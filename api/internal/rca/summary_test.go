package rca_test

import (
	"fmt"
	"slices"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/rca"
)

var (
	scale    = domain.DefaultStatusScale()
	services = rca.NounForms{One: "service", Many: "services"}
	// trainingMetric is a percent that is not a ratio of records, judged by
	// bands: Green at 90% or more.
	trainingMetric = domain.Metric{Key: "security_training", Formula: "trained / headcount * 100", Format: domain.FormatPercent0,
		Direction: domain.DirectionHigherBetter,
		Rule:      bands(domain.Band{Status: "G", Op: ">=", Value: 90}, domain.Band{Status: "Y", Op: ">=", Value: 70}, domain.Band{Status: "R"})}
	quarterlyMetric = domain.Metric{Key: "design_review", Formula: "reviewed / shipped * 100", Format: domain.FormatPercent0,
		Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyQuarterly,
		Rule: bands(domain.Band{Status: "G", Op: ">=", Value: 90}, domain.Band{Status: "R"})}
)

func company(display, status string) *rca.CellFacts {
	return &rca.CellFacts{Display: display, Status: status}
}

// uptimeServices is 24 reporting services: 18 at 100%, then six below it,
// Webhooks the worst.
func uptimeServices() []rca.SubjectFacts {
	var out []rca.SubjectFacts
	for i := range 18 {
		out = append(out, rca.SubjectFacts{ID: fmt.Sprintf("svc-%02d", i), Name: fmt.Sprintf("Service %02d", i),
			Cell: rca.CellFacts{Display: "100.00%", Status: "G"}, Rule: uptimeMetric.Rule})
	}
	for _, s := range []struct{ id, name, display, status string }{
		{"search", "Search", "99.87%", "Y"},
		{"analytics-ingest", "Analytics Ingest", "99.83%", "Y"},
		{"webhooks", "Webhooks", "99.06%", "R"},
		{"ledger", "Ledger", "99.97%", "G"},
		{"checkout-api", "Checkout API", "99.95%", "G"},
		{"push-gateway", "Push Gateway", "99.93%", "G"},
	} {
		out = append(out, rca.SubjectFacts{ID: s.id, Name: s.name, Cell: rca.CellFacts{Display: s.display, Status: s.status}, Rule: uptimeMetric.Rule})
	}
	return out
}

func allAt100(n int) []rca.SubjectFacts {
	var out []rca.SubjectFacts
	for i := range n {
		out = append(out, rca.SubjectFacts{ID: fmt.Sprintf("svc-%02d", i), Name: fmt.Sprintf("Service %02d", i),
			Cell: rca.CellFacts{Display: "100.00%", Status: "G"}, Rule: uptimeMetric.Rule})
	}
	return out
}

