// Package demo seeds the fictional "Acme Demo" tenant: an org tree with a
// reorg, tracked services, a scorecard with three published methodology
// versions, 22 months of deterministic synthetic data, and, from 2026-M07,
// synthetic tracker records (epics and defects, with monthly snapshots) that
// the third version derives four measures from. The proof of concept, the
// web app's development, and the end-to-end tests all run against it.
//
// Everything here is invented. No real company, product, or person appears.
package demo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/recordimport"
	"opsvision/internal/store"
)

// Identity of the demo tenant and its scorecard.
const (
	TenantID    = "acme-demo"
	TenantName  = "Acme Demo"
	Auth0OrgID  = "org_acme_demo"
	ScorecardID = "service-fulfillment"
)

// User is a demo identity. The dev server lists them and signs tokens for
// them; Seed gives each a membership in the demo tenant.
type User struct {
	UserID string      `json:"userId"`
	Email  string      `json:"email"`
	Name   string      `json:"name"`
	Role   domain.Role `json:"role"`
}

// Users are the demo identities: an admin, a contributor scoped to Payments,
// and an unscoped viewer. Treat it as read-only.
var Users = []User{
	{UserID: "dev|admin", Email: "admin@demo.test", Name: "Avery Admin", Role: domain.RoleAdmin},
	{UserID: "dev|contributor", Email: "contributor@demo.test", Name: "Casey Contributor", Role: domain.RoleContributor},
	{UserID: "dev|viewer", Email: "viewer@demo.test", Name: "Val Viewer", Role: domain.RoleViewer},
}

// NotApplicable names the data point that is explicitly not applicable, and
// why. Both of its measures carry the reason.
var NotApplicable = struct {
	MetricKey string
	SubjectID string
	Period    period.Period
	Reason    string
}{
	MetricKey: "concepts_on_budget",
	SubjectID: "pipelines",
	Period:    period.Period{Grain: period.Month, FY: 2026, Index: 10},
	Reason:    "No concepts reached a budget checkpoint this month",
}

// ZeroOverZero names the month whose inputs are 0 and 0, so the metric
// divides zero by zero and is not applicable.
var ZeroOverZero = struct {
	MetricKey string
	SubjectID string
	Period    period.Period
	Measures  map[string]bool
}{
	MetricKey: "customer_feedback_slo",
	SubjectID: "ios-app",
	Period:    period.Period{Grain: period.Month, FY: 2026, Index: 2},
	Measures:  map[string]bool{"idea_age_days_sum": true, "idea_count": true},
}

// Fixed instants keep the seed reproducible.
var (
	tenantCreated = time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)
	published2025 = time.Date(2024, time.December, 15, 0, 0, 0, 0, time.UTC)
	published2026 = time.Date(2025, time.December, 15, 0, 0, 0, 0, time.UTC)
	// published2026v2 is when the records-derived methodology was published.
	published2026v2 = time.Date(2026, time.June, 15, 0, 0, 0, 0, time.UTC)
	// derivedAt is when the derived values were last calculated: the day
	// after the latest snapshot.
	derivedAt = time.Date(2026, time.November, 1, 9, 0, 0, 0, time.UTC)
)

// rngSeed fixes the synthetic data.
const (
	rngSeed1 = 0x0b5c0de
	rngSeed2 = 0x2026
)

// Seed creates the demo tenant in st and returns its ID. cal is the fiscal
// calendar the tenant's periods are measured with (the demo uses a January
// fiscal year start).
//
// Seed is safe to run again: if the tenant already exists nothing is written
// and the ID is returned, so a persistent dev store is seeded once.
func Seed(ctx context.Context, st store.Store, cal period.Calendar) (string, error) {
	switch _, err := st.GetTenant(ctx, TenantID); {
	case err == nil:
		return TenantID, nil
	case !errors.Is(err, store.ErrNotFound):
		return "", fmt.Errorf("demo: look up tenant: %w", err)
	}

	tenant := domain.Tenant{
		ID:                   TenantID,
		Name:                 TenantName,
		Auth0OrgID:           Auth0OrgID,
		FiscalYearStartMonth: time.January,
		StatusScale:          domain.DefaultStatusScale(),
		DefaultRole:          domain.RoleViewer,
		CreatedAt:            tenantCreated,
	}
	if err := st.CreateTenant(ctx, tenant); err != nil {
		return "", fmt.Errorf("demo: create tenant: %w", err)
	}
	for _, u := range Users {
		m := domain.Membership{UserID: u.UserID, Email: u.Email, Name: u.Name, Role: u.Role, CreatedAt: tenantCreated}
		if u.Role == domain.RoleContributor {
			m.Scope = domain.Scope{OrgUnitIDs: []string{"payments"}}
		}
		if err := st.PutMembership(ctx, TenantID, m); err != nil {
			return "", fmt.Errorf("demo: add member %s: %w", u.UserID, err)
		}
	}

	if err := seedOrg(ctx, st); err != nil {
		return "", err
	}
	if err := seedMethodology(ctx, st); err != nil {
		return "", err
	}
	if err := seedRecords(ctx, st); err != nil {
		return "", err
	}
	if err := seedData(ctx, st, cal); err != nil {
		return "", err
	}
	if err := seedDerived(ctx, st, tenant); err != nil {
		return "", err
	}
	return TenantID, nil
}

func month(fy, idx int) period.Period { return period.Period{Grain: period.Month, FY: fy, Index: idx} }

// --- org -------------------------------------------------------------------

