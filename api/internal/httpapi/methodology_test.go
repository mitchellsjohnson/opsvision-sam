package httpapi

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// versionJSON is the wire form of a methodology version.
type versionJSON struct {
	ID            string             `json:"id"`
	ScorecardID   string             `json:"scorecardId"`
	Name          string             `json:"name"`
	Status        string             `json:"status"`
	EffectiveFrom string             `json:"effectiveFrom"`
	PublishedAt   *string            `json:"publishedAt"`
	Revision      int                `json:"revision"`
	Content       domain.Methodology `json:"content"`
}

type diffJSON struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Changes []struct {
		Path   string `json:"path"`
		Kind   string `json:"kind"`
		Before any    `json:"before"`
		After  any    `json:"after"`
	} `json:"changes"`
}

// sampleMethodology is a valid methodology with one metric whose green band
// starts at greenFrom.
func sampleMethodology(greenFrom float64) domain.Methodology {
	return domain.Methodology{
		Categories: []domain.Category{{ID: "quality", Name: "Quality", Order: 1}},
		Measures: []domain.Measure{
			{Key: "closed", Name: "Closed", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
			{Key: "total", Name: "Total", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
		},
		Metrics: []domain.Metric{{
			Key:        "closure_rate",
			Name:       "Closure rate",
			CategoryID: "quality",
			Formula:    "closed / total",
			Format:     domain.FormatPercent1,
			Direction:  domain.DirectionHigherBetter,
			Frequency:  domain.FrequencyMonthly,
			ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "team"}},
			Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
				{Status: "G", Op: ">=", Value: greenFrom},
				{Status: "Y", Op: ">=", Value: 75},
				{Status: "R"},
			}},
			Targets:    []domain.Target{},
			Definition: "Share of items closed.",
			Source:     "Synthetic tracker",
		}},
	}
}

func seedScorecard(t *testing.T, e *testEnv, id string) {
	t.Helper()
	e.expect(t, 201, e.tokens["t1-admin"], "POST", "/scorecards", map[string]any{"id": id, "name": "Scorecard " + id}, nil)
}

func newDraft(t *testing.T, e *testEnv, sc, name string, cloneFrom string) versionJSON {
	t.Helper()
	body := map[string]any{"name": name}
	if cloneFrom != "" {
		body["cloneFrom"] = cloneFrom
	}
	var v versionJSON
	e.expect(t, 201, e.tokens["t1-admin"], "POST", "/scorecards/"+sc+"/versions", body, &v)
	return v
}

func saveDraft(t *testing.T, e *testEnv, v versionJSON, m domain.Methodology) versionJSON {
	t.Helper()
	var out versionJSON
	e.expect(t, 200, e.tokens["t1-admin"], "PUT", "/scorecards/"+v.ScorecardID+"/versions/"+v.ID,
		map[string]any{"revision": v.Revision, "content": m}, &out)
	return out
}

func publish(t *testing.T, e *testEnv, v versionJSON, month string) versionJSON {
	t.Helper()
	var out versionJSON
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/"+v.ScorecardID+"/versions/"+v.ID+"/publish",
		map[string]any{"effectiveFrom": month}, &out)
	return out
}

func getVersion(t *testing.T, e *testEnv, sc, id string) versionJSON {
	t.Helper()
	var v versionJSON
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/"+sc+"/versions/"+id, nil, &v)
	return v
}

// publishedDraft creates, fills, and publishes a version effective from month.
func publishedVersion(t *testing.T, e *testEnv, sc, name, month string, m domain.Methodology) versionJSON {
	t.Helper()
	v := newDraft(t, e, sc, name, "")
	v = saveDraft(t, e, v, m)
	return publish(t, e, v, month)
}

