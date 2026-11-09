package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// Count tallies what Sync did, or would do, to one kind of thing.
type Count struct {
	Created, Updated, Unchanged int
	// Differs counts existing things that differ from the file and were kept
	// as they are (Sync without Overwrite).
	Differs int
}

// Difference names one existing thing that differs from the file.
type Difference struct {
	Kind, ID string
}

// Counts is the outcome of Sync, by kind.
type Counts struct {
	Tenant, Levels, Units, Moves, ItemKinds, Items, Scorecards, Versions, Templates, Users Count
	// Differing lists, in load order, what differs from the file. Without
	// Overwrite these were kept; with it they are counted as Updated and not
	// listed.
	Differing []Difference
}

// SyncOptions controls Sync.
type SyncOptions struct {
	// DryRun only reads: nothing is written, and the counts are what a real
	// run would produce.
	DryRun bool
	// Overwrite updates existing things that differ from the file. Without
	// it they are kept untouched and reported in Counts.Differing.
	Overwrite bool
}

// Kind is one line of Counts.
type Kind struct {
	Name  string
	Count Count
}

// Kinds lists the counts in the order Sync writes them.
func (c Counts) Kinds() []Kind {
	return []Kind{
		{"tenant", c.Tenant}, {"levels", c.Levels}, {"units", c.Units}, {"moves", c.Moves},
		{"item kinds", c.ItemKinds}, {"items", c.Items}, {"scorecards", c.Scorecards},
		{"versions", c.Versions}, {"templates", c.Templates}, {"users", c.Users},
	}
}

// Sync loads f into st, and is safe to run again. Unlike Apply it accepts a
// tenant that already exists:
//
//   - A thing the store lacks is created; one that is identical is left alone.
//   - One that differs from the file is kept untouched and reported in
//     Counts.Differing, so a re-run never wipes edits made in the app. With
//     Overwrite it is replaced by the file's content instead (counted as
//     Updated).
//   - Nothing the file does not name is ever deleted.
//   - Methodology versions are written with the store's optimistic revision: a
//     new one is created at revision 1, an overwritten one is saved against
//     the revision found, so a version changed by someone else meanwhile is a
//     conflict error rather than a lost update. A published version keeps its
//     original publishedAt when the file has none.
//   - The tenant record itself cannot be changed (the store has no update for
//     it), with or without Overwrite. A stored tenant that differs from the
//     file's is an error, reported before anything is written.
//
// now stamps what the file leaves unstamped. It stops at the first store
// error; running again completes the load.
func Sync(ctx context.Context, st store.Store, f File, now time.Time, opts SyncOptions) (Counts, error) {
	dryRun := opts.DryRun
	var c Counts
	tid := f.Tenant.ID
	now = now.UTC()

	t := f.Tenant
	cur, err := st.GetTenant(ctx, tid)
	switch {
	case err == nil:
		if diffs := tenantDiffs(cur, t); len(diffs) > 0 {
			return c, fmt.Errorf("bootstrap: tenant %q already exists and differs from the file in %s; bootstrap cannot change an existing tenant", tid, strings.Join(diffs, ", "))
		}
		c.Tenant.Unchanged++
	case errors.Is(err, store.ErrNotFound):
		if t.CreatedAt.IsZero() {
			t.CreatedAt = now
		}
		if !dryRun {
			if err := st.CreateTenant(ctx, t); err != nil {
				return c, fmt.Errorf("bootstrap: create tenant: %w", err)
			}
		}
		c.Tenant.Created++
	default:
		return c, fmt.Errorf("bootstrap: look up tenant: %w", err)
	}

	// Levels are replaced as a set by the store, so the set to write holds the
	// stored level wherever the file's is not to be applied, and the stored
	// levels the file does not name.
	curLevels, err := st.ListLevels(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: levels: %w", err)
	}
	var levelSet []domain.Level
	levelChanged := false
	for _, l := range f.Levels {
		cur := find(curLevels, func(x domain.Level) bool { return x.ID == l.ID })
		write := decide(&c, &c.Levels, "level", l.ID, l, cur, opts)
		levelChanged = levelChanged || write
		if cur != nil && !write {
			levelSet = append(levelSet, *cur)
		} else {
			levelSet = append(levelSet, l)
		}
	}
	for _, l := range curLevels {
		if !hasLevel(f.Levels, l.ID) {
			levelSet = append(levelSet, l)
		}
	}
	if levelChanged && !dryRun {
		if err := st.PutLevels(ctx, tid, levelSet); err != nil {
			return c, fmt.Errorf("bootstrap: levels: %w", err)
		}
	}

	curUnits, err := st.ListOrgUnits(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: org units: %w", err)
	}
	for _, u := range f.Units {
		if decide(&c, &c.Units, "unit", u.ID, u, find(curUnits, func(x domain.OrgUnit) bool { return x.ID == u.ID }), opts) && !dryRun {
			if err := st.PutOrgUnit(ctx, tid, u); err != nil {
				return c, fmt.Errorf("bootstrap: org unit %s: %w", u.ID, err)
			}
		}
	}

	curMoves, err := st.ListOrgMoves(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: org moves: %w", err)
	}
	for _, m := range f.Moves {
		match := func(x domain.OrgMove) bool {
			return x.UnitID == m.UnitID && x.EffectiveMonth == m.EffectiveMonth
		}
		if decide(&c, &c.Moves, "move", m.UnitID+"@"+fmt.Sprint(m.EffectiveMonth), m, find(curMoves, match), opts) && !dryRun {
			if err := st.PutOrgMove(ctx, tid, m); err != nil {
				return c, fmt.Errorf("bootstrap: org move of %s: %w", m.UnitID, err)
			}
		}
	}

	curKinds, err := st.ListItemKinds(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: item kinds: %w", err)
	}
	for _, k := range f.ItemKinds {
		if decide(&c, &c.ItemKinds, "item kind", k.ID, k, find(curKinds, func(x domain.ItemKind) bool { return x.ID == k.ID }), opts) && !dryRun {
			if err := st.PutItemKind(ctx, tid, k); err != nil {
				return c, fmt.Errorf("bootstrap: item kind %s: %w", k.ID, err)
			}
		}
	}

	curItems, err := st.ListTrackedItems(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: tracked items: %w", err)
	}
	for _, it := range f.Items {
		if decide(&c, &c.Items, "item", it.ID, it, find(curItems, func(x domain.TrackedItem) bool { return x.ID == it.ID }), opts) && !dryRun {
			if err := st.PutTrackedItem(ctx, tid, it); err != nil {
				return c, fmt.Errorf("bootstrap: tracked item %s: %w", it.ID, err)
			}
		}
	}

	curScorecards, err := st.ListScorecards(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: scorecards: %w", err)
	}
	for _, sc := range f.Scorecards {
		if decide(&c, &c.Scorecards, "scorecard", sc.ID, sc, find(curScorecards, func(x domain.Scorecard) bool { return x.ID == sc.ID }), opts) && !dryRun {
			if err := st.PutScorecard(ctx, tid, sc); err != nil {
				return c, fmt.Errorf("bootstrap: scorecard %s: %w", sc.ID, err)
			}
		}
	}

	curVersions := map[string][]domain.MethodologyVersion{}
	for _, sc := range f.Scorecards {
		vs, err := st.ListVersions(ctx, tid, sc.ID)
		if err != nil {
			return c, fmt.Errorf("bootstrap: versions of %s: %w", sc.ID, err)
		}
		curVersions[sc.ID] = vs
	}
	for _, v := range f.Versions {
		cur := find(curVersions[v.ScorecardID], func(x domain.MethodologyVersion) bool { return x.ID == v.ID })
		expected := store.MustNotExist
		if cur != nil {
			// Compare against the stored revision, and keep its publish time
			// when the file names none.
			expected = cur.Revision
			v.Revision = cur.Revision
			if v.PublishedAt == nil {
				v.PublishedAt = cur.PublishedAt
			}
		}
		if v.PublishedAt == nil && (v.Status == domain.VersionPublished || v.Status == domain.VersionSuperseded) {
			at := now
			v.PublishedAt = &at
		}
		if decide(&c, &c.Versions, "version", v.ScorecardID+"/"+v.ID, v, cur, opts) && !dryRun {
			if err := st.PutVersion(ctx, tid, v, expected); err != nil {
				return c, fmt.Errorf("bootstrap: version %s: %w", v.ID, err)
			}
		}
	}

	curTemplates, err := st.ListTemplates(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: templates: %w", err)
	}
	for _, tpl := range f.Templates {
		if tpl.Name == "" {
			tpl.Name = tpl.ID
		}
		cur := find(curTemplates, func(x store.Template) bool { return x.ID == tpl.ID })
		if cur != nil {
			tpl.Revision, tpl.LastUsed = cur.Revision, cur.LastUsed
		}
		if decide(&c, &c.Templates, "template", tpl.ID, tpl, cur, opts) && !dryRun {
			if err := st.PutTemplate(ctx, tid, tpl); err != nil {
				return c, fmt.Errorf("bootstrap: template %s: %w", tpl.ID, err)
			}
		}
	}

	curMembers, err := st.ListMemberships(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: members: %w", err)
	}
	for _, u := range f.Users {
		m := domain.Membership{UserID: u.UserID, Email: u.Email, Name: u.Name, Role: u.Role, Scope: u.Scope, CreatedAt: now}
		cur := find(curMembers, func(x domain.Membership) bool { return x.UserID == u.UserID })
		if cur != nil {
			m.CreatedAt = cur.CreatedAt
		}
		if decide(&c, &c.Users, "member", u.UserID, m, cur, opts) && !dryRun {
			if err := st.PutMembership(ctx, tid, m); err != nil {
				return c, fmt.Errorf("bootstrap: member %s: %w", u.UserID, err)
			}
		}
	}
	return c, nil
}

