package lambdahttp_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/httpapi"
	"opsvision/internal/lambdahttp"
	"opsvision/internal/period"
	"opsvision/internal/store/memstore"
)

// TestAPIThroughAdapter runs the real API behind the adapter: a large view
// response is gzip-compressed by the API and must reach API Gateway as base64
// with IsBase64Encoded set.
func TestAPIThroughAdapter(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	st := memstore.New()
	if _, err := demo.Seed(context.Background(), st, period.Calendar{FiscalYearStartMonth: 1}); err != nil {
		t.Fatal(err)
	}
	mw, err := auth.Middleware(auth.Config{Mode: auth.ModeDev, DevSecret: secret}, st)
	if err != nil {
		t.Fatal(err)
	}
	h := lambdahttp.Handler(httpapi.CORS("https://app.example.test")(
		httpapi.NewHandler(httpapi.NewServer(httpapi.Deps{Store: st}), mw)))

	token, err := auth.IssueDevToken(secret, "dev|admin", "admin@demo.test", "Avery Admin", demo.Auth0OrgID, false)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := h(context.Background(), events.APIGatewayProxyRequest{
		HTTPMethod: "GET",
		Path:       "/Prod/v1/scorecards/service-fulfillment/view",
		MultiValueQueryStringParameters: map[string][]string{
			"periods": {"2026-M10", "2026-M09", "2026-M08"},
		},
		MultiValueHeaders: map[string][]string{
			"Authorization":   {"Bearer " + token},
			"Accept-Encoding": {"gzip, deflate"},
			"Origin":          {"https://app.example.test"},
		},
		RequestContext: events.APIGatewayProxyRequestContext{Stage: "Prod", RequestID: "r1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d: %s", resp.StatusCode, resp.Body)
	}
	if !resp.IsBase64Encoded {
		t.Fatal("compressed view must be base64 encoded")
	}
	if got := resp.MultiValueHeaders["Content-Encoding"]; len(got) != 1 || got[0] != "gzip" {
		t.Fatalf("Content-Encoding = %v", got)
	}
	if got := resp.MultiValueHeaders["Access-Control-Allow-Origin"]; len(got) != 1 || got[0] != "https://app.example.test" {
		t.Errorf("Allow-Origin = %v", got)
	}
	raw, err := base64.StdEncoding.DecodeString(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var view struct {
		Rows []json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(plain, &view); err != nil || len(view.Rows) == 0 {
		t.Fatalf("decoded body is not a view: %v", err)
	}
}
