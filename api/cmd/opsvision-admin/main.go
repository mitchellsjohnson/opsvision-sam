// Command opsvision-admin loads a tenant into a deployed OpsVision DynamoDB
// table. An operator runs it with their own AWS credentials (the default
// credential chain: environment, shared config, SSO); the deployment itself
// needs no extra permissions or endpoints for it.
//
//	opsvision-admin bootstrap -table T -file bootstrap.json [-dry-run] [-overwrite]
//	opsvision-admin import -table T -tenant ID -workbook x.xlsx -template ID [-dry-run]
//
// bootstrap writes the tenant, org model, scorecards, methodology versions and
// import templates of a bootstrap file (the same file and validation as the
// dev server's -bootstrap, see docs/deploy/local-bootstrap.md) and prints how
// many of each it created, updated or left unchanged. It only creates what is
// missing. An existing item (level, unit, move, item kind, item, scorecard,
// version, template, member) that differs from the file is reported as
// "differs (kept)" and left untouched, so running it again after go-live never
// wipes edits made in the app. -overwrite updates those items instead (versions
// against their stored revision), except a version that is not a draft: it is
// immutable in the app, so it is never overwritten and is reported as
// "differs (kept, published)". It is safe to run again: nothing is
// duplicated. A tenant without an auth0OrgId is accepted, as a
// single-organization deployment has none.
//
// import parses a legacy workbook with a template saved in the table, as
// cmd/importcheck does, and prints the counts and findings. Without -dry-run
// it applies the result as a change set (channel "import", actor
// "cli:<user>"). The workbook is read from the local file; nothing goes
// through S3. A workbook with error findings is never applied.
//
// With -dry-run neither command writes anything.
//
// Exit status: 0 on success, 1 when an import has error findings, 2 for bad
// flags, unreadable input or a store failure.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/oklog/ulid/v2"

	"opsvision/internal/bootstrap"
	"opsvision/internal/changeset"
	"opsvision/internal/importer"
	"opsvision/internal/store"
	"opsvision/internal/store/dynamostore"
)

const (
	exitOK       = 0
	exitFindings = 1
	exitUsage    = 2

	// findingLimit is the most findings printed per severity.
	findingLimit = 50
)

// deps are the command's connections to the outside world, replaced in tests.
type deps struct {
	open func(ctx context.Context, table string) (store.Store, error)
	now  func() time.Time
	user func() string
}

func realDeps() deps {
	return deps{
		open: func(ctx context.Context, table string) (store.Store, error) {
			cfg, err := config.LoadDefaultConfig(ctx)
			if err != nil {
				return nil, fmt.Errorf("load AWS config: %w", err)
			}
			return dynamostore.New(dynamodb.NewFromConfig(cfg), table), nil
		},
		now: time.Now,
		user: func() string {
			if u, err := user.Current(); err == nil && u.Username != "" {
				return u.Username
			}
			if n := os.Getenv("USER"); n != "" {
				return n
			}
			return "unknown"
		},
	}
}

const usage = `usage:
  opsvision-admin bootstrap -table T -file bootstrap.json [-dry-run] [-overwrite]
  opsvision-admin import -table T -tenant ID -workbook x.xlsx -template ID [-dry-run]`

// run is main with its streams and dependencies injected; it returns the exit status.
func run(args []string, stdout, stderr io.Writer, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "opsvision-admin: a subcommand is required")
		fmt.Fprintln(stderr, usage)
		return exitUsage
	}
	switch args[0] {
	case "bootstrap":
		return runBootstrap(args[1:], stdout, stderr, d)
	case "import":
		return runImport(args[1:], stdout, stderr, d)
	case "-h", "-help", "--help", "help":
		fmt.Fprintln(stdout, usage)
		return exitOK
	default:
		fmt.Fprintf(stderr, "opsvision-admin: unknown subcommand %q\n%s\n", args[0], usage)
		return exitUsage
	}
}

func newFlags(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("opsvision-admin "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

// parseFlags parses args and checks that the required flags (name, value
// pairs) are set and no arguments are left over. It returns false, with the
// exit status, when the caller should stop.
func parseFlags(fs *flag.FlagSet, args []string, stderr io.Writer, required func() [][2]string) (bool, int) {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return false, exitOK
		}
		return false, exitUsage
	}
	for _, r := range required() {
		if r[1] == "" {
			fmt.Fprintf(stderr, "opsvision-admin: -%s is required\n", r[0])
			return false, exitUsage
		}
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "opsvision-admin: unexpected argument %q\n", fs.Arg(0))
		return false, exitUsage
	}
	return true, exitOK
}

