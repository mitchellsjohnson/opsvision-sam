package records

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/file"
	"github.com/expr-lang/expr/parser"
	"github.com/expr-lang/expr/types"
	"github.com/expr-lang/expr/vm"

	"opsvision/internal/domain"
)

// MaxWhereLen is the maximum length of a where expression, in characters.
const MaxWhereLen = 1000

// priorDueDatesField is the one built-in field that is a list of dates. It
// is usable on the right of in.
const priorDueDatesField = "priorDueDates"

// kindDateList is the field kind of priorDueDatesField.
const kindDateList domain.AttrType = "date list"

// Internal three-valued logic functions. Their names start with an
// underscore, which no field or attribute key can.
const (
	fnAnd = "_and"
	fnOr  = "_or"
	fnNot = "_not"
)

// Cond is a compiled where condition. It is safe for concurrent use.
//
// A comparison that reads a missing value (a nil date or number, a zero
// createdAt, a missing date attribute) is unknown rather than true or false:
// ! keeps it unknown, && and || treat it as SQL does, and an unknown result
// does not match.
type Cond struct {
	prog   *vm.Program // nil matches everything
	fields map[string]domain.AttrType
}

// CompileWhere validates src against rt and compiles it. The empty condition
// matches everything. src may use every built-in record field and each
// attribute of rt; literals; comparisons; + - * /; in [...] and not in [...];
// and &&, ||, !. Function calls are not allowed and the result must be a
// bool. Errors start with "where: " and name the problem.
func CompileWhere(src string, rt domain.RecordType) (*Cond, error) {
	if strings.TrimSpace(src) == "" {
		return &Cond{}, nil
	}
	if n := utf8.RuneCountInString(src); n > MaxWhereLen {
		return nil, fmt.Errorf("where: too long (%d characters, max %d)", n, MaxWhereLen)
	}
	tree, err := parser.Parse(src)
	if err != nil {
		return nil, whereError(err)
	}
	c := &Cond{fields: map[string]domain.AttrType{}}
	if err := c.check(tree.Node, rt); err != nil {
		return nil, fmt.Errorf("where: %w", err)
	}

	// Type-check against the fields' real types, so mismatches and non-bool
	// results fail here rather than per record.
	typed := make(map[string]any, len(c.fields))
	for name, kind := range c.fields {
		typed[name] = zeroOf(kind)
	}
	if _, err := expr.Compile(src, expr.Env(typed), expr.AsBool()); err != nil {
		return nil, whereError(err)
	}

	// The program that runs reads untyped values, so missing ones can be nil,
	// and guards every comparison that reads a value that can be missing.
	dynamic := make(types.Map, len(c.fields))
	for name := range c.fields {
		dynamic[name] = types.Any
	}
	prog, err := expr.Compile(src,
		expr.Env(dynamic),
		expr.Function(fnAnd, logicAnd, new(func(any, any) any)),
		expr.Function(fnOr, logicOr, new(func(any, any) any)),
		expr.Function(fnNot, logicNot, new(func(any) any)),
		expr.Patch(&unknownPatcher{fields: c.fields}),
	)
	if err != nil {
		return nil, whereError(err)
	}
	c.prog = prog
	return c, nil
}

// Match reports whether f satisfies the condition. It returns an error only
// when an attribute value has the wrong type for its declaration.
func (c *Cond) Match(f domain.RecordFields) (bool, error) {
	if c == nil || c.prog == nil {
		return true, nil
	}
	env := make(map[string]any, len(c.fields))
	for name, kind := range c.fields {
		v, err := fieldValue(f, name, kind)
		if err != nil {
			return false, err
		}
		env[name] = v
	}
	out, err := expr.Run(c.prog, env)
	if err != nil {
		return false, fmt.Errorf("where: %w", err)
	}
	return out == true, nil
}

// whereError formats an expr error as one line with its column.
func whereError(err error) error {
	var fe *file.Error
	if errors.As(err, &fe) {
		return fmt.Errorf("where: %s (column %d)", fe.Message, fe.Column+1)
	}
	if msg := err.Error(); strings.HasPrefix(msg, "expected bool") {
		return fmt.Errorf("where: the condition must be true or false, %s", msg)
	}
	return fmt.Errorf("where: %w", err)
}

