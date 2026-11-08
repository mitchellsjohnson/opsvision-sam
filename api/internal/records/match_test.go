package records

import (
	"reflect"
	"testing"

	"opsvision/internal/domain"
)

var (
	acmeUnits = []domain.OrgUnit{
		{ID: "u-platform", Name: "Platform"},
		{ID: "u-checkout", Name: "Checkout", ParentID: "u-platform", SourceKeys: []string{"CHK"}},
		{ID: "u-pipelines", Name: "Pipelines", ParentID: "u-platform"},
		{ID: "u-billing", Name: "Billing", SourceKeys: []string{"Invoicing"}},
		{ID: "u-ios", Name: "iOS App"},
		{ID: "u-android", Name: "Android App"},
	}
	acmeItems = []domain.TrackedItem{
		{ID: "i-wallet", KindID: "app", Name: "Wallet Service", OrgUnitID: "u-checkout", SourceKeys: []string{"wallet-api"}},
	}
)

func suggestionFor(t *testing.T, got []SubjectSuggestion, value string) SubjectSuggestion {
	t.Helper()
	for _, s := range got {
		if s.Value == value {
			return s
		}
	}
	t.Fatalf("no suggestion for %q in %+v", value, got)
	return SubjectSuggestion{}
}

func TestFuzzySubject(t *testing.T) {
	values := map[string]int{
		"Checkout Svc":   5,
		"Pipelines team": 3,
		"Platform":       2,
		"Mystery Box":    1,
	}
	got := SuggestSubjects(values, acmeUnits, acmeItems)
	if len(got) != 4 {
		t.Fatalf("got %d suggestions: %+v", len(got), got)
	}

	co := suggestionFor(t, got, "Checkout Svc")
	if co.SubjectID != "u-checkout" || co.Score != 1.0 || co.Rows != 5 {
		t.Errorf("Checkout Svc = %+v", co)
	}
	pl := suggestionFor(t, got, "Pipelines team")
	if pl.SubjectID != "u-pipelines" || pl.Score != 1.0 || pl.Rows != 3 {
		t.Errorf("Pipelines team = %+v", pl)
	}
	// A parent unit is still suggested; the preview flags it (R7).
	pf := suggestionFor(t, got, "Platform")
	if pf.SubjectID != "u-platform" || pf.Score != 1.0 {
		t.Errorf("Platform = %+v", pf)
	}
	my := suggestionFor(t, got, "Mystery Box")
	if my.SubjectID != "" || my.Score != 0 || len(my.Candidates) != 0 {
		t.Errorf("Mystery Box = %+v, want no suggestion", my)
	}

	// Biggest groups first.
	order := []string{got[0].Value, got[1].Value, got[2].Value, got[3].Value}
	if !reflect.DeepEqual(order, []string{"Checkout Svc", "Pipelines team", "Platform", "Mystery Box"}) {
		t.Errorf("order = %q", order)
	}
}

func TestFuzzySubjectNormalization(t *testing.T) {
	cases := map[string]string{
		"checkout":          "u-checkout",
		"  CHECKOUT  ":      "u-checkout",
		"Checkout, Svc.":    "u-checkout",
		"Checkout Service":  "u-checkout",
		"Checkout App Team": "u-checkout",
		"iOS App":           "u-ios",
		"ios":               "u-ios",
		"Android":           "u-android",
		"Wallet":            "i-wallet",
		"Wallet Svc":        "i-wallet",
	}
	values := map[string]int{}
	for v := range cases {
		values[v] = 1
	}
	got := SuggestSubjects(values, acmeUnits, acmeItems)
	for v, want := range cases {
		s := suggestionFor(t, got, v)
		if s.SubjectID != want || s.Score != 1.0 {
			t.Errorf("%q = %+v, want %s at 1.0", v, s, want)
		}
	}
}

func TestSubjectSourceKeysMatchExactly(t *testing.T) {
	got := SuggestSubjects(map[string]int{"chk": 2, "INVOICING": 1, "wallet-api": 1, "Billing": 1}, acmeUnits, acmeItems)
	for v, want := range map[string]string{"chk": "u-checkout", "INVOICING": "u-billing", "wallet-api": "i-wallet", "Billing": "u-billing"} {
		if s := suggestionFor(t, got, v); s.SubjectID != want || s.Score != 1.0 {
			t.Errorf("%q = %+v, want %s", v, s, want)
		}
	}
}

