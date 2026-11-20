package rca_test

import (
	"reflect"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/rca"
	"opsvision/internal/records"
)

func miss(id, pri, reason, due string, dates map[string]string, state domain.RecordState) records.Contribution {
	ds := map[string]domain.Date{"dueAt": date(due)}
	for k, v := range dates {
		ds[k] = date(v)
	}
	return records.Contribution{Source: "tracker", ExternalID: id, Title: "Epic " + id, Priority: pri,
		State: state, Amount: 1, Reason: reason, Dates: ds}
}

func keys(rs []rca.Ranked) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.C.ExternalID
	}
	return out
}

func TestRankRatio(t *testing.T) {
	got := rca.RankRatio([]records.Contribution{
		miss("E-3", "P2", records.ReasonMissed, "2026-10-28", nil, domain.StateOpen),
		miss("E-5", "", records.ReasonMissed, "2026-10-05", map[string]string{"completedAt": "2026-10-30"}, domain.StateDone),
		miss("E-4", "P1", records.ReasonMissed, "2026-10-20", map[string]string{"completedAt": "2026-10-21"}, domain.StateDone),
		miss("E-6", "P1", records.ReasonMissed, "2026-10-01", map[string]string{"completedAt": "2026-10-04"}, domain.StateDone),
		miss("E-2", "P1", records.ReasonMissed, "2026-10-10", map[string]string{"completedAt": "2026-10-13"}, domain.StateDone),
		miss("E-1", "P1", records.ReasonSlipped, "2026-10-15", map[string]string{"nextDueAt": "2026-11-12"}, domain.StateOpen),
	})
	if want := []string{"E-1", "E-2", "E-6", "E-4", "E-3", "E-5"}; !reflect.DeepEqual(keys(got), want) {
		t.Fatalf("order = %v, want %v (priority, then days late, then key)", keys(got), want)
	}
	notes := map[string]string{}
	for _, r := range got {
		notes[r.C.ExternalID] = r.Note
		if r.ImpactDisplay != "" {
			t.Errorf("%s: ratio rows carry no points, got %q", r.C.ExternalID, r.ImpactDisplay)
		}
	}
	want := map[string]string{
		"E-1": "Slipped Oct 15 → Nov 12",
		"E-2": "Late by 3 days",
		"E-4": "Late by 1 day",
		"E-3": "Missed Oct 28 · still open",
	}
	for id, w := range want {
		if notes[id] != w {
			t.Errorf("%s note = %q, want %q", id, notes[id], w)
		}
	}
	// A slip with nothing after it still names the date it slipped from.
	if r := rca.RankRatio([]records.Contribution{miss("E-7", "P1", records.ReasonSlipped, "2026-10-15", nil, domain.StateOpen)}); r[0].Note != "Slipped Oct 15" {
		t.Errorf("bare slip note = %q", r[0].Note)
	}
}

func amount(id string, v float64) records.Contribution {
	return records.Contribution{Source: "tracker", ExternalID: id, Title: id, Amount: v}
}

func TestRankChange(t *testing.T) {
	got := rca.RankChange(
		[]records.Contribution{amount("D-2", 4), amount("D-1", 10), amount("D-3", 2)},
		[]records.Contribution{amount("D-1", 6), amount("D-2", 5), amount("D-9", 3)},
		1)
	if want := []string{"D-1", "D-3", "D-2", "D-9"}; !reflect.DeepEqual(keys(got), want) {
		t.Fatalf("order = %v, want %v (by the increase)", keys(got), want)
	}
	byID := map[string]rca.Ranked{}
	for _, r := range got {
		byID[r.C.ExternalID] = r
	}
	if r := byID["D-3"]; r.Note != "New" || r.Impact != 2 || r.ImpactDisplay != "+2" {
		t.Errorf("D-3 = %+v", r)
	}
	if r := byID["D-1"]; r.Note != "" || r.Impact != 4 || r.ImpactDisplay != "+4" {
		t.Errorf("D-1 = %+v", r)
	}
	if r := byID["D-9"]; r.Note != "Improved" || r.Impact != -3 || r.ImpactDisplay != "-3" {
		t.Errorf("D-9 = %+v", r)
	}
	perDay := rca.RankChange([]records.Contribution{amount("D-1", 10)}, nil, 31)
	if perDay[0].ImpactDisplay != "+0.3" || perDay[0].Note != "New" {
		t.Errorf("per day = %+v", perDay[0])
	}
}

func TestRankAmounts(t *testing.T) {
	got := rca.RankAmounts(31, []records.Contribution{amount("D-2", 62), amount("D-1", 384.4), amount("D-3", 62)})
	if want := []string{"D-1", "D-2", "D-3"}; !reflect.DeepEqual(keys(got), want) {
		t.Fatalf("order = %v", keys(got))
	}
	if got[0].ImpactDisplay != "12.4" || got[1].ImpactDisplay != "2" || !near(got[0].Impact, 12.4) {
		t.Fatalf("impacts = %+v", got)
	}
}

func TestRankOverPlan(t *testing.T) {
	planned := []records.Contribution{amount("C-1", 100), amount("C-2", 200), amount("C-3", 50)}
	actual := []records.Contribution{amount("C-2", 216), amount("C-1", 130), amount("C-3", 40), amount("C-4", 12)}
	got := rca.RankOverPlan(rca.PlanOverruns(planned, actual))
	if want := []string{"C-1", "C-2", "C-4"}; !reflect.DeepEqual(keys(got), want) {
		t.Fatalf("order = %v, want %v (only records over plan)", keys(got), want)
	}
	if got[0].Impact != 30 || got[0].ImpactDisplay != "$30k" || got[1].ImpactDisplay != "$16k" || got[2].ImpactDisplay != "$12k" {
		t.Fatalf("impacts = %+v", got)
	}
}