func TestScorecardsCreateAndList(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]

	var list struct{ Scorecards []domain.Scorecard }
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards", nil, &list)
	if list.Scorecards == nil || len(list.Scorecards) != 0 {
		t.Fatalf("empty list = %#v, want []", list.Scorecards)
	}

	var sc domain.Scorecard
	e.expect(t, 201, admin, "POST", "/scorecards", map[string]any{"id": "delivery", "name": " Delivery "}, &sc)
	if sc.ID != "delivery" || sc.Name != "Delivery" {
		t.Fatalf("created = %+v", sc)
	}
	e.expectError(t, 409, "conflict", admin, "POST", "/scorecards", map[string]any{"id": "delivery", "name": "Again"})
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards", map[string]any{"id": "bad id!", "name": "X"})
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards", map[string]any{"id": "ok", "name": "  "})
	e.expectError(t, 403, "forbidden", e.tokens["t1-contributor"], "POST", "/scorecards", map[string]any{"id": "other", "name": "X"})
	e.expectError(t, 403, "forbidden", e.tokens["t1-viewer"], "POST", "/scorecards", map[string]any{"id": "other", "name": "X"})

	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards", nil, &list)
	if len(list.Scorecards) != 1 || list.Scorecards[0].ID != "delivery" {
		t.Fatalf("list = %+v", list.Scorecards)
	}
	// Another tenant sees none.
	e.expect(t, 200, e.tokens["t2-admin"], "GET", "/scorecards", nil, &list)
	if len(list.Scorecards) != 0 {
		t.Fatalf("t2 list = %+v", list.Scorecards)
	}

	var actions []string
	for _, en := range e.audits(t, "t1") {
		actions = append(actions, en.Action)
	}
	if strings.Join(actions, ",") != "scorecard.create" {
		t.Errorf("audit actions = %v", actions)
	}
}

func TestCreateCloneEditPublish(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	seedScorecard(t, e, "delivery")

	// New empty draft.
	v1 := newDraft(t, e, "delivery", "Baseline", "")
	if v1.Status != "draft" || v1.Revision != 1 || v1.EffectiveFrom != "" || v1.PublishedAt != nil || v1.ScorecardID != "delivery" {
		t.Fatalf("new draft = %+v", v1)
	}
	if len(v1.Content.Metrics) != 0 {
		t.Fatalf("new draft content = %+v", v1.Content)
	}

	// Edit, validate, publish.
	v1 = saveDraft(t, e, v1, sampleMethodology(90))
	if v1.Revision != 2 || len(v1.Content.Metrics) != 1 {
		t.Fatalf("saved = %+v", v1)
	}
	var res struct {
		Valid  bool
		Errors []detail
	}
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/versions/"+v1.ID+"/validate", nil, &res)
	if !res.Valid || len(res.Errors) != 0 {
		t.Fatalf("validate = %+v", res)
	}
	pub := publish(t, e, v1, "2026-M01")
	if pub.Status != "published" || pub.EffectiveFrom != "2026-M01" || pub.PublishedAt == nil || pub.Revision != 3 {
		t.Fatalf("published = %+v", pub)
	}

	// Clone into a second draft, tweak, publish later.
	v2 := newDraft(t, e, "delivery", "Tighter", v1.ID)
	if v2.ID == v1.ID || v2.Status != "draft" || v2.Revision != 1 || v2.EffectiveFrom != "" || v2.PublishedAt != nil {
		t.Fatalf("clone = %+v", v2)
	}
	if len(v2.Content.Metrics) != 1 || v2.Content.Metrics[0].Formula != "closed / total" {
		t.Fatalf("clone content = %+v", v2.Content)
	}
	v2 = saveDraft(t, e, v2, sampleMethodology(95))
	pub2 := publish(t, e, v2, "2026-M07")
	if pub2.Status != "published" {
		t.Fatalf("published v2 = %+v", pub2)
	}
	if got := getVersion(t, e, "delivery", v1.ID); got.Status != "superseded" {
		t.Errorf("v1 status = %q, want superseded", got.Status)
	}

	var list struct{ Versions []versionJSON }
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions", nil, &list)
	if len(list.Versions) != 2 {
		t.Fatalf("versions = %+v", list.Versions)
	}

	var actions []string
	for _, en := range e.audits(t, "t1") {
		actions = append(actions, en.Action)
	}
	want := "scorecard.create,version.create,version.update,version.publish,version.create,version.update,version.publish,version.supersede"
	if strings.Join(actions, ",") != want {
		t.Errorf("audit actions\n got %v\nwant %s", actions, want)
	}
}

