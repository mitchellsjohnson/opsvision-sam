package rca

import (
	"cmp"
	"math"
	"slices"
	"sort"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/records"
)

// Incident is one incident record as the downtime arithmetic reads it. Key
// is the group key when set, else the external ID. Minutes is the record's
// minutesDown; Impact is impactPct / 100 (0 means 1). Cutoff is the instant
// its source's data runs to (Cutoff of the source's latest as-of date); the
// zero time means no cutoff.
type Incident struct {
	Source, ExternalID, Key, Title, URL, Severity, SubjectID string
	State                                                    domain.RecordState
	Start, End                                               *time.Time
	Minutes                                                  *float64
	Impact                                                   float64
	CreatedAt                                                domain.Date
	CompletedAt                                              *domain.Date
	Cutoff                                                   time.Time
}

// Counted is one incident's share of a window's downtime. Minutes is what it
// counts in the window (impact-weighted, overlaps split); TotalMinutes its
// whole length (to its source's cutoff when ongoing). Overlaps maps the key
// of each incident it overlaps to the raw minutes they overlap.
// SameWindowAs lists incidents from other sources whose windows overlap it
// by at least 80% of the shorter one.
type Counted struct {
	Incident                                                  Incident
	Minutes, TotalMinutes                                     float64
	Overlaps                                                  map[string]float64
	SameWindowAs                                              []string
	StartedBefore, EndedAfter, Ongoing, DurationOnly, Unknown bool
}

// Downtime is a window's downtime explained by incidents. Unexplained and
// Excess are never both above zero; WithinTolerance (|explained − reported|
// at most max(1, 1% of reported)) only sets the tone, it hides nothing.
// Items are in evidence order: counted minutes descending, then start, then
// key.
type Downtime struct {
	PeriodMinutes, ReportedMinutes, Explained, Unexplained, Excess float64
	WithinTolerance                                                bool
	Items                                                          []Counted
}

// sameWindowShare is the overlap, as a share of the shorter window, at which
// two incidents from different sources read as one outage.
const sameWindowShare = 0.8

// extent is how an incident's minutes are placed.
type extent int

const (
	extentInterval extent = iota // a start and an end (or ongoing, or to its completed day)
	extentDuration               // minutes, placed by the UTC date of its start or creation
	extentUnknown                // nothing to count
)

// span is one incident's interval, clipped to the window and its cutoff.
type span struct {
	item       int
	lo, hi     time.Time // counted in the window
	start, end time.Time // whole, to the cutoff
	weight     float64
}