// check rejects anything outside the allowed grammar and records the fields
// and attributes n references.
func (c *Cond) check(n ast.Node, rt domain.RecordType) error {
	switch n := n.(type) {
	case *ast.StringNode, *ast.IntegerNode, *ast.FloatNode, *ast.BoolNode:
		return nil
	case *ast.IdentifierNode:
		kind, ok := fieldKind(rt, n.Value)
		if !ok {
			return fmt.Errorf("unknown field %q on record type %q", n.Value, rt.ID)
		}
		c.fields[n.Value] = kind
		return nil
	case *ast.NilNode:
		return errors.New("nil is not allowed; a missing value never matches a comparison")
	case *ast.UnaryNode:
		switch n.Operator {
		case "!", "not", "-":
			return c.check(n.Node, rt)
		}
		return fmt.Errorf("operator %q is not allowed", n.Operator)
	case *ast.BinaryNode:
		switch n.Operator {
		case "&&", "||", "and", "or", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/":
			if err := c.check(n.Left, rt); err != nil {
				return err
			}
			if err := c.check(n.Right, rt); err != nil {
				return err
			}
		case "in":
			if err := c.check(n.Left, rt); err != nil {
				return err
			}
			if err := c.checkList(n.Right, rt); err != nil {
				return err
			}
		default:
			return fmt.Errorf("operator %q is not allowed", n.Operator)
		}
		return checkKnownValues(n, rt)
	case *ast.ArrayNode:
		return errors.New("a list [...] is only allowed after in")
	case *ast.CallNode, *ast.BuiltinNode:
		return fmt.Errorf("function calls are not allowed (%s)", n)
	case *ast.MemberNode:
		return fmt.Errorf("field access with . or [] is not allowed (%s)", n)
	case *ast.ConditionalNode:
		return errors.New("the ?: operator is not allowed")
	default:
		return fmt.Errorf("%s is not allowed", n)
	}
}

// checkList checks the right side of in: a list of literals, or the
// priorDueDates field.
func (c *Cond) checkList(n ast.Node, rt domain.RecordType) error {
	switch n := n.(type) {
	case *ast.ArrayNode:
		for _, el := range n.Nodes {
			switch el.(type) {
			case *ast.StringNode, *ast.IntegerNode, *ast.FloatNode, *ast.BoolNode:
			default:
				return fmt.Errorf("in [...] takes a list of literal values, got %s", el)
			}
		}
		return nil
	case *ast.IdentifierNode:
		if kind, _ := fieldKind(rt, n.Value); kind == kindDateList {
			return c.check(n, rt)
		}
	}
	return fmt.Errorf("in takes a list [...] or %s, got %s", priorDueDatesField, n)
}