// segments and products in tree order. Analytics starts under Data and moves
// to Platform in 2026-M07.
var segments = []struct{ id, name string }{
	{"platform", "Platform"}, {"payments", "Payments"}, {"data", "Data"}, {"mobile", "Mobile"},
}

var products = []struct{ id, name, segment string }{
	{"identity", "Identity", "platform"},
	{"messaging", "Messaging", "platform"},
	{"checkout", "Checkout", "payments"},
	{"billing", "Billing", "payments"},
	{"analytics", "Analytics", "data"},
	{"pipelines", "Pipelines", "data"},
	{"ios-app", "iOS App", "mobile"},
	{"android-app", "Android App", "mobile"},
}

var services = []struct{ id, name string }{
	{"public-api", "Public API"}, {"web-app", "Web App"}, {"status-page", "Status Page"},
}

const companyID = "acme"

func seedOrg(ctx context.Context, st store.Store) error {
	if err := st.PutLevels(ctx, TenantID, []domain.Level{
		{ID: "company", Name: "Company", Depth: 0},
		{ID: "segment", Name: "Segment", Depth: 1},
		{ID: "product", Name: "Product", Depth: 2},
	}); err != nil {
		return fmt.Errorf("demo: levels: %w", err)
	}
	units := []domain.OrgUnit{{ID: companyID, Name: TenantName, LevelID: "company"}}
	for _, s := range segments {
		units = append(units, domain.OrgUnit{ID: s.id, Name: s.name, LevelID: "segment", ParentID: companyID, SourceKeys: []string{s.name}})
	}
	for _, p := range products {
		units = append(units, domain.OrgUnit{ID: p.id, Name: p.name, LevelID: "product", ParentID: p.segment, SourceKeys: []string{p.name}})
	}
	for _, u := range units {
		if err := st.PutOrgUnit(ctx, TenantID, u); err != nil {
			return fmt.Errorf("demo: org unit %s: %w", u.ID, err)
		}
	}
	if err := st.PutOrgMove(ctx, TenantID, domain.OrgMove{
		UnitID:         "analytics",
		NewParentID:    "platform",
		EffectiveMonth: month(2026, 7),
		Note:           "Analytics joins Platform in the mid-year reorg",
	}); err != nil {
		return fmt.Errorf("demo: org move: %w", err)
	}
	if err := st.PutItemKind(ctx, TenantID, domain.ItemKind{ID: "services", Name: "Services"}); err != nil {
		return fmt.Errorf("demo: item kind: %w", err)
	}
	for _, s := range services {
		if err := st.PutTrackedItem(ctx, TenantID, domain.TrackedItem{
			ID: s.id, KindID: "services", Name: s.name, OrgUnitID: "platform", SourceKeys: []string{s.name},
		}); err != nil {
			return fmt.Errorf("demo: tracked item %s: %w", s.id, err)
		}
	}
	return nil
}

// --- methodology -----------------------------------------------------------

func seedMethodology(ctx context.Context, st store.Store) error {
	if err := st.PutScorecard(ctx, TenantID, domain.Scorecard{ID: ScorecardID, Name: "Service Fulfillment"}); err != nil {
		return fmt.Errorf("demo: scorecard: %w", err)
	}
	for _, v := range []domain.MethodologyVersion{
		version("v2025", "2025 v1.0", 2025, published2025, 85),
		version("v2026", "2026 v1.0", 2026, published2026, 90),
		derivedVersion(),
	} {
		if err := st.PutVersion(ctx, TenantID, v, store.MustNotExist); err != nil {
			return fmt.Errorf("demo: version %s: %w", v.ID, err)
		}
	}
	return nil
}

func version(id, name string, fy int, at time.Time, onTimeGreen float64) domain.MethodologyVersion {
	at = at.UTC()
	return domain.MethodologyVersion{
		ID:            id,
		ScorecardID:   ScorecardID,
		Name:          name,
		Status:        domain.VersionPublished,
		EffectiveFrom: month(fy, 1),
		PublishedAt:   &at,
		Content:       methodology(fy, onTimeGreen),
	}
}

// derivedVersion is "2026 v2": the 2026 methodology with epics committed,
// epics on time, defect points, and days in the period derived from tracker
// records instead of entered, from 2026-M07 (when records start).
func derivedVersion() domain.MethodologyVersion {
	v := version("v2026-2", "2026 v2", 2026, published2026v2, 90)
	v.EffectiveFrom = recordsFrom
	rules := map[string]domain.DeriveRule{
		"epics_committed": {RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeResolved},
		"epics_on_time":   {RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeMet},
		"defect_points_sum": {
			RecordType: "defect", Op: domain.OpDailyOpenWeighted,
			Where: "category in ['bug','defect']", Weights: maps.Clone(defectWeights),
		},
		"defect_days": {RecordType: "defect", Op: domain.OpDaysInPeriod},
	}
	for i := range v.Content.Measures {
		if r, ok := rules[v.Content.Measures[i].Key]; ok {
			v.Content.Measures[i].Source = domain.MeasureDerived
			v.Content.Measures[i].Derive = &r
		}
	}
	return v
}

// isDerived reports whether a measure's value for p comes from records, not
// from the seed's entered data: the four derived measures from 2026-M07 on.
func isDerived(measure string, p period.Period) bool {
	switch measure {
	case "epics_committed", "epics_on_time", "defect_points_sum", "defect_days":
		return p.Grain == period.Month && p.FY == recordsFrom.FY && p.Index >= recordsFrom.Index
	}
	return false
}

func bands(g, y float64) []domain.Band {
	return []domain.Band{
		{Status: "G", Op: ">=", Value: g},
		{Status: "Y", Op: ">=", Value: y},
		{Status: "R"},
	}
}

