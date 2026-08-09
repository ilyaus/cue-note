package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ilyaus/cue-note/internal/model"
)

func newTestStore(t *testing.T) *JSONFileStore {
	t.Helper()
	path := filepath.Join(t.TempDir(), "nested", "cue-note.json")
	s, err := OpenJSONFile(path)
	if err != nil {
		t.Fatalf("OpenJSONFile: %v", err)
	}
	var ticks int64
	s.now = func() time.Time {
		ticks++
		return time.Unix(1700000000+ticks, 0).UTC()
	}
	return s
}

func mustCreatePrompt(t *testing.T, s *JSONFileStore, in model.PromptInput) model.Prompt {
	t.Helper()
	p, err := s.CreatePrompt(context.Background(), in)
	if err != nil {
		t.Fatalf("CreatePrompt: %v", err)
	}
	return p
}

func TestCreatePromptNormalizesAndPersists(t *testing.T) {
	s := newTestStore(t)
	created := mustCreatePrompt(t, s, model.PromptInput{
		Name:      "  Summarize  ",
		Tags:      []string{"Writing", " writing ", "LLM", ""},
		Body:      "Summarize {{text}}",
		Variables: []string{" text ", "text", ""},
	})

	if created.Name != "Summarize" {
		t.Errorf("name not trimmed: %q", created.Name)
	}
	if !model.SameStrings(created.Tags, []string{"llm", "writing"}) {
		t.Errorf("tags not normalized: %v", created.Tags)
	}
	if !model.SameStrings(created.Variables, []string{"text"}) {
		t.Errorf("variables not normalized: %v", created.Variables)
	}
	if created.Version != 1 {
		t.Errorf("version = %d, want 1", created.Version)
	}
	if created.ID == "" || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Errorf("unexpected server-owned fields: %+v", created)
	}

	reopened, err := OpenJSONFile(s.Path())
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, err := reopened.GetPrompt(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("GetPrompt after reopen: %v", err)
	}
	if got.Name != created.Name || got.Version != 1 {
		t.Errorf("record did not survive reopen: %+v", got)
	}
}

func TestCreatePromptValidation(t *testing.T) {
	s := newTestStore(t)
	cases := map[string]model.PromptInput{
		"name": {Name: "   ", Body: "body"},
		"body": {Name: "name", Body: "\n\t"},
	}
	for field, in := range cases {
		_, err := s.CreatePrompt(context.Background(), in)
		var verr *model.ValidationError
		if !errors.As(err, &verr) {
			t.Fatalf("%s: expected validation error, got %v", field, err)
		}
		if verr.Field != field {
			t.Errorf("field = %q, want %q", verr.Field, field)
		}
	}
}

func TestUpdatePromptVersionRules(t *testing.T) {
	s := newTestStore(t)
	created := mustCreatePrompt(t, s, model.PromptInput{Name: "n", Body: "body", Variables: []string{"a"}})

	renamed, err := s.UpdatePrompt(context.Background(), created.ID, model.PromptInput{
		Name: "renamed", Tags: []string{"x"}, Body: "body", Variables: []string{"a"},
	})
	if err != nil {
		t.Fatalf("UpdatePrompt (metadata only): %v", err)
	}
	if renamed.Version != 1 {
		t.Errorf("metadata-only edit bumped version to %d", renamed.Version)
	}
	if !renamed.UpdatedAt.After(created.UpdatedAt) {
		t.Errorf("updatedAt not advanced")
	}

	rebodied, err := s.UpdatePrompt(context.Background(), created.ID, model.PromptInput{
		Name: "renamed", Body: "new body", Variables: []string{"a"},
	})
	if err != nil {
		t.Fatalf("UpdatePrompt (body): %v", err)
	}
	if rebodied.Version != 2 {
		t.Errorf("body edit version = %d, want 2", rebodied.Version)
	}

	revars, err := s.UpdatePrompt(context.Background(), created.ID, model.PromptInput{
		Name: "renamed", Body: "new body", Variables: []string{"a", "b"},
	})
	if err != nil {
		t.Fatalf("UpdatePrompt (variables): %v", err)
	}
	if revars.Version != 3 {
		t.Errorf("variables edit version = %d, want 3", revars.Version)
	}
	if !revars.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("createdAt mutated by update")
	}
}

