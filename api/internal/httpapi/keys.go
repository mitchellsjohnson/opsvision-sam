package httpapi

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"opsvision/internal/domain"
)

// Source keys are the names an org unit or tracked item goes by in source
// systems; imports match rows to subjects by them, so a key must identify at
// most one subject in a tenant. Keys compare case-insensitively after
// trimming.

func normKey(k string) string { return strings.ToLower(strings.TrimSpace(k)) }

// checkKeyConflicts records a problem at path[i] for every key repeated
// within keys. Blank keys are reported elsewhere (trimKeys) and skipped here.
func checkKeyConflicts(pr *problems, path string, keys []string) {
	first := map[string]int{}
	for i, k := range keys {
		n := normKey(k)
		if n == "" {
			continue
		}
		if j, dup := first[n]; dup {
			pr.add(path+"["+strconv.Itoa(i)+"]", "source key %q repeats %s[%d]", strings.TrimSpace(k), path, j)
			continue
		}
		first[n] = i
	}
}

// sourceKeyConflict returns a 409 naming the subject that already holds any
// of keys, with a detail at path[i] per held key, or nil. The org unit
// exceptUnit and the item exceptItem are left out: the subject being saved
// may keep its own keys. Unit and item IDs live in separate namespaces, so
// each exception names its own kind.
func sourceKeyConflict(path string, keys []string, units []domain.OrgUnit, items []domain.TrackedItem, exceptUnit, exceptItem string) error {
	us := make([]domain.OrgUnit, 0, len(units))
	for _, u := range units {
		if u.ID != exceptUnit {
			us = append(us, u)
		}
	}
	its := make([]domain.TrackedItem, 0, len(items))
	for _, it := range items {
		if it.ID != exceptItem {
			its = append(its, it)
		}
	}
	var details []detail
	for i, k := range keys {
		id, held := domain.SourceKeyHolder(us, its, k)
		if !held {
			continue
		}
		details = append(details, detail{
			Path:    path + "[" + strconv.Itoa(i) + "]",
			Message: fmt.Sprintf("source key %q already belongs to %s", strings.TrimSpace(k), holderName(us, its, id, k)),
		})
	}
	if len(details) == 0 {
		return nil
	}
	return &apiError{status: http.StatusConflict, code: codeConflict, message: details[0].Message, details: details}
}

// holderName describes the subject id that holds key, for messages: "org unit
// checkout (Checkout)" or "item web (Web)".
func holderName(units []domain.OrgUnit, items []domain.TrackedItem, id, key string) string {
	for _, u := range units {
		if u.ID == id && hasSourceKey(u.SourceKeys, key) {
			return fmt.Sprintf("org unit %s (%s)", u.ID, u.Name)
		}
	}
	for _, it := range items {
		if it.ID == id {
			return fmt.Sprintf("item %s (%s)", it.ID, it.Name)
		}
	}
	return id
}

func hasSourceKey(keys []string, key string) bool {
	k := normKey(key)
	for _, s := range keys {
		if normKey(s) == k {
			return true
		}
	}
	return false
}
