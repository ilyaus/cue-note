package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/ilyaus/cue-note/internal/model"
)

// snapshotVersion identifies the on-disk layout so a future migration can
// recognize files written by this version. Version 2 adds categories, prompt
// kinds, and category assignments; version 1 files load with defaults.
const snapshotVersion = 2

// snapshot is the full on-disk representation of the store.
type snapshot struct {
	Version    int              `json:"version"`
	Prompts    []model.Prompt   `json:"prompts"`
	Notes      []model.Note     `json:"notes"`
	Categories []model.Category `json:"categories"`
}

// JSONFileStore is a Repository backed by a single local JSON file. The whole
// dataset is held in memory and rewritten atomically on every mutation.
type JSONFileStore struct {
	path string
	now  func() time.Time

	mu         sync.RWMutex
	prompts    map[string]model.Prompt
	notes      map[string]model.Note
	categories map[string]model.Category
}

// compile-time assertion that the file store satisfies the contract.
var _ Repository = (*JSONFileStore)(nil)

// OpenJSONFile loads (or creates) the data file at path. A missing file yields
// an empty store; a malformed file is an error so that a corrupt or foreign
// file is never silently overwritten.
func OpenJSONFile(path string) (*JSONFileStore, error) {
	if path == "" {
		return nil, errors.New("store: data file path must not be empty")
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("store: create data directory %s: %w", dir, err)
		}
	}
	s := &JSONFileStore{
		path:       path,
		now:        func() time.Time { return time.Now().UTC() },
		prompts:    make(map[string]model.Prompt),
		notes:      make(map[string]model.Note),
		categories: make(map[string]model.Category),
	}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("store: read data file %s: %w", path, err)
	}
	if len(raw) == 0 {
		return s, nil
	}
	var snap snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, fmt.Errorf("store: parse data file %s: %w", path, err)
	}
	for _, p := range snap.Prompts {
		if p.Kind == "" {
			p.Kind = model.KindUser
		}
		s.prompts[p.ID] = p
	}
	for _, n := range snap.Notes {
		s.notes[n.ID] = n
	}
	for _, c := range snap.Categories {
		s.categories[c.ID] = c
	}
	return s, nil
}

// Path returns the data file location.
func (s *JSONFileStore) Path() string { return s.path }

