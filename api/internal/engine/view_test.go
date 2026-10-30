package engine

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

func tptr(t time.Time) *time.Time { return &t }

func year(fy int) period.Period { return period.Period{Grain: period.Year, FY: fy} }

var prodOnly = []domain.Subject{{Kind: domain.SubjectLevel, ID: "prod"}}

// viewVersions returns two published versions: FY25 (effective 2025-M01) and
// FY26 (effective 2026-M01). FY26 has looser bands for on_time_pct and adds
// the rework metric; FY25 alone has the legacy_pct metric.
func viewVersions() (v25, v26 domain.MethodologyVersion) {
	v25 = domain.MethodologyVersion{
		ID: "v2025", Name: "FY25 methodology", Status: domain.VersionSuperseded,
		EffectiveFrom: month(2025, 1),
		Content: domain.Methodology{
			Categories: []domain.Category{
				{ID: "delivery", Name: "Delivery", Order: 2},
				{ID: "quality", Name: "Quality", Order: 1},
			},
			Measures: []domain.Measure{onTime, committed},
			Metrics: []domain.Metric{
				{Key: "on_time_pct", Name: "On time %", CategoryID: "delivery", Formula: "on_time / committed * 100",
					Format: domain.FormatPercent1, Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
					ReportedAt: prodOnly, Rule: bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0))},
				{Key: "legacy_pct", Name: "Legacy %", CategoryID: "quality", Formula: "on_time / committed * 100",
					Format: domain.FormatPercent0, Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
					ReportedAt: prodOnly, Rule: bandsRule(band("G", ">=", 90), band("R", "", 0))},
			},
		},
	}
	v26 = domain.MethodologyVersion{
		ID: "v2026", Name: "FY26 methodology", Status: domain.VersionPublished,
		EffectiveFrom: month(2026, 1),
		Content: domain.Methodology{
			Categories: []domain.Category{
				{ID: "delivery", Name: "Delivery", Order: 2},
				{ID: "quality", Name: "Quality", Order: 1},
			},
			Measures: []domain.Measure{onTime, committed},
			Metrics: []domain.Metric{
				{Key: "on_time_pct", Name: "On time percent", CategoryID: "delivery", Formula: "on_time / committed * 100",
					Format: domain.FormatPercent1, Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
					ReportedAt: prodOnly, Rule: bandsRule(band("G", ">=", 80), band("Y", ">=", 70), band("R", "", 0))},
				{Key: "rework", Name: "Rework", CategoryID: "quality", Formula: "on_time",
					Format: domain.FormatNumber0, Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly,
					ReportedAt: prodOnly, Rule: bandsRule(band("G", "<=", 5), band("R", "", 0))},
			},
		},
	}
	return v25, v26
}

func viewInput(t *testing.T, data ...domain.DataPoint) *Input {
	t.Helper()
	in := fixtureInput(t, data...)
	v25, v26 := viewVersions()
	in.Versions = []domain.MethodologyVersion{v26, v25}
	return in
}

func rowCell(t *testing.T, v View, metric, subject string, col int) Cell {
	t.Helper()
	for _, r := range v.Rows {
		if r.MetricKey == metric && r.SubjectID == subject {
			if col >= len(r.Cells) {
				t.Fatalf("row %s/%s has %d cells, want index %d", metric, subject, len(r.Cells), col)
			}
			return r.Cells[col]
		}
	}
	t.Fatalf("no row for %s/%s", metric, subject)
	return Cell{}
}

