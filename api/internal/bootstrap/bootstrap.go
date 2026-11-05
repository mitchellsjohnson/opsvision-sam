// Package bootstrap reads a tenant configuration file and writes it into an
// empty store. The local devserver and the importcheck command use it so a
// maintainer can work against their own tenant (org tree, scorecards,
// methodology, import templates, dev users) without a database or any real
// data in the repository.
//
// The file format is the domain's JSON (camelCase), one top-level key per
// kind of thing; see docs/deploy/local-bootstrap.md. Real files belong in the
// git-ignored /private/ folder.
package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/importer"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// maxFileBytes bounds a bootstrap file.
const maxFileBytes = 16 << 20

// File is a tenant configuration.
type File struct {
	Tenant     domain.Tenant               `json:"tenant"`
	Levels     []domain.Level              `json:"levels"`
	Units      []domain.OrgUnit            `json:"units"`
	Moves      []domain.OrgMove            `json:"moves"`
	ItemKinds  []domain.ItemKind           `json:"itemKinds"`
	Items      []domain.TrackedItem        `json:"items"`
	Scorecards []domain.Scorecard          `json:"scorecards"`
	Versions   []domain.MethodologyVersion `json:"versions"`
	Templates  []store.Template            `json:"templates"`
	Users      []DevUser                   `json:"users"`
}

// DevUser is a local sign-in identity. It becomes a member of the tenant,
// bound directly to UserID (there is no pending invitation).
type DevUser struct {
	UserID string       `json:"userId"`
	Email  string       `json:"email"`
	Name   string       `json:"name"`
	Role   domain.Role  `json:"role"`
	Scope  domain.Scope `json:"scope"`
}

// Load reads and validates a bootstrap file. It decodes strictly (unknown
// fields and trailing data are errors), fills the tenant's defaults (January
// fiscal year start, the green/yellow/red scale, a viewer default role), and
// reports every problem it finds, not just the first.
func Load(path string) (File, error) {
	fh, err := os.Open(path)
	if err != nil {
		return File{}, fmt.Errorf("bootstrap: %w", err)
	}
	defer fh.Close()
	raw, err := io.ReadAll(io.LimitReader(fh, maxFileBytes+1))
	if err != nil {
		return File{}, fmt.Errorf("bootstrap: read %s: %w", path, err)
	}
	if len(raw) > maxFileBytes {
		return File{}, fmt.Errorf("bootstrap: %s is larger than %d MiB", path, maxFileBytes>>20)
	}

	var f File
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return File{}, fmt.Errorf("bootstrap: %s: %w", path, err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return File{}, fmt.Errorf("bootstrap: %s has data after the JSON document", path)
	}

	if f.Tenant.FiscalYearStartMonth == 0 {
		f.Tenant.FiscalYearStartMonth = time.January
	}
	if len(f.Tenant.StatusScale) == 0 {
		f.Tenant.StatusScale = domain.DefaultStatusScale()
	}
	if f.Tenant.DefaultRole == "" {
		f.Tenant.DefaultRole = domain.RoleViewer
	}

	if errs := f.validate(); len(errs) > 0 {
		return File{}, fmt.Errorf("bootstrap: %s is not valid:\n%w", path, errors.Join(errs...))
	}
	return f, nil
}

// idSet checks IDs of one kind: valid shape, no duplicates.
type idSet struct {
	kind string
	seen map[string]bool
	errs *[]error
}

func newIDSet(kind string, errs *[]error) *idSet {
	return &idSet{kind: kind, seen: map[string]bool{}, errs: errs}
}

func (s *idSet) add(path, id string) {
	switch {
	case !importer.ValidID(id):
		*s.errs = append(*s.errs, fmt.Errorf("%s: %s id %q %s", path, s.kind, id, importer.IDRule))
	case s.seen[id]:
		*s.errs = append(*s.errs, fmt.Errorf("%s: duplicate %s id %q", path, s.kind, id))
	}
	s.seen[id] = true
}

