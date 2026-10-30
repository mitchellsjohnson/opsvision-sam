package legacy

import (
	"reflect"
	"testing"

	"opsvision/internal/domain"
)

func TestParseBandText(t *testing.T) {
	hi, lo := domain.DirectionHigherBetter, domain.DirectionLowerBetter
	b := func(s, op string, v float64) domain.Band { return domain.Band{Status: s, Op: op, Value: v} }
	tests := []struct {
		name          string
		g, y, r       string
		want          []domain.Band
		wantDirection domain.Direction
	}{
		{"brief 1", ">=90%", ">=80% < 90%", "< 80%", []domain.Band{b("G", ">=", 90), b("Y", ">=", 80), b("R", "", 0)}, hi},
		{"brief 2", "<=110%", ">110% <= 120%", "> 120%", []domain.Band{b("G", "<=", 110), b("Y", "<=", 120), b("R", "", 0)}, lo},
		{"brief 3 uptime", "99.9% uptime", "<99.9% >99.8%", "< 99.8%", []domain.Band{b("G", ">=", 99.9), b("Y", ">", 99.8), b("R", "", 0)}, hi},
		{"brief 4 days", "<= 14", "14 - 17", "18+", []domain.Band{b("G", "<=", 14), b("Y", "<=", 17), b("R", "", 0)}, lo},
		{"variant 70/90", ">=90%", ">=70% < 90%", "<70%", []domain.Band{b("G", ">=", 90), b("Y", ">=", 70), b("R", "", 0)}, hi},
		{"variant tight range", ">=80%", ">60%<=79%", "<=59%", []domain.Band{b("G", ">=", 80), b("Y", ">", 60), b("R", "", 0)}, hi},
		{"variant zero", "<= 0%", ">0% - 10%", ">10%", []domain.Band{b("G", "<=", 0), b("Y", "<=", 10), b("R", "", 0)}, lo},
		{"unicode ops", "≥90%", "≥80% <90%", "<80%", []domain.Band{b("G", ">=", 90), b("Y", ">=", 80), b("R", "", 0)}, hi},
		{"empty red", ">=90%", ">=80%", "", []domain.Band{b("G", ">=", 90), b("Y", ">=", 80), b("R", "", 0)}, hi},
		{"plus green", "18+", "14 - 17", "<14", []domain.Band{b("G", ">=", 18), b("Y", ">=", 14), b("R", "", 0)}, hi},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, dir, err := ParseBandText(tc.g, tc.y, tc.r)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("bands = %+v, want %+v", got, tc.want)
			}
			if dir != tc.wantDirection {
				t.Errorf("direction = %q, want %q", dir, tc.wantDirection)
			}
		})
	}
}

func TestParseBandTextErrors(t *testing.T) {
	tests := []struct{ name, g, y, r string }{
		{"garbage", "good stuff", "ok-ish", "bad"},
		{"empty green", "", ">=80%", "<80%"},
		{"empty yellow", ">=90%", "", "<80%"},
		{"change style", ">= 0% improvement in Quality Score", ">= -5% < 0%", "< -5%"},
		{"grade scale", "5.26 - 5.84 - B", "4.0 - 5.25 - C", "< 4.0"},
		{"yellow wrong side", ">=90%", "< 90%", "<80%"},
		{"green two bounds", ">=80% < 90%", ">=70%", "<70%"},
		{"bad red", ">=90%", ">=80%", "who knows"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if bands, _, err := ParseBandText(tc.g, tc.y, tc.r); err == nil {
				t.Fatalf("expected error, got %+v", bands)
			}
		})
	}
}
