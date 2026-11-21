package domain

import (
	"fmt"
	"strings"
	"testing"
)

func validRCA() CellRCA {
	return CellRCA{
		ScorecardID: "service-fulfillment", MetricKey: "uptime", SubjectID: "webhooks",
		Text:  "INC-2041 and INC-2047 explain most of it; 40m not explained.",
		Links: []RCALink{{Title: "Postmortem", URL: "https://docs.example/pm/2041"}},
	}
}

func messageAt(errs []ValidationError, path string) string {
	for _, e := range errs {
		if e.Path == path {
			return e.Message
		}
	}
	return ""
}

func TestCellRCAValidateAcceptsAValidNote(t *testing.T) {
	if errs := validRCA().Validate(); errs != nil {
		t.Fatalf("valid note rejected: %v", errs)
	}
	r := validRCA()
	r.Links = nil
	if errs := r.Validate(); errs != nil {
		t.Fatalf("a note without links rejected: %v", errs)
	}
}

func TestCellRCAValidateText(t *testing.T) {
	cases := []struct {
		name, text, want string
	}{
		{"only newlines", "\n\n\n", "Write what drove this metric this month"},
		{"only spaces and tabs", " \t  ", "Write what drove this metric this month"},
		{"281 code points", strings.Repeat("é", 281), "Write up to 280 characters"},
		{"control character", "caused by\x00 a bad deploy", "Use plain text without control characters"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := validRCA()
			r.Text = tc.text
			if got := messageAt(r.Validate(), "text"); got != tc.want {
				t.Fatalf("text %q: message %q, want %q", tc.text, got, tc.want)
			}
		})
	}

	r := validRCA()
	r.Text = strings.Repeat("é", 280)
	if errs := r.Validate(); errs != nil {
		t.Fatalf("280 code points rejected: %v", errs)
	}
	// Whitespace runs collapse before counting: 280 letters with newlines between them fit.
	r.Text = strings.Repeat("a\n\n", 139) + "a"
	if errs := r.Validate(); errs != nil {
		t.Fatalf("collapsed text of 279 characters rejected: %v", errs)
	}
	r.Text = `<img src=x onerror="alert(1)">`
	if errs := r.Validate(); errs != nil {
		t.Fatalf("HTML-looking text is plain text and should be accepted: %v", errs)
	}
	// Emoji sequences (with a zero-width joiner) are text; bidi overrides are not.
	r.Text = "Deploy went badly \U0001F9D1\u200D\U0001F4BB"
	if errs := r.Validate(); errs != nil {
		t.Fatalf("emoji with a joiner rejected: %v", errs)
	}
	for _, bidi := range []string{"\u202E", "\u2066", "\u200F", "\u061C"} {
		r := validRCA()
		r.Text = "fixed by " + bidi + "INC-2041"
		if got := messageAt(r.Validate(), "text"); got != "Use plain text without control characters" {
			t.Errorf("text with %U: message %q", []rune(bidi)[0], got)
		}
		r = validRCA()
		r.Links[0].Title = "Post" + bidi + "mortem"
		if got := messageAt(r.Validate(), "links[0].title"); got != "Use plain text without control characters" {
			t.Errorf("title with %U: message %q", []rune(bidi)[0], got)
		}
		r = validRCA()
		r.Links[0].URL = "https://docs.example/" + bidi + "a"
		if got := messageAt(r.Validate(), "links[0].url"); got != "Use a link that starts with https://" {
			t.Errorf("url with %U: message %q", []rune(bidi)[0], got)
		}
	}
}

