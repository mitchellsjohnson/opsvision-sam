package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

// ---- wire types -----------------------------------------------------------

type cellJSON struct {
	MetricKey  string             `json:"metricKey"`
	SubjectID  string             `json:"subjectId"`
	Period     string             `json:"period"`
	YTD        bool               `json:"ytd"`
	Value      *float64           `json:"value"`
	Display    string             `json:"display"`
	Status     string             `json:"status"`
	NAReason   string             `json:"naReason"`
	Components map[string]float64 `json:"components"`
	Coverage   []int              `json:"coverage"`
	VersionID  string             `json:"versionId"`
	Override   *struct {
		Value  *float64 `json:"value"`
		Status string   `json:"status"`
		Reason string   `json:"reason"`
		By     string   `json:"by"`
	} `json:"override"`
	Computed *struct {
		Value  *float64 `json:"value"`
		Status string   `json:"status"`
	} `json:"computed"`
	Cutoff *string `json:"cutoff"`
}

type viewRowJSON struct {
	MetricKey   string     `json:"metricKey"`
	SubjectID   string     `json:"subjectId"`
	SubjectName string     `json:"subjectName"`
	Depth       int        `json:"depth"`
	Cells       []cellJSON `json:"cells"`
}

type viewJSON struct {
	Periods         []string          `json:"periods"`
	Ytd             []string          `json:"ytd"`
	Categories      []domain.Category `json:"categories"`
	Rows            []viewRowJSON     `json:"rows"`
	VersionByPeriod map[string]string `json:"versionByPeriod"`
}

// cell returns the cell of (metric, subject) in column col.
func (v viewJSON) cell(t *testing.T, metric, subject string, col int) cellJSON {
	t.Helper()
	for _, r := range v.Rows {
		if r.MetricKey == metric && r.SubjectID == subject {
			if col >= len(r.Cells) {
				t.Fatalf("row %s/%s has %d cells, want column %d", metric, subject, len(r.Cells), col)
			}
			return r.Cells[col]
		}
	}
	t.Fatalf("no row %s/%s in %d rows", metric, subject, len(v.Rows))
	return cellJSON{}
}

func (v viewJSON) subjects(metric string) []string {
	var out []string
	for _, r := range v.Rows {
		if r.MetricKey == metric {
			out = append(out, r.SubjectID)
		}
	}
	return out
}

// ---- tests ----------------------------------------------------------------

func TestViewShapeAndNormalization(t *testing.T) {
	e := newTestEnv(t)
	ver := seedDelivery(t, e)
	saveSplit(t, e)

	status, raw := e.call(t, e.tokens["t1-admin"], "GET", "/scorecards/delivery/view?periods=2026-M10&periods=2026-Q4&ytd=2026-M10", nil)
	if status != 200 {
		t.Fatalf("status %d: %s", status, raw)
	}
	// Arrays and objects the contract marks required are never null.
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"periods", "ytd", "categories", "rows", "versionByPeriod"} {
		if generic[field] == nil {
			t.Errorf("%s is null", field)
		}
	}
	if strings.Contains(string(raw), `"components":null`) || strings.Contains(string(raw), `"coverage":null`) {
		t.Errorf("null components/coverage in response")
	}

	var v viewJSON
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Periods) != 2 || v.Periods[1] != "2026-Q4" || len(v.Ytd) != 1 || v.Ytd[0] != "2026-M10" {
		t.Errorf("columns = %v %v", v.Periods, v.Ytd)
	}
	if v.VersionByPeriod["2026-M10"] != ver.ID || v.VersionByPeriod["YTD:2026-M10"] != ver.ID {
		t.Errorf("versionByPeriod = %v, want %s", v.VersionByPeriod, ver.ID)
	}
	if len(v.Categories) != 1 || v.Categories[0].ID != "flow" {
		t.Errorf("categories = %+v", v.Categories)
	}
	for _, r := range v.Rows {
		if len(r.Cells) != 3 {
			t.Fatalf("row %s/%s has %d cells, want one per column", r.MetricKey, r.SubjectID, len(r.Cells))
		}
	}
	// Blank cells carry {} and a two-element coverage.
	blank := v.cell(t, "reviews_score", "prod-1", 0) // a quarterly metric in a month column
	if blank.Components == nil || blank.Coverage == nil || len(blank.Coverage) != 2 {
		t.Errorf("blank cell = %+v", blank)
	}
	if ytd := v.cell(t, "on_time_pct", "seg-a", 2); !ytd.YTD || ytd.Display != "84.3%" {
		t.Errorf("ytd cell = %+v", ytd)
	}
	// Depth follows the org tree.
	for _, r := range v.Rows {
		if r.MetricKey == "on_time_pct" && r.SubjectID == "acme" && r.Depth != 0 {
			t.Errorf("acme depth = %d", r.Depth)
		}
		if r.MetricKey == "on_time_pct" && r.SubjectID == "prod-1" && r.Depth != 2 {
			t.Errorf("prod-1 depth = %d", r.Depth)
		}
	}
}

