package records

import (
	"strings"
	"testing"

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
