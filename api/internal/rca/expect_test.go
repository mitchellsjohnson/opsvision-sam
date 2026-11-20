package rca_test

import (
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/rca"
)

func i64(n int64) *int64 { return &n }

func exp(e rca.Expectation) *rca.Expectation { return &e }

func TestExpect(t *testing.T) {
	cases := []struct {
		name string
		in   rca.ExpectInput
		want rca.Expectation
	}{
		{"YTD column", rca.ExpectInput{YTD: true, HasValueOrStatus: true, Status: "R", BestStatus: "G", AtReportingSubject: true}, rca.None},
		{"not due", rca.ExpectInput{NotDue: true, Status: "R", BestStatus: "G", AtReportingSubject: true}, rca.None},
		{"not applicable", rca.ExpectInput{NA: true, HasValueOrStatus: true, Status: "R", BestStatus: "G", AtReportingSubject: true}, rca.None},
		{"not rated", rca.ExpectInput{NotRated: true, HasValueOrStatus: true, BestStatus: "G", AtReportingSubject: true}, rca.None},
		{"uptime company cell, worst child Red", rca.ExpectInput{HasReadableChildren: true, BestStatus: "G", WorstChild: exp(rca.Needed)}, rca.Available},
		{"company cell, worst child only below its ideal", rca.ExpectInput{HasReadableChildren: true, WorstChild: exp(rca.Available)}, rca.Available},
		{"company cell, children all perfect", rca.ExpectInput{HasReadableChildren: true, WorstChild: exp(rca.None)}, rca.None},
		{"company cell, no child judged", rca.ExpectInput{HasReadableChildren: true}, rca.None},
		{"no value, no children", rca.ExpectInput{BestStatus: "G", AtReportingSubject: true}, rca.None},
		{"Red product of epics_on_time", rca.ExpectInput{HasValueOrStatus: true, Status: "R", BestStatus: "G", AtReportingSubject: true, HasReadableChildren: true}, rca.Needed},
		{"Red segment of epics_on_time", rca.ExpectInput{HasValueOrStatus: true, Status: "R", BestStatus: "G", HasReadableChildren: true}, rca.Available},
		{"Yellow company cell of postmortems_on_time", rca.ExpectInput{HasValueOrStatus: true, Status: "Y", BestStatus: "G", AtReportingSubject: true}, rca.Needed},
		{"Green item at 99.97%", rca.ExpectInput{HasValueOrStatus: true, Status: "G", BestStatus: "G", AtReportingSubject: true,
			DisplayedUnits: i64(9997), IdealUnits: i64(10000), Higher: true}, rca.Available},
		{"Green at 100.00%", rca.ExpectInput{HasValueOrStatus: true, Status: "G", BestStatus: "G", AtReportingSubject: true,
			DisplayedUnits: i64(10000), IdealUnits: i64(10000), Higher: true}, rca.None},
		{"Green without an ideal", rca.ExpectInput{HasValueOrStatus: true, Status: "G", BestStatus: "G", AtReportingSubject: true}, rca.None},
		{"Green and over plan", rca.ExpectInput{HasValueOrStatus: true, Status: "G", BestStatus: "G", AtReportingSubject: true,
			DisplayedUnits: i64(103), IdealUnits: i64(100)}, rca.Available},
		{"Green and under plan", rca.ExpectInput{HasValueOrStatus: true, Status: "G", BestStatus: "G", AtReportingSubject: true,
			DisplayedUnits: i64(96), IdealUnits: i64(100)}, rca.None},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rca.Expect(tc.in); got != tc.want {
				t.Fatalf("Expect = %q, want %q", got, tc.want)
			}
		})
	}
	if rca.Needed != "needed" || rca.Available != "available" || rca.None != "none" {
		t.Fatal("expectation values must match the API's enum")
	}
}

func TestBestStatus(t *testing.T) {
	custom := []domain.StatusLevel{
		{Key: "B", Label: "Blue", Rank: 1}, {Key: "G", Label: "Green", Rank: 2},
		{Key: "Y", Label: "Yellow", Rank: 3}, {Key: "R", Label: "Red", Rank: 4},
	}
	rule := bands(domain.Band{Status: "R", Op: "<", Value: 80}, domain.Band{Status: "Y", Op: "<", Value: 90}, domain.Band{Status: "G"})
	if got := rca.BestStatus(rule, custom); got != "G" {
		t.Fatalf("bands G, Y, R on a B-G-Y-R scale: best %q, want G (no rule uses B)", got)
	}
	scale := domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "Y", Min: 0}, {Status: "G", Min: 3}}}
	if got := rca.BestStatus(scale, custom); got != "G" {
		t.Fatalf("scale steps G, Y: best %q", got)
	}
	if got := rca.BestStatus(defectMetric.Rule, domain.DefaultStatusScale()); got != "G" {
		t.Fatalf("change rule: best %q", got)
	}
	withBlue := bands(domain.Band{Status: "B", Op: ">=", Value: 99.99}, domain.Band{Status: "G", Op: ">=", Value: 99.9}, domain.Band{Status: "R"})
	if got := rca.BestStatus(withBlue, custom); got != "B" {
		t.Fatalf("a rule that uses B: best %q", got)
	}
	if got := rca.BestStatus(bands(domain.Band{Status: "X"}), custom); got != "" {
		t.Fatalf("statuses outside the scale: best %q", got)
	}
}

func TestIsReportingSubject(t *testing.T) {
	levels := []domain.Level{{ID: "company", Depth: 0}, {ID: "segment", Depth: 1}, {ID: "product", Depth: 2}}
	two := domain.Metric{ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "segment"}, {Kind: domain.SubjectLevel, ID: "product"}}}
	if !rca.IsReportingSubject(two, levels, 2, false) {
		t.Error("product should be the reporting subject")
	}
	if rca.IsReportingSubject(two, levels, 1, false) {
		t.Error("segment is a roll-up when the metric also reports at product")
	}
	if rca.IsReportingSubject(two, levels, 0, false) {
		t.Error("the company is not a reporting level")
	}
	items := domain.Metric{ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}, {Kind: domain.SubjectItemKind, ID: "service"}}}
	if !rca.IsReportingSubject(items, levels, 3, true) {
		t.Error("an item is deeper than any unit")
	}
	if rca.IsReportingSubject(items, levels, 2, false) {
		t.Error("product is a roll-up of items")
	}
	company := domain.Metric{ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "company"}}}
	if !rca.IsReportingSubject(company, levels, 0, false) {
		t.Error("a company-level metric reports at the company")
	}
	if rca.IsReportingSubject(company, levels, 0, true) {
		t.Error("an item is not a reporting subject of a unit-only metric")
	}
}
