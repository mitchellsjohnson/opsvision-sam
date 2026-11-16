// Command api is the OpsVision API as an AWS Lambda function behind API
// Gateway (REST, proxy integration) or an Application Load Balancer (Lambda
// target group with multi-value headers enabled).
//
// Configuration comes from the environment:
//
//	OPSVISION_AUTH_MODE    must be "auth0"; anything else refuses to start
//	OPSVISION_EVENT_SOURCE "apigateway" (default), "alb", or "sqs" (the
//	                       assistant turn worker, fed by the turn queue);
//	                       anything else refuses to start
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
//	OPSVISION_UPLOADS_ORIGIN  https origin browsers upload to, for the web
//	                     app's CSP (default
//	                     https://<UPLOADS_BUCKET>.s3.<AWS_REGION>.amazonaws.com)
//
// OPSVISION_WEB_AUTH0_CLIENT_ID or OPSVISION_UPLOADS_ORIGIN without
// OPSVISION_SERVE_WEB=1 refuses to start. See docs/deploy/environment.md.
//
// Assistant (all optional):
//
//	OPSVISION_CREDENTIAL_KMS_KEY_ID  KMS key (ID, ARN or alias) that encrypts
//	                     users' assistant API keys, with encryption context
//	                     {tenant, user, purpose: assistant-credential}
//	OPSVISION_CREDENTIAL_KEY  base64 32-byte AES-256-GCM key used instead when
//	                     no KMS key is set (local development; not read when
//	                     OPSVISION_CREDENTIAL_KMS_KEY_ID is set)
//	OPSVISION_ASSISTANT_BASE_URL  https origin (optionally with a path) of
//	                     the model provider API (default
//	                     https://api.anthropic.com)
//	OPSVISION_ASSISTANT_QUEUE_URL  https URL of the SQS queue assistant turns
//	                     are sent to; without it asking SAM answers 503
//	                     assistant_unavailable
//
// The worker (OPSVISION_EVENT_SOURCE=sqs) runs from the same zip with the same
// configuration (it needs the table, the credential key and the provider
// URL, and is checked like the API). It takes one queue message at a time and
// reports a failed turn as a batch item failure so SQS retries it; the event
// source mapping needs ReportBatchItemFailures, and the function a timeout
// above the 90 s turn budget.
//
// With neither credential key set, saving an assistant API key answers 503
// assistant_unavailable; keys are never stored unencrypted. A malformed
// OPSVISION_CREDENTIAL_KEY or OPSVISION_ASSISTANT_BASE_URL refuses to start.
//
// Single-organization sign-in (one tenant; org_id is ignored):
//
//	OPSVISION_TENANT_ID  the one tenant every trusted caller belongs to;
//	                     setting it enables the mode
//	OPSVISION_TRUSTED_SUB_PREFIXES  comma-separated sub prefixes allowed to
//	                     sign in, each ending in "|" (required with the mode)
//	OPSVISION_BOOTSTRAP_ADMINS  comma-separated emails that become admins on
//	                     their first sign-in (optional). A later demotion is
//	                     kept, but a deleted membership comes back as admin;
//	                     to revoke a bootstrap admin, remove the email here
//	OPSVISION_USERINFO_URL  https /userinfo endpoint, called on a first sign-in
//	                     whose token has no email claim (default
//	                     https://<AUTH0_DOMAIN>/userinfo)
//
// A trusted caller's email (token claim or /userinfo) counts as verified for
// invitations and bootstrap admins, whatever email_verified says: the trusted
// connection is the organization's own directory.
package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"opsvision/internal/assistant"
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
	eventSourceSQS        = "sqs"
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

	SingleTenantID     string
	TrustedSubPrefixes []string
	BootstrapAdmins    []string
	UserInfoURL        string

	CredentialKMSKeyID string
	CredentialKey      []byte
	AssistantBaseURL   string // "" is the provider default
	AssistantQueueURL  string // "" leaves the assistant without a queue
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
	case eventSourceAPIGateway, eventSourceALB, eventSourceSQS:
	default:
		return appConfig{}, fmt.Errorf("refusing to start: OPSVISION_EVENT_SOURCE must be %s, %s or %s", eventSourceAPIGateway, eventSourceALB, eventSourceSQS)
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
	if err := loadSingleOrg(getenv, &c); err != nil {
		return appConfig{}, err
	}
	if err := loadAssistant(getenv, &c); err != nil {
		return appConfig{}, err
	}

	c.WebAuth0ClientID = getenv("OPSVISION_WEB_AUTH0_CLIENT_ID")
	c.UploadsOrigin = getenv("OPSVISION_UPLOADS_ORIGIN")
	switch getenv("OPSVISION_SERVE_WEB") {
	case "", "0":
		// The web app's settings without the web app are configuration drift.
		if c.WebAuth0ClientID != "" || c.UploadsOrigin != "" {
			return appConfig{}, errors.New("refusing to start: OPSVISION_WEB_AUTH0_CLIENT_ID and " +
				"OPSVISION_UPLOADS_ORIGIN apply only with OPSVISION_SERVE_WEB=1")
		}
		return c, nil
	case "1":
		c.ServeWeb = true
	default:
		return appConfig{}, errors.New(`refusing to start: OPSVISION_SERVE_WEB must be "1", "0" or unset`)
	}
	if c.WebAuth0ClientID == "" {
		return appConfig{}, errors.New("OPSVISION_WEB_AUTH0_CLIENT_ID is required when OPSVISION_SERVE_WEB=1")
	}
	if c.UploadsOrigin != "" && !isHTTPSOrigin(c.UploadsOrigin) {
		return appConfig{}, errors.New("refusing to start: OPSVISION_UPLOADS_ORIGIN must be an https origin " +
			"(scheme and host only, such as https://uploads.example.test)")
	}
	if c.UploadsOrigin == "" {
		region := getenv("AWS_REGION")
		if region == "" {
			return appConfig{}, errors.New("OPSVISION_UPLOADS_ORIGIN is required when AWS_REGION is not set")
		}
		c.UploadsOrigin = "https://" + c.UploadsBucket + ".s3." + region + ".amazonaws.com"
	}
	return c, nil
}

