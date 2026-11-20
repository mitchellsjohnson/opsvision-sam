package rca_test

import (
	"testing"

	"opsvision/internal/rca"
)

func TestDuration(t *testing.T) {
	for m, want := range map[float64]string{
		0: "0m", 45: "45m", 59.6: "1h 00m", 216: "3h 36m", 420: "7h 00m", 1440: "1d 0h 00m", 1565: "1d 2h 05m", 2*1440 + 65: "2d 1h 05m",
	} {
		if got := rca.Duration(m); got != want {
			t.Errorf("Duration(%v) = %q, want %q", m, got, want)
		}
	}
}
