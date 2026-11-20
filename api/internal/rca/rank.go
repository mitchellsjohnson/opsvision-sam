package rca

import (
	"cmp"
	"math"
	"slices"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/records"
)

// Ranked is one record ranked as evidence. Impact is its contribution in the
// ranking's terms; ImpactDisplay shows it (empty for ratios, which state the
// unit cost once in the gap's detail); Note says what happened to it.
type Ranked struct {
	C             records.Contribution
	Impact        float64
	ImpactDisplay string
	Note          string
}

// RankRatio orders a ratio's misses (denominator contributions not in the
// numerator): priority first (none last), then days late (most first), then
// key. Days late run from the commitment's due date to its completion, else
// to its next due date (Dates["nextDueAt"], which callers may set). Notes:
// "Slipped Oct 15 → Nov 12", "Late by 3 days", "Missed Oct 28 · still open".
func RankRatio(misses []records.Contribution) []Ranked {
	out := make([]Ranked, len(misses))
	late := make(map[int]int, len(misses))
	for i, c := range misses {
		out[i] = Ranked{C: c, Note: missNote(c)}
		late[i] = daysLate(c)
	}
	idx := make([]int, len(out))
	for i := range idx {
		idx[i] = i
	}
	slices.SortStableFunc(idx, func(a, b int) int {
		return cmp.Or(
			comparePriority(out[a].C.Priority, out[b].C.Priority),
			cmp.Compare(late[b], late[a]),
			cmp.Compare(out[a].C.ExternalID, out[b].C.ExternalID),
			cmp.Compare(out[a].C.Source, out[b].C.Source),
		)
	})
	sorted := make([]Ranked, len(out))
	for i, j := range idx {
		sorted[i] = out[j]
	}
	return sorted
}

// comparePriority orders priorities as written (P1 before P2, SEV1 before
// SEV2), with none or no priority last.
func comparePriority(a, b string) int {
	an, bn := a == "" || a == domain.PriorityNone, b == "" || b == domain.PriorityNone
	switch {
	case an && bn:
		return 0
	case an:
		return 1
	case bn:
		return -1
	}
	return cmp.Compare(a, b)
}

// lateEnd is when a missed or slipped commitment was done, else its next due
// date.
func lateEnd(c records.Contribution) (domain.Date, bool) {
	if d, ok := c.Dates["completedAt"]; ok && !d.IsZero() {
		return d, true
	}
	if d, ok := c.Dates["nextDueAt"]; ok && !d.IsZero() {
		return d, true
	}
	return domain.Date{}, false
}

func daysLate(c records.Contribution) int {
	due, ok := c.Dates["dueAt"]
	end, okEnd := lateEnd(c)
	if !ok || !okEnd {
		return 0
	}
	return max(days(due, end), 0)
}

func missNote(c records.Contribution) string {
	due, hasDue := c.Dates["dueAt"]
	if !hasDue || due.IsZero() {
		return ""
	}
	switch c.Reason {
	case records.ReasonSlipped:
		if end, ok := lateEnd(c); ok {
			return "Slipped " + shortDate(due) + " → " + shortDate(end)
		}
		return "Slipped " + shortDate(due)
	case records.ReasonMissed:
		if done, ok := c.Dates["completedAt"]; ok && !done.IsZero() && due.Before(done) {
			return "Late by " + dayCount(days(due, done))
		}
		if c.State == domain.StateOpen {
			return "Missed " + shortDate(due) + " · still open"
		}
		return "Missed " + shortDate(due)
	}
	return ""
}

// RankAmounts orders contributions by amount, largest first (then key), with
// each one's share of the value: amount / per (a day's share of points over
// days, an average's share of ages over the count). ImpactDisplay has at
// most one decimal; the caller adds the unit and, when every contributor is
// listed, rounds the shares against the displayed value with RoundParts.
func RankAmounts(per float64, cs []records.Contribution) []Ranked {
	out := make([]Ranked, len(cs))
	for i, c := range cs {
		v := share(c.Amount, per)
		out[i] = Ranked{C: c, Impact: v, ImpactDisplay: trimmed(v, 1)}
	}
	slices.SortStableFunc(out, byImpact)
	return out
}

// RankChange orders records by how much more they contribute now than in
// the compared period, per per (a day): the largest increase first, then
// key. A record absent from prior is tagged New; one only in prior (closed
// since) counts its whole prior amount negative and is tagged Improved.
func RankChange(cur, prior []records.Contribution, per float64) []Ranked {
	before := make(map[[2]string]float64, len(prior))
	for _, c := range prior {
		before[identity(c)] += c.Amount
	}
	now := make(map[[2]string]bool, len(cur))
	var out []Ranked
	for _, c := range cur {
		now[identity(c)] = true
		was, had := before[identity(c)]
		v := share(c.Amount-was, per)
		r := Ranked{C: c, Impact: v, ImpactDisplay: signedTrimmed(v, 1)}
		if !had {
			r.Note = "New"
		}
		out = append(out, r)
	}
	for _, c := range prior {
		if now[identity(c)] {
			continue
		}
		v := share(-c.Amount, per)
		out = append(out, Ranked{C: c, Impact: v, ImpactDisplay: signedTrimmed(v, 1), Note: "Improved"})
	}
	slices.SortStableFunc(out, byImpact)
	return out
}

// PlanOverruns pairs the planned and actual contributions of a money plan
// by record and returns one contribution per record with Amount = actual −
// planned (a record with no planned amount is all over plan), in actual's
// order.
func PlanOverruns(planned, actual []records.Contribution) []records.Contribution {
	plan := make(map[[2]string]float64, len(planned))
	for _, c := range planned {
		plan[identity(c)] += c.Amount
	}
	out := make([]records.Contribution, 0, len(actual))
	for _, c := range actual {
		c.Amount -= plan[identity(c)]
		out = append(out, c)
	}
	return out
}

// RankOverPlan orders overruns (Amount = actual − planned, from
// PlanOverruns), keeping only records over plan, largest first, shown in
// thousands of dollars like money_k.
func RankOverPlan(cs []records.Contribution) []Ranked {
	var out []Ranked
	for _, c := range cs {
		if c.Amount > 0 {
			out = append(out, Ranked{C: c, Impact: c.Amount, ImpactDisplay: engine.Format(domain.FormatMoneyK, c.Amount)})
		}
	}
	slices.SortStableFunc(out, byImpact)
	return out
}

func byImpact(a, b Ranked) int {
	return cmp.Or(
		cmp.Compare(math.Round(b.Impact*1e9), math.Round(a.Impact*1e9)),
		cmp.Compare(a.C.ExternalID, b.C.ExternalID),
		cmp.Compare(a.C.Source, b.C.Source),
	)
}

func share(amount, per float64) float64 {
	if per <= 0 {
		return amount
	}
	return amount / per
}

func identity(c records.Contribution) [2]string { return [2]string{c.Source, c.ExternalID} }
