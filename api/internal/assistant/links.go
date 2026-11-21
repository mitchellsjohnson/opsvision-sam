package assistant

import (
	"encoding/json"
	"html"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

var (
	// codeSpan matches fenced code blocks and inline code, which Markdown
	// renders as text.
	codeSpan = regexp.MustCompile("(?s)```.*?```|`[^`\n]*`")
	// inlineLink matches [title](destination "optional title") and the
	// image form; the destination may be in angle brackets.
	inlineLink = regexp.MustCompile(`(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)`)
	// autoLink matches <scheme:...>.
	autoLink = regexp.MustCompile(`<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\s]*)>`)
	// refDefinition matches a reference link definition line: [label]: url.
	refDefinition = regexp.MustCompile(`(?m)^( {0,3})\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+).*$`)

	// hostRef is where text names a host: an http or https scheme and any
	// slashes or backslashes after it (browsers read https:evil.example and
	// https:\\evil.example as https://evil.example), or two of them.
	hostRef = regexp.MustCompile(`(?i)\bhttps?:[/\\]*|[/\\]{2}`)
	// linkScheme is a scheme other than http(s) that Markdown renderers
	// still link.
	linkScheme = regexp.MustCompile(`(?i)\b(?:mailto|xmpp|ircs?):`)
	// backslashEscape is a CommonMark backslash escape.
	backslashEscape = regexp.MustCompile("\\\\([!-/:-@\\[-`{-~])")
)

// URLHosts lists the distinct hosts (lowercase, without port) of the http
// and https URLs in the URL fields of a tool result's JSON: string values
// under a key "url" or "href", or one ending in "Url" or "URL". A URL inside
// other text (a title an import wrote) names no host, and text that is not
// JSON names none.
func URLHosts(text string) []string {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	var walk func(key string, v any)
	walk = func(key string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				walk(k, c)
			}
		case []any:
			for _, c := range x {
				walk(key, c)
			}
		case string:
			if !urlKey(key) {
				return
			}
			u, err := url.Parse(strings.TrimSpace(x))
			if err != nil {
				return
			}
			if s := strings.ToLower(u.Scheme); s != "http" && s != "https" {
				return
			}
			if h := strings.ToLower(u.Hostname()); h != "" && !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	walk("", v)
	return out
}

func urlKey(k string) bool {
	return k == "url" || k == "href" || strings.HasSuffix(k, "Url") || strings.HasSuffix(k, "URL")
}

// RewriteAnswerLinks turns every Markdown link, image and autolink in an
// answer whose destination's host is not one of hosts into plain text:
// "title (host)". Links that name no host (paths in the app) stay; links
// with another scheme (javascript:, data:) keep only their title. Code is
// left as it is: Markdown shows it as text.
//
// A regular expression cannot match all of CommonMark, so when the result,
// read with entities decoded and backslash escapes removed, still names a
// host not in hosts (or a mailto:, xmpp: or irc: address), no link may
// render in it at all: see neutralizeLinks. The web checks every link's
// host again where the real parser runs.
func RewriteAnswerLinks(answer string, hosts []string) string {
	allowed := make(map[string]bool, len(hosts))
	for _, h := range hosts {
		allowed[strings.ToLower(h)] = true
	}
	var b strings.Builder
	last := 0
	for _, loc := range codeSpan.FindAllStringIndex(answer, -1) {
		b.WriteString(rewriteLinks(answer[last:loc[0]], allowed))
		b.WriteString(answer[loc[0]:loc[1]])
		last = loc[1]
	}
	b.WriteString(rewriteLinks(answer[last:], allowed))
	out := b.String()
	if namesOtherHost(out, allowed) {
		return neutralizeLinks(out)
	}
	return out
}

// namesOtherHost reports whether s names a host not in allowed, as it is,
// with backslash escapes removed and entities decoded (in either order), or
// a link scheme other than http(s). Tabs, which browsers drop from URLs,
// are dropped first. Code counts too: the regex's idea of code can be wrong.
func namesOtherHost(s string, allowed map[string]bool) bool {
	unescape := func(s string) string { return backslashEscape.ReplaceAllString(s, "$1") }
	for _, v := range []string{s, html.UnescapeString(unescape(s)), unescape(html.UnescapeString(s))} {
		v = strings.ReplaceAll(v, "\t", "")
		if linkScheme.MatchString(v) {
			return true
		}
		for _, loc := range hostRef.FindAllStringIndex(v, -1) {
			if h := refHost(v[loc[1]:]); h != "" && !allowed[h] {
				return true
			}
		}
	}
	return false
}

// refHost is the host at the start of s, the text after a scheme or "//":
// lowercase, without user info, port or trailing punctuation; "" when s
// starts with no host.
func refHost(s string) string {
	end := strings.IndexFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune("/\\?#()<>\"'`", r)
	})
	if end >= 0 {
		s = s[:end]
	}
	if i := strings.LastIndexByte(s, '@'); i >= 0 {
		s = s[i+1:]
	}
	if strings.HasPrefix(s, "[") {
		if i := strings.IndexByte(s, ']'); i > 0 {
			return strings.ToLower(s[1:i])
		}
		return strings.ToLower(s)
	}
	if i := strings.IndexAny(s, "[]"); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndexByte(s, ':'); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(strings.TrimRight(s, ".,;:!*_~"))
}

