package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

const (
	syntheticBootstrap = "../../internal/bootstrap/testdata/synthetic.json"
	sampleWorkbook     = "../../internal/legacy/testdata/legacy_sample.xlsx"
	tenantID           = "sample-co"
)

var fixedNow = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

// admin runs the command against st and returns its exit code and output.
func admin(t *testing.T, st store.Store, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	d := deps{
		open: func(_ context.Context, table string) (store.Store, error) {
			if table == "" {
				t.Error("open called without a table")
			}
			return st, nil
		},
		now:  func() time.Time { return fixedNow },
		user: func() string { return "tester" },
	}
	code := run(args, &out, &errOut, d)
	return code, out.String(), errOut.String()
}

func bootstrapArgs(extra ...string) []string {
	return append([]string{"bootstrap", "-table", "t", "-file", syntheticBootstrap}, extra...)
}

func importArgs(extra ...string) []string {
	return append([]string{"import", "-table", "t", "-tenant", tenantID, "-workbook", sampleWorkbook, "-template", "legacy-1"}, extra...)
}

// line returns the output line starting with prefix.
func line(t *testing.T, out, prefix string) string {
	t.Helper()
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, prefix) {
			return l
		}
	}
	t.Fatalf("no %q line in:\n%s", prefix, out)
	return ""
}

func loaded(t *testing.T) *memstore.Store {
	t.Helper()
	st := memstore.New()
	if code, out, errOut := admin(t, st, bootstrapArgs()...); code != 0 {
		t.Fatalf("bootstrap exit %d\n%s\n%s", code, out, errOut)
	}
	return st
}

