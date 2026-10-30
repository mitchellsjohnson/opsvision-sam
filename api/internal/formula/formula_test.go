package formula

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
)

func mustCompile(t *testing.T, src string, measures ...string) *Formula {
	t.Helper()
	f, err := Compile(src, measures)
	if err != nil {
		t.Fatalf("Compile(%q): %v", src, err)
	}
	return f
}

func approx(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEvalRatio(t *testing.T) {
	f := mustCompile(t, "on_time / committed * 100", "on_time", "committed")
	got, err := f.Eval(map[string]float64{"on_time": 440, "committed": 522})
	if err != nil {
		t.Fatal(err)
	}
	approx(t, got, 84.29118773946360)
}

func TestEvalUptime(t *testing.T) {
	f := mustCompile(t, "(1 - seconds_down / seconds_in_period) * 100", "seconds_down", "seconds_in_period")
	got, err := f.Eval(map[string]float64{"seconds_down": 300, "seconds_in_period": 2592000})
	if err != nil {
		t.Fatal(err)
	}
	approx(t, got, 99.98842592592593)
}

func TestIntegerLiteralsAreFloat(t *testing.T) {
	got, err := mustCompile(t, "1/2").Eval(nil)
	if err != nil {
		t.Fatal(err)
	}
	approx(t, got, 0.5)

	got, err = mustCompile(t, "7 / 2 + 1").Eval(nil)
	if err != nil {
		t.Fatal(err)
	}
	approx(t, got, 4.5)
}

func TestFunctionsAndUnaryMinus(t *testing.T) {
	cases := []struct {
		src  string
		vars map[string]float64
		want float64
	}{
		{"min(a, b)", map[string]float64{"a": 3, "b": 5}, 3},
		{"max(a, b)", map[string]float64{"a": 3, "b": 5}, 5},
		{"abs(a - b)", map[string]float64{"a": 3, "b": 5}, 2},
		{"-a + b", map[string]float64{"a": 3, "b": 5}, 2},
		{"-(a * 2)", map[string]float64{"a": 3, "b": 5}, -6},
		{"max(a, 0) * -1", map[string]float64{"a": 3, "b": 5}, -3},
		{"max(min(a, b), 4)", map[string]float64{"a": 3, "b": 5}, 4},
	}
	for _, c := range cases {
		t.Run(c.src, func(t *testing.T) {
			got, err := mustCompile(t, c.src, "a", "b").Eval(c.vars)
			if err != nil {
				t.Fatal(err)
			}
			approx(t, got, c.want)
		})
	}
}

func TestDivByZero(t *testing.T) {
	cases := []string{"a / b", "a / (b - b)", "a / b * 100", "1 / 0", "a / 0"}
	for _, src := range cases {
		t.Run(src, func(t *testing.T) {
			f := mustCompile(t, src, "a", "b")
			got, err := f.Eval(map[string]float64{"a": 5, "b": 0})
			if !errors.Is(err, ErrDivByZero) {
				t.Fatalf("got (%v, %v), want ErrDivByZero", got, err)
			}
		})
	}
}

func TestMissingMeasure(t *testing.T) {
	f := mustCompile(t, "a / b", "a", "b")
	_, err := f.Eval(map[string]float64{"a": 1})
	var miss ErrMissing
	if !errors.As(err, &miss) {
		t.Fatalf("got %v, want ErrMissing", err)
	}
	if miss.Measure != "b" {
		t.Fatalf("Measure = %q, want b", miss.Measure)
	}
	if !strings.Contains(err.Error(), "b") {
		t.Fatalf("message %q should name b", err.Error())
	}
}

func TestRejectsUnsafe(t *testing.T) {
	cases := []string{
		`env()`, `"x"`, `a.b`, `a > 1`, `len(a)`, `a ? 1 : 2`,
		`a == b`, `a and b`, `not a`, `a % b`, `a ** b`, `a ?? b`,
		`[a, b]`, `{"k": a}`, `a[0]`, `a..b`, `nil`, `true`, `foo(a)`,
		`div(a, b)`, `min(a)`, `abs(a, b)`, `min`, `$env`, `#`, `a in b`,
		`1 ; 2`, ``, `a +`, `(a`, `let x = 1; x`, `sum([a])`,
	}
	for _, src := range cases {
		t.Run(src, func(t *testing.T) {
			if f, err := Compile(src, []string{"a", "b"}); err == nil {
				t.Fatalf("Compile(%q) succeeded: %+v", src, f)
			}
		})
	}
}

func TestRejectsUnknownIdent(t *testing.T) {
	_, err := Compile("a / c", []string{"a", "b"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "c") {
		t.Fatalf("error %q should name c", err.Error())
	}
}

func TestIdentifiers(t *testing.T) {
	got, err := Identifiers("max(zeta, alpha) / min(alpha, beta_2) + abs(zeta) * 3")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"alpha", "beta_2", "zeta"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	got, err = Identifiers("1 + 2")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}

	if _, err := Identifiers("a +"); err == nil {
		t.Fatal("expected error for unparseable input")
	}
}

func TestNonFiniteResultIsError(t *testing.T) {
	f := mustCompile(t, "a * a", "a")
	got, err := f.Eval(map[string]float64{"a": math.MaxFloat64})
	if err == nil {
		t.Fatalf("got %v, want error for overflow", got)
	}
}

func TestEvalIsRepeatable(t *testing.T) {
	f := mustCompile(t, "a / b", "a", "b")
	for i := 1; i <= 3; i++ {
		got, err := f.Eval(map[string]float64{"a": float64(i), "b": 2})
		if err != nil {
			t.Fatal(err)
		}
		approx(t, got, float64(i)/2)
	}
}