func TestPublishedImmutable(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	v := publishedVersion(t, e, "delivery", "Baseline", "2026-M01", sampleMethodology(90))

	got := e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "PUT", "/scorecards/delivery/versions/"+v.ID,
		map[string]any{"revision": v.Revision, "content": sampleMethodology(80)})
	if got.Error.Message != "published versions are immutable" {
		t.Errorf("message = %q", got.Error.Message)
	}
	if after := getVersion(t, e, "delivery", v.ID); after.Content.Metrics[0].Rule.Bands[0].Value != 90 {
		t.Errorf("published content changed: %+v", after.Content.Metrics[0].Rule)
	}
	// Publishing a published version again is a conflict too.
	e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "POST", "/scorecards/delivery/versions/"+v.ID+"/publish",
		map[string]any{"effectiveFrom": "2026-M03"})
}

func TestPublishValidationErrors(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	m := sampleMethodology(90)
	m.Metrics[0].Formula = "closed / missing_measure"
	v := saveDraft(t, e, newDraft(t, e, "delivery", "Broken", ""), m)

	got := e.expectError(t, 400, "invalid", e.tokens["t1-admin"], "POST", "/scorecards/delivery/versions/"+v.ID+"/publish",
		map[string]any{"effectiveFrom": "2026-M01"})
	found := false
	for _, d := range got.Error.Details {
		if d.Path == "metrics[0].formula" {
			found = true
		}
	}
	if !found {
		t.Errorf("details = %+v, want metrics[0].formula", got.Error.Details)
	}
	if after := getVersion(t, e, "delivery", v.ID); after.Status != "draft" || after.EffectiveFrom != "" || after.PublishedAt != nil {
		t.Errorf("failed publish changed the draft: %+v", after)
	}

	// validate reports the same problem with a 200.
	var res struct {
		Valid  bool
		Errors []detail
	}
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/delivery/versions/"+v.ID+"/validate", nil, &res)
	if res.Valid || len(res.Errors) == 0 || res.Errors[0].Path != "metrics[0].formula" {
		t.Errorf("validate = %+v", res)
	}
}

func TestStatusScaleDefaultsWhenTenantHasNone(t *testing.T) {
	if got := statusScale(domain.Tenant{}); len(got) != len(domain.DefaultStatusScale()) {
		t.Errorf("empty scale -> %v, want default", got)
	}
	custom := []domain.StatusLevel{{Key: "OK", Label: "Fine", Color: "#000000", Rank: 1}}
	if got := statusScale(domain.Tenant{StatusScale: custom}); len(got) != 1 || got[0].Key != "OK" {
		t.Errorf("custom scale -> %v", got)
	}
}

func TestStaleRevisionPut(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	seedScorecard(t, e, "delivery")
	v := newDraft(t, e, "delivery", "Draft", "")

	saveDraft(t, e, v, sampleMethodology(90)) // revision 1 -> 2
	// A second writer still holding revision 1.
	e.expectError(t, 409, "conflict", admin, "PUT", "/scorecards/delivery/versions/"+v.ID,
		map[string]any{"revision": 1, "content": sampleMethodology(80)})
	// A revision from the future is also stale.
	e.expectError(t, 409, "conflict", admin, "PUT", "/scorecards/delivery/versions/"+v.ID,
		map[string]any{"revision": 9, "content": sampleMethodology(80)})
	if got := getVersion(t, e, "delivery", v.ID); got.Revision != 2 || got.Content.Metrics[0].Rule.Bands[0].Value != 90 {
		t.Errorf("stale put changed the draft: %+v", got)
	}
}

