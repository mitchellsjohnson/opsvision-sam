package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	syntheticBootstrap = "../../internal/bootstrap/testdata/synthetic.json"
	sampleWorkbook     = "../../internal/legacy/testdata/legacy_sample.xlsx"
)

func noEnv(k string) string {
	if k == "OPSVISION_DEV_SECRET" {
		return goodSecret
	}
	return ""
}

func bootstrapOpts() options {
	o := devOpts()
	o.seed = "none"
	o.bootstrap = syntheticBootstrap
	return o
}

func TestBootstrapFlagRules(t *testing.T) {
	// -bootstrap alone turns the demo seed off.
	o, err := parseFlags([]string{"-bootstrap", syntheticBootstrap}, noEnv)
	if err != nil || o.seed != "none" || o.bootstrap != syntheticBootstrap {
		t.Fatalf("-bootstrap alone: %+v, %v", o, err)
	}

	for name, args := range map[string][]string{
		"with -seed demo":          {"-bootstrap", "b.json", "-seed", "demo"},
		"with dynamo":              {"-bootstrap", "b.json", "-store", "dynamo", "-table", "t"},
		"import without bootstrap": {"-import", "w.xlsx", "-import-template", "t1"},
		"import without template":  {"-bootstrap", "b.json", "-import", "w.xlsx"},
		"template without import":  {"-bootstrap", "b.json", "-import-template", "t1"},
	} {
		if _, err := parseFlags(args, noEnv); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	// The options themselves refuse a demo seed with a bootstrap, however built.
	bad := bootstrapOpts()
	bad.seed = "demo"
	if _, err := newHandler(context.Background(), bad); err == nil {
		t.Error("newHandler accepted -bootstrap with the demo seed")
	}

	good, err := parseFlags([]string{"-bootstrap", "b.json", "-import", "w.xlsx", "-import-template", "t1"}, noEnv)
	if err != nil || good.importFile != "w.xlsx" || good.importTemplate != "t1" {
		t.Errorf("full import flags: %+v, %v", good, err)
	}
}

func login(t *testing.T, h http.Handler, id string) string {
	t.Helper()
	w := serve(h, "POST", "/dev/login", `{"userId":"`+id+`"}`, "")
	if w.Code != 200 {
		t.Fatalf("login %s = %d: %s", id, w.Code, w.Body)
	}
	var out struct{ Token string }
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Token == "" {
		t.Fatalf("login %s body %s: %v", id, w.Body, err)
	}
	return out.Token
}

func TestBootstrapDevUsersAndLogin(t *testing.T) {
	h, err := newHandler(context.Background(), bootstrapOpts())
	if err != nil {
		t.Fatal(err)
	}

	w := serve(h, "GET", "/dev/users", "", "")
	var users []struct{ UserID, Email, Name, Role string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &users) != nil {
		t.Fatalf("GET /dev/users = %d: %s", w.Code, w.Body)
	}
	if len(users) != 3 || users[0].UserID != "dev|admin" || users[0].Email != "admin@sample.test" || users[0].Role != "admin" {
		t.Errorf("users = %+v (the demo users must not be listed)", users)
	}

	// Log in by user ID and by email; the token resolves to the bootstrap tenant.
	for _, id := range []string{"dev|admin", "viewer@sample.test", "dev|north"} {
		token := login(t, h, id)
		w := serve(h, "GET", "/v1/me", "", token)
		if w.Code != 200 {
			t.Fatalf("%s: GET /v1/me = %d: %s", id, w.Code, w.Body)
		}
		var me struct {
			Tenant struct{ Id, Name string }
		}
		if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil || me.Tenant.Id != "sample-co" {
			t.Errorf("%s: me = %s (%v), want tenant sample-co", id, w.Body, err)
		}
	}
	if w := serve(h, "POST", "/dev/login", `{"userId":"dev|contributor"}`, ""); w.Code != http.StatusNotFound {
		t.Errorf("demo user login = %d, want 404", w.Code)
	}

	token := login(t, h, "dev|admin")
	if w := serve(h, "GET", "/v1/scorecards", "", token); w.Code != 200 || !strings.Contains(w.Body.String(), `"sc"`) {
		t.Errorf("GET /v1/scorecards = %d: %s", w.Code, w.Body)
	}
}

func TestBootstrapStartupImport(t *testing.T) {
	o := bootstrapOpts()
	o.importFile = sampleWorkbook
	o.importTemplate = "legacy-1"
	app, err := build(context.Background(), o)
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	pts, _, err := app.store.ListData(context.Background(), "sample-co", "sc", []int{2025})
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) != 22 {
		t.Errorf("imported data points = %d, want 22", len(pts))
	}
	v, err := app.store.GetVersion(context.Background(), "sample-co", "sc", "v2-draft")
	if err != nil {
		t.Fatal(err)
	}
	var defined bool
	for _, m := range v.Content.Metrics {
		if m.Key == "uptime" && strings.Contains(m.Definition, "available") {
			defined = true
		}
	}
	if !defined {
		t.Errorf("the draft version did not receive the workbook's methodology text: %+v", v.Content.Metrics)
	}

	// The imported data is served.
	token := login(t, app.handler, "dev|admin")
	if w := serve(app.handler, "GET", "/v1/me", "", token); w.Code != 200 {
		t.Errorf("GET /v1/me = %d", w.Code)
	}
}

func TestBootstrapStartupImportFailuresRefuseToStart(t *testing.T) {
	// A template naming a subject that is not in the org tree produces an
	// error finding, so the import cannot be applied.
	raw, err := os.ReadFile(syntheticBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(broken, []byte(strings.ReplaceAll(string(raw), `"subject": "south"`, `"subject": "nowhere"`)), 0o600); err != nil {
		t.Fatal(err)
	}

	for name, mutate := range map[string]func(*options){
		"missing subject":  func(o *options) { o.bootstrap = broken },
		"unknown template": func(o *options) { o.importTemplate = "nope" },
		"missing workbook": func(o *options) { o.importFile = filepath.Join(t.TempDir(), "absent.xlsx") },
	} {
		o := bootstrapOpts()
		o.importFile = sampleWorkbook
		o.importTemplate = "legacy-1"
		mutate(&o)
		_, err := newHandler(context.Background(), o)
		if err == nil {
			t.Errorf("%s: newHandler succeeded, want a refusal to start", name)
			continue
		}
		if name == "missing subject" && strings.Contains(err.Error(), "nowhere") {
			t.Errorf("%s: the error repeats finding text: %v", name, err)
		}
	}
}