func runBootstrap(args []string, stdout, stderr io.Writer, d deps) int {
	fs := newFlags("bootstrap", stderr)
	table := fs.String("table", "", "DynamoDB table name (required)")
	file := fs.String("file", "", "bootstrap JSON file (required)")
	dry := fs.Bool("dry-run", false, "report what would change; write nothing")
	overwrite := fs.Bool("overwrite", false, "update existing items that differ from the file (default: keep them and report them)")
	if ok, code := parseFlags(fs, args, stderr, func() [][2]string {
		return [][2]string{{"table", *table}, {"file", *file}}
	}); !ok {
		return code
	}
	ctx := context.Background()
	f, err := bootstrap.LoadWith(*file, bootstrap.LoadOptions{AllowEmptyOrg: true})
	if err != nil {
		fmt.Fprintln(stderr, "opsvision-admin:", err)
		return exitUsage
	}
	st, err := d.open(ctx, *table)
	if err != nil {
		fmt.Fprintln(stderr, "opsvision-admin:", err)
		return exitUsage
	}
	counts, err := bootstrap.Sync(ctx, st, f, d.now(), bootstrap.SyncOptions{DryRun: *dry, Overwrite: *overwrite})
	if err != nil {
		fmt.Fprintln(stderr, "opsvision-admin:", err)
		return exitUsage
	}
	printCounts(stdout, f.Tenant.ID, counts, *dry, *overwrite)
	return exitOK
}

func printCounts(w io.Writer, tenantID string, c bootstrap.Counts, dry, overwrite bool) {
	fmt.Fprintf(w, "tenant id: %s\n", tenantID)
	if dry {
		fmt.Fprintln(w, "dry run: nothing is written")
	}
	for _, k := range c.Kinds() {
		fmt.Fprintf(w, "%s: %d created, %d updated, %d unchanged", k.Name, k.Count.Created, k.Count.Updated, k.Count.Unchanged)
		if k.Count.Differs > 0 {
			fmt.Fprintf(w, ", %d differs (kept)", k.Count.Differs)
		}
		fmt.Fprintln(w)
	}
	canOverwrite := false
	for _, d := range c.Differing {
		if d.Locked != "" {
			fmt.Fprintf(w, "differs (kept, %s): %s %s\n", d.Locked, d.Kind, d.ID)
			continue
		}
		fmt.Fprintf(w, "differs (kept): %s %s\n", d.Kind, d.ID)
		canOverwrite = true
	}
	if canOverwrite && !overwrite {
		fmt.Fprintln(w, "existing items that differ from the file were left as they are; pass -overwrite to update them")
	}
}

func runImport(args []string, stdout, stderr io.Writer, d deps) int {
	fs := newFlags("import", stderr)
	table := fs.String("table", "", "DynamoDB table name (required)")
	tenantID := fs.String("tenant", "", "tenant ID (required)")
	workbook := fs.String("workbook", "", "legacy .xlsx workbook, read from this local file (required)")
	template := fs.String("template", "", "ID of the saved import template (required)")
	dry := fs.Bool("dry-run", false, "parse and report; apply nothing")
	if ok, code := parseFlags(fs, args, stderr, func() [][2]string {
		return [][2]string{{"table", *table}, {"tenant", *tenantID}, {"workbook", *workbook}, {"template", *template}}
	}); !ok {
		return code
	}
	ctx := context.Background()
	st, err := d.open(ctx, *table)
	if err != nil {
		fmt.Fprintln(stderr, "opsvision-admin:", err)
		return exitUsage
	}
	rep, err := Import(ctx, st, ImportParams{
		TenantID: *tenantID, Workbook: *workbook, TemplateID: *template,
		Actor: "cli:" + d.user(), DryRun: *dry,
	}, d.now())
	if rep.TemplateID != "" {
		printImport(stdout, rep, *dry)
	}
	switch {
	case errors.Is(err, errErrorFindings):
		fmt.Fprintln(stderr, "opsvision-admin:", err)
		return exitFindings
	case err != nil:
		fmt.Fprintln(stderr, "opsvision-admin:", err)
		return exitUsage
	}
	return exitOK
}

var errErrorFindings = errors.New("the workbook has error findings and cannot be applied")

// ImportParams says what to import.
type ImportParams struct {
	TenantID   string
	Workbook   string // local .xlsx path
	TemplateID string
	Actor      string // recorded as the author, "cli:<user>"
	DryRun     bool
}