func lowerBands(g, y float64) []domain.Band {
	return []domain.Band{
		{Status: "G", Op: "<=", Value: g},
		{Status: "Y", Op: "<=", Value: y},
		{Status: "R"},
	}
}

// methodology returns the scorecard definition for a fiscal year. The years
// differ in one threshold: the on-time green line (and the annual goal that
// follows it), 85 in 2025 and 90 in 2026, so restating one year under the
// other visibly changes statuses.
func methodology(fy int, onTimeGreen float64) domain.Methodology {
	atProduct := []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}}
	atSegment := []domain.Subject{{Kind: domain.SubjectLevel, ID: "segment"}}
	atService := []domain.Subject{{Kind: domain.SubjectItemKind, ID: "services"}}
	year := period.Period{Grain: period.Year, FY: fy}

	return domain.Methodology{
		Categories: []domain.Category{
			{ID: "delivery", Name: "Delivery", Order: 1},
			{ID: "quality", Name: "Quality", Order: 2},
			{ID: "engineering", Name: "Engineering", Order: 3},
			{ID: "security", Name: "Security", Order: 4},
			{ID: "design", Name: "Design", Order: 5},
			{ID: "product", Name: "Product", Order: 6},
		},
		Measures: []domain.Measure{
			{Key: "epics_committed", Name: "Epics committed", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "epics_on_time", Name: "Epics delivered on time", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "concepts_measured", Name: "Concepts measured", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "concepts_within_budget", Name: "Concepts within budget", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "planned_spend_k", Name: "Planned spend", Unit: "$k", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "actual_spend_k", Name: "Actual spend", Unit: "$k", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "ev_measured", Name: "Concepts assessed for expected value", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "ev_delivered", Name: "Concepts that delivered expected value", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			// Every unit reports the same calendar days, so days takes the max
			// across units rather than the sum.
			{Key: "defect_points_sum", Name: "Defect points", Unit: "points", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "defect_days", Name: "Days in period", Unit: "days", OrgAgg: domain.AggMax, TimeAgg: domain.AggSum},
			{Key: "seconds_down", Name: "Seconds down", Unit: "s", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			{Key: "seconds_in_period", Name: "Seconds in period", Unit: "s", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			{Key: "trained_count", Name: "People trained", Unit: "people", OrgAgg: domain.AggSum, TimeAgg: domain.AggLatest},
			{Key: "headcount", Name: "Headcount", Unit: "people", OrgAgg: domain.AggSum, TimeAgg: domain.AggLatest},
			{Key: "idea_age_days_sum", Name: "Idea age (sum of days)", Unit: "days", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "idea_count", Name: "Ideas", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "a11y_score", Name: "Accessibility score", Unit: "points", OrgAgg: domain.AggNone, TimeAgg: domain.AggLatest},
			{Key: "a11y_max", Name: "Accessibility maximum score", Unit: "points", OrgAgg: domain.AggNone, TimeAgg: domain.AggLatest},
			{Key: "oss_within_slo", Name: "Open-source risks within SLO", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "oss_due", Name: "Open-source risks due", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
		},
		Metrics: []domain.Metric{
			{
				Key: "epics_on_time", Name: "Epics delivered on time", CategoryID: "delivery",
				Formula: "epics_on_time / epics_committed * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(onTimeGreen, 80)},
				Targets:    []domain.Target{{Label: "Annual goal", From: year, To: year, Value: onTimeGreen}},
				Definition: "Share of committed epics that shipped by their committed date.",
				Notes:      "Epics that move to a later quarter count as late.",
				Example:    "18 of 20 committed epics shipped on time is 90%.",
				Source:     "Delivery tracker",
			},
			{
				Key: "concepts_on_budget", Name: "Concepts delivered on budget", CategoryID: "delivery",
				Formula: "concepts_within_budget / concepts_measured * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(90, 80)},
				Targets:    []domain.Target{{Label: "Goal", Value: 80}},
				Definition: "Share of measured concepts that landed within their approved budget.",
				Example:    "7 of 8 concepts within budget is 88%.",
				Source:     "Finance review",
			},
			{
				Key: "spend_vs_plan", Name: "Spend vs plan", CategoryID: "delivery",
				Formula: "actual_spend_k / planned_spend_k * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: lowerBands(110, 120)},
				Definition: "Actual spend as a percentage of planned spend. Lower is better.",
				Example:    "$1,150k spent against $1,000k planned is 115%.",
				Source:     "Finance ledger",
			},
			{
				Key: "concepts_expected_value", Name: "Concepts delivered expected value", CategoryID: "product",
				Formula: "ev_delivered / ev_measured * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyQuarterly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(90, 80)},
				Definition: "Share of assessed concepts whose delivered value met the value expected at approval. Reported quarterly.",
				Source:     "Product review",
			},
			{
				Key: "weighted_defect_score", Name: "Weighted defect score", CategoryID: "quality",
				Formula: "defect_points_sum / defect_days", Format: domain.FormatNumber2,
				Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				// Any improvement is green, a decline of up to 5% is yellow, more is red.
				Rule: domain.StatusRule{Type: domain.RuleChange, Compare: domain.ComparePriorPeriod, Bands: []domain.Band{
					{Status: "G", Op: ">=", Value: 0},
					{Status: "Y", Op: ">=", Value: -5},
					{Status: "R"},
				}},
				Definition: "Severity-weighted open defects per day. Judged on change against the prior period; lower is better.",
				Source:     "Defect tracker",
			},
			{
				Key: "uptime", Name: "Uptime", CategoryID: "engineering",
				Formula: "(1 - seconds_down / seconds_in_period) * 100", Format: domain.FormatPercent2,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atService,
				Rule: domain.StatusRule{
					Type: domain.RuleBands,
					Bands: []domain.Band{
						{Status: "G", Op: ">=", Value: 99.9},
						{Status: "Y", Op: ">", Value: 99.8},
						{Status: "R"},
					},
					// The status page is held to a looser goal than the services behind it.
					PerSubject: []domain.SubjectBands{{SubjectID: "status-page", Bands: []domain.Band{
						{Status: "G", Op: ">=", Value: 99.5},
						{Status: "Y", Op: ">", Value: 99.0},
						{Status: "R"},
					}}},
				},
				Definition: "Share of the period a service was available.",
				Example:    "43 minutes of downtime in a 30-day month is 99.90%.",
				Source:     "Monitoring",
			},
			{
				Key: "security_training", Name: "Security training completion", CategoryID: "security",
				Formula: "trained_count / headcount * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(90, 70)},
				Definition: "People who completed the current security training, as a share of headcount at period end.",
				Source:     "Learning platform",
			},
			{
				Key: "customer_feedback_slo", Name: "Customer feedback SLO", CategoryID: "product",
				Formula: "idea_age_days_sum / idea_count", Format: domain.FormatDays0,
				Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: lowerBands(14, 17)},
				Definition: "Average age, in days, of customer ideas awaiting a response.",
				Notes:      "A month with no ideas is not applicable.",
				Source:     "Feedback portal",
			},
			{
				Key: "accessibility_compliance", Name: "Accessibility compliance", CategoryID: "design",
				Formula: "a11y_score / a11y_max * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyBiannual, ReportedAt: atProduct,
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
					{Status: "G", Op: ">=", Value: 80},
					{Status: "Y", Op: ">", Value: 60},
					{Status: "R"},
				}},
				Definition: "Audit score as a share of the maximum. Audited twice a year; does not roll up.",
				Source:     "Accessibility audit",
			},
			{
				Key: "open_source_risk_slo", Name: "Open-source risk SLO", CategoryID: "security",
				Formula: "oss_within_slo / oss_due * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atSegment,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(90, 80)},
				Definition: "Share of open-source risks due this period that were resolved within the policy SLO.",
				Source:     "Risk register",
			},
		},
	}
}