func TestCellRCAValidateLinks(t *testing.T) {
	const https = "Use a link that starts with https://"
	cases := []struct {
		name, url, want string
	}{
		{"javascript", "javascript:alert(1)", https},
		{"http", "http://docs.example/a", https},
		{"user info", "https://user:secret@docs.example/a", https},
		{"user name only", "https://user@docs.example/a", https},
		{"space", "https://docs.example/a b", https},
		{"leading space", " https://docs.example/a", https},
		{"no host", "https:///path", https},
		{"not a URL", "postmortem", https},
		{"2049 bytes", "https://docs.example/" + strings.Repeat("a", 2049-len("https://docs.example/")), "This link is too long; use one up to 2,048 characters"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := validRCA()
			r.Links = []RCALink{{Title: "Ticket", URL: tc.url}}
			if got := messageAt(r.Validate(), "links[0].url"); got != tc.want {
				t.Fatalf("url %q: message %q, want %q", tc.url, got, tc.want)
			}
		})
	}

	t.Run("2048 bytes is fine", func(t *testing.T) {
		r := validRCA()
		r.Links = []RCALink{{Title: "Ticket", URL: "https://docs.example/" + strings.Repeat("a", 2048-len("https://docs.example/"))}}
		if errs := r.Validate(); errs != nil {
			t.Fatalf("got %v", errs)
		}
	})
	t.Run("title required", func(t *testing.T) {
		r := validRCA()
		r.Links[0].Title = "   "
		if got := messageAt(r.Validate(), "links[0].title"); got != "Add a title for this link" {
			t.Fatalf("message %q", got)
		}
	})
	t.Run("title too long", func(t *testing.T) {
		r := validRCA()
		r.Links[0].Title = strings.Repeat("t", 81)
		if got := messageAt(r.Validate(), "links[0].title"); got != "Write up to 80 characters" {
			t.Fatalf("message %q", got)
		}
	})
	t.Run("HTML title is text", func(t *testing.T) {
		r := validRCA()
		r.Links[0].Title = `<img src=x onerror="alert(1)">`
		if errs := r.Validate(); errs != nil {
			t.Fatalf("got %v", errs)
		}
	})
	t.Run("25 links are fine, 26 are not", func(t *testing.T) {
		if MaxRCALinks != 25 || MaxRCALinkBytes != 16384 {
			t.Fatalf("limits = %d links, %d bytes; want 25 and 16384", MaxRCALinks, MaxRCALinkBytes)
		}
		r := validRCA()
		r.Links = nil
		for i := range 25 {
			r.Links = append(r.Links, RCALink{Title: fmt.Sprintf("INC-%d", 2000+i), URL: fmt.Sprintf("https://tracker.example/browse/INC-%d", 2000+i)})
		}
		if errs := r.Validate(); errs != nil {
			t.Fatalf("25 links rejected: %v", errs)
		}
		r.Links = append(r.Links, RCALink{Title: "One more", URL: "https://tracker.example/browse/INC-3000"})
		if got := messageAt(r.Validate(), "links"); got != "Up to 25 links" {
			t.Fatalf("message %q", got)
		}
	})
	t.Run("duplicate", func(t *testing.T) {
		r := validRCA()
		r.Links = []RCALink{{Title: "A", URL: "https://docs.example/a"}, {Title: "B", URL: "HTTPS://docs.example/a"}}
		errs := r.Validate()
		if got := messageAt(errs, "links[1].url"); got != "This link is already listed" {
			t.Fatalf("message %q (%v)", got, errs)
		}
		if messageAt(errs, "links[0].url") != "" {
			t.Fatalf("the first copy should be fine: %v", errs)
		}
	})
	t.Run("links over 16 KB together", func(t *testing.T) {
		r := validRCA()
		r.Links = nil
		for i := range 25 {
			r.Links = append(r.Links, RCALink{Title: "T", URL: fmt.Sprintf("https://docs.example/%02d/", i) + strings.Repeat("x", 640)})
		}
		errs := r.Validate()
		if got := messageAt(errs, "links"); got != "These links are too long together; shorten or remove some" {
			t.Fatalf("message %q (%v)", got, errs)
		}
		// At exactly 16,384 bytes of titles and URLs they fit.
		r.Links = nil
		for i := range 16 {
			u := fmt.Sprintf("https://docs.example/%02d/", i)
			r.Links = append(r.Links, RCALink{Title: "T", URL: u + strings.Repeat("y", 1024-1-len(u))})
		}
		if errs := r.Validate(); errs != nil {
			t.Fatalf("16,384 bytes rejected: %v", errs)
		}
	})
	t.Run("uppercase scheme accepted and stored lowercase", func(t *testing.T) {
		r := validRCA()
		r.Links = []RCALink{{Title: " Runbook ", URL: "HTTPS://docs.example/a"}}
		if errs := r.Validate(); errs != nil {
			t.Fatalf("got %v", errs)
		}
		n := r.Normalize()
		if n.Links[0].URL != "https://docs.example/a" || n.Links[0].Title != "Runbook" {
			t.Fatalf("normalized link = %+v", n.Links[0])
		}
		if r.Links[0].URL != "HTTPS://docs.example/a" {
			t.Fatal("Normalize changed the receiver's links")
		}
	})
}

func TestCellRCANormalizeText(t *testing.T) {
	r := validRCA()
	r.Text = "  first line\n\n  second\tline  "
	if got := r.Normalize().Text; got != "first line second line" {
		t.Fatalf("Normalize text = %q", got)
	}
	if got := NormalizeRCAText("a\n\n  b"); got != "a b" {
		t.Fatalf("NormalizeRCAText = %q", got)
	}
	// No Unicode normalization: a decomposed é stays two code points.
	if got := NormalizeRCAText("e\u0301"); got != "e\u0301" {
		t.Fatalf("NormalizeRCAText normalized Unicode: %q", got)
	}
}

func TestRCAChannel(t *testing.T) {
	for in, want := range map[string]string{"": "web", "token": "api", "mcp": "mcp"} {
		if got := RCAChannel(in); got != want {
			t.Errorf("RCAChannel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRCAEvidenceLimit(t *testing.T) {
	if MaxRCAEvidence != 200 {
		t.Fatalf("MaxRCAEvidence = %d, want 200", MaxRCAEvidence)
	}
}
