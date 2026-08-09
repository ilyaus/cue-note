package model

import "testing"

func TestNormalizeTags(t *testing.T) {
	got := NormalizeTags([]string{" Go ", "go", "API", "", "  "})
	if !SameStrings(got, []string{"api", "go"}) {
		t.Fatalf("NormalizeTags = %v", got)
	}
	if empty := NormalizeTags(nil); empty == nil || len(empty) != 0 {
		t.Fatalf("NormalizeTags(nil) must be an empty non-nil slice, got %#v", empty)
	}
}

func TestHasAllTags(t *testing.T) {
	have := []string{"go", "api"}
	if !HasAllTags(have, nil) {
		t.Error("no filter should match everything")
	}
	if !HasAllTags(have, []string{"GO", " api "}) {
		t.Error("case/whitespace-insensitive AND match failed")
	}
	if HasAllTags(have, []string{"go", "missing"}) {
		t.Error("partial match must not satisfy AND semantics")
	}
}

func TestContainsFold(t *testing.T) {
	if !ContainsFold("", "anything") {
		t.Error("empty query must match")
	}
	if !ContainsFold("NEEDLE", "haystack", "a needle here") {
		t.Error("case-insensitive substring match failed")
	}
	if ContainsFold("needle", "haystack") {
		t.Error("unexpected match")
	}
}

func TestPromptInputValidation(t *testing.T) {
	if err := (PromptInput{Name: "n", Body: "b"}).Validate(); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	nameErr, ok := (PromptInput{Body: "b"}).Validate().(*ValidationError)
	if !ok || nameErr.Field != "name" {
		t.Fatalf("expected name validation error, got %v", nameErr)
	}
	bodyErr, ok := (PromptInput{Name: "n"}).Validate().(*ValidationError)
	if !ok || bodyErr.Field != "body" {
		t.Fatalf("expected body validation error, got %v", bodyErr)
	}
	if bodyErr.Error() == "" {
		t.Error("ValidationError.Error must be non-empty")
	}
}

func TestPromptInputKindValidation(t *testing.T) {
	cases := []struct {
		name      string
		in        PromptInput
		wantField string
	}{
		{"system kind ok", PromptInput{Name: "n", Body: "b", Kind: KindSystem}, ""},
		{"user kind ok", PromptInput{Name: "n", Body: "b", Kind: KindUser}, ""},
		{"empty kind ok", PromptInput{Name: "n", Body: "b"}, ""},
		{"unknown kind", PromptInput{Name: "n", Body: "b", Kind: "assistant"}, "kind"},
		{"system with reference", PromptInput{Name: "n", Body: "b", Kind: KindSystem, SystemPromptID: "abc"}, "systemPromptId"},
		{"user with reference ok", PromptInput{Name: "n", Body: "b", Kind: KindUser, SystemPromptID: "abc"}, ""},
	}
	for _, tc := range cases {
		err := tc.in.Validate()
		if tc.wantField == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", tc.name, err)
			}
			continue
		}
		verr, ok := err.(*ValidationError)
		if !ok || verr.Field != tc.wantField {
			t.Errorf("%s: error = %v, want field %q", tc.name, err, tc.wantField)
		}
	}
}

func TestPromptInputNormalizedDefaultsKind(t *testing.T) {
	in := PromptInput{Name: "n", Body: "b"}.Normalized()
	if in.Kind != KindUser {
		t.Errorf("kind = %q, want %q", in.Kind, KindUser)
	}
	in = PromptInput{Name: "n", Body: "b", Kind: " SYSTEM ", CategoryID: " c1 ", SystemPromptID: " s1 "}.Normalized()
	if in.Kind != KindSystem || in.CategoryID != "c1" || in.SystemPromptID != "s1" {
		t.Errorf("unexpected normalization: %+v", in)
	}
}

func TestCategoryInputValidationAndNormalization(t *testing.T) {
	in := CategoryInput{Name: "  Folder ", ParentID: " p1 "}.Normalized()
	if in.Name != "Folder" || in.ParentID != "p1" {
		t.Fatalf("unexpected normalization: %+v", in)
	}
	if err := in.Validate(); err != nil {
		t.Fatalf("valid category rejected: %v", err)
	}
	verr, ok := (CategoryInput{Name: "  "}).Validate().(*ValidationError)
	if !ok || verr.Field != "name" {
		t.Fatalf("expected name validation error, got %v", verr)
	}
}

func TestNoteInputNormalizationAndValidation(t *testing.T) {
	in := NoteInput{Title: "  Title ", Tags: []string{"X"}, PromptID: "  abc "}.Normalized()
	if in.Title != "Title" || in.PromptID != "abc" || !SameStrings(in.Tags, []string{"x"}) {
		t.Fatalf("unexpected normalization: %+v", in)
	}
	if err := in.Validate(); err != nil {
		t.Fatalf("valid note rejected: %v", err)
	}
	if err := (NoteInput{Title: "  "}).Validate(); err == nil {
		t.Fatal("expected title validation error")
	}
}

func TestPromptInputNormalizedKeepsVariableOrder(t *testing.T) {
	in := PromptInput{Name: "n", Body: "b", Variables: []string{" second ", "first", "second"}}.Normalized()
	if !SameStrings(in.Variables, []string{"second", "first"}) {
		t.Fatalf("variable order not preserved: %v", in.Variables)
	}
}

func TestNewIDIsUniqueAndOpaque(t *testing.T) {
	first, err := NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	second, err := NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if first == second {
		t.Fatal("ids must be unique")
	}
	if len(first) != 32 {
		t.Fatalf("unexpected id length %d", len(first))
	}
}
