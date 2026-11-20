package rca

import (
	"math"
	"slices"
)

// RoundParts rounds parts to decimals places so they add up to total
// (itself rounded to decimals) exactly, by the largest remainder method:
// floor every part, then give one unit each to the parts with the largest
// remainders until the sum is total (or, when the floors already exceed it,
// take one unit each from the smallest remainders). Equal remainders go in
// slice order, so callers pass parts in evidence order with the remainder
// last. A part never goes below zero.
func RoundParts(parts []float64, total float64, decimals int) []float64 {
	decimals = max(decimals, 0)
	scale := math.Pow10(decimals)
	units := make([]int64, len(parts))
	rems := make([]int64, len(parts)) // remainders in billionths of a unit, so near-equal ones tie
	var sum int64
	for i, p := range parts {
		x := math.Max(p, 0) * scale
		f := math.Floor(x + 1e-9)
		units[i] = int64(f)
		rems[i] = int64(math.Round(math.Max(x-f, 0) * 1e9))
		sum += units[i]
	}
	order := make([]int, len(parts))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int {
		switch {
		case rems[a] > rems[b]:
			return -1
		case rems[a] < rems[b]:
			return 1
		}
		return 0
	})
	want := int64(math.Round(total * scale))
	for diff := want - sum; diff > 0 && len(order) > 0; {
		for _, i := range order {
			if diff == 0 {
				break
			}
			units[i]++
			diff--
		}
	}
	for diff := sum - want; diff > 0; {
		took := false
		for k := len(order) - 1; k >= 0 && diff > 0; k-- {
			if i := order[k]; units[i] > 0 {
				units[i]--
				diff--
				took = true
			}
		}
		if !took {
			break
		}
	}
	out := make([]float64, len(parts))
	for i, u := range units {
		out[i] = float64(u) / scale
	}
	return out
}