func TestOnlyAdminsEditMethodology(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	base := publishedVersion(t, e, "delivery", "Baseline", "2026-M01", sampleMethodology(90))
	draft := newDraft(t, e, "delivery", "Next", base.ID)

	for _, who := range []string{"t1-contributor", "t1-viewer"} {
		tok := e.tokens[who]
		e.expectError(t, 403, "forbidden", tok, "POST", "/scorecards", map[string]any{"id": "x", "name": "X"})
		e.expectError(t, 403, "forbidden", tok, "POST", "/scorecards/delivery/versions", map[string]any{"name": "N"})
		e.expectError(t, 403, "forbidden", tok, "PUT", "/scorecards/delivery/versions/"+draft.ID,
			map[string]any{"revision": 1, "content": sampleMethodology(80)})
		e.expectError(t, 403, "forbidden", tok, "POST", "/scorecards/delivery/versions/"+draft.ID+"/validate", nil)
		e.expectError(t, 403, "forbidden", tok, "POST", "/scorecards/delivery/versions/"+draft.ID+"/publish",
			map[string]any{"effectiveFrom": "2026-M07"})
	}

	// Every member can read versions and diffs.
	for _, who := range []string{"t1-contributor", "t1-viewer"} {
		tok := e.tokens[who]
		var list struct{ Versions []versionJSON }
		e.expect(t, 200, tok, "GET", "/scorecards/delivery/versions", nil, &list)
		if len(list.Versions) != 2 {
			t.Errorf("%s sees %d versions", who, len(list.Versions))
		}
		e.expect(t, 200, tok, "GET", "/scorecards/delivery/versions/"+draft.ID, nil, nil)
		var d diffJSON
		e.expect(t, 200, tok, "GET", "/scorecards/delivery/versions/"+draft.ID+"/diff?against="+base.ID, nil, &d)
	}
	if got := getVersion(t, e, "delivery", draft.ID); got.Revision != 1 {
		t.Errorf("forbidden writes changed the draft: %+v", got)
	}
}