func TestBootstrapLoadsTenant(t *testing.T) {
	ctx := context.Background()
	st := memstore.New()
	code, out, errOut := admin(t, st, bootstrapArgs()...)
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	tn, err := st.GetTenant(ctx, tenantID)
	if err != nil || tn.Name != "Sample Co" || !tn.CreatedAt.Equal(fixedNow) {
		t.Fatalf("tenant = %+v, %v", tn, err)
	}
	units, _ := st.ListOrgUnits(ctx, tenantID)
	vs, _ := st.ListVersions(ctx, tenantID, "sc")
	tpls, _ := st.ListTemplates(ctx, tenantID)
	ms, _ := st.ListMemberships(ctx, tenantID)
	if len(units) != 3 || len(vs) != 2 || len(tpls) != 1 || len(ms) != 3 {
		t.Fatalf("units=%d versions=%d templates=%d members=%d", len(units), len(vs), len(tpls), len(ms))
	}
	for _, v := range vs {
		if v.Revision != 1 {
			t.Errorf("version %s revision = %d, want 1", v.ID, v.Revision)
		}
	}
	for prefix, want := range map[string]string{
		"tenant:":    "tenant: 1 created, 0 updated, 0 unchanged",
		"units:":     "units: 3 created, 0 updated, 0 unchanged",
		"versions:":  "versions: 2 created, 0 updated, 0 unchanged",
		"templates:": "templates: 1 created, 0 updated, 0 unchanged",
		"users:":     "users: 3 created, 0 updated, 0 unchanged",
	} {
		if got := line(t, out, prefix); got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
}

// A single-organization deployment has no Auth0 organization to name.
func TestBootstrapAcceptsEmptyOrganization(t *testing.T) {
	raw, err := os.ReadFile(syntheticBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(raw), `"auth0OrgId": "org_sample_co",`, "", 1)
	if body == string(raw) {
		t.Fatal("fixture no longer names auth0OrgId")
	}
	path := filepath.Join(t.TempDir(), "single-org.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	st := memstore.New()
	code, out, errOut := admin(t, st, "bootstrap", "-table", "t", "-file", path)
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	if tn, err := st.GetTenant(context.Background(), tenantID); err != nil || tn.Auth0OrgID != "" {
		t.Fatalf("tenant = %+v, %v", tn, err)
	}
}

func TestBootstrapTwice(t *testing.T) {
	ctx := context.Background()
	st := loaded(t)
	code, out, errOut := admin(t, st, bootstrapArgs()...)
	if code != 0 {
		t.Fatalf("second run exit %d\n%s\n%s", code, out, errOut)
	}
	for _, prefix := range []string{"tenant:", "levels:", "units:", "item kinds:", "items:", "scorecards:", "versions:", "templates:", "users:"} {
		l := line(t, out, prefix)
		if !strings.Contains(l, " 0 created, 0 updated, ") || strings.HasSuffix(l, " 0 unchanged") {
			t.Errorf("second run: %q, want everything unchanged", l)
		}
	}
	if got := line(t, out, "versions:"); got != "versions: 0 created, 0 updated, 2 unchanged" {
		t.Errorf("versions line = %q", got)
	}

	units, _ := st.ListOrgUnits(ctx, tenantID)
	vs, _ := st.ListVersions(ctx, tenantID, "sc")
	tpls, _ := st.ListTemplates(ctx, tenantID)
	ms, _ := st.ListMemberships(ctx, tenantID)
	if len(units) != 3 || len(vs) != 2 || len(tpls) != 1 || len(ms) != 3 {
		t.Fatalf("duplicates: units=%d versions=%d templates=%d members=%d", len(units), len(vs), len(tpls), len(ms))
	}
	for _, v := range vs {
		if v.Revision != 1 {
			t.Errorf("version %s revision = %d after a second run, want 1", v.ID, v.Revision)
		}
	}
	if tpls[0].Revision != 1 {
		t.Errorf("template revision = %d after a second run, want 1", tpls[0].Revision)
	}
}

// A changed version in the file updates the stored one from its own revision.
func TestBootstrapUpdatesChangedVersion(t *testing.T) {
	st := loaded(t)
	raw, _ := os.ReadFile(syntheticBootstrap)
	if !strings.Contains(string(raw), `"name": "v1"`) {
		t.Fatal("fixture no longer names version v1")
	}
	path := filepath.Join(t.TempDir(), "changed.json")
	if err := os.WriteFile(path, []byte(strings.Replace(string(raw), `"name": "v1"`, `"name": "Version one"`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := admin(t, st, "bootstrap", "-table", "t", "-file", path)
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	if got := line(t, out, "versions:"); got != "versions: 0 created, 1 updated, 1 unchanged" {
		t.Errorf("versions line = %q", got)
	}
	v, err := st.GetVersion(context.Background(), tenantID, "sc", "v1")
	if err != nil || v.Name != "Version one" || v.Revision != 2 {
		t.Errorf("v1 = %q revision %d, %v; want updated at revision 2", v.Name, v.Revision, err)
	}
}

func TestBootstrapDryRunWritesNothing(t *testing.T) {
	st := memstore.New()
	code, out, errOut := admin(t, st, bootstrapArgs("-dry-run")...)
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	if !strings.Contains(out, "dry run") || line(t, out, "units:") != "units: 3 created, 0 updated, 0 unchanged" {
		t.Errorf("dry run output:\n%s", out)
	}
	if _, err := st.GetTenant(context.Background(), tenantID); err == nil {
		t.Error("a dry run created the tenant")
	}
}

func TestBootstrapRefusesChangedTenant(t *testing.T) {
	st := loaded(t)
	raw, _ := os.ReadFile(syntheticBootstrap)
	path := filepath.Join(t.TempDir(), "renamed.json")
	if err := os.WriteFile(path, []byte(strings.Replace(string(raw), `"name": "Sample Co"`, `"name": "Renamed Co"`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := admin(t, st, "bootstrap", "-table", "t", "-file", path)
	if code != 2 || !strings.Contains(errOut, "tenant") || !strings.Contains(errOut, "name") {
		t.Errorf("exit %d, stderr %q; want 2 naming the tenant's changed name", code, errOut)
	}
	if tn, _ := st.GetTenant(context.Background(), tenantID); tn.Name != "Sample Co" {
		t.Errorf("tenant name = %q, want it untouched", tn.Name)
	}
}

func TestImportDryRunWritesNothing(t *testing.T) {
	ctx := context.Background()
	st := loaded(t)
	before, _ := st.GetVersion(ctx, tenantID, "sc", "v2")
	code, out, errOut := admin(t, st, importArgs("-dry-run")...)
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	m := regexp.MustCompile(`data points: (\d+)`).FindStringSubmatch(out)
	if m == nil || m[1] == "0" || !strings.Contains(out, "findings:") || !strings.Contains(out, "dry run") {
		t.Errorf("dry run output:\n%s", out)
	}
	pts, ovs, _ := st.ListData(ctx, tenantID, "sc", []int{2023, 2024, 2025, 2026, 2027})
	if len(pts) != 0 || len(ovs) != 0 {
		t.Errorf("a dry run wrote %d points and %d overrides", len(pts), len(ovs))
	}
	if audit, _ := st.ListAudit(ctx, tenantID, time.Time{}, fixedNow.AddDate(10, 0, 0)); len(audit) != 0 {
		t.Errorf("a dry run wrote %d audit entries", len(audit))
	}
	if after, _ := st.GetVersion(ctx, tenantID, "sc", "v2"); after.Revision != before.Revision {
		t.Errorf("a dry run changed draft version v2: revision %d -> %d", before.Revision, after.Revision)
	}
}

func TestImportApplies(t *testing.T) {
	ctx := context.Background()
	st := loaded(t)
	code, out, errOut := admin(t, st, importArgs()...)
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	m := regexp.MustCompile(`data points: (\d+)`).FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no data points count:\n%s", out)
	}
	want, _ := strconv.Atoi(m[1])
	if want == 0 || !strings.Contains(out, "applied:") {
		t.Fatalf("output:\n%s", out)
	}
	pts, _, _ := st.ListData(ctx, tenantID, "sc", []int{2023, 2024, 2025, 2026, 2027})
	if len(pts) != want {
		t.Errorf("stored %d data points, parsed %d", len(pts), want)
	}
	for _, p := range pts {
		if p.EnteredBy != "cli:tester" {
			t.Errorf("point entered by %q, want cli:tester", p.EnteredBy)
			break
		}
	}
	audit, _ := st.ListAudit(ctx, tenantID, time.Time{}, fixedNow.AddDate(10, 0, 0))
	if len(audit) != 1 || audit[0].ActorID != "cli:tester" || audit[0].Channel != "import" || audit[0].Action != "import.apply" {
		t.Errorf("audit = %+v, want one import.apply entry by cli:tester on channel import", audit)
	}
}

func TestImportErrorFindingsApplyNothing(t *testing.T) {
	ctx := context.Background()
	st := memstore.New()
	raw, _ := os.ReadFile(syntheticBootstrap)
	body := strings.ReplaceAll(string(raw), `"subject": "south"`, `"subject": "nowhere"`)
	path := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := admin(t, st, "bootstrap", "-table", "t", "-file", path); code != 0 {
		t.Fatalf("bootstrap exit %d: %s", code, errOut)
	}
	code, out, _ := admin(t, st, importArgs()...)
	if code != 1 || !strings.Contains(out, "error (") || !strings.Contains(out, "nowhere") {
		t.Errorf("exit %d, output:\n%s; want 1 with the error findings", code, out)
	}
	if pts, _, _ := st.ListData(ctx, tenantID, "sc", []int{2023, 2024, 2025, 2026, 2027}); len(pts) != 0 {
		t.Errorf("wrote %d points despite error findings", len(pts))
	}
	if audit, _ := st.ListAudit(ctx, tenantID, time.Time{}, fixedNow.AddDate(10, 0, 0)); len(audit) != 0 {
		t.Errorf("wrote %d audit entries despite error findings", len(audit))
	}
}

func TestImportUnknownTenantAndTemplate(t *testing.T) {
	st := loaded(t)
	args := importArgs()
	for i, a := range args {
		if a == tenantID {
			args[i] = "no-such-tenant"
		}
	}
	if code, _, errOut := admin(t, st, args...); code != 2 || !strings.Contains(errOut, "no-such-tenant") {
		t.Errorf("unknown tenant: exit %d, stderr %q", code, errOut)
	}
	args = importArgs()
	for i, a := range args {
		if a == "legacy-1" {
			args[i] = "no-such-template"
		}
	}
	if code, _, errOut := admin(t, st, args...); code != 2 || !strings.Contains(errOut, "no-such-template") {
		t.Errorf("unknown template: exit %d, stderr %q", code, errOut)
	}
}

func TestUsageErrors(t *testing.T) {
	st := memstore.New()
	for name, args := range map[string][]string{
		"no subcommand":      {},
		"unknown subcommand": {"frobnicate"},
		"bootstrap no flags": {"bootstrap"},
		"bootstrap no table": {"bootstrap", "-file", syntheticBootstrap},
		"bootstrap no file":  {"bootstrap", "-table", "t"},
		"bootstrap bad file": {"bootstrap", "-table", "t", "-file", "does-not-exist.json"},
		"import no flags":    {"import"},
		"import no tenant":   {"import", "-table", "t", "-workbook", sampleWorkbook, "-template", "legacy-1"},
		"import no workbook": {"import", "-table", "t", "-tenant", tenantID, "-template", "legacy-1"},
		"import no template": {"import", "-table", "t", "-tenant", tenantID, "-workbook", sampleWorkbook},
		"import bad file":    {"import", "-table", "t", "-tenant", tenantID, "-workbook", "nope.xlsx", "-template", "legacy-1"},
	} {
		t.Run(name, func(t *testing.T) {
			code, _, errOut := admin(t, st, args...)
			if code != 2 || errOut == "" {
				t.Errorf("exit %d, stderr %q; want 2 with a message", code, errOut)
			}
		})
	}
}
