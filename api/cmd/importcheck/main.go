// Command importcheck parses a legacy workbook with an import template, the
// way the Import API would, and reports what it found. It is for iterating on
// a template quickly: edit the bootstrap file, run it again.
//
//	go run ./cmd/importcheck -bootstrap <json> -workbook <xlsx> -template <id> \
//	    [-sheet <name>] [-limit N] [-severity error|warn|info] [-json]
//
// The bootstrap file (see docs/deploy/local-bootstrap.md) is loaded into a
// throwaway in-memory store; the workbook is only read. Nothing is applied
// and the tool never writes a file: everything goes to stdout (messages about
// bad input go to stderr).
//
// Findings are printed grouped by severity, then by sheet, up to -limit per
// group. -severity sets the lowest severity shown (error shows errors only;
// warn shows errors and warnings; info shows all, the default). -sheet shows
// one sheet's findings. The counts line always covers everything.
//
// Exit status: 0 when the parse has no error findings, 1 when it has any
// (whatever -sheet and -severity hide), 2 for bad flags or unreadable input.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"opsvision/internal/bootstrap"
	"opsvision/internal/changeset"
	"opsvision/internal/importer"
	"opsvision/internal/store/memstore"
)

const (
	exitOK       = 0
	exitFindings = 1
	exitUsage    = 2
)

type options struct {
	bootstrap string
	workbook  string
	template  string
	sheet     string
	limit     int
	severity  string
	json      bool
}

func parseFlags(args []string, stderr io.Writer) (options, error) {
	var o options
	fs := flag.NewFlagSet("importcheck", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&o.bootstrap, "bootstrap", "", "bootstrap JSON file holding the tenant and the template (required)")
	fs.StringVar(&o.workbook, "workbook", "", "legacy .xlsx workbook to check (required)")
	fs.StringVar(&o.template, "template", "", "ID of the template in the bootstrap file (required)")
	fs.StringVar(&o.sheet, "sheet", "", "show only the findings of this sheet")
	fs.IntVar(&o.limit, "limit", 50, "most findings to print per severity and sheet")
	fs.StringVar(&o.severity, "severity", "info", "lowest severity to show: error, warn or info")
	fs.BoolVar(&o.json, "json", false, "print one JSON document instead of text")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	switch {
	case o.bootstrap == "" || o.workbook == "" || o.template == "":
		return o, errors.New("-bootstrap, -workbook and -template are required")
	case o.limit < 1:
		return o, errors.New("-limit must be at least 1")
	}
	switch o.severity {
	case changeset.SeverityError, changeset.SeverityWarn, changeset.SeverityInfo:
	default:
		return o, fmt.Errorf("invalid -severity %q (want error, warn or info)", o.severity)
	}
	return o, nil
}

// report is the result of a check.
type report struct {
	TemplateID    string         `json:"templateId"`
	ScorecardID   string         `json:"scorecardId"`
	Counts        counts         `json:"counts"`
	FindingCounts map[string]int `json:"findingCounts"`
	Groups        []group        `json:"groups"`
}

type counts struct {
	DataPoints  int `json:"dataPoints"`
	Overrides   int `json:"overrides"`
	VersionText int `json:"versionText"`
	LegacyNotes int `json:"legacyNotes"`
}

// group is the findings of one severity on one sheet. Total counts all of
// them; Findings holds up to the limit.
type group struct {
	Severity string              `json:"severity"`
	Sheet    string              `json:"sheet"`
	Total    int                 `json:"total"`
	Findings []changeset.Finding `json:"findings"`
}

// severityShown reports whether severity s passes the -severity floor.
func severityShown(s, floor string) bool {
	rank := map[string]int{changeset.SeverityError: 0, changeset.SeverityWarn: 1, changeset.SeverityInfo: 2}
	r, ok := rank[s]
	return ok && r <= rank[floor]
}

