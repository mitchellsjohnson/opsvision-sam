package records

import (
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

func TestResolverIgnoresInactiveUnits(t *testing.T) {
	// Billing retires from December; Android App picks up its "Billing" key.
	units := append([]domain.OrgUnit(nil), deriveUnits...)
	retired := mon(2026, 12)
	for i := range units {
		if units[i].ID == "billing" {
			units[i].RetiredFrom = &retired
		}
	}
	tree, err := orgtree.New(units, nil)
	if err != nil {
		t.Fatal(err)
	}
	in := deriveInput(t, nil)
	in.Tree = tree
	in.Items = append([]domain.TrackedItem{{ID: "android", KindID: "app", Name: "Android App", SourceKeys: []string{"billing"}}}, deriveItems...)

	r := NewResolver(in)
	cases := []struct {
		key         string
		month       period.Period
		id, problem string
	}{
		{"Billing", mon(2026, 11), "", SubjectAmbiguous},
		{"Billing", mon(2026, 12), "android", ""},
		{" billing ", mon(2027, 1), "android", ""},
		{"Checkout", mon(2026, 12), "checkout", ""},
	}
	for _, c := range cases {
		id, problem := r.Resolve(c.key, c.month)
		if id != c.id || problem != c.problem {
			t.Errorf("Resolve(%q, %s) = (%q, %q), want (%q, %q)", c.key, c.month, id, problem, c.id, c.problem)
		}
		if id2, p2 := ResolveSubject(in, c.key, c.month); id2 != id || p2 != problem {
			t.Errorf("ResolveSubject(%q, %s) = (%q, %q), Resolver says (%q, %q)", c.key, c.month, id2, p2, id, problem)
		}
	}

	// A retired unit alone matches nothing after it retires.
	in.Items = deriveItems
	if id, problem := NewResolver(in).Resolve("Billing", mon(2026, 12)); id != "" || problem != SubjectUnmatched {
		t.Errorf("retired Billing = (%q, %q), want unmatched", id, problem)
	}
}

func TestDeriveSkipsRetiredUnitKeys(t *testing.T) {
	// Billing retires from December. A December defect on "Billing" counts nowhere,
	// and Android App, which also holds the key, gets it without ambiguity.
	units := append([]domain.OrgUnit(nil), deriveUnits...)
	retired := mon(2026, 12)
	for i := range units {
		if units[i].ID == "billing" {
			units[i].RetiredFrom = &retired
		}
	}
	tree, err := orgtree.New(units, nil)
	if err != nil {
		t.Fatal(err)
	}
	f := openDefect("Billing", "P3")
	f.CreatedAt = day("2026-12-01")
	in := deriveInput(t, map[string]string{"defect": "2026-12-31"}, rec("defect", "BIL-601", rev("2026-12-31", f)))
	in.Tree = tree
	in.Items = append([]domain.TrackedItem{{ID: "android", KindID: "app", Name: "Android App", SourceKeys: []string{"Billing"}}}, deriveItems...)
	out := derive(t, in, pointsSum, mon(2026, 12))
	wantValue(t, out, "android", mon(2026, 12), 31*4)
	if hasCell(out, "billing", mon(2026, 12)) {
		t.Errorf("retired billing got a December value")
	}
}
