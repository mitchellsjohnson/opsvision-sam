package domain

import "strings"

// SourceKeyHolder returns the ID of the org unit or tracked item whose source
// keys include key, compared case-insensitively after trimming, and false
// when none does or key is blank. Units are searched before items, each in
// the order given. Source keys are unique per tenant, so callers use it to
// refuse a key another subject already holds.
func SourceKeyHolder(units []OrgUnit, items []TrackedItem, key string) (id string, ok bool) {
	k := strings.ToLower(strings.TrimSpace(key))
	if k == "" {
		return "", false
	}
	has := func(keys []string) bool {
		for _, s := range keys {
			if strings.ToLower(strings.TrimSpace(s)) == k {
				return true
			}
		}
		return false
	}
	for _, u := range units {
		if has(u.SourceKeys) {
			return u.ID, true
		}
	}
	for _, it := range items {
		if has(it.SourceKeys) {
			return it.ID, true
		}
	}
	return "", false
}
