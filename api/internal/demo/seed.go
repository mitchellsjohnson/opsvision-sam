// Package demo seeds the fictional "Acme Demo" tenant: an org tree with a
// reorg, 24 tracked services and 21 regional deployments, a scorecard with four published methodology
// versions, 24 months of deterministic synthetic data (2024-M11 through
// 2026-M10), and, from 2026-M07, synthetic tracker records (epics and
// defects, with monthly snapshots) that the latest version derives four
// measures from, plus one incident export (as of 2026-11-01) that explains
// part of October's uptime, and company exec summaries for September and
// October (October with some stale and missing). The proof of concept, the
// web app's development, and the end-to-end tests all run against it.
//
// The data exercises every chart kind at realistic density: ratio, line
// (a lower-is-better score in the hundreds), change, days, discrete
// (quarterly and biannual), money plan, uptime across 24 services with
// mid-window onboarding and gaps, deployment uptime in the shape real
// tenants show (long names, fewer than half reporting this month, many with
// no reports in the last year), a sparse metric that is mostly not
// applicable, a metric whose company total is not reported (so the chart
// draws one line per segment), and metrics that are not reported at all.
//
// Everything here is invented. No real company, product, or person appears.
package demo

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"slices"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/recordimport"
	"opsvision/internal/records"
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

// NotReported lists the metrics with no value in the latest month, on
// purpose: one has never been reported, the other stopped after 2026-M07.
var NotReported = []string{"design_review_coverage", "roadmap_evidence"}

// NoCompanyTotal is the metric reported per segment whose measures do not
// roll up, so the company row has no value and charts draw a line per
// segment instead.
const NoCompanyTotal = "customer_satisfaction"

// SparseMetric is the company-level metric that is not applicable in most
// months (no incident needed a postmortem), so it charts as lettered results.
const SparseMetric = "postmortems_on_time"

// AttributionCell names one cell of the demo scorecard.
type AttributionCell struct {
	MetricKey string
	SubjectID string
	Period    period.Period
}

// AttributionExamples are the cells of 2026-M10 whose incidents the demo
// explains: Webhooks' uptime (three incidents, two overlapping, and minutes
// no incident explains), Search's (a fan-out incident; the planned failover
// is filtered out), Analytics Ingest's (incidents add up to more than it
// reports) and a deployment's (an incident from September and one at partial
// impact). Treat it as read-only.
var AttributionExamples = []AttributionCell{
	{MetricKey: "uptime", SubjectID: "webhooks", Period: latestMonth},
	{MetricKey: "uptime", SubjectID: "search", Period: latestMonth},
	{MetricKey: "uptime", SubjectID: "analytics-ingest", Period: latestMonth},
	{MetricKey: "deployment_uptime", SubjectID: "dep-notify-multi", Period: latestMonth},
}

// SummaryCell names one metric's exec summary: the metric and the period it
// belongs to (the month, or a coarse metric's quarter, half or year).
type SummaryCell struct {
	MetricKey string
	Period    period.Period
}

// The exec summaries of 2026-M10, each set in methodology order. Every
// metric required that month is in exactly one set. Treat them as read-only.
var (
	// SummaryWritten have a summary written against the company standing as
	// it is.
	SummaryWritten = []SummaryCell{
		{MetricKey: "epics_on_time", Period: latestMonth},
		{MetricKey: "concepts_on_budget", Period: latestMonth},
		{MetricKey: "weighted_defect_score", Period: latestMonth},
		{MetricKey: "uptime", Period: latestMonth},
		{MetricKey: "postmortems_on_time", Period: latestMonth},
		{MetricKey: "customer_satisfaction", Period: latestMonth},
		{MetricKey: "open_source_risk_slo", Period: latestMonth},
	}
	// SummaryStale has a summary written when the company value was lower,
	// so it reads stale.
	SummaryStale = []SummaryCell{
		{MetricKey: "spend_vs_plan", Period: latestMonth},
	}
	// SummaryMissing are required and have no summary, so 2026-M10 cannot be
	// published until an admin writes them. Security training is Green
	// below 100%.
	SummaryMissing = []SummaryCell{
		{MetricKey: "support_backlog", Period: latestMonth},
		{MetricKey: "deployment_uptime", Period: latestMonth},
		{MetricKey: "security_training", Period: latestMonth},
	}
)

// SummarySeptember are the summaries of every metric required to publish
// 2026-M09, in methodology order, so the demo has a month that publishes.
// The quarterly metric's belongs to the quarter September closes. Treat it
// as read-only.
var SummarySeptember = []SummaryCell{
	{MetricKey: "epics_on_time", Period: month(2026, 9)},
	{MetricKey: "concepts_on_budget", Period: month(2026, 9)},
	{MetricKey: "spend_vs_plan", Period: month(2026, 9)},
	{MetricKey: "concepts_expected_value", Period: period.Period{Grain: period.Quarter, FY: 2026, Index: 3}},
	{MetricKey: "weighted_defect_score", Period: month(2026, 9)},
	{MetricKey: "support_backlog", Period: month(2026, 9)},
	{MetricKey: "uptime", Period: month(2026, 9)},
	{MetricKey: "deployment_uptime", Period: month(2026, 9)},
	{MetricKey: "security_training", Period: month(2026, 9)},
	{MetricKey: "customer_satisfaction", Period: month(2026, 9)},
	{MetricKey: "open_source_risk_slo", Period: month(2026, 9)},
}