func (f File) validate() []error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	t := f.Tenant
	switch {
	case t.ID == "":
		bad("tenant.id is required")
	case !importer.ValidID(t.ID):
		bad("tenant.id %q %s", t.ID, importer.IDRule)
	}
	if t.Auth0OrgID == "" {
		bad("tenant.auth0OrgId is required")
	}
	if strings.TrimSpace(t.Name) == "" {
		bad("tenant.name is required")
	}
	if t.FiscalYearStartMonth < time.January || t.FiscalYearStartMonth > time.December {
		bad("tenant.fiscalYearStartMonth %d is not 1..12", int(t.FiscalYearStartMonth))
	}
	if !t.DefaultRole.Valid() {
		bad("tenant.defaultRole %q is not a role", t.DefaultRole)
	}

	// Levels.
	levels := newIDSet("level", &errs)
	depths := map[int]string{}
	for i, l := range f.Levels {
		path := fmt.Sprintf("levels[%d]", i)
		levels.add(path, l.ID)
		if l.Depth < 0 {
			bad("%s: depth %d is negative", path, l.Depth)
		}
		if prev, dup := depths[l.Depth]; dup {
			bad("%s: depth %d is already used by level %q", path, l.Depth, prev)
		}
		depths[l.Depth] = l.ID
	}

	// Org units and moves.
	units := newIDSet("unit", &errs)
	for i, u := range f.Units {
		path := fmt.Sprintf("units[%d]", i)
		units.add(path, u.ID)
		if !levels.seen[u.LevelID] {
			bad("%s: unit %q names unknown level %q", path, u.ID, u.LevelID)
		}
	}
	if _, err := orgtree.New(f.Units, f.Moves); err != nil {
		bad("org tree: %v", err)
	}

	// Item kinds and items.
	kinds := newIDSet("item kind", &errs)
	for i, k := range f.ItemKinds {
		kinds.add(fmt.Sprintf("itemKinds[%d]", i), k.ID)
	}
	items := newIDSet("item", &errs)
	for i, it := range f.Items {
		path := fmt.Sprintf("items[%d]", i)
		items.add(path, it.ID)
		if !kinds.seen[it.KindID] {
			bad("%s: item %q names unknown kind %q", path, it.ID, it.KindID)
		}
		if !units.seen[it.OrgUnitID] {
			bad("%s: item %q names unknown org unit %q", path, it.ID, it.OrgUnitID)
		}
	}

	// Scorecards and versions.
	scorecards := newIDSet("scorecard", &errs)
	for i, sc := range f.Scorecards {
		scorecards.add(fmt.Sprintf("scorecards[%d]", i), sc.ID)
	}
	type versionKey struct{ scorecard, id string }
	versionSeen := map[versionKey]bool{}
	for i, v := range f.Versions {
		path := fmt.Sprintf("versions[%d] (%s)", i, v.ID)
		if !importer.ValidID(v.ID) {
			bad("%s: version id %q %s", path, v.ID, importer.IDRule)
		}
		if !scorecards.seen[v.ScorecardID] {
			bad("%s: names unknown scorecard %q", path, v.ScorecardID)
		}
		k := versionKey{v.ScorecardID, v.ID}
		if versionSeen[k] {
			bad("%s: duplicate version id %q in scorecard %q", path, v.ID, v.ScorecardID)
		}
		versionSeen[k] = true
		// A draft has no effective period until it is scheduled to publish.
		if v.EffectiveFrom == (period.Period{}) && v.Status != domain.VersionDraft {
			bad("%s: effectiveFrom is required", path)
		}
		switch v.Status {
		case domain.VersionDraft, domain.VersionInReview:
			// A draft may be incomplete; it is validated when it is published.
		case domain.VersionPublished, domain.VersionSuperseded:
			for _, e := range v.Content.Validate(t.StatusScale) {
				bad("%s: content.%s: %s", path, e.Path, e.Message)
			}
		default:
			bad("%s: status %q is not draft, in_review, published or superseded", path, v.Status)
		}
	}

	// Templates.
	templates := newIDSet("template", &errs)
	for i, tpl := range f.Templates {
		path := fmt.Sprintf("templates[%d] (%s)", i, tpl.ID)
		templates.add(path, tpl.ID)
		if tpl.Profile != importer.ProfileLegacyWorkbook {
			bad("%s: profile %q must be %s", path, tpl.Profile, importer.ProfileLegacyWorkbook)
			continue
		}
		tb, problems := importer.DecodeTemplateBody(tpl.Body)
		for _, p := range problems {
			bad("%s: %s %s", path, p.Path, p.Message)
		}
		if len(problems) == 0 && tb.ScorecardID != "" && !scorecards.seen[tb.ScorecardID] {
			bad("%s: body.scorecardId names unknown scorecard %q", path, tb.ScorecardID)
		}
	}

	// Users.
	userSeen := map[string]bool{}
	for i, u := range f.Users {
		path := fmt.Sprintf("users[%d]", i)
		switch {
		case u.UserID == "" || strings.Contains(u.UserID, "#"):
			bad("%s: userId %q must be non-empty and not contain '#'", path, u.UserID)
		case userSeen[u.UserID]:
			bad("%s: duplicate userId %q", path, u.UserID)
		}
		userSeen[u.UserID] = true
		if strings.TrimSpace(u.Email) == "" {
			bad("%s: email is required", path)
		}
		if !u.Role.Valid() {
			bad("%s: role %q is not admin, contributor or viewer", path, u.Role)
		}
		for _, id := range u.Scope.OrgUnitIDs {
			if !units.seen[id] {
				bad("%s: scope names unknown org unit %q", path, id)
			}
		}
	}
	return errs
}

