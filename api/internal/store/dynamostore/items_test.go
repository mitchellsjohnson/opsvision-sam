package dynamostore

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// These tests round-trip every item type through the real attributevalue
// encoder, with no DynamoDB involved.

func roundTrip[T any](t *testing.T, item T) T {
	t.Helper()
	m, err := marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"PK", "SK"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("encoded item has no %s attribute (embedded keys not flattened?): %v", k, m)
		}
	}
	out, err := unmarshal[T](m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func eq[T any](t *testing.T, what string, got, want T) {
	t.Helper()
	if d := cmp.Diff(want, got, cmpopts.EquateEmpty()); d != "" {
		t.Errorf("%s mismatch (-want +got):\n%s", what, d)
	}
}

func f64(v float64) *float64 { return &v }

func TestItemRoundTrip(t *testing.T) {
	at := time.Date(2026, time.October, 5, 12, 30, 15, 123456789, time.UTC)
	retired := period.Period{Grain: period.Month, FY: 2027, Index: 3}
	mth := period.Period{Grain: period.Month, FY: 2026, Index: 11}

	tenant := domain.Tenant{ID: "t1", Name: "Tenant", Auth0OrgID: "org_1", FiscalYearStartMonth: time.October, StatusScale: domain.DefaultStatusScale(), DefaultRole: domain.RoleViewer, CreatedAt: at}
	eq(t, "tenant", roundTrip(t, newTenantItem(tenant)).domain(), tenant)
	bare := domain.Tenant{ID: "t2"}
	eq(t, "bare tenant", roundTrip(t, newTenantItem(bare)).domain(), bare)
	if ti := newTenantItem(tenant); ti.PK != "T#t1" || ti.SK != "TENANT" || ti.GSI1PK != "TENANTS" || ti.GSI1SK != "T#t1" {
		t.Errorf("tenant keys = %+v", ti.keys)
	}

	mem := domain.Membership{UserID: "u1", Email: "u@example.test", Name: "U", Role: domain.RoleAdmin, Scope: domain.Scope{OrgUnitIDs: []string{"a"}, MetricKeys: []string{"x", "y"}}, CreatedAt: at}
	eq(t, "membership", roundTrip(t, newMembershipItem("t1", mem)).domain(), mem)
	if mi := newMembershipItem("t1", mem); mi.GSI1PK != "USER#u1" || mi.GSI1SK != "T#t1" {
		t.Errorf("membership GSI keys = %+v", mi.keys)
	}

	lvl := domain.Level{ID: "l", Name: "L", Depth: 0}
	eq(t, "level", roundTrip(t, newLevelItem("t1", lvl)).domain(), lvl)

	unit := domain.OrgUnit{ID: "u", Name: "U", LevelID: "l", ParentID: "p", SourceKeys: []string{"a", "b"}, RetiredFrom: &retired}
	gotUnit, err := roundTrip(t, newUnitItem("t1", unit)).domain()
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "unit", gotUnit, unit)

	move := domain.OrgMove{UnitID: "u", NewParentID: "p", EffectiveMonth: mth, Note: "n"}
	gotMove, err := roundTrip(t, newMoveItem("t1", move)).domain()
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "move", gotMove, move)

	kind := domain.ItemKind{ID: "k", Name: "K"}
	eq(t, "kind", roundTrip(t, newKindItem("t1", kind)).domain(), kind)
	ti := domain.TrackedItem{ID: "i", KindID: "k", Name: "I", OrgUnitID: "u", SourceKeys: []string{"s"}}
	eq(t, "tracked item", roundTrip(t, newTrackedItem("t1", ti)).domain(), ti)
	sc := domain.Scorecard{ID: "sc", Name: "SC"}
	eq(t, "scorecard", roundTrip(t, newScorecardItem("t1", sc)).domain(), sc)

	pub := at
	ver := domain.MethodologyVersion{
		ID: "v1", ScorecardID: "sc", Name: "V", Status: domain.VersionPublished, EffectiveFrom: mth, PublishedAt: &pub, Revision: 4,
		Content: domain.Methodology{
			Categories: []domain.Category{{ID: "c", Name: "C", Order: 2}},
			Measures:   []domain.Measure{{Key: "m", Name: "M", OrgAgg: domain.AggSum, TimeAgg: domain.AggLatest}},
			Metrics: []domain.Metric{{
				Key: "x", Formula: "m", Targets: []domain.Target{{Label: "T", From: mth, To: mth, Value: 1.5}},
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{{Status: "G", Op: ">=", Value: 90}, {Status: "R"}}},
			}},
		},
	}
	vi, err := newVersionItem("t1", ver, 4)
	if err != nil {
		t.Fatal(err)
	}
	if vi.SK != "SC#sc#VER#v1" {
		t.Errorf("version SK = %q", vi.SK)
	}
	gotVer, err := roundTrip(t, vi).domain()
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "version", gotVer, ver)
	// A version with no PublishedAt and a zero EffectiveFrom.
	ver2 := domain.MethodologyVersion{ID: "v2", ScorecardID: "sc", Revision: 1}
	vi2, err := newVersionItem("t1", ver2, 1)
	if err != nil {
		t.Fatal(err)
	}
	gotVer2, err := roundTrip(t, vi2).domain()
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "bare version", gotVer2, ver2)

	// A data point whose value is exactly zero must stay non-nil; N/A must stay nil.
	zero := domain.DataPoint{MeasureKey: "m", SubjectID: "u", Period: mth, Value: f64(0), Source: domain.SourceGrid, EnteredBy: "e", EnteredAt: at, Revision: 3}
	na := domain.DataPoint{MeasureKey: "m", SubjectID: "u", Period: mth, NAReason: "n/a", EnteredAt: at, Revision: 1}
	for name, p := range map[string]domain.DataPoint{"zero": zero, "n/a": na} {
		k := keys{PK: dataPK("t1", "sc", p.Period.FY), SK: pointSK(p.Period, p.MeasureKey, p.SubjectID)}
		got, err := roundTrip(t, newPointItem(k, p)).domain()
		if err != nil {
			t.Fatal(err)
		}
		eq(t, "point "+name, got, p)
		if (got.Value == nil) != (p.Value == nil) {
			t.Errorf("point %s: Value nil-ness changed: got %v want %v", name, got.Value, p.Value)
		}
	}

	ov := domain.Override{MetricKey: "x", SubjectID: "u", Period: mth, Value: f64(0), Status: "Y", Reason: "r", By: "b", At: at}
	gotOv, err := roundTrip(t, newOverrideItem("t1", "sc", ov)).domain()
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "override", gotOv, ov)
	if oi := newOverrideItem("t1", "sc", ov); oi.PK != "T#t1#SC#sc#FY#2026" || oi.SK != "OV#2026-M11#x#u" {
		t.Errorf("override keys = %+v", oi.keys)
	}

	ae := domain.AuditEntry{ID: "01ABC", ActorID: "a", Channel: "web", Action: "x", TargetType: "t", TargetID: "1", Before: json.RawMessage(`{"v":1}`), After: json.RawMessage(`{"v":2}`), At: at}
	eq(t, "audit", roundTrip(t, newAuditItem("t1", ae)).domain(), ae)
	if ai := newAuditItem("t1", ae); ai.PK != "T#t1#AUDIT#2026-10" || ai.SK != "01ABC" {
		t.Errorf("audit keys = %+v", ai.keys)
	}

	im := store.Import{ID: "i", Status: "s", ObjectKey: "k", Profile: "p", TemplateID: "t", CreatedBy: "c", CreatedAt: at, ChangeSet: json.RawMessage(`{"a":1}`)}
	eq(t, "import", roundTrip(t, newImportItem("t1", im)).domain(), im)
	tp := store.Template{ID: "t", Name: "N", Profile: "p", Body: json.RawMessage(`{"cols":[1]}`)}
	eq(t, "template", roundTrip(t, newTemplateItem("t1", tp)).domain(), tp)
}