func analyze(o options) (report, error) {
	ctx := context.Background()
	f, err := bootstrap.Load(o.bootstrap)
	if err != nil {
		return report{}, err
	}
	st := memstore.New()
	if err := bootstrap.Apply(ctx, st, f, time.Now()); err != nil {
		return report{}, err
	}
	wb, err := importer.OpenWorkbookFile(o.workbook)
	if err != nil {
		return report{}, err
	}
	res, err := importer.ParseStored(ctx, st, f.Tenant, importer.CalendarOf(f.Tenant), o.template, wb)
	if err != nil {
		return report{}, err
	}
	cs := res.ChangeSet

	r := report{
		TemplateID:  res.TemplateID,
		ScorecardID: res.ScorecardID,
		Counts: counts{
			DataPoints: len(cs.Data), Overrides: len(cs.Overrides),
			VersionText: len(cs.VersionText), LegacyNotes: len(cs.Notes),
		},
		FindingCounts: map[string]int{},
		Groups:        []group{},
	}
	for _, sev := range importer.Severities {
		r.FindingCounts[sev] = 0
	}
	for k, v := range importer.CountFindings(cs.Findings) {
		r.FindingCounts[k] = v
	}

	type key struct{ severity, sheet string }
	byKey := map[key]*group{}
	for _, fd := range cs.Findings {
		if !severityShown(fd.Severity, o.severity) {
			continue
		}
		if o.sheet != "" && !strings.EqualFold(fd.Sheet, o.sheet) {
			continue
		}
		k := key{fd.Severity, fd.Sheet}
		g := byKey[k]
		if g == nil {
			g = &group{Severity: fd.Severity, Sheet: fd.Sheet, Findings: []changeset.Finding{}}
			byKey[k] = g
		}
		g.Total++
		if len(g.Findings) < o.limit {
			g.Findings = append(g.Findings, fd)
		}
	}
	for _, g := range byKey {
		r.Groups = append(r.Groups, *g)
	}
	sevRank := func(s string) int {
		for i, v := range importer.Severities {
			if v == s {
				return i
			}
		}
		return len(importer.Severities)
	}
	sort.Slice(r.Groups, func(i, j int) bool {
		a, b := r.Groups[i], r.Groups[j]
		if sevRank(a.Severity) != sevRank(b.Severity) {
			return sevRank(a.Severity) < sevRank(b.Severity)
		}
		return a.Sheet < b.Sheet
	})
	return r, nil
}

func printText(w io.Writer, r report) {
	fmt.Fprintf(w, "template: %s\nscorecard: %s\n", r.TemplateID, r.ScorecardID)
	fmt.Fprintf(w, "data points: %d\noverrides: %d\nversion text: %d\nlegacy notes: %d\n",
		r.Counts.DataPoints, r.Counts.Overrides, r.Counts.VersionText, r.Counts.LegacyNotes)
	fmt.Fprintf(w, "findings: %d error, %d warn, %d info\n",
		r.FindingCounts[changeset.SeverityError], r.FindingCounts[changeset.SeverityWarn], r.FindingCounts[changeset.SeverityInfo])

	lastSeverity := ""
	for _, g := range r.Groups {
		if g.Severity != lastSeverity {
			total := 0
			for _, h := range r.Groups {
				if h.Severity == g.Severity {
					total += h.Total
				}
			}
			fmt.Fprintf(w, "\n%s (%d)\n", g.Severity, total)
			lastSeverity = g.Severity
		}
		sheet := g.Sheet
		if sheet == "" {
			sheet = "(no sheet)"
		}
		fmt.Fprintf(w, "  %s\n", sheet)
		for _, fd := range g.Findings {
			// Most messages already begin with Sheet!Cell.
			if fd.Cell != "" && !strings.Contains(fd.Message, fd.Cell) {
				fmt.Fprintf(w, "    %s: %s\n", fd.Cell, fd.Message)
			} else {
				fmt.Fprintf(w, "    %s\n", fd.Message)
			}
		}
		if more := g.Total - len(g.Findings); more > 0 {
			fmt.Fprintf(w, "    ... and %d more\n", more)
		}
	}
}

// run is main with its streams and arguments injected; it returns the exit status.
func run(args []string, stdout, stderr io.Writer) int {
	o, err := parseFlags(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		fmt.Fprintln(stderr, "importcheck:", err)
		return exitUsage
	}
	r, err := analyze(o)
	if err != nil {
		fmt.Fprintln(stderr, "importcheck:", err)
		return exitUsage
	}
	if o.json {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(r); err != nil {
			fmt.Fprintln(stderr, "importcheck:", err)
			return exitUsage
		}
	} else {
		printText(stdout, r)
	}
	if r.FindingCounts[changeset.SeverityError] > 0 {
		return exitFindings
	}
	return exitOK
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }
