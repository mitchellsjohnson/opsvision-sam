package assistant

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
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
	return b.String()
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
