package bootstrap

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store/memstore"
)

const syntheticFile = "testdata/synthetic.json"

// syntheticMap decodes the synthetic file into a generic map so tests can
// break one part of it and write the result to a temp file.
func syntheticMap(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile(syntheticFile)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func writeMap(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "bootstrap.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// slice returns the JSON array at key as a []any.
func slice(t *testing.T, m map[string]any, key string) []any {
	t.Helper()
	s, ok := m[key].([]any)
	if !ok {
		t.Fatalf("%s is not an array", key)
	}
	return s
}

func TestLoadValidSynthetic(t *testing.T) {
	f, err := Load(syntheticFile)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if f.Tenant.ID != "sample-co" || f.Tenant.Auth0OrgID != "org_sample_co" {
		t.Errorf("tenant = %+v", f.Tenant)
	}
	if len(f.Tenant.StatusScale) != 3 || f.Tenant.DefaultRole != domain.RoleViewer {
		t.Errorf("tenant defaults not filled: %+v", f.Tenant)
	}
	if len(f.Units) != 3 || len(f.Versions) != 2 || len(f.Templates) != 1 || len(f.Users) != 3 {
		t.Errorf("counts: units=%d versions=%d templates=%d users=%d", len(f.Units), len(f.Versions), len(f.Templates), len(f.Users))
	}
	if f.Versions[0].EffectiveFrom != (period.Period{Grain: period.Year, FY: 2025}) {
		t.Errorf("effectiveFrom = %v", f.Versions[0].EffectiveFrom)
	}
	if got := f.Users[2].Scope.OrgUnitIDs; len(got) != 1 || got[0] != "north" {
		t.Errorf("scope = %v", got)
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	m := syntheticMap(t)
	m["surprise"] = true
	if _, err := Load(writeMap(t, m)); err == nil || !strings.Contains(err.Error(), "surprise") {
		t.Errorf("top-level unknown field: err = %v", err)
	}

	m = syntheticMap(t)
	slice(t, m, "units")[0].(map[string]any)["colour"] = "red"
	if _, err := Load(writeMap(t, m)); err == nil || !strings.Contains(err.Error(), "colour") {
		t.Errorf("nested unknown field: err = %v", err)
	}

	// Data after the document is also refused.
	path := filepath.Join(t.TempDir(), "b.json")
	b, _ := os.ReadFile(syntheticFile)
	if err := os.WriteFile(path, append(b, []byte(`{"x":1}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Error("trailing data accepted")
	}
}

func TestLoadMissingFile(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Error("missing file accepted")
	}
}

func TestLoadReportsInvalidMethodology(t *testing.T) {
	m := syntheticMap(t)
	versions := slice(t, m, "versions")
	// Published version: break a formula. Draft version: break it too, which
	// is allowed.
	for _, v := range versions {
		metrics := v.(map[string]any)["content"].(map[string]any)["metrics"].([]any)
		metrics[0].(map[string]any)["formula"] = "no_such_measure / 2"
	}
	_, err := Load(writeMap(t, m))
	if err == nil {
		t.Fatal("invalid published methodology accepted")
	}
	msg := err.Error()
	if !strings.Contains(msg, "v1") || !strings.Contains(msg, "formula") {
		t.Errorf("error does not locate the bad published version: %v", err)
	}
	if strings.Contains(msg, "v2-draft") {
		t.Errorf("draft version must not be validated: %v", err)
	}

	// With only the draft broken the file loads.
	m = syntheticMap(t)
	metrics := slice(t, m, "versions")[1].(map[string]any)["content"].(map[string]any)["metrics"].([]any)
	metrics[0].(map[string]any)["formula"] = "no_such_measure / 2"
	if _, err := Load(writeMap(t, m)); err != nil {
		t.Errorf("invalid draft rejected: %v", err)
	}
}

func TestLoadReportsBadTemplate(t *testing.T) {
	m := syntheticMap(t)
	body := slice(t, m, "templates")[0].(map[string]any)["body"].(map[string]any)
	rows := body["rows"].([]any)
	rows[1].(map[string]any)["convert"] = "no_such_converter"
	_, err := Load(writeMap(t, m))
	if err == nil || !strings.Contains(err.Error(), "legacy-1") || !strings.Contains(err.Error(), "converter") {
		t.Errorf("bad template: err = %v", err)
	}

	m = syntheticMap(t)
	slice(t, m, "templates")[0].(map[string]any)["body"].(map[string]any)["bogus"] = 1
	if _, err := Load(writeMap(t, m)); err == nil || !strings.Contains(err.Error(), "legacy-1") {
		t.Errorf("template with unknown field: err = %v", err)
	}

	m = syntheticMap(t)
	slice(t, m, "templates")[0].(map[string]any)["body"].(map[string]any)["scorecardId"] = "missing"
	if _, err := Load(writeMap(t, m)); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Errorf("template naming an unknown scorecard: err = %v", err)
	}
}

func TestLoadReportsEveryProblem(t *testing.T) {
	m := syntheticMap(t)
	m["tenant"].(map[string]any)["auth0OrgId"] = ""
	slice(t, m, "units")[1].(map[string]any)["id"] = "bad id!"
	slice(t, m, "levels")[1].(map[string]any)["depth"] = 0
	_, err := Load(writeMap(t, m))
	if err == nil {
		t.Fatal("invalid file accepted")
	}
	for _, want := range []string{"auth0OrgId", "bad id!", "depth"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error is missing %q: %v", want, err)
		}
	}
}

func TestLoadRejectsBrokenTree(t *testing.T) {
	m := syntheticMap(t)
	slice(t, m, "units")[1].(map[string]any)["parentId"] = "nowhere"
	if _, err := Load(writeMap(t, m)); err == nil || !strings.Contains(err.Error(), "nowhere") {
		t.Errorf("unknown parent: err = %v", err)
	}
}

func TestLoadRejectsBadReferences(t *testing.T) {
	for name, mutate := range map[string]func(m map[string]any){
		"unit level": func(m map[string]any) { slice(t, m, "units")[1].(map[string]any)["levelId"] = "ghost" },
		"item kind":  func(m map[string]any) { slice(t, m, "items")[0].(map[string]any)["kindId"] = "ghost" },
		"item unit":  func(m map[string]any) { slice(t, m, "items")[0].(map[string]any)["orgUnitId"] = "ghost" },
		"version sc": func(m map[string]any) { slice(t, m, "versions")[0].(map[string]any)["scorecardId"] = "ghost" },
		"user role":  func(m map[string]any) { slice(t, m, "users")[0].(map[string]any)["role"] = "owner" },
		"user scope": func(m map[string]any) {
			slice(t, m, "users")[2].(map[string]any)["scope"] = map[string]any{"orgUnitIds": []any{"ghost"}}
		},
	} {
		m := syntheticMap(t)
		mutate(m)
		if _, err := Load(writeMap(t, m)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestApplyCreatesEverything(t *testing.T) {
	f, err := Load(syntheticFile)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	st := memstore.New()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := Apply(ctx, st, f, now); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	tn, err := st.TenantByAuth0Org(ctx, "org_sample_co")
	if err != nil || tn.ID != "sample-co" || !tn.CreatedAt.Equal(now) {
		t.Fatalf("tenant = %+v, %v", tn, err)
	}
	if ls, _ := st.ListLevels(ctx, "sample-co"); len(ls) != 2 {
		t.Errorf("levels = %v", ls)
	}
	if us, _ := st.ListOrgUnits(ctx, "sample-co"); len(us) != 3 {
		t.Errorf("units = %v", us)
	}
	if ks, _ := st.ListItemKinds(ctx, "sample-co"); len(ks) != 1 {
		t.Errorf("kinds = %v", ks)
	}
	if is, _ := st.ListTrackedItems(ctx, "sample-co"); len(is) != 1 {
		t.Errorf("items = %v", is)
	}
	if scs, _ := st.ListScorecards(ctx, "sample-co"); len(scs) != 1 {
		t.Errorf("scorecards = %v", scs)
	}
	vs, err := st.ListVersions(ctx, "sample-co", "sc")
	if err != nil || len(vs) != 2 {
		t.Fatalf("versions = %v, %v", vs, err)
	}
	for _, v := range vs {
		if v.Revision != 1 {
			t.Errorf("version %s revision = %d, want 1", v.ID, v.Revision)
		}
	}
	tpls, err := st.ListTemplates(ctx, "sample-co")
	if err != nil || len(tpls) != 1 || tpls[0].ID != "legacy-1" || tpls[0].Profile != "legacy_workbook" {
		t.Fatalf("templates = %+v, %v", tpls, err)
	}
	var body map[string]any
	if err := json.Unmarshal(tpls[0].Body, &body); err != nil || body["sheets"] == nil {
		t.Errorf("template body = %s, %v", tpls[0].Body, err)
	}
	ms, err := st.ListMemberships(ctx, "sample-co")
	if err != nil || len(ms) != 3 {
		t.Fatalf("memberships = %+v, %v", ms, err)
	}
	m, err := st.GetMembership(ctx, "sample-co", "dev|north")
	if err != nil || m.Role != domain.RoleContributor || m.Email != "north@sample.test" || len(m.Scope.OrgUnitIDs) != 1 {
		t.Errorf("membership = %+v, %v", m, err)
	}
	if tids, _ := st.TenantsForUser(ctx, "dev|admin"); len(tids) != 1 || tids[0] != "sample-co" {
		t.Errorf("tenants for admin = %v", tids)
	}
}

func TestApplyRefusesExistingTenant(t *testing.T) {
	f, err := Load(syntheticFile)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	st := memstore.New()
	if err := Apply(ctx, st, f, time.Now()); err != nil {
		t.Fatal(err)
	}
	err = Apply(ctx, st, f, time.Now())
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("second Apply: err = %v, want an already-exists refusal", err)
	}
}

// TestDocExampleLoads keeps the example in docs/deploy/local-bootstrap.md valid.
func TestDocExampleLoads(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/deploy/local-bootstrap.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(doc)
	const open = "```json\n"
	i := strings.Index(text, open)
	if i < 0 {
		t.Fatal("no json example in the doc")
	}
	text = text[i+len(open):]
	j := strings.Index(text, "```")
	if j < 0 {
		t.Fatal("unterminated json example")
	}
	path := filepath.Join(t.TempDir(), "example.json")
	if err := os.WriteFile(path, []byte(text[:j]), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err != nil {
		t.Errorf("the documented example does not load: %v", err)
	}
}
