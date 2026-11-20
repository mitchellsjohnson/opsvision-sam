package records

import (
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
)

var defectType = domain.RecordType{
	ID:         "defect",
	Name:       "Defect",
	Priorities: []string{"P1", "P2", "P3", "P4"},
	Attributes: []domain.AttributeDef{
		{Key: "customerTicket", Name: "Customer ticket", Type: domain.AttrBool},
		{Key: "severity", Name: "Severity", Type: domain.AttrNumber},
		{Key: "team", Name: "Team", Type: domain.AttrString},
		{Key: "reviewedAt", Name: "Reviewed", Type: domain.AttrDate},
	},
}

func mustCompile(t *testing.T, src string) *Cond {
	t.Helper()
	c, err := CompileWhere(src, defectType)
	if err != nil {
		t.Fatalf("CompileWhere(%q): %v", src, err)
	}
	return c
}

func mustMatch(t *testing.T, c *Cond, f domain.RecordFields) bool {
	t.Helper()
	ok, err := c.Match(f)
	if err != nil {
		t.Fatalf("Match(%+v): %v", f, err)
	}
	return ok
}

func TestWhereEmptyMatchesEverything(t *testing.T) {
	for _, src := range []string{"", "   "} {
		if !mustMatch(t, mustCompile(t, src), domain.RecordFields{}) {
			t.Errorf("CompileWhere(%q) did not match", src)
		}
	}
}

