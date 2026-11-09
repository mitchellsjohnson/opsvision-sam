package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	syntheticBootstrap = "../../internal/bootstrap/testdata/synthetic.json"
	sampleWorkbook     = "../../internal/legacy/testdata/legacy_sample.xlsx"
)

// check runs the command and returns its exit code, stdout and stderr.
func check(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := run(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func baseArgs() []string {
	return []string{"-bootstrap", syntheticBootstrap, "-workbook", sampleWorkbook, "-template", "legacy-1"}
}

// brokenBootstrap writes a copy of the synthetic file whose template names a
// subject that does not exist.
func brokenBootstrap(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(syntheticBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "broken.json")
	body := strings.ReplaceAll(string(raw), `"subject": "south"`, `"subject": "nowhere"`)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestImportcheckPrintsCounts(t *testing.T) {
	code, out, errOut := check(t, baseArgs()...)
	if code != 0 {
		t.Fatalf("exit %d; stdout:\n%s\nstderr:\n%s", code, out, errOut)
	}
	for _, want := range []string{"data points: 22", "overrides: 1", "version text: 9", "legacy notes: 1", "template: legacy-1", "scorecard: sc"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout is missing %q:\n%s", want, out)
		}
	}
	if errOut != "" {
		t.Errorf("stderr = %q, want nothing", errOut)
	}
}

// A single-organization deployment's bootstrap file has no auth0OrgId: the
// tenant comes from configuration, not from the sign-in organization.
func TestImportcheckAcceptsSingleOrgBootstrap(t *testing.T) {
	raw, err := os.ReadFile(syntheticBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	delete(doc["tenant"].(map[string]any), "auth0OrgId")
	body, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "single-org.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}

	code, out, errOut := check(t, "-bootstrap", path, "-workbook", sampleWorkbook, "-template", "legacy-1")
	if code != 0 {
		t.Fatalf("exit %d; stdout:\n%s\nstderr:\n%s", code, out, errOut)
	}
	if !strings.Contains(out, "data points: 22") {
		t.Errorf("stdout is missing the counts:\n%s", out)
	}
}

func TestImportcheckExitsOneOnErrorFindings(t *testing.T) {
	args := []string{"-bootstrap", brokenBootstrap(t), "-workbook", sampleWorkbook, "-template", "legacy-1"}
	code, out, _ := check(t, args...)
	if code != 1 {
		t.Fatalf("exit = %d, want 1; stdout:\n%s", code, out)
	}
	if !strings.Contains(out, "error (") || !strings.Contains(out, "nowhere") || !strings.Contains(out, "Scorecard") {
		t.Errorf("findings are not grouped by severity and sheet:\n%s", out)
	}
}

func TestImportcheckFiltersAndLimits(t *testing.T) {
	broken := brokenBootstrap(t)
	args := func(extra ...string) []string {
		return append([]string{"-bootstrap", broken, "-workbook", sampleWorkbook, "-template", "legacy-1"}, extra...)
	}

	// -sheet that matches nothing hides every finding but the exit code still reflects them.
	code, out, _ := check(t, args("-sheet", "No Such Sheet")...)
	if code != 1 || strings.Contains(out, "nowhere") {
		t.Errorf("-sheet filter: exit %d, output:\n%s", code, out)
	}

	// -limit 1 truncates a group and says so.
	_, out, _ = check(t, args("-limit", "1")...)
	if !strings.Contains(out, "more") {
		t.Errorf("-limit 1 did not report the findings it left out:\n%s", out)
	}

	// -severity error shows only errors.
	_, out, _ = check(t, args("-severity", "error")...)
	if strings.Contains(out, "\nwarn (") || strings.Contains(out, "\ninfo (") {
		t.Errorf("-severity error printed lower severities:\n%s", out)
	}
}

func TestImportcheckJSON(t *testing.T) {
	code, out, _ := check(t, append(baseArgs(), "-json")...)
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, out)
	}
	var doc struct {
		TemplateID  string `json:"templateId"`
		ScorecardID string `json:"scorecardId"`
		Counts      struct {
			DataPoints  int `json:"dataPoints"`
			Overrides   int `json:"overrides"`
			VersionText int `json:"versionText"`
			LegacyNotes int `json:"legacyNotes"`
		} `json:"counts"`
		Findings map[string]int `json:"findingCounts"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if doc.TemplateID != "legacy-1" || doc.ScorecardID != "sc" || doc.Counts.DataPoints != 22 || doc.Counts.LegacyNotes != 1 {
		t.Errorf("doc = %+v", doc)
	}
}

func TestImportcheckUsageAndInputErrors(t *testing.T) {
	for name, args := range map[string][]string{
		"no flags":         {},
		"no workbook":      {"-bootstrap", syntheticBootstrap, "-template", "legacy-1"},
		"bad severity":     append(baseArgs(), "-severity", "loud"),
		"bad limit":        append(baseArgs(), "-limit", "0"),
		"missing workbook": {"-bootstrap", syntheticBootstrap, "-workbook", filepath.Join(t.TempDir(), "absent.xlsx"), "-template", "legacy-1"},
		"unknown template": {"-bootstrap", syntheticBootstrap, "-workbook", sampleWorkbook, "-template", "nope"},
		"missing config":   {"-bootstrap", filepath.Join(t.TempDir(), "absent.json"), "-workbook", sampleWorkbook, "-template", "legacy-1"},
	} {
		code, out, errOut := check(t, args...)
		if code != 2 {
			t.Errorf("%s: exit %d, want 2 (stdout %q)", name, code, out)
		}
		if errOut == "" {
			t.Errorf("%s: no message on stderr", name)
		}
	}
}

func TestImportcheckWritesNoFiles(t *testing.T) {
	bs, err := filepath.Abs(syntheticBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	wb, err := filepath.Abs(sampleWorkbook)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Chdir(dir)
	if code, out, errOut := check(t, "-bootstrap", bs, "-workbook", wb, "-template", "legacy-1"); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errOut)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Errorf("working directory has %d entries after a run (%v)", len(entries), err)
	}
}
