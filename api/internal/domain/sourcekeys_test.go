package domain

import "testing"

func TestSourceKeyHolder(t *testing.T) {
	units := []OrgUnit{
		{ID: "commerce", Name: "Commerce"},
		{ID: "checkout", Name: "Checkout", ParentID: "commerce", SourceKeys: []string{"Checkout", " CHK "}},
	}
	items := []TrackedItem{{ID: "ios", Name: "iOS App", SourceKeys: []string{"iOS App"}}}
	cases := []struct {
		key, id string
		ok      bool
	}{
		{"checkout", "checkout", true},
		{"  chk", "checkout", true},
		{"IOS APP", "ios", true},
		{"Billing", "", false},
		{"", "", false},
		{"   ", "", false},
	}
	for _, c := range cases {
		id, ok := SourceKeyHolder(units, items, c.key)
		if id != c.id || ok != c.ok {
			t.Errorf("SourceKeyHolder(%q) = (%q, %v), want (%q, %v)", c.key, id, ok, c.id, c.ok)
		}
	}
}