// Fixed instants keep the seed reproducible.
var (
	tenantCreated = time.Date(2024, time.October, 1, 0, 0, 0, 0, time.UTC)
	published2024 = time.Date(2023, time.December, 15, 0, 0, 0, 0, time.UTC)
	published2025 = time.Date(2024, time.December, 15, 0, 0, 0, 0, time.UTC)
	published2026 = time.Date(2025, time.December, 15, 0, 0, 0, 0, time.UTC)
	// published2026v2 is when the records-derived methodology was published.
	published2026v2 = time.Date(2026, time.June, 15, 0, 0, 0, 0, time.UTC)
	// derivedAt is when the derived values were last calculated: the day
	// after the latest snapshot.
	derivedAt = time.Date(2026, time.November, 1, 9, 0, 0, 0, time.UTC)
)

// rngSeed fixes the synthetic data. rngSeedWide seeds a second stream for
// the data added later (the first two months of the window, the services
// beyond the first three, and the newer metrics), so the original stream's
// values do not move.
// rngSeedDeploy seeds the deployments' stream, drawn last for the same reason.
const (
	rngSeed1      = 0x0b5c0de
	rngSeed2      = 0x2026
	rngSeedWide   = 0x5ca1e
	rngSeedDeploy = 0xde910
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
	if err := seedIncidents(ctx, st, tenant); err != nil {
		return "", err
	}
	if err := seedSummaries(ctx, st); err != nil {
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

// serviceSpec is one tracked service and how its uptime behaves. It reports
// from `from` (the window start when zero) through `until` (the latest month
// when zero), except in `gaps`; `outages` are months with a long outage.
// `latest` pins the minutes down in the latest month (nil draws as usual).
// Deployments also have `degraded` months (Yellow) and may be `silent`: no
// reports anywhere in the window.
type serviceSpec struct {
	id, name, segment string
	downtime          float64 // typical minutes down a month
	from, until       period.Period
	gaps, outages     []period.Period
	degraded          []period.Period
	latest            *float64
	silent            bool
}

func minutes(v float64) *float64 { return &v }

// services are the tracked services. The first three are drawn from the
// original stream (see monthlyServices); the rest from the wide one. In the
// latest month 18 are green (four at 100.00%), two yellow, one red, and three
// not reported.
var services = []serviceSpec{
	{id: "public-api", name: "Public API", segment: "platform"},
	{id: "web-app", name: "Web App", segment: "platform"},
	{id: "status-page", name: "Status Page", segment: "platform"},
	{id: "checkout-api", name: "Checkout API", segment: "payments", downtime: 12, latest: minutes(0)},
	{id: "billing-worker", name: "Billing Worker", segment: "payments", downtime: 25},
	{id: "payments-gateway", name: "Payments Gateway", segment: "payments", downtime: 8, latest: minutes(0)},
	{id: "ledger", name: "Ledger", segment: "payments", downtime: 15, from: month(2025, 6)},
	{id: "inventory-api", name: "Inventory API", segment: "payments", downtime: 14, from: month(2025, 9)},
	{id: "pricing-engine", name: "Pricing Engine", segment: "payments", downtime: 16, until: month(2026, 8)},
	{id: "search", name: "Search", segment: "platform", downtime: 35, latest: minutes(60)},
	{id: "auth-service", name: "Auth Service", segment: "platform", downtime: 5, latest: minutes(0)},
	{id: "notifications", name: "Notifications", segment: "platform", downtime: 40},
	{
		id: "webhooks", name: "Webhooks", segment: "platform", downtime: 50, from: month(2025, 3),
		outages: []period.Period{month(2025, 7), month(2025, 8), month(2026, 3)}, latest: minutes(420),
	},
	{id: "feature-flags", name: "Feature Flags", segment: "platform", downtime: 10, from: month(2026, 2)},
	{id: "email-relay", name: "Email Relay", segment: "platform", downtime: 30, gaps: []period.Period{month(2025, 8), month(2025, 9)}},
	{
		id: "admin-console", name: "Admin Console", segment: "platform", downtime: 30,
		gaps: []period.Period{month(2025, 1), month(2025, 3), month(2025, 5), month(2025, 7), month(2025, 9), month(2025, 11)},
	},
	{id: "audit-log", name: "Audit Log", segment: "platform", downtime: 4, from: month(2026, 7)},
	{id: "reporting", name: "Reporting", segment: "data", downtime: 45, until: month(2026, 9)},
	{id: "analytics-ingest", name: "Analytics Ingest", segment: "data", downtime: 55, from: month(2025, 1), latest: minutes(75)},
	{id: "data-export", name: "Data Export", segment: "data", downtime: 20, from: month(2026, 5)},
	{id: "scheduler", name: "Scheduler", segment: "data", downtime: 18, gaps: []period.Period{month(2025, 12), month(2026, 1), month(2026, 2)}},
	{id: "mobile-backend", name: "Mobile Backend", segment: "mobile", downtime: 22},
	{id: "media-cdn", name: "Media CDN", segment: "mobile", downtime: 6, latest: minutes(0)},
	{id: "push-gateway", name: "Push Gateway", segment: "mobile", downtime: 28, from: month(2025, 10), until: month(2026, 9)},
}

// deployments are the regional deployments behind Deployment uptime, in the
// shape real tenants show: long names, and in the latest month only nine
// reporting (eight green, one red) and twelve not reported, eight of them
// with no reports in the last twelve months. Several were onboarded inside
// the window. Their statuses are fixed (see deploymentFleet).
var deployments = []serviceSpec{
	{
		id: "dep-notify-multi", name: "Notification Relay - Multi-Region Active", segment: "platform", downtime: 18, from: month(2025, 9),
		degraded: []period.Period{month(2026, 1), month(2026, 2), month(2026, 3), month(2026, 4)}, latest: minutes(165),
	},
	{id: "dep-pay-eu", name: "Payments Gateway - EU Region Primary", segment: "payments", downtime: 8},
	{id: "dep-pay-us", name: "Payments Gateway - US Region Primary", segment: "payments", downtime: 10, outages: []period.Period{month(2026, 7)}},
	{
		id: "dep-portal-cloud", name: "Customer Portal - Private Cloud Tenant Suite", segment: "platform", downtime: 12,
		outages: []period.Period{month(2026, 1), month(2026, 2), month(2026, 3)},
	},
	{
		id: "dep-identity-east", name: "Identity Service - Production East", segment: "platform", downtime: 6, from: month(2026, 1),
		degraded: []period.Period{month(2026, 2)}, outages: []period.Period{month(2026, 6)},
	},
	{id: "dep-identity-west", name: "Identity Service - Staging Mirror West", segment: "platform", downtime: 9, from: month(2026, 8)},
	{id: "dep-search-a1", name: "Search Indexer - Production Cluster A-1", segment: "data", downtime: 14, from: month(2026, 8), outages: []period.Period{month(2026, 9)}},
	{id: "dep-search-a2", name: "Search Indexer - Production Cluster A-2", segment: "data", downtime: 11, from: month(2026, 9)},
	{id: "dep-ledger", name: "Ledger API", segment: "payments", downtime: 5, from: month(2026, 9)},
	{id: "dep-webhooks-us", name: "Webhook Dispatcher - US Region Primary", segment: "platform", downtime: 20, from: month(2025, 4), until: month(2026, 9)},
	{
		id: "dep-renderer", name: "Document Renderer - Shared Worker Pool", segment: "data", downtime: 16, from: month(2026, 4), until: month(2026, 8),
		gaps: []period.Period{month(2026, 6)},
	},
	{id: "dep-identity-dr", name: "Identity Service - Disaster Recovery Standby", segment: "platform", downtime: 3, until: month(2026, 6)},
	{
		id: "dep-search-legacy", name: "Search Indexer - Legacy Cluster B", segment: "data", downtime: 30, until: month(2025, 12),
		outages: []period.Period{month(2025, 10), month(2025, 11), month(2025, 12)},
	},
	{id: "dep-partner-sandbox", name: "Partner API Gateway - Sandbox Environment", segment: "payments", downtime: 25, until: month(2025, 9)},
	{id: "dep-warehouse-primary", name: "Analytics Warehouse - Batch Loader Primary", segment: "data", silent: true},
	{id: "dep-warehouse-replica", name: "Analytics Warehouse - Batch Loader Replica", segment: "data", silent: true},
	{id: "dep-push-apac", name: "Mobile Push Delivery - APAC Region Primary", segment: "mobile", silent: true},
	{id: "dep-push-eu", name: "Mobile Push Delivery - EU Region Secondary", segment: "mobile", silent: true},
	{id: "dep-export-jobs", name: "Data Export Service - Scheduled Jobs Runner", segment: "data", silent: true},
	{id: "dep-billing-recon", name: "Billing Reconciliation - Nightly Batch Worker", segment: "payments", silent: true},
	{id: "dep-edge-cache", name: "Edge Cache", segment: "mobile", silent: true},
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
	if err := st.PutItemKind(ctx, TenantID, domain.ItemKind{ID: "deployments", Name: "Deployments"}); err != nil {
		return fmt.Errorf("demo: item kind: %w", err)
	}
	for _, k := range []struct {
		kind  string
		specs []serviceSpec
	}{{"services", services}, {"deployments", deployments}} {
		for _, s := range k.specs {
			if err := st.PutTrackedItem(ctx, TenantID, domain.TrackedItem{
				ID: s.id, KindID: k.kind, Name: s.name, OrgUnitID: s.segment, SourceKeys: []string{s.name},
			}); err != nil {
				return fmt.Errorf("demo: tracked item %s: %w", s.id, err)
			}
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
		version("v2024", "2024 v1.0", 2024, published2024, 85),
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
	atDeployment := []domain.Subject{{Kind: domain.SubjectItemKind, ID: "deployments"}}
	atCompany := []domain.Subject{{Kind: domain.SubjectLevel, ID: "company"}}
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
			// Each product's backlog is scored on its own scale, so the company
			// figure is their average rather than their sum.
			{Key: "support_points", Name: "Weighted support backlog", Unit: "points", OrgAgg: domain.AggAverage, TimeAgg: domain.AggLatest},
			// Survey results are weighted per segment and do not roll up.
			{Key: "csat_positive", Name: "Positive survey responses", Unit: "count", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			{Key: "csat_responses", Name: "Survey responses", Unit: "count", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			{Key: "postmortems_on_time", Name: "Postmortems published on time", Unit: "count", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			{Key: "postmortems_due", Name: "Postmortems due", Unit: "count", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			{Key: "design_reviewed", Name: "Features with a design review", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "design_shipped", Name: "Features shipped", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "roadmap_evidenced", Name: "Roadmap items with customer evidence", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "roadmap_items", Name: "Roadmap items", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
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
				ChartKind:  "money_plan",
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
				Key: "support_backlog", Name: "Weighted support backlog", CategoryID: "quality",
				Formula: "support_points", Format: domain.FormatNumber0,
				Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: lowerBands(450, 600)},
				Definition: "Open support cases at month end, weighted by severity and age. Lower is better.",
				Example:    "Two week-old severity 1 cases at 64 points each and forty minor ones at 4 is 288.",
				Source:     "Support desk",
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
				Key: "deployment_uptime", Name: "Deployment uptime", CategoryID: "engineering",
				Formula: "(1 - seconds_down / seconds_in_period) * 100", Format: domain.FormatPercent2,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atDeployment,
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
					{Status: "G", Op: ">=", Value: 99.9},
					{Status: "Y", Op: ">", Value: 99.8},
					{Status: "R"},
				}},
				Definition: "Share of the month each regional deployment was available, from synthetic checks. A deployment reports once its check is connected.",
				Example:    "165 minutes of downtime in a 31-day month is 99.63%.",
				Source:     "Synthetic checks",
			},
			{
				Key: "postmortems_on_time", Name: "Incident postmortems on time", CategoryID: "engineering",
				Formula: "postmortems_on_time / postmortems_due * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atCompany,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(90, 75)},
				Definition: "Share of major incidents whose postmortem was published within five working days.",
				Notes:      "A month with no major incident is not applicable.",
				Source:     "Incident log",
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
				Key: "customer_satisfaction", Name: "Customer satisfaction", CategoryID: "product",
				Formula: "csat_positive / csat_responses * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atSegment,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(85, 75)},
				Definition: "Share of survey responses rating the product 4 or 5 out of 5. Each segment runs its own survey, so there is no company total.",
				Source:     "Customer survey",
			},
			{
				Key: "roadmap_evidence", Name: "Roadmap items with customer evidence", CategoryID: "product",
				Formula: "roadmap_evidenced / roadmap_items * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(75, 60)},
				Definition: "Share of committed roadmap items backed by at least one linked customer request.",
				Source:     "Roadmap tool",
			},
			{
				Key: "design_review_coverage", Name: "Design review coverage", CategoryID: "design",
				Formula: "design_reviewed / design_shipped * 100", Format: domain.FormatPercent0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly, ReportedAt: atProduct,
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: bands(90, 75)},
				Definition: "Share of shipped features that had a design review before build.",
				Source:     "Design tracker",
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

// latestMonth is the last month with entered data.
var latestMonth = month(2026, 10)

// earlyMonths are the window's first two months, drawn from the wide stream.
var earlyMonths = []period.Period{month(2024, 11), month(2024, 12)}

// window lists every month with data: 2024-M11 through 2026-M10.
func window() []period.Period { return append(slices.Clone(earlyMonths), months()...) }

// months lists the months the original stream draws: 2025-M01 through 2026-M10.
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

	// Everything below draws from its own stream, so the values above stay put.
	g.r = rand.New(rand.NewPCG(rngSeedWide, rngSeed2))
	for i, m := range earlyMonths {
		g.monthlyProducts(m, i-len(earlyMonths))
		g.monthlyServices(m)
		g.monthlySegments(m)
	}
	q4, h2 := period.Period{Grain: period.Quarter, FY: 2024, Index: 4}, period.Period{Grain: period.Half, FY: 2024, Index: 2}
	g.quarterly(q4)
	g.biannual(h2)
	ws := window()
	g.fleet(ws)
	for i, m := range ws {
		g.supportBacklog(m, i)
		g.satisfaction(m)
		g.postmortems(m)
		g.roadmapEvidence(m)
	}
	g.r = rand.New(rand.NewPCG(rngSeedDeploy, rngSeed2))
	g.deploymentFleet(ws)

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

// monthlyServices draws the first three services, the ones in serviceDowntime.
func (g *generator) monthlyServices(m period.Period) {
	secs := float64(g.cal.Seconds(m))
	for _, s := range services[:len(serviceDowntime)] {
		f := g.r.Float64()
		down := math.Round(serviceDowntime[s.id]*f*f) * 60
		g.put("seconds_down", s.id, m, down)
		g.put("seconds_in_period", s.id, m, secs)
	}
}

// before reports whether month a comes before month b.
func before(a, b period.Period) bool {
	return a.FY < b.FY || (a.FY == b.FY && a.Index < b.Index)
}

func reports(s serviceSpec, m period.Period) bool {
	if (s.from != period.Period{}) && before(m, s.from) {
		return false
	}
	if (s.until != period.Period{}) && before(s.until, m) {
		return false
	}
	return !slices.Contains(s.gaps, m)
}

// fleet draws the services after the first three over the window: usually a
// skewed share of their typical downtime, now and then an incident, a long
// outage in their `outages` months, and the pinned figure in the latest
// month. The latest month never draws an incident, so its mix is fixed.
func (g *generator) fleet(ws []period.Period) {
	for _, s := range services[len(serviceDowntime):] {
		for _, m := range ws {
			if !reports(s, m) {
				continue
			}
			f := g.r.Float64()
			down := math.Round(s.downtime * f * f)
			switch {
			case m == latestMonth && s.latest != nil:
				down = *s.latest
			case m == latestMonth:
				down = math.Round(math.Min(s.downtime, 40) * f * f)
			case slices.Contains(s.outages, m):
				down = math.Round(g.between(150, 480))
			case g.r.Float64() < 0.03:
				down = math.Round(g.between(95, 300))
			}
			g.put("seconds_down", s.id, m, down*60)
			g.put("seconds_in_period", s.id, m, float64(g.cal.Seconds(m)))
		}
	}
}

// deploymentFleet draws the deployments over the window: a skewed share of
// their typical downtime (at most 30 minutes, always Green), 50 to 78 minutes
// in `degraded` months (Yellow even in February), a long outage in `outages`
// months, and the pinned figure in the latest month. Unlike the services they
// never draw a random incident, so every month's status is fixed.
func (g *generator) deploymentFleet(ws []period.Period) {
	for _, s := range deployments {
		if s.silent {
			continue
		}
		for _, m := range ws {
			if !reports(s, m) {
				continue
			}
			f := g.r.Float64()
			down := math.Round(s.downtime * f * f)
			switch {
			case m == latestMonth && s.latest != nil:
				down = *s.latest
			case slices.Contains(s.outages, m):
				down = math.Round(g.between(150, 480))
			case slices.Contains(s.degraded, m):
				down = math.Round(g.between(50, 78))
			}
			g.put("seconds_down", s.id, m, down*60)
			g.put("seconds_in_period", s.id, m, float64(g.cal.Seconds(m)))
		}
	}
}

// supportBacklog wanders around each product's level with a slow seasonal
// swing and drifts worse over the window, so the company average crosses
// from green into yellow.
func (g *generator) supportBacklog(m period.Period, idx int) {
	for _, p := range profiles {
		base := 180 * p.defects * (1 + 0.12*math.Sin(float64(idx)/3) + 0.011*float64(idx))
		g.put("support_points", p.id, m, math.Round(base*g.between(0.9, 1.1)))
	}
}

// satisfactionRates is each segment's share of positive survey responses.
// Mobile starts surveying in 2025-M06.
var satisfactionRates = map[string]float64{"platform": 0.9, "payments": 0.83, "data": 0.78, "mobile": 0.72}

func (g *generator) satisfaction(m period.Period) {
	for _, s := range segments {
		if s.id == "mobile" && before(m, month(2025, 6)) {
			continue
		}
		n := g.count(80, 220)
		g.put("csat_responses", s.id, m, float64(n))
		g.put("csat_positive", s.id, m, g.share(n, satisfactionRates[s.id], 0.05))
	}
}

// postmortemMonths are the months with a major incident; every other month
// is not applicable. Five of the latest twelve have one, so the metric is
// sparse over the default window.
var postmortemMonths = []period.Period{
	month(2024, 11), month(2025, 1), month(2025, 2), month(2025, 4), month(2025, 6), month(2025, 7),
	month(2025, 9), month(2025, 10), month(2025, 12), month(2026, 3), month(2026, 6), month(2026, 8), latestMonth,
}

const noIncident = "No major incident needed a postmortem this month"

func (g *generator) postmortems(m period.Period) {
	measures := []string{"postmortems_on_time", "postmortems_due"}
	if !slices.Contains(postmortemMonths, m) {
		g.na(measures, companyID, m, noIncident)
		return
	}
	due := g.count(1, 5)
	onTime := g.share(due, 0.85, 0.2)
	if m == latestMonth {
		due, onTime = 5, 4
	}
	g.put("postmortems_due", companyID, m, float64(due))
	g.put("postmortems_on_time", companyID, m, onTime)
}

// roadmapEvidence is reported until 2026-M07 and then stops, so it has
// history but nothing for the latest months.
func (g *generator) roadmapEvidence(m period.Period) {
	if before(month(2026, 7), m) {
		return
	}
	for _, p := range profiles {
		n := g.count(5, 14)
		g.put("roadmap_items", p.id, m, float64(n))
		g.put("roadmap_evidenced", p.id, m, g.share(n, 0.55+0.25*p.expected, 0.12))
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
	// The web app is green in the latest month, so the services' mix is fixed.
	set("seconds_down", "web-app", latestMonth, 20*60)
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

// --- incidents and exec summaries ------------------------------------------

// The incident tracker export the demo's incidents come from, read as of
// 2026-11-01: September incidents for history and October's, which explain
// part of the uptime and deployment uptime of a few services and one
// deployment. They change no value.
const (
	incidentSource     = "incident-tracker"
	incidentTemplateID = "incident-tracker-export"
	incidentFile       = "acme_incidents_oct.csv"
)

//go:embed testdata/acme_incidents_oct.csv
var incidentsCSV []byte

var incidentsAsOf = date(2026, time.November, 1)

// incidentType is the incident preset, linked to the uptime metrics as their
// downtime explanation, with planned maintenance filtered out.
func incidentType() domain.RecordType {
	rt := records.IncidentPreset()
	rt.TrackedFrom = map[string]period.Period{incidentSource: month(2026, 9)}
	for _, metric := range []string{"uptime", "deployment_uptime"} {
		rt.Explains = append(rt.Explains, domain.ExplainLink{
			ScorecardID: ScorecardID, MetricKey: metric, Mode: domain.ExplainDowntime,
			DownMeasure: "seconds_down", Where: "category != 'maintenance'",
		})
	}
	return rt
}

// incidentTemplate reads the tracker's incident export: one record per
// listed component, times in UTC, and the issue type as the category.
func incidentTemplate() records.Template {
	layout := []string{"2006-01-02 15:04"}
	return records.Template{
		Name: "Tracker incidents export", RecordType: records.IncidentTypeID, Source: incidentSource,
		File: records.FileSpec{Format: "csv", HeaderRow: 1}, TimeZone: "UTC",
		Fields: map[string]records.FieldMap{
			"externalId":  {Column: "Issue key"},
			"title":       {Column: "Summary"},
			"category":    {Column: "Issue Type", Map: map[string]string{"Maintenance": "maintenance", "*": "incident"}},
			"priority":    {Column: "Priority", Map: map[string]string{"SEV-1": "SEV1", "SEV-2": "SEV2", "SEV-3": "SEV3", "SEV-4": "SEV4"}},
			"status":      {Column: "Status"},
			"state":       {Column: "Status", Map: map[string]string{"Resolved": "done", "Closed": "done", "Cancelled": "cancelled", "*": "open"}},
			"subjectKey":  {Column: "Components", Separator: ","},
			"createdAt":   {Column: "Incident start", DateFormats: layout},
			"completedAt": {Column: "Resolved", DateFormats: layout},
			"url":         {Template: "https://tracker.example/browse/{Issue key}"},
		},
		Attributes: map[string]records.FieldMap{
			"startedAt": {Column: "Incident start", DateFormats: layout},
			"endedAt":   {Column: "Incident end", DateFormats: layout},
			"impactPct": {Column: "Customer impact"},
		},
	}
}

// seedIncidents stores the incident type and reads the tracker export
// through the import plan, as an upload would, then stores its snapshot
// (with a fixed ID and time, so the seed is reproducible) and the template.
// It fails if the plan has any problem or would write any value.
func seedIncidents(ctx context.Context, st store.Store, tenant domain.Tenant) error {
	rt := incidentType()
	if err := st.PutRecordType(ctx, TenantID, rt, 0); err != nil {
		return fmt.Errorf("demo: record type %s: %w", rt.ID, err)
	}
	tpl := incidentTemplate()
	if errs := tpl.Validate(rt); len(errs) != 0 {
		return fmt.Errorf("demo: incident template: %v", errs)
	}
	tbl, err := records.ReadCSV(bytes.NewReader(incidentsCSV))
	if err != nil {
		return fmt.Errorf("demo: %s: %w", incidentFile, err)
	}
	p, err := recordimport.Build(ctx, st, tenant, ScorecardID, tpl, tbl, incidentsAsOf, recordimport.Answers{}, nil)
	if err != nil {
		return fmt.Errorf("demo: plan %s: %w", incidentFile, err)
	}
	if len(p.Problems) != 0 || p.Counts.Errors != 0 || p.Counts.Unmatched != 0 || len(p.NewValues) != 0 {
		return fmt.Errorf("demo: %s: problems %+v, counts %+v, new values %v", incidentFile, p.Problems, p.Counts, p.NewValues)
	}
	if len(p.Writes) != 0 {
		return fmt.Errorf("demo: %s would change %d values", incidentFile, len(p.Writes))
	}
	sn := p.Snapshot
	sn.ID, sn.FileName = snapshotID(rt.ID, incidentsAsOf), incidentFile
	sn.CreatedBy, sn.CreatedAt = Users[0].UserID, incidentsAsOf.Time.Add(17*time.Hour)
	revs := slices.Clone(p.Revisions)
	for i := range revs {
		revs[i].Rev.SnapshotID = sn.ID
	}
	if err := st.ApplySnapshot(ctx, TenantID, sn, revs); err != nil {
		return fmt.Errorf("demo: incident snapshot: %w", err)
	}
	body, err := json.Marshal(tpl)
	if err != nil {
		return err
	}
	used := sn.CreatedAt
	// "records" is the profile of a records import template.
	if err := st.PutTemplate(ctx, TenantID, store.Template{ID: incidentTemplateID, Name: tpl.Name, Profile: "records", Body: body, LastUsed: &used}); err != nil {
		return fmt.Errorf("demo: incident template: %w", err)
	}
	return nil
}

// summary is one seeded exec summary and the company standing it was
// written against.
type summary struct {
	SummaryCell
	text  string
	links []domain.RCALink
	at    time.Time
	basis domain.RCABasis
}

func basis(display, status string, evidence ...string) domain.RCABasis {
	return domain.RCABasis{Display: display, Status: status, Evidence: append([]string{}, evidence...)}
}

// subjects are the evidence keys of the reporting subjects short of perfect.
func subjects(ids ...string) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = "subject:" + id
	}
	return out
}

// incidents are the evidence keys of the incident records counted.
func incidents(externalIDs ...string) []string {
	out := make([]string, len(externalIDs))
	for i, id := range externalIDs {
		out[i] = incidentSource + ":" + id
	}
	return out
}

func tracker(title, key string) domain.RCALink {
	return domain.RCALink{Title: title, URL: "https://tracker.example/browse/" + key}
}

func docs(title, path string) domain.RCALink {
	return domain.RCALink{Title: title, URL: "https://docs.example/" + path}
}

// octoberSummaries are SummaryWritten and SummaryStale, in that order. Each
// basis is the company standing the summary was written against: the
// written ones as it is now (the display, the status, the reporting
// subjects short of perfect, then the incidents counted), the stale one from
// before the late invoices raised spend.
func octoberSummaries() []summary {
	at := func(d, h, m int) time.Time { return time.Date(2026, time.November, d, h, m, 0, 0, time.UTC) }
	oct := func(i int) SummaryCell { return SummaryWritten[i] }
	return []summary{
		{SummaryCell: oct(0), at: at(3, 9, 10),
			text: "Seven of 33 epics slipped, four of them in Checkout and Billing after a partner changed its refund interface " +
				"mid-month. They are re-planned for November.",
			links: []domain.RCALink{docs("November re-plan", "plans/checkout-november"), tracker("Partner refund interface change", "PAY-1187")},
			basis: basis("79%", "R", subjects("android-app", "billing", "checkout", "pipelines")...)},
		{SummaryCell: oct(1), at: at(3, 9, 25),
			text:  "Eight of 40 concepts ran over budget, mostly in Billing and Checkout, where vendor rates rose in September.",
			links: []domain.RCALink{docs("Vendor rate review", "finance/vendor-rates-q4")},
			basis: basis("80%", "Y", subjects("analytics", "android-app", "billing", "checkout", "ios-app")...)},
		{SummaryCell: oct(2), at: at(3, 10, 5),
			text: "The score rose 26% on a burst of high-priority defects in the mobile apps after their 6.2 release; " +
				"Billing's backlog also grew.",
			links: []domain.RCALink{tracker("Mobile 6.2 defect triage", "MOB-3302")},
			basis: basis("22.81", "R", subjects("android-app", "billing", "ios-app")...)},
		{SummaryCell: oct(3), at: at(3, 15, 20),
			text: "Webhooks lost 7h to a queue saturation after the 3 Oct deploy (INC-2041) and an overlapping crash loop " +
				"and DNS fault on 17 Oct; Analytics Ingest and Search had short incidents. 40m on Webhooks has no incident.",
			links: []domain.RCALink{
				docs("Delivery queue saturation postmortem", "postmortems/inc-2041"),
				tracker("Retry worker crash loop", "INC-2047"),
				tracker("Regional DNS fault", "INC-2049"),
				tracker("Ingest backlog", "INC-2052"),
			},
			basis: basis("99.06%", "R", slices.Concat(
				subjects("analytics-ingest", "billing-worker", "data-export", "email-relay", "feature-flags", "inventory-api", "ledger",
					"mobile-backend", "scheduler", "search", "status-page", "web-app", "webhooks"),
				incidents("INC-2041@Webhooks", "INC-2047@Webhooks", "INC-2049@Search", "INC-2049@Webhooks", "INC-2052@Analytics Ingest"))...)},
		{SummaryCell: oct(4), at: at(4, 11, 0),
			text:  "One of five postmortems was late: the 17 Oct crash loop review waited on the DNS provider's report. It closed on 4 Nov.",
			links: []domain.RCALink{},
			basis: basis("80%", "Y", subjects(companyID)...)},
		{SummaryCell: oct(5), at: at(4, 14, 30),
			text: "All four segments fell short; Data dropped to 74% while the export redesign was in beta. Survey comments " +
				"point at slow exports.",
			links: []domain.RCALink{docs("October survey comments", "research/csat-2026-10")},
			basis: basis("74%", "R", subjects("data", "mobile", "payments", "platform")...)},
		{SummaryCell: oct(6), at: at(5, 10, 15),
			text:  "Eight of 41 open-source findings passed their fix date, most of them waiting on an upstream library release.",
			links: []domain.RCALink{tracker("Upstream release tracking", "SEC-912")},
			basis: basis("80%", "Y", subjects("data", "mobile", "payments", "platform")...)},
		{SummaryCell: SummaryStale[0], at: at(2, 16, 45),
			text: "Spend ran over plan on two vendor renewals in Checkout and Billing that landed early; both were " +
				"budgeted for November.",
			links: []domain.RCALink{docs("Vendor renewals", "finance/renewals-2026")},
			basis: basis("102%", "G", subjects("android-app", "billing", "checkout", "identity", "messaging", "pipelines")...)},
	}
}

// septemberSummaries are SummarySeptember, each written against the company
// standing as it is now.
func septemberSummaries() []summary {
	at := func(d, h, m int) time.Time { return time.Date(2026, time.October, d, h, m, 0, 0, time.UTC) }
	sep := func(i int) SummaryCell { return SummarySeptember[i] }
	return []summary{
		{SummaryCell: sep(0), at: at(2, 9, 0),
			text:  "Nine in ten epics landed on time; the two that slipped, in Billing and Pipelines, waited on a shared schema migration.",
			links: []domain.RCALink{tracker("Shared schema migration", "PLAT-2210")},
			basis: basis("90%", "G", subjects("billing", "pipelines")...)},
		{SummaryCell: sep(1), at: at(2, 9, 20),
			text:  "Ten of 46 concepts ran over budget as vendor rates rose mid-quarter; rates are now locked through year end.",
			links: []domain.RCALink{docs("Vendor rate review", "finance/vendor-rates-q4")},
			basis: basis("78%", "R", subjects("android-app", "billing", "checkout", "ios-app", "messaging", "pipelines")...)},
		{SummaryCell: sep(2), at: at(2, 9, 40),
			text:  "Spend ran 10% over plan because October hardware orders were placed in September to hold their pricing.",
			links: []domain.RCALink{docs("Hardware order timing", "finance/hardware-2026-09")},
			basis: basis("110%", "G", subjects("android-app", "billing", "checkout", "ios-app", "messaging", "pipelines")...)},
		{SummaryCell: sep(3), at: at(2, 10, 0),
			text: "Thirteen of 78 concepts fell short of their expected value in Q3, most of them early bets in Billing and " +
				"Checkout that are being re-scoped.",
			links: []domain.RCALink{docs("Q3 concept review", "plans/concepts-2026-q3")},
			basis: basis("83%", "Y", subjects("analytics", "android-app", "billing", "checkout", "messaging", "pipelines")...)},
		{SummaryCell: sep(4), at: at(2, 10, 30),
			text:  "The score worsened 27% as older defects in Billing and Checkout were re-triaged to a higher priority.",
			links: []domain.RCALink{},
			basis: basis("18.10", "R", subjects("analytics", "billing", "checkout", "messaging", "pipelines")...)},
		{SummaryCell: sep(5), at: at(2, 11, 0),
			text:  "The weighted backlog reached 647 after the billing statement change raised ticket volume; two more agents joined in late September.",
			links: []domain.RCALink{docs("Statement change support plan", "support/statement-change")},
			basis: basis("647", "R", subjects("android-app", "billing", "checkout", "ios-app", "messaging", "pipelines")...)},
		{SummaryCell: sep(6), at: at(5, 14, 0),
			text: "Short incidents across services; the longest was on Notifications (INC-1996). Webhooks and Public API also had " +
				"brief incidents. Reporting was lowest at 99.90%.",
			links: []domain.RCALink{
				tracker("Notifications incident", "INC-1996"),
				tracker("Webhooks incident", "INC-2003"),
				tracker("Public API incident", "INC-2008"),
			},
			basis: basis("99.90%", "G", slices.Concat(
				subjects("admin-console", "analytics-ingest", "audit-log", "billing-worker", "data-export", "email-relay",
					"inventory-api", "media-cdn", "notifications", "public-api", "reporting", "scheduler", "search", "status-page",
					"web-app", "webhooks"),
				incidents("INC-1996@Notifications", "INC-2003@Webhooks", "INC-2008@Public API"))...)},
		{SummaryCell: sep(7), at: at(5, 14, 30),
			text: "Search Indexer cluster A-1 lost about six hours to a failed node replacement; Notification Relay's outage " +
				"began late on 30 Sep (INC-2036) and ran into October.",
			links: []domain.RCALink{tracker("Notification Relay outage", "INC-2036")},
			basis: basis("99.09%", "R", slices.Concat(
				subjects("dep-identity-west", "dep-ledger", "dep-notify-multi", "dep-portal-cloud", "dep-search-a1"),
				incidents("INC-2036@Notification Relay - Multi-Region Active"))...)},
		{SummaryCell: sep(8), at: at(6, 9, 0),
			text:  "45 of 419 people missed the September deadline, mostly new joiners; reminders now go out two weeks ahead.",
			links: []domain.RCALink{},
			basis: basis("89%", "Y", subjects("analytics", "android-app", "billing", "checkout", "ios-app", "messaging", "pipelines")...)},
		{SummaryCell: sep(9), at: at(6, 9, 30),
			text:  "All four segments fell short; Mobile was lowest at 76% on reviews about sign-in after the 6.1 release.",
			links: []domain.RCALink{docs("September survey comments", "research/csat-2026-09")},
			basis: basis("76%", "Y", subjects("data", "mobile", "payments", "platform")...)},
		{SummaryCell: sep(10), at: at(6, 10, 0),
			text:  "Eight of 44 findings in Data, Mobile and Payments missed their fix date while waiting on upstream releases.",
			links: []domain.RCALink{tracker("Upstream release tracking", "SEC-912")},
			basis: basis("82%", "Y", subjects("data", "mobile", "payments")...)},
	}
}

// seedSummaries stores the company exec summaries of 2026-M09 and 2026-M10,
// all by the admin, each with the basis it was written against.
func seedSummaries(ctx context.Context, st store.Store) error {
	admin := Users[0]
	for _, s := range slices.Concat(septemberSummaries(), octoberSummaries()) {
		r := domain.CellRCA{
			ScorecardID: ScorecardID, MetricKey: s.MetricKey, SubjectID: companyID, Period: s.Period,
			Text: s.text, Links: s.links, AuthorID: admin.UserID, AuthorName: admin.Name, Channel: domain.RCAChannelWeb,
			CreatedAt: s.at, UpdatedAt: s.at, Basis: s.basis,
		}
		if errs := r.Validate(); len(errs) != 0 {
			return fmt.Errorf("demo: exec summary of %s %s: %v", s.MetricKey, s.Period, errs)
		}
		if _, err := st.PutRCA(ctx, TenantID, r.Normalize(), 0); err != nil {
			return fmt.Errorf("demo: exec summary of %s %s: %w", s.MetricKey, s.Period, err)
		}
	}
	return nil
}
