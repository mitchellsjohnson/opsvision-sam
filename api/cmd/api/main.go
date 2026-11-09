// Command api is the OpsVision API as an AWS Lambda function behind API
// Gateway (REST, proxy integration) or an Application Load Balancer (Lambda
// target group with multi-value headers enabled).
//
// Configuration comes from the environment:
//
//	OPSVISION_AUTH_MODE    must be "auth0"; anything else refuses to start
//	OPSVISION_EVENT_SOURCE "apigateway" (default) or "alb"; anything else
//	                       refuses to start
//	TABLE_NAME           DynamoDB table
//	UPLOADS_BUCKET       S3 bucket for uploaded workbooks and parsed change sets
//	AUTH0_DOMAIN         Auth0 tenant domain, e.g. example.us.auth0.com
//	AUTH0_AUDIENCE       API audience the access tokens are issued for
//	CLAIM_NAMESPACE      prefix of the email/name claims (default https://opsvision/)
//	ALLOWED_ORIGIN       the one browser origin allowed by CORS (optional when
//	                     the web app is served from the same origin)
//	OPSVISION_SERVE_WEB  "1" also serves the embedded web app (every path but
//	                     /v1/ and /healthz); "" or "0" serves the API only
//	OPSVISION_WEB_AUTH0_CLIENT_ID  the web app's Auth0 client ID (required
//	                     when serving the web app)
//	OPSVISION_UPLOADS_ORIGIN  origin browsers upload to, for the web app's CSP
//	                     (default https://<UPLOADS_BUCKET>.s3.<AWS_REGION>.amazonaws.com)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/auth"
	"opsvision/internal/httpapi"
	"opsvision/internal/lambdahttp"
	"opsvision/internal/objects"
	"opsvision/internal/store"
	"opsvision/internal/store/dynamostore"
	"opsvision/internal/webui"
)

// errNotAuth0 is why the function will not start in any other auth mode. The
// dev-mode token validator accepts tokens anyone holding a shared secret can
// forge, so it must be impossible to enable by configuration drift.
var errNotAuth0 = errors.New("refusing to start: OPSVISION_AUTH_MODE must be auth0")

// Event sources the function can be invoked by.
const (
	eventSourceAPIGateway = "apigateway"
	eventSourceALB        = "alb"
)

type appConfig struct {
	EventSource    string
	Table          string
	UploadsBucket  string
	Auth0Domain    string
	Auth0Audience  string
	ClaimNamespace string
	AllowedOrigin  string

	ServeWeb         bool
	WebAuth0ClientID string
	UploadsOrigin    string
}

// loadConfig reads the configuration from getenv. The auth mode is checked
// first and must be exactly "auth0".
func loadConfig(getenv func(string) string) (appConfig, error) {
	if getenv("OPSVISION_AUTH_MODE") != auth.ModeAuth0 {
		return appConfig{}, errNotAuth0
	}
	eventSource := getenv("OPSVISION_EVENT_SOURCE")
	switch eventSource {
	case "":
		eventSource = eventSourceAPIGateway
	case eventSourceAPIGateway, eventSourceALB:
	default:
		return appConfig{}, fmt.Errorf("refusing to start: OPSVISION_EVENT_SOURCE must be %s or %s", eventSourceAPIGateway, eventSourceALB)
	}
	c := appConfig{
		EventSource:    eventSource,
		Table:          getenv("TABLE_NAME"),
		UploadsBucket:  getenv("UPLOADS_BUCKET"),
		Auth0Domain:    getenv("AUTH0_DOMAIN"),
		Auth0Audience:  getenv("AUTH0_AUDIENCE"),
		ClaimNamespace: getenv("CLAIM_NAMESPACE"),
		AllowedOrigin:  getenv("ALLOWED_ORIGIN"),
	}
	for _, r := range []struct{ name, value string }{
		{"TABLE_NAME", c.Table},
		{"UPLOADS_BUCKET", c.UploadsBucket},
		{"AUTH0_DOMAIN", c.Auth0Domain},
		{"AUTH0_AUDIENCE", c.Auth0Audience},
	} {
		if r.value == "" {
			return appConfig{}, fmt.Errorf("%s is required", r.name)
		}
	}
	if c.ClaimNamespace == "" {
		c.ClaimNamespace = auth.DefaultClaimNamespace
	}

	switch getenv("OPSVISION_SERVE_WEB") {
	case "", "0":
		return c, nil
	case "1":
		c.ServeWeb = true
	default:
		return appConfig{}, errors.New(`refusing to start: OPSVISION_SERVE_WEB must be "1", "0" or unset`)
	}
	c.WebAuth0ClientID = getenv("OPSVISION_WEB_AUTH0_CLIENT_ID")
	if c.WebAuth0ClientID == "" {
		return appConfig{}, errors.New("OPSVISION_WEB_AUTH0_CLIENT_ID is required when OPSVISION_SERVE_WEB=1")
	}
	c.UploadsOrigin = getenv("OPSVISION_UPLOADS_ORIGIN")
	if c.UploadsOrigin == "" {
		region := getenv("AWS_REGION")
		if region == "" {
			return appConfig{}, errors.New("OPSVISION_UPLOADS_ORIGIN is required when AWS_REGION is not set")
		}
		c.UploadsOrigin = "https://" + c.UploadsBucket + ".s3." + region + ".amazonaws.com"
	}
	return c, nil
}