// Apply writes f into st, which must not have the tenant yet. Every
// membership is bound by user ID. now stamps what the file leaves unstamped.
// It stops at the first store error; a half-applied tenant should be
// discarded (the devserver keeps it in memory, so a restart does).
func Apply(ctx context.Context, st store.Store, f File, now time.Time) error {
	tid := f.Tenant.ID
	switch _, err := st.GetTenant(ctx, tid); {
	case err == nil:
		return fmt.Errorf("bootstrap: tenant %q already exists; refusing to overwrite it", tid)
	case !errors.Is(err, store.ErrNotFound):
		return fmt.Errorf("bootstrap: look up tenant: %w", err)
	}

	now = now.UTC()
	t := f.Tenant
	if t.CreatedAt.IsZero() {
		t.CreatedAt = now
	}
	if err := st.CreateTenant(ctx, t); err != nil {
		return fmt.Errorf("bootstrap: create tenant: %w", err)
	}
	if err := st.PutLevels(ctx, tid, f.Levels); err != nil {
		return fmt.Errorf("bootstrap: levels: %w", err)
	}
	for _, u := range f.Units {
		if err := st.PutOrgUnit(ctx, tid, u); err != nil {
			return fmt.Errorf("bootstrap: org unit %s: %w", u.ID, err)
		}
	}
	for _, m := range f.Moves {
		if err := st.PutOrgMove(ctx, tid, m); err != nil {
			return fmt.Errorf("bootstrap: org move of %s: %w", m.UnitID, err)
		}
	}
	for _, k := range f.ItemKinds {
		if err := st.PutItemKind(ctx, tid, k); err != nil {
			return fmt.Errorf("bootstrap: item kind %s: %w", k.ID, err)
		}
	}
	for _, it := range f.Items {
		if err := st.PutTrackedItem(ctx, tid, it); err != nil {
			return fmt.Errorf("bootstrap: tracked item %s: %w", it.ID, err)
		}
	}
	for _, sc := range f.Scorecards {
		if err := st.PutScorecard(ctx, tid, sc); err != nil {
			return fmt.Errorf("bootstrap: scorecard %s: %w", sc.ID, err)
		}
	}
	for _, v := range f.Versions {
		if v.PublishedAt == nil && (v.Status == domain.VersionPublished || v.Status == domain.VersionSuperseded) {
			at := now
			v.PublishedAt = &at
		}
		if err := st.PutVersion(ctx, tid, v, store.MustNotExist); err != nil {
			return fmt.Errorf("bootstrap: version %s: %w", v.ID, err)
		}
	}
	for _, tpl := range f.Templates {
		if tpl.Name == "" {
			tpl.Name = tpl.ID
		}
		if err := st.PutTemplate(ctx, tid, tpl); err != nil {
			return fmt.Errorf("bootstrap: template %s: %w", tpl.ID, err)
		}
	}
	for _, u := range f.Users {
		m := domain.Membership{UserID: u.UserID, Email: u.Email, Name: u.Name, Role: u.Role, Scope: u.Scope, CreatedAt: now}
		if err := st.PutMembership(ctx, tid, m); err != nil {
			return fmt.Errorf("bootstrap: member %s: %w", u.UserID, err)
		}
	}
	return nil
}
