package records

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

// incidentTemplates reads the three sample templates of spec §7.2, keyed
// tracker, oncall and status_page.
func incidentTemplates(t testing.TB) map[string]Template {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "incidents_templates.json"))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]Template
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// normalizeSample normalizes one sample export with its template and fails
// on any problem.
func normalizeSample(t *testing.T, tpl, file string) map[string]Row {
	t.Helper()
	rt := IncidentPreset()
	tp := incidentTemplates(t)[tpl]
	if errs := tp.Validate(rt); errs != nil {
		t.Fatalf("%s template: %v", tpl, errs)
	}
	rows, skipped, problems := Normalize(tp, rt, readFixtureCSV(t, file))
	if len(problems) != 0 || skipped != 0 {
		t.Fatalf("%s: skipped %d, problems %+v", file, skipped, problems)
	}
	out := map[string]Row{}
	for _, r := range rows {
		if _, dup := out[r.ExternalID]; dup {
			t.Fatalf("%s: %s twice", file, r.ExternalID)
		}
		out[r.ExternalID] = r
	}
	return out
}

func TestIncidentPreset(t *testing.T) {
	rt := IncidentPreset()
	if rt.ID != "incident" || rt.Name != "Incident" {
		t.Fatalf("preset = %+v", rt)
	}
	if want := []string{"SEV1", "SEV2", "SEV3", "SEV4"}; !reflect.DeepEqual(rt.Priorities, want) {
		t.Fatalf("priorities = %v", rt.Priorities)
	}
	types := map[string]domain.AttrType{}
	for _, a := range rt.Attributes {
		types[a.Key] = a.Type
	}
	want := map[string]domain.AttrType{"startedAt": domain.AttrDateTime, "endedAt": domain.AttrDateTime,
		"minutesDown": domain.AttrNumber, "impactPct": domain.AttrNumber}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("attributes = %v, want %v", types, want)
	}
	if errs := rt.Validate(); errs != nil {
		t.Fatalf("preset is invalid: %v", errs)
	}
	// A downtime link is valid on the preset.
	rt.Explains = []domain.ExplainLink{{ScorecardID: "sf", MetricKey: "uptime", Mode: domain.ExplainDowntime}}
	if errs := rt.Validate(); errs != nil {
		t.Fatalf("preset with a downtime link is invalid: %v", errs)
	}
}

func TestIncidentTrackerSample(t *testing.T) {
	rows := normalizeSample(t, "tracker", "incidents_tracker.csv")
	if len(rows) != 7 {
		t.Fatalf("records = %d, want 7 (six rows, INC-2049 fans out to two)", len(rows))
	}
	web, search := rows["INC-2049@Webhooks"], rows["INC-2049@Search"]
	if web.ExternalID == "" || search.ExternalID == "" {
		t.Fatalf("INC-2049 did not fan out: %v", keysOf(rows))
	}
	if web.Fields.GroupKey != "INC-2049" || search.Fields.GroupKey != "INC-2049" {
		t.Fatalf("group keys = %q, %q", web.Fields.GroupKey, search.Fields.GroupKey)
	}
	if web.Fields.SubjectKey != "Webhooks" || search.Fields.SubjectKey != "Search" || web.RowNum != search.RowNum {
		t.Fatalf("fan-out subjects = %q, %q (rows %d, %d)", web.Fields.SubjectKey, search.Fields.SubjectKey, web.RowNum, search.RowNum)
	}
	if got := web.Fields.Attributes["startedAt"]; got != "2026-10-17T11:20:00Z" {
		t.Fatalf("startedAt = %#v", got)
	}
	if got := web.Fields.Attributes["endedAt"]; got != "2026-10-17T11:50:00Z" {
		t.Fatalf("endedAt = %#v", got)
	}
	if !reflect.DeepEqual(web.Fields.Attributes, search.Fields.Attributes) || web.Fields.Title != search.Fields.Title {
		t.Fatal("fan-out records should share every field but the subject and identity")
	}

	// One listed service still fans out, so a service added later keeps the identity.
	first := rows["INC-2041@Webhooks"]
	f := first.Fields
	if f.GroupKey != "INC-2041" || f.Priority != "SEV2" || f.State != domain.StateDone || f.CreatedAt.String() != "2026-10-03" ||
		f.CompletedAt.String() != "2026-10-04" || f.URL != "https://tracker.example/browse/INC-2041" || f.Category != "Incident" {
		t.Fatalf("INC-2041 = %+v", f)
	}
	if f.Attributes["impactPct"] != float64(100) {
		t.Fatalf("impactPct = %#v", f.Attributes["impactPct"])
	}
	if got := rows["INC-2058@Webhooks"].Fields.State; got != domain.StateCancelled {
		t.Fatalf("INC-2058 state = %q, want cancelled", got)
	}
	if got := rows["INC-2055@Search"].Fields.Category; got != "Maintenance" {
		t.Fatalf("INC-2055 category = %q", got)
	}
}

