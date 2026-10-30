// Command devserver runs the OpsVision API locally, for development, the
// proof of concept, and end-to-end tests.
//
//	go run ./cmd/devserver -seed demo
//
// By default it keeps data in memory, signs in with shared-secret dev tokens,
// and seeds the fictional Acme Demo tenant. In dev auth mode it also serves
// three endpoints outside /v1 and outside authentication:
//
//	GET  /dev/users                      the demo users
//	POST /dev/login {"userId": "..."}    {"token": "..."} for one of them
//	PUT  /dev/objects/{key...}           import uploads (see below)
//
// The first two let anyone who can reach the server become any demo user.
// They exist only with -auth dev; never expose a dev server to a network you
// do not trust.
//
// Imports keep uploaded workbooks in memory (-objects mem, the default). The
// upload URLs the API hands out point at PUT /dev/objects/{key...}?exp=<unix>&sig=<hex>,
// signed with the dev secret (HMAC-SHA256 of "key|exp") and valid for 15
// minutes; the endpoint accepts only the .xlsx content type and 20 MiB. With
// -objects s3 (and -uploads-bucket or $UPLOADS_BUCKET) uploads go to S3 with
// presigned URLs, as in production.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/httpapi"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/store"
	"opsvision/internal/store/dynamostore"
	"opsvision/internal/store/memstore"
)

type options struct {
	addr          string
	store         string // memory | dynamo
	table         string
	objects       string // mem | s3
	uploadsBucket string // S3 bucket (with -objects s3)
	auth          string // dev | auth0
	seed          string // demo | none
	devSecret     string
	allowedOrigin string
	auth0Domain   string
	auth0Audience string
}

// parseFlags reads options from args and the environment (getenv). The dev
// secret comes from -dev-secret, falling back to OPSVISION_DEV_SECRET; the
// Auth0 settings fall back to AUTH0_DOMAIN and AUTH0_AUDIENCE.
func parseFlags(args []string, getenv func(string) string) (options, error) {
	var o options
	fs := flag.NewFlagSet("devserver", flag.ContinueOnError)
	fs.StringVar(&o.addr, "addr", "127.0.0.1:8080", "listen address (loopback by default; dev auth is for local use only)")
	fs.StringVar(&o.store, "store", "memory", "data store: memory or dynamo")
	fs.StringVar(&o.table, "table", "", "DynamoDB table (with -store dynamo)")
	fs.StringVar(&o.objects, "objects", "mem", "import file storage: mem (in memory, dev uploads) or s3 (presigned S3 uploads)")
	fs.StringVar(&o.uploadsBucket, "uploads-bucket", "", "S3 bucket for import files (with -objects s3; default $UPLOADS_BUCKET)")
	fs.StringVar(&o.auth, "auth", "dev", "authentication: dev (shared-secret tokens, /dev/login) or auth0")
	fs.StringVar(&o.seed, "seed", "demo", "seed the store: demo (Acme Demo tenant) or none")
	fs.StringVar(&o.devSecret, "dev-secret", "", "dev token signing secret, at least 32 bytes (default $OPSVISION_DEV_SECRET)")
	fs.StringVar(&o.allowedOrigin, "allowed-origin", "http://localhost:5173", "browser origin allowed by CORS")
	fs.StringVar(&o.auth0Domain, "auth0-domain", "", "Auth0 domain (with -auth auth0; default $AUTH0_DOMAIN)")
	fs.StringVar(&o.auth0Audience, "auth0-audience", "", "Auth0 API audience (with -auth auth0; default $AUTH0_AUDIENCE)")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	if o.devSecret == "" {
		o.devSecret = getenv("OPSVISION_DEV_SECRET")
	}
	if o.uploadsBucket == "" {
		o.uploadsBucket = getenv("UPLOADS_BUCKET")
	}
	if o.auth0Domain == "" {
		o.auth0Domain = getenv("AUTH0_DOMAIN")
	}
	if o.auth0Audience == "" {
		o.auth0Audience = getenv("AUTH0_AUDIENCE")
	}
	return o, o.validate()
}