// newHandler assembles the API: CORS outermost (so preflights are answered
// before authentication), then compression and Auth0 token validation around
// the /v1 routes. With cfg.ServeWeb, the embedded web app answers every path
// other than /v1/ and /healthz, and is never behind CORS or authentication.
func newHandler(cfg appConfig, st store.Store, objs objects.Store) (http.Handler, error) {
	authMW, err := auth.Middleware(auth.Config{
		Mode:           auth.ModeAuth0,
		Domain:         cfg.Auth0Domain,
		Audience:       cfg.Auth0Audience,
		ClaimNamespace: cfg.ClaimNamespace,
	}, st)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	srv := httpapi.NewServer(httpapi.Deps{Store: st, Objects: objs})
	api := httpapi.CORS(cfg.AllowedOrigin)(httpapi.NewHandler(srv, authMW))
	if !cfg.ServeWeb {
		return api, nil
	}
	web := webui.Handler(webui.Files(), webui.Config{
		AuthMode:      auth.ModeAuth0,
		Auth0Domain:   cfg.Auth0Domain,
		Auth0ClientID: cfg.WebAuth0ClientID,
		Auth0Audience: cfg.Auth0Audience,
		UploadsOrigin: cfg.UploadsOrigin,
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isAPIPath(r.URL.Path) {
			api.ServeHTTP(w, r)
			return
		}
		web.ServeHTTP(w, r)
	}), nil
}

// isAPIPath reports whether p belongs to the API rather than the web app.
func isAPIPath(p string) bool {
	return p == "/healthz" || p == "/v1" || strings.HasPrefix(p, "/v1/")
}

func run(ctx context.Context) error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	if cfg.AllowedOrigin == "" && !cfg.ServeWeb {
		slog.Warn("ALLOWED_ORIGIN is not set; browsers on other origins cannot call this API")
	}
	awsCfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	st := dynamostore.New(dynamodb.NewFromConfig(awsCfg), cfg.Table)
	objs := objects.NewS3(objects.NewS3Client(awsCfg), cfg.UploadsBucket)
	h, err := newHandler(cfg, st, objs)
	if err != nil {
		return err
	}
	lambda.StartWithOptions(lambdaHandler(cfg.EventSource, h), lambda.WithContext(ctx))
	return nil
}

// lambdaHandler adapts h to the Lambda event shape of eventSource, which
// loadConfig has validated.
func lambdaHandler(eventSource string, h http.Handler) any {
	if eventSource == eventSourceALB {
		return lambdahttp.ALBHandler(h)
	}
	return lambdahttp.Handler(h)
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(context.Background()); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}
