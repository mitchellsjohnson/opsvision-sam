package engine

import (
	"reflect"
	"sync"
	"testing"

	"opsvision/internal/domain"
)

func memoData() []domain.DataPoint {
	var data []domain.DataPoint
	leaves := []string{"gateway", "storage", "analytics", "warehouse"}
	for mo := 1; mo <= 12; mo++ {
		for i, l := range leaves {
			data = append(data,
				pt("on_time", l, month(2026, mo), float64(10*(i+1)+mo)),
				pt("committed", l, month(2026, mo), float64(100+i)),
			)
		}
	}
	return data
}

func sumMetric(key, formula string) domain.Metric {
	return metricOf(key, formula, domain.FormatNumber1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 0)))
}

// Metrics that reference the same measures share rolled-up slot values: after
// one metric is computed, a second metric over the same measures adds nothing
// to the memo.
func TestSlotMemoSharedAcrossMetrics(t *testing.T) {
	ix := NewIndex(fixtureInput(t, memoData()...))
	v := versionOf(onTime, committed)
	a := sumMetric("a", "on_time / committed * 100")
	b := sumMetric("b", "on_time + committed")
	subjects := []string{"company", "platform", "data", "gateway", "analytics"}

	for _, s := range subjects {
		for mo := 1; mo <= 12; mo++ {
			ix.Cell(v, a, s, month(2026, mo))
		}
		ix.CellYTD(v, a, s, month(2026, 12))
	}
	ix.memoMu.RLock()
	after := len(ix.memo)
	ix.memoMu.RUnlock()
	if after == 0 {
		t.Fatal("memo is empty: rollups were not memoized")
	}
	for _, s := range subjects {
		for mo := 1; mo <= 12; mo++ {
			ix.Cell(v, b, s, month(2026, mo))
		}
		ix.CellYTD(v, b, s, month(2026, 12))
	}
	ix.memoMu.RLock()
	got := len(ix.memo)
	ix.memoMu.RUnlock()
	if got != after {
		t.Errorf("memo grew from %d to %d entries for a metric over the same measures", after, got)
	}
	// Every entry is a distinct (measure, subject, month): 2 measures x 7
	// units x the 24 months of FY25-FY26 that current and prior cells reach.
	if after > 2*7*24 {
		t.Errorf("memo has %d entries, want at most %d distinct (measure, subject, month)", after, 2*7*24)
	}
}

// Memoized answers equal those of a fresh Index, and a measure key defined
// with different rollups in two versions is not shared between them.
func TestSlotMemoMatchesFreshIndexAcrossVersions(t *testing.T) {
	data := memoData()
	sumV := versionOf(onTime, committed)
	maxOnTime := onTime
	maxOnTime.OrgAgg = domain.AggMax
	sumV.ID = "sum"
	maxV := versionOf(maxOnTime, committed)
	maxV.ID = "max"
	m := sumMetric("a", "on_time")

	warm := NewIndex(fixtureInput(t, data...))
	for round := 0; round < 2; round++ { // second round is served from the memo
		sum := warm.Cell(sumV, m, "company", month(2026, 1))
		mx := warm.Cell(maxV, m, "company", month(2026, 1))
		approx(t, "sum rollup", sum.Value, 11+21+31+41)
		approx(t, "max rollup", mx.Value, 41)
	}

	for _, s := range []string{"company", "platform", "data", "gateway", "analytics", "svc-a"} {
		for mo := 1; mo <= 12; mo++ {
			for _, v := range []domain.MethodologyVersion{sumV, maxV} {
				got := warm.Cell(v, m, s, month(2026, mo))
				want := NewIndex(fixtureInput(t, data...)).Cell(v, m, s, month(2026, mo))
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("%s/%s/%d: memoized %+v != fresh %+v", v.ID, s, mo, got, want)
				}
			}
		}
	}
}

// Concurrent use of one Index (run with -race) matches serial results.
func TestIndexConcurrentCellsMatchSerial(t *testing.T) {
	in := fixtureInput(t, memoData()...)
	v := versionOf(onTime, committed)
	m := sumMetric("a", "on_time / committed * 100")
	m.Rule = changeRule(domain.ComparePriorPeriod, band("G", ">=", 0), band("R", "", 0))
	subjects := []string{"company", "platform", "data", "gateway", "analytics", "warehouse"}

	type key struct {
		s   string
		mo  int
		ytd bool
	}
	compute := func(ix *Index) map[key]Cell {
		out := map[key]Cell{}
		for _, s := range subjects {
			for mo := 1; mo <= 12; mo++ {
				out[key{s, mo, false}] = ix.Cell(v, m, s, month(2026, mo))
				out[key{s, mo, true}] = ix.CellYTD(v, m, s, month(2026, mo))
			}
		}
		return out
	}
	want := compute(NewIndex(in))

	shared := NewIndex(in)
	var wg sync.WaitGroup
	results := make([]map[key]Cell, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = compute(shared)
		}()
	}
	wg.Wait()
	for i, got := range results {
		if !reflect.DeepEqual(got, want) {
			t.Errorf("goroutine %d differs from serial result", i)
		}
	}
}