// loadSingleOrg reads the single-organization sign-in settings into c. They
// apply only with OPSVISION_TENANT_ID; any of them without it refuses to
// start, as does a malformed list or URL.
func loadSingleOrg(getenv func(string) string, c *appConfig) error {
	tenantID := getenv("OPSVISION_TENANT_ID")
	prefixes := getenv("OPSVISION_TRUSTED_SUB_PREFIXES")
	admins := getenv("OPSVISION_BOOTSTRAP_ADMINS")
	userInfoURL := getenv("OPSVISION_USERINFO_URL")
	if tenantID == "" {
		if prefixes != "" || admins != "" || userInfoURL != "" {
			return errors.New("refusing to start: OPSVISION_TRUSTED_SUB_PREFIXES, OPSVISION_BOOTSTRAP_ADMINS " +
				"and OPSVISION_USERINFO_URL apply only with OPSVISION_TENANT_ID")
		}
		return nil
	}
	if strings.TrimSpace(tenantID) != tenantID {
		return errors.New("refusing to start: OPSVISION_TENANT_ID must not have surrounding spaces")
	}
	c.SingleTenantID = tenantID

	if strings.TrimSpace(prefixes) == "" {
		return errors.New("refusing to start: OPSVISION_TRUSTED_SUB_PREFIXES is required with OPSVISION_TENANT_ID")
	}
	list, err := commaList("OPSVISION_TRUSTED_SUB_PREFIXES", prefixes)
	if err != nil {
		return err
	}
	for _, p := range list {
		if len(p) < 2 || !strings.HasSuffix(p, "|") {
			return fmt.Errorf("refusing to start: OPSVISION_TRUSTED_SUB_PREFIXES entry %q must end with \"|\"", p)
		}
	}
	c.TrustedSubPrefixes = list

	if admins != "" {
		list, err := commaList("OPSVISION_BOOTSTRAP_ADMINS", admins)
		if err != nil {
			return err
		}
		for i, a := range list {
			local, domain, ok := strings.Cut(a, "@")
			if !ok || local == "" || domain == "" || strings.Contains(domain, "@") {
				return fmt.Errorf("refusing to start: OPSVISION_BOOTSTRAP_ADMINS entry %q is not an email address", a)
			}
			list[i] = strings.ToLower(a)
		}
		c.BootstrapAdmins = list
	}

	if userInfoURL != "" {
		u, err := url.Parse(userInfoURL)
		if err != nil || u.Scheme != "https" || u.Host == "" || strings.TrimSpace(userInfoURL) != userInfoURL {
			return errors.New("refusing to start: OPSVISION_USERINFO_URL must be an https URL")
		}
		c.UserInfoURL = userInfoURL
	}
	return nil
}

// loadAssistant reads the assistant settings into c. The KMS key takes
// precedence over the local key, which is then not read.
func loadAssistant(getenv func(string) string, c *appConfig) error {
	if id := getenv("OPSVISION_CREDENTIAL_KMS_KEY_ID"); id != "" {
		if strings.TrimSpace(id) != id {
			return errors.New("refusing to start: OPSVISION_CREDENTIAL_KMS_KEY_ID must not have surrounding spaces")
		}
		c.CredentialKMSKeyID = id
	} else if raw := getenv("OPSVISION_CREDENTIAL_KEY"); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(key) != 32 {
			return errors.New("refusing to start: OPSVISION_CREDENTIAL_KEY must be 32 bytes, base64-encoded")
		}
		c.CredentialKey = key
	}
	if base := getenv("OPSVISION_ASSISTANT_BASE_URL"); base != "" {
		u, err := url.Parse(base)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
			u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.HasSuffix(base, "#") || strings.TrimSpace(base) != base {
			return errors.New("refusing to start: OPSVISION_ASSISTANT_BASE_URL must be an https URL with no query or fragment")
		}
		c.AssistantBaseURL = strings.TrimRight(base, "/")
	}
	if q := getenv("OPSVISION_ASSISTANT_QUEUE_URL"); q != "" {
		u, err := url.Parse(q)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
			u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.HasSuffix(q, "#") || strings.TrimSpace(q) != q {
			return errors.New("refusing to start: OPSVISION_ASSISTANT_QUEUE_URL must be an https URL with no query or fragment")
		}
		c.AssistantQueueURL = q
	}
	return nil
}