func (o options) validate() error {
	switch o.store {
	case "memory":
	case "dynamo":
		if o.table == "" {
			return errors.New("-store dynamo requires -table")
		}
	default:
		return fmt.Errorf("invalid -store %q (want memory or dynamo)", o.store)
	}
	switch o.objects {
	case "", "mem": // options built without the flag default to memory
	case "s3":
		if o.uploadsBucket == "" {
			return errors.New("-objects s3 requires -uploads-bucket (or UPLOADS_BUCKET)")
		}
	default:
		return fmt.Errorf("invalid -objects %q (want mem or s3)", o.objects)
	}
	switch o.seed {
	case "demo", "none":
	default:
		return fmt.Errorf("invalid -seed %q (want demo or none)", o.seed)
	}
	switch o.auth {
	case "dev":
		if len(o.devSecret) < auth.MinDevSecretBytes {
			return fmt.Errorf("refusing to start: dev auth needs a secret of at least %d bytes (-dev-secret or OPSVISION_DEV_SECRET)", auth.MinDevSecretBytes)
		}
	case "auth0":
		if o.auth0Domain == "" || o.auth0Audience == "" {
			return errors.New("-auth auth0 requires -auth0-domain and -auth0-audience (or AUTH0_DOMAIN and AUTH0_AUDIENCE)")
		}
	default:
		return fmt.Errorf("invalid -auth %q (want dev or auth0)", o.auth)
	}
	return nil
}

// openStore returns the configured store.
func openStore(ctx context.Context, o options) (store.Store, error) {
	if o.store == "memory" {
		return memstore.New(), nil
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return dynamostore.New(dynamodb.NewFromConfig(cfg), o.table), nil
}

// openObjects returns the configured import file store. The in-memory store
// signs its upload URLs with the dev secret and points them at this server.
func openObjects(ctx context.Context, o options) (objects.Store, error) {
	if o.objects == "s3" {
		cfg, err := config.LoadDefaultConfig(ctx)
		if err != nil {
			return nil, fmt.Errorf("load AWS config: %w", err)
		}
		return objects.NewS3(objects.NewS3Client(cfg), o.uploadsBucket), nil
	}
	return objects.NewMem(originOf(o.addr), objects.Signer(o.devSecret)), nil
}

// originOf returns the origin clients reach a server listening on addr by.
// An address without a host, or on all interfaces, is reached as localhost.
func originOf(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return "http://localhost:8080"
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// newHandler builds the server from validated-or-not options; it validates
// them itself so no caller can skip the dev secret check.
func newHandler(ctx context.Context, o options) (http.Handler, error) {
	h, _, err := newHandlerObjects(ctx, o)
	return h, err
}

// newHandlerObjects is newHandler that also returns the import file store.
func newHandlerObjects(ctx context.Context, o options) (http.Handler, objects.Store, error) {
	if err := o.validate(); err != nil {
		return nil, nil, err
	}
	st, err := openStore(ctx, o)
	if err != nil {
		return nil, nil, err
	}
	objs, err := openObjects(ctx, o)
	if err != nil {
		return nil, nil, err
	}
	if _, mem := objs.(*objects.Mem); mem && o.auth != "dev" {
		slog.Warn("in-memory import uploads are only served with -auth dev; use -objects s3 to import files")
	}
	if o.seed == "demo" {
		id, err := demo.Seed(ctx, st, period.Calendar{FiscalYearStartMonth: 1})
		if err != nil {
			return nil, nil, fmt.Errorf("seed demo data: %w", err)
		}
		slog.Info("demo tenant ready", "tenant", id)
	}

	authCfg := auth.Config{Mode: auth.ModeDev, DevSecret: o.devSecret}
	if o.auth == "auth0" {
		authCfg = auth.Config{Mode: auth.ModeAuth0, Domain: o.auth0Domain, Audience: o.auth0Audience}
	}
	authMW, err := auth.Middleware(authCfg, st)
	if err != nil {
		return nil, nil, fmt.Errorf("auth: %w", err)
	}
	api := httpapi.NewHandler(httpapi.NewServer(httpapi.Deps{Store: st, Objects: objs}), authMW)

	mux := http.NewServeMux()
	if o.auth == "dev" {
		mux.HandleFunc("GET /dev/users", devUsers)
		mux.HandleFunc("POST /dev/login", devLogin(o.devSecret))
		if mem, ok := objs.(*objects.Mem); ok {
			mux.HandleFunc("PUT "+objects.DevObjectsPath+"{key...}", devPutObject(mem, o.devSecret, func() time.Time { return time.Now() }))
		}
	}
	mux.Handle("/", api)
	return httpapi.CORS(o.allowedOrigin)(mux), objs, nil
}

// devPutObject accepts an import upload at a URL signed by objects.Mem. The
// signature is the only credential: it binds the key and an expiry. Only the
// .xlsx content type is accepted, up to objects.MaxUploadBytes.
func devPutObject(mem *objects.Mem, secret string, now func() time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")
		q := r.URL.Query()
		switch err := objects.Verify(secret, key, q.Get("exp"), q.Get("sig"), now()); {
		case errors.Is(err, objects.ErrExpired):
			devError(w, http.StatusForbidden, "forbidden", "upload URL expired; start the import again")
			return
		case err != nil:
			devError(w, http.StatusForbidden, "forbidden", "invalid upload signature")
			return
		}
		if r.Header.Get("Content-Type") != objects.ContentTypeXLSX {
			devError(w, http.StatusUnsupportedMediaType, "invalid", "Content-Type must be "+objects.ContentTypeXLSX)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, objects.MaxUploadBytes))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				devError(w, http.StatusRequestEntityTooLarge, "invalid", fmt.Sprintf("the file is larger than %d MiB", objects.MaxUploadBytes>>20))
				return
			}
			devError(w, http.StatusBadRequest, "invalid", "cannot read the upload")
			return
		}
		if err := mem.Put(r.Context(), key, objects.ContentTypeXLSX, body); err != nil {
			devError(w, http.StatusInternalServerError, "internal", "cannot store the upload")
			return
		}
		w.WriteHeader(http.StatusOK)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func devError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func devUsers(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, demo.Users)
}

