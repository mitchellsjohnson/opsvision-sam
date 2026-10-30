package engine

import (
	"fmt"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// benchInput builds a tenant of 60 org units (1 company, 4 segments, 55
// products), 50 monthly metrics reported at every level, and two fiscal
// years of data, so a year view is 50 x 60 x (12 months + 1 YTD) cells.
func benchInput(tb testing.TB) *Input {
	tb.Helper()
	units := []domain.OrgUnit{{ID: "co", Name: "Company", LevelID: "co"}}
	var leaves []string
	for s := 0; s < 4; s++ {
		sid := fmt.Sprintf("seg%d", s)
		units = append(units, domain.OrgUnit{ID: sid, Name: sid, LevelID: "seg", ParentID: "co"})
		n := 14
		if s == 3 {
			n = 13
		}
		for p := 0; p < n; p++ {
			pid := fmt.Sprintf("p%d_%02d", s, p)
			units = append(units, domain.OrgUnit{ID: pid, Name: pid, LevelID: "prod", ParentID: sid})
			leaves = append(leaves, pid)
		}
	}
	if len(units) != 60 {
		tb.Fatalf("units = %d, want 60", len(units))
	}
	tree, err := orgtree.New(units, nil)
	if err != nil {
		tb.Fatal(err)
	}

	const nMeasures = 20
	var measures []domain.Measure
	for i := 0; i < nMeasures; i++ {
		measures = append(measures, domain.Measure{
			Key: fmt.Sprintf("m%02d", i), Name: fmt.Sprintf("M%02d", i),
			OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
		})
	}
	var metrics []domain.Metric
	for i := 0; i < 50; i++ {
		rule := bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0))
		if i%5 == 0 {
			rule = changeRule(domain.ComparePriorPeriod, band("G", ">=", 0), band("R", "", 0))
		}
		metrics = append(metrics, domain.Metric{
			Key: fmt.Sprintf("metric%02d", i), Name: fmt.Sprintf("Metric %02d", i),
			CategoryID: fmt.Sprintf("cat%d", i%5),
			Formula:    fmt.Sprintf("m%02d / m%02d * 100", i%nMeasures, (i+1)%nMeasures),
			Format:     domain.FormatPercent1, Direction: domain.DirectionHigherBetter,
			Frequency: domain.FrequencyMonthly, Rule: rule,
			ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "co"}, {Kind: domain.SubjectLevel, ID: "seg"}, {Kind: domain.SubjectLevel, ID: "prod"}},
		})
	}
	var cats []domain.Category
	for i := 0; i < 5; i++ {
		cats = append(cats, domain.Category{ID: fmt.Sprintf("cat%d", i), Name: fmt.Sprintf("Category %d", i), Order: i})
	}
	version := domain.MethodologyVersion{
		ID: "v1", Name: "Bench", Status: domain.VersionPublished, EffectiveFrom: month(2025, 1),
		Content: domain.Methodology{Categories: cats, Measures: measures, Metrics: metrics},
	}

	var data []domain.DataPoint
	for _, fy := range []int{2025, 2026} {
		for mo := 1; mo <= 12; mo++ {
			for li, leaf := range leaves {
				for mi := 0; mi < nMeasures; mi++ {
					data = append(data, pt(measures[mi].Key, leaf, month(fy, mo), float64(80+(li*7+mi*3+mo)%40)))
				}
			}
		}
	}
	return &Input{Cal: cal, Tree: tree, Versions: []domain.MethodologyVersion{version}, Data: data}
}

func BenchmarkComputeYear(b *testing.B) {
	in := benchInput(b)
	req := ViewRequest{YTD: []period.Period{month(2026, 12)}}
	for m := 1; m <= 12; m++ {
		req.Periods = append(req.Periods, month(2026, m))
	}
	v, err := Compute(in, req)
	if err != nil {
		b.Fatal(err)
	}
	if len(v.Rows) != 50*60 || len(v.Rows[0].Cells) != 13 {
		b.Fatalf("rows = %d, cells = %d; want 3000 x 13", len(v.Rows), len(v.Rows[0].Cells))
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Compute(in, req); err != nil {
			b.Fatal(err)
		}
	}
}
