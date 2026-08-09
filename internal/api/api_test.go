package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ilyaus/cue-note/internal/model"
	"github.com/ilyaus/cue-note/internal/store"
)

const testKey = "test-key"

func newTestServer(t *testing.T) *Server {
	t.Helper()
	repo, err := store.OpenJSONFile(filepath.Join(t.TempDir(), "cue-note.json"))
	if err != nil {
		t.Fatalf("OpenJSONFile: %v", err)
	}
	srv, err := New(Config{Repo: repo, APIKey: testKey, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

func do(t *testing.T, srv *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return doWithKey(t, srv, method, path, body, testKey)
}

func doWithKey(t *testing.T, srv *Server, method, path, body, key string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if key != "" {
		req.Header.Set(APIKeyHeader, key)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return out
}

func createPrompt(t *testing.T, srv *Server, body string) model.Prompt {
	t.Helper()
	rec := do(t, srv, http.MethodPost, "/v1/prompts", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create prompt status = %d body = %s", rec.Code, rec.Body.String())
	}
	return decode[model.Prompt](t, rec)
}

func TestNewRequiresRepoAndKey(t *testing.T) {
	if _, err := New(Config{APIKey: "k"}); err == nil {
		t.Error("expected error without repository")
	}
	repo, err := store.OpenJSONFile(filepath.Join(t.TempDir(), "d.json"))
	if err != nil {
		t.Fatalf("OpenJSONFile: %v", err)
	}
	if _, err := New(Config{Repo: repo}); err == nil {
		t.Error("expected error when no API key is configured")
	}
	if _, err := New(Config{Repo: repo, DisableAuth: true}); err != nil {
		t.Errorf("explicit auth opt-out rejected: %v", err)
	}
}

func TestAuthIsEnforcedBeforeLookup(t *testing.T) {
	srv := newTestServer(t)
	prompt := createPrompt(t, srv, `{"name":"n","body":"b"}`)

	for name, key := range map[string]string{"missing": "", "wrong": "nope"} {
		existing := doWithKey(t, srv, http.MethodGet, "/v1/prompts/"+prompt.ID, "", key)
		absent := doWithKey(t, srv, http.MethodGet, "/v1/prompts/does-not-exist", "", key)
		if existing.Code != http.StatusUnauthorized || absent.Code != http.StatusUnauthorized {
			t.Fatalf("%s key: statuses = %d, %d, want 401", name, existing.Code, absent.Code)
		}
		if existing.Body.String() != absent.Body.String() {
			t.Errorf("%s key: unauthenticated responses leak record existence", name)
		}
		if got := decode[ErrorResponse](t, existing).Error.Code; got != CodeUnauthorized {
			t.Errorf("%s key: code = %q", name, got)
		}
	}
}

func TestHealthIsUnauthenticated(t *testing.T) {
	srv := newTestServer(t)
	rec := doWithKey(t, srv, http.MethodGet, "/healthz", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := decode[map[string]string](t, rec)["status"]; got != "ok" {
		t.Errorf("status field = %q", got)
	}
	if rec := doWithKey(t, srv, http.MethodPost, "/healthz", "", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /healthz status = %d", rec.Code)
	}
}

func TestPromptCRUDLifecycle(t *testing.T) {
	srv := newTestServer(t)
	created := createPrompt(t, srv, `{"name":"Summarize","tags":["Writing","writing"],"body":"Summarize {{text}}","variables":["text"]}`)
	if created.Version != 1 || !model.SameStrings(created.Tags, []string{"writing"}) {
		t.Fatalf("unexpected created prompt: %+v", created)
	}

	got := decode[model.Prompt](t, do(t, srv, http.MethodGet, "/v1/prompts/"+created.ID, ""))
	if got.ID != created.ID {
		t.Fatalf("get returned %+v", got)
	}

	updateRec := do(t, srv, http.MethodPut, "/v1/prompts/"+created.ID, `{"name":"Summarize","tags":["writing"],"body":"New body","variables":["text"]}`)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("update status = %d body = %s", updateRec.Code, updateRec.Body.String())
	}
	if updated := decode[model.Prompt](t, updateRec); updated.Version != 2 || updated.Body != "New body" {
		t.Fatalf("unexpected update: %+v", updated)
	}

	delRec := do(t, srv, http.MethodDelete, "/v1/prompts/"+created.ID, "")
	if delRec.Code != http.StatusNoContent || delRec.Body.Len() != 0 {
		t.Fatalf("delete status = %d body = %q", delRec.Code, delRec.Body.String())
	}
	if rec := do(t, srv, http.MethodGet, "/v1/prompts/"+created.ID, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete status = %d", rec.Code)
	}
}

func TestNoteCRUDAndLinkage(t *testing.T) {
	srv := newTestServer(t)
	prompt := createPrompt(t, srv, `{"name":"p","body":"b"}`)

	rec := do(t, srv, http.MethodPost, "/v1/notes", `{"title":"Observations","tags":["Field"],"body":"# heading","promptId":"`+prompt.ID+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create note status = %d body = %s", rec.Code, rec.Body.String())
	}
	note := decode[model.Note](t, rec)
	if note.PromptID != prompt.ID || !model.SameStrings(note.Tags, []string{"field"}) {
		t.Fatalf("unexpected note: %+v", note)
	}

	bad := do(t, srv, http.MethodPost, "/v1/notes", `{"title":"x","promptId":"missing"}`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("dangling link status = %d", bad.Code)
	}
	if env := decode[ErrorResponse](t, bad).Error; env.Code != CodeValidationFailed || env.Field != "promptId" {
		t.Fatalf("unexpected envelope: %+v", env)
	}

	upd := do(t, srv, http.MethodPut, "/v1/notes/"+note.ID, `{"title":"Observations","body":"# heading","promptId":""}`)
	if upd.Code != http.StatusOK {
		t.Fatalf("update note status = %d body = %s", upd.Code, upd.Body.String())
	}
	if decode[model.Note](t, upd).PromptID != "" {
		t.Error("linkage not cleared")
	}
	if rec := do(t, srv, http.MethodDelete, "/v1/notes/"+note.ID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete note status = %d", rec.Code)
	}
}

func TestValidationErrorEnvelope(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodPost, "/v1/prompts", `{"name":"","body":"b"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	env := decode[ErrorResponse](t, rec).Error
	if env.Code != CodeValidationFailed || env.Field != "name" || env.Message == "" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type = %q", ct)
	}
}

func TestMalformedAndUnknownFieldBodies(t *testing.T) {
	srv := newTestServer(t)
	cases := map[string]string{
		"malformed":     `{"name":`,
		"unknown field": `{"name":"n","body":"b","nope":1}`,
		"trailing data": `{"name":"n","body":"b"}{"name":"m"}`,
	}
	for name, body := range cases {
		rec := do(t, srv, http.MethodPost, "/v1/prompts", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d body = %s", name, rec.Code, rec.Body.String())
			continue
		}
		if got := decode[ErrorResponse](t, rec).Error.Code; got != CodeInvalidRequest {
			t.Errorf("%s: code = %q", name, got)
		}
	}
}

func TestBodySizeLimit(t *testing.T) {
	repo, err := store.OpenJSONFile(filepath.Join(t.TempDir(), "cue-note.json"))
	if err != nil {
		t.Fatalf("OpenJSONFile: %v", err)
	}
	srv, err := New(Config{Repo: repo, APIKey: testKey, MaxBodyBytes: 32, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	body := `{"name":"n","body":"` + strings.Repeat("x", 500) + `"}`
	rec := do(t, srv, http.MethodPost, "/v1/prompts", body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := decode[ErrorResponse](t, rec).Error.Code; got != CodeInvalidRequest {
		t.Errorf("code = %q", got)
	}
}

func TestListFilteringAndPaginationOverHTTP(t *testing.T) {
	srv := newTestServer(t)
	createPrompt(t, srv, `{"name":"Alpha","tags":["go","api"],"body":"needle"}`)
	createPrompt(t, srv, `{"name":"Beta","tags":["go"],"body":"plain"}`)

	all := decode[PromptListResponse](t, do(t, srv, http.MethodGet, "/v1/prompts", ""))
	if all.Total != 2 || all.Limit != DefaultListLimit || all.Offset != 0 {
		t.Fatalf("unexpected listing: %+v", all)
	}

	tagged := decode[PromptListResponse](t, do(t, srv, http.MethodGet, "/v1/prompts?tag=go&tag=api", ""))
	if tagged.Total != 1 || tagged.Items[0].Name != "Alpha" {
		t.Fatalf("tag filter broken: %+v", tagged)
	}

	searched := decode[PromptListResponse](t, do(t, srv, http.MethodGet, "/v1/prompts?q=NEEDLE", ""))
	if searched.Total != 1 {
		t.Fatalf("search broken: %+v", searched)
	}

	paged := decode[PromptListResponse](t, do(t, srv, http.MethodGet, "/v1/prompts?limit=1&offset=1", ""))
	if paged.Total != 2 || len(paged.Items) != 1 || paged.Limit != 1 || paged.Offset != 1 {
		t.Fatalf("pagination broken: %+v", paged)
	}
}

func TestListParameterValidation(t *testing.T) {
	srv := newTestServer(t)
	for _, query := range []string{"?limit=0", "?limit=abc", "?limit=100000", "?offset=-1", "?offset=x"} {
		rec := do(t, srv, http.MethodGet, "/v1/prompts"+query, "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d", query, rec.Code)
			continue
		}
		env := decode[ErrorResponse](t, rec).Error
		if env.Code != CodeValidationFailed || env.Field == "" {
			t.Errorf("%s: envelope = %+v", query, env)
		}
	}
}

func TestTagsEndpoint(t *testing.T) {
	srv := newTestServer(t)
	createPrompt(t, srv, `{"name":"a","body":"b","tags":["go"]}`)
	if rec := do(t, srv, http.MethodPost, "/v1/notes", `{"title":"n","tags":["work"]}`); rec.Code != http.StatusCreated {
		t.Fatalf("create note status = %d", rec.Code)
	}
	inv := decode[store.TagInventory](t, do(t, srv, http.MethodGet, "/v1/tags", ""))
	if len(inv.Prompts) != 1 || inv.Prompts[0].Tag != "go" {
		t.Errorf("prompt tags = %+v", inv.Prompts)
	}
	if len(inv.Notes) != 1 || inv.Notes[0].Tag != "work" {
		t.Errorf("note tags = %+v", inv.Notes)
	}
	if rec := do(t, srv, http.MethodPost, "/v1/tags", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /v1/tags status = %d", rec.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	srv := newTestServer(t)
	prompt := createPrompt(t, srv, `{"name":"n","body":"b"}`)
	cases := []struct{ method, path string }{
		{http.MethodPatch, "/v1/prompts"},
		{http.MethodPatch, "/v1/prompts/" + prompt.ID},
		{http.MethodPatch, "/v1/notes"},
		{http.MethodPatch, "/v1/notes/x"},
	}
	for _, c := range cases {
		rec := do(t, srv, c.method, c.path, "")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s: status = %d", c.method, c.path, rec.Code)
			continue
		}
		if rec.Header().Get("Allow") == "" {
			t.Errorf("%s %s: missing Allow header", c.method, c.path)
		}
		if got := decode[ErrorResponse](t, rec).Error.Code; got != CodeMethodNotAllowed {
			t.Errorf("%s %s: code = %q", c.method, c.path, got)
		}
	}
}

func TestUnknownItemRoutes(t *testing.T) {
	srv := newTestServer(t)
	for _, path := range []string{"/v1/prompts/", "/v1/prompts/a/b", "/v1/notes/", "/v1/notes/a/b", "/v1/bogus", "/", "/nope"} {
		rec := do(t, srv, http.MethodGet, path, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d", path, rec.Code)
			continue
		}
		if got := decode[ErrorResponse](t, rec).Error.Code; got != CodeNotFound {
			t.Errorf("%s: code = %q", path, got)
		}
	}
}

func TestDisableAuthServesWithoutKey(t *testing.T) {
	repo, err := store.OpenJSONFile(filepath.Join(t.TempDir(), "cue-note.json"))
	if err != nil {
		t.Fatalf("OpenJSONFile: %v", err)
	}
	srv, err := New(Config{Repo: repo, DisableAuth: true, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if rec := doWithKey(t, srv, http.MethodGet, "/v1/prompts", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}
