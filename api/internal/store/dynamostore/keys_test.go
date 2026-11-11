package dynamostore

import (
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// TestKeys pins every key string from the table in the Task 10 brief. These
// strings are the on-disk format: changing one orphans existing data.
func TestKeys(t *testing.T) {
	m := period.Period{Grain: period.Month, FY: 2026, Index: 3}
	fy := period.Period{Grain: period.Year, FY: 2027}
	asOf, err := domain.ParseDate("2026-10-05")
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		got  string
		want string
	}{
		{"tenant PK", tenantPK("acme"), "T#acme"},
		{"tenant SK", skTenant, "TENANT"},
		{"tenant GSI1PK", gsiTenants, "TENANTS"},
		{"tenant GSI1SK", gsiTenantSK("acme"), "T#acme"},

		{"auth0 org PK", auth0OrgPK("org_123"), "AUTH0ORG#org_123"},
		{"auth0 org SK", skAuth0Map, "MAP"},

		{"membership SK", memberSK("user-1"), "MEMBER#user-1"},
		{"membership pending SK", memberSK("pending:a@example.test"), "MEMBER#pending:a@example.test"},
		{"membership GSI1PK", gsiUserPK("user-1"), "USER#user-1"},
		{"membership GSI1SK", gsiTenantSK("acme"), "T#acme"},

		{"level SK", levelSK("div"), "LEVEL#div"},
		{"unit SK", unitSK("u1"), "UNIT#u1"},
		{"move SK", moveSK("u1", m), "MOVE#u1#2026-M03"},
		{"kind SK", kindSK("k1"), "KIND#k1"},
		{"item SK", itemSK("i1"), "ITEM#i1"},

		{"scorecard SK", scorecardSK("sc1"), "SC#sc1"},
		{"layout SK", layoutSK("user-1", "delivery"), "LAYOUT#user-1#delivery"},
		{"layout default SK", layoutDefaultSK("delivery"), "LAYOUTDEFAULT#delivery"},
		{"version SK", versionSK("sc1", "v1"), "SC#sc1#VER#v1"},

		{"data current PK", dataPK("acme", "sc1", 2026), "T#acme#SC#sc1#FY#2026"},
		{"data current SK", pointSK(m, "m1", "u1"), "DP#2026-M03#m1#u1"},
		{"data current SK year", pointSK(fy, "m1", "u1"), "DP#2027-FY#m1#u1"},
		{"data history PK", histPK("acme", "sc1"), "T#acme#SC#sc1#HIST"},
		{"data history SK", histSK(m, "m1", "u1", 7), "DP#2026-M03#m1#u1#R000007"},
		{"data history SK prefix", histPrefix(m, "m1", "u1"), "DP#2026-M03#m1#u1#R"},

		{"override PK", dataPK("acme", "sc1", 2026), "T#acme#SC#sc1#FY#2026"},
		{"override SK", overrideSK(m, "x", "u1"), "OV#2026-M03#x#u1"},

		{"audit PK", auditPK("acme", time.Date(2026, time.October, 31, 23, 59, 0, 0, time.UTC)), "T#acme#AUDIT#2026-10"},
		{"audit PK other zone", auditPK("acme", time.Date(2026, time.November, 1, 1, 0, 0, 0, time.FixedZone("x", 3*3600))), "T#acme#AUDIT#2026-10"},

		{"import SK", importSK("imp-1"), "IMPORT#imp-1"},
		{"template SK", templateSK("t-1"), "TEMPLATE#t-1"},

		{"record type SK", recordTypeSK("defect"), "RTYPE#defect"},
		{"snapshot SK", snapshotSK("defect", "snap-1"), "SNAP#defect#snap-1"},
		{"snapshot SK prefix", snapshotPrefix("defect"), "SNAP#defect#"},
		{"record PK", recordPK("acme", "defect"), "T#acme#REC#defect"},
		{"record SK", recordSK("tracker-a", "CHK-12", asOf), "R#tracker-a#CHK-12#2026-10-05"},
		{"record SK escapes hash", recordSK("tracker-a", "CHK#12", asOf), "R#tracker-a#CHK%2312#2026-10-05"},
		{"record SK escapes source", recordSK("a#b", "1", asOf), "R#a%23b#1#2026-10-05"},
		{"record SK escapes slash and space", recordSK("my src", "a/b", asOf), "R#my%20src#a%2Fb#2026-10-05"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
}

func TestSKPrefixes(t *testing.T) {
	cases := map[string]string{
		prefixMember:    "MEMBER#",
		prefixLevel:     "LEVEL#",
		prefixUnit:      "UNIT#",
		prefixMove:      "MOVE#",
		prefixKind:      "KIND#",
		prefixItem:      "ITEM#",
		prefixScorecard: "SC#",
		prefixTemplate:  "TEMPLATE#",
		prefixPoint:     "DP#",
		prefixOverride:  "OV#",
		prefixRecType:   "RTYPE#",
		prefixSnapshot:  "SNAP#",
		prefixRecordRev: "R#",
		prefixLayout:    "LAYOUT#",
		prefixLayoutDef: "LAYOUTDEFAULT#",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("prefix = %q, want %q", got, want)
		}
	}
	if got := versionPrefix("sc1"); got != "SC#sc1#VER#" {
		t.Errorf("versionPrefix = %q", got)
	}
	if got := tenantFromGSISK("T#acme"); got != "acme" {
		t.Errorf("tenant from GSI1SK = %q", got)
	}
}

func TestAuditMonths(t *testing.T) {
	utc := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }
	cases := []struct {
		name     string
		from, to time.Time
		want     []string
	}{
		{"single month", utc(2026, 10, 5), utc(2026, 10, 20), []string{"2026-10"}},
		{"spans year", utc(2026, 11, 30), utc(2027, 1, 2), []string{"2026-11", "2026-12", "2027-01"}},
		{"exclusive end at month boundary", utc(2026, 9, 10), utc(2026, 10, 1), []string{"2026-09"}},
		{"empty range", utc(2026, 10, 10), utc(2026, 10, 10), nil},
		{"inverted range", utc(2026, 10, 10), utc(2026, 10, 1), nil},
	}
	for _, c := range cases {
		got := auditMonths(c.from, c.to)
		var gotS []string
		for _, g := range got {
			gotS = append(gotS, g.Format("2006-01"))
		}
		if len(gotS) != len(c.want) {
			t.Errorf("%s: months = %v, want %v", c.name, gotS, c.want)
			continue
		}
		for i := range gotS {
			if gotS[i] != c.want[i] {
				t.Errorf("%s: months = %v, want %v", c.name, gotS, c.want)
				break
			}
		}
	}
}
