package domain

import (
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
		{"only newlines", "\n\n\n", "Write what caused the gap"},
		{"only spaces and tabs", " \t  ", "Write what caused the gap"},
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
	t.Run("six links", func(t *testing.T) {
		r := validRCA()
		r.Links = nil
		for i := range 6 {
			r.Links = append(r.Links, RCALink{Title: "T", URL: "https://docs.example/" + string(rune('a'+i))})
		}
		if got := messageAt(r.Validate(), "links"); got != "Up to 5 links" {
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
	t.Run("five links over 4 KB together", func(t *testing.T) {
		r := validRCA()
		r.Links = nil
		for i := range 5 {
			r.Links = append(r.Links, RCALink{Title: "T", URL: "https://docs.example/" + string(rune('a'+i)) + strings.Repeat("x", 900)})
		}
		errs := r.Validate()
		if got := messageAt(errs, "links"); got != "These links are too long together; shorten or remove one" {
			t.Fatalf("message %q (%v)", got, errs)
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
