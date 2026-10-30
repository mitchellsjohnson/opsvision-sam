package changeset_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

const (
	tenant    = "t1"
	scorecard = "sc1"
)

func m(idx int) period.Period { return period.Period{Grain: period.Month, FY: 2025, Index: idx} }

func f(v float64) *float64 { return &v }

func version(id string, status domain.VersionStatus) domain.MethodologyVersion {
	return domain.MethodologyVersion{
		ID: id, ScorecardID: scorecard, Name: id, Status: status,
		EffectiveFrom: period.Period{Grain: period.Year, FY: 2025},
		Content: domain.Methodology{
			Measures: []domain.Measure{{Key: "up", Name: "Up", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}},
			Metrics: []domain.Metric{
				{Key: "uptime", Name: "Uptime", Formula: "up", Format: domain.FormatPercent2,
					Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
					Rule:       domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "G", Min: 1}}},
					Definition: "old definition"},
			},
		},
	}
}

func seed(t *testing.T, vs ...domain.MethodologyVersion) *memstore.Store {
	t.Helper()
	st := memstore.New()
	ctx := context.Background()
	if err := st.PutScorecard(ctx, tenant, domain.Scorecard{ID: scorecard, Name: "SC"}); err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		if err := st.PutVersion(ctx, tenant, v, 0); err != nil {
			t.Fatal(err)
		}
	}
	return st
}