// CountDowntime counts the minutes incs explain in window w, given the
// period's minutes and the reported downtime. Cancelled incidents and those
// outside the window are left out. Overlapping intervals count the union
// once: each elementary segment is down for its length times the largest
// impact active, split among the active incidents in proportion to impact.
// Duration-only incidents count their minutes times impact in the period of
// the UTC date of their start (else creation) and are not overlap-checked;
// incidents with no times and no minutes are listed with 0 and Unknown.
func CountDowntime(w Window, periodMinutes, reportedMinutes float64, incs []Incident) Downtime {
	d := Downtime{PeriodMinutes: periodMinutes, ReportedMinutes: reportedMinutes}
	var spans []span
	for _, in := range incs {
		if in.State == domain.StateCancelled {
			continue
		}
		weight := in.Impact
		if weight <= 0 || weight > 1 {
			weight = 1
		}
		c := Counted{Incident: in, Overlaps: map[string]float64{}}
		start, end, ongoing, kind := placement(in, w)
		switch kind {
		case extentInterval:
			whole := end
			switch {
			case !in.Cutoff.IsZero() && in.Cutoff.Before(whole):
				whole = in.Cutoff
			case in.Cutoff.IsZero() && ongoing:
				whole = earlier(whole, w.End)
			}
			lo, hi := later(start, w.Start), earlier(whole, w.End)
			zeroInside := start.Equal(end) && !start.Before(w.Start) && start.Before(w.End)
			if !hi.After(lo) && !zeroInside {
				continue
			}
			c.TotalMinutes = math.Max(0, whole.Sub(start).Minutes())
			c.StartedBefore = start.Before(w.Start)
			c.EndedAfter = whole.After(w.End)
			c.Ongoing = ongoing
			if hi.After(lo) {
				spans = append(spans, span{item: len(d.Items), lo: lo, hi: hi, start: start, end: whole, weight: weight})
			}
		case extentDuration:
			if !dayIn(w, start) {
				continue
			}
			c.Minutes = *in.Minutes * weight
			c.TotalMinutes = *in.Minutes
			c.DurationOnly = true
		case extentUnknown:
			if !dayIn(w, start) {
				continue
			}
			c.Unknown = true
		}
		d.Items = append(d.Items, c)
	}

	sweep(d.Items, spans)
	sameWindows(d.Items, spans)

	for i := range d.Items {
		d.Items[i].Minutes = clean(d.Items[i].Minutes)
		d.Explained += d.Items[i].Minutes
	}
	d.Explained = clean(d.Explained)
	d.Unexplained = clean(math.Max(0, reportedMinutes-d.Explained))
	d.Excess = clean(math.Max(0, d.Explained-reportedMinutes))
	d.WithinTolerance = math.Abs(d.Explained-reportedMinutes) <= math.Max(1, 0.01*reportedMinutes)

	slices.SortStableFunc(d.Items, evidenceOrder)
	return d
}

// placement says how in's minutes are placed in w. For an interval it
// returns its start and end (far past w for an ongoing one, which the
// source's cutoff then clips); for the others, start is the UTC day that
// places it.
func placement(in Incident, w Window) (start, end time.Time, ongoing bool, kind extent) {
	if in.Start != nil {
		s := in.Start.UTC()
		switch {
		case in.End != nil:
			e := in.End.UTC()
			if e.Before(s) {
				e = s
			}
			return s, e, false, extentInterval
		case in.State == domain.StateOpen:
			e := w.End.AddDate(1, 0, 0)
			if e.Before(s) {
				e = s
			}
			return s, e, true, extentInterval
		case in.Minutes != nil:
			return utcDay(s), time.Time{}, false, extentDuration
		case in.CompletedAt != nil && !in.CompletedAt.IsZero():
			e := utcDay(in.CompletedAt.Time).AddDate(0, 0, 1)
			if e.Before(s) {
				e = s
			}
			return s, e, false, extentInterval
		}
		return utcDay(s), time.Time{}, false, extentUnknown
	}
	day := utcDay(in.CreatedAt.Time)
	if in.Minutes != nil {
		return day, time.Time{}, false, extentDuration
	}
	return day, time.Time{}, false, extentUnknown
}

// sweep splits the spans into elementary segments and adds each segment's
// downtime to the active incidents, and the overlap minutes between them.
func sweep(items []Counted, spans []span) {
	var points []time.Time
	for _, s := range spans {
		points = append(points, s.lo, s.hi)
	}
	slices.SortFunc(points, func(a, b time.Time) int { return a.Compare(b) })
	points = slices.CompactFunc(points, func(a, b time.Time) bool { return a.Equal(b) })
	active := make([]int, 0, len(spans))
	for k := 0; k+1 < len(points); k++ {
		a, b := points[k], points[k+1]
		active = active[:0]
		maxW, sumW := 0.0, 0.0
		for si, s := range spans {
			if !s.lo.After(a) && !s.hi.Before(b) {
				active = append(active, si)
				maxW = math.Max(maxW, s.weight)
				sumW += s.weight
			}
		}
		if len(active) == 0 {
			continue
		}
		length := b.Sub(a).Minutes()
		down := length * maxW
		for _, si := range active {
			items[spans[si].item].Minutes += down * spans[si].weight / sumW
		}
		for _, si := range active {
			for _, sj := range active {
				ci, cj := &items[spans[si].item], items[spans[sj].item]
				if si != sj && ci.Incident.Key != cj.Incident.Key {
					ci.Overlaps[cj.Incident.Key] += length
				}
			}
		}
	}
}