func TestDiffDetectsThresholdChange(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	base := publishedVersion(t, e, "delivery", "Baseline", "2026-M01", sampleMethodology(90))
	next := saveDraft(t, e, newDraft(t, e, "delivery", "Tighter", base.ID), sampleMethodology(95))

	var d diffJSON
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions/"+next.ID+"/diff?against="+base.ID, nil, &d)
	if d.From != base.ID || d.To != next.ID {
		t.Errorf("from/to = %q/%q", d.From, d.To)
	}
	if len(d.Changes) != 1 || d.Changes[0].Path != "metrics[closure_rate].rule" || d.Changes[0].Kind != "changed" {
		t.Fatalf("changes = %+v", d.Changes)
	}
	before, _ := d.Changes[0].Before.(map[string]any)["bands"].([]any)
	after, _ := d.Changes[0].After.(map[string]any)["bands"].([]any)
	if len(before) != 3 || len(after) != 3 || before[0].(map[string]any)["value"] != 90.0 || after[0].(map[string]any)["value"] != 95.0 {
		t.Errorf("before/after = %+v / %+v", d.Changes[0].Before, d.Changes[0].After)
	}

	// Identical content: empty list, never null.
	same := newDraft(t, e, "delivery", "Same", base.ID)
	status, raw := e.call(t, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions/"+same.ID+"/diff?against="+base.ID, nil)
	if status != 200 || !strings.Contains(string(raw), `"changes":[]`) {
		t.Errorf("identical diff = %d %s", status, raw)
	}
}

func TestDiffDefaultsToVersionInForce(t *testing.T) {
	e := newTestEnv(t)
	viewer := e.tokens["t1-viewer"]
	seedScorecard(t, e, "delivery")
	seedScorecard(t, e, "other")
	draft := newDraft(t, e, "delivery", "First", "")

	// Nothing published yet and no against: nothing to compare with.
	e.expectError(t, 400, "invalid", viewer, "GET", "/scorecards/delivery/versions/"+draft.ID+"/diff", nil)

	old := publishedVersion(t, e, "delivery", "Old", "2026-M01", sampleMethodology(90))
	cur := publishedVersion(t, e, "delivery", "Current", "2026-M04", sampleMethodology(92))
	next := saveDraft(t, e, newDraft(t, e, "delivery", "Next", cur.ID), sampleMethodology(95))

	var d diffJSON
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/versions/"+next.ID+"/diff", nil, &d)
	if d.From != cur.ID || len(d.Changes) != 1 {
		t.Errorf("default diff = %+v, want against %s (not %s)", d, cur.ID, old.ID)
	}

	// against must belong to the same scorecard and exist.
	foreign := publishedVersion(t, e, "other", "Foreign", "2026-M01", sampleMethodology(90))
	e.expectError(t, 400, "invalid", viewer, "GET", "/scorecards/delivery/versions/"+next.ID+"/diff?against="+foreign.ID, nil)
	e.expectError(t, 400, "invalid", viewer, "GET", "/scorecards/delivery/versions/"+next.ID+"/diff?against=ghost", nil)
	e.expectError(t, 400, "invalid", viewer, "GET", "/scorecards/delivery/versions/"+next.ID+"/diff?against=bad!id", nil)
	e.expectError(t, 404, "not_found", viewer, "GET", "/scorecards/delivery/versions/ghost/diff?against="+cur.ID, nil)
}

func TestVersionAccessIsTenantScoped(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	v := publishedVersion(t, e, "delivery", "Baseline", "2026-M01", sampleMethodology(90))
	other := e.tokens["t2-admin"]

	e.expectError(t, 404, "not_found", other, "GET", "/scorecards/delivery/versions", nil)
	e.expectError(t, 404, "not_found", other, "GET", "/scorecards/delivery/versions/"+v.ID, nil)
	e.expectError(t, 404, "not_found", other, "GET", "/scorecards/delivery/versions/"+v.ID+"/diff?against="+v.ID, nil)
	e.expectError(t, 404, "not_found", other, "POST", "/scorecards/delivery/versions", map[string]any{"name": "X"})
	e.expectError(t, 404, "not_found", other, "PUT", "/scorecards/delivery/versions/"+v.ID,
		map[string]any{"revision": 1, "content": sampleMethodology(80)})
	e.expectError(t, 404, "not_found", other, "POST", "/scorecards/delivery/versions/"+v.ID+"/validate", nil)
	e.expectError(t, 404, "not_found", other, "POST", "/scorecards/delivery/versions/"+v.ID+"/publish",
		map[string]any{"effectiveFrom": "2026-M07"})

	// Same IDs in another tenant do not collide: t2 can create its own.
	e.expect(t, 201, other, "POST", "/scorecards", map[string]any{"id": "delivery", "name": "Theirs"}, nil)
	e.expectError(t, 404, "not_found", other, "GET", "/scorecards/delivery/versions/"+v.ID, nil)
	// A scorecard that does not exist is 404 for its own tenant too.
	e.expectError(t, 404, "not_found", e.tokens["t1-viewer"], "GET", "/scorecards/ghost/versions", nil)
}

func TestCloneFromOtherScorecardIsRejected(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	seedScorecard(t, e, "delivery")
	seedScorecard(t, e, "other")
	foreign := newDraft(t, e, "other", "Foreign", "")

	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions",
		map[string]any{"name": "Clone", "cloneFrom": foreign.ID})
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions",
		map[string]any{"name": "Clone", "cloneFrom": "ghost"})
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions",
		map[string]any{"name": "Clone", "cloneFrom": "bad!id"})
	var list struct{ Versions []versionJSON }
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/versions", nil, &list)
	if len(list.Versions) != 0 {
		t.Errorf("rejected clone created %+v", list.Versions)
	}
}

func TestPublishSameEffectiveFromConflicts(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	publishedVersion(t, e, "delivery", "First", "2026-M04", sampleMethodology(90))
	second := saveDraft(t, e, newDraft(t, e, "delivery", "Second", ""), sampleMethodology(95))

	e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "POST", "/scorecards/delivery/versions/"+second.ID+"/publish",
		map[string]any{"effectiveFrom": "2026-M04"})
	if got := getVersion(t, e, "delivery", second.ID); got.Status != "draft" {
		t.Errorf("rejected publish changed status: %+v", got)
	}
	// A different month works.
	publish(t, e, second, "2026-M05")

	// Superseded versions hold their month too.
	third := saveDraft(t, e, newDraft(t, e, "delivery", "Third", ""), sampleMethodology(80))
	e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "POST", "/scorecards/delivery/versions/"+third.ID+"/publish",
		map[string]any{"effectiveFrom": "2026-M04"})
}

