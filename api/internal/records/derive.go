package records

import (
	"errors"
	"fmt"
	"sort"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// DeriveInput is everything derivation reads. LatestAsOf maps a record type
// to the as-of date of its latest snapshot.
type DeriveInput struct {
	Cal        period.Calendar
	Tree       *orgtree.Tree
	Items      []domain.TrackedItem
	Types      []domain.RecordType
	Records    []domain.Record
	LatestAsOf map[string]domain.Date
}

// Contribution reasons.
const (
	ReasonMatched  = "matched"
	ReasonMet      = "met"
	ReasonMissed   = "missed"
	ReasonSlipped  = "slipped"
	ReasonPending  = "pending"
	ReasonOpenDays = "open_days"
	ReasonAgeDays  = "age_days"
)

// Contribution is one record's part in a derived value. Amount is what it
// added to the value (1 for a count, a defect's points, an age in days);
// Dates holds the dates the rule used, by field name.
type Contribution struct {
	Source, ExternalID, Title, URL, Priority string
	State                                    domain.RecordState
	Amount                                   float64
	Reason                                   string
	Dates                                    map[string]domain.Date
}

// Derived is a measure's value for one subject and period, computed from
// records through Cutoff. Pending counts commitments due later in the period
// that are not yet met or missed.
type Derived struct {
	MeasureKey, SubjectID string
	Period                period.Period
	Value                 float64
	Cutoff                domain.Date
	Pending               int
	Contributions         []Contribution
}

// window is one requested period that gets derived values.
type window struct {
	p      period.Period
	start  time.Time // first day
	last   time.Time // last day of the period
	cut    time.Time // the earlier of last and the latest snapshot
	months []monthSpan
	order  []string
	cells  map[string]*Derived
}

// monthSpan is one month of a window, as days [start, end).
type monthSpan struct {
	m          period.Period
	start, end time.Time
}

// contains reports whether d is in the window through its cutoff.
func (w *window) contains(d time.Time) bool { return !d.Before(w.start) && !d.After(w.cut) }

// inPeriod reports whether d is in the window's period, ignoring the cutoff.
func (w *window) inPeriod(d time.Time) bool { return !d.Before(w.start) && !d.After(w.last) }

// Derive computes m's derive rule for each period, returning one value per
// subject that gets one: every leaf org unit and tracked item with a source
// key, for periods that start no earlier than the record type's earliest
// tracked-from month and no later than its latest snapshot. A subject with
// no matching records gets 0. Values are ordered by period as given, then
// by subject ID; contributions by source and external ID.
func Derive(in DeriveInput, m domain.Measure, periods []period.Period) ([]Derived, error) {
	if m.Derive == nil {
		return nil, fmt.Errorf("derive %s: measure has no derive rule", m.Key)
	}
	rule := *m.Derive
	var rt domain.RecordType
	found := false
	for _, t := range in.Types {
		if t.ID == rule.RecordType {
			rt, found = t, true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("derive %s: unknown record type %q", m.Key, rule.RecordType)
	}
	if errs := domain.ValidateDerive(domain.Methodology{Measures: []domain.Measure{m}}, []domain.RecordType{rt}); errs != nil {
		joined := make([]error, len(errs))
		for i, e := range errs {
			joined[i] = e
		}
		return nil, fmt.Errorf("derive %s: %w", m.Key, errors.Join(joined...))
	}
	cond, err := CompileWhere(rule.Where, rt)
	if err != nil {
		return nil, fmt.Errorf("derive %s: %w", m.Key, err)
	}

	latest, ok := in.LatestAsOf[rt.ID]
	if !ok || latest.IsZero() {
		return nil, nil
	}
	from, ok := trackedFrom(in.Cal, rt)
	if !ok {
		return nil, nil
	}
	windows, err := buildWindows(in, m.Key, periods, from, dayOf(latest))
	if err != nil || len(windows) == 0 {
		return nil, err
	}

	d := &deriver{in: in, rule: rule, rt: rt, cond: cond, res: newResolver(in), windows: windows, latest: latest}
	if rule.Op != domain.OpDaysInPeriod {
		for i := range in.Records {
			r := &in.Records[i]
			if r.Type != rt.ID || len(r.Revisions) == 0 {
				continue
			}
			if err := d.record(r); err != nil {
				return nil, fmt.Errorf("derive %s: record %s/%s: %w", m.Key, r.Source, r.ExternalID, err)
			}
		}
	}

	var out []Derived
	for _, w := range windows {
		for _, id := range w.order {
			c := w.cells[id]
			if rule.Op == domain.OpDaysInPeriod {
				c.Value = float64(daysBetween(w.start, w.cut) + 1)
			}
			sort.SliceStable(c.Contributions, func(i, j int) bool {
				a, b := c.Contributions[i], c.Contributions[j]
				if a.Source != b.Source {
					return a.Source < b.Source
				}
				return a.ExternalID < b.ExternalID
			})
			out = append(out, *c)
		}
	}
	return out, nil
}

// trackedFrom returns the first day of rt's earliest tracked-from month
// across sources, and false when no source has one.
func trackedFrom(cal period.Calendar, rt domain.RecordType) (time.Time, bool) {
	var from time.Time
	ok := false
	for _, p := range rt.TrackedFrom {
		if s := cal.Start(p); !ok || s.Before(from) {
			from, ok = s, true
		}
	}
	return from, ok
}

// buildWindows returns the periods that get derived values, each with a zero
// cell per subject.
func buildWindows(in DeriveInput, key string, periods []period.Period, from, latest time.Time) ([]*window, error) {
	var out []*window
	for _, p := range periods {
		months := in.Cal.Months(p)
		if months == nil {
			return nil, fmt.Errorf("derive %s: invalid period %s", key, p)
		}
		start, end := in.Cal.Start(p), in.Cal.End(p)
		if start.Before(from) || start.After(latest) {
			continue
		}
		last := end.AddDate(0, 0, -1)
		cut := minTime(last, latest)
		w := &window{p: p, start: start, last: last, cut: cut, cells: map[string]*Derived{}}
		for _, mo := range months {
			w.months = append(w.months, monthSpan{m: mo, start: in.Cal.Start(mo), end: in.Cal.End(mo)})
		}
		w.order = cellSubjects(in, months)
		for _, id := range w.order {
			w.cells[id] = &Derived{MeasureKey: key, SubjectID: id, Period: p, Cutoff: domain.Date{Time: cut}}
		}
		out = append(out, w)
	}
	return out, nil
}

type deriver struct {
	in      DeriveInput
	rule    domain.DeriveRule
	rt      domain.RecordType
	cond    *Cond
	res     *resolver
	windows []*window
	latest  domain.Date
}

// cell returns the cell of w for the subject key matches in month, or nil
// when the key does not resolve to a subject with a value in w.
func (d *deriver) cell(w *window, key string, month period.Period) *Derived {
	id, problem := d.res.resolve(key, month)
	if problem != "" {
		return nil
	}
	return w.cells[id]
}

func (d *deriver) record(r *domain.Record) error {
	switch d.rule.Op {
	case domain.OpDailyOpenWeighted:
		return d.dailyOpen(r)
	case domain.OpCommitments:
		return d.commitments(r)
	}
	return d.bucketed(r)
}

// bucketed handles count, sum, and age_sum, which read the latest revision
// and bucket by the rule's bucketBy date.
func (d *deriver) bucketed(r *domain.Record) error {
	f := Latest(*r)
	bucket, ok, err := d.date(f, d.rule.BucketBy)
	if err != nil || !ok {
		return err
	}
	month := d.in.Cal.MonthOf(bucket)
	matched := -1 // unknown until a cell needs it
	for _, w := range d.windows {
		if !w.contains(bucket) {
			continue
		}
		c := d.cell(w, f.SubjectKey, month)
		if c == nil {
			continue
		}
		if matched < 0 {
			ok, err := d.cond.Match(f)
			if err != nil {
				return err
			}
			matched = boolInt(ok)
		}
		if matched == 0 {
			continue
		}
		con := contribution(r, f, ReasonMatched, 1)
		con.Dates[d.rule.BucketBy] = domain.Date{Time: bucket}
		switch d.rule.Op {
		case domain.OpSum:
			v, err := fieldValue(f, d.rule.Field, domain.AttrNumber)
			if err != nil {
				return err
			}
			n, ok := v.(float64)
			if !ok {
				continue // no value to add
			}
			con.Amount = n
		case domain.OpAgeSum:
			from, ok, err := d.date(f, d.rule.AgeFrom)
			if err != nil {
				return err
			}
			if !ok {
				continue
			}
			to, ok, err := d.date(f, d.rule.AgeTo)
			if err != nil {
				return err
			}
			if ok {
				con.Dates[d.rule.AgeTo] = domain.Date{Time: to}
			} else {
				to = w.cut // still open, or no ageTo: age through the cutoff
			}
			con.Reason = ReasonAgeDays
			con.Amount = float64(max(0, daysBetween(from, to)))
			con.Dates[d.rule.AgeFrom] = domain.Date{Time: from}
		}
		c.Value += con.Amount
		c.Contributions = append(c.Contributions, con)
	}
	return nil
}

// commitments counts each of the record's commitments in the period its
// due date falls in. Outcomes are judged at the latest snapshot, which for
// a commitment due within a period matches judging at the period's cutoff.
func (d *deriver) commitments(r *domain.Record) error {
	cs := Commitments(*r, d.latest)
	if len(cs) == 0 {
		return nil
	}
	f := Latest(*r)
	ok, err := d.cond.Match(f)
	if err != nil || !ok {
		return err
	}
	for _, cm := range cs {
		if cm.Outcome == OutcomeDropped {
			continue
		}
		due := dayOf(cm.Due)
		month := d.in.Cal.MonthOf(due)
		for _, w := range d.windows {
			if !w.inPeriod(due) {
				continue
			}
			c := d.cell(w, f.SubjectKey, month)
			if c == nil {
				continue
			}
			var con Contribution
			switch {
			case cm.Outcome == OutcomePending:
				con = contribution(r, f, ReasonPending, 0)
				c.Pending++
			case cm.Outcome == OutcomeMet:
				con = contribution(r, f, ReasonMet, 1)
			case cm.Slipped:
				con = contribution(r, f, ReasonSlipped, float64(boolInt(d.rule.Outcome == domain.OutcomeResolved)))
			default:
				con = contribution(r, f, ReasonMissed, float64(boolInt(d.rule.Outcome == domain.OutcomeResolved)))
			}
			con.Dates["dueAt"] = domain.Date{Time: due}
			if f.CompletedAt != nil && !f.CompletedAt.IsZero() {
				con.Dates["completedAt"] = domain.Date{Time: dayOf(*f.CompletedAt)}
			}
			c.Value += con.Amount
			c.Contributions = append(c.Contributions, con)
		}
	}
	return nil
}

// dailyOpen adds, for each day through the cutoff that the record is open,
// the weight of its priority that day when that day's revision matches the
// where condition. createdAt and completedAt come from the latest revision.
func (d *deriver) dailyOpen(r *domain.Record) error {
	f := Latest(*r)
	if f.CreatedAt.IsZero() {
		return nil
	}
	created := dayOf(f.CreatedAt)
	var done time.Time
	hasDone := f.CompletedAt != nil && !f.CompletedAt.IsZero()
	if hasDone {
		done = dayOf(*f.CompletedAt)
	}
	revs := r.Revisions
	matches := make([]int8, len(revs)) // 0 unknown, 1 no, 2 yes
	match := func(i int) (bool, error) {
		if matches[i] == 0 {
			ok, err := d.cond.Match(revs[i].Fields)
			if err != nil {
				return false, err
			}
			matches[i] = 1 + int8(boolInt(ok))
		}
		return matches[i] == 2, nil
	}

	type part struct {
		cell        *Derived
		points      float64
		days        int
		contributed bool
	}
	for _, w := range d.windows {
		// Open on days [a, b): created on or before the day and not yet
		// completed on it.
		a, b := maxTime(created, w.start), w.cut.AddDate(0, 0, 1)
		if hasDone && done.Before(b) {
			b = done
		}
		if !a.Before(b) {
			continue
		}
		var parts []part
		for _, ms := range w.months {
			x, y := maxTime(a, ms.start), minTime(b, ms.end)
			if !x.Before(y) {
				continue
			}
			c := d.cell(w, f.SubjectKey, ms.m)
			if c == nil {
				continue
			}
			pi := -1
			for i := range parts {
				if parts[i].cell == c {
					pi = i
				}
			}
			if pi < 0 {
				parts = append(parts, part{cell: c})
				pi = len(parts) - 1
			}
			for x.Before(y) {
				i := revisionOn(revs, x)
				seg := y
				if i+1 < len(revs) {
					if next := dayOf(revs[i+1].AsOf); next.Before(seg) {
						seg = next
					}
				}
				ok, err := match(i)
				if err != nil {
					return err
				}
				if ok {
					n := daysBetween(x, seg)
					parts[pi].points += d.rule.Weights[priorityOf(revs[i].Fields)] * float64(n)
					parts[pi].days += n
				}
				x = seg
			}
		}
		for _, p := range parts {
			if p.days == 0 {
				continue
			}
			con := contribution(r, f, ReasonOpenDays, p.points)
			con.Dates["createdAt"] = domain.Date{Time: created}
			if hasDone {
				con.Dates["completedAt"] = domain.Date{Time: done}
			}
			p.cell.Value += p.points
			p.cell.Contributions = append(p.cell.Contributions, con)
		}
	}
	return nil
}

// date returns the date field or attribute name of f as a calendar day, and
// false when it is empty.
func (d *deriver) date(f domain.RecordFields, name string) (time.Time, bool, error) {
	if name == "" {
		return time.Time{}, false, nil
	}
	v, err := fieldValue(f, name, domain.AttrDate)
	if err != nil {
		return time.Time{}, false, err
	}
	t, ok := v.(time.Time)
	return t, ok, nil
}

func contribution(r *domain.Record, f domain.RecordFields, reason string, amount float64) Contribution {
	return Contribution{
		Source: r.Source, ExternalID: r.ExternalID, Title: f.Title, URL: f.URL,
		Priority: priorityOf(f), State: f.State, Amount: amount, Reason: reason,
		Dates: map[string]domain.Date{},
	}
}

func priorityOf(f domain.RecordFields) string {
	if f.Priority == "" {
		return domain.PriorityNone
	}
	return f.Priority
}

// daysBetween returns the number of calendar days from a to b (UTC midnights).
func daysBetween(a, b time.Time) int {
	return int(b.Sub(a).Round(time.Hour).Hours() / 24)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