func TestFuzzyTokenOverlap(t *testing.T) {
	units := []domain.OrgUnit{
		{ID: "u-1", Name: "Payments Gateway"},
		{ID: "u-2", Name: "Payments Reporting"},
		{ID: "u-3", Name: "Data Pipelines"},
	}
	got := SuggestSubjects(map[string]int{
		"Payments":                      4, // 1/2 with each Payments unit: a tie
		"Payments Gateway Retries":      2, // 2/3 with Payments Gateway
		"Gateway Payments":              1, // same words, any order: exact
		"Pipelines":                     1, // 1/2 with Data Pipelines
		"Data":                          1, // 1/2
		"Retries":                       1, // nothing
		"Reporting Payments Data Extra": 1, // 2/4 with Payments Reporting
	}, units, nil)

	pay := suggestionFor(t, got, "Payments")
	if pay.Score != 0.5 || !reflect.DeepEqual(pay.Candidates, []string{"u-1", "u-2"}) || pay.SubjectID != "u-1" {
		t.Errorf("Payments = %+v, want tie broken by ID", pay)
	}
	if s := suggestionFor(t, got, "Payments Gateway Retries"); s.SubjectID != "u-1" || s.Score < 0.66 || s.Score > 0.67 {
		t.Errorf("Payments Gateway Retries = %+v", s)
	}
	if s := suggestionFor(t, got, "Gateway Payments"); s.SubjectID != "u-1" || s.Score != 1.0 {
		t.Errorf("Gateway Payments = %+v", s)
	}
	if s := suggestionFor(t, got, "Pipelines"); s.SubjectID != "u-3" || s.Score != 0.5 {
		t.Errorf("Pipelines = %+v", s)
	}
	if s := suggestionFor(t, got, "Retries"); s.SubjectID != "" {
		t.Errorf("Retries = %+v", s)
	}
	if s := suggestionFor(t, got, "Reporting Payments Data Extra"); s.SubjectID != "u-2" || s.Score != 0.5 {
		t.Errorf("Reporting Payments Data = %+v", s)
	}
}

func TestSubjectCandidatesTopThree(t *testing.T) {
	units := []domain.OrgUnit{
		{ID: "a", Name: "Core Alpha"}, {ID: "b", Name: "Core Beta"},
		{ID: "c", Name: "Core Gamma"}, {ID: "d", Name: "Core Delta"},
		{ID: "e", Name: "Core"},
	}
	s := SuggestSubjects(map[string]int{"Core": 1}, units, nil)[0]
	if s.SubjectID != "e" || s.Score != 1.0 {
		t.Fatalf("suggestion = %+v", s)
	}
	// Best first, then the 0.5 ties in ID order, capped at three.
	if !reflect.DeepEqual(s.Candidates, []string{"e", "a", "b"}) {
		t.Errorf("Candidates = %q", s.Candidates)
	}
}

func TestSubjectTiesAreStable(t *testing.T) {
	// A unit and an item with the same name: units first, then by ID. The result
	// must not depend on input order or on map iteration order.
	units := []domain.OrgUnit{{ID: "u-2", Name: "Search"}, {ID: "u-1", Name: "Search"}}
	items := []domain.TrackedItem{{ID: "i-0", Name: "Search"}}
	values := map[string]int{"Search": 3, "search ": 3, "SEARCH": 3, "Other": 1, "Another": 1}
	first := SuggestSubjects(values, units, items)
	if s := suggestionFor(t, first, "Search"); s.SubjectID != "u-1" || !reflect.DeepEqual(s.Candidates, []string{"u-1", "u-2", "i-0"}) {
		t.Errorf("Search = %+v", s)
	}
	for i := 0; i < 20; i++ {
		got := SuggestSubjects(values, []domain.OrgUnit{units[1], units[0]}, items)
		if !reflect.DeepEqual(got, first) {
			t.Fatalf("run %d differs:\n%+v\n%+v", i, got, first)
		}
	}
	// Equal row counts fall back to value order.
	var vals []string
	for _, s := range first {
		vals = append(vals, s.Value)
	}
	if !reflect.DeepEqual(vals, []string{"SEARCH", "Search", "search ", "Another", "Other"}) {
		t.Errorf("value order = %q", vals)
	}
}

func TestSubjectNameOfOnlyNoiseWords(t *testing.T) {
	// "App" normalizes to nothing; fall back to the plain words rather than matching everything.
	units := []domain.OrgUnit{{ID: "u-app", Name: "App"}, {ID: "u-ios", Name: "iOS App"}}
	got := SuggestSubjects(map[string]int{"App": 1, "Team": 1}, units, nil)
	if s := suggestionFor(t, got, "App"); s.SubjectID != "u-app" || s.Score != 1.0 {
		t.Errorf("App = %+v", s)
	}
	if s := suggestionFor(t, got, "Team"); s.SubjectID != "" {
		t.Errorf("Team = %+v", s)
	}
}

func TestSuggestSubjectsEdges(t *testing.T) {
	if got := SuggestSubjects(nil, acmeUnits, acmeItems); len(got) != 0 {
		t.Errorf("nil values: %+v", got)
	}
	// Blank values are rows without a subject, not something to match.
	if got := SuggestSubjects(map[string]int{"": 3, "  ": 1}, acmeUnits, nil); len(got) != 0 {
		t.Errorf("blank values: %+v", got)
	}
	got := SuggestSubjects(map[string]int{"Checkout": 1}, nil, nil)
	if len(got) != 1 || got[0].SubjectID != "" || got[0].Rows != 1 {
		t.Errorf("no subjects: %+v", got)
	}
}