// --- data ------------------------------------------------------------------

// profile gives one product its own tendencies, so the demo shows a spread of
// outcomes rather than uniform noise.
type profile struct {
	id         string
	onTime     float64 // epics on-time rate
	budget     float64 // concepts within budget rate
	spendBias  float64 // actual / planned centre
	expected   float64 // expected-value delivery rate
	defects    float64 // defect points per day
	training   float64 // training completion at the start
	headcount  int
	age        float64 // average idea age in days
	accessible float64 // accessibility score out of 100
}

var profiles = []profile{
	{"identity", 0.95, 0.95, 1.00, 0.95, 1.6, 0.93, 62, 9, 91},
	{"messaging", 0.88, 0.85, 1.06, 0.88, 2.4, 0.84, 48, 13, 84},
	{"checkout", 0.84, 0.80, 1.12, 0.84, 3.1, 0.78, 55, 15, 76},
	{"billing", 0.78, 0.70, 1.18, 0.74, 3.8, 0.72, 41, 19, 64},
	{"analytics", 0.92, 0.90, 1.02, 0.91, 1.9, 0.90, 36, 11, 88},
	{"pipelines", 0.86, 0.82, 1.08, 0.82, 2.7, 0.80, 44, 16, 79},
	{"ios-app", 0.90, 0.88, 1.04, 0.90, 2.1, 0.87, 39, 10, 82},
	{"android-app", 0.74, 0.68, 1.15, 0.72, 3.5, 0.70, 46, 18, 69},
}

var sloRates = map[string]float64{"platform": 0.96, "payments": 0.86, "data": 0.74, "mobile": 0.68}

// generator accumulates data point writes.
type generator struct {
	r   *rand.Rand
	cal period.Calendar
	out []store.DataWrite
}

// at returns when a period's data was entered: late in its last month.
func (g *generator) at(p period.Period) time.Time {
	ms := g.cal.Months(p)
	return g.cal.Start(ms[len(ms)-1]).AddDate(0, 0, 27)
}

// put records an entered value. Values the records methodology derives are
// drawn (so the rest of the data does not move) but not written.
func (g *generator) put(measure, subject string, p period.Period, v float64) {
	if isDerived(measure, p) {
		return
	}
	g.out = append(g.out, g.write(measure, subject, p, &v, ""))
}

func (g *generator) na(measures []string, subject string, p period.Period, reason string) {
	for _, m := range measures {
		g.out = append(g.out, g.write(m, subject, p, nil, reason))
	}
}

func (g *generator) write(measure, subject string, p period.Period, v *float64, reason string) store.DataWrite {
	return store.DataWrite{
		Point: domain.DataPoint{
			MeasureKey: measure, SubjectID: subject, Period: p,
			Value: v, NAReason: reason,
			Source: domain.SourceImport, EnteredBy: Users[0].UserID, EnteredAt: g.at(p),
		},
		ExpectedRevision: store.MustNotExist,
	}
}

// between returns a uniform float in [lo, hi).
func (g *generator) between(lo, hi float64) float64 { return lo + g.r.Float64()*(hi-lo) }

func (g *generator) count(lo, hi int) int { return lo + g.r.IntN(hi-lo+1) }

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// share returns round(n * rate) with rate jittered by +-spread and kept in
// [0, 1], never above n.
func (g *generator) share(n int, rate, spread float64) float64 {
	return math.Round(float64(n) * clamp(rate+g.between(-spread, spread), 0, 1))
}

