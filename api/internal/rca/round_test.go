package rca_test

import (
	"math"
	"math/rand/v2"
	"reflect"
	"testing"

	"opsvision/internal/rca"
)

func TestRoundParts(t *testing.T) {
	cases := []struct {
		name     string
		parts    []float64
		total    float64
		decimals int
		want     []float64
	}{
		{"worked example", []float64{0.34722, 0.12731, 0.02546}, 0.5, 2, []float64{0.35, 0.13, 0.02}},
		{"webhooks", []float64{0.56, 0.252, 0.0392, 0.0896}, 0.94, 2, []float64{0.56, 0.25, 0.04, 0.09}},
		{"tie goes to the earlier part", []float64{0.0672, 0.0672}, 0.13, 2, []float64{0.07, 0.06}},
		{"minutes tie", []float64{250, 112.5, 17.5, 40}, 420, 0, []float64{250, 113, 17, 40}},
		{"whole points", []float64{9.0909, 9.0909, 9.0909}, 27, 0, []float64{9, 9, 9}},
		{"total below the floors takes from the smallest remainders", []float64{0.2, 0.3, 0.5}, 0, 0, []float64{0, 0, 0}},
		{"excess against its own sum", []float64{0.2016}, 0.2, 2, []float64{0.2}},
		{"empty", nil, 0, 2, []float64{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rca.RoundParts(tc.parts, tc.total, tc.decimals)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("RoundParts(%v, %v, %d) = %v, want %v", tc.parts, tc.total, tc.decimals, got, tc.want)
			}
		})
	}

	// The floors exceed the total: units come back from the smallest remainders first.
	if got := rca.RoundParts([]float64{1.9, 1.1, 1.5}, 2, 0); !reflect.DeepEqual(got, []float64{1, 0, 1}) {
		t.Fatalf("over-floor case = %v", got)
	}
	// Float noise does not lose a unit: 0.29 is 28.999... hundredths in binary.
	if got := rca.RoundParts([]float64{0.29, 0.71}, 1, 2); !reflect.DeepEqual(got, []float64{0.29, 0.71}) {
		t.Fatalf("noise case = %v", got)
	}
}

func TestRoundPartsSumsExactly(t *testing.T) {
	r := rand.New(rand.NewPCG(20261120, 1))
	for i := range 1000 {
		n := 1 + r.IntN(8)
		d := r.IntN(3)
		parts := make([]float64, n)
		sum := 0.0
		for j := range parts {
			parts[j] = r.Float64() * math.Pow(10, float64(r.IntN(4)-1))
			sum += parts[j]
		}
		scale := math.Pow10(d)
		total := math.Round(sum*scale) / scale
		got := rca.RoundParts(parts, total, d)
		var units int64
		for j, g := range got {
			u := math.Round(g * scale)
			if math.Abs(g*scale-u) > 1e-6 {
				t.Fatalf("case %d: part %v is not a multiple of 10^-%d", i, g, d)
			}
			if g < 0 {
				t.Fatalf("case %d: negative part %v from %v", i, g, parts[j])
			}
			units += int64(u)
		}
		if want := int64(math.Round(total * scale)); units != want {
			t.Fatalf("case %d: %v rounded to %v sums to %d, want %d", i, parts, got, units, want)
		}
	}
}
