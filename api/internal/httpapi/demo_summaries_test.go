package httpapi

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"opsvision/internal/demo"
	"opsvision/internal/engine"
	"opsvision/internal/period"
)

func gateCells(items []GateItem, state string) []demo.SummaryCell {
	var out []demo.SummaryCell
	for _, it := range items {
		if it.State == state {
			out = append(out, demo.SummaryCell{MetricKey: it.MetricKey, Period: it.Period})
		}
	}
	return out
}

// currentBasis is the full basis a summary of metric would be stored with
// now: the gate's facts plus the incidents counted.
func currentBasis(t *testing.T, e *testEnv, metric string, month period.Period) (summaryFacts, []string) {
	t.Helper()
	ctx := context.Background()
	tenant, err := e.store.GetTenant(ctx, demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	in, err := e.api.loadInput(ctx, tenant, demo.ScorecardID, fiscalYears(true, month))
	if err != nil {
		t.Fatal(err)
	}
	v, _ := engine.VersionFor(in.Versions, month, in.Cal)
	for _, m := range v.Content.Metrics {
		if m.Key != metric {
			continue
		}
		per := month
		if g, ok := frequencyGrain(m.Frequency); ok && g != period.Month {
			per = in.Cal.Parent(month, g)
		}
		view, err := engine.Compute(in, engine.ViewRequest{Periods: []period.Period{per}, Structure: engine.StructureAsOf})
		if err != nil {
			t.Fatal(err)
		}
		c, err := e.api.newSummaryContext(ctx, tenant, demo.ScorecardID, in, reportRoot(in, month))
		if err != nil {
			t.Fatal(err)
		}
		last, _ := lastMonth(in.Cal, per)
		f := c.facts(v, m, per, view.Rows, 0, per != month, last == month)
		incs, err := e.api.incidentEvidence(ctx, tenant.ID, demo.ScorecardID, in, f)
		if err != nil {
			t.Fatal(err)
		}
		return f, incs
	}
	t.Fatalf("no metric %s in force for %s", metric, month)
	return summaryFacts{}, nil
}

// TestDemoSummaryGate: the seeded demo's October gate lists exactly the
// demo's missing and stale summaries, every written one is current in full
// (incidents included), and September has nothing missing or stale.
func TestDemoSummaryGate(t *testing.T) {
	e := newDemoEnv(t)
	oct := demoGate(t, e, oct2026)
	if got := gateCells(oct, summaryMissing); !reflect.DeepEqual(got, demo.SummaryMissing) {
		t.Errorf("October missing = %+v, want %+v", got, demo.SummaryMissing)
	}
	if got := gateCells(oct, summaryStale); !reflect.DeepEqual(got, demo.SummaryStale) {
		t.Errorf("October stale = %+v, want %+v", got, demo.SummaryStale)
	}
	// October also shows the quarterly metric's Q3 summary, the quarter it
	// counts, written in September and not required in October.
	q3 := demo.SummaryCell{MetricKey: "concepts_expected_value", Period: period.Period{Grain: period.Quarter, FY: 2026, Index: 3}}
	if got := gateCells(oct, summaryWritten); !reflect.DeepEqual(slices.DeleteFunc(got, func(c demo.SummaryCell) bool { return c == q3 }), demo.SummaryWritten) {
		t.Errorf("October written = %+v, want %+v and Q3", got, demo.SummaryWritten)
	}
	for _, it := range oct {
		if (it.State == summaryMissing || it.State == summaryStale) && !it.Requirement.Required {
			t.Errorf("%s is %s but not required", it.MetricKey, it.State)
		}
	}
	by := gateByMetric(oct)
	if q := by[q3.MetricKey]; q.Period != q3.Period || q.State != summaryWritten || q.Requirement.Required {
		t.Errorf("October %s = %+v, want Q3 written, not required", q3.MetricKey, q)
	}
	if st := by["security_training"]; st.Standing.Status != "G" || st.Requirement.Reason != "Below 100% ("+st.Standing.Display+")" {
		t.Errorf("security_training = %+v, want Green below 100%%", st)
	}

	for _, c := range slices.Concat(demo.SummaryWritten, demo.SummarySeptember) {
		month := c.Period
		if month.Grain != period.Month {
			month = period.Period{Grain: period.Month, FY: c.Period.FY, Index: c.Period.Index * 3}
		}
		r, ok := storedSummary(t, e, c.MetricKey, c.Period)
		if !ok {
			t.Errorf("no summary for %+v", c)
			continue
		}
		f, incs := currentBasis(t, e, c.MetricKey, month)
		if cur := f.basis(incs); !reflect.DeepEqual(r.Basis, cur) {
			t.Errorf("%+v basis = %+v, want the current %+v", c, r.Basis, cur)
		}
	}

	sp, _ := storedSummary(t, e, "spend_vs_plan", oct2026)
	f, incs := currentBasis(t, e, "spend_vs_plan", oct2026)
	cur := f.basis(incs)
	if got := staleReasons(sp.Basis, cur, func(s string) string { return s }); !reflect.DeepEqual(got,
		[]string{"The value changed from " + sp.Basis.Display + " to " + cur.Display + "."}) {
		t.Errorf("spend_vs_plan stale reasons = %q", got)
	}

	sep := demoGate(t, e, period.Period{Grain: period.Month, FY: 2026, Index: 9})
	if got := gateCells(sep, summaryMissing); len(got) != 0 {
		t.Errorf("September missing = %+v, want none", got)
	}
	if got := gateCells(sep, summaryStale); len(got) != 0 {
		t.Errorf("September stale = %+v, want none", got)
	}
	var required []demo.SummaryCell
	for _, it := range sep {
		if it.Requirement.Required {
			required = append(required, demo.SummaryCell{MetricKey: it.MetricKey, Period: it.Period})
		}
	}
	if !reflect.DeepEqual(required, demo.SummarySeptember) {
		t.Errorf("September required = %+v, want the seeded %+v", required, demo.SummarySeptember)
	}
}