// devLogin signs a token for a demo user, named by user ID or email.
func devLogin(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			UserID string `json:"userId"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
		if err := dec.Decode(&body); err != nil || strings.TrimSpace(body.UserID) == "" {
			devError(w, http.StatusBadRequest, "invalid", `body must be {"userId": "..."}`)
			return
		}
		for _, u := range demo.Users {
			if body.UserID != u.UserID && !strings.EqualFold(body.UserID, u.Email) {
				continue
			}
			token, err := auth.IssueDevToken(secret, u.UserID, u.Email, u.Name, demo.Auth0OrgID, false)
			if err != nil {
				devError(w, http.StatusInternalServerError, "internal", "cannot sign token")
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"token": token})
			return
		}
		devError(w, http.StatusNotFound, "not_found", "unknown demo user")
	}
}

// nonLoopback reports whether addr could be reached from another machine: it
// has no host (all interfaces), an unspecified or non-loopback IP, or a host
// name other than localhost. An address that cannot be parsed counts as
// non-loopback.
func nonLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return true
	}
	if host == "localhost" {
		return false
	}
	ip := net.ParseIP(host)
	return ip == nil || !ip.IsLoopback()
}

// banner warns, loudly, that dev auth is on.
func banner(o options) {
	lines := []string{
		"",
		"################################################################",
		"#  DEV AUTH MODE: FOR LOCAL DEVELOPMENT ONLY                    #",
		"#  Anyone who can reach this server can sign in as any demo     #",
		"#  user (POST /dev/login) and tokens are signed with a shared   #",
		"#  secret. Never expose it, and never point it at real data.    #",
		"################################################################",
		"",
	}
	fmt.Fprintln(os.Stderr, strings.Join(lines, "\n"))
	slog.Warn("dev auth mode enabled", "addr", o.addr, "store", o.store)
	if o.auth == "dev" && nonLoopback(o.addr) {
		slog.Warn("dev auth on a non-loopback address: anyone who can reach it can sign in as any demo user; use -addr 127.0.0.1:8080 unless you need remote access", "addr", o.addr)
	}
	if o.store == "dynamo" {
		slog.Warn("dev auth with a DynamoDB store: any demo data is written to the table", "table", o.table)
	}
}

func run(args []string) error {
	o, err := parseFlags(args, os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	h, err := newHandler(ctx, o)
	if err != nil {
		return err
	}
	if o.auth == "dev" {
		banner(o)
	}
	srv := &http.Server{
		Addr:              o.addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("listening", "addr", o.addr, "auth", o.auth, "store", o.store, "allowedOrigin", o.allowedOrigin)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		slog.Error(err.Error())
		os.Exit(1)
	}
}
