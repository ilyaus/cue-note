// Package model holds the cue-note domain types and their validation and
// normalization rules. It has no knowledge of net/http or of persistence.
package model

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Prompt is a reusable, versioned block of template text.
type Prompt struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Tags      []string  `json:"tags"`
	Body      string    `json:"body"`
	Variables []string  `json:"variables"`
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Note is a free-form Markdown document, optionally linked to a Prompt.
type Note struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Tags      []string  `json:"tags"`
	Body      string    `json:"body"`
	PromptID  string    `json:"promptId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// PromptInput carries the client-owned fields of a Prompt.
type PromptInput struct {
	Name      string   `json:"name"`
	Tags      []string `json:"tags"`
	Body      string   `json:"body"`
	Variables []string `json:"variables"`
}

// NoteInput carries the client-owned fields of a Note.
type NoteInput struct {
	Title    string   `json:"title"`
	Tags     []string `json:"tags"`
	Body     string   `json:"body"`
	PromptID string   `json:"promptId"`
}

// ValidationError reports a client-supplied field that violates a domain rule.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func newValidationError(field, message string) *ValidationError {
	return &ValidationError{Field: field, Message: message}
}

// Validate reports whether the prompt input satisfies the domain rules.
func (in PromptInput) Validate() error {
	if strings.TrimSpace(in.Name) == "" {
		return newValidationError("name", "must not be empty")
	}
	if strings.TrimSpace(in.Body) == "" {
		return newValidationError("body", "must not be empty")
	}
	return nil
}

// Validate reports whether the note input satisfies the domain rules.
func (in NoteInput) Validate() error {
	if strings.TrimSpace(in.Title) == "" {
		return newValidationError("title", "must not be empty")
	}
	return nil
}

// Normalized returns the prompt input with tags and variables cleaned up.
func (in PromptInput) Normalized() PromptInput {
	in.Name = strings.TrimSpace(in.Name)
	in.Tags = NormalizeTags(in.Tags)
	in.Variables = normalizeVariables(in.Variables)
	return in
}

// Normalized returns the note input with title, tags, and linkage cleaned up.
func (in NoteInput) Normalized() NoteInput {
	in.Title = strings.TrimSpace(in.Title)
	in.Tags = NormalizeTags(in.Tags)
	in.PromptID = strings.TrimSpace(in.PromptID)
	return in
}

// NormalizeTags trims, lower-cases, de-duplicates, and sorts tags. It always
// returns a non-nil slice so JSON encoding yields [] rather than null.
func NormalizeTags(tags []string) []string {
	seen := make(map[string]struct{}, len(tags))
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		t := strings.ToLower(strings.TrimSpace(tag))
		if t == "" {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// normalizeVariables trims and de-duplicates declared placeholder names,
// preserving the author's ordering because it is meaningful for a template.
func normalizeVariables(vars []string) []string {
	seen := make(map[string]struct{}, len(vars))
	out := make([]string, 0, len(vars))
	for _, v := range vars {
		name := strings.TrimSpace(v)
		if name == "" {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

// SameStrings reports whether two string slices hold the same ordered values.
func SameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// HasAllTags reports whether have contains every tag in want, case-insensitively.
func HasAllTags(have, want []string) bool {
	if len(want) == 0 {
		return true
	}
	set := make(map[string]struct{}, len(have))
	for _, h := range have {
		set[strings.ToLower(strings.TrimSpace(h))] = struct{}{}
	}
	for _, w := range want {
		needle := strings.ToLower(strings.TrimSpace(w))
		if needle == "" {
			continue
		}
		if _, ok := set[needle]; !ok {
			return false
		}
	}
	return true
}

// ContainsFold reports whether any of the haystacks contains needle,
// case-insensitively. An empty needle matches everything.
func ContainsFold(needle string, haystacks ...string) bool {
	q := strings.ToLower(strings.TrimSpace(needle))
	if q == "" {
		return true
	}
	for _, h := range haystacks {
		if strings.Contains(strings.ToLower(h), q) {
			return true
		}
	}
	return false
}

// NewID returns an opaque, URL-safe identifier.
func NewID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