func TestPublishValidatesEffectiveFrom(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	seedScorecard(t, e, "delivery")
	v := saveDraft(t, e, newDraft(t, e, "delivery", "Draft", ""), sampleMethodology(90))
	for _, from := range []string{"", "2026-Q1", "2026-FY", "nonsense", "2026-M13"} {
		e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions/"+v.ID+"/publish",
			map[string]any{"effectiveFrom": from})
	}
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions/"+v.ID+"/publish", `{`)
}

func TestPublishSupersedesOnlyThePredecessor(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	m := sampleMethodology(90)
	v1 := publishedVersion(t, e, "delivery", "V1", "2026-M01", m)
	v3 := publishedVersion(t, e, "delivery", "V3", "2026-M07", m)
	status := func(id string) string { return getVersion(t, e, "delivery", id).Status }

	// v1 was in force immediately before M07.
	if status(v1.ID) != "superseded" || status(v3.ID) != "published" {
		t.Fatalf("after v3: v1=%s v3=%s", status(v1.ID), status(v3.ID))
	}

	// Publishing between them supersedes v1 (already) and leaves the later v3 alone.
	v2 := publishedVersion(t, e, "delivery", "V2", "2026-M04", m)
	if status(v1.ID) != "superseded" || status(v2.ID) != "published" || status(v3.ID) != "published" {
		t.Fatalf("after v2: v1=%s v2=%s v3=%s", status(v1.ID), status(v2.ID), status(v3.ID))
	}

	// Back-dating before everything supersedes nobody.
	v0 := publishedVersion(t, e, "delivery", "V0", "2025-M06", m)
	if status(v0.ID) != "published" || status(v2.ID) != "published" || status(v3.ID) != "published" {
		t.Fatalf("after v0: v0=%s v2=%s v3=%s", status(v0.ID), status(v2.ID), status(v3.ID))
	}
	if status(v1.ID) != "superseded" {
		t.Fatalf("v1 = %s", status(v1.ID))
	}

	// An unpublished draft is never touched.
	draft := newDraft(t, e, "delivery", "Draft", "")
	publishedVersion(t, e, "delivery", "V4", "2026-M10", m)
	if status(draft.ID) != "draft" {
		t.Errorf("draft status = %s", status(draft.ID))
	}
}

func TestMethodologyIDsAreValidated(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	seedScorecard(t, e, "delivery")
	v := newDraft(t, e, "delivery", "Draft", "")

	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/bad!id/versions", nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/versions/bad!id", nil)
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions", map[string]any{"name": " "})
	e.expectError(t, 400, "invalid", admin, "PUT", "/scorecards/delivery/versions/"+v.ID,
		map[string]any{"revision": -1, "content": sampleMethodology(90)})
	e.expectError(t, 400, "invalid", admin, "PUT", "/scorecards/delivery/versions/"+v.ID,
		map[string]any{"revision": 1, "name": " ", "content": sampleMethodology(90)})
	e.expectError(t, 401, "unauthorized", "", "GET", "/scorecards/delivery/versions", nil)
}

func TestResponsesNeverContainNullArrays(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	v := newDraft(t, e, "delivery", "Empty", "")

	_, raw := e.call(t, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions/"+v.ID, nil)
	for _, want := range []string{`"categories":[]`, `"measures":[]`, `"metrics":[]`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("response lacks %s: %s", want, raw)
		}
	}

	// A sparse body (omitted arrays) is stored and returned as empty arrays.
	var out versionJSON
	e.expect(t, 200, e.tokens["t1-admin"], "PUT", "/scorecards/delivery/versions/"+v.ID,
		`{"revision":1,"name":"Renamed","content":{"metrics":[{"key":"m","name":"M","categoryId":"c","formula":"1","format":"number0","direction":"higher_better","frequency":"monthly","rule":{"type":"bands"}}]}}`, &out)
	if out.Name != "Renamed" {
		t.Errorf("name = %q", out.Name)
	}
	_, raw = e.call(t, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions/"+v.ID, nil)
	if strings.Contains(string(raw), "null") {
		t.Errorf("response contains null: %s", raw)
	}
	for _, want := range []string{`"reportedAt":[]`, `"targets":[]`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("response lacks %s: %s", want, raw)
		}
	}
}