// months lists the fiscal months with data: 2025-M01 through 2026-M10.
func months() []period.Period {
	var out []period.Period
	for fy := 2025; fy <= 2026; fy++ {
		for i := 1; i <= 12; i++ {
			if fy == 2026 && i > 10 {
				break
			}
			out = append(out, month(fy, i))
		}
	}
	return out
}

func seedData(ctx context.Context, st store.Store, cal period.Calendar) error {
	g := &generator{r: rand.New(rand.NewPCG(rngSeed1, rngSeed2)), cal: cal}
	ms := months()

	for i, m := range ms {
		g.monthlyProducts(m, i)
		g.monthlyServices(m)
		g.monthlySegments(m)
	}
	// Quarterly metrics hold data at quarter grain, for complete quarters.
	for _, q := range []string{"2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"} {
		p, err := period.Parse(q)
		if err != nil {
			return err
		}
		g.quarterly(p)
	}
	// Biannual accessibility audits, entered at every unit because the
	// measures do not roll up the org tree.
	for _, h := range []string{"2025-H1", "2025-H2", "2026-H1"} {
		p, err := period.Parse(h)
		if err != nil {
			return err
		}
		g.biannual(p)
	}

	g.pin()

	if _, err := st.PutDataPoints(ctx, TenantID, ScorecardID, g.out); err != nil {
		return fmt.Errorf("demo: data points: %w", err)
	}
	return nil
}

func (g *generator) monthlyProducts(m period.Period, idx int) {
	days := float64(g.cal.Seconds(m) / 86400)
	for _, p := range profiles {
		// Epics on time.
		committed := g.count(4, 10)
		g.put("epics_committed", p.id, m, float64(committed))
		g.put("epics_on_time", p.id, m, g.share(committed, p.onTime, 0.12))

		// Concepts on budget, with one month where nothing qualified.
		if p.id == NotApplicable.SubjectID && m == NotApplicable.Period {
			g.na([]string{"concepts_measured", "concepts_within_budget"}, p.id, m, NotApplicable.Reason)
		} else {
			measured := g.count(3, 9)
			g.put("concepts_measured", p.id, m, float64(measured))
			g.put("concepts_within_budget", p.id, m, g.share(measured, p.budget, 0.15))
		}

		// Spend against plan.
		planned := math.Round(g.between(700, 2400))
		g.put("planned_spend_k", p.id, m, planned)
		g.put("actual_spend_k", p.id, m, math.Round(planned*clamp(p.spendBias+g.between(-0.07, 0.07), 0.8, 1.4)))

		// Weighted defect score: points per day, wandering around the
		// product's level.
		g.put("defect_points_sum", p.id, m, math.Round(days*p.defects*g.between(0.8, 1.2)*10)/10)
		g.put("defect_days", p.id, m, days)

		// Security training: completion creeps up over the 22 months.
		head := p.headcount + idx/3
		trained := math.Round(float64(head) * clamp(p.training+0.004*float64(idx)+g.between(-0.03, 0.03), 0, 1))
		g.put("headcount", p.id, m, float64(head))
		g.put("trained_count", p.id, m, trained)

		// Customer feedback: ideas awaiting a response, with one empty month.
		if p.id == ZeroOverZero.SubjectID && m == ZeroOverZero.Period {
			g.put("idea_age_days_sum", p.id, m, 0)
			g.put("idea_count", p.id, m, 0)
		} else {
			n := g.count(3, 10)
			g.put("idea_count", p.id, m, float64(n))
			g.put("idea_age_days_sum", p.id, m, math.Round(float64(n)*p.age*g.between(0.85, 1.15)))
		}
	}
}

// serviceDowntime is the typical minutes of downtime per month for each
// service; the actual figure is that scaled by a skewed random factor.
var serviceDowntime = map[string]float64{"public-api": 30, "web-app": 110, "status-page": 120}

func (g *generator) monthlyServices(m period.Period) {
	secs := float64(g.cal.Seconds(m))
	for _, s := range services {
		f := g.r.Float64()
		down := math.Round(serviceDowntime[s.id]*f*f) * 60
		g.put("seconds_down", s.id, m, down)
		g.put("seconds_in_period", s.id, m, secs)
	}
}

func (g *generator) monthlySegments(m period.Period) {
	for _, s := range segments {
		due := g.count(4, 14)
		g.put("oss_due", s.id, m, float64(due))
		g.put("oss_within_slo", s.id, m, g.share(due, sloRates[s.id], 0.12))
	}
}

func (g *generator) quarterly(q period.Period) {
	for _, p := range profiles {
		measured := g.count(6, 15)
		g.put("ev_measured", p.id, q, float64(measured))
		g.put("ev_delivered", p.id, q, g.share(measured, p.expected, 0.1))
	}
}

func (g *generator) biannual(h period.Period) {
	// Scores creep up between audits.
	gain := float64(h.FY-2025)*3 + float64(h.Index-1)*1.5
	score := map[string]float64{}
	bySegment := map[string][]float64{}
	var all []float64
	for _, p := range profiles {
		v := math.Round(clamp(p.accessible+gain+g.between(-3, 3), 0, 100))
		score[p.id] = v
		seg := productSegment(p.id)
		bySegment[seg] = append(bySegment[seg], v)
		all = append(all, v)
	}
	// Segment and company scores are audited directly, not rolled up.
	for _, s := range segments {
		score[s.id] = math.Round(mean(bySegment[s.id]))
	}
	score[companyID] = math.Round(mean(all))
	for _, id := range append(append([]string{companyID}, segmentIDs()...), productIDs()...) {
		g.put("a11y_score", id, h, score[id])
		g.put("a11y_max", id, h, 100)
	}
}

