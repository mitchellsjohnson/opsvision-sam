package httpapi

import (
	"fmt"
	"regexp"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// Patterns of client-supplied identifiers; they mirror the Id and Key schemas
// in openapi/openapi.yaml, which the server does not enforce by itself.
var (
	idPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
)

const (
	idRule  = "must be 1-64 characters: letters, digits, '_' or '-'"
	keyRule = "must start with a lowercase letter and contain only lowercase letters, digits, or '_'"
)

// validID reports whether s is a valid client-supplied identifier.
func validID(s string) bool { return idPattern.MatchString(s) }

// validKey reports whether s is a valid metric or measure key.
func validKey(s string) bool { return keyPattern.MatchString(s) }

// validUserID reports whether s is a usable user ID: non-empty and free of
// '#', which the store uses as a key separator.
func validUserID(s string) bool { return s != "" && !strings.Contains(s, "#") }

// problems collects validation failures so one response can report them all.
// The zero value is ready to use.
type problems struct{ list []detail }

func (p *problems) add(path, format string, args ...any) {
	p.list = append(p.list, detail{Path: path, Message: fmt.Sprintf(format, args...)})
}

// err returns nil when nothing was recorded, else a 400 invalid error whose
// details are the recorded problems.
func (p *problems) err() error {
	if len(p.list) == 0 {
		return nil
	}
	return badRequest("request validation failed", p.list...)
}

// id checks a required client-supplied ID.
func (p *problems) id(path, v string) {
	if !validID(v) {
		p.add(path, "%s", idRule)
	}
}

// optionalID checks an ID that may be the empty string.
func (p *problems) optionalID(path, v string) {
	if v != "" && !validID(v) {
		p.add(path, "must be empty or %s", idRule)
	}
}

// key checks a metric or measure key.
func (p *problems) key(path, v string) {
	if !validKey(v) {
		p.add(path, "%s", keyRule)
	}
}

// nonEmpty checks that v has non-blank content.
func (p *problems) nonEmpty(path, v string) {
	if strings.TrimSpace(v) == "" {
		p.add(path, "must not be empty")
	}
}

// role checks a role against the domain's known roles.
func (p *problems) role(path string, r domain.Role) {
	if !r.Valid() {
		p.add(path, "must be one of admin, contributor, viewer")
	}
}

// month parses a Month-grain period such as 2026-M07. On failure it records a
// problem and returns false.
func (p *problems) month(path, v string) (period.Period, bool) {
	m, err := period.Parse(v)
	if err != nil || m.Grain != period.Month {
		p.add(path, "must be a month such as 2026-M07")
		return period.Period{}, false
	}
	return m, true
}
