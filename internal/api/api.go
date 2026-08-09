// Package api exposes the cue-note HTTP contract: routing, API-key
// authentication, JSON encoding, and the single structured error envelope.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ilyaus/cue-note/internal/model"
	"github.com/ilyaus/cue-note/internal/store"
)

// APIKeyHeader carries the static API key on every /v1 request.
const APIKeyHeader = "x-cue-note-api-key"

// DefaultMaxBodyBytes bounds a request body, per NFR-004.
const DefaultMaxBodyBytes int64 = 1 << 20

// DefaultListLimit is applied when a caller does not ask for a page size.
const DefaultListLimit = 100

// MaxListLimit caps an explicit page size.
const MaxListLimit = 1000

// Error codes returned in the error envelope.
const (
	CodeUnauthorized     = "unauthorized"
	CodeNotFound         = "not_found"
	CodeValidationFailed = "validation_failed"
	CodeInvalidRequest   = "invalid_request"
	CodeMethodNotAllowed = "method_not_allowed"
	CodeInternalError    = "internal_error"
)

// Config wires a Server. Repo is required; APIKey is required unless
// DisableAuth is set (intended for tests and explicit operator opt-out).
type Config struct {
	Repo         store.Repository
	APIKey       string
	DisableAuth  bool
	MaxBodyBytes int64
	Logger       *log.Logger
}

// Server routes and serves the cue-note API.
type Server struct {
	repo         store.Repository
	apiKey       string
	disableAuth  bool
	maxBodyBytes int64
	logger       *log.Logger
	mux          *http.ServeMux
}

// ErrorBody is the payload of the single error envelope.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

// ErrorResponse is the only error shape the API emits.
type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

