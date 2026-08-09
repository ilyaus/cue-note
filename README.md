# cue-note

A local-first, secure store for **Prompts** and **Notes**, written in pure Go with
zero CGO. It runs as a long-lived process on your own machine, exposes a
structured JSON HTTP API for other local applications (such as `loomwork`) to
read and write the library, and ships a separate web UI for browsing and editing
it by hand.

- **Two entity types** — versioned prompt templates with declared variables, and
  Markdown notes that can link to a prompt.
- **Local-first** — the whole library is one human-readable JSON file on your
  disk. No cloud, no telemetry, no network egress.
- **Secure by default** — binds `127.0.0.1`, and every `/v1` request must carry a
  static API key in the `x-cue-note-api-key` header.
- **Search and tags** — list, filter by multiple tags (AND), and case-insensitive
  substring search across names/titles, bodies, and prompt variables.
- **Separate UI** — a small static single-page app served by its own binary,
  which consumes the exact same public API a third-party consumer does.
- **Pure Go, standard library first** — no third-party dependencies at all.

Specification documents live in [`.specify/memory/constitution.md`](.specify/memory/constitution.md),
[`docs/INTENT.md`](docs/INTENT.md), [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md),
and [`docs/architecture.md`](docs/architecture.md).

## Build

```bash
make build      # builds bin/cue-note-server (API) and bin/cue-note-ui (web UI)
make test       # runs the unit test suites
make vet        # go vet ./...
make fmt        # gofmt -l -w .
```

Both binaries are built with `CGO_ENABLED=0`. Go 1.21+ is required.

## Run

```bash
export CUE_NOTE_API_KEY="$(openssl rand -hex 32)"   # never commit this
./bin/cue-note-server                               # API on http://127.0.0.1:8765
./bin/cue-note-ui                                   # UI  on http://127.0.0.1:8766
```

Then open <http://127.0.0.1:8766> in a browser.

The server refuses to start without an API key unless you pass `--disable-auth`.
Data is written to `./data/cue-note.json` by default; the `data/` directory is
git-ignored.

### `cue-note-server` flags

| Flag | Default | Description |
| --- | --- | --- |
| `--addr` | `127.0.0.1:8765` | Listen address. A non-loopback value logs a warning. |
| `--data-file` | `data/cue-note.json` | Path to the JSON data file. |
| `--config` | — | Optional JSON config file. Environment variables always win. |
| `--disable-auth` | `false` | Serve without API-key authentication (local development only). |

### `cue-note-ui` flags

| Flag | Default | Description |
| --- | --- | --- |
| `--addr` | `127.0.0.1:8766` | Listen address for the UI. |
| `--api-url` | `http://127.0.0.1:8765` | Base URL of the cue-note API. |
| `--config` | — | Optional JSON config file. |

### Configuration

| Variable | Config file key | Default | Used by |
| --- | --- | --- | --- |
| `CUE_NOTE_API_KEY` | `apiKey` | — (required) | server, ui |
| `CUE_NOTE_ADDR` | `addr` | `127.0.0.1:8765` | server |
| `CUE_NOTE_DATA_FILE` | `dataFile` | `data/cue-note.json` | server |
| `CUE_NOTE_UI_ADDR` | `uiAddr` | `127.0.0.1:8766` | ui |
| `CUE_NOTE_API_URL` | `apiUrl` | `http://127.0.0.1:8765` | ui |

A config file is optional and, if used, must stay out of version control —
`config.json` is git-ignored:

```json
{
  "apiKey": "…",
  "addr": "127.0.0.1:8765",
  "dataFile": "data/cue-note.json"
}
```

---

# API contract

Base URL: `http://127.0.0.1:8765`. All request and response bodies are
`application/json`. This is the surface `loomwork` codes against.

## Authentication

Every route under `/v1/` requires the static API key:

```http
x-cue-note-api-key: <CUE_NOTE_API_KEY>
```

A missing or wrong key returns `401` with the `unauthorized` code and reveals
nothing about whether the requested record exists. `GET /healthz` is the only
unauthenticated route.

```bash
curl -s http://127.0.0.1:8765/v1/prompts \
  -H "x-cue-note-api-key: $CUE_NOTE_API_KEY"
```

### How `loomwork` should authenticate

1. Read the key from its own environment (`CUE_NOTE_API_KEY`) or its secret
   store — never from a committed file.