func TestPromptNotFound(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if _, err := s.GetPrompt(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetPrompt error = %v, want ErrNotFound", err)
	}
	if _, err := s.UpdatePrompt(ctx, "nope", model.PromptInput{Name: "n", Body: "b"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdatePrompt error = %v, want ErrNotFound", err)
	}
	if err := s.DeletePrompt(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeletePrompt error = %v, want ErrNotFound", err)
	}
	if _, err := s.GetNote(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetNote error = %v, want ErrNotFound", err)
	}
	if err := s.DeleteNote(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteNote error = %v, want ErrNotFound", err)
	}
}

func TestListPromptsFilteringAndPagination(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	first := mustCreatePrompt(t, s, model.PromptInput{Name: "Alpha", Tags: []string{"go", "api"}, Body: "needle in body"})
	second := mustCreatePrompt(t, s, model.PromptInput{Name: "Beta", Tags: []string{"go"}, Body: "nothing here"})
	third := mustCreatePrompt(t, s, model.PromptInput{Name: "NEEDLE name", Tags: []string{"api"}, Body: "x"})

	all, err := s.ListPrompts(ctx, ListOptions{})
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if all.Total != 3 {
		t.Fatalf("total = %d, want 3", all.Total)
	}
	// Newest updatedAt first.
	if all.Items[0].ID != third.ID || all.Items[2].ID != first.ID {
		t.Errorf("unexpected ordering: %v", []string{all.Items[0].Name, all.Items[1].Name, all.Items[2].Name})
	}

	tagged, err := s.ListPrompts(ctx, ListOptions{Tags: []string{"GO", "api"}})
	if err != nil {
		t.Fatalf("ListPrompts (tags): %v", err)
	}
	if tagged.Total != 1 || tagged.Items[0].ID != first.ID {
		t.Errorf("tag AND semantics broken: %+v", tagged)
	}

	searched, err := s.ListPrompts(ctx, ListOptions{Query: "needle"})
	if err != nil {
		t.Fatalf("ListPrompts (query): %v", err)
	}
	if searched.Total != 2 {
		t.Errorf("query total = %d, want 2 (name + body match)", searched.Total)
	}

	combined, err := s.ListPrompts(ctx, ListOptions{Tags: []string{"go"}, Query: "needle"})
	if err != nil {
		t.Fatalf("ListPrompts (combined): %v", err)
	}
	if combined.Total != 1 || combined.Items[0].ID != first.ID {
		t.Errorf("tag+query conjunction broken: %+v", combined)
	}

	paged, err := s.ListPrompts(ctx, ListOptions{Limit: 1, Offset: 1})
	if err != nil {
		t.Fatalf("ListPrompts (paged): %v", err)
	}
	if paged.Total != 3 || len(paged.Items) != 1 || paged.Items[0].ID != second.ID {
		t.Errorf("pagination broken: total=%d items=%d", paged.Total, len(paged.Items))
	}

	beyond, err := s.ListPrompts(ctx, ListOptions{Offset: 99})
	if err != nil {
		t.Fatalf("ListPrompts (beyond): %v", err)
	}
	if len(beyond.Items) != 0 || beyond.Total != 3 {
		t.Errorf("offset past end: %+v", beyond)
	}
}

func TestVariableSearchMatchesPrompts(t *testing.T) {
	s := newTestStore(t)
	mustCreatePrompt(t, s, model.PromptInput{Name: "n", Body: "b", Variables: []string{"customerName"}})
	page, err := s.ListPrompts(context.Background(), ListOptions{Query: "customername"})
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if page.Total != 1 {
		t.Errorf("variables not searched: total = %d", page.Total)
	}
}

func TestNoteLinkageLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	prompt := mustCreatePrompt(t, s, model.PromptInput{Name: "p", Body: "b"})

	if _, err := s.CreateNote(ctx, model.NoteInput{Title: "t", PromptID: "missing"}); err == nil {
		t.Fatal("expected validation error for dangling promptId")
	} else {
		var verr *model.ValidationError
		if !errors.As(err, &verr) || verr.Field != "promptId" {
			t.Fatalf("unexpected error: %v", err)
		}
	}

	note, err := s.CreateNote(ctx, model.NoteInput{Title: "Linked", Tags: []string{"B", "a"}, Body: "# md", PromptID: prompt.ID})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if note.PromptID != prompt.ID || !model.SameStrings(note.Tags, []string{"a", "b"}) {
		t.Fatalf("unexpected note: %+v", note)
	}

	unlinked, err := s.UpdateNote(ctx, note.ID, model.NoteInput{Title: "Linked", Body: "# md", PromptID: ""})
	if err != nil {
		t.Fatalf("UpdateNote: %v", err)
	}
	if unlinked.PromptID != "" {
		t.Errorf("promptId not cleared: %q", unlinked.PromptID)
	}

	relinked, err := s.UpdateNote(ctx, note.ID, model.NoteInput{Title: "Linked", Body: "# md", PromptID: prompt.ID})
	if err != nil {
		t.Fatalf("UpdateNote (relink): %v", err)
	}
	if relinked.PromptID != prompt.ID {
		t.Fatalf("relink failed: %+v", relinked)
	}

	if err := s.DeletePrompt(ctx, prompt.ID); err != nil {
		t.Fatalf("DeletePrompt: %v", err)
	}
	after, err := s.GetNote(ctx, note.ID)
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if after.PromptID != "" {
		t.Errorf("note still links to deleted prompt: %q", after.PromptID)
	}
}