// TestSummaryRequired has one case per row of the design's requirement
// table (§4.1).
func TestSummaryRequired(t *testing.T) {
	oneBelow := allAt100(23)
	oneBelow = append(oneBelow, rca.SubjectFacts{ID: "ledger", Name: "Ledger", Cell: rca.CellFacts{Display: "99.97%", Status: "G"}, Rule: uptimeMetric.Rule})
	notReported := allAt100(0)
	for i := range 24 {
		notReported = append(notReported, rca.SubjectFacts{ID: fmt.Sprintf("svc-%02d", i), Name: "S", Rule: uptimeMetric.Rule})
	}
	cases := []struct {
		name string
		in   rca.SummaryInput
		want rca.Requirement
	}{
		{"company Red", rca.SummaryInput{Metric: epicsMetric, Company: company("57%", "R"), CompanyRule: epicsMetric.Rule},
			rca.Requirement{Required: true, Reason: "Red"}},
		{"company Yellow", rca.SummaryInput{Metric: epicsMetric, Company: company("85%", "Y"), CompanyRule: epicsMetric.Rule},
			rca.Requirement{Required: true, Reason: "Yellow"}},
		{"company Green below 100%", rca.SummaryInput{Metric: uptimeMetric, Company: company("99.97%", "G"), CompanyRule: uptimeMetric.Rule},
			rca.Requirement{Required: true, Reason: "Below 100% (99.97%)"}},
		{"Green percent below 100%", rca.SummaryInput{Metric: trainingMetric, Company: company("94%", "G"), CompanyRule: trainingMetric.Rule},
			rca.Requirement{Required: true, Reason: "Below 100% (94%)"}},
		{"company Green at 100%", rca.SummaryInput{Metric: uptimeMetric, Company: company("100.00%", "G"), CompanyRule: uptimeMetric.Rule},
			rca.Requirement{}},
		{"no company value, one service below 100% while Green",
			rca.SummaryInput{Metric: uptimeMetric, Company: &rca.CellFacts{}, CompanyRule: uptimeMetric.Rule, Reporting: oneBelow, Noun: services},
			rca.Requirement{Required: true, Reason: "1 of 24 services below 100%"}},
		{"no company cell at all, six below",
			rca.SummaryInput{Metric: uptimeMetric, CompanyRule: uptimeMetric.Rule, Reporting: uptimeServices(), Noun: services},
			rca.Requirement{Required: true, Reason: "6 of 24 services below 100%"}},
		{"no company value, every service at 100%",
			rca.SummaryInput{Metric: uptimeMetric, Company: &rca.CellFacts{}, CompanyRule: uptimeMetric.Rule, Reporting: allAt100(24), Noun: services},
			rca.Requirement{}},
		{"not reported", rca.SummaryInput{Metric: uptimeMetric, Company: &rca.CellFacts{}, CompanyRule: uptimeMetric.Rule, Reporting: notReported, Noun: services},
			rca.Requirement{}},
		{"not reported, no subjects", rca.SummaryInput{Metric: epicsMetric, Company: &rca.CellFacts{}, CompanyRule: epicsMetric.Rule},
			rca.Requirement{}},
		{"value but not rated", rca.SummaryInput{Metric: epicsMetric, Company: &rca.CellFacts{Display: "57%", Value: fp(57)}, CompanyRule: epicsMetric.Rule},
			rca.Requirement{}},
		{"change rule Green", rca.SummaryInput{Metric: defectMetric, Company: company("12.4", "G"), CompanyRule: defectMetric.Rule},
			rca.Requirement{}},
		{"change rule Red", rca.SummaryInput{Metric: defectMetric, Company: company("15.6", "R"), CompanyRule: defectMetric.Rule},
			rca.Requirement{Required: true, Reason: "Red"}},
		{"band metric Green", rca.SummaryInput{Metric: backlogMetric, Company: company("420", "G"), CompanyRule: backlogMetric.Rule},
			rca.Requirement{}},
		{"money plan Green under plan", rca.SummaryInput{Metric: spendMetric, Company: company("97%", "G"), CompanyRule: spendMetric.Rule},
			rca.Requirement{}},
		{"quarterly, the month that closes the quarter",
			rca.SummaryInput{Metric: quarterlyMetric, Company: company("80%", "R"), CompanyRule: quarterlyMetric.Rule, Coarse: true, ClosesInMonth: true},
			rca.Requirement{Required: true, Reason: "Red"}},
		{"quarterly, a month that does not close it",
			rca.SummaryInput{Metric: quarterlyMetric, Company: company("80%", "R"), CompanyRule: quarterlyMetric.Rule, Coarse: true},
			rca.Requirement{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.in.Scale = scale
			if got := rca.SummaryRequired(c.in); got != c.want {
				t.Fatalf("SummaryRequired = %+v, want %+v", got, c.want)
			}
		})
	}
}

// TestSummaryRequiredPerSubjectBands: each reporting subject is judged by
// its own rule, so a subject at its own best status and at 100% is perfect
// whatever the metric's bands say.
func TestSummaryRequiredPerSubjectBands(t *testing.T) {
	loose := bands(domain.Band{Status: "G", Op: ">=", Value: 99.5}, domain.Band{Status: "R"})
	in := rca.SummaryInput{Metric: uptimeMetric, CompanyRule: uptimeMetric.Rule, Scale: scale, Noun: services,
		Reporting: []rca.SubjectFacts{
			{ID: "status-page", Name: "Status page", Cell: rca.CellFacts{Display: "99.60%", Status: "G"}, Rule: loose},
			{ID: "a", Name: "A", Cell: rca.CellFacts{Display: "100.00%", Status: "G"}, Rule: uptimeMetric.Rule},
		}}
	if got := rca.SummaryRequired(in); got != (rca.Requirement{Required: true, Reason: "1 of 2 services below 100%"}) {
		t.Fatalf("SummaryRequired = %+v", got)
	}
	// A band metric with no ideal counts the subjects not at their best.
	in = rca.SummaryInput{Metric: backlogMetric, CompanyRule: backlogMetric.Rule, Scale: scale, Noun: rca.NounForms{One: "product", Many: "products"},
		Reporting: []rca.SubjectFacts{
			{ID: "a", Name: "A", Cell: rca.CellFacts{Display: "620", Status: "R"}, Rule: backlogMetric.Rule},
			{ID: "b", Name: "B", Cell: rca.CellFacts{Display: "120", Status: "G"}, Rule: backlogMetric.Rule},
		}}
	if got := rca.SummaryRequired(in); got != (rca.Requirement{Required: true, Reason: "1 of 2 products not Green"}) {
		t.Fatalf("band SummaryRequired = %+v", got)
	}
}

