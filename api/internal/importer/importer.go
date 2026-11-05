// Package importer is the one place that turns a legacy workbook into a change
// set for a tenant: it decodes a stored template, picks the scorecard, loads
// what the parser compares against, and runs legacy.ParseWorkbook.
//
// The Import API (package httpapi), the local devserver's startup import, and
// the importcheck command all call it, so the local tools and the API cannot
// disagree about what an import would do.
package importer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/legacy"
	"opsvision/internal/objects"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/store"
	"opsvision/internal/xlsx"
)

// ProfileLegacyWorkbook is the profile of a legacy workbook template.
const ProfileLegacyWorkbook = "legacy_workbook"

// IDRule describes ValidID in words.
const IDRule = "must be 1-64 characters: letters, digits, '_' or '-'"

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ValidID reports whether s is a valid client-supplied identifier (tenant,
// unit, template and similar IDs).
func ValidID(s string) bool { return idPattern.MatchString(s) }

// Problem locates one problem with a template or request.
type Problem struct {
	Path    string
	Message string
}

// Error is a problem the caller can fix, for example a template that names a
// scorecard that does not exist. Path, when set, is the request field at
// fault.
type Error struct {
	Path    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// TemplateBody is the stored document of a legacy_workbook template: the
// legacy mapping plus the scorecard to import into.
type TemplateBody struct {
	legacy.Template
	// ScorecardID names the scorecard the import writes to. Without it the
	// tenant's only scorecard is used.
	ScorecardID string `json:"scorecardId,omitempty"`
}

// DecodeTemplateBody decodes a template body strictly (unknown fields and
// trailing data are errors) and validates the mapping. The returned problems
// are empty when the template is usable.
func DecodeTemplateBody(raw []byte) (TemplateBody, []Problem) {
	var tb TemplateBody
	if len(raw) > legacy.MaxTemplateBytes {
		return tb, []Problem{{Path: "body", Message: fmt.Sprintf("is larger than %d bytes", legacy.MaxTemplateBytes)}}
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tb); err != nil {
		return TemplateBody{}, []Problem{{Path: "body", Message: "is not a valid template: " + err.Error()}}
	}
	if _, err := dec.Token(); err != io.EOF {
		return TemplateBody{}, []Problem{{Path: "body", Message: "has data after the JSON document"}}
	}
	var out []Problem
	if tb.ScorecardID != "" && !ValidID(tb.ScorecardID) {
		out = append(out, Problem{Path: "body.scorecardId", Message: IDRule})
	}
	for _, f := range tb.Template.Validate() {
		out = append(out, Problem{Path: "body", Message: strings.TrimPrefix(f.Message, "template: ")})
	}
	return tb, out
}

// CalendarOf returns the fiscal calendar of a tenant.
func CalendarOf(t domain.Tenant) period.Calendar {
	return period.Calendar{FiscalYearStartMonth: t.FiscalYearStartMonth}
}

// ResolveScorecard picks the scorecard an import writes to: the one the
// template names, else the tenant's only one. Problems the template author
// can fix come back as *Error.
func ResolveScorecard(ctx context.Context, st store.Store, tenantID, named string) (string, error) {
	if named != "" {
		if _, err := st.GetScorecard(ctx, tenantID, named); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return "", &Error{Path: "body.scorecardId", Message: fmt.Sprintf("scorecard %q does not exist", named)}
			}
			return "", err
		}
		return named, nil
	}
	scs, err := st.ListScorecards(ctx, tenantID)
	if err != nil {
		return "", err
	}
	switch len(scs) {
	case 1:
		return scs[0].ID, nil
	case 0:
		return "", &Error{Message: "the tenant has no scorecard to import into"}
	default:
		return "", &Error{Message: "the tenant has several scorecards; set scorecardId in the template body"}
	}
}

// Years lists the fiscal years of data a parse compares against: those the
// template's sheets name, and the year before each.
func Years(t legacy.Template) []int {
	seen := map[int]bool{}
	add := func(fy int) {
		seen[fy] = true
		seen[fy-1] = true
	}
	for _, sm := range t.Sheets {
		add(sm.FiscalYear)
		for _, text := range sm.PeriodColumns {
			if per, err := period.Parse(text); err == nil {
				add(per.FY)
			}
		}
	}
	out := make([]int, 0, len(seen))
	for y := range seen {
		out = append(out, y)
	}
	sort.Ints(out)
	return out
}