func TestListNotesFiltering(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if _, err := s.CreateNote(ctx, model.NoteInput{Title: "Meeting notes", Tags: []string{"work"}, Body: "budget review"}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if _, err := s.CreateNote(ctx, model.NoteInput{Title: "Recipe", Tags: []string{"home"}, Body: "flour"}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	byTag, err := s.ListNotes(ctx, ListOptions{Tags: []string{"work"}})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if byTag.Total != 1 || byTag.Items[0].Title != "Meeting notes" {
		t.Errorf("tag filter broken: %+v", byTag)
	}

	byQuery, err := s.ListNotes(ctx, ListOptions{Query: "BUDGET"})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if byQuery.Total != 1 {
		t.Errorf("body search broken: %+v", byQuery)
	}
}

func TestDeleteNoteRemovesRecord(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	note, err := s.CreateNote(ctx, model.NoteInput{Title: "temp"})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if err := s.DeleteNote(ctx, note.ID); err != nil {
		t.Fatalf("DeleteNote: %v", err)
	}
	if _, err := s.GetNote(ctx, note.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("note survived delete: %v", err)
	}
	page, err := s.ListNotes(ctx, ListOptions{})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if page.Total != 0 {
		t.Errorf("total = %d, want 0", page.Total)
	}
}

func TestTagsInventory(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustCreatePrompt(t, s, model.PromptInput{Name: "a", Body: "b", Tags: []string{"go", "api"}})
	mustCreatePrompt(t, s, model.PromptInput{Name: "c", Body: "d", Tags: []string{"go"}})
	if _, err := s.CreateNote(ctx, model.NoteInput{Title: "n", Tags: []string{"work"}}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	inv, err := s.Tags(ctx)
	if err != nil {
		t.Fatalf("Tags: %v", err)
	}
	want := []TagCount{{Tag: "go", Count: 2}, {Tag: "api", Count: 1}}
	if len(inv.Prompts) != len(want) {
		t.Fatalf("prompt tags = %+v", inv.Prompts)
	}
	for i := range want {
		if inv.Prompts[i] != want[i] {
			t.Errorf("prompt tag %d = %+v, want %+v", i, inv.Prompts[i], want[i])
		}
	}
	if len(inv.Notes) != 1 || inv.Notes[0] != (TagCount{Tag: "work", Count: 1}) {
		t.Errorf("note tags = %+v", inv.Notes)
	}
}

func TestOpenJSONFileRejectsMalformedData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := OpenJSONFile(path); err == nil {
		t.Fatal("expected error for malformed data file")
	}
	if _, err := OpenJSONFile(""); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestConcurrentMutationsAreSafe(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	const n = 25
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.CreatePrompt(ctx, model.PromptInput{Name: "concurrent", Body: "body"}); err != nil {
				t.Errorf("CreatePrompt: %v", err)
				return
			}
			if _, err := s.ListPrompts(ctx, ListOptions{Query: "body"}); err != nil {
				t.Errorf("ListPrompts: %v", err)
			}
		}()
	}
	wg.Wait()

	page, err := s.ListPrompts(ctx, ListOptions{Limit: n})
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if page.Total != n {
		t.Errorf("total = %d, want %d", page.Total, n)
	}
}