func TestListVersionsNewestFirst(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	m := sampleMethodology(90)
	old := publishedVersion(t, e, "delivery", "Old", "2026-M01", m)
	cur := publishedVersion(t, e, "delivery", "Current", "2026-M04", m)
	draft := newDraft(t, e, "delivery", "Draft", "")

	var list struct{ Versions []versionJSON }
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions", nil, &list)
	var got []string
	for _, v := range list.Versions {
		got = append(got, v.ID)
	}
	want := []string{draft.ID, cur.ID, old.ID}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("order = %v, want %v", got, want)
	}
}

// derivedSample is sampleMethodology plus derived measures that exercise every
// DeriveRule field.
func derivedSample() domain.Methodology {
	m := sampleMethodology(90)
	m.Measures = append(m.Measures,
		domain.Measure{
			Key: "defect_points_sum", Name: "Defect points", Unit: "points", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureDerived,
			Derive: &domain.DeriveRule{
				RecordType: "defect", Op: domain.OpDailyOpenWeighted,
				Where:   "category in ['bug', 'defect']",
				Weights: map[string]float64{"P1": 64, "P2": 16, "P3": 4, "P4": 2, "none": 1},
			},
		},
		domain.Measure{
			Key: "epics_on_time", Name: "Epics on time", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureDerived,
			Derive: &domain.DeriveRule{
				RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeMet,
				BucketBy: "dueAt", Where: "state == 'done'",
			},
		},
		domain.Measure{
			Key: "idea_age_days_sum", Name: "Idea age", Unit: "days", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureDerived,
			Derive: &domain.DeriveRule{
				RecordType: "idea", Op: domain.OpAgeSum,
				BucketBy: "completedAt", AgeFrom: "createdAt", AgeTo: "completedAt",
			},
		},
		domain.Measure{
			Key: "planned_spend_k", Name: "Planned spend", Unit: "$k", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureDerived,
			Derive: &domain.DeriveRule{RecordType: "release", Op: domain.OpSum, BucketBy: "completedAt", Field: "planned"},
		},
		domain.Measure{
			Key: "defect_days", Name: "Defect days", Unit: "days", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureDerived,
			Derive: &domain.DeriveRule{RecordType: "defect", Op: domain.OpDaysInPeriod},
		},
		domain.Measure{
			Key: "typed_total", Name: "Typed total", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureEntered,
		},
	)
	return m
}

