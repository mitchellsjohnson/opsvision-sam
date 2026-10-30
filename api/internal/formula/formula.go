// Package formula compiles and evaluates admin-authored metric formulas such
// as "on_time / committed * 100" inside a strict whitelist sandbox.
//
// The accepted grammar is deliberately tiny: number literals, measure
// identifiers (snake_case), the binary operators + - * /, unary minus,
// parentheses, and the functions min(a, b), max(a, b) and abs(x). Everything
// else the underlying expr parser understands (member access, strings,
// comparisons, ternaries, other builtins, ...) is rejected at compile time.
//
// All arithmetic is float64. Division is routed through a checked function so
// that dividing by zero yields ErrDivByZero instead of +Inf or NaN.
package formula

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"

	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
	"github.com/expr-lang/expr/vm"
)

// ErrDivByZero is returned by Eval when a formula divides by zero.
var ErrDivByZero = errors.New("formula: division by zero")

// ErrNotFinite is returned by Eval when a result overflows to +Inf/-Inf or is
// NaN. Metric values must always be finite numbers.
var ErrNotFinite = errors.New("formula: result is not a finite number")

// ErrMissing is returned by Eval when a referenced measure has no value.
type ErrMissing struct {
	Measure string
}

func (e ErrMissing) Error() string {
	return fmt.Sprintf("formula: missing value for measure %q", e.Measure)
}

// Formula is a compiled, sandboxed formula. It is safe for concurrent use.
type Formula struct {
	src    string
	prog   *vm.Program
	idents []string
}

// funcArity lists the whitelisted functions and their required argument count.
var funcArity = map[string]int{"min": 2, "max": 2, "abs": 1}

// divFunc is the name of the internal checked-division function. It starts
// with an underscore so identRe can never match it: users cannot call it or
// shadow it with a measure, and it cannot collide with any measure name.
const divFunc = "_div"

// Limits on formula source. Formulas are short; these caps keep the
// recursive-descent parser (whose stack use grows with nesting, and which
// creates no AST nodes for parentheses) from being driven to a fatal,
// unrecoverable stack overflow by hostile input.
const (
	// MaxSourceLen is the maximum formula length in bytes.
	MaxSourceLen = 2048
	// MaxParenDepth is the maximum parenthesis nesting depth.
	MaxParenDepth = 64
)

var identRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// checkLimits rejects oversized or deeply nested source before it reaches
// the parser.
func checkLimits(src string) error {
	if len(src) > MaxSourceLen {
		return fmt.Errorf("formula: too long (%d bytes, max %d)", len(src), MaxSourceLen)
	}
	depth := 0
	for i := 0; i < len(src); i++ {
		switch src[i] {
		case '(', '[', '{':
			depth++
			if depth > MaxParenDepth {
				return fmt.Errorf("formula: nesting too deep (max %d)", MaxParenDepth)
			}
		case ')', ']', '}':
			if depth > 0 {
				depth--
			}
		}
	}
	return nil
}

// Compile validates src against the whitelist and measures, and returns a
// Formula ready for Eval. Every identifier in src must appear in measures.
func Compile(src string, measures []string) (*Formula, error) {
	idents, err := Identifiers(src)
	if err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(measures))
	for _, m := range measures {
		known[m] = true
	}
	// The compile env holds only identifiers that the validated source
	// actually references (already regex-checked, never min/max/abs), so
	// measure names in the wider list cannot shadow internals.
	env := make(map[string]any, len(idents))
	for _, id := range idents {
		if !known[id] {
			return nil, fmt.Errorf("formula: unknown measure %q", id)
		}
		env[id] = float64(0)
	}

	prog, err := expr.Compile(src,
		expr.Env(env),
		expr.Function(divFunc, checkedDiv, new(func(float64, float64) (float64, error))),
		expr.Patch(floatDivPatcher{}),
		expr.AsFloat64(),
	)
	if err != nil {
		return nil, fmt.Errorf("formula: %w", err)
	}
	return &Formula{src: src, prog: prog, idents: idents}, nil
}