// neutralizeLinks escapes every [, ], < outside code, so no link, image,
// autolink or raw HTML can form; the text reads the same. Only a fence that
// opens at the start of a line is trusted as code, since no container can
// hold one there. Inline code spans are kept in a paragraph whose backtick
// runs all pair within their own line, where CommonMark pairs them the same
// way; in any other paragraph a span could end on another line than a guess
// says, so its backticks are escaped too and it shows as plain text.
func neutralizeLinks(s string) string {
	var b strings.Builder
	var para []string
	flush := func() {
		escapeParagraph(&b, para)
		para = para[:0]
	}
	fence := ""
	for _, ln := range strings.SplitAfter(s, "\n") {
		body := strings.TrimRight(ln, "\r\n")
		switch {
		case fence != "":
			if closesFence(body, fence) {
				fence = ""
			}
			b.WriteString(ln)
		case opensFence(body) != "":
			flush()
			fence = opensFence(body)
			b.WriteString(ln)
		case strings.Trim(body, " \t") == "":
			flush()
			b.WriteString(ln)
		default:
			para = append(para, ln)
		}
	}
	flush()
	return b.String()
}

func escapeParagraph(b *strings.Builder, lines []string) {
	keep := true
	for _, ln := range lines {
		if _, ok := codeSpans(ln); !ok {
			keep = false
			break
		}
	}
	for _, ln := range lines {
		var spans [][2]int
		if keep {
			spans, _ = codeSpans(ln)
		}
		escapeLinkSyntax(b, ln, spans)
	}
}

// codeSpans are line's inline code spans (start and end offsets) as
// CommonMark pairs backtick runs; ok is false when a run has no closing run
// of the same length on the line.
func codeSpans(line string) (spans [][2]int, ok bool) {
	run := func(i int) int {
		j := i
		for j < len(line) && line[j] == '`' {
			j++
		}
		return j - i
	}
	for i := 0; i < len(line); {
		switch {
		case line[i] == '\\' && i+1 < len(line) && isASCIIPunct(line[i+1]):
			i += 2
			continue
		case line[i] != '`':
			i++
			continue
		}
		n, closed := run(i), false
		for j := i + n; j < len(line); {
			if line[j] != '`' {
				j++
				continue
			}
			m := run(j)
			if m == n {
				spans = append(spans, [2]int{i, j + m})
				i, closed = j+m, true
				break
			}
			j += m
		}
		if !closed {
			return spans, false
		}
	}
	return spans, true
}

// opensFence is the run of three or more backticks or tildes that opens a
// fenced code block at the very start of line, or "".
func opensFence(line string) string {
	if len(line) < 3 || (line[0] != '`' && line[0] != '~') {
		return ""
	}
	n := len(line) - len(strings.TrimLeft(line, line[:1]))
	if n < 3 || (line[0] == '`' && strings.Contains(line[n:], "`")) {
		return ""
	}
	return line[:n]
}

// closesFence reports whether line closes the fence: up to three spaces,
// at least as many of its character, then only spaces and tabs.
func closesFence(line, fence string) bool {
	rest := strings.TrimLeft(line, " ")
	if len(line)-len(rest) > 3 {
		return false
	}
	body := strings.TrimLeft(rest, fence[:1])
	return len(rest)-len(body) >= len(fence) && strings.Trim(body, " \t") == ""
}

// escapeLinkSyntax writes s with a backslash before each [, ], < and
// backtick that is not already escaped, and the code spans as they are.
func escapeLinkSyntax(b *strings.Builder, s string, spans [][2]int) {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if len(spans) > 0 && i == spans[0][0] {
			b.WriteString(s[i:spans[0][1]])
			i = spans[0][1] - 1
			spans = spans[1:]
			continue
		}
		switch {
		case c == '\\' && i+1 < len(s) && isASCIIPunct(s[i+1]):
			b.WriteByte(c)
			b.WriteByte(s[i+1])
			i++
		case c == '[' || c == ']' || c == '<' || c == '`':
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
}

func isASCIIPunct(c byte) bool {
	return c >= '!' && c <= '/' || c >= ':' && c <= '@' || c >= '[' && c <= '`' || c >= '{' && c <= '~'
}

func rewriteLinks(s string, allowed map[string]bool) string {
	s = inlineLink.ReplaceAllStringFunc(s, func(m string) string {
		g := inlineLink.FindStringSubmatch(m)
		title, dest := g[2], strings.Trim(g[3], "<>")
		if keep, host := linkAllowed(dest, allowed); !keep {
			return plainLink(title, host)
		}
		return m
	})
	s = autoLink.ReplaceAllStringFunc(s, func(m string) string {
		dest := autoLink.FindStringSubmatch(m)[1]
		if keep, host := linkAllowed(dest, allowed); !keep {
			return host
		}
		return m
	})
	return refDefinition.ReplaceAllStringFunc(s, func(m string) string {
		g := refDefinition.FindStringSubmatch(m)
		if keep, host := linkAllowed(strings.Trim(g[3], "<>"), allowed); !keep {
			return strings.TrimRight(g[1]+g[2]+": "+host, " ")
		}
		return m
	})
}

// linkAllowed says whether a link to dest may stay, and the host to name
// when it may not ("" for a link with another scheme).
func linkAllowed(dest string, allowed map[string]bool) (bool, string) {
	u, err := url.Parse(strings.TrimSpace(dest))
	if err != nil {
		return false, ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "" && scheme != "http" && scheme != "https" {
		return false, ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return scheme == "", ""
	}
	return allowed[host], host
}

func plainLink(title, host string) string {
	title = strings.TrimSpace(title)
	switch {
	case host == "":
		return title
	case title == "":
		return host
	}
	return title + " (" + host + ")"
}
