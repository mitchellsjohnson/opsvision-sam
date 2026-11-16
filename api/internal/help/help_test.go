package help

import (
	"io/fs"
	"path"
	"strings"
	"testing"
)

var wantTopics = []string{
	"asking-sam", "commitments-and-slips", "derived-measures", "imports-and-dedupe",
	"live-and-locked-periods", "metric-kinds", "report-publishing", "restatement",
	"scope-and-filters", "statuses-and-bands", "worst-of-n",
}

func TestEveryTopicFileParses(t *testing.T) {
	files, err := fs.Glob(topicFS, "topics/*.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(wantTopics) {
		t.Fatalf("%d topic files, want %d: %v", len(files), len(wantTopics), files)
	}
	for _, f := range files {
		raw, err := fs.ReadFile(topicFS, f)
		if err != nil {
			t.Fatal(err)
		}
		tp, err := parse(raw)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if want := strings.TrimSuffix(path.Base(f), ".md"); tp.ID != want {
			t.Errorf("%s: id %q, want the file name %q", f, tp.ID, want)
		}
		if tp.Title == "" || strings.TrimSpace(tp.Body) == "" {
			t.Errorf("%s: empty title or body", f)
		}
		if strings.HasPrefix(tp.Body, "---") || strings.Contains(tp.Body, "\nid:") {
			t.Errorf("%s: front matter leaked into the body", f)
		}
	}
}

func TestAllAndGet(t *testing.T) {
	all := All()
	if len(all) != len(wantTopics) {
		t.Fatalf("All() has %d topics, want %d", len(all), len(wantTopics))
	}
	for i, id := range wantTopics {
		if all[i].ID != id {
			t.Fatalf("All()[%d] = %q, want %q (sorted by ID)", i, all[i].ID, id)
		}
		got, ok := Get(id)
		if !ok || got.ID != id || got.Body == "" {
			t.Fatalf("Get(%q) = %+v, %v", id, got, ok)
		}
	}
	if _, ok := Get("no-such-topic"); ok {
		t.Fatal("Get found a topic that does not exist")
	}
	all[0].Title = "changed"
	if again, _ := Get(all[0].ID); again.Title == "changed" {
		t.Fatal("All returned the package's own slice")
	}
}

func TestSearch(t *testing.T) {
	for _, c := range []struct{ query, want string }{
		{"commitment", "commitments-and-slips"},
		{"Why did my commitment slip?", "commitments-and-slips"},
		{"what does red mean", "statuses-and-bands"},
		{"restate under the new methodology", "restatement"},
		{"worst of 2 segments", "worst-of-n"},
		{"duplicate rows in my upload", "imports-and-dedupe"},
		{"publish the report", "report-publishing"},
	} {
		got := Search(c.query)
		if len(got) == 0 || got[0].ID != c.want {
			ids := make([]string, len(got))
			for i, g := range got {
				ids[i] = g.ID
			}
			t.Errorf("Search(%q) = %v, want %s first", c.query, ids, c.want)
		}
		if len(got) > MaxResults {
			t.Errorf("Search(%q) returned %d results, want at most %d", c.query, len(got), MaxResults)
		}
	}
	if got := Search("zzzz qqqq"); len(got) != 0 {
		t.Errorf("Search(nonsense) = %v, want none", got)
	}
	if got := Search("   "); len(got) != 0 {
		t.Errorf("Search(blank) = %v, want none", got)
	}
}
