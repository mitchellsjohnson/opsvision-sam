package domain

import (
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"opsvision/internal/period"
)

// Exec summary limits. MaxRCAEvidence bounds the basis's evidence keys, which
// are stored with the summary and in its audit entries.
const (
	MaxRCATextRunes   = 280
	MaxRCALinks       = 25
	MaxRCATitleRunes  = 80
	MaxRCAURLBytes    = 2048
	MaxRCALinkBytes   = 16384
	MaxRCAEvidence    = 200
	rcaHTTPSScheme    = "https"
	rcaHTTPSPrefixLen = len("https://")
)

// Exec summary channels for CellRCA.Channel.
const (
	RCAChannelWeb = "web"
	RCAChannelAPI = "api"
	RCAChannelMCP = "mcp"
)

// RCALink is one link on an exec summary: plain-text title and an https URL.
type RCALink struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// RCABasis is what a summary was written against, to tell when it goes
// stale: the company standing's displayed value and status, the evidence
// ("subject:{id}" of the reporting subjects with a gap, sorted, then the
// sorted "source:externalId" of the incidents counted; at most
// MaxRCAEvidence), and the reported downtime in whole minutes.
type RCABasis struct {
	Display         string   `json:"display"`
	Status          string   `json:"status"`
	Evidence        []string `json:"evidence"`
	ReportedMinutes *int     `json:"reportedMinutes,omitempty"`
}

// CellRCA is the stored shape of an exec summary: one metric's write-up for
// one period, kept on the company root unit (SubjectID).
type CellRCA struct {
	ScorecardID string        `json:"scorecardId"`
	MetricKey   string        `json:"metricKey"`
	SubjectID   string        `json:"subjectId"`
	Period      period.Period `json:"period"`
	Text        string        `json:"text"`
	Links       []RCALink     `json:"links"`
	AuthorID    string        `json:"authorId"`
	AuthorName  string        `json:"authorName"`
	Channel     string        `json:"channel"`
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
	Revision    int           `json:"revision"`
	Basis       RCABasis      `json:"basis"`
}

// RCAChannel maps a principal's channel to a summary's: a browser session ("")
// is web, an access token is api, and MCP is mcp.
func RCAChannel(principalChannel string) string {
	switch principalChannel {
	case "":
		return RCAChannelWeb
	case "mcp":
		return RCAChannelMCP
	}
	return RCAChannelAPI
}

// NormalizeRCAText trims s and collapses every run of whitespace, newlines
// included, to one space. It does not normalize Unicode: the server counts
// runes as received, and the web sends NFC.
func NormalizeRCAText(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// Normalize returns a copy of r as it is stored: the text normalized, link
// titles trimmed, and link schemes lowercased (HTTPS:// is stored https://).
func (r CellRCA) Normalize() CellRCA {
	r.Text = NormalizeRCAText(r.Text)
	if r.Links != nil {
		links := make([]RCALink, len(r.Links))
		for i, l := range r.Links {
			links[i] = RCALink{Title: strings.TrimSpace(l.Title), URL: lowerScheme(l.URL)}
		}
		r.Links = links
	}
	return r
}

// lowerScheme lowercases an https scheme written in any case.
func lowerScheme(u string) string {
	if len(u) >= rcaHTTPSPrefixLen && strings.EqualFold(u[:rcaHTTPSPrefixLen], rcaHTTPSScheme+"://") {
		return rcaHTTPSScheme + "://" + u[rcaHTTPSPrefixLen:]
	}
	return u
}

// Validate returns every problem with the summary's text and links, with the
// message shown under the field, or nil. Paths are text, links,
// links[0].title and links[0].url. It judges the summary as Normalize stores
// it.
func (r CellRCA) Validate() []ValidationError {
	v := &validator{}
	text := NormalizeRCAText(r.Text)
	switch {
	case text == "":
		v.add("text", "Write what drove this metric this month")
	case utf8.RuneCountInString(text) > MaxRCATextRunes:
		v.add("text", "Write up to 280 characters")
	case strings.ContainsFunc(text, isControl):
		v.add("text", "Use plain text without control characters")
	}

	if len(r.Links) > MaxRCALinks {
		v.add("links", "Up to 25 links")
	}
	total := 0
	seen := map[string]bool{}
	for i, l := range r.Links {
		path := fmt.Sprintf("links[%d]", i)
		title := strings.TrimSpace(l.Title)
		total += len(title) + len(l.URL)
		switch {
		case title == "":
			v.add(path+".title", "Add a title for this link")
		case utf8.RuneCountInString(title) > MaxRCATitleRunes:
			v.add(path+".title", "Write up to 80 characters")
		case strings.ContainsFunc(title, isControl):
			v.add(path+".title", "Use plain text without control characters")
		}
		switch u := lowerScheme(l.URL); {
		case len(l.URL) > MaxRCAURLBytes:
			v.add(path+".url", "This link is too long; use one up to 2,048 characters")
		case !validHTTPS(u):
			v.add(path+".url", "Use a link that starts with https://")
		case seen[u]:
			v.add(path+".url", "This link is already listed")
		default:
			seen[u] = true
		}
	}
	if total > MaxRCALinkBytes {
		v.add("links", "These links are too long together; shorten or remove some")
	}
	if len(v.errs) == 0 {
		return nil
	}
	return v.errs
}

// isControl reports control characters and the bidirectional formatting
// characters, which can make text or a link read differently from what it
// is. Other format characters, such as the joiner in emoji sequences, are
// text.
func isControl(r rune) bool {
	switch {
	case unicode.IsControl(r),
		r == '\u061C', r == '\u200E', r == '\u200F',
		r >= '\u202A' && r <= '\u202E',
		r >= '\u2066' && r <= '\u2069':
		return true
	}
	return false
}

// validHTTPS reports whether u (scheme already lowercased) is an absolute
// https URL with a host, no user info, and no whitespace or control
// characters.
func validHTTPS(u string) bool {
	if !strings.HasPrefix(u, rcaHTTPSScheme+"://") {
		return false
	}
	if strings.ContainsFunc(u, func(r rune) bool { return unicode.IsSpace(r) || isControl(r) }) {
		return false
	}
	p, err := url.Parse(u)
	if err != nil || p.Scheme != rcaHTTPSScheme || p.Host == "" || p.User != nil || p.Hostname() == "" {
		return false
	}
	return true
}
