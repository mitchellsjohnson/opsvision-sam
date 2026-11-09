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
}

// Counts is the outcome of Sync, by kind.
type Counts struct {
	Tenant, Levels, Units, Moves, ItemKinds, Items, Scorecards, Versions, Templates, Users Count
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

// Sync makes st hold f, and is safe to run again. Unlike Apply it accepts a
// tenant that already exists:
//
//   - A thing the store lacks is created; one that is identical is left alone;
//     one that differs is overwritten with the file's content. Nothing the
//     file does not name is deleted.
//   - Methodology versions are written with the store's optimistic revision: a
//     new one is created at revision 1, a changed one is saved against the
//     revision found, so a version changed by someone else meanwhile is a
//     conflict error rather than a lost update. A published version keeps its
//     original publishedAt when the file has none.
//   - The tenant record itself cannot be changed (the store has no update for
//     it). A stored tenant that differs from the file's is an error, reported
//     before anything is written.
//
// With dryRun, Sync only reads and returns the counts a real run would. now
// stamps what the file leaves unstamped. It stops at the first store error;
// running again completes the load.
func Sync(ctx context.Context, st store.Store, f File, now time.Time, dryRun bool) (Counts, error) {
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

	// Levels are replaced as a set; keep stored levels the file does not name.
	curLevels, err := st.ListLevels(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: levels: %w", err)
	}
	merged := append([]domain.Level(nil), f.Levels...)
	for _, l := range curLevels {
		if !hasLevel(f.Levels, l.ID) {
			merged = append(merged, l)
		}
	}
	changed := 0
	for _, l := range f.Levels {
		if kind(&c.Levels, l, find(curLevels, func(x domain.Level) bool { return x.ID == l.ID }), same) {
			changed++
		}
	}
	if changed > 0 && !dryRun {
		if err := st.PutLevels(ctx, tid, merged); err != nil {
			return c, fmt.Errorf("bootstrap: levels: %w", err)
		}
	}

	curUnits, err := st.ListOrgUnits(ctx, tid)
	if err != nil {
		return c, fmt.Errorf("bootstrap: org units: %w", err)
	}
	for _, u := range f.Units {
		if kind(&c.Units, u, find(curUnits, func(x domain.OrgUnit) bool { return x.ID == u.ID }), same) && !dryRun {
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
		if kind(&c.Moves, m, find(curMoves, match), same) && !dryRun {
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
		if kind(&c.ItemKinds, k, find(curKinds, func(x domain.ItemKind) bool { return x.ID == k.ID }), same) && !dryRun {
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
		if kind(&c.Items, it, find(curItems, func(x domain.TrackedItem) bool { return x.ID == it.ID }), same) && !dryRun {
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
		if kind(&c.Scorecards, sc, find(curScorecards, func(x domain.Scorecard) bool { return x.ID == sc.ID }), same) && !dryRun {
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
		if kind(&c.Versions, v, cur, same) && !dryRun {
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
		if kind(&c.Templates, tpl, cur, same) && !dryRun {
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
		if kind(&c.Users, m, cur, same) && !dryRun {
			if err := st.PutMembership(ctx, tid, m); err != nil {
				return c, fmt.Errorf("bootstrap: member %s: %w", u.UserID, err)
			}
		}
	}
	return c, nil
}

// kind tallies one thing against what the store holds (cur, nil when absent)
// and reports whether it must be written.
func kind[T any](c *Count, want T, cur *T, eq func(a, b T) bool) bool {
	switch {
	case cur == nil:
		c.Created++
	case eq(want, *cur):
		c.Unchanged++
		return false
	default:
		c.Updated++
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