// ImportReport is the outcome of Import.
type ImportReport struct {
	TemplateID, ScorecardID  string
	DataPoints, Overrides    int
	VersionText, LegacyNotes int
	FindingCounts            map[string]int
	Findings                 []changeset.Finding
	// Applied is nil for a dry run or when the change set was not applied.
	Applied *changeset.ApplyResult
}

// Import parses a workbook with the tenant's saved template and, unless
// DryRun, applies it as a change set, through the code the Import API uses
// (importer.ParseStored and changeset.Apply). It needs only the store: the
// workbook is read from disk, not from the object store. A change set with
// error findings is reported, returned with errErrorFindings, and not applied.
func Import(ctx context.Context, st store.Store, p ImportParams, now time.Time) (ImportReport, error) {
	tenant, err := st.GetTenant(ctx, p.TenantID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ImportReport{}, fmt.Errorf("tenant %q does not exist in this table; run bootstrap first", p.TenantID)
		}
		return ImportReport{}, fmt.Errorf("look up tenant %q: %w", p.TenantID, err)
	}
	wb, err := importer.OpenWorkbookFile(p.Workbook)
	if err != nil {
		return ImportReport{}, err
	}
	res, err := importer.ParseStored(ctx, st, tenant, importer.CalendarOf(tenant), p.TemplateID, wb)
	if err != nil {
		return ImportReport{}, err
	}
	cs := res.ChangeSet
	cs.ID = ulid.Make().String()
	cs.CreatedBy = p.Actor
	cs.CreatedAt = now.UTC()

	rep := ImportReport{
		TemplateID: res.TemplateID, ScorecardID: res.ScorecardID,
		DataPoints: len(cs.Data), Overrides: len(cs.Overrides),
		VersionText: len(cs.VersionText), LegacyNotes: len(cs.Notes),
		FindingCounts: map[string]int{}, Findings: cs.Findings,
	}
	for _, sev := range importer.Severities {
		rep.FindingCounts[sev] = 0
	}
	for k, v := range importer.CountFindings(cs.Findings) {
		rep.FindingCounts[k] = v
	}
	if rep.FindingCounts[changeset.SeverityError] > 0 {
		return rep, fmt.Errorf("%w (%d error findings)", errErrorFindings, rep.FindingCounts[changeset.SeverityError])
	}
	if p.DryRun {
		return rep, nil
	}
	applied, err := changeset.Apply(ctx, st, p.TenantID, res.ScorecardID, cs, p.Actor)
	if err != nil {
		return rep, fmt.Errorf("apply: %w", err)
	}
	rep.Applied = &applied
	return rep, nil
}

func printImport(w io.Writer, r ImportReport, dry bool) {
	fmt.Fprintf(w, "template: %s\nscorecard: %s\n", r.TemplateID, r.ScorecardID)
	if dry {
		fmt.Fprintln(w, "dry run: nothing is written")
	}
	fmt.Fprintf(w, "data points: %d\noverrides: %d\nversion text: %d\nlegacy notes: %d\n",
		r.DataPoints, r.Overrides, r.VersionText, r.LegacyNotes)
	fmt.Fprintf(w, "findings: %d error, %d warn, %d info\n",
		r.FindingCounts[changeset.SeverityError], r.FindingCounts[changeset.SeverityWarn], r.FindingCounts[changeset.SeverityInfo])
	for _, sev := range importer.Severities {
		n := 0
		for _, f := range r.Findings {
			if f.Severity != sev {
				continue
			}
			if n == 0 {
				fmt.Fprintf(w, "\n%s (%d)\n", sev, r.FindingCounts[sev])
			}
			if n == findingLimit {
				fmt.Fprintf(w, "  ... and %d more\n", r.FindingCounts[sev]-findingLimit)
				break
			}
			fmt.Fprintf(w, "  %s\n", f.Message)
			n++
		}
	}
	if a := r.Applied; a != nil {
		fmt.Fprintf(w, "\napplied: %d data points, %d overrides, %d version text changes", a.DataPoints, a.Overrides, a.VersionText)
		if len(a.Findings) > 0 {
			fmt.Fprintf(w, " (%d version text changes skipped)", len(a.Findings))
		}
		fmt.Fprintln(w)
		for _, f := range a.Findings {
			fmt.Fprintf(w, "  skipped: %s\n", f.Message)
		}
	}
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, realDeps())) }
