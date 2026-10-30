package httpapi

import (
	"context"
	"strconv"
	"strings"

	"opsvision/internal/domain"
)

// Source keys are the names an org unit or tracked item goes by in source
// systems; imports match rows to subjects by them, so a key must identify at
// most one subject in a tenant. Keys compare case-insensitively after
// trimming.

// keyOwners maps a normalized source key to a description of its owner, such
// as "org unit seg-a".
type keyOwners map[string]string

func normKey(k string) string { return strings.ToLower(strings.TrimSpace(k)) }

// sourceKeyOwners indexes the source keys of every org unit and tracked item
// in the tenant, except the org unit exceptUnit and the item exceptItem (the
// entity being updated may keep its own keys). Unit and item IDs live in
// separate namespaces, so each exception names its own kind.
func (s *Server) sourceKeyOwners(ctx context.Context, tenantID string, units []domain.OrgUnit, exceptUnit, exceptItem string) (keyOwners, error) {
	items, err := s.store.ListTrackedItems(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	owners := keyOwners{}
	for _, u := range units {
		if u.ID == exceptUnit {
			continue
		}
		for _, k := range u.SourceKeys {
			owners[normKey(k)] = "org unit " + u.ID
		}
	}
	for _, it := range items {
		if it.ID == exceptItem {
			continue
		}
		for _, k := range it.SourceKeys {
			owners[normKey(k)] = "item " + it.ID
		}
	}
	return owners, nil
}

// checkKeyConflicts records a problem at path[i] for every key that another
// subject owns, and for every key repeated within keys. Blank keys are
// reported elsewhere (trimKeys) and skipped here.
func checkKeyConflicts(pr *problems, path string, keys []string, owners keyOwners) {
	first := map[string]int{}
	for i, k := range keys {
		n := normKey(k)
		if n == "" {
			continue
		}
		at := path + "[" + strconv.Itoa(i) + "]"
		if owner, taken := owners[n]; taken {
			pr.add(at, "source key %q is already used by %s", strings.TrimSpace(k), owner)
		} else if j, dup := first[n]; dup {
			pr.add(at, "source key %q repeats %s[%d]", strings.TrimSpace(k), path, j)
		}
		if _, seen := first[n]; !seen {
			first[n] = i
		}
	}
}
