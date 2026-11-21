package assistant

import (
	"slices"
	"testing"
)

func TestRewriteAnswerLinks(t *testing.T) {
	hosts := []string{"tracker.example", "Docs.Example"}
	for _, c := range []struct{ name, in, want string }{
		{"kept", "See [INC-2041](https://tracker.example/browse/INC-2041).", "See [INC-2041](https://tracker.example/browse/INC-2041)."},
		{"host case", "[pm](https://DOCS.example/pm/2041)", "[pm](https://DOCS.example/pm/2041)"},
		{"other host", "Read [the fix](https://evil.example/steal?x=1) now.", "Read the fix (evil.example) now."},
		{"subdomain is another host", "[x](https://a.tracker.example/y)", "x (a.tracker.example)"},
		{"http", "[x](http://tracker.example/y)", "[x](http://tracker.example/y)"},
		{"title attribute", `[x](https://evil.example/y "click")`, "x (evil.example)"},
		{"angle destination", "[x](<https://evil.example/a b>)", "x (evil.example)"},
		{"image", "![pixel](https://evil.example/p.png)", "pixel (evil.example)"},
		{"autolink", "Go to <https://evil.example/a>.", "Go to evil.example."},
		{"kept autolink", "<https://tracker.example/a>", "<https://tracker.example/a>"},
		{"javascript", "[x](javascript:alert(1))", "x"},
		{"relative", "[x](/scorecards/a)", "[x](/scorecards/a)"},
		{"protocol relative", "[x](//evil.example/a)", "x (evil.example)"},
		{"reference", "See [x][1].\n\n[1]: https://evil.example/a", "See [x][1].\n\n1: evil.example"},
		{"kept reference", "[1]: https://tracker.example/a", "[1]: https://tracker.example/a"},
		{"user info", "[x](https://tracker.example@evil.example/a)", "x (evil.example)"},
		{"two", "[a](https://evil.example/1) and [b](https://tracker.example/2)", "a (evil.example) and [b](https://tracker.example/2)"},
		{"no links", "Uptime was 99.06% (Red) in 2026-M10.", "Uptime was 99.06% (Red) in 2026-M10."},
		{"code is left alone", "`[x](https://evil.example)`", "`[x](https://evil.example)`"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := RewriteAnswerLinks(c.in, hosts); got != c.want {
				t.Errorf("RewriteAnswerLinks(%q)\n got %q\nwant %q", c.in, got, c.want)
			}
		})
	}
}

// Only URL fields count: a title or text that holds a URL names no host.
func TestURLHosts(t *testing.T) {
	text := `{"links":[{"title":"INC-2041","url":"https://tracker.example/browse/INC-2041"}],` +
		`"incidents":[{"title":"open https://evil.example/x","url":"https://Docs.Example/pm"}],` +
		`"text":"see https://evil.example/y","evidence":[{"key":"CHK-113","url":"http://plain.example/x"}],` +
		`"bad":{"url":"https://"},"homepageUrl":"https://home.example/","count":3}`
	got := URLHosts(text)
	slices.Sort(got)
	if want := []string{"docs.example", "home.example", "plain.example", "tracker.example"}; !slices.Equal(got, want) {
		t.Fatalf("URLHosts = %v, want %v", got, want)
	}
	if got := URLHosts("Not JSON: https://evil.example/a"); len(got) != 0 {
		t.Fatalf("plain text: %v", got)
	}
	if got := URLHosts(`[{"url":"javascript:alert(1)"}]`); len(got) != 0 {
		t.Fatalf("javascript url: %v", got)
	}
}