func mean(vs []float64) float64 {
	sum := 0.0
	for _, v := range vs {
		sum += v
	}
	return sum / float64(len(vs))
}

func segmentIDs() []string {
	out := make([]string, len(segments))
	for i, s := range segments {
		out[i] = s.id
	}
	return out
}

func productIDs() []string {
	out := make([]string, len(profiles))
	for i, p := range profiles {
		out[i] = p.id
	}
	return out
}

// productSegment returns the segment a product belonged to originally.
func productSegment(id string) string {
	for _, p := range products {
		if p.id == id {
			return p.segment
		}
	}
	return ""
}

// pin overwrites a few points so the demo has the cases it promises
// regardless of the random draw: a month that scores green under 2025
// thresholds and yellow under 2026 (85% on time: green at >=85, yellow at
// >=80 once the green line moves to 90).
func (g *generator) pin() {
	set := func(measure, subject string, p period.Period, v float64) {
		for i := range g.out {
			w := &g.out[i]
			if w.Point.MeasureKey == measure && w.Point.SubjectID == subject && w.Point.Period == p {
				x := v
				w.Point.Value = &x
				w.Point.NAReason = ""
				return
			}
		}
		panic("demo: pinned point not generated: " + measure + "/" + subject + "/" + p.String())
	}
	set("epics_committed", "checkout", month(2025, 6), 20)
	set("epics_on_time", "checkout", month(2025, 6), 17)
}

// --- records ---------------------------------------------------------------

// The tracker the demo records come from, and the first month they count.
const (
	trackerSource = "tracker"
	trackerURL    = "https://tracker.example.test/browse/"
)

var recordsFrom = month(2026, 7)

// defectWeights are the points a defect adds per open day, by priority.
var defectWeights = map[string]float64{"P1": 64, "P2": 16, "P3": 4, "P4": 2, domain.PriorityNone: 1}

func date(y int, m time.Month, d int) domain.Date {
	return domain.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC)}
}

// snapshotDates are the month ends the tracker was exported at, July through
// October 2026. The November exports in testdata are as of 2026-11-14.
var snapshotDates = []domain.Date{date(2026, 7, 31), date(2026, 8, 31), date(2026, 9, 30), date(2026, 10, 31)}

func recordTypes() []domain.RecordType {
	from := map[string]period.Period{trackerSource: recordsFrom}
	return []domain.RecordType{
		{
			ID: "defect", Name: "Defect", Priorities: []string{"P1", "P2", "P3", "P4"},
			Attributes:  []domain.AttributeDef{{Key: "customerTicket", Name: "Customer ticket", Type: domain.AttrBool}},
			TrackedFrom: from,
		},
		{ID: "epic", Name: "Epic", TrackedFrom: maps.Clone(from)},
	}
}

// keyPrefix is the tracker project key of each product's records.
var keyPrefix = map[string]string{
	"identity": "IDN", "messaging": "MSG", "checkout": "CHK", "billing": "BIL",
	"analytics": "ANL", "pipelines": "PIP", "ios-app": "IOS", "android-app": "AND",
}

var epicTitles = []string{
	"Saved payment methods", "Self-serve plan changes", "Audit log export", "Guided onboarding",
	"Bulk import tool", "Role-based dashboards", "Offline mode", "Usage alerts",
	"Search relevance tuning", "Scheduled reports", "Single sign-on options", "Retry controls",
}

var defectTitles = []string{
	"Total rounds incorrectly on large orders", "Form freezes after autocomplete", "Export file has duplicate rows",
	"Date picker ignores locale", "Notification sent twice", "Filter resets after sorting",
	"Image upload fails over 5 MB", "Timeout when saving settings", "Wrong currency symbol on receipts",
	"Back button loses draft", "Tooltip covers the submit button", "Pagination skips a page",
}

func productName(id string) string {
	for _, p := range products {
		if p.id == id {
			return p.name
		}
	}
	panic("demo: unknown product " + id)
}

// epicSpec is one synthetic epic. Its due date moves to newDue on slippedOn
// (zero when it never moves); completed is zero while it is open.
type epicSpec struct {
	key, product, title string
	created, due        domain.Date
	slippedOn, newDue   domain.Date
	completed           domain.Date
}

func (e epicSpec) fields(s domain.Date) (domain.RecordFields, bool) {
	if s.Time.Before(e.created.Time) {
		return domain.RecordFields{}, false
	}
	due := e.due
	if !e.slippedOn.IsZero() && !s.Time.Before(e.slippedOn.Time) {
		due = e.newDue
	}
	f := domain.RecordFields{
		SubjectKey: productName(e.product), Title: e.title, Status: "In Progress", URL: trackerURL + e.key,
		State: domain.StateOpen, CreatedAt: e.created, DueAt: &due,
	}
	if !e.completed.IsZero() && !e.completed.Time.After(s.Time) {
		done := e.completed
		f.State, f.Status, f.CompletedAt = domain.StateDone, "Done", &done
	}
	return f, true
}

// defectSpec is one synthetic defect. Priority "" is none. It moves to
// escalatedTo on escalatedOn when that is set.
type defectSpec struct {
	key, product, title, category, priority string
	customer                                bool
	created, completed                      domain.Date
	escalatedOn                             domain.Date
	escalatedTo                             string
}

