# Architecture

## System Overview

NexusCode has three runtime layers:

1. `packages/core` — agent runtime (LLM loop, modes, tool execution, permissions, MCP, skills, indexing).
2. `packages/vscode` — VS Code host + React webview UI.
3. `packages/cli` — terminal host + Ink TUI.

Both UI hosts call the same `runAgentLoop` in `core`, so behavior remains consistent across VS Code and CLI.

### Extension: Cline-style Controller
**Status:** active  
**Context:** Port Cline’s extension architecture (single Controller owning task/session state) into NexusCode.  
**Decision:** `packages/vscode` uses a **Controller** (`src/controller.ts`) that owns session, config, run state, indexer, MCP, and checkpoint. The **NexusProvider** only owns webview(s) and delegates all messages to `controller.handleWebviewMessage()`. State is pushed via `controller.postStateToWebview()` / `getStateToPostToWebview()`. Agent runs use `runAgentLoop` (local) or NexusCode server (sessions, pagination).  
**Rationale:** Clear separation of concerns, easier to add Cline-like features (task history, approvals, checkpoints) later.  
**Trade-offs:** Controller depends on VS Code API for `getCwd()` and config overrides; postMessage is passed in so Controller stays testable.

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
- When the tool-call budget is exceeded, the loop allows one extra iteration with tools disabled so the model can emit a final text-only answer (no silent truncation).
- Optional `config.agentLoop.toolCallBudget` and `config.agentLoop.maxIterations` override default per-mode limits when set.

## Data Flow

1. User message enters VS Code webview or CLI TUI.
2. **Without server:** host persists message into local session storage (JSONL). **With server:** message is sent to NexusCode server; session and messages live in server SQLite DB.
3. Core (in-process or on server) assembles prompt blocks (role/rules/skills/system/mentions/compaction).
4. Model streams text + tool calls.
5. Tools execute via host adapter with permissions.
6. Session/tool traces are saved (locally or on server) and surfaced back to UI. Extension and CLI can list/switch sessions when using the server; messages are loaded in pages to avoid OOM.
7. Index updates run in background and publish status events (in-process mode only; server mode does not run indexer in extension).

## External Dependencies

| Dependency | Why |
|---|---|
| Vercel AI SDK | Unified provider abstraction and tool-call streaming |
| Qdrant REST client | Semantic vector retrieval |
| SQLite (FTS5 via `better-sqlite3`) | Fast local keyword + symbol indexing |
| MCP SDK | External tool ecosystem integration |

## Version requirements

- **Node.js**: 20+ is required only for **packaging** the VS Code extension (`pnpm package:vscode`). The `vsce` CLI (via undici) needs the global `File` API available from Node 20. The rest of the build (`pnpm build`, core, webview, extension bundle) works on Node 18. The repo provides `.nvmrc` with `20` for nvm/fnm users.
- **pnpm**: used for workspace and scripts; no minimum version enforced in code.

## Known Constraints

- Auto-started Qdrant currently supports only local endpoints.
- Workspace multi-root uses the first folder as active project root in VS Code host.
- Type-checking across workspace expects built `core` artifacts because package exports are dist-first.