func TestVersionSelection(t *testing.T) {
	v25, v26 := viewVersions()
	vs := []domain.MethodologyVersion{v26, v25}
	cases := []struct {
		p    period.Period
		want string
	}{
		{month(2025, 12), "v2025"},
		{quarter(2026, 1), "v2026"},
		{year(2026), "v2026"},
		{month(2025, 1), "v2025"},
	}
	for _, c := range cases {
		got, ok := VersionFor(vs, c.p, cal)
		if !ok || got.ID != c.want {
			t.Errorf("VersionFor(%s) = %q, %v; want %q", c.p, got.ID, ok, c.want)
		}
	}
	if _, ok := VersionFor(vs, month(2024, 12), cal); ok {
		t.Errorf("VersionFor(2024-M12) found a version before any took effect")
	}
	if got, ok := VersionFor(vs, year(2025), cal); !ok || got.ID != "v2025" {
		t.Errorf("VersionFor(2025-FY) = %q, %v; want v2025 (FY26 not yet in force at 2025-M12)", got.ID, ok)
	}
}

func TestVersionSelectionIgnoresDraftsAndBreaksTies(t *testing.T) {
	v25, v26 := viewVersions()
	draft := v26
	draft.ID, draft.Status, draft.EffectiveFrom = "draft", domain.VersionDraft, month(2026, 2)
	review := v26
	review.ID, review.Status, review.EffectiveFrom = "review", domain.VersionInReview, month(2026, 2)
	got, ok := VersionFor([]domain.MethodologyVersion{draft, review, v25, v26}, month(2026, 5), cal)
	if !ok || got.ID != "v2026" {
		t.Errorf("drafts/in-review must not be selected, got %q, %v", got.ID, ok)
	}

	a, b := v26, v26
	a.ID, a.PublishedAt = "a", tptr(time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC))
	b.ID, b.PublishedAt = "b", tptr(time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC))
	for _, order := range [][]domain.MethodologyVersion{{a, b}, {b, a}} {
		got, _ := VersionFor(order, month(2026, 3), cal)
		if got.ID != "b" {
			t.Errorf("tie on EffectiveFrom: got %q, want later PublishedAt b", got.ID)
		}
	}
}

