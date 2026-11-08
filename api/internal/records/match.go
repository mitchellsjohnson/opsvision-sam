package records

import (
	"sort"
	"strings"
	"unicode"

	"opsvision/internal/domain"
)

// SubjectSuggestion is OpsVision's guess at which org unit or tracked item one
// distinct product or team value from a file means. Rows is how many rows carry
// the value. SubjectID is the best match (empty when nothing is close enough),
// Score its closeness from 0.5 to 1 (1 is the same words), and Candidates the
// IDs of up to three matches, best first, for a picker.
type SubjectSuggestion struct {
	Value      string
	Rows       int
	SubjectID  string
	Score      float64
	Candidates []string
}

// minSubjectScore is the least token overlap (Jaccard) worth suggesting.
const minSubjectScore = 0.5

// maxSubjectCandidates is how many matches a suggestion lists.
const maxSubjectCandidates = 3

// noiseWords carry no identity: "Checkout Svc", "Checkout Service" and
// "Checkout team" all mean Checkout.
var noiseWords = map[string]bool{"svc": true, "service": true, "team": true, "app": true}

// subjectTarget is one org unit or tracked item, with the word sets of its name
// and of each source key it already carries.
type subjectTarget struct {
	id      string
	isItem  bool
	retired bool
	forms   []map[string]bool
}

// SuggestSubjects matches each distinct value (with its row count) to the org
// units and tracked items by name and existing source keys. Values are
// compared as sets of lowercase words with punctuation and the words svc,
// service, team, and app removed: the same words score 1.0, otherwise the
// overlap (Jaccard) must be at least 0.5. Ties go to units before items,
// current before retired, then the lower ID, so the answer never depends on
// input or map order. Blank values are skipped. Results are ordered by row
// count, largest first, then by value.
func SuggestSubjects(values map[string]int, units []domain.OrgUnit, items []domain.TrackedItem) []SubjectSuggestion {
	targets := make([]subjectTarget, 0, len(units)+len(items))
	for _, u := range units {
		targets = append(targets, subjectTarget{
			id: u.ID, retired: u.RetiredFrom != nil, forms: wordSets(u.Name, u.SourceKeys),
		})
	}
	for _, it := range items {
		targets = append(targets, subjectTarget{id: it.ID, isItem: true, forms: wordSets(it.Name, it.SourceKeys)})
	}

	out := make([]SubjectSuggestion, 0, len(values))
	for value, rows := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		out = append(out, suggestSubject(value, rows, targets))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Rows != out[j].Rows {
			return out[i].Rows > out[j].Rows
		}
		return out[i].Value < out[j].Value
	})
	return out
}

func suggestSubject(value string, rows int, targets []subjectTarget) SubjectSuggestion {
	words := subjectWords(value)
	type scored struct {
		t     subjectTarget
		score float64
	}
	var hits []scored
	for _, t := range targets {
		best := 0.0
		for _, form := range t.forms {
			if s := jaccard(words, form); s > best {
				best = s
			}
		}
		if best >= minSubjectScore {
			hits = append(hits, scored{t, best})
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		switch {
		case a.score != b.score:
			return a.score > b.score
		case a.t.retired != b.t.retired:
			return !a.t.retired
		case a.t.isItem != b.t.isItem:
			return !a.t.isItem
		}
		return a.t.id < b.t.id
	})

	s := SubjectSuggestion{Value: value, Rows: rows}
	if len(hits) == 0 {
		return s
	}
	s.SubjectID, s.Score = hits[0].t.id, hits[0].score
	for i := 0; i < len(hits) && i < maxSubjectCandidates; i++ {
		s.Candidates = append(s.Candidates, hits[i].t.id)
	}
	return s
}

// wordSets returns the word set of name and of each source key, skipping
// empty ones.
func wordSets(name string, keys []string) []map[string]bool {
	var out []map[string]bool
	for _, s := range append([]string{name}, keys...) {
		if w := subjectWords(s); len(w) > 0 {
			out = append(out, w)
		}
	}
	return out
}

// subjectWords lowercases s, splits it into words on anything that is not a
// letter or digit, and drops noise words. When nothing is left (the value was
// only noise, like "App") the plain words are kept instead.
func subjectWords(s string) map[string]bool {
	all := words(s)
	kept := map[string]bool{}
	for _, w := range all {
		if !noiseWords[w] {
			kept[w] = true
		}
	}
	if len(kept) > 0 {
		return kept
	}
	for _, w := range all {
		kept[w] = true
	}
	return kept
}

// words splits s into lowercase runs of letters and digits.
func words(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// jaccard is |a ∩ b| / |a ∪ b|; 0 when either is empty.
func jaccard(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	inter := 0
	for w := range a {
		if b[w] {
			inter++
		}
	}
	return float64(inter) / float64(len(a)+len(b)-inter)
}