func TestViewWindowValidation(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	get := func(query string) {
		t.Helper()
		e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/view"+query, nil)
	}

	var many []string
	for i := 1; i <= 25; i++ {
		many = append(many, "periods=2026-Q1")
	}
	get("?" + strings.Join(many, "&")) // 25 periods
	get("")                            // zero columns
	get("?subjects=acme")              // still zero columns
	get("?ytd=2026-M10&ytd=2026-M09&ytd=2026-M08")
	get("?ytd=2026-Q1")                    // ytd must be a month
	get("?periods=nonsense")               // unparseable period
	get("?periods=2026-M10&structure=bad") // unknown structure
	get("?periods=2026-M10&restate=ghost") // not a version of this scorecard

	var ok viewJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?"+strings.Join(many[:24], "&"), nil, &ok)
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?ytd=2026-M10", nil, &ok)
	if len(ok.Periods) != 0 || len(ok.Ytd) != 1 {
		t.Errorf("ytd-only view columns = %v %v", ok.Periods, ok.Ytd)
	}

	var subj []string
	for i := 0; i < 201; i++ {
		subj = append(subj, "subjects=s"+string(rune('a'+i%26))+strings.Repeat("x", i/26))
	}
	get("?periods=2026-M10&" + strings.Join(subj, "&"))
}

func TestViewerSeesOnlyScopedRows(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	viewer := e.tokens["t1-viewer"]

	setScope(t, e, domain.RoleViewer, domain.Scope{OrgUnitIDs: []string{"prod-1"}})
	var v viewJSON
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	// prod-1 and its attached item; nothing above it, no sibling, no
	// unattached item.
	if got := strings.Join(v.subjects("on_time_pct"), ","); got != "prod-1" {
		t.Errorf("on_time_pct subjects = %q", got)
	}
	if got := strings.Join(v.subjects("app_defects"), ","); got != "pay" {
		t.Errorf("app_defects subjects = %q", got)
	}

	// Metric scope drops rows of other metrics.
	setScope(t, e, domain.RoleViewer, domain.Scope{MetricKeys: []string{"reviews_score"}})
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	for _, r := range v.Rows {
		if r.MetricKey != "reviews_score" {
			t.Errorf("viewer sees row %s/%s outside its metric scope", r.MetricKey, r.SubjectID)
		}
	}
	if len(v.Rows) == 0 {
		t.Error("viewer sees nothing")
	}

	// Unscoped viewers see every org row but not unattached items;
	// contributors and admins see all rows.
	setScope(t, e, domain.RoleViewer, domain.Scope{})
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	if got := strings.Join(v.subjects("on_time_pct"), ","); got != "acme,seg-a,prod-1,prod-2" {
		t.Errorf("unscoped viewer subjects = %q", got)
	}
	if got := strings.Join(v.subjects("app_defects"), ","); got != "pay" {
		t.Errorf("unscoped viewer items = %q, want unattached items hidden", got)
	}
	for _, role := range []string{"t1-contributor", "t1-admin"} {
		e.expect(t, 200, e.tokens[role], "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
		if got := strings.Join(v.subjects("app_defects"), ","); got != "pay,shop" {
			t.Errorf("%s items = %q", role, got)
		}
	}
	// Subjects filter composes with scope.
	e.expect(t, 200, e.tokens["t1-admin"], "GET", "/scorecards/delivery/view?periods=2026-M10&subjects=seg-a", nil, &v)
	for _, r := range v.Rows {
		if r.SubjectID != "seg-a" {
			t.Errorf("subjects filter leaked row %s", r.SubjectID)
		}
	}
}

func TestRestateQueryParam(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	admin := e.tokens["t1-admin"]

	// A draft that is stricter about green: 84.3% turns red under it.
	draft := newDraft(t, e, "delivery", "Stricter", "")
	m := deliveryMethodology()
	m.Metrics[0].Rule.Bands = []domain.Band{{Status: "G", Op: ">=", Value: 95}, {Status: "Y", Op: ">=", Value: 90}, {Status: "R"}}
	draft = saveDraft(t, e, draft, m)

	var base, restated viewJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &base)
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10&restate="+draft.ID, nil, &restated)
	if c := base.cell(t, "on_time_pct", "seg-a", 0); c.Status != "Y" {
		t.Errorf("as published = %+v", c)
	}
	rc := restated.cell(t, "on_time_pct", "seg-a", 0)
	if rc.Status != "R" || rc.VersionID != draft.ID || restated.VersionByPeriod["2026-M10"] != draft.ID {
		t.Errorf("restated = %+v byPeriod %v", rc, restated.VersionByPeriod)
	}
	// Restating never changes the published view.
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &base)
	if c := base.cell(t, "on_time_pct", "seg-a", 0); c.Status != "Y" {
		t.Errorf("published view changed after restate: %+v", c)
	}

	// A version of another scorecard is not a valid restatement.
	seedScorecard(t, e, "other")
	foreign := newDraft(t, e, "other", "Foreign", "")
	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/view?periods=2026-M10&restate="+foreign.ID, nil)
}

