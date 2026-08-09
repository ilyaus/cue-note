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
	if err := s.DeletePrompt(ctx, "nope", false); !errors.Is(err, ErrNotFound) {
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

	if err := s.DeletePrompt(ctx, prompt.ID, false); err != nil {
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

func mustCreateCategory(t *testing.T, s *JSONFileStore, in model.CategoryInput) model.Category {
	t.Helper()
	c, err := s.CreateCategory(context.Background(), in)
	if err != nil {
		t.Fatalf("CreateCategory: %v", err)
	}
	return c
}

func wantValidationField(t *testing.T, err error, field string) {
	t.Helper()
	var verr *model.ValidationError
	if !errors.As(err, &verr) || verr.Field != field {
		t.Fatalf("error = %v, want validation error on %q", err, field)
	}
}

func TestCategoryCRUDAndCyclePrevention(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	root := mustCreateCategory(t, s, model.CategoryInput{Name: " Root "})
	if root.Name != "Root" || root.ParentID != "" || root.ID == "" {
		t.Fatalf("unexpected category: %+v", root)
	}
	child := mustCreateCategory(t, s, model.CategoryInput{Name: "Child", ParentID: root.ID})
	grandchild := mustCreateCategory(t, s, model.CategoryInput{Name: "Grandchild", ParentID: child.ID})

	if _, err := s.CreateCategory(ctx, model.CategoryInput{Name: "x", ParentID: "missing"}); err == nil {
		t.Fatal("expected error for dangling parentId")
	} else {
		wantValidationField(t, err, "parentId")
	}

	if _, err := s.UpdateCategory(ctx, root.ID, model.CategoryInput{Name: "Root", ParentID: root.ID}); err == nil {
		t.Fatal("expected error for self parent")
	} else {
		wantValidationField(t, err, "parentId")
	}
	if _, err := s.UpdateCategory(ctx, root.ID, model.CategoryInput{Name: "Root", ParentID: grandchild.ID}); err == nil {
		t.Fatal("expected error for cycle")
	} else {
		wantValidationField(t, err, "parentId")
	}

	renamed, err := s.UpdateCategory(ctx, child.ID, model.CategoryInput{Name: "Renamed", ParentID: root.ID})
	if err != nil {
		t.Fatalf("UpdateCategory: %v", err)
	}
	if renamed.Name != "Renamed" {
		t.Errorf("rename failed: %+v", renamed)
	}

	if _, err := s.GetCategory(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCategory error = %v, want ErrNotFound", err)
	}
	if err := s.DeleteCategory(ctx, "nope", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteCategory error = %v, want ErrNotFound", err)
	}

	page, err := s.ListCategories(ctx, ListOptions{Query: "renamed"})
	if err != nil {
		t.Fatalf("ListCategories: %v", err)
	}
	if page.Total != 1 || page.Items[0].ID != child.ID {
		t.Errorf("category search broken: %+v", page)
	}
}

func TestDeleteCategoryForceSemantics(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	root := mustCreateCategory(t, s, model.CategoryInput{Name: "Root"})
	mid := mustCreateCategory(t, s, model.CategoryInput{Name: "Mid", ParentID: root.ID})
	leaf := mustCreateCategory(t, s, model.CategoryInput{Name: "Leaf", ParentID: mid.ID})
	prompt := mustCreatePrompt(t, s, model.PromptInput{Name: "p", Body: "b", CategoryID: mid.ID})
	note, err := s.CreateNote(ctx, model.NoteInput{Title: "n", CategoryID: mid.ID})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if err := s.DeleteCategory(ctx, mid.ID, false); err == nil {
		t.Fatal("expected rejection without force")
	} else {
		wantValidationField(t, err, "id")
	}

	if err := s.DeleteCategory(ctx, mid.ID, true); err != nil {
		t.Fatalf("force delete: %v", err)
	}
	if _, err := s.GetCategory(ctx, mid.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("category survived force delete: %v", err)
	}
	reparented, err := s.GetCategory(ctx, leaf.ID)
	if err != nil {
		t.Fatalf("GetCategory: %v", err)
	}
	if reparented.ParentID != root.ID {
		t.Errorf("child parentId = %q, want %q", reparented.ParentID, root.ID)
	}
	clearedPrompt, err := s.GetPrompt(ctx, prompt.ID)
	if err != nil {
		t.Fatalf("GetPrompt: %v", err)
	}
	if clearedPrompt.CategoryID != "" {
		t.Errorf("prompt categoryId not cleared: %q", clearedPrompt.CategoryID)
	}
	clearedNote, err := s.GetNote(ctx, note.ID)
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if clearedNote.CategoryID != "" {
		t.Errorf("note categoryId not cleared: %q", clearedNote.CategoryID)
	}

	// An empty leaf deletes without force.
	if err := s.DeleteCategory(ctx, leaf.ID, false); err != nil {
		t.Errorf("empty category delete: %v", err)
	}
}

func TestPromptKindAndSystemPromptReferences(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	system := mustCreatePrompt(t, s, model.PromptInput{Name: "sys", Body: "b", Kind: model.KindSystem})
	if system.Kind != model.KindSystem {
		t.Fatalf("kind = %q", system.Kind)
	}
	defaulted := mustCreatePrompt(t, s, model.PromptInput{Name: "plain", Body: "b"})
	if defaulted.Kind != model.KindUser {
		t.Fatalf("default kind = %q, want user", defaulted.Kind)
	}

	if _, err := s.CreatePrompt(ctx, model.PromptInput{Name: "u", Body: "b", SystemPromptID: "missing"}); err == nil {
		t.Fatal("expected error for dangling systemPromptId")
	} else {
		wantValidationField(t, err, "systemPromptId")
	}
	if _, err := s.CreatePrompt(ctx, model.PromptInput{Name: "u", Body: "b", SystemPromptID: defaulted.ID}); err == nil {
		t.Fatal("expected error for user-kind reference target")
	} else {
		wantValidationField(t, err, "systemPromptId")
	}

	user := mustCreatePrompt(t, s, model.PromptInput{Name: "u", Body: "b", SystemPromptID: system.ID})
	if user.SystemPromptID != system.ID {
		t.Fatalf("reference not stored: %+v", user)
	}

	// The referenced system prompt cannot silently become a user prompt.
	if _, err := s.UpdatePrompt(ctx, system.ID, model.PromptInput{Name: "sys", Body: "b", Kind: model.KindUser}); err == nil {
		t.Fatal("expected error for kind change while referenced")
	} else {
		wantValidationField(t, err, "kind")
	}

	if err := s.DeletePrompt(ctx, system.ID, false); err == nil {
		t.Fatal("expected rejection deleting referenced system prompt without force")
	} else {
		wantValidationField(t, err, "id")
	}
	if err := s.DeletePrompt(ctx, system.ID, true); err != nil {
		t.Fatalf("force delete: %v", err)
	}
	cleared, err := s.GetPrompt(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetPrompt: %v", err)
	}
	if cleared.SystemPromptID != "" {
		t.Errorf("systemPromptId not cleared: %q", cleared.SystemPromptID)
	}
}

func TestPromptCategoryReferenceAndFilters(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if _, err := s.CreatePrompt(ctx, model.PromptInput{Name: "p", Body: "b", CategoryID: "missing"}); err == nil {
		t.Fatal("expected error for dangling categoryId")
	} else {
		wantValidationField(t, err, "categoryId")
	}
	if _, err := s.CreateNote(ctx, model.NoteInput{Title: "n", CategoryID: "missing"}); err == nil {
		t.Fatal("expected error for dangling note categoryId")
	} else {
		wantValidationField(t, err, "categoryId")
	}

	cat := mustCreateCategory(t, s, model.CategoryInput{Name: "c"})
	system := mustCreatePrompt(t, s, model.PromptInput{Name: "sys", Body: "b", Kind: model.KindSystem, CategoryID: cat.ID})
	mustCreatePrompt(t, s, model.PromptInput{Name: "user", Body: "b"})

	byCategory, err := s.ListPrompts(ctx, ListOptions{CategoryID: cat.ID})
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if byCategory.Total != 1 || byCategory.Items[0].ID != system.ID {
		t.Errorf("category filter broken: %+v", byCategory)
	}
	byKind, err := s.ListPrompts(ctx, ListOptions{Kind: model.KindSystem})
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if byKind.Total != 1 || byKind.Items[0].ID != system.ID {
		t.Errorf("kind filter broken: %+v", byKind)
	}

	note, err := s.CreateNote(ctx, model.NoteInput{Title: "n", CategoryID: cat.ID, PromptID: system.ID})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if _, err := s.CreateNote(ctx, model.NoteInput{Title: "other"}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	noteByCategory, err := s.ListNotes(ctx, ListOptions{CategoryID: cat.ID})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if noteByCategory.Total != 1 || noteByCategory.Items[0].ID != note.ID {
		t.Errorf("note category filter broken: %+v", noteByCategory)
	}
	noteByPrompt, err := s.ListNotes(ctx, ListOptions{PromptID: system.ID})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if noteByPrompt.Total != 1 || noteByPrompt.Items[0].ID != note.ID {
		t.Errorf("note prompt filter broken: %+v", noteByPrompt)
	}
}

func TestOpenJSONFileMigratesV1Data(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v1.json")
	v1 := `{
  "version": 1,
  "prompts": [
    {"id": "p1", "name": "Old", "tags": [], "body": "b", "variables": [], "version": 1,
     "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}
  ],
  "notes": [
    {"id": "n1", "title": "Old note", "tags": [], "body": "",
     "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}
  ]
}`
	if err := os.WriteFile(path, []byte(v1), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s, err := OpenJSONFile(path)
	if err != nil {
		t.Fatalf("OpenJSONFile: %v", err)
	}
	ctx := context.Background()
	prompt, err := s.GetPrompt(ctx, "p1")
	if err != nil {
		t.Fatalf("GetPrompt: %v", err)
	}
	if prompt.Kind != model.KindUser || prompt.CategoryID != "" || prompt.SystemPromptID != "" {
		t.Errorf("v1 prompt defaults broken: %+v", prompt)
	}
	note, err := s.GetNote(ctx, "n1")
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if note.CategoryID != "" {
		t.Errorf("v1 note defaults broken: %+v", note)
	}
	cats, err := s.ListCategories(ctx, ListOptions{})
	if err != nil {
		t.Fatalf("ListCategories: %v", err)
	}
	if cats.Total != 0 {
		t.Errorf("expected no categories, got %+v", cats)
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
