// Package report builds monthly operating report snapshots and fact sentences.
package report

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"opsvision/internal/domain"
)

const jsonContentType = "application/json"

// Document is the JSON snapshot stored for a published revision.
type Document struct {
	Period      string          `json:"period"`
	GeneratedAt time.Time       `json:"generatedAt"`
	Summary     string          `json:"summary"`
	Facts       []string        `json:"facts"`
	VersionIds  []string        `json:"versionIds"`
	View        json.RawMessage `json:"view"`
}

// FactsView is the slice of a scorecard view used to compute fact sentences.
// RootSubjectID is the org tree's root unit: facts describe its rows only,
// and there are none when it is empty.
type FactsView struct {
	ReportPeriod  string
	RootSubjectID string
	Rows          []FactsRow
}

// FactsRow is one metric row at one subject.
type FactsRow struct {
	MetricKey  string
	MetricName string
	SubjectID  string
	Depth      int
	Cells      []FactsCell
}

// FactsCell is one column cell.
type FactsCell struct {
	Period   string
	Value    *float64
	Display  string
	Status   string
	NAReason string
}

// Facts computes fact sentences for the company row at ReportPeriod.
func Facts(v FactsView, scale []domain.StatusLevel) []string {
	if len(scale) == 0 {
		scale = domain.DefaultStatusScale()
	}
	rank := statusRanks(scale)
	worst := worstRank(rank)
	best := bestRank(rank)
	root := v.RootSubjectID
	if root == "" {
		return []string{}
	}
	byMetric := map[string]FactsRow{}
	for _, r := range v.Rows {
		if r.SubjectID != root {
			continue
		}
		byMetric[r.MetricKey] = r
	}
	var turned []string
	var firstGreen []string
	var notReported []string
	for _, r := range sortRows(byMetric) {
		cur, ok := cellAt(r, v.ReportPeriod)
		if !ok {
			continue
		}
		prev, hasPrev := priorMonthCell(r, v.ReportPeriod, monthOrder(r))
		if hasPrev && reported(cur) && reported(prev) {
			cr, pr := rank[cur.Status], rank[prev.Status]
			if cr == worst && pr != worst && cur.Status != "" && prev.Status != "" {
				turned = append(turned, r.MetricName)
			}
		}
		if reported(cur) && cur.Status != "" && rank[cur.Status] == best {
			k := greenStreak(r, v.ReportPeriod, monthOrder(r), rank, best)
			if k >= 2 {
				firstGreen = append(firstGreen, fmt.Sprintf("first green in %d months: %s", k, r.MetricName))
			}
		}
		if !reported(cur) {
			notReported = append(notReported, r.MetricName)
		}
	}
	out := []string{}
	if len(turned) > 0 {
		out = append(out, fmt.Sprintf("%d metric%s turned red: %s", len(turned), plural(len(turned)), strings.Join(turned, ", ")))
	}
	out = append(out, firstGreen...)
	if len(notReported) > 0 {
		out = append(out, fmt.Sprintf("not reported: %s", strings.Join(notReported, ", ")))
	}
	return out
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func sortRows(by map[string]FactsRow) []FactsRow {
	keys := make([]string, 0, len(by))
	for k := range by {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]FactsRow, 0, len(keys))
	for _, k := range keys {
		out = append(out, by[k])
	}
	return out
}

func statusRanks(scale []domain.StatusLevel) map[string]int {
	out := map[string]int{}
	for _, l := range scale {
		out[l.Key] = l.Rank
	}
	return out
}

func worstRank(rank map[string]int) int {
	w := 0
	for _, r := range rank {
		if r > w {
			w = r
		}
	}
	return w
}

func bestRank(rank map[string]int) int {
	if len(rank) == 0 {
		return 1
	}
	b := rank[mapKeys(rank)[0]]
	for _, r := range rank {
		if r < b {
			b = r
		}
	}
	return b
}

func mapKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func reported(c FactsCell) bool {
	if c.Value != nil {
		return true
	}
	return c.Status != "" && c.NAReason == ""
}

func monthOrder(r FactsRow) []string {
	var months []string
	seen := map[string]struct{}{}
	for _, c := range r.Cells {
		if _, ok := seen[c.Period]; ok {
			continue
		}
		seen[c.Period] = struct{}{}
		months = append(months, c.Period)
	}
	sort.Strings(months)
	return months
}

func cellAt(r FactsRow, period string) (FactsCell, bool) {
	for _, c := range r.Cells {
		if c.Period == period {
			return c, true
		}
	}
	return FactsCell{}, false
}

func priorMonthCell(r FactsRow, period string, order []string) (FactsCell, bool) {
	idx := slices.Index(order, period)
	if idx <= 0 {
		return FactsCell{}, false
	}
	return cellAt(r, order[idx-1])
}

func greenStreak(r FactsRow, period string, order []string, rank map[string]int, best int) int {
	idx := slices.Index(order, period)
	if idx < 0 {
		return 0
	}
	cur, ok := cellAt(r, period)
	if !ok || !reported(cur) || cur.Status == "" || rank[cur.Status] != best {
		return 0
	}
	k := 1
	for i := idx - 1; i >= 0; i-- {
		c, ok := cellAt(r, order[i])
		if !ok || !reported(c) || c.Status == "" {
			break
		}
		if rank[c.Status] == best {
			break
		}
		k++
	}
	if k < 2 {
		return 0
	}
	return k
}

// ObjectKey returns the objects-store key for a report snapshot.
func ObjectKey(tenantID, scorecardID, period string, revision int) string {
	return fmt.Sprintf("t/%s/reports/%s/%s/%d.json", tenantID, scorecardID, period, revision)
}