// LoadInput reads everything the engine needs for one scorecard of a tenant:
// the org tree, tracked items, every methodology version, and the data points
// and overrides of the given fiscal years (none when years is empty).
//
// It builds a fresh Input on every call. An engine.Index memoizes values
// computed from the input, so one must never outlive the request that read
// the data it was built from.
func LoadInput(ctx context.Context, st store.Store, tenant domain.Tenant, cal period.Calendar, scorecardID string, years []int) (*engine.Input, error) {
	units, err := st.ListOrgUnits(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	moves, err := st.ListOrgMoves(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	tree, err := orgtree.New(units, moves)
	if err != nil {
		return nil, fmt.Errorf("build org tree: %w", err)
	}
	items, err := st.ListTrackedItems(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	versions, err := st.ListVersions(ctx, tenant.ID, scorecardID)
	if err != nil {
		return nil, err
	}
	in := &engine.Input{
		Cal:       cal,
		Tree:      tree,
		Items:     items,
		Versions:  versions,
		Data:      []domain.DataPoint{},
		Overrides: []domain.Override{},
	}
	if len(years) > 0 {
		in.Data, in.Overrides, err = st.ListData(ctx, tenant.ID, scorecardID, years)
		if err != nil {
			return nil, err
		}
	}
	return in, nil
}

// Parse parses a workbook with a template into a change set that would write
// to scorecardID. Nothing is stored. The caller sets the change set's ID,
// CreatedBy and CreatedAt.
func Parse(ctx context.Context, st store.Store, tenant domain.Tenant, cal period.Calendar, scorecardID string, t legacy.Template, wb *xlsx.Workbook) (changeset.ChangeSet, error) {
	base, err := LoadInput(ctx, st, tenant, cal, scorecardID, Years(t))
	if err != nil {
		return changeset.ChangeSet{}, err
	}
	return legacy.ParseWorkbook(wb, t, base), nil
}

// Result is a parsed import.
type Result struct {
	TemplateID  string
	ScorecardID string
	ChangeSet   changeset.ChangeSet
}

// ParseStored parses wb with the template saved under templateID, resolving
// the scorecard the way the Import API does. It is the whole "parse for
// import" flow for callers that have a template ID rather than a request.
func ParseStored(ctx context.Context, st store.Store, tenant domain.Tenant, cal period.Calendar, templateID string, wb *xlsx.Workbook) (Result, error) {
	tpls, err := st.ListTemplates(ctx, tenant.ID)
	if err != nil {
		return Result{}, err
	}
	var tpl *store.Template
	for i := range tpls {
		if tpls[i].ID == templateID {
			tpl = &tpls[i]
		}
	}
	if tpl == nil {
		return Result{}, &Error{Path: "templateId", Message: fmt.Sprintf("template %q does not exist", templateID)}
	}
	if tpl.Profile != ProfileLegacyWorkbook {
		return Result{}, &Error{Path: "templateId", Message: fmt.Sprintf("template %q is not a legacy_workbook template", templateID)}
	}
	tb, problems := DecodeTemplateBody(tpl.Body)
	if len(problems) > 0 {
		msgs := make([]string, len(problems))
		for i, p := range problems {
			msgs[i] = p.Path + " " + p.Message
		}
		return Result{}, &Error{Message: fmt.Sprintf("template %q is not valid: %s", templateID, strings.Join(msgs, "; "))}
	}
	scorecardID, err := ResolveScorecard(ctx, st, tenant.ID, tb.ScorecardID)
	if err != nil {
		return Result{}, err
	}
	cs, err := Parse(ctx, st, tenant, cal, scorecardID, tb.Template, wb)
	if err != nil {
		return Result{}, err
	}
	return Result{TemplateID: templateID, ScorecardID: scorecardID, ChangeSet: cs}, nil
}

// OpenWorkbookFile opens a workbook on disk with the same size limit as an
// upload. It only reads the file.
func OpenWorkbookFile(path string) (*xlsx.Workbook, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() > objects.MaxUploadBytes {
		return nil, fmt.Errorf("%s is larger than %d MiB", path, objects.MaxUploadBytes>>20)
	}
	wb, err := xlsx.Open(f, st.Size())
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return wb, nil
}

// Severities lists the finding severities, most serious first.
var Severities = []string{changeset.SeverityError, changeset.SeverityWarn, changeset.SeverityInfo}

// CountFindings counts findings by severity.
func CountFindings(fs []changeset.Finding) map[string]int {
	out := map[string]int{}
	for _, f := range fs {
		out[f.Severity]++
	}
	return out
}