func TestViewStructureCurrent(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M01", 50, 0), wr("committed", "prod-1", "2026-M01", 100, 0),
		wr("on_time", "prod-1", "2026-M10", 90, 0), wr("committed", "prod-1", "2026-M10", 100, 0),
	), nil)
	// prod-1 moves to seg-b from October.
	e.expect(t, 201, admin, "POST", "/org/units/prod-1/moves", map[string]any{"newParentId": "seg-b", "effectiveMonth": "2026-M10", "note": "reorg"}, nil)

	var asOf, current viewJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M01&periods=2026-M10", nil, &asOf)
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M01&periods=2026-M10&structure=current", nil, &current)
	if c := asOf.cell(t, "on_time_pct", "seg-a", 0); c.Display != "50.0%" {
		t.Errorf("as_of seg-a Jan = %+v, want prod-1's data under its January parent", c)
	}
	if c := asOf.cell(t, "on_time_pct", "seg-b", 0); c.Value != nil {
		t.Errorf("as_of: seg-b had no data in January, got %+v", c)
	}
	if c := current.cell(t, "on_time_pct", "seg-b", 0); c.Display != "50.0%" {
		t.Errorf("current structure seg-b Jan = %+v, want prod-1's January data under seg-b", c)
	}
}

func TestGzipAppliedToLargeResponses(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)

	fetch := func(path, acceptEncoding string) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequest("GET", e.srv.URL+"/v1"+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+e.tokens["t1-admin"])
		if acceptEncoding != "" {
			req.Header.Set("Accept-Encoding", acceptEncoding)
		}
		// A custom Transport without compression support keeps the raw bytes.
		client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, raw
	}
	const viewPath = "/scorecards/delivery/view?periods=2026-M08&periods=2026-M09&periods=2026-M10"

	resp, raw := fetch(viewPath, "gzip")
	if resp.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("headers = %v (body %d bytes)", resp.Header, len(raw))
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) <= 1024 || len(raw) >= len(plain) {
		t.Errorf("plain %d bytes, compressed %d bytes", len(plain), len(raw))
	}
	var v viewJSON
	if err := json.Unmarshal(plain, &v); err != nil || len(v.Rows) == 0 {
		t.Fatalf("decompressed body is not the view: %v", err)
	}
	if resp.Header.Get("Content-Length") != "" && resp.Header.Get("Content-Length") != itoa(len(raw)) {
		t.Errorf("Content-Length %s does not match the compressed body (%d)", resp.Header.Get("Content-Length"), len(raw))
	}

	// Without Accept-Encoding, and for small responses, nothing is compressed.
	resp, raw = fetch(viewPath, "")
	if resp.Header.Get("Content-Encoding") != "" || !json.Valid(raw) {
		t.Errorf("uncompressed request got Content-Encoding %q", resp.Header.Get("Content-Encoding"))
	}
	resp, raw = fetch("/me", "gzip")
	if resp.Header.Get("Content-Encoding") != "" || !json.Valid(raw) {
		t.Errorf("small response got Content-Encoding %q (%d bytes)", resp.Header.Get("Content-Encoding"), len(raw))
	}
}

func TestViewCellCutoff(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	ctx := context.Background()
	v, err := e.store.GetVersion(ctx, "t1", "sc", "v1")
	if err != nil {
		t.Fatal(err)
	}
	// An entered metric beside the derived defect score.
	v.Content.Measures = append(v.Content.Measures, domain.Measure{
		Key: "escapes", Name: "Escapes", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
	})
	entered := v.Content.Metrics[0]
	entered.Key, entered.Name, entered.Formula = "escape_count", "Escapes", "escapes"
	v.Content.Metrics = append(v.Content.Metrics, entered)
	if err := e.store.PutVersion(ctx, "t1", v, v.Revision); err != nil {
		t.Fatal(err)
	}
	applyDefects(t, e) // the defects export as of 2026-09-15

	var view viewJSON
	e.expect(t, 200, e.tokens["t1-viewer"], "GET",
		"/scorecards/sc/view?periods=2026-M08&periods=2026-M09&periods=2026-M10&periods=2026-Q3&ytd=2026-M09", nil, &view)
	cutoff := func(metric, subject string, col int) string {
		if c := view.cell(t, metric, subject, col).Cutoff; c != nil {
			return *c
		}
		return ""
	}
	for _, subject := range []string{"checkout", "acme"} {
		if got := cutoff("defect_score", subject, 1); got != "2026-09-15" {
			t.Errorf("defect_score %s 2026-M09 cutoff = %q, want 2026-09-15", subject, got)
		}
		// August is complete, October starts after the snapshot, and quarters
		// and year-to-date columns are not month cells.
		for _, col := range []int{0, 2, 3, 4} {
			if got := cutoff("defect_score", subject, col); got != "" {
				t.Errorf("defect_score %s column %d cutoff = %q, want none", subject, col, got)
			}
		}
	}
	if got := cutoff("escape_count", "checkout", 1); got != "" {
		t.Errorf("entered metric got cutoff %q", got)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