// Identifiers parses src and returns the distinct measure identifiers it
// references, sorted. The function names min, max and abs are excluded. It
// returns an error if src is unparseable or uses anything outside the
// whitelist.
func Identifiers(src string) ([]string, error) {
	if err := checkLimits(src); err != nil {
		return nil, err
	}
	tree, err := parser.Parse(src)
	if err != nil {
		return nil, fmt.Errorf("formula: %w", err)
	}
	seen := map[string]bool{}
	if err := validate(tree.Node, seen); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}

// Eval evaluates the formula with the given measure values.
func (f *Formula) Eval(vars map[string]float64) (float64, error) {
	env := make(map[string]any, len(f.idents))
	for _, id := range f.idents {
		v, ok := vars[id]
		if !ok {
			return 0, ErrMissing{Measure: id}
		}
		env[id] = v
	}
	out, err := vm.Run(f.prog, env)
	if err != nil {
		if errors.Is(err, ErrDivByZero) {
			return 0, ErrDivByZero
		}
		return 0, fmt.Errorf("formula: %w", err)
	}
	res, ok := out.(float64)
	if !ok {
		return 0, fmt.Errorf("formula: unexpected result type %T", out)
	}
	if math.IsNaN(res) || math.IsInf(res, 0) {
		return 0, ErrNotFinite
	}
	return res, nil
}

// validate walks n, rejecting anything outside the whitelist and recording
// referenced measure identifiers in seen.
func validate(n ast.Node, seen map[string]bool) error {
	switch n := n.(type) {
	case *ast.IntegerNode, *ast.FloatNode:
		return nil
	case *ast.IdentifierNode:
		if !identRe.MatchString(n.Value) {
			return fmt.Errorf("formula: invalid identifier %q (must be snake_case)", n.Value)
		}
		if _, isFunc := funcArity[n.Value]; isFunc {
			return fmt.Errorf("formula: %q is a function and must be called with arguments", n.Value)
		}
		seen[n.Value] = true
		return nil
	case *ast.UnaryNode:
		if n.Operator != "-" {
			return fmt.Errorf("formula: operator %q is not allowed", n.Operator)
		}
		return validate(n.Node, seen)
	case *ast.BinaryNode:
		switch n.Operator {
		case "+", "-", "*", "/":
		default:
			return fmt.Errorf("formula: operator %q is not allowed", n.Operator)
		}
		if err := validate(n.Left, seen); err != nil {
			return err
		}
		return validate(n.Right, seen)
	case *ast.BuiltinNode:
		// min/max/abs may parse as builtins.
		return validateCall(n.Name, n.Arguments, seen)
	case *ast.CallNode:
		id, ok := n.Callee.(*ast.IdentifierNode)
		if !ok {
			return errors.New("formula: only min, max and abs may be called")
		}
		return validateCall(id.Value, n.Arguments, seen)
	default:
		return fmt.Errorf("formula: %T is not allowed", n)
	}
}

func validateCall(name string, args []ast.Node, seen map[string]bool) error {
	want, ok := funcArity[name]
	if !ok {
		return fmt.Errorf("formula: function %q is not allowed (only min, max, abs)", name)
	}
	if len(args) != want {
		return fmt.Errorf("formula: %s takes %d argument(s), got %d", name, want, len(args))
	}
	for _, a := range args {
		if err := validate(a, seen); err != nil {
			return err
		}
	}
	return nil
}

// checkedDiv is the runtime implementation of "/".
func checkedDiv(params ...any) (any, error) {
	a, b := params[0].(float64), params[1].(float64)
	if b == 0 {
		return nil, ErrDivByZero
	}
	return a / b, nil
}

// floatDivPatcher rewrites the validated AST: integer literals become float
// literals (so 1/2 == 0.5 and no integer arithmetic happens) and "/" becomes
// a call to checkedDiv.
type floatDivPatcher struct{}

func (floatDivPatcher) Visit(node *ast.Node) {
	switch n := (*node).(type) {
	case *ast.IntegerNode:
		f := &ast.FloatNode{Value: float64(n.Value)}
		ast.Patch(node, f)
	case *ast.BinaryNode:
		if n.Operator == "/" {
			call := &ast.CallNode{
				Callee:    &ast.IdentifierNode{Value: divFunc},
				Arguments: []ast.Node{n.Left, n.Right},
			}
			ast.Patch(node, call)
		}
	}
}