func bandsJSON(t *testing.T) string {
	t.Helper()
	b, err := json.Marshal(changeset.BandsValue{
		Bands:     []domain.Band{{Status: "G", Op: ">=", Value: 99.9}, {Status: "Y", Op: ">=", Value: 99.5}, {Status: "R"}},
		Direction: domain.DirectionHigherBetter,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestApplyWritesEverything(t *testing.T) {
	st := seed(t, version("draft1", domain.VersionDraft))
	ctx := context.Background()
	cs := changeset.ChangeSet{
		ID: "cs1", Source: changeset.SourceLegacyWorkbook, Status: changeset.StatusParsed,
		Data: []store.DataWrite{
			{Point: domain.DataPoint{MeasureKey: "up", SubjectID: "u1", Period: m(1), Value: f(5), Source: domain.SourceLegacy}, ExpectedRevision: store.Unconditional},
			{Point: domain.DataPoint{MeasureKey: "up", SubjectID: "u1", Period: m(2), NAReason: "n/a", Source: domain.SourceLegacy}, ExpectedRevision: store.Unconditional},
		},
		Overrides: []domain.Override{{MetricKey: "uptime", SubjectID: "u1", Period: m(1), Status: "R", Reason: "As reported in legacy workbook"}},
		VersionText: []changeset.VersionTextChange{
			{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldDefinition, Value: "new definition"},
			{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldFrequency, Value: "quarterly"},
			{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldBands, Value: bandsJSON(t)},
		},
		Notes: []changeset.LegacyNote{{MetricKey: "uptime", SubjectID: "u1", Period: m(1), Text: "a note"}},
	}
	res, err := changeset.Apply(ctx, st, tenant, scorecard, cs, "admin-1")
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if res.DataPoints != 2 || res.Overrides != 1 || res.VersionText != 3 || len(res.Findings) != 0 {
		t.Fatalf("result = %+v", res)
	}

	pts, ovs, err := st.ListData(ctx, tenant, scorecard, []int{2025})
	if err != nil || len(pts) != 2 || len(ovs) != 1 {
		t.Fatalf("ListData = %d points, %d overrides, err %v", len(pts), len(ovs), err)
	}
	for _, p := range pts {
		if p.EnteredBy != "admin-1" || p.EnteredAt.IsZero() || p.Source != domain.SourceLegacy {
			t.Errorf("point not stamped: %+v", p)
		}
	}
	if ovs[0].By != "admin-1" || ovs[0].At.IsZero() {
		t.Errorf("override not stamped: %+v", ovs[0])
	}

	v, err := st.GetVersion(ctx, tenant, scorecard, "draft1")
	if err != nil {
		t.Fatal(err)
	}
	mt := v.Content.Metrics[0]
	if mt.Definition != "new definition" || mt.Frequency != domain.FrequencyQuarterly {
		t.Errorf("metric text = %q / %q", mt.Definition, mt.Frequency)
	}
	if mt.Rule.Type != domain.RuleBands || len(mt.Rule.Bands) != 3 || mt.Rule.Bands[0].Value != 99.9 || len(mt.Rule.Scale) != 0 {
		t.Errorf("rule = %+v", mt.Rule)
	}
	if v.Revision != 2 {
		t.Errorf("version revision = %d, want 2 (one save for all text)", v.Revision)
	}

	audit, err := st.ListAudit(ctx, tenant, time.Unix(0, 0), time.Now().Add(time.Hour))
	if err != nil || len(audit) != 1 {
		t.Fatalf("audit = %d entries, err %v", len(audit), err)
	}
	a := audit[0]
	if a.Action != "import.apply" || a.ActorID != "admin-1" || a.TargetID != "cs1" || a.ID == "" {
		t.Errorf("audit = %+v", a)
	}
	var counts map[string]int
	if err := json.Unmarshal(a.After, &counts); err != nil {
		t.Fatal(err)
	}
	if counts["dataPoints"] != 2 || counts["overrides"] != 1 || counts["versionText"] != 3 || counts["notes"] != 1 {
		t.Errorf("audit counts = %v", counts)
	}
}

func TestApplyRejectsPublishedVersionText(t *testing.T) {
	st := seed(t, version("pub1", domain.VersionPublished), version("draft1", domain.VersionDraft))
	ctx := context.Background()
	cs := changeset.ChangeSet{
		ID: "cs1",
		Data: []store.DataWrite{
			{Point: domain.DataPoint{MeasureKey: "up", SubjectID: "u1", Period: m(1), Value: f(5)}, ExpectedRevision: store.Unconditional},
		},
		Overrides: []domain.Override{{MetricKey: "uptime", SubjectID: "u1", Period: m(1), Status: "R"}},
		VersionText: []changeset.VersionTextChange{
			{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldDefinition, Value: "x"},
			{VersionID: "pub1", MetricKey: "uptime", Field: changeset.FieldDefinition, Value: "y"},
		},
	}
	if _, err := changeset.Apply(ctx, st, tenant, scorecard, cs, "admin-1"); err == nil {
		t.Fatal("Apply succeeded against a published version")
	}
	pts, ovs, _ := st.ListData(ctx, tenant, scorecard, []int{2025})
	if len(pts) != 0 || len(ovs) != 0 {
		t.Errorf("rejected change set still wrote %d points, %d overrides", len(pts), len(ovs))
	}
	d, _ := st.GetVersion(ctx, tenant, scorecard, "draft1")
	if d.Content.Metrics[0].Definition != "old definition" {
		t.Errorf("draft changed despite rejection: %q", d.Content.Metrics[0].Definition)
	}
	audit, _ := st.ListAudit(ctx, tenant, time.Unix(0, 0), time.Now().Add(time.Hour))
	if len(audit) != 0 {
		t.Errorf("audit entries written for a rejected change set: %d", len(audit))
	}
}

func TestApplyMissingVersion(t *testing.T) {
	st := seed(t)
	cs := changeset.ChangeSet{VersionText: []changeset.VersionTextChange{{VersionID: "nope", MetricKey: "uptime", Field: "definition", Value: "x"}}}
	_, err := changeset.Apply(context.Background(), st, tenant, scorecard, cs, "a")
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestApplyMissingMetricIsFinding(t *testing.T) {
	st := seed(t, version("draft1", domain.VersionDraft))
	ctx := context.Background()
	cs := changeset.ChangeSet{VersionText: []changeset.VersionTextChange{
		{VersionID: "draft1", MetricKey: "ghost", Field: changeset.FieldDefinition, Value: "x"},
		{VersionID: "draft1", MetricKey: "uptime", Field: "colour", Value: "x"},
		{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldFrequency, Value: "sometimes"},
		{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldBands, Value: "{not json"},
		{VersionID: "draft1", MetricKey: "uptime", Field: changeset.FieldNotes, Value: "kept"},
	}}
	res, err := changeset.Apply(ctx, st, tenant, scorecard, cs, "a")
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if res.VersionText != 1 || len(res.Findings) != 4 {
		t.Fatalf("result = %+v", res)
	}
	for _, fd := range res.Findings {
		if fd.Severity != changeset.SeverityError {
			t.Errorf("finding %+v is not an error", fd)
		}
	}
	v, _ := st.GetVersion(ctx, tenant, scorecard, "draft1")
	if v.Content.Metrics[0].Notes != "kept" || v.Content.Metrics[0].Frequency != domain.FrequencyMonthly {
		t.Errorf("metric = %+v", v.Content.Metrics[0])
	}
}

func TestApplyEmptyChangeSetStillAudits(t *testing.T) {
	st := seed(t)
	res, err := changeset.Apply(context.Background(), st, tenant, scorecard, changeset.ChangeSet{ID: "cs0"}, "a")
	if err != nil || res.DataPoints != 0 {
		t.Fatalf("res %+v err %v", res, err)
	}
	audit, _ := st.ListAudit(context.Background(), tenant, time.Unix(0, 0), time.Now().Add(time.Hour))
	if len(audit) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(audit))
	}
}

func TestHasErrors(t *testing.T) {
	if changeset.HasErrors([]changeset.Finding{{Severity: changeset.SeverityWarn}}) {
		t.Error("warn counted as error")
	}
	if !changeset.HasErrors([]changeset.Finding{{Severity: changeset.SeverityInfo}, {Severity: changeset.SeverityError}}) {
		t.Error("error not counted")
	}
}
