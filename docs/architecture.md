# System Architecture Specification

## 1. Process Topology
Two independent binaries, one shared HTTP contract:

```text
  [ browser ]                       [ loomwork / any local app ]
       │  HTML + fetch(/api/...)              │  HTTP + x-cue-note-api-key
       ▼                                      │
  [ cmd/webui ]  ── proxy, injects API key ──►│
                                              ▼
                                       [ cmd/server ]
                                              │
                                     internal/api (routing, auth, JSON)
                                              │
                                     internal/store (Repository)
                                              │
                                      single local JSON data file
```

The UI never holds the API key in the browser: `cmd/webui` serves the static app
from `web/static` and proxies `/api/*` to the API server, attaching the key from
its own environment.

## 2. Request Lifecycle
```text
  [ Phase 1: Boundary ]
           │
           ▼ method + path routing -> API-key check -> body size limit -> JSON decode
  [ Phase 2: Domain ]
           │
           ▼ validate required fields -> normalize tags -> assign server-owned fields
  [ Phase 3: Persistence ]
           │
           ▼ RWMutex write lock -> mutate in-memory index -> atomic snapshot to disk
  [ Phase 4: Response ]
           │
           ▼ structured JSON payload, or single error envelope with stable code
```

## 3. Package Responsibilities
```text
cmd/server        API server entry point: flags/env, store construction, http.Server
cmd/webui         Static UI server + reverse proxy that injects the API key
internal/model    Prompt and Note domain types, tag normalization, validation (no net/http)
internal/store    Repository interface + JSON file-backed implementation
internal/api      Router, auth middleware, handlers, JSON encoding, error envelope
web/static        Static single-page UI assets (embedded into the webui binary)
```

## 4. Persistence Choice
**Decision: a single-file JSON store guarded by `sync.RWMutex`, written atomically.**

Considered alternatives:

| Option | Verdict |
| --- | --- |
| `modernc.org/sqlite` (pure-Go SQLite) | Rejected for this version. It satisfies zero-CGO, but it is a very large transpiled dependency (tens of thousands of generated lines) for a dataset that is a personal prompt/notes library — typically hundreds of records, comfortably resident in memory. It also pulls SQL schema-migration concerns into a first version whose schema is still moving. |
| BoltDB / bbolt | Rejected. Pure Go and crash-safe, but a key/value B+tree gives no query help for the tag-AND and substring searches we need, so filtering would still be a full scan in application code — the same work the JSON store does, with an extra dependency and an opaque on-disk format. |
| **Single JSON file (chosen)** | Zero third-party dependencies, honoring the constitution's standard-library-priority rule. The whole dataset is loaded into an in-memory map on start, so reads are pure memory and filtering is a linear scan over a small collection. The on-disk format is human-readable and diffable, which matters for a local-first tool the owner may want to inspect, back up, or hand-edit. |

Durability is provided by writing the full snapshot to a temp file in the target
directory, `fsync`-ing it, then `rename`-ing over the data file — an atomic
replace on POSIX. A crash therefore leaves either the previous or the new
complete file, never a truncated one.

Known trade-off: write cost is O(size of dataset) per mutation, so the design
stops scaling somewhere in the low tens of thousands of records. That is
deliberate. The store sits behind `store.Repository`, so replacing it with a
`modernc.org/sqlite` implementation is a new file plus a wiring change in
`cmd/server` — no handler, model, or UI change. The interface is the insurance
policy that makes the simple choice safe.

## 5. Concurrency Model
A single `sync.RWMutex` guards both the in-memory index and the file. List and
get take the read lock and may proceed in parallel; create, update, and delete
take the write lock for the whole mutate-then-persist sequence, which is what
makes a mutation and its durability atomic together, and makes concurrent
updates to one record resolve to one of the requested states rather than a mix.
If a disk write fails, the in-memory state is rolled back so memory and disk
cannot diverge.

## 6. Security Boundaries
* Default bind is `127.0.0.1`; a non-loopback address must be typed out by the operator.
* All `/v1/` routes require `x-cue-note-api-key`; the key is compared with `subtle.ConstantTimeCompare`.
* Auth is checked before routing to a record, so an unauthenticated caller cannot distinguish an existing id from a missing one.
* `/healthz` is the only unauthenticated route and returns liveness only.
* The key is sourced from `CUE_NOTE_API_KEY` or a git-ignored config file. Nothing secret is committed, and the key is never logged or echoed in a response.

## 7. Failure Semantics
Errors are values, wrapped with context, and mapped to codes exactly once at the
HTTP boundary: `store.ErrNotFound` → `not_found`, `model.ValidationError` →
`validation_failed` (with `field`), malformed JSON → `invalid_request`, and
anything unexpected → `internal_error` with the detail logged locally rather
than returned to the caller.