func TestCompanyHeadline(t *testing.T) {
	in := rca.SummaryInput{Metric: uptimeMetric, CompanyRule: uptimeMetric.Rule, Scale: scale, Reporting: uptimeServices(), Noun: services}
	if got := rca.CompanyHeadline(in); got != "6 of 24 services below 100% · worst Webhooks 99.06%" {
		t.Fatalf("CompanyHeadline = %q", got)
	}
	if d, s := rca.CompanyStanding(in); d != "99.06%" || s != "R" {
		t.Fatalf("CompanyStanding = %q %q, want the worst service's", d, s)
	}
	if got := rca.SubjectsShort(in); !slices.Equal(got, []string{"search", "analytics-ingest", "webhooks", "ledger", "checkout-api", "push-gateway"}) {
		t.Fatalf("SubjectsShort = %v", got)
	}
	in.Reporting = allAt100(24)
	if got := rca.CompanyHeadline(in); got != "" {
		t.Fatalf("CompanyHeadline at 100%% = %q, want none", got)
	}
	cases := []struct {
		name string
		in   rca.SummaryInput
		want string
	}{
		{"Green below 100%", rca.SummaryInput{Metric: trainingMetric, Company: company("94%", "G"), CompanyRule: trainingMetric.Rule}, "6 pts short of 100%"},
		{"downtime", rca.SummaryInput{Metric: uptimeMetric, Company: company("99.50%", "R"), CompanyRule: uptimeMetric.Rule}, "0.50 pts short of 100%"},
		{"band", rca.SummaryInput{Metric: backlogMetric, Company: company("588", "R"), CompanyRule: backlogMetric.Rule}, "138 above the Green line (450 or less)"},
		{"perfect", rca.SummaryInput{Metric: uptimeMetric, Company: company("100.00%", "G"), CompanyRule: uptimeMetric.Rule}, ""},
		{"change rule", rca.SummaryInput{Metric: defectMetric, Company: &rca.CellFacts{Display: "22.8", Status: "R", Change: fp(-26)}, CompanyRule: defectMetric.Rule, ComparedLabel: "Sep"},
			"26% worse than Sep · Green needs any improvement"},
		{"ratio, with the record noun", rca.SummaryInput{Metric: epicsMetric, CompanyRule: epicsMetric.Rule, RecordNoun: "epics",
			Company: &rca.CellFacts{Display: "79%", Status: "R", Components: map[string]float64{"epics_on_time": 26, "epics_committed": 33}}},
			"21 pts short of 100% · 7 of 33 epics missed"},
	}
	for _, c := range cases {
		c.in.Scale = scale
		if got := rca.CompanyHeadline(c.in); got != c.want {
			t.Errorf("%s: CompanyHeadline = %q, want %q", c.name, got, c.want)
		}
		if d, s := rca.CompanyStanding(c.in); d != c.in.Company.Display || s != c.in.Company.Status {
			t.Errorf("%s: CompanyStanding = %q %q", c.name, d, s)
		}
	}
}

func TestNouns(t *testing.T) {
	for in, want := range map[string]rca.NounForms{
		"Services":     {One: "service", Many: "services"},
		"Repository":   {One: "repository", Many: "repositories"},
		"Product":      {One: "product", Many: "products"},
		"Status class": {One: "status class", Many: "status classes"},
		"":             {One: "item", Many: "items"},
	} {
		if got := rca.Nouns(in, "item"); got != want {
			t.Errorf("Nouns(%q) = %+v, want %+v", in, got, want)
		}
	}
}

// TestInferredMoneyPlan: a money plan whose chart kind is left to the engine
// (two-sided bands around 100%) is judged as a money plan by the rules and
// the gap, whatever its direction.
func TestInferredMoneyPlan(t *testing.T) {
	plan := domain.Metric{Key: "spend", Formula: "actual_k / planned_k * 100", Format: domain.FormatPercent0, Frequency: domain.FrequencyMonthly,
		Rule: bands(domain.Band{Status: "R", Op: ">", Value: 110}, domain.Band{Status: "Y", Op: ">", Value: 105}, domain.Band{Status: "Y", Op: "<", Value: 90}, domain.Band{Status: "G"})}
	under := rca.SummaryInput{Metric: plan, Company: company("97%", "G"), CompanyRule: plan.Rule, Scale: scale}
	if got := rca.SummaryRequired(under); got.Required {
		t.Errorf("97%% of plan = %+v, want optional", got)
	}
	over := rca.SummaryInput{Metric: plan, Company: company("104%", "G"), CompanyRule: plan.Rule, Scale: scale}
	if got := rca.SummaryRequired(over); got != (rca.Requirement{Required: true, Reason: "Above 100% (104%)"}) {
		t.Errorf("104%% of plan = %+v", got)
	}
	if got := rca.CompanyHeadline(over); got != "4% over plan" {
		t.Errorf("headline = %q", got)
	}
	if ideal, ok := rca.Ideal(plan); !ok || ideal != 100 {
		t.Errorf("Ideal = %v %v", ideal, ok)
	}
}