func TestIncidentOncallSample(t *testing.T) {
	rows := normalizeSample(t, "oncall", "incidents_oncall.csv")
	if len(rows) != 3 {
		t.Fatalf("records = %v", keysOf(rows))
	}
	r := rows["88412"]
	if r.Fields.GroupKey != "" {
		t.Fatalf("no separator, no fan-out: group key %q", r.Fields.GroupKey)
	}
	if got := r.Fields.Attributes["startedAt"]; got != "2026-10-09T01:14:00Z" {
		t.Fatalf("88412 startedAt = %#v", got)
	}
	if got := r.Fields.Attributes["endedAt"]; got != "2026-10-09T01:58:00Z" {
		t.Fatalf("88412 endedAt = %#v", got)
	}
	if r.Fields.CreatedAt.String() != "2026-10-08" {
		t.Fatalf("88412 createdAt = %s, want the local date 2026-10-08", r.Fields.CreatedAt)
	}
	if got := rows["88507"].Fields.Attributes["startedAt"]; got != "2026-10-12T06:02:00Z" {
		t.Fatalf("88507 startedAt = %#v", got)
	}
	open := rows["88533"].Fields
	if open.State != domain.StateOpen || open.CompletedAt != nil {
		t.Fatalf("88533 = %+v, want open", open)
	}
	if _, ok := open.Attributes["endedAt"]; ok {
		t.Fatalf("88533 has an endedAt: %#v", open.Attributes)
	}
	if open.Priority != "SEV4" || open.URL != "https://oncall.example/incidents/88533" {
		t.Fatalf("88533 = %+v", open)
	}
}

func TestIncidentStatusPageSample(t *testing.T) {
	rows := normalizeSample(t, "status_page", "incidents_status_page.csv")
	if len(rows) != 3 {
		t.Fatalf("records = %v", keysOf(rows))
	}
	for _, id := range []string{"sp-7h1q@Webhooks", "sp-7h1q@Notifications"} {
		r, ok := rows[id]
		if !ok {
			t.Fatalf("no %s in %v", id, keysOf(rows))
		}
		if r.Fields.Attributes["impactPct"] != float64(50) || r.Fields.GroupKey != "sp-7h1q" || r.Fields.Priority != "SEV2" {
			t.Fatalf("%s = %+v", id, r.Fields)
		}
	}
	if got := rows["sp-7f3k@Search"].Fields.Attributes["impactPct"]; got != float64(25) {
		t.Fatalf("degraded_performance impactPct = %#v", got)
	}
	if got := rows["sp-7h1q@Webhooks"].Fields.Attributes["startedAt"]; got != "2026-10-03T14:00:00Z" {
		t.Fatalf("startedAt = %#v", got)
	}
}

