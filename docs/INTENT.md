# Project Intent

## Overview
Lightweight Go service that stores and manages a personal library of reusable **Prompts** and free-form **Notes** on the local machine. It runs as a long-lived local process, exposes an HTTP API for other applications (such as `loomwork`) to read and write that library, and ships a separate web UI for browsing and editing it by hand.

## Why
Prompt text and working notes currently live scattered across editor scratch files, chat histories, and ad-hoc directories. There is no single place to look up "the prompt I use for X", no way for a second application to reuse it, and no way to tag or search across them. Cue Note is that single place — local, private, and API-first.

## Entities
Two entity types are stored, and only two:

- **Prompt** — a reusable, versioned block of template text. Carries a human name, tags, the body/template text, and an optional set of declared variables/placeholders that a consumer is expected to fill in before use. A prompt's `version` increments on every substantive edit so a consumer can detect that the text it cached is stale.
- **Note** — a free-form Markdown document. Carries a title, tags, the Markdown body, and an optional link to the prompt it relates to (for example, notes on how a prompt behaved in practice).

Both entities are identified by an opaque string id and carry creation and update timestamps.

## Required Interfaces
- **HTTP API** — the authoritative interface. Structured JSON in, structured JSON out, one documented error envelope. Full CRUD for both entity types, plus list, filter-by-tag, and substring (full-text-ish) search. This contract is what `loomwork` codes against, so it is documented in the README and treated as a published surface.
- **Web UI** — a separate binary serving a small static single-page app from `web/`. Browse, create, edit, tag, and delete prompts and notes. It is a client of the same HTTP API and holds no privileged knowledge about storage.

## Security Posture
Single-user, single-machine. The service binds `127.0.0.1` by default and requires a static API key on every API request, presented in the `x-cue-note-api-key` header. The key is sourced from the environment (or a config file that is git-ignored) and is never committed. Exposure beyond loopback is possible but must be an explicit, deliberate operator action.

## Non-Goals (this version)
Multi-user accounts and per-user authorization, remote/hosted deployment, synchronization or replication between machines, rich-text editing, prompt execution against any model provider, and full-text indexing beyond case-insensitive substring matching.
