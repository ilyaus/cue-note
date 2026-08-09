# Cue Note Constitution

## Core Principles

## 1. Core Purpose
This project delivers a local-first, secure storage and management service for two entity types — Prompts and Notes. It exposes a structured JSON HTTP API that other local applications (notably `loomwork`) consume programmatically, and ships a separate, thin web UI for humans. Data never leaves the machine it is stored on; there is no cloud dependency, no telemetry, and no background network egress.

## 2. Technical Commandments
* **Language Target:** Pure Go (Go 1.21+).
* **Zero Native C Dependencies:** External packages must be pure Go. No CGO or native binary dependencies allowed, ensuring the service builds and runs identically on any developer machine as a single static binary.
* **Standard Library Priority:** Leverage Go standard library packages (`net/http`, `encoding/json`, `context`, `sync`, `embed`) wherever possible. A third-party dependency is admissible only when the standard library cannot express the requirement.
* **Local-Only By Default:** The server binds to a loopback address unless explicitly overridden. Authentication is mandatory: every API request carries a static API key supplied through environment or config. Secrets are never committed to the repository.
* **Error Handling Paradigm:** No `panic()` recovery patterns inside business-critical storage or request-handling flows. Every error must be wrapped with diagnostic context and bubbled up to the HTTP boundary, which converts it into a single, structured JSON error envelope.
* **Concurrency & Safety:** All shared in-memory state — including the store index and its file-backed snapshots — must be protected by `sync.RWMutex` to guarantee absolute thread safety under concurrent HTTP handling.
* **Durability:** Every mutation must be persisted atomically (write temp file, `fsync`, rename) so that a crash mid-write can never leave a partially written data file.

## 3. Code Generation & Architecture Standards
* **Test-Driven Foundation:** Every repository operation, filter rule, and HTTP handler must be accompanied by robust native Go unit tests (`*_test.go`) alongside the logic.
* **Decoupled Interfaces:** The domain layer (`internal/model`) knows nothing about `net/http` or persistence. The persistence layer sits behind a repository interface so the storage engine can be replaced without touching handlers. The HTTP layer interacts purely with structured domain objects.
* **Composition Root at the Edge:** Wiring — flags, environment, addresses, store paths — belongs exclusively in `cmd/`. Packages under `internal/` accept their dependencies explicitly.
* **UI Is a Client, Not a Layer:** The web UI is a separate binary and a separate directory (`web/`). It consumes the same public HTTP API contract that `loomwork` does, guaranteeing the contract is sufficient for third-party consumers.