func TestIncidentRowErrors(t *testing.T) {
	rt := IncidentPreset()
	tpl := incidentTemplates(t)["tracker"]
	headers := []string{"Issue key", "Issue Type", "Summary", "Priority", "Status", "Components", "Incident start", "Incident end", "Customer impact", "Created", "Resolved"}
	row := func(id, start, end, impact string) []string {
		return []string{id, "Incident", "x", "SEV-2", "Resolved", "Webhooks", start, end, impact, "2026-10-03 14:09", "2026-10-04 10:00"}
	}
	tbl := csvTable(headers,
		row("INC-1", "2026-10-03 14:05", "2026-10-03 13:00", "100%"),
		row("INC-2", "2026-10-03 14:05", "2026-10-03 15:00", "0%"),
		row("INC-3", "2026-10-03 14:05", "2026-10-03 15:00", "-5"),
		row("INC-4", "2026-10-03 14:05", "2026-10-03 15:00", "150%"),
		row("INC-5", "2026-10-03 14:05", "2026-10-03 15:00", "84%"),
		row("INC-6", "2026-10-03 14:05", "2026-10-03 14:05", ""),
	)
	rows, _, problems := Normalize(tpl, rt, tbl)
	if len(rows) != 2 || rows[0].ExternalID != "INC-5@Webhooks" || rows[1].ExternalID != "INC-6@Webhooks" {
		t.Fatalf("rows = %+v, problems = %+v", rows, problems)
	}
	if got := rows[0].Fields.Attributes["impactPct"]; got != float64(84) {
		t.Fatalf("84%% reads as %#v", got)
	}
	want := []struct {
		row          int
		field, value string
		msg          string
	}{
		{2, "endedAt", "2026-10-03 13:00", "Ended before it started"},
		{3, "impactPct", "0%", "Impact must be more than 0 and at most 100"},
		{4, "impactPct", "-5", "Impact must be more than 0 and at most 100"},
		{5, "impactPct", "150%", "Impact must be more than 0 and at most 100"},
	}
	if len(problems) != len(want) {
		t.Fatalf("problems = %+v", problems)
	}
	for i, w := range want {
		p := problems[i]
		if p.RowNum != w.row || p.Field != w.field || p.Value != w.value || p.Message != w.msg || p.Kind != ProblemError {
			t.Errorf("problem %d = %+v, want %+v", i, p, w)
		}
	}
	if problems[0].Column != "Incident end" || problems[1].Column != "Customer impact" {
		t.Errorf("columns = %q, %q", problems[0].Column, problems[1].Column)
	}
}

func TestIncidentNegativeMinutesDown(t *testing.T) {
	rt := IncidentPreset()
	tpl := incidentTemplates(t)["tracker"]
	tpl.Attributes["minutesDown"] = FieldMap{Column: "Down", Unit: "s"}
	headers := []string{"Issue key", "Issue Type", "Summary", "Priority", "Status", "Components", "Incident start", "Incident end", "Customer impact", "Created", "Resolved", "Down"}
	row := func(id, down string) []string {
		return []string{id, "Incident", "x", "SEV-2", "Resolved", "Webhooks", "2026-10-03 14:05", "2026-10-03 15:00", "100%", "2026-10-03 14:09", "2026-10-04 10:00", down}
	}
	rows, _, problems := Normalize(tpl, rt, csvTable(headers, row("INC-1", "-1800"), row("INC-2", "0"), row("INC-3", "1800")))
	if len(rows) != 2 || rows[0].ExternalID != "INC-2@Webhooks" || rows[1].Fields.Attributes["minutesDown"] != float64(30) {
		t.Fatalf("rows = %+v, problems = %+v", rows, problems)
	}
	if len(problems) != 1 || problems[0].RowNum != 2 || problems[0].Field != "minutesDown" || problems[0].Value != "-1800" ||
		problems[0].Message != "Minutes down must be 0 or more" || problems[0].Column != "Down" {
		t.Fatalf("problems = %+v", problems)
	}
}

func TestValidateExplainWhere(t *testing.T) {
	rt := IncidentPreset()
	rt.Explains = []domain.ExplainLink{
		{ScorecardID: "sf", MetricKey: "uptime", Mode: domain.ExplainDowntime, Where: "category != 'maintenance' && startedAt >= '2026-10-01T00:00:00Z'"},
		{ScorecardID: "sf", MetricKey: "postmortems_on_time", Mode: domain.ExplainList, Where: "nope == 1"},
	}
	errs := ValidateExplainWhere(rt)
	if len(errs) != 1 || errs[0].Path != "explains[1].where" || !strings.Contains(errs[0].Message, "unknown field") {
		t.Fatalf("errors = %v", errs)
	}
}

func keysOf(m map[string]Row) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