// newSealer returns the sealer for assistant credentials that cfg selects: KMS
// (with the client newKMS builds), the local AES key, or none.
func newSealer(cfg appConfig, newKMS func() assistant.KMSAPI) (assistant.Sealer, error) {
	switch {
	case cfg.CredentialKMSKeyID != "":
		return assistant.NewKMSSealer(newKMS(), cfg.CredentialKMSKeyID), nil
	case cfg.CredentialKey != nil:
		return assistant.NewAESSealer(cfg.CredentialKey)
	}
	return nil, nil
}

// isHTTPSOrigin reports whether s is exactly https://host[:port]: no path,
// query, fragment or user info, and a host of letters, digits, dots and
// hyphens. It goes into the web app's Content-Security-Policy as is.
func isHTTPSOrigin(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || s != "https://"+u.Host {
		return false
	}
	for _, r := range u.Hostname() {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-') {
			return false
		}
	}
	return true
}

// commaList splits a comma-separated variable, trimming spaces around each
// entry. An empty entry refuses to start.
func commaList(name, value string) ([]string, error) {
	parts := strings.Split(value, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
		if parts[i] == "" {
			return nil, fmt.Errorf("refusing to start: %s has an empty entry", name)
		}
	}
	return parts, nil
}

// newHandler assembles the API: CORS outermost (so preflights are answered
// before authentication), then compression and Auth0 token validation around
// the /v1 routes. With cfg.ServeWeb, the embedded web app answers every path
// other than /v1/ and /healthz, and is never behind CORS or authentication;
// API responses then carry the web app's HSTS, nosniff and referrer policy.
// sealer encrypts assistant credentials and queue starts assistant turns;
// without either the assistant is unavailable.
func newHandler(cfg appConfig, st store.Store, objs objects.Store, sealer assistant.Sealer, queue assistant.Queue) (http.Handler, error) {
	authMW, err := auth.Middleware(auth.Config{
		Mode:               auth.ModeAuth0,
		Domain:             cfg.Auth0Domain,
		Audience:           cfg.Auth0Audience,
		ClaimNamespace:     cfg.ClaimNamespace,
		SingleTenantID:     cfg.SingleTenantID,
		TrustedSubPrefixes: cfg.TrustedSubPrefixes,
		BootstrapAdmins:    cfg.BootstrapAdmins,
		UserInfoURL:        cfg.UserInfoURL,
	}, st)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	api := httpapi.CORS(cfg.AllowedOrigin)(httpapi.NewHandler(newServer(cfg, st, objs, sealer, queue), authMW))
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
			webui.SetSecurityHeaders(w.Header())
			api.ServeHTTP(w, r)
			return
		}
		web.ServeHTTP(w, r)
	}), nil
}

// newServer is the API server both event sources share.
func newServer(cfg appConfig, st store.Store, objs objects.Store, sealer assistant.Sealer, queue assistant.Queue) *httpapi.Server {
	return httpapi.NewServer(httpapi.Deps{
		Store:    st,
		Objects:  objs,
		Sealer:   sealer,
		Provider: assistant.NewHTTPProvider(cfg.AssistantBaseURL, nil),
		Queue:    queue,
	})
}

// newWorker is the turn queue's handler: each message is one assistant turn,
// run by the same server's runner (tools dispatched through its router).
func newWorker(cfg appConfig, st store.Store, objs objects.Store, sealer assistant.Sealer) (func(context.Context, events.SQSEvent) (events.SQSEventResponse, error), error) {
	runner, err := newServer(cfg, st, objs, sealer, nil).AssistantRunner()
	if err != nil {
		return nil, err
	}
	return assistant.SQSHandler(runner.Run), nil
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
	sealer, err := newSealer(cfg, func() assistant.KMSAPI { return kms.NewFromConfig(awsCfg) })
	if err != nil {
		return err
	}
	if sealer == nil {
		slog.Warn("no assistant credential key is set; saving assistant API keys is unavailable")
	}
	if cfg.EventSource == eventSourceSQS {
		worker, err := newWorker(cfg, st, objs, sealer)
		if err != nil {
			return err
		}
		lambda.StartWithOptions(worker, lambda.WithContext(ctx))
		return nil
	}
	var queue assistant.Queue
	if cfg.AssistantQueueURL != "" {
		queue = assistant.NewSQSQueue(sqs.NewFromConfig(awsCfg), cfg.AssistantQueueURL)
	} else {
		slog.Warn("OPSVISION_ASSISTANT_QUEUE_URL is not set; asking SAM is unavailable")
	}
	h, err := newHandler(cfg, st, objs, sealer, queue)
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