func TestDerivedMeasureRoundTrip(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	want := derivedSample()

	saved := saveDraft(t, e, newDraft(t, e, "delivery", "Derived", ""), want)
	if !reflect.DeepEqual(saved.Content.Measures, want.Measures) {
		t.Fatalf("PUT response measures:\n got %+v\nwant %+v", saved.Content.Measures, want.Measures)
	}
	got := getVersion(t, e, "delivery", saved.ID)
	if !reflect.DeepEqual(got.Content.Measures, want.Measures) {
		t.Fatalf("GET measures:\n got %+v\nwant %+v", got.Content.Measures, want.Measures)
	}

	// An entered measure with no source stays free of derived fields on the wire.
	status, raw := e.call(t, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/versions/"+saved.ID, nil)
	var wire struct {
		Content struct {
			Measures []map[string]any `json:"measures"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &wire); status != 200 || err != nil || len(wire.Content.Measures) == 0 {
		t.Fatalf("GET = %d %v %s", status, err, raw)
	}
	for _, k := range []string{"source", "derive"} {
		if _, ok := wire.Content.Measures[0][k]; ok {
			t.Errorf("entered measure carries %q on the wire: %v", k, wire.Content.Measures[0])
		}
	}

	// A clone carries the rules too.
	clone := newDraft(t, e, "delivery", "Clone", saved.ID)
	if !reflect.DeepEqual(clone.Content.Measures, want.Measures) {
		t.Errorf("clone measures = %+v", clone.Content.Measures)
	}
}

func TestDerivedMeasureWithoutRuleFailsPublish(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	m := sampleMethodology(90)
	m.Measures[1].Source = domain.MeasureDerived // no derive rule
	v := saveDraft(t, e, newDraft(t, e, "delivery", "NoRule", ""), m)

	got := e.expectError(t, 400, "invalid", e.tokens["t1-admin"], "POST", "/scorecards/delivery/versions/"+v.ID+"/publish",
		map[string]any{"effectiveFrom": "2026-M01"})
	found := false
	for _, d := range got.Error.Details {
		if d.Path == "measures[1].derive" {
			found = true
		}
	}
	if !found {
		t.Errorf("details = %+v, want measures[1].derive", got.Error.Details)
	}
}

// putMonthPoint stores one value in sc for the given month.
func putMonthPoint(t *testing.T, e *testEnv, sc string, p period.Period) {
	t.Helper()
	v := 1.0
	_, err := e.store.PutDataPoints(context.Background(), "t1", sc, []store.DataWrite{{
		Point: domain.DataPoint{
			MeasureKey: "closed", SubjectID: "team-a", Period: p, Value: &v,
			Source: "test", EnteredBy: "u-t1-admin", EnteredAt: testNow,
		},
		ExpectedRevision: store.Unconditional,
	}})
	if err != nil {
		t.Fatal(err)
	}
}

type scorecardSummaryJSON struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	LatestDataMonth *string `json:"latestDataMonth"`
}

func listSummaries(t *testing.T, e *testEnv) map[string]scorecardSummaryJSON {
	t.Helper()
	var list struct {
		Scorecards []scorecardSummaryJSON `json:"scorecards"`
	}
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards", nil, &list)
	out := map[string]scorecardSummaryJSON{}
	for _, sc := range list.Scorecards {
		out[sc.ID] = sc
	}
	return out
}

func TestScorecardsListLatestDataMonth(t *testing.T) {
	e := newTestEnv(t) // testNow is 2026-M10, so FY2026 and FY2025 are in range
	for _, id := range []string{"empty", "current", "previous", "old", "mixed"} {
		seedScorecard(t, e, id)
	}
	month := func(fy, idx int) period.Period { return period.Period{Grain: period.Month, FY: fy, Index: idx} }
	putMonthPoint(t, e, "current", month(2026, 3))
	putMonthPoint(t, e, "current", month(2026, 8))
	putMonthPoint(t, e, "current", month(2025, 12))
	putMonthPoint(t, e, "previous", month(2025, 4))
	putMonthPoint(t, e, "previous", month(2025, 11))
	putMonthPoint(t, e, "old", month(2024, 12)) // two fiscal years back: out of range
	putMonthPoint(t, e, "mixed", month(2025, 6))
	putMonthPoint(t, e, "mixed", period.Period{Grain: period.Year, FY: 2026}) // not month grain

	got := listSummaries(t, e)
	want := map[string]string{"current": "2026-M08", "previous": "2025-M11", "mixed": "2025-M06"}
	for id, w := range want {
		if got[id].LatestDataMonth == nil || *got[id].LatestDataMonth != w {
			t.Errorf("%s latestDataMonth = %v, want %s", id, got[id].LatestDataMonth, w)
		}
	}
	for _, id := range []string{"empty", "old"} {
		if got[id].LatestDataMonth != nil {
			t.Errorf("%s latestDataMonth = %s, want null", id, *got[id].LatestDataMonth)
		}
	}
}

func TestScorecardsListNullLatestDataMonthOnTheWire(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "empty")
	_, raw := e.call(t, e.tokens["t1-viewer"], "GET", "/scorecards", nil)
	if !strings.Contains(string(raw), `"latestDataMonth":null`) {
		t.Fatalf("response %s must carry an explicit null latestDataMonth", raw)
	}
}