// decide tallies one thing against what the store holds (cur, nil when
// absent) into n and reports whether it must be written. A thing that
// differs is written only with opts.Overwrite; otherwise it is recorded in
// c.Differing and kept.
func decide[T any](c *Counts, n *Count, kind, id string, want T, cur *T, opts SyncOptions) bool {
	switch {
	case cur == nil:
		n.Created++
	case same(want, *cur):
		n.Unchanged++
		return false
	case opts.Overwrite:
		n.Updated++
	default:
		n.Differs++
		c.Differing = append(c.Differing, Difference{Kind: kind, ID: id})
		return false
	}
	return true
}

func find[T any](xs []T, match func(T) bool) *T {
	for i := range xs {
		if match(xs[i]) {
			return &xs[i]
		}
	}
	return nil
}

func hasLevel(ls []domain.Level, id string) bool {
	return find(ls, func(l domain.Level) bool { return l.ID == id }) != nil
}

// same reports whether two values have the same JSON content, treating a nil
// slice, an empty slice and a missing field alike (a store may return any).
func same[T any](a, b T) bool { return canon(a) == canon(b) }

func canon(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%#v", v)
	}
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		return string(raw)
	}
	out, _ := json.Marshal(prune(tree))
	return string(out)
}

// prune drops nulls and empty arrays and objects from a decoded JSON tree.
func prune(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			e = prune(e)
			if e == nil {
				delete(x, k)
			} else {
				x[k] = e
			}
		}
		if len(x) == 0 {
			return nil
		}
		return x
	case []any:
		if len(x) == 0 {
			return nil
		}
		for i := range x {
			x[i] = prune(x[i])
		}
		return x
	}
	return v
}

// tenantDiffs names the settings in which a stored tenant differs from the
// file's. CreatedAt is not compared: the file usually leaves it unset.
func tenantDiffs(cur, want domain.Tenant) []string {
	var d []string
	if cur.Name != want.Name {
		d = append(d, "name")
	}
	if cur.Auth0OrgID != want.Auth0OrgID {
		d = append(d, "auth0OrgId")
	}
	if cur.FiscalYearStartMonth != want.FiscalYearStartMonth {
		d = append(d, "fiscalYearStartMonth")
	}
	if cur.DefaultRole != want.DefaultRole {
		d = append(d, "defaultRole")
	}
	if !same(cur.StatusScale, want.StatusScale) {
		d = append(d, "statusScale")
	}
	return d
}