2. Send it verbatim in the `x-cue-note-api-key` header on every `/v1` request.
3. Treat `401 unauthorized` as a configuration fault (do not retry); treat
   `502`/connection refused as "cue-note is not running".
4. Talk to `127.0.0.1` only. Both processes are expected to be on the same host.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness. Unauthenticated. |
| `GET` | `/v1/prompts` | List/search prompts. |
| `POST` | `/v1/prompts` | Create a prompt. |
| `GET` | `/v1/prompts/{id}` | Fetch one prompt. |
| `PUT` | `/v1/prompts/{id}` | Replace a prompt's client-owned fields. |
| `DELETE` | `/v1/prompts/{id}` | Delete a prompt (linked notes are unlinked). |
| `GET` | `/v1/notes` | List/search notes. |
| `POST` | `/v1/notes` | Create a note. |
| `GET` | `/v1/notes/{id}` | Fetch one note. |
| `PUT` | `/v1/notes/{id}` | Replace a note's client-owned fields. |
| `DELETE` | `/v1/notes/{id}` | Delete a note. |
| `GET` | `/v1/tags` | Distinct tags in use, with counts, per entity type. |

## Entity shapes

### Prompt

```json
{
  "id": "9f1c1c4d8f7b4a1e9d0b6a2c3e4f5a6b",
  "name": "Summarize transcript",
  "tags": ["meetings", "writing"],
  "body": "Summarize the following transcript:\n\n{{transcript}}",
  "variables": ["transcript"],
  "version": 3,
  "createdAt": "2026-01-04T09:12:44Z",
  "updatedAt": "2026-02-11T17:03:02Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Server-assigned, opaque. |
| `name` | string | Required, non-blank. |
| `tags` | string[] | Trimmed, lower-cased, de-duplicated, sorted. Always present (`[]` when empty). |
| `body` | string | Required, non-blank. The template text. |
| `variables` | string[] | Optional declared placeholder names, de-duplicated, author order preserved. |
| `version` | int | Starts at `1`; increments by one whenever `body` or `variables` change. Edits to `name`/`tags` alone do not bump it. |
| `createdAt` / `updatedAt` | RFC 3339 UTC | Server-owned. |

### Note

```json
{
  "id": "c7a2b1e04d5f42a8b9c3d1e0f5a6b7c8",
  "title": "How the summarizer behaved on long calls",
  "tags": ["meetings"],
  "body": "# Findings\n\nTruncates past ~40 minutes.",
  "promptId": "9f1c1c4d8f7b4a1e9d0b6a2c3e4f5a6b",
  "createdAt": "2026-02-11T17:05:00Z",
  "updatedAt": "2026-02-11T17:05:00Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Server-assigned, opaque. |
| `title` | string | Required, non-blank. |
| `tags` | string[] | Normalized as above. |
| `body` | string | Markdown. May be empty. |
| `promptId` | string | Optional. Must reference an existing prompt. Omitted from the response when unset. Send `""` to clear. |
| `createdAt` / `updatedAt` | RFC 3339 UTC | Server-owned. |

`id`, `version`, `createdAt`, and `updatedAt` are server-owned: values a client
sends for them are rejected as unknown fields, since request bodies are strict.

## Requests and responses

### Create

`POST /v1/prompts` — request body:

```json
{
  "name": "Summarize transcript",
  "tags": ["Meetings", "writing"],
  "body": "Summarize the following transcript:\n\n{{transcript}}",
  "variables": ["transcript"]
}
```

`POST /v1/notes` — request body:

```json
{
  "title": "How the summarizer behaved on long calls",
  "tags": ["meetings"],
  "body": "# Findings\n\nTruncates past ~40 minutes.",
  "promptId": "9f1c1c4d8f7b4a1e9d0b6a2c3e4f5a6b"
}
```

`201 Created` with the full entity as the body. Request bodies are strict: an
unknown field, trailing content after the object, or a body over 1 MiB is
rejected with `invalid_request`.

### Read, update, delete

`GET /v1/prompts/{id}` and `GET /v1/notes/{id}` return `200` with the entity, or
`404 not_found`.

`PUT` takes the same body shape as `POST` and **replaces** every client-owned
field — omitting `tags` clears them. It returns `200` with the updated entity.

`DELETE` returns `204 No Content` with an empty body, or `404 not_found`.
Deleting a prompt clears `promptId` on any note that referenced it.

### List, tag filter, search

`GET /v1/prompts` and `GET /v1/notes` accept:

| Parameter | Repeatable | Default | Meaning |
| --- | --- | --- | --- |
| `tag` | yes | — | Record must carry **every** listed tag (AND). Case-insensitive. |
| `q` | no | — | Case-insensitive substring match. Prompts: `name`, `body`, `variables`. Notes: `title`, `body`. |
| `limit` | no | `100` | Page size, `1`–`1000`. |
| `offset` | no | `0` | Records to skip. |

`tag` and `q` combine conjunctively. Results are sorted by `updatedAt`
descending, with `id` ascending as a deterministic tiebreaker.

```bash
curl -s -G http://127.0.0.1:8765/v1/prompts \
  -H "x-cue-note-api-key: $CUE_NOTE_API_KEY" \
  --data-urlencode 'q=transcript' \
  --data-urlencode 'tag=meetings' \
  --data-urlencode 'tag=writing' \
  --data-urlencode 'limit=20'
```

Response:

```json
{
  "items": [ { "id": "…", "name": "…", "tags": [], "body": "…", "variables": [], "version": 1, "createdAt": "…", "updatedAt": "…" } ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

`total` is the number of records matching the filters **before** pagination.

### Tags

`GET /v1/tags`:

```json
{
  "prompts": [ { "tag": "meetings", "count": 12 }, { "tag": "writing", "count": 4 } ],
  "notes": [ { "tag": "meetings", "count": 3 } ]
}
```

Sorted by descending count, then tag name.

### Health

`GET /healthz` → `200 {"status":"ok"}`.

## Error format

Every error — for every endpoint — uses one envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "must not be empty",
    "field": "name"
  }
}
```

`field` is present only for validation failures.

| HTTP | `code` | Cause |
| --- | --- | --- |
| `400` | `validation_failed` | A field violates a domain rule (missing `name`/`title`/`body`, dangling `promptId`, bad `limit`/`offset`). |
| `400` | `invalid_request` | Malformed JSON, unknown field, or trailing content. |
| `401` | `unauthorized` | Missing or wrong `x-cue-note-api-key`. |
| `404` | `not_found` | Unknown id or unknown route. |
| `405` | `method_not_allowed` | Method not supported; the response carries an `Allow` header. |
| `413` | `invalid_request` | Request body over the 1 MiB limit. |
| `500` | `internal_error` | Unexpected fault. Detail is logged locally, never returned. |

---

## Web UI

The UI is a separate binary and lives in [`web/`](web/): `web/static` holds the
static single-page app, embedded into `bin/cue-note-ui` via `go:embed`.

```bash
export CUE_NOTE_API_KEY="…"     # same key the API server uses
./bin/cue-note-ui               # http://127.0.0.1:8766
```

It serves the app and reverse-proxies `/api/*` to `<api-url>/v1/*`, attaching the
API key **server-side**, so the key is never delivered to the browser. The UI
supports browsing, text and tag search, creating, editing, re-tagging, linking a
note to a prompt, and deleting — for both entity types.

If the API is not running, UI requests return
`502 {"error":{"code":"upstream_unavailable","…"}}`.

## Project layout

```text
cmd/server        API server entry point (flags/env, store construction, http.Server)
cmd/webui         UI server + reverse proxy that injects the API key
internal/model    Prompt and Note domain types, normalization, validation (no net/http)
internal/store    Repository interface + atomic JSON-file implementation
internal/api      Router, auth middleware, handlers, error envelope
internal/config   Config-file + environment resolution
web/static        Static single-page UI assets (embedded)
```

## Storage and durability

The library is a single JSON file, loaded into memory at startup and rewritten on
every mutation via temp file → `fsync` → `rename`, so an interrupted write can
never leave a truncated file. All access is guarded by a `sync.RWMutex`. The
choice — and its scaling limits, plus why not SQLite or BoltDB — is argued in
[`docs/architecture.md`](docs/architecture.md). The store sits behind
`store.Repository`, so swapping engines touches one file plus wiring in
`cmd/server`.

## Security notes

- Default bind is loopback; a non-loopback `--addr` logs a warning at startup.
- Keys are compared with `crypto/subtle.ConstantTimeCompare`.
- Authentication is checked before any record lookup.
- The key is never logged, echoed, or sent to the browser.
- `data/`, `config.json`, and `.env` are git-ignored. Do not commit your library
  or your key.