func TestWhereCompileErrors(t *testing.T) {
	cases := []struct {
		name, src, want string
	}{
		{"unknown field", "nope == 'x'", `unknown field "nope" on record type "defect"`},
		{"type mismatch", "priority > 3", "mismatched types string and int"},
		{"function call", "len(title) > 3", "function calls are not allowed"},
		{"function call by name", "upper(title) == 'X'", "function calls are not allowed"},
		{"non-bool result", "planned + 1", "must be true or false"},
		{"non-bool string", "title", "must be true or false"},
		{"member access", "title.size > 1", "not allowed"},
		{"nil literal", "dueAt == nil", "nil is not allowed"},
		{"operator", "title matches 'x'", `operator "matches" is not allowed`},
		{"ternary", "customerTicket ? true : false", "not allowed"},
		{"list outside in", "['a'] == ['a']", "list"},
		{"unknown priority", "priority in ['P1', 'P9']", `unknown priority "P9"`},
		{"unknown state", "state == 'closed'", `unknown state "closed"`},
		{"parse error", "state ==", "where:"},
		{"too long", "title == '" + strings.Repeat("x", 1000) + "'", "too long"},
		{"attributes map", "attributes == 1", `unknown field "attributes"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := CompileWhere(c.src, defectType)
			if err == nil {
				t.Fatalf("CompileWhere(%q) succeeded, want error containing %q", c.src, c.want)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("CompileWhere(%q) error = %q, want it to contain %q", c.src, err, c.want)
			}
			if !strings.HasPrefix(err.Error(), "where: ") {
				t.Errorf("error %q should start with \"where: \"", err)
			}
		})
	}
}

func TestWhereAttributes(t *testing.T) {
	c := mustCompile(t, "customerTicket && category in ['bug','defect']")
	cases := []struct {
		name string
		f    domain.RecordFields
		want bool
	}{
		{"bug with ticket", domain.RecordFields{Category: "bug", Attributes: map[string]any{"customerTicket": true}}, true},
		{"defect with ticket", domain.RecordFields{Category: "defect", Attributes: map[string]any{"customerTicket": true}}, true},
		{"feature with ticket", domain.RecordFields{Category: "feature", Attributes: map[string]any{"customerTicket": true}}, false},
		{"bug without ticket", domain.RecordFields{Category: "bug", Attributes: map[string]any{"customerTicket": false}}, false},
		{"bug, attribute missing", domain.RecordFields{Category: "bug"}, false},
	}
	for _, tc := range cases {
		if got := mustMatch(t, c, tc.f); got != tc.want {
			t.Errorf("%s: match = %v, want %v", tc.name, got, tc.want)
		}
	}

	if !mustMatch(t, mustCompile(t, "category not in ['bug']"), domain.RecordFields{Category: "feature"}) {
		t.Error("not in: feature should match")
	}
	// A missing attribute is the zero value of its type.
	if !mustMatch(t, mustCompile(t, "!customerTicket && team == '' && severity == 0"), domain.RecordFields{}) {
		t.Error("missing attributes should be false, empty and 0")
	}
	if !mustMatch(t, mustCompile(t, "severity >= 2"), domain.RecordFields{Attributes: map[string]any{"severity": 3}}) {
		t.Error("an integer attribute should compare as a number")
	}
	if _, err := mustCompile(t, "severity >= 2").Match(domain.RecordFields{Attributes: map[string]any{"severity": "high"}}); err == nil ||
		!strings.Contains(err.Error(), `attribute "severity"`) {
		t.Errorf("wrong-typed attribute: err = %v, want an error naming the attribute", err)
	}
}

func TestWhereStateAndPriority(t *testing.T) {
	c := mustCompile(t, "state == 'done' && priority in ['P1', 'none']")
	if !mustMatch(t, c, domain.RecordFields{State: domain.StateDone, Priority: "P1"}) {
		t.Error("done P1 should match")
	}
	if !mustMatch(t, c, domain.RecordFields{State: domain.StateDone}) {
		t.Error("a record with no priority has priority none")
	}
	if mustMatch(t, c, domain.RecordFields{State: domain.StateOpen, Priority: "P1"}) {
		t.Error("open P1 should not match")
	}
}

func TestWhereDates(t *testing.T) {
	onTime := mustCompile(t, "completedAt <= dueAt")
	late := mustCompile(t, "completedAt > dueAt")
	notOnTime := mustCompile(t, "!(completedAt <= dueAt)")
	cases := []struct {
		name                string
		f                   domain.RecordFields
		onTime, late, notOn bool
	}{
		{"early", domain.RecordFields{DueAt: dp("2027-01-31"), CompletedAt: dp("2027-01-20")}, true, false, false},
		{"same day", domain.RecordFields{DueAt: dp("2027-01-31"), CompletedAt: dp("2027-01-31")}, true, false, false},
		{"late", domain.RecordFields{DueAt: dp("2027-01-31"), CompletedAt: dp("2027-02-01")}, false, true, true},
		{"not completed", domain.RecordFields{DueAt: dp("2027-01-31")}, false, false, false},
		{"no due date", domain.RecordFields{CompletedAt: dp("2027-01-20")}, false, false, false},
		{"neither", domain.RecordFields{}, false, false, false},
	}
	for _, tc := range cases {
		if got := mustMatch(t, onTime, tc.f); got != tc.onTime {
			t.Errorf("%s: completedAt <= dueAt = %v, want %v", tc.name, got, tc.onTime)
		}
		if got := mustMatch(t, late, tc.f); got != tc.late {
			t.Errorf("%s: completedAt > dueAt = %v, want %v", tc.name, got, tc.late)
		}
		if got := mustMatch(t, notOnTime, tc.f); got != tc.notOn {
			t.Errorf("%s: !(completedAt <= dueAt) = %v, want %v", tc.name, got, tc.notOn)
		}
	}

	// A missing date on one side of || does not hide a match on the other.
	either := mustCompile(t, "completedAt <= dueAt || state == 'cancelled'")
	if !mustMatch(t, either, domain.RecordFields{State: domain.StateCancelled}) {
		t.Error("cancelled with no dates should match the || branch")
	}

	// Missing numbers never match a comparison either, even inside arithmetic.
	budget := mustCompile(t, "state == 'done' && actual <= planned * 1.2")
	if !mustMatch(t, budget, domain.RecordFields{State: domain.StateDone, Planned: num(100), Actual: num(110)}) {
		t.Error("110 <= 100 * 1.2 should match")
	}
	if mustMatch(t, budget, domain.RecordFields{State: domain.StateDone, Actual: num(110)}) {
		t.Error("missing planned should not match")
	}
	if mustMatch(t, budget, domain.RecordFields{State: domain.StateDone, Planned: num(100)}) {
		t.Error("missing actual should not match")
	}

	// Date attributes accept the stored string form; a missing one is no date.
	reviewed := mustCompile(t, "reviewedAt <= completedAt")
	if !mustMatch(t, reviewed, domain.RecordFields{CompletedAt: dp("2027-01-20"), Attributes: map[string]any{"reviewedAt": "2027-01-10"}}) {
		t.Error("string date attribute should compare as a date")
	}
	if !mustMatch(t, reviewed, domain.RecordFields{CompletedAt: dp("2027-01-20"), Attributes: map[string]any{"reviewedAt": day("2027-01-20")}}) {
		t.Error("Date attribute should compare as a date")
	}
	if mustMatch(t, reviewed, domain.RecordFields{CompletedAt: dp("2027-01-20")}) {
		t.Error("missing date attribute should not match")
	}

	// A zero createdAt is no date.
	if mustMatch(t, mustCompile(t, "createdAt <= completedAt"), domain.RecordFields{CompletedAt: dp("2027-01-20")}) {
		t.Error("zero createdAt should not match")
	}

	// priorDueDates is a list of dates usable with in.
	slipped := mustCompile(t, "dueAt in priorDueDates")
	if !mustMatch(t, slipped, domain.RecordFields{DueAt: dp("2027-01-31"), PriorDueDates: []domain.Date{day("2026-12-31"), day("2027-01-31")}}) {
		t.Error("dueAt in priorDueDates should match")
	}
	if mustMatch(t, slipped, domain.RecordFields{PriorDueDates: []domain.Date{day("2026-12-31")}}) {
		t.Error("missing dueAt should not match in")
	}
}

func TestWhereDateTimes(t *testing.T) {
	rt := IncidentPreset()
	compile := func(src string) *Cond {
		t.Helper()
		c, err := CompileWhere(src, rt)
		if err != nil {
			t.Fatalf("CompileWhere(%q): %v", src, err)
		}
		return c
	}
	at := func(start string) domain.RecordFields {
		return domain.RecordFields{Attributes: map[string]any{"startedAt": start}}
	}

	from := compile("startedAt >= '2026-10-01T00:00:00Z'")
	cases := []struct {
		start string
		want  bool
	}{
		{"2026-10-01T00:00:00Z", true},
		{"2026-09-30T23:59:00Z", false},
		{"2026-10-17T11:20:00Z", true},
	}
	for _, tc := range cases {
		if got := mustMatch(t, from, at(tc.start)); got != tc.want {
			t.Errorf("startedAt %s >= Oct 1: %v, want %v", tc.start, got, tc.want)
		}
	}
	// Instants compare as instants, whatever offset the literal is written in.
	if !mustMatch(t, compile("startedAt < '2026-09-30T20:00:00-04:00'"), at("2026-09-30T23:59:00Z")) {
		t.Error("23:59Z is before 20:00-04:00 (00:00Z)")
	}
	if !mustMatch(t, compile("startedAt == '2026-10-01T02:00:00+02:00'"), at("2026-10-01T00:00:00Z")) {
		t.Error("equal instants in two offsets should be equal")
	}
	if !mustMatch(t, compile("startedAt in ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z']"), at("2026-10-02T00:00:00Z")) {
		t.Error("in [...] of instants should match")
	}
	// Two datetime fields compare with each other; a missing one never matches.
	ended := compile("endedAt > startedAt && category != 'maintenance'")
	if !mustMatch(t, ended, domain.RecordFields{Category: "incident", Attributes: map[string]any{"startedAt": "2026-10-01T00:00:00Z", "endedAt": "2026-10-01T01:00:00Z"}}) {
		t.Error("endedAt > startedAt should match")
	}
	if mustMatch(t, ended, at("2026-10-01T00:00:00Z")) || mustMatch(t, from, domain.RecordFields{}) {
		t.Error("a missing datetime should not match")
	}
	if mustMatch(t, compile("!(startedAt >= '2026-10-01T00:00:00Z')"), domain.RecordFields{}) {
		t.Error("! of an unknown comparison should stay unknown")
	}

	for src, want := range map[string]string{
		"startedAt >= '2026-10-01'":           "date and time",
		"startedAt >= 'soon'":                 "date and time",
		"startedAt >= '2026-10-01T00:00:00'":  "date and time",
		"startedAt in ['2026-10-01']":         "date and time",
		"startedAt >= createdAt":              "date and time",
		"startedAt > 5":                       "mismatched types",
		"createdAt >= '2026-10-01T00:00:00Z'": "mismatched types",
		"'2026-10-01' <= endedAt":             "date and time",
	} {
		_, err := CompileWhere(src, rt)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("CompileWhere(%q) error = %v, want it to mention %q", src, err, want)
		}
	}
}

func TestFieldDateTimeAndText(t *testing.T) {
	f := domain.RecordFields{GroupKey: "INC-2049", Attributes: map[string]any{"startedAt": "2026-10-09T01:14:00Z"}}
	got, ok, err := FieldDateTime(f, "startedAt")
	if err != nil || !ok || !got.Equal(time.Date(2026, 10, 9, 1, 14, 0, 0, time.UTC)) || got.Location() != time.UTC {
		t.Fatalf("FieldDateTime = %v, %v, %v", got, ok, err)
	}
	if _, ok, err := FieldDateTime(f, "endedAt"); ok || err != nil {
		t.Fatalf("missing endedAt = %v, %v", ok, err)
	}
	if _, _, err := FieldDateTime(domain.RecordFields{Attributes: map[string]any{"startedAt": "2026-10-09"}}, "startedAt"); err == nil {
		t.Fatal("a date-only value read as a datetime did not fail")
	}
	if s, ok, err := FieldText(f, "startedAt", domain.AttrDateTime); err != nil || !ok || s != "2026-10-09T01:14:00Z" {
		t.Fatalf("FieldText = %q, %v, %v", s, ok, err)
	}
	if !mustMatch(t, mustCompileFor(t, "groupKey == 'INC-2049'", IncidentPreset()), f) {
		t.Error("groupKey should be usable in conditions")
	}
}

func mustCompileFor(t *testing.T, src string, rt domain.RecordType) *Cond {
	t.Helper()
	c, err := CompileWhere(src, rt)
	if err != nil {
		t.Fatalf("CompileWhere(%q): %v", src, err)
	}
	return c
}

func TestFieldDate(t *testing.T) {
	due := day("2026-10-31")
	f := domain.RecordFields{CreatedAt: day("2026-09-03"), DueAt: &due,
		Attributes: map[string]any{"reviewedAt": "2026-09-10", "team": "Payments"}}
	for name, want := range map[string]string{"createdAt": "2026-09-03", "dueAt": "2026-10-31", "reviewedAt": "2026-09-10"} {
		got, ok, err := FieldDate(f, name)
		if err != nil || !ok || got.String() != want {
			t.Errorf("FieldDate(%s) = %v, %v, %v; want %s", name, got, ok, err, want)
		}
	}
	if _, ok, err := FieldDate(f, "completedAt"); ok || err != nil {
		t.Errorf("empty completedAt = %v, %v", ok, err)
	}
	if _, _, err := FieldDate(f, "team"); err == nil {
		t.Error("a string attribute read as a date did not fail")
	}
}