// sameWindows marks pairs of incidents from different sources whose whole
// windows overlap by at least sameWindowShare of the shorter one.
func sameWindows(items []Counted, spans []span) {
	for i, a := range spans {
		for _, b := range spans[i+1:] {
			ia, ib := &items[a.item], &items[b.item]
			if ia.Incident.Source == ib.Incident.Source {
				continue
			}
			shorter := math.Min(a.end.Sub(a.start).Minutes(), b.end.Sub(b.start).Minutes())
			overlap := earlier(a.end, b.end).Sub(later(a.start, b.start)).Minutes()
			if shorter <= 0 || overlap < sameWindowShare*shorter {
				continue
			}
			if !slices.Contains(ia.SameWindowAs, ib.Incident.Key) {
				ia.SameWindowAs = append(ia.SameWindowAs, ib.Incident.Key)
			}
			if !slices.Contains(ib.SameWindowAs, ia.Incident.Key) {
				ib.SameWindowAs = append(ib.SameWindowAs, ia.Incident.Key)
			}
		}
	}
	for i := range items {
		sort.Strings(items[i].SameWindowAs)
	}
}

// evidenceOrder is counted minutes descending, then start (none last), then
// key, source and external ID.
func evidenceOrder(a, b Counted) int {
	if c := cmp.Compare(math.Round(b.Minutes*1e6), math.Round(a.Minutes*1e6)); c != 0 {
		return c
	}
	switch as, bs := a.Incident.Start, b.Incident.Start; {
	case as != nil && bs != nil:
		if c := as.Compare(*bs); c != 0 {
			return c
		}
	case as != nil:
		return -1
	case bs != nil:
		return 1
	}
	return cmp.Or(
		cmp.Compare(a.Incident.Key, b.Incident.Key),
		cmp.Compare(a.Incident.Source, b.Incident.Source),
		cmp.Compare(a.Incident.ExternalID, b.Incident.ExternalID),
	)
}

// dayIn reports whether the calendar day (at UTC midnight) falls in w, by
// the window's own calendar dates.
func dayIn(w Window, day time.Time) bool {
	return !day.Before(localDay(w.Start)) && day.Before(localDay(w.End))
}

// utcDay is t's UTC calendar date at UTC midnight.
func utcDay(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// localDay is t's calendar date in its own location, at UTC midnight.
func localDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func earlier(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

func later(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// clean drops floating-point noise below a billionth of a minute.
func clean(x float64) float64 { return math.Round(x*1e9) / 1e9 }

// FromRecord reads an incident record's fields (as of the snapshot in
// force) for the arithmetic: Key is the group key when set, else the
// external ID; Start and End from startedAt and endedAt; Minutes from
// minutesDown; Impact from impactPct (a percentage). SubjectID is the
// caller's to set. It fails when a date-time attribute holds another type.
func FromRecord(source, externalID string, f domain.RecordFields, cutoff time.Time) (Incident, error) {
	in := Incident{
		Source: source, ExternalID: externalID, Key: cmp.Or(f.GroupKey, externalID),
		Title: f.Title, URL: f.URL, Severity: f.Priority, State: f.State,
		CreatedAt: f.CreatedAt, CompletedAt: f.CompletedAt, Cutoff: cutoff,
	}
	for name, dst := range map[string]**time.Time{records.AttrStartedAt: &in.Start, records.AttrEndedAt: &in.End} {
		t, ok, err := records.FieldDateTime(f, name)
		if err != nil {
			return Incident{}, err
		}
		if ok {
			*dst = &t
		}
	}
	if v, ok := f.Attributes[records.AttrMinutesDown].(float64); ok {
		in.Minutes = &v
	}
	if v, ok := f.Attributes[records.AttrImpactPct].(float64); ok {
		in.Impact = v / 100
	}
	return in, nil
}
