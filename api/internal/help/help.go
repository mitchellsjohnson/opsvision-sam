// Package help holds the methodology help topics SAM reads: short Markdown
// files embedded in the binary, each with front matter
//
//	---
//	id: <the file name without .md>
//	title: <a short title>
//	keywords: <optional words people use for the topic>
//	---
package help

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"slices"
	"sort"
	"strings"
	"unicode"
)

// Topic is one help topic. Body is Markdown.
type Topic struct {
	ID, Title, Body string
	keywords        []string
}

// MaxResults is the most topics Search returns.
const MaxResults = 4

//go:embed topics/*.md
var topicFS embed.FS

var topics = mustLoad()

func mustLoad() []Topic {
	files, err := fs.Glob(topicFS, "topics/*.md")
	if err != nil {
		panic(err)
	}
	out := make([]Topic, 0, len(files))
	for _, f := range files {
		raw, err := fs.ReadFile(topicFS, f)
		if err != nil {
			panic(err)
		}
		t, err := parse(raw)
		if err != nil {
			panic(fmt.Sprintf("help: %s: %v", f, err))
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// parse reads a topic file: front matter between two "---" lines, then the
// body.
func parse(raw []byte) (Topic, error) {
	raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	rest, ok := bytes.CutPrefix(raw, []byte("---\n"))
	if !ok {
		return Topic{}, errors.New("no front matter")
	}
	front, body, ok := bytes.Cut(rest, []byte("\n---\n"))
	if !ok {
		return Topic{}, errors.New("unterminated front matter")
	}
	var t Topic
	for _, line := range strings.Split(string(front), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "id":
			t.ID = v
		case "title":
			t.Title = v
		case "keywords":
			t.keywords = words(v)
		}
	}
	if t.ID == "" || t.Title == "" {
		return Topic{}, errors.New("front matter needs id and title")
	}
	t.Body = strings.TrimSpace(string(body))
	return t, nil
}

// All returns every topic, sorted by ID.
func All() []Topic { return slices.Clone(topics) }

// Get returns the topic with id.
func Get(id string) (Topic, bool) {
	for _, t := range topics {
		if t.ID == id {
			return t, true
		}
	}
	return Topic{}, false
}

// Search returns up to MaxResults topics that match words of query, best
// first: a word in the title, ID or keywords counts more than one in the
// body. Words match when one starts with the other (commitment and
// commitments). Ties go to the lower ID.
func Search(query string) []Topic {
	q := words(query)
	if len(q) == 0 {
		return nil
	}
	type scored struct {
		t     Topic
		score int
	}
	var hits []scored
	for _, t := range topics {
		head := append(append(words(t.Title), words(strings.ReplaceAll(t.ID, "-", " "))...), t.keywords...)
		body := words(t.Body)
		score := 0
		for _, w := range q {
			switch {
			case anyMatch(head, w):
				score += 3
			case anyMatch(body, w):
				score++
			}
		}
		if score > 0 {
			hits = append(hits, scored{t, score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	out := make([]Topic, 0, min(len(hits), MaxResults))
	for _, h := range hits[:min(len(hits), MaxResults)] {
		out = append(out, h.t)
	}
	return out
}

func anyMatch(ws []string, w string) bool {
	for _, x := range ws {
		short, long := x, w
		if len(short) > len(long) {
			short, long = long, short
		}
		if strings.HasPrefix(long, short) && (len(short) >= 4 || short == long) {
			return true
		}
	}
	return false
}

// stopWords carry no topic.
var stopWords = map[string]bool{
	"the": true, "and": true, "for": true, "are": true, "was": true, "did": true, "does": true,
	"what": true, "why": true, "how": true, "when": true, "where": true, "which": true, "who": true,
	"this": true, "that": true, "with": true, "from": true, "into": true, "our": true, "your": true,
	"you": true, "can": true, "mean": true, "means": true, "work": true, "works": true, "get": true,
	"has": true, "have": true, "not": true, "under": true, "new": true, "its": true, "about": true,
}

// words splits s into distinct lowercase words of at least 3 letters or
// digits, without stop words.
func words(s string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		if len(w) < 3 || stopWords[w] || slices.Contains(out, w) {
			continue
		}
		out = append(out, w)
	}
	return out
}