func (d defectSpec) fields(s domain.Date) (domain.RecordFields, bool) {
	if s.Time.Before(d.created.Time) {
		return domain.RecordFields{}, false
	}
	pri := d.priority
	if !d.escalatedOn.IsZero() && !s.Time.Before(d.escalatedOn.Time) {
		pri = d.escalatedTo
	}
	f := domain.RecordFields{
		SubjectKey: productName(d.product), Title: d.title, Category: d.category, Priority: pri,
		Status: "Open", URL: trackerURL + d.key, State: domain.StateOpen, CreatedAt: d.created,
		Attributes: map[string]any{"customerTicket": d.customer},
	}
	if !d.completed.IsZero() && !d.completed.Time.After(s.Time) {
		done := d.completed
		f.State, f.Status, f.CompletedAt = domain.StateDone, "Done", &done
	}
	return f, true
}

// batch is what one snapshot stores: its revisions and the counts the upload
// would have reported.
type batch struct {
	revs   []store.RecordRevisionWrite
	counts map[string]int
}

// recordsBuilder generates the synthetic records with its own random stream,
// so the entered data does not depend on it.
type recordsBuilder struct {
	r       *rand.Rand
	used    map[string]bool
	next    map[string]int
	batches map[string][]batch // by record type, one per snapshot date
}

func newRecordsBuilder() *recordsBuilder {
	b := &recordsBuilder{
		r: rand.New(rand.NewPCG(rngSeed1, rngSeed2^0x7265)), used: map[string]bool{}, next: map[string]int{},
		batches: map[string][]batch{},
	}
	for _, typ := range []string{"epic", "defect"} {
		bs := make([]batch, len(snapshotDates))
		for i := range bs {
			bs[i].counts = map[string]int{"new": 0, "changed": 0, "unchanged": 0, "skipped": 0, "missing": 0, "unmatched": 0, "errors": 0}
		}
		b.batches[typ] = bs
	}
	return b
}

func snapshotID(typ string, s domain.Date) string { return "snap-" + typ + "-" + s.String() }

func (b *recordsBuilder) count(lo, hi int) int { return lo + b.r.IntN(hi-lo+1) }

func pick(b *recordsBuilder, from []string) string { return from[b.r.IntN(len(from))] }

// key returns the next tracker key for a product's project.
func (b *recordsBuilder) key(product string) string {
	for {
		b.next[product]++
		k := fmt.Sprintf("%s-%d", keyPrefix[product], 100+b.next[product])
		if !b.used[k] {
			b.used[k] = true
			return k
		}
	}
}

// reserve claims a hand-written key and panics if it is taken.
func (b *recordsBuilder) reserve(key string) {
	if b.used[key] {
		panic("demo: duplicate record key " + key)
	}
	b.used[key] = true
}

// add stores a record's revisions: one at each snapshot where it first
// appears or where its fields differ from the previous snapshot.
func (b *recordsBuilder) add(typ, key string, fieldsAt func(domain.Date) (domain.RecordFields, bool)) {
	var prev []byte
	for i, s := range snapshotDates {
		f, ok := fieldsAt(s)
		if !ok {
			continue
		}
		cur, err := json.Marshal(f)
		if err != nil {
			panic(err)
		}
		bt := &b.batches[typ][i]
		switch {
		case prev == nil:
			bt.counts["new"]++
		case bytes.Equal(prev, cur):
			bt.counts["unchanged"]++
			continue
		default:
			bt.counts["changed"]++
		}
		prev = cur
		bt.revs = append(bt.revs, store.RecordRevisionWrite{
			Source: trackerSource, ExternalID: key, Type: typ,
			Rev: domain.RecordRevision{AsOf: s, SnapshotID: snapshotID(typ, s), Fields: f},
		})
	}
}

func (b *recordsBuilder) addEpic(e epicSpec)     { b.add("epic", e.key, e.fields) }
func (b *recordsBuilder) addDefect(d defectSpec) { b.add("defect", d.key, d.fields) }

// generate draws each product's epics and defects for July through October
// and adds the hand-written ones the November exports refer to.
func (b *recordsBuilder) generate() {
	for _, p := range profiles {
		for mo := time.July; mo <= time.October; mo++ {
			for range b.count(3, 6) {
				b.addEpic(b.epic(p, mo))
			}
		}
		b.addDefect(b.backlogDefect(p))
		for mo := time.July; mo <= time.October; mo++ {
			for range max(1, int(math.Round(p.defects*0.4))) + b.count(0, 1) {
				b.addDefect(b.defect(p, mo))
			}
		}
	}
	for _, e := range pinnedEpics() {
		b.reserve(e.key)
		b.addEpic(e)
	}
	for _, d := range pinnedDefects() {
		b.reserve(d.key)
		b.addDefect(d)
	}
}

// epic draws an epic due in month mo of 2026. Most land on time at the
// product's rate; the rest slip to a later date (from August, when a
// snapshot has seen the original date), finish late, or are still open.
func (b *recordsBuilder) epic(p profile, mo time.Month) epicSpec {
	first := date(2026, mo, 1)
	e := epicSpec{key: b.key(p.id), product: p.id, title: pick(b, epicTitles), created: first.AddDays(-b.count(45, 120))}
	roll, miss := b.r.Float64(), b.r.Float64()
	switch {
	case roll < p.onTime:
		e.due = first.AddDays(b.count(0, 27))
		e.completed = e.due.AddDays(-b.count(0, 10))
	case mo > time.July && miss < 0.45:
		// The date moves after the previous month-end snapshot has seen it.
		e.due = first.AddDays(b.count(7, 27))
		e.slippedOn = e.due.AddDays(-b.count(2, 7))
		e.newDue = e.due.AddDays(b.count(14, 45))
		if b.r.Float64() < 0.6 {
			e.completed = e.newDue.AddDays(-b.count(0, 6))
		}
	case miss < 0.75:
		e.due = first.AddDays(b.count(0, 27))
		e.completed = e.due.AddDays(b.count(3, 20))
	default:
		e.due = first.AddDays(b.count(0, 27))
	}
	return e
}

