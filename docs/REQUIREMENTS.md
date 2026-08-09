# Product and Functional Requirements

## 1. Functional Requirements

### FR-001: Prompt Entity
* A prompt is persisted with the fields: `id` (opaque, server-assigned), `name`, `tags` (list of strings), `body` (template text), `variables` (optional list of declared placeholder names), `version` (integer, starts at 1), `createdAt`, `updatedAt` (RFC 3339 UTC).
* `name` and `body` are required on create; a request missing either is rejected with a validation error naming the offending field.
* Tags are normalized: trimmed, lower-cased, de-duplicated, and stored in a stable sorted order.
* `version` increments by exactly one whenever an update changes `body` or `variables`. Edits that only touch `name` or `tags` leave `version` unchanged.
* `id`, `version`, `createdAt`, and `updatedAt` are server-owned; values supplied by a client for those fields are ignored.

### FR-002: Note Entity
* A note is persisted with the fields: `id`, `title`, `tags`, `body` (Markdown), `promptId` (optional linkage to a prompt), `createdAt`, `updatedAt`.
* `title` is required on create; `body` may be empty.
* When `promptId` is present it must reference an existing prompt; otherwise the request is rejected as a validation error. Clearing the link is done by sending an empty `promptId`.
* Tag normalization matches FR-001.

### FR-003: CRUD Semantics
* Create, read, update (full replace of client-owned fields), and delete are supported for both entity types.
* Reading or deleting an unknown id yields the not-found error code, never a partially applied mutation.
* Update is atomic with respect to concurrent requests: two concurrent updates to the same record leave the record in one of the two requested states, never a mix.

### FR-004: Listing, Tag Filtering, and Search
* Listing returns records sorted by `updatedAt` descending, with `id` ascending as a deterministic tiebreaker.
* `tag` may be repeated; a record matches only when it carries **every** requested tag (AND semantics). Matching is case-insensitive.
* `q` performs case-insensitive substring matching. For prompts it searches `name`, `body`, and `variables`; for notes it searches `title` and `body`.
* `tag` and `q` combine conjunctively. `limit` and `offset` paginate the filtered result; the response reports the pre-pagination `total`.
* A tag inventory endpoint returns every distinct tag in use with its usage count per entity type.

### FR-005: Authentication and Binding
* Every request under `/v1/` requires the configured static API key in the `x-cue-note-api-key` header. A missing or mismatched key yields `401` with the standard error envelope and no information about whether the requested record exists.
* The key is read from the `CUE_NOTE_API_KEY` environment variable or an explicitly supplied, git-ignored config file. The server refuses to start when no key is configured, unless authentication is explicitly disabled by operator flag.
* The listen address defaults to `127.0.0.1:8765`. Binding to a non-loopback interface requires an explicit operator-supplied address.
* `/healthz` is unauthenticated and reveals nothing beyond liveness.

### FR-006: Structured Responses and Error Envelope
* All responses are `application/json`. Errors use a single envelope shape carrying a stable machine-readable `code`, a human `message`, and an optional `field` for validation failures.
* Error codes in this version: `unauthorized`, `not_found`, `validation_failed`, `invalid_request`, `method_not_allowed`, `internal_error`.

### FR-007: Web UI
* A separate binary serves a static single-page app that lists, searches by text and tag, creates, edits, re-tags, and deletes both prompts and notes.
* The UI reaches the API through its own server-side proxy so the API key stays in the UI process's environment and is never delivered to the browser.

## 2. Non-Functional Requirements

### NFR-001: Local-First Durability
* All data lives in a single local data file (default `./data/cue-note.json`, overridable). Every mutation is flushed to disk before the HTTP response is written, using a temp-file + `fsync` + `rename` sequence so an interrupted write cannot corrupt the existing file.

### NFR-002: Thread Safety
* The store is safe for concurrent use by many HTTP handlers; reads may proceed in parallel and writes are serialized via `sync.RWMutex`.

### NFR-003: Zero CGO, Single Binary
* Both binaries build with `CGO_ENABLED=0` and embed their static assets, so deployment is a file copy.

### NFR-004: Bounded Request Handling
* Request bodies are size-limited (1 MiB default) and the server enforces read/write header timeouts so a stuck local client cannot exhaust the process.

### NFR-005: Test Coverage of Behavior
* Repository operations (including tag/search filtering and version increment rules) and every HTTP handler path — success, validation failure, auth failure, not found — are covered by `*_test.go` files alongside the logic.
