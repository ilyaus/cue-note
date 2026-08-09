// Package store defines the cue-note persistence contract and its local
// file-backed implementation.
package store

import (
	"context"
	"errors"

	"github.com/ilyaus/cue-note/internal/model"
)

// ErrNotFound reports that no record exists for the requested id.
var ErrNotFound = errors.New("record not found")

// ListOptions filters and paginates a listing. Tags are ANDed, Query is a
// case-insensitive substring match, and a Limit of zero means "no limit".
// CategoryID filters both prompts and notes; Kind applies to prompts only and
// PromptID applies to notes only.
type ListOptions struct {
	Tags       []string
	Query      string
	CategoryID string
	Kind       string
	PromptID   string
	Limit      int
	Offset     int
}

// PromptPage is a filtered, paginated slice of prompts plus the pre-pagination
// total of matching records.
type PromptPage struct {
	Items []model.Prompt
	Total int
}

// NotePage is a filtered, paginated slice of notes plus the pre-pagination
// total of matching records.
type NotePage struct {
	Items []model.Note
	Total int
}

// CategoryPage is a filtered, paginated slice of categories plus the
// pre-pagination total of matching records.
type CategoryPage struct {
	Items []model.Category
	Total int
}

// TagCount is a tag and the number of records carrying it.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// TagInventory reports the tags in use per entity type.
type TagInventory struct {
	Prompts []TagCount `json:"prompts"`
	Notes   []TagCount `json:"notes"`
}

// Repository is the persistence contract the API layer depends on. Every
// implementation must be safe for concurrent use.
type Repository interface {
	CreatePrompt(ctx context.Context, in model.PromptInput) (model.Prompt, error)
	GetPrompt(ctx context.Context, id string) (model.Prompt, error)
	UpdatePrompt(ctx context.Context, id string, in model.PromptInput) (model.Prompt, error)
	DeletePrompt(ctx context.Context, id string, force bool) error
	ListPrompts(ctx context.Context, opts ListOptions) (PromptPage, error)

	CreateNote(ctx context.Context, in model.NoteInput) (model.Note, error)
	GetNote(ctx context.Context, id string) (model.Note, error)
	UpdateNote(ctx context.Context, id string, in model.NoteInput) (model.Note, error)
	DeleteNote(ctx context.Context, id string) error
	ListNotes(ctx context.Context, opts ListOptions) (NotePage, error)

	CreateCategory(ctx context.Context, in model.CategoryInput) (model.Category, error)
	GetCategory(ctx context.Context, id string) (model.Category, error)
	UpdateCategory(ctx context.Context, id string, in model.CategoryInput) (model.Category, error)
	DeleteCategory(ctx context.Context, id string, force bool) error
	ListCategories(ctx context.Context, opts ListOptions) (CategoryPage, error)

	Tags(ctx context.Context) (TagInventory, error)
}