// priority draws a defect priority: mostly P3 and P4, rarely P2, and some with
// none. P1 is left to the hand-written ones.
func (b *recordsBuilder) priority() string {
	switch roll := b.r.Float64(); {
	case roll < 0.06:
		return "P2"
	case roll < 0.40:
		return "P3"
	case roll < 0.75:
		return "P4"
	}
	return ""
}

func (b *recordsBuilder) category() string {
	if b.r.IntN(3) == 0 {
		return "defect"
	}
	return "bug"
}

// backlogDefect is a defect already open on 2026-07-01 that closes in July.
func (b *recordsBuilder) backlogDefect(p profile) defectSpec {
	created := date(2026, time.June, 1).AddDays(b.count(9, 27))
	return defectSpec{
		key: b.key(p.id), product: p.id, title: pick(b, defectTitles), category: b.category(), priority: b.priority(),
		customer: b.r.IntN(3) == 0, created: created, completed: date(2026, time.July, 1).AddDays(b.count(4, 24)),
	}
}

// defect draws a defect created in month mo. Most close within about two
// weeks; a few linger. Those still open at the last snapshot stay open.
func (b *recordsBuilder) defect(p profile, mo time.Month) defectSpec {
	created := date(2026, mo, 1).AddDays(b.count(0, 27))
	open := b.count(3, 16)
	if b.r.Float64() < 0.08 {
		open = b.count(35, 70)
	}
	return defectSpec{
		key: b.key(p.id), product: p.id, title: pick(b, defectTitles), category: b.category(), priority: b.priority(),
		customer: b.r.IntN(3) == 0, created: created, completed: created.AddDays(open),
	}
}

// pinnedEpics are the epics the November export updates: three Checkout epics
// due in early November (which the export moves later), one Billing epic that
// then finishes, and one Analytics epic that stays as it is.
func pinnedEpics() []epicSpec {
	return []epicSpec{
		{key: "CHK-241", product: "checkout", title: "Saved wallet checkout", created: date(2026, time.August, 10), due: date(2026, time.November, 6)},
		{key: "CHK-243", product: "checkout", title: "Partial refunds", created: date(2026, time.August, 24), due: date(2026, time.November, 10)},
		{key: "CHK-247", product: "checkout", title: "Multi-currency totals", created: date(2026, time.September, 8), due: date(2026, time.November, 13)},
		{key: "BIL-231", product: "billing", title: "Usage-based invoicing", created: date(2026, time.August, 17), due: date(2026, time.November, 12)},
		{key: "ANL-228", product: "analytics", title: "Saved report schedules", created: date(2026, time.September, 1), due: date(2026, time.November, 20)},
	}
}

// pinnedDefects are the open defects the November export updates: one
// escalates, one closes, one is unchanged.
func pinnedDefects() []defectSpec {
	return []defectSpec{
		{key: "PAY-880", product: "checkout", title: "Refund email is sent twice", category: "bug", priority: "P3", created: date(2026, time.October, 14)},
		{key: "BIL-871", product: "billing", title: "Proration rounds up a day", category: "defect", priority: "P3", customer: true, created: date(2026, time.October, 6)},
		{key: "IOS-340", product: "ios-app", title: "Wallet button hidden on small screens", category: "bug", priority: "P4", created: date(2026, time.September, 21)},
	}
}

// seedRecords stores the record types and one snapshot per type per month
// end, with the revisions each snapshot first saw or changed.
func seedRecords(ctx context.Context, st store.Store) error {
	for _, rt := range recordTypes() {
		if err := st.PutRecordType(ctx, TenantID, rt, 0); err != nil {
			return fmt.Errorf("demo: record type %s: %w", rt.ID, err)
		}
	}
	b := newRecordsBuilder()
	b.generate()
	for _, typ := range []string{"epic", "defect"} {
		for i, s := range snapshotDates {
			bt := b.batches[typ][i]
			sn := domain.Snapshot{
				ID: snapshotID(typ, s), RecordType: typ, Source: trackerSource, AsOf: s,
				FileName:  fmt.Sprintf("acme_%ss_%s.csv", typ, s),
				CreatedBy: Users[0].UserID, CreatedAt: s.Time.Add(17 * time.Hour), Counts: bt.counts,
			}
			if err := st.ApplySnapshot(ctx, TenantID, sn, bt.revs); err != nil {
				return fmt.Errorf("demo: %s snapshot %s: %w", typ, s, err)
			}
		}
	}
	return nil
}

// seedDerived writes the values the records give the derived measures, as an
// import would have left them.
func seedDerived(ctx context.Context, st store.Store, tenant domain.Tenant) error {
	writes, err := recordimport.Recalculate(ctx, st, tenant, ScorecardID, func(period.Period) bool { return false }, nil)
	if err != nil {
		return fmt.Errorf("demo: derive from records: %w", err)
	}
	for i := range writes {
		writes[i].Point.EnteredBy, writes[i].Point.EnteredAt = Users[0].UserID, derivedAt
	}
	if len(writes) == 0 {
		return nil
	}
	if _, err := st.PutDataPoints(ctx, TenantID, ScorecardID, writes); err != nil {
		return fmt.Errorf("demo: derived data points: %w", err)
	}
	return nil
}