// checkKnownValues rejects string literals compared with priority or state
// that are not one of the field's values, catching typos when the rule is
// saved.
func checkKnownValues(n *ast.BinaryNode, rt domain.RecordType) error {
	var id *ast.IdentifierNode
	var lits []ast.Node
	switch n.Operator {
	case "==", "!=":
		if l, ok := n.Left.(*ast.IdentifierNode); ok {
			id, lits = l, []ast.Node{n.Right}
		} else if r, ok := n.Right.(*ast.IdentifierNode); ok {
			id, lits = r, []ast.Node{n.Left}
		}
	case "in":
		l, okL := n.Left.(*ast.IdentifierNode)
		arr, okR := n.Right.(*ast.ArrayNode)
		if okL && okR {
			id, lits = l, arr.Nodes
		}
	}
	if id == nil {
		return nil
	}
	var known []string
	var unknown string
	switch id.Value {
	case "priority":
		known = rt.AllPriorities()
		unknown = fmt.Sprintf("for record type %q ", rt.ID)
	case "state":
		known = []string{string(domain.StateOpen), string(domain.StateDone), string(domain.StateCancelled)}
	default:
		return nil
	}
	for _, lit := range lits {
		s, ok := lit.(*ast.StringNode)
		if !ok {
			continue // a type mismatch, reported by the type check
		}
		if !contains(known, s.Value) {
			return fmt.Errorf("unknown %s %q %s(known: %s)", id.Value, s.Value, unknown, strings.Join(known, ", "))
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// fieldKind returns the kind of the built-in field or attribute name.
func fieldKind(rt domain.RecordType, name string) (domain.AttrType, bool) {
	if name == priorDueDatesField {
		return kindDateList, true
	}
	return rt.FieldKind(name)
}

// nullable reports whether a field of kind can be missing at run time.
// Missing strings and bools are their zero values; missing dates and
// numbers are nil, except number attributes, which are 0.
func nullable(name string, kind domain.AttrType) bool {
	switch kind {
	case domain.AttrDate:
		return true
	case domain.AttrNumber:
		var none domain.RecordFields
		_, builtin := numberField(none, name)
		return builtin
	}
	return false
}

// zeroOf returns a value of kind's type for type checking.
func zeroOf(kind domain.AttrType) any {
	switch kind {
	case domain.AttrNumber:
		return float64(0)
	case domain.AttrBool:
		return false
	case domain.AttrDate:
		return time.Time{}
	case kindDateList:
		return []time.Time{}
	}
	return ""
}

// fieldValue returns the run-time value of the field or attribute name in f:
// a string, float64, bool, time.Time, []time.Time, or nil when missing.
func fieldValue(f domain.RecordFields, name string, kind domain.AttrType) (any, error) {
	switch name {
	case "subjectKey":
		return f.SubjectKey, nil
	case "title":
		return f.Title, nil
	case "category":
		return f.Category, nil
	case "priority":
		if f.Priority == "" {
			return domain.PriorityNone, nil
		}
		return f.Priority, nil
	case "status":
		return f.Status, nil
	case "state":
		return string(f.State), nil
	case "url":
		return f.URL, nil
	case "createdAt":
		return dateValue(f.CreatedAt), nil
	case "committedAt":
		return datePtrValue(f.CommittedAt), nil
	case "dueAt":
		return datePtrValue(f.DueAt), nil
	case "completedAt":
		return datePtrValue(f.CompletedAt), nil
	case "measuredAt":
		return datePtrValue(f.MeasuredAt), nil
	case priorDueDatesField:
		out := make([]time.Time, 0, len(f.PriorDueDates))
		for _, d := range f.PriorDueDates {
			if !d.IsZero() {
				out = append(out, dayOf(d))
			}
		}
		return out, nil
	}
	if p, ok := numberField(f, name); ok {
		if p == nil {
			return nil, nil
		}
		return *p, nil
	}
	return attrValue(name, kind, f.Attributes[name])
}

// numberField returns the built-in number field name of f, and whether name
// is one.
func numberField(f domain.RecordFields, name string) (*float64, bool) {
	switch name {
	case "planned":
		return f.Planned, true
	case "actual":
		return f.Actual, true
	case "expectedValue":
		return f.ExpectedValue, true
	case "deliveredValue":
		return f.DeliveredValue, true
	}
	return nil, false
}

func dateValue(d domain.Date) any {
	if d.IsZero() {
		return nil
	}
	return dayOf(d)
}

func datePtrValue(d *domain.Date) any {
	if d == nil {
		return nil
	}
	return dateValue(*d)
}

// attrValue converts the stored attribute v to kind. A missing attribute is
// the zero value of its type; a missing date is no date (nil).
func attrValue(key string, kind domain.AttrType, v any) (any, error) {
	if v == nil {
		if kind == domain.AttrDate {
			return nil, nil
		}
		return zeroOf(kind), nil
	}
	switch kind {
	case domain.AttrString:
		if s, ok := v.(string); ok {
			return s, nil
		}
	case domain.AttrBool:
		switch b := v.(type) {
		case bool:
			return b, nil
		case *bool:
			return b != nil && *b, nil
		}
	case domain.AttrNumber:
		switch n := v.(type) {
		case float64:
			return n, nil
		case float32:
			return float64(n), nil
		case int:
			return float64(n), nil
		case int32:
			return float64(n), nil
		case int64:
			return float64(n), nil
		case json.Number:
			if x, err := n.Float64(); err == nil {
				return x, nil
			}
		case *float64:
			if n == nil {
				return float64(0), nil
			}
			return *n, nil
		}
	case domain.AttrDate:
		switch d := v.(type) {
		case domain.Date:
			return dateValue(d), nil
		case *domain.Date:
			return datePtrValue(d), nil
		case time.Time:
			return dateValue(domain.Date{Time: d}), nil
		case string:
			if d == "" {
				return nil, nil
			}
			if p, err := domain.ParseDate(d); err == nil {
				return dateValue(p), nil
			}
		}
	}
	return nil, fmt.Errorf("where: attribute %q: want a %s, got %v (%T)", key, kind, v, v)
}

// unknownPatcher rewrites the checked tree for the run-time program. A
// comparison that reads a value that can be missing becomes
// "all present ? comparison : nil", and &&, || and ! become the three-valued
// functions, so an unknown comparison never matches.
type unknownPatcher struct {
	fields map[string]domain.AttrType
}

func (p *unknownPatcher) Visit(node *ast.Node) {
	switch n := (*node).(type) {
	case *ast.BinaryNode:
		switch n.Operator {
		case "&&", "and":
			ast.Patch(node, call(fnAnd, n.Left, n.Right))
		case "||", "or":
			ast.Patch(node, call(fnOr, n.Left, n.Right))
		case "==", "!=", "<", "<=", ">", ">=", "in":
			if guard := p.presentGuard(n); guard != nil {
				ast.Patch(node, &ast.ConditionalNode{Cond: guard, Exp1: n, Exp2: &ast.NilNode{}})
			}
		}
	case *ast.UnaryNode:
		if n.Operator == "!" || n.Operator == "not" {
			ast.Patch(node, call(fnNot, n.Node))
		}
	}
}

// presentGuard returns "a != nil && b != nil ..." over the fields in n that
// can be missing, or nil when there are none.
func (p *unknownPatcher) presentGuard(n ast.Node) ast.Node {
	seen := map[string]bool{}
	var guard ast.Node
	var walk func(ast.Node)
	walk = func(n ast.Node) {
		switch n := n.(type) {
		case *ast.IdentifierNode:
			if seen[n.Value] || !nullable(n.Value, p.fields[n.Value]) {
				return
			}
			seen[n.Value] = true
			present := &ast.BinaryNode{Operator: "!=", Left: &ast.IdentifierNode{Value: n.Value}, Right: &ast.NilNode{}}
			if guard == nil {
				guard = present
			} else {
				guard = &ast.BinaryNode{Operator: "&&", Left: guard, Right: present}
			}
		case *ast.BinaryNode:
			walk(n.Left)
			walk(n.Right)
		case *ast.UnaryNode:
			walk(n.Node)
		case *ast.ConditionalNode:
			walk(n.Cond)
			walk(n.Exp1)
			walk(n.Exp2)
		case *ast.CallNode:
			for _, a := range n.Arguments {
				walk(a)
			}
		}
	}
	walk(n)
	return guard
}

func call(name string, args ...ast.Node) ast.Node {
	return &ast.CallNode{Callee: &ast.IdentifierNode{Value: name}, Arguments: args}
}

// logicAnd, logicOr and logicNot implement three-valued logic over true,
// false and nil (unknown).
func logicAnd(params ...any) (any, error) {
	a, b := params[0], params[1]
	if a == false || b == false {
		return false, nil
	}
	if a == true && b == true {
		return true, nil
	}
	return nil, nil
}

func logicOr(params ...any) (any, error) {
	a, b := params[0], params[1]
	if a == true || b == true {
		return true, nil
	}
	if a == false && b == false {
		return false, nil
	}
	return nil, nil
}

func logicNot(params ...any) (any, error) {
	if b, ok := params[0].(bool); ok {
		return !b, nil
	}
	return nil, nil
}
