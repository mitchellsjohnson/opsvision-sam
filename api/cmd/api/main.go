// Command api is the OpsVision API as an AWS Lambda function behind API
// Gateway (REST, proxy integration).
//
// Configuration comes from the environment:
//
//	OPSVISION_AUTH_MODE  must be "auth0"; anything else refuses to start
//	TABLE_NAME           DynamoDB table
//	AUTH0_DOMAIN         Auth0 tenant domain, e.g. example.us.auth0.com
//	AUTH0_AUDIENCE       API audience the access tokens are issued for
//	CLAIM_NAMESPACE      prefix of the email/name claims (default https://opsvision/)
//	ALLOWED_ORIGIN       the one browser origin allowed by CORS
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/auth"
	"opsvision/internal/httpapi"
	"opsvision/internal/lambdahttp"
	"opsvision/internal/store"
	"opsvision/internal/store/dynamostore"
)

// errNotAuth0 is why the function will not start in any other auth mode. The
// dev-mode token validator accepts tokens anyone holding a shared secret can
// forge, so it must be impossible to enable by configuration drift.
var errNotAuth0 = errors.New("refusing to start: OPSVISION_AUTH_MODE must be auth0")

type appConfig struct {
	Table          string
	Auth0Domain    string
	Auth0Audience  string
	ClaimNamespace string
	AllowedOrigin  string
}

// loadConfig reads the configuration from getenv. The auth mode is checked
// first and must be exactly "auth0".
func loadConfig(getenv func(string) string) (appConfig, error) {
	if getenv("OPSVISION_AUTH_MODE") != auth.ModeAuth0 {
		return appConfig{}, errNotAuth0
	}
	c := appConfig{
		Table:          getenv("TABLE_NAME"),
		Auth0Domain:    getenv("AUTH0_DOMAIN"),
		Auth0Audience:  getenv("AUTH0_AUDIENCE"),
		ClaimNamespace: getenv("CLAIM_NAMESPACE"),
		AllowedOrigin:  getenv("ALLOWED_ORIGIN"),
	}
	for _, r := range []struct{ name, value string }{
		{"TABLE_NAME", c.Table},
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
	return c, nil
}

// newHandler assembles the API: CORS outermost (so preflights are answered
// before authentication), then compression and Auth0 token validation around
// the /v1 routes.
func newHandler(cfg appConfig, st store.Store) (http.Handler, error) {
	authMW, err := auth.Middleware(auth.Config{
		Mode:           auth.ModeAuth0,
		Domain:         cfg.Auth0Domain,
		Audience:       cfg.Auth0Audience,
		ClaimNamespace: cfg.ClaimNamespace,
	}, st)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	srv := httpapi.NewServer(httpapi.Deps{Store: st})
	return httpapi.CORS(cfg.AllowedOrigin)(httpapi.NewHandler(srv, authMW)), nil
}

func run(ctx context.Context) error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	if cfg.AllowedOrigin == "" {
		slog.Warn("ALLOWED_ORIGIN is not set; browsers on other origins cannot call this API")
	}
	awsCfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	st := dynamostore.New(dynamodb.NewFromConfig(awsCfg), cfg.Table)
	h, err := newHandler(cfg, st)
	if err != nil {
		return err
	}
	lambda.StartWithOptions(lambdahttp.Handler(h), lambda.WithContext(ctx))
	return nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(context.Background()); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}
