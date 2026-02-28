# Architecture

## System Overview

NexusCode has three runtime layers:

1. `packages/core` — agent runtime (LLM loop, modes, tool execution, permissions, MCP, skills, indexing).
2. `packages/vscode` — VS Code host + React webview UI.
3. `packages/cli` — terminal host + Ink TUI.

Both UI hosts call the same `runAgentLoop` in `core`, so behavior remains consistent across VS Code and CLI.

## Key Decisions

### Unified Config Flow Across Hosts
**Status:** active  
**Context:** VS Code and CLI exposed different slices of config and some settings were UI-only.  
**Decision:** both hosts now persist updates into `.nexus/nexus.yaml` and deep-merge nested sections (`model`, `maxMode`, `embeddings`, `indexing`, `vectorDb`, `tools`).  
**Rationale:** one source of truth for local/project behavior, with predictable cross-host parity.  
**Trade-offs:** host-specific overrides (e.g. VS Code settings) can still mask file config at runtime.

### Vector Index Wiring Through Factory
**Status:** active  
**Context:** vector indexing options existed, but indexer construction in hosts did not pass embeddings/vector dependencies.  
**Decision:** introduced `createCodebaseIndexer()` factory that wires embeddings + vector store only when prerequisites are valid.  
**Rationale:** prevents silent misconfiguration and keeps host code minimal.  
**Trade-offs:** additional async initialization path before indexing starts.

### Qdrant Availability Guard + Auto-Start
**Status:** active  
**Context:** semantic search requires reachable Qdrant; manual startup caused frequent failure states.  
**Decision:** introduced `ensureQdrantRunning()` with health check + optional auto-start strategy (local `qdrant` binary first, then Docker).  
**Rationale:** out-of-the-box vector setup while preserving explicit fallback to FTS-only indexing if unavailable.  
**Trade-offs:** auto-start is local-only (`localhost`) and depends on installed runtime (binary or Docker).

### Mention Resolution as First-Class Prompt Context
**Status:** active  
**Context:** `@mentions` parser existed but was not integrated into the runtime prompt assembly.  
**Decision:** before each task loop, latest user message is parsed for mentions and resolved context is injected as a dedicated prompt block.  
**Rationale:** deterministic handling of `@file`, `@folder`, `@url`, `@problems`, `@git`.  
**Trade-offs:** slightly larger system prompt for mention-heavy requests.

## Invariants

- Mode permissions are enforced in `core` (not only in UI).
- Built-in tool set remains always available per mode; filtering applies to dynamic/MCP/custom sets by threshold.
- If vector prerequisites are invalid, agent must remain functional with FTS-only search.
- Host UI changes must not change `runAgentLoop` contracts.

## Data Flow

1. User message enters VS Code webview or CLI TUI.
2. Host persists message into session storage.
3. Core assembles prompt blocks (role/rules/skills/system/mentions/compaction).
4. Model streams text + tool calls.
5. Tools execute via host adapter with permissions.
6. Session/tool traces are saved and surfaced back to UI.
7. Index updates run in background and publish status events.

## External Dependencies

| Dependency | Why |
|---|---|
| Vercel AI SDK | Unified provider abstraction and tool-call streaming |
| Qdrant REST client | Semantic vector retrieval |
| SQLite (FTS5 via `better-sqlite3`) | Fast local keyword + symbol indexing |
| MCP SDK | External tool ecosystem integration |

## Known Constraints

- Auto-started Qdrant currently supports only local endpoints.
- Workspace multi-root uses the first folder as active project root in VS Code host.
- Type-checking across workspace expects built `core` artifacts because package exports are dist-first.
