package importer_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"opsvision/internal/bootstrap"
	"opsvision/internal/domain"
	"opsvision/internal/importer"
	"opsvision/internal/legacy"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

const (
	syntheticBootstrap = "../bootstrap/testdata/synthetic.json"
	sampleWorkbook     = "../legacy/testdata/legacy_sample.xlsx"
)

func loaded(t *testing.T) (store.Store, domain.Tenant) {
	t.Helper()
	f, err := bootstrap.Load(syntheticBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	st := memstore.New()
	if err := bootstrap.Apply(context.Background(), st, f, time.Now()); err != nil {
		t.Fatal(err)
	}
	return st, f.Tenant
}

func TestParseStoredMatchesTheSampleWorkbook(t *testing.T) {
	st, tenant := loaded(t)
	wb, err := importer.OpenWorkbookFile(sampleWorkbook)
	if err != nil {
		t.Fatal(err)
	}
	res, err := importer.ParseStored(context.Background(), st, tenant, importer.CalendarOf(tenant), "legacy-1", wb)
	if err != nil {
		t.Fatal(err)
	}
	cs := res.ChangeSet
	if res.ScorecardID != "sc" || len(cs.Data) != 22 || len(cs.Overrides) != 1 || len(cs.VersionText) != 9 {
		t.Errorf("result = scorecard %q, %d data, %d overrides, %d text", res.ScorecardID, len(cs.Data), len(cs.Overrides), len(cs.VersionText))
	}
	if n := importer.CountFindings(cs.Findings)["error"]; n != 0 {
		t.Errorf("error findings = %d", n)
	}
}

func TestParseStoredRefusals(t *testing.T) {
	st, tenant := loaded(t)
	ctx := context.Background()
	wb, err := importer.OpenWorkbookFile(sampleWorkbook)
	if err != nil {
		t.Fatal(err)
	}
	_, err = importer.ParseStored(ctx, st, tenant, importer.CalendarOf(tenant), "nope", wb)
	var ie *importer.Error
	if !errors.As(err, &ie) || ie.Path != "templateId" {
		t.Errorf("unknown template: %v", err)
	}

	if err := st.PutTemplate(ctx, tenant.ID, store.Template{ID: "csv-1", Name: "csv", Profile: "csv"}); err != nil {
		t.Fatal(err)
	}
	if _, err := importer.ParseStored(ctx, st, tenant, importer.CalendarOf(tenant), "csv-1", wb); err == nil || !strings.Contains(err.Error(), "legacy_workbook") {
		t.Errorf("csv template: %v", err)
	}

	if err := st.PutTemplate(ctx, tenant.ID, store.Template{ID: "bad", Name: "bad", Profile: "legacy_workbook", Body: []byte(`{"sheets":[]}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := importer.ParseStored(ctx, st, tenant, importer.CalendarOf(tenant), "bad", wb); err == nil || !strings.Contains(err.Error(), "not valid") {
		t.Errorf("invalid template: %v", err)
	}
}

func TestResolveScorecard(t *testing.T) {
	st, tenant := loaded(t)
	ctx := context.Background()

	if id, err := importer.ResolveScorecard(ctx, st, tenant.ID, ""); err != nil || id != "sc" {
		t.Errorf("only scorecard: %q, %v", id, err)
	}
	if id, err := importer.ResolveScorecard(ctx, st, tenant.ID, "sc"); err != nil || id != "sc" {
		t.Errorf("named: %q, %v", id, err)
	}
	var ie *importer.Error
	if _, err := importer.ResolveScorecard(ctx, st, tenant.ID, "ghost"); !errors.As(err, &ie) || ie.Path != "body.scorecardId" {
		t.Errorf("unknown named: %v", err)
	}
	if err := st.PutScorecard(ctx, tenant.ID, domain.Scorecard{ID: "second", Name: "Second"}); err != nil {
		t.Fatal(err)
	}
	if _, err := importer.ResolveScorecard(ctx, st, tenant.ID, ""); !errors.As(err, &ie) || ie.Path != "" {
		t.Errorf("several scorecards: %v", err)
	}
}

func TestYears(t *testing.T) {
	tpl := legacy.Template{Sheets: []legacy.SheetMap{
		{Sheet: "A", FiscalYear: 2025},
		{Sheet: "B", FiscalYear: 2027, PeriodColumns: map[string]string{"C": "2026-Q4", "D": "not a period"}},
	}}
	if got, want := importer.Years(tpl), []int{2024, 2025, 2026, 2027}; !slices.Equal(got, want) {
		t.Errorf("Years = %v, want %v", got, want)
	}
}

func TestYearsIncludesRowPeriodColumns(t *testing.T) {
	tpl := legacy.Template{
		Sheets: []legacy.SheetMap{{Sheet: "A", FiscalYear: 2025}},
		Rows:   []legacy.RowMap{{Sheet: "A", PeriodColumns: map[string]string{"F": "2028-Q1", "G": "bogus"}}},
	}
	if got, want := importer.Years(tpl), []int{2024, 2025, 2027, 2028}; !slices.Equal(got, want) {
		t.Errorf("Years = %v, want %v", got, want)
	}
}

func TestOpenWorkbookFileErrors(t *testing.T) {
	if _, err := importer.OpenWorkbookFile("does-not-exist.xlsx"); err == nil {
		t.Error("missing file accepted")
	}
	if _, err := importer.OpenWorkbookFile("importer.go"); err == nil {
		t.Error("a non-workbook was opened")
	}
}