func TestComputeUsesVersionPerColumn(t *testing.T) {
	in := viewInput(t,
		pt("on_time", "gateway", month(2025, 12), 85), pt("committed", "gateway", month(2025, 12), 100),
		pt("on_time", "gateway", month(2026, 1), 85), pt("committed", "gateway", month(2026, 1), 100),
	)
	v, err := Compute(in, ViewRequest{
		Periods: []period.Period{month(2025, 12), month(2026, 1)},
		YTD:     []period.Period{month(2026, 1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	wantVer := map[string]string{"2025-M12": "v2025", "2026-M01": "v2026", "YTD:2026-M01": "v2026"}
	if !reflect.DeepEqual(v.VersionByPeriod, wantVer) {
		t.Errorf("VersionByPeriod = %v, want %v", v.VersionByPeriod, wantVer)
	}
	if !reflect.DeepEqual(v.YTD, []period.Period{month(2026, 1)}) || len(v.Periods) != 2 {
		t.Errorf("View periods = %v, YTD = %v", v.Periods, v.YTD)
	}
	for _, r := range v.Rows {
		if len(r.Cells) != 3 {
			t.Fatalf("row %s/%s has %d cells, want 3 (2 periods + 1 YTD)", r.MetricKey, r.SubjectID, len(r.Cells))
		}
	}
	dec, jan, ytd := rowCell(t, v, "on_time_pct", "gateway", 0), rowCell(t, v, "on_time_pct", "gateway", 1), rowCell(t, v, "on_time_pct", "gateway", 2)
	if dec.Status != "Y" || dec.VersionID != "v2025" || dec.YTD {
		t.Errorf("Dec 2025 cell = %+v; want Y under v2025", dec)
	}
	if jan.Status != "G" || jan.VersionID != "v2026" {
		t.Errorf("Jan 2026 cell = %+v; want G under v2026", jan)
	}
	if !ytd.YTD || ytd.Period != month(2026, 1) || ytd.Status != "G" {
		t.Errorf("YTD cell = %+v", ytd)
	}

	// Row metadata comes from the latest column's version (FY26 name).
	for _, r := range v.Rows {
		if r.MetricKey == "on_time_pct" && r.MetricName != "On time percent" {
			t.Errorf("MetricName = %q, want name from latest version", r.MetricName)
		}
		// legacy_pct only exists under FY25: metadata from that version.
		if r.MetricKey == "legacy_pct" && (r.MetricName != "Legacy %" || r.Format != domain.FormatPercent0) {
			t.Errorf("legacy row metadata = %q/%q", r.MetricName, r.Format)
		}
	}
}

func TestComputeNotMeasuredAndNoMethodology(t *testing.T) {
	in := viewInput(t)
	v, err := Compute(in, ViewRequest{Periods: []period.Period{month(2024, 6), month(2025, 6), month(2026, 6)}})
	if err != nil {
		t.Fatal(err)
	}
	none := rowCell(t, v, "on_time_pct", "gateway", 0)
	if none.Value != nil || none.Status != "" || none.NAReason != "No methodology in force" {
		t.Errorf("no-version cell = %+v", none)
	}
	if _, ok := v.VersionByPeriod["2024-M06"]; ok {
		t.Errorf("VersionByPeriod should omit columns with no version: %v", v.VersionByPeriod)
	}
	rework25 := rowCell(t, v, "rework", "gateway", 1)
	if rework25.Value != nil || rework25.Status != "" || rework25.NAReason != "Not measured under FY25 methodology" {
		t.Errorf("rework under FY25 = %+v", rework25)
	}
	if rework25.MetricKey != "rework" || rework25.SubjectID != "gateway" || rework25.Period != month(2025, 6) {
		t.Errorf("identity fields missing on placeholder cell: %+v", rework25)
	}
	legacy26 := rowCell(t, v, "legacy_pct", "gateway", 2)
	if legacy26.NAReason != "Not measured under FY26 methodology" {
		t.Errorf("legacy under FY26 NAReason = %q", legacy26.NAReason)
	}
}

func TestYTDAcrossMove(t *testing.T) {
	var data []domain.DataPoint
	for m := 1; m <= 9; m++ {
		data = append(data,
			pt("on_time", "analytics", month(2026, m), 10),
			pt("on_time", "warehouse", month(2026, m), 1),
			pt("on_time", "gateway", month(2026, m), 100),
		)
	}
	in := viewInput(t, data...)
	// A metric that is a plain sum, reported at products and their ancestors.
	for i := range in.Versions {
		in.Versions[i].Content.Metrics = []domain.Metric{{
			Key: "total", Name: "Total", CategoryID: "delivery", Formula: "on_time", Format: domain.FormatNumber0,
			Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: prodOnly,
			Rule: bandsRule(band("G", ">=", 0)),
		}}
	}
	req := ViewRequest{YTD: []period.Period{month(2026, 9)}}

	asOf, err := Compute(in, req)
	if err != nil {
		t.Fatal(err)
	}
	// Data: Analytics Jan-Jun (6*10) + Warehouse Jan-Sep (9*1).
	if got := rowCell(t, asOf, "total", "data", 0); got.Value == nil || *got.Value != 69 {
		t.Errorf("as_of Data YTD = %+v, want 69", got.Value)
	}
	// Platform: Gateway Jan-Sep (900) + Analytics Jul-Sep (30).
	if got := rowCell(t, asOf, "total", "platform", 0); got.Value == nil || *got.Value != 930 {
		t.Errorf("as_of Platform YTD = %+v, want 930", got.Value)
	}

	req.Structure = "current"
	cur, err := Compute(in, req)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowCell(t, cur, "total", "platform", 0); got.Value == nil || *got.Value != 990 {
		t.Errorf("current Platform YTD = %+v, want 990 (Analytics Jan-Sep)", got.Value)
	}
	if got := rowCell(t, cur, "total", "data", 0); got.Value == nil || *got.Value != 9 {
		t.Errorf("current Data YTD = %+v, want 9", got.Value)
	}

	// The default structure is unaffected by having computed "current".
	again, err := Compute(in, ViewRequest{YTD: []period.Period{month(2026, 9)}, Structure: "as_of"})
	if err != nil {
		t.Fatal(err)
	}
	if got := rowCell(t, again, "total", "data", 0); got.Value == nil || *got.Value != 69 {
		t.Errorf("as_of Data YTD after current = %+v, want 69", got.Value)
	}
}

func TestStructureCurrentOrdersByCurrentTree(t *testing.T) {
	in := viewInput(t)
	req := ViewRequest{Periods: []period.Period{month(2026, 9)}, SubjectIDs: []string{"data", "analytics", "warehouse", "platform"}}
	cur := req
	cur.Structure = "current"
	// Both at latest month 2026-M09: the trees agree, so order is identical.
	a, err := Compute(in, req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Compute(in, cur)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(subjectsOf(a, "on_time_pct"), subjectsOf(b, "on_time_pct")) {
		t.Errorf("subject order differs: %v vs %v", subjectsOf(a, "on_time_pct"), subjectsOf(b, "on_time_pct"))
	}

	// A period before the move: as_of has analytics under data, current has it under platform.
	early := ViewRequest{Periods: []period.Period{month(2026, 3), month(2026, 9)}}
	e1, _ := Compute(in, early)
	early.Structure = "current"
	e2, _ := Compute(in, early)
	// Latest column is 2026-M09 so the listing tree is the post-move tree in both.
	if !reflect.DeepEqual(subjectsOf(e1, "on_time_pct"), subjectsOf(e2, "on_time_pct")) {
		t.Errorf("listing should use latest month tree in both modes")
	}
}

func subjectsOf(v View, metric string) []string {
	var out []string
	for _, r := range v.Rows {
		if r.MetricKey == metric {
			out = append(out, r.SubjectID)
		}
	}
	return out
}

func TestRestatementDoesNotMutate(t *testing.T) {
	in := viewInput(t,
		pt("on_time", "gateway", month(2025, 3), 85), pt("committed", "gateway", month(2025, 3), 100),
	)
	req := ViewRequest{Periods: []period.Period{month(2025, 3)}}

	base, err := Compute(in, req)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowCell(t, base, "on_time_pct", "gateway", 0); got.Status != "Y" || got.VersionID != "v2025" {
		t.Fatalf("baseline = %+v, want Y under v2025", got)
	}

	rs := req
	rs.Restate = "v2026"
	restated, err := Compute(in, rs)
	if err != nil {
		t.Fatal(err)
	}
	got := rowCell(t, restated, "on_time_pct", "gateway", 0)
	if got.Status != "G" || got.VersionID != "v2026" {
		t.Errorf("restated = %+v, want G under v2026", got)
	}
	if restated.VersionByPeriod["2025-M03"] != "v2026" {
		t.Errorf("VersionByPeriod = %v", restated.VersionByPeriod)
	}
	// Under restatement only v2026's metrics exist.
	if keys := metricKeys(restated); !reflect.DeepEqual(keys, []string{"rework", "on_time_pct"}) {
		t.Errorf("restated metrics = %v", keys)
	}

	after, err := Compute(in, req)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowCell(t, after, "on_time_pct", "gateway", 0); got.Status != "Y" || got.VersionID != "v2025" {
		t.Errorf("after restatement = %+v, want original Y under v2025", got)
	}
	if !reflect.DeepEqual(base, after) {
		t.Errorf("Compute without Restate changed after a restated Compute")
	}
}

func metricKeys(v View) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range v.Rows {
		if !seen[r.MetricKey] {
			seen[r.MetricKey] = true
			out = append(out, r.MetricKey)
		}
	}
	return out
}

func TestRestateDraftVersionPreview(t *testing.T) {
	in := viewInput(t, pt("on_time", "gateway", month(2026, 2), 72), pt("committed", "gateway", month(2026, 2), 100))
	_, v26 := viewVersions()
	draft := v26
	draft.ID, draft.Name, draft.Status, draft.EffectiveFrom = "v2027-draft", "FY27 draft", domain.VersionDraft, month(2027, 1)
	draft.Content.Metrics = append([]domain.Metric(nil), draft.Content.Metrics...)
	draft.Content.Metrics[0].Rule = bandsRule(band("G", ">=", 70), band("R", "", 0))
	in.Versions = append(in.Versions, draft)

	v, err := Compute(in, ViewRequest{Periods: []period.Period{month(2026, 2)}, Restate: "v2027-draft"})
	if err != nil {
		t.Fatal(err)
	}
	if got := rowCell(t, v, "on_time_pct", "gateway", 0); got.Status != "G" || got.VersionID != "v2027-draft" {
		t.Errorf("draft preview = %+v", got)
	}
	// Without Restate the draft is never used.
	v, err = Compute(in, ViewRequest{Periods: []period.Period{month(2026, 2)}})
	if err != nil {
		t.Fatal(err)
	}
	if got := rowCell(t, v, "on_time_pct", "gateway", 0); got.Status != "Y" || got.VersionID != "v2026" {
		t.Errorf("without restate = %+v", got)
	}
}

func TestComputeErrors(t *testing.T) {
	in := viewInput(t)
	if _, err := Compute(in, ViewRequest{Periods: []period.Period{month(2026, 1)}, Restate: "nope"}); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Errorf("unknown Restate: err = %v", err)
	}
	if _, err := Compute(in, ViewRequest{Periods: []period.Period{month(2026, 1)}, Structure: "sideways"}); err == nil || !strings.Contains(err.Error(), "sideways") {
		t.Errorf("invalid Structure: err = %v", err)
	}
	for _, s := range []string{"", "as_of", "current"} {
		if _, err := Compute(in, ViewRequest{Periods: []period.Period{month(2026, 1)}, Structure: s}); err != nil {
			t.Errorf("Structure %q: err = %v", s, err)
		}
	}
}

func TestRowsOrdering(t *testing.T) {
	in := viewInput(t)
	v, err := Compute(in, ViewRequest{Periods: []period.Period{month(2026, 9)}})
	if err != nil {
		t.Fatal(err)
	}

	// Categories: quality (1) before delivery (2).
	var cats []string
	for _, c := range v.Categories {
		cats = append(cats, c.ID)
	}
	if !reflect.DeepEqual(cats, []string{"quality", "delivery"}) {
		t.Errorf("Categories = %v", cats)
	}

	// Rows: category order, then metric order, then subject (tree pre-order).
	type key struct{ m, s string }
	var got []key
	for _, r := range v.Rows {
		got = append(got, key{r.MetricKey, r.SubjectID})
	}
	tree := []string{"company", "data", "warehouse", "platform", "analytics", "gateway", "storage"}
	var want []key
	for _, m := range []string{"rework", "on_time_pct"} {
		for _, s := range tree {
			want = append(want, key{m, s})
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("row order:\n got %v\nwant %v", got, want)
	}

	depths := map[string]int{"company": 0, "data": 1, "platform": 1, "warehouse": 2, "analytics": 2, "gateway": 2, "storage": 2}
	for _, r := range v.Rows {
		if r.MetricKey != "on_time_pct" {
			continue
		}
		if r.Depth != depths[r.SubjectID] {
			t.Errorf("Depth(%s) = %d, want %d", r.SubjectID, r.Depth, depths[r.SubjectID])
		}
		if r.CategoryID != "delivery" || r.Direction != domain.DirectionHigherBetter {
			t.Errorf("row metadata = %+v", r)
		}
	}
	for _, r := range v.Rows {
		if r.SubjectName == "" {
			t.Errorf("row %s/%s has no SubjectName", r.MetricKey, r.SubjectID)
		}
	}
	if name := cellRowName(v, "on_time_pct", "analytics"); name != "Analytics" {
		t.Errorf("SubjectName = %q", name)
	}
}

func cellRowName(v View, metric, subject string) string {
	for _, r := range v.Rows {
		if r.MetricKey == metric && r.SubjectID == subject {
			return r.SubjectName
		}
	}
	return ""
}

func TestSubjectsReportedAtLevelsAndKinds(t *testing.T) {
	in := viewInput(t)
	in.Items = append(in.Items,
		domain.TrackedItem{ID: "app-z", KindID: "app", Name: "Zeta", OrgUnitID: "gateway"},
		domain.TrackedItem{ID: "app-a", KindID: "app", Name: "Alpha", OrgUnitID: "gateway"},
		domain.TrackedItem{ID: "app-free", KindID: "app", Name: "Alpha Free"},
	)
	for i := range in.Versions {
		in.Versions[i].Content.Metrics = []domain.Metric{
			{Key: "seg_only", Name: "Seg only", CategoryID: "delivery", Formula: "on_time", Format: domain.FormatNumber0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "seg"}}},
			{Key: "apps", Name: "Apps", CategoryID: "delivery", Formula: "on_time", Format: domain.FormatNumber0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectItemKind, ID: "app"}}},
		}
	}
	v, err := Compute(in, ViewRequest{Periods: []period.Period{month(2026, 9)}})
	if err != nil {
		t.Fatal(err)
	}
	// seg level + ancestors (company); no products, no items.
	if got := subjectsOf(v, "seg_only"); !reflect.DeepEqual(got, []string{"company", "data", "platform"}) {
		t.Errorf("seg_only subjects = %v", got)
	}
	// Items sorted by kind then name; depth = unit depth + 1, 0 if unattached.
	if got := subjectsOf(v, "apps"); !reflect.DeepEqual(got, []string{"app-a", "app-free", "app-z"}) {
		t.Errorf("apps subjects = %v", got)
	}
	for _, r := range v.Rows {
		if r.MetricKey != "apps" {
			continue
		}
		want := 3
		if r.SubjectID == "app-free" {
			want = 0
		}
		if r.Depth != want {
			t.Errorf("Depth(%s) = %d, want %d", r.SubjectID, r.Depth, want)
		}
	}

	// SubjectIDs filter keeps order.
	v, err = Compute(in, ViewRequest{Periods: []period.Period{month(2026, 9)}, SubjectIDs: []string{"platform", "app-z", "company"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := subjectsOf(v, "seg_only"); !reflect.DeepEqual(got, []string{"company", "platform"}) {
		t.Errorf("filtered seg_only = %v", got)
	}
	if got := subjectsOf(v, "apps"); !reflect.DeepEqual(got, []string{"app-z"}) {
		t.Errorf("filtered apps = %v", got)
	}
}

func TestComputeEmpty(t *testing.T) {
	v, err := Compute(viewInput(t), ViewRequest{})
	if err != nil || len(v.Rows) != 0 {
		t.Errorf("empty request: rows=%d err=%v", len(v.Rows), err)
	}
	v, err = Compute(&Input{Cal: cal}, ViewRequest{Periods: []period.Period{month(2026, 1)}})
	if err != nil || len(v.Rows) != 0 {
		t.Errorf("empty input: rows=%d err=%v", len(v.Rows), err)
	}
}

func TestCompiledFormulaCacheIsConcurrencySafe(t *testing.T) {
	in := viewInput(t,
		pt("on_time", "gateway", month(2026, 1), 85), pt("committed", "gateway", month(2026, 1), 100))
	ix := NewIndex(in)
	_, v26 := viewVersions()
	m := v26.Content.Metrics[0]
	done := make(chan Cell, 8)
	for i := 0; i < 8; i++ {
		go func() { done <- ix.Cell(v26, m, "gateway", month(2026, 1)) }()
	}
	for i := 0; i < 8; i++ {
		if c := <-done; c.Value == nil || *c.Value != 85 {
			t.Errorf("concurrent cell = %+v", c.Value)
		}
	}
}