// PromptListResponse is the prompt listing payload.
type PromptListResponse struct {
	Items  []model.Prompt `json:"items"`
	Total  int            `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
}

// NoteListResponse is the note listing payload.
type NoteListResponse struct {
	Items  []model.Note `json:"items"`
	Total  int          `json:"total"`
	Limit  int          `json:"limit"`
	Offset int          `json:"offset"`
}

// New builds a Server. It fails when the configuration cannot serve requests
// safely — notably an unset API key without an explicit opt-out.
func New(cfg Config) (*Server, error) {
	if cfg.Repo == nil {
		return nil, errors.New("api: repository must not be nil")
	}
	if cfg.APIKey == "" && !cfg.DisableAuth {
		return nil, errors.New("api: API key must be configured (set CUE_NOTE_API_KEY) or auth explicitly disabled")
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	s := &Server{
		repo:         cfg.Repo,
		apiKey:       cfg.APIKey,
		disableAuth:  cfg.DisableAuth,
		maxBodyBytes: cfg.MaxBodyBytes,
		logger:       cfg.Logger,
		mux:          http.NewServeMux(),
	}
	s.routes()
	return s, nil
}

func (s *Server) routes() {
	s.mux.HandleFunc("/healthz", s.handleHealth)
	s.mux.Handle("/v1/prompts", s.authenticated(http.HandlerFunc(s.handlePromptCollection)))
	s.mux.Handle("/v1/prompts/", s.authenticated(http.HandlerFunc(s.handlePromptItem)))
	s.mux.Handle("/v1/notes", s.authenticated(http.HandlerFunc(s.handleNoteCollection)))
	s.mux.Handle("/v1/notes/", s.authenticated(http.HandlerFunc(s.handleNoteItem)))
	s.mux.Handle("/v1/tags", s.authenticated(http.HandlerFunc(s.handleTags)))
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// authenticated rejects requests that do not carry the configured API key. It
// runs before any record lookup so an unauthenticated caller cannot learn
// whether an id exists.
func (s *Server) authenticated(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.disableAuth {
			presented := r.Header.Get(APIKeyHeader)
			if subtle.ConstantTimeCompare([]byte(presented), []byte(s.apiKey)) != 1 {
				s.writeError(w, http.StatusUnauthorized, CodeUnauthorized, "missing or invalid API key", "")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w, http.MethodGet)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w, http.MethodGet)
		return
	}
	inventory, err := s.repo.Tags(r.Context())
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, inventory)
}

func (s *Server) handlePromptCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		opts, err := listOptions(r)
		if err != nil {
			s.writeValidation(w, err)
			return
		}
		page, err := s.repo.ListPrompts(r.Context(), opts)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, PromptListResponse{
			Items:  page.Items,
			Total:  page.Total,
			Limit:  opts.Limit,
			Offset: opts.Offset,
		})
	case http.MethodPost:
		var in model.PromptInput
		if err := s.decode(w, r, &in); err != nil {
			s.writeDecodeError(w, err)
			return
		}
		prompt, err := s.repo.CreatePrompt(r.Context(), in)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, prompt)
	default:
		s.methodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func (s *Server) handlePromptItem(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r.URL.Path, "/v1/prompts/")
	if !ok {
		s.writeError(w, http.StatusNotFound, CodeNotFound, "unknown route", "")
		return
	}
	switch r.Method {
	case http.MethodGet:
		prompt, err := s.repo.GetPrompt(r.Context(), id)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, prompt)
	case http.MethodPut:
		var in model.PromptInput
		if err := s.decode(w, r, &in); err != nil {
			s.writeDecodeError(w, err)
			return
		}
		prompt, err := s.repo.UpdatePrompt(r.Context(), id, in)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, prompt)
	case http.MethodDelete:
		if err := s.repo.DeletePrompt(r.Context(), id); err != nil {
			s.writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		s.methodNotAllowed(w, http.MethodGet, http.MethodPut, http.MethodDelete)
	}
}

func (s *Server) handleNoteCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		opts, err := listOptions(r)
		if err != nil {
			s.writeValidation(w, err)
			return
		}
		page, err := s.repo.ListNotes(r.Context(), opts)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, NoteListResponse{
			Items:  page.Items,
			Total:  page.Total,
			Limit:  opts.Limit,
			Offset: opts.Offset,
		})
	case http.MethodPost:
		var in model.NoteInput
		if err := s.decode(w, r, &in); err != nil {
			s.writeDecodeError(w, err)
			return
		}
		note, err := s.repo.CreateNote(r.Context(), in)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, note)
	default:
		s.methodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func (s *Server) handleNoteItem(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r.URL.Path, "/v1/notes/")
	if !ok {
		s.writeError(w, http.StatusNotFound, CodeNotFound, "unknown route", "")
		return
	}
	switch r.Method {
	case http.MethodGet:
		note, err := s.repo.GetNote(r.Context(), id)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, note)
	case http.MethodPut:
		var in model.NoteInput
		if err := s.decode(w, r, &in); err != nil {
			s.writeDecodeError(w, err)
			return
		}
		note, err := s.repo.UpdateNote(r.Context(), id, in)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, note)
	case http.MethodDelete:
		if err := s.repo.DeleteNote(r.Context(), id); err != nil {
			s.writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		s.methodNotAllowed(w, http.MethodGet, http.MethodPut, http.MethodDelete)
	}
}

// pathID extracts a single trailing path segment, rejecting empty and nested ids.
func pathID(path, prefix string) (string, bool) {
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// listOptions parses tag, q, limit, and offset query parameters.
func listOptions(r *http.Request) (store.ListOptions, error) {
	query := r.URL.Query()
	opts := store.ListOptions{
		Tags:  model.NormalizeTags(query["tag"]),
		Query: query.Get("q"),
		Limit: DefaultListLimit,
	}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > MaxListLimit {
			return store.ListOptions{}, &model.ValidationError{
				Field:   "limit",
				Message: "must be an integer between 1 and " + strconv.Itoa(MaxListLimit),
			}
		}
		opts.Limit = limit
	}
	if raw := query.Get("offset"); raw != "" {
		offset, err := strconv.Atoi(raw)
		if err != nil || offset < 0 {
			return store.ListOptions{}, &model.ValidationError{Field: "offset", Message: "must be a non-negative integer"}
		}
		opts.Offset = offset
	}
	return opts, nil
}

// decode reads a bounded JSON body, rejecting unknown fields so a typo in a
// consumer's payload surfaces immediately rather than being silently dropped.
func (s *Server) decode(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(new(struct{})); !errors.Is(err, io.EOF) {
		return errors.New("body must contain exactly one JSON object")
	}
	return nil
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		s.logger.Printf("cue-note: encode response: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"internal_error","message":"failed to encode response"}}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		s.logger.Printf("cue-note: write response: %v", err)
	}
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, message, field string) {
	s.writeJSON(w, status, ErrorResponse{Error: ErrorBody{Code: code, Message: message, Field: field}})
}

func (s *Server) methodNotAllowed(w http.ResponseWriter, allowed ...string) {
	w.Header().Set("Allow", strings.Join(allowed, ", "))
	s.writeError(w, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "method not allowed for this resource", "")
}

func (s *Server) writeDecodeError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		s.writeError(w, http.StatusRequestEntityTooLarge, CodeInvalidRequest, "request body too large", "")
		return
	}
	s.writeError(w, http.StatusBadRequest, CodeInvalidRequest, "malformed JSON request body: "+err.Error(), "")
}

func (s *Server) writeValidation(w http.ResponseWriter, err error) {
	var verr *model.ValidationError
	if errors.As(err, &verr) {
		s.writeError(w, http.StatusBadRequest, CodeValidationFailed, verr.Message, verr.Field)
		return
	}
	s.writeError(w, http.StatusBadRequest, CodeValidationFailed, err.Error(), "")
}

// writeStoreError maps domain and persistence errors onto the envelope exactly
// once, keeping unexpected internal detail out of the response.
func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	var verr *model.ValidationError
	switch {
	case errors.As(err, &verr):
		s.writeError(w, http.StatusBadRequest, CodeValidationFailed, verr.Message, verr.Field)
	case errors.Is(err, store.ErrNotFound):
		s.writeError(w, http.StatusNotFound, CodeNotFound, "record not found", "")
	default:
		s.logger.Printf("cue-note: internal error: %v", err)
		s.writeError(w, http.StatusInternalServerError, CodeInternalError, "internal error", "")
	}
}