func (s *JSONFileStore) CreatePrompt(_ context.Context, in model.PromptInput) (model.Prompt, error) {
	in = in.Normalized()
	if err := in.Validate(); err != nil {
		return model.Prompt{}, err
	}
	id, err := model.NewID()
	if err != nil {
		return model.Prompt{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.checkPromptReferencesLocked(in); err != nil {
		return model.Prompt{}, err
	}
	ts := s.now()
	prompt := model.Prompt{
		ID:             id,
		Name:           in.Name,
		Kind:           in.Kind,
		CategoryID:     in.CategoryID,
		SystemPromptID: in.SystemPromptID,
		Tags:           in.Tags,
		Body:           in.Body,
		Variables:      in.Variables,
		Version:        1,
		CreatedAt:      ts,
		UpdatedAt:      ts,
	}
	s.prompts[id] = prompt
	if err := s.persistLocked(); err != nil {
		delete(s.prompts, id)
		return model.Prompt{}, err
	}
	return prompt, nil
}

func (s *JSONFileStore) GetPrompt(_ context.Context, id string) (model.Prompt, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	prompt, ok := s.prompts[id]
	if !ok {
		return model.Prompt{}, fmt.Errorf("prompt %q: %w", id, ErrNotFound)
	}
	return prompt, nil
}

func (s *JSONFileStore) UpdatePrompt(_ context.Context, id string, in model.PromptInput) (model.Prompt, error) {
	in = in.Normalized()
	if err := in.Validate(); err != nil {
		return model.Prompt{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.prompts[id]
	if !ok {
		return model.Prompt{}, fmt.Errorf("prompt %q: %w", id, ErrNotFound)
	}
	if in.SystemPromptID == id {
		return model.Prompt{}, &model.ValidationError{Field: "systemPromptId", Message: "must not reference the prompt itself"}
	}
	if err := s.checkPromptReferencesLocked(in); err != nil {
		return model.Prompt{}, err
	}
	if existing.Kind == model.KindSystem && in.Kind == model.KindUser {
		for _, p := range s.prompts {
			if p.SystemPromptID == id {
				return model.Prompt{}, &model.ValidationError{Field: "kind", Message: "cannot change kind to user while user prompts reference this system prompt"}
			}
		}
	}
	updated := existing
	updated.Name = in.Name
	updated.Kind = in.Kind
	updated.CategoryID = in.CategoryID
	updated.SystemPromptID = in.SystemPromptID
	updated.Tags = in.Tags
	updated.Body = in.Body
	updated.Variables = in.Variables
	updated.UpdatedAt = s.now()
	if existing.Body != in.Body || !model.SameStrings(existing.Variables, in.Variables) {
		updated.Version = existing.Version + 1
	}
	s.prompts[id] = updated
	if err := s.persistLocked(); err != nil {
		s.prompts[id] = existing
		return model.Prompt{}, err
	}
	return updated, nil
}

func (s *JSONFileStore) DeletePrompt(_ context.Context, id string, force bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.prompts[id]
	if !ok {
		return fmt.Errorf("prompt %q: %w", id, ErrNotFound)
	}
	referencing := make(map[string]model.Prompt)
	for promptID, p := range s.prompts {
		if p.SystemPromptID == id {
			referencing[promptID] = p
		}
	}
	if len(referencing) > 0 && !force {
		return &model.ValidationError{Field: "id", Message: "system prompt is referenced by user prompts; retry with ?force=true to clear the references"}
	}
	for promptID, p := range referencing {
		cleared := p
		cleared.SystemPromptID = ""
		cleared.UpdatedAt = s.now()
		s.prompts[promptID] = cleared
	}
	// Notes keep their linkage semantics honest: a deleted prompt unlinks.
	relinked := make(map[string]model.Note)
	for noteID, note := range s.notes {
		if note.PromptID == id {
			relinked[noteID] = note
			cleared := note
			cleared.PromptID = ""
			cleared.UpdatedAt = s.now()
			s.notes[noteID] = cleared
		}
	}
	delete(s.prompts, id)
	if err := s.persistLocked(); err != nil {
		s.prompts[id] = existing
		for promptID, p := range referencing {
			s.prompts[promptID] = p
		}
		for noteID, note := range relinked {
			s.notes[noteID] = note
		}
		return err
	}
	return nil
}

func (s *JSONFileStore) ListPrompts(_ context.Context, opts ListOptions) (PromptPage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	matched := make([]model.Prompt, 0, len(s.prompts))
	for _, p := range s.prompts {
		if opts.CategoryID != "" && p.CategoryID != opts.CategoryID {
			continue
		}
		if opts.Kind != "" && p.Kind != opts.Kind {
			continue
		}
		if !model.HasAllTags(p.Tags, opts.Tags) {
			continue
		}
		haystacks := append([]string{p.Name, p.Body}, p.Variables...)
		if !model.ContainsFold(opts.Query, haystacks...) {
			continue
		}
		matched = append(matched, p)
	}
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].UpdatedAt.Equal(matched[j].UpdatedAt) {
			return matched[i].UpdatedAt.After(matched[j].UpdatedAt)
		}
		return matched[i].ID < matched[j].ID
	})
	total := len(matched)
	return PromptPage{Items: paginate(matched, opts), Total: total}, nil
}

func (s *JSONFileStore) CreateNote(_ context.Context, in model.NoteInput) (model.Note, error) {
	in = in.Normalized()
	if err := in.Validate(); err != nil {
		return model.Note{}, err
	}
	id, err := model.NewID()
	if err != nil {
		return model.Note{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.checkPromptLinkLocked(in.PromptID); err != nil {
		return model.Note{}, err
	}
	if err := s.checkCategoryLinkLocked(in.CategoryID); err != nil {
		return model.Note{}, err
	}
	ts := s.now()
	note := model.Note{
		ID:         id,
		Title:      in.Title,
		CategoryID: in.CategoryID,
		Tags:       in.Tags,
		Body:       in.Body,
		PromptID:   in.PromptID,
		CreatedAt:  ts,
		UpdatedAt:  ts,
	}
	s.notes[id] = note
	if err := s.persistLocked(); err != nil {
		delete(s.notes, id)
		return model.Note{}, err
	}
	return note, nil
}

func (s *JSONFileStore) GetNote(_ context.Context, id string) (model.Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	note, ok := s.notes[id]
	if !ok {
		return model.Note{}, fmt.Errorf("note %q: %w", id, ErrNotFound)
	}
	return note, nil
}

func (s *JSONFileStore) UpdateNote(_ context.Context, id string, in model.NoteInput) (model.Note, error) {
	in = in.Normalized()
	if err := in.Validate(); err != nil {
		return model.Note{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.notes[id]
	if !ok {
		return model.Note{}, fmt.Errorf("note %q: %w", id, ErrNotFound)
	}
	if err := s.checkPromptLinkLocked(in.PromptID); err != nil {
		return model.Note{}, err
	}
	if err := s.checkCategoryLinkLocked(in.CategoryID); err != nil {
		return model.Note{}, err
	}
	updated := existing
	updated.Title = in.Title
	updated.CategoryID = in.CategoryID
	updated.Tags = in.Tags
	updated.Body = in.Body
	updated.PromptID = in.PromptID
	updated.UpdatedAt = s.now()
	s.notes[id] = updated
	if err := s.persistLocked(); err != nil {
		s.notes[id] = existing
		return model.Note{}, err
	}
	return updated, nil
}

func (s *JSONFileStore) DeleteNote(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.notes[id]
	if !ok {
		return fmt.Errorf("note %q: %w", id, ErrNotFound)
	}
	delete(s.notes, id)
	if err := s.persistLocked(); err != nil {
		s.notes[id] = existing
		return err
	}
	return nil
}

func (s *JSONFileStore) ListNotes(_ context.Context, opts ListOptions) (NotePage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	matched := make([]model.Note, 0, len(s.notes))
	for _, n := range s.notes {
		if opts.CategoryID != "" && n.CategoryID != opts.CategoryID {
			continue
		}
		if opts.PromptID != "" && n.PromptID != opts.PromptID {
			continue
		}
		if !model.HasAllTags(n.Tags, opts.Tags) {
			continue
		}
		if !model.ContainsFold(opts.Query, n.Title, n.Body) {
			continue
		}
		matched = append(matched, n)
	}
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].UpdatedAt.Equal(matched[j].UpdatedAt) {
			return matched[i].UpdatedAt.After(matched[j].UpdatedAt)
		}
		return matched[i].ID < matched[j].ID
	})
	total := len(matched)
	return NotePage{Items: paginate(matched, opts), Total: total}, nil
}

func (s *JSONFileStore) Tags(_ context.Context) (TagInventory, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	promptCounts := make(map[string]int)
	for _, p := range s.prompts {
		for _, tag := range p.Tags {
			promptCounts[tag]++
		}
	}
	noteCounts := make(map[string]int)
	for _, n := range s.notes {
		for _, tag := range n.Tags {
			noteCounts[tag]++
		}
	}
	return TagInventory{Prompts: sortedCounts(promptCounts), Notes: sortedCounts(noteCounts)}, nil
}

func (s *JSONFileStore) CreateCategory(_ context.Context, in model.CategoryInput) (model.Category, error) {
	in = in.Normalized()
	if err := in.Validate(); err != nil {
		return model.Category{}, err
	}
	id, err := model.NewID()
	if err != nil {
		return model.Category{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.checkCategoryParentLocked(id, in.ParentID); err != nil {
		return model.Category{}, err
	}
	ts := s.now()
	category := model.Category{
		ID:        id,
		Name:      in.Name,
		ParentID:  in.ParentID,
		CreatedAt: ts,
		UpdatedAt: ts,
	}
	s.categories[id] = category
	if err := s.persistLocked(); err != nil {
		delete(s.categories, id)
		return model.Category{}, err
	}
	return category, nil
}

func (s *JSONFileStore) GetCategory(_ context.Context, id string) (model.Category, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	category, ok := s.categories[id]
	if !ok {
		return model.Category{}, fmt.Errorf("category %q: %w", id, ErrNotFound)
	}
	return category, nil
}

func (s *JSONFileStore) UpdateCategory(_ context.Context, id string, in model.CategoryInput) (model.Category, error) {
	in = in.Normalized()
	if err := in.Validate(); err != nil {
		return model.Category{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.categories[id]
	if !ok {
		return model.Category{}, fmt.Errorf("category %q: %w", id, ErrNotFound)
	}
	if err := s.checkCategoryParentLocked(id, in.ParentID); err != nil {
		return model.Category{}, err
	}
	updated := existing
	updated.Name = in.Name
	updated.ParentID = in.ParentID
	updated.UpdatedAt = s.now()
	s.categories[id] = updated
	if err := s.persistLocked(); err != nil {
		s.categories[id] = existing
		return model.Category{}, err
	}
	return updated, nil
}

func (s *JSONFileStore) DeleteCategory(_ context.Context, id string, force bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.categories[id]
	if !ok {
		return fmt.Errorf("category %q: %w", id, ErrNotFound)
	}

	childCategories := make(map[string]model.Category)
	for catID, c := range s.categories {
		if c.ParentID == id {
			childCategories[catID] = c
		}
	}
	assignedPrompts := make(map[string]model.Prompt)
	for promptID, p := range s.prompts {
		if p.CategoryID == id {
			assignedPrompts[promptID] = p
		}
	}
	assignedNotes := make(map[string]model.Note)
	for noteID, n := range s.notes {
		if n.CategoryID == id {
			assignedNotes[noteID] = n
		}
	}
	if !force && (len(childCategories) > 0 || len(assignedPrompts) > 0 || len(assignedNotes) > 0) {
		return &model.ValidationError{Field: "id", Message: "category has child categories or assigned items; retry with ?force=true to re-parent children and clear assignments"}
	}

	ts := s.now()
	for catID, c := range childCategories {
		reparented := c
		reparented.ParentID = existing.ParentID
		reparented.UpdatedAt = ts
		s.categories[catID] = reparented
	}
	for promptID, p := range assignedPrompts {
		cleared := p
		cleared.CategoryID = ""
		cleared.UpdatedAt = ts
		s.prompts[promptID] = cleared
	}
	for noteID, n := range assignedNotes {
		cleared := n
		cleared.CategoryID = ""
		cleared.UpdatedAt = ts
		s.notes[noteID] = cleared
	}
	delete(s.categories, id)
	if err := s.persistLocked(); err != nil {
		s.categories[id] = existing
		for catID, c := range childCategories {
			s.categories[catID] = c
		}
		for promptID, p := range assignedPrompts {
			s.prompts[promptID] = p
		}
		for noteID, n := range assignedNotes {
			s.notes[noteID] = n
		}
		return err
	}
	return nil
}

func (s *JSONFileStore) ListCategories(_ context.Context, opts ListOptions) (CategoryPage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	matched := make([]model.Category, 0, len(s.categories))
	for _, c := range s.categories {
		if !model.ContainsFold(opts.Query, c.Name) {
			continue
		}
		matched = append(matched, c)
	}
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].UpdatedAt.Equal(matched[j].UpdatedAt) {
			return matched[i].UpdatedAt.After(matched[j].UpdatedAt)
		}
		return matched[i].ID < matched[j].ID
	})
	total := len(matched)
	return CategoryPage{Items: paginate(matched, opts), Total: total}, nil
}

// checkPromptReferencesLocked validates a prompt input's categoryId and
// systemPromptId against the current dataset. Callers must hold a lock.
func (s *JSONFileStore) checkPromptReferencesLocked(in model.PromptInput) error {
	if err := s.checkCategoryLinkLocked(in.CategoryID); err != nil {
		return err
	}
	if in.SystemPromptID != "" {
		target, ok := s.prompts[in.SystemPromptID]
		if !ok {
			return &model.ValidationError{Field: "systemPromptId", Message: fmt.Sprintf("no prompt exists with id %q", in.SystemPromptID)}
		}
		if target.Kind != model.KindSystem {
			return &model.ValidationError{Field: "systemPromptId", Message: fmt.Sprintf("prompt %q is not a system prompt", in.SystemPromptID)}
		}
	}
	return nil
}

// checkCategoryLinkLocked rejects a categoryId that points at a category that
// is absent. Callers must hold a lock.
func (s *JSONFileStore) checkCategoryLinkLocked(categoryID string) error {
	if categoryID == "" {
		return nil
	}
	if _, ok := s.categories[categoryID]; !ok {
		return &model.ValidationError{Field: "categoryId", Message: fmt.Sprintf("no category exists with id %q", categoryID)}
	}
	return nil
}

// checkCategoryParentLocked rejects a parentId that is absent, self-referential,
// or would introduce a cycle in the category tree. Callers must hold a lock.
func (s *JSONFileStore) checkCategoryParentLocked(id, parentID string) error {
	if parentID == "" {
		return nil
	}
	if parentID == id {
		return &model.ValidationError{Field: "parentId", Message: "must not reference the category itself"}
	}
	if _, ok := s.categories[parentID]; !ok {
		return &model.ValidationError{Field: "parentId", Message: fmt.Sprintf("no category exists with id %q", parentID)}
	}
	seen := map[string]struct{}{id: {}}
	for cursor := parentID; cursor != ""; {
		if _, cycles := seen[cursor]; cycles {
			return &model.ValidationError{Field: "parentId", Message: "must not create a cycle in the category tree"}
		}
		seen[cursor] = struct{}{}
		parent, ok := s.categories[cursor]
		if !ok {
			break
		}
		cursor = parent.ParentID
	}
	return nil
}

// checkPromptLinkLocked rejects a note that points at a prompt that is absent.
func (s *JSONFileStore) checkPromptLinkLocked(promptID string) error {
	if promptID == "" {
		return nil
	}
	if _, ok := s.prompts[promptID]; !ok {
		return &model.ValidationError{Field: "promptId", Message: fmt.Sprintf("no prompt exists with id %q", promptID)}
	}
	return nil
}

// persistLocked writes the whole dataset to a temp file, fsyncs it, and renames
// it over the data file. Callers must hold the write lock.
func (s *JSONFileStore) persistLocked() error {
	snap := snapshot{
		Version:    snapshotVersion,
		Prompts:    make([]model.Prompt, 0, len(s.prompts)),
		Notes:      make([]model.Note, 0, len(s.notes)),
		Categories: make([]model.Category, 0, len(s.categories)),
	}
	for _, p := range s.prompts {
		snap.Prompts = append(snap.Prompts, p)
	}
	for _, n := range s.notes {
		snap.Notes = append(snap.Notes, n)
	}
	for _, c := range s.categories {
		snap.Categories = append(snap.Categories, c)
	}
	sort.Slice(snap.Prompts, func(i, j int) bool { return snap.Prompts[i].ID < snap.Prompts[j].ID })
	sort.Slice(snap.Notes, func(i, j int) bool { return snap.Notes[i].ID < snap.Notes[j].ID })
	sort.Slice(snap.Categories, func(i, j int) bool { return snap.Categories[i].ID < snap.Categories[j].ID })

	payload, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return fmt.Errorf("store: encode snapshot: %w", err)
	}
	payload = append(payload, '\n')

	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".cue-note-*.tmp")
	if err != nil {
		return fmt.Errorf("store: create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return fmt.Errorf("store: write temp file %s: %w", tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("store: sync temp file %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("store: close temp file %s: %w", tmpName, err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("store: chmod temp file %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("store: replace data file %s: %w", s.path, err)
	}
	return nil
}

func paginate[T any](items []T, opts ListOptions) []T {
	offset := opts.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= len(items) {
		return []T{}
	}
	items = items[offset:]
	if opts.Limit > 0 && opts.Limit < len(items) {
		items = items[:opts.Limit]
	}
	return items
}

func sortedCounts(counts map[string]int) []TagCount {
	out := make([]TagCount, 0, len(counts))
	for tag, count := range counts {
		out = append(out, TagCount{Tag: tag, Count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	return out
}
