# Architecture

## System Overview

NexusCode has three runtime layers:

1. **`packages/core`** — Agent runtime: LLM loop, modes, tool execution, permissions, MCP client, skills, indexing, session, compaction, checkpoints. No VS Code or CLI dependencies.
2. **`packages/vscode`** — VS Code host + React webview UI (settings, chat, sessions, agent presets).
3. **`packages/cli`** — Terminal host + TUI (OpenTUI/React). Same agent loop as the extension.

Both hosts call the same `runAgentLoop()` in core, so behavior is consistent across VS Code and CLI.

Optional **`packages/server`** stores sessions and messages in SQLite; extension and CLI can connect to it for shared sessions and pagination (no OOM on long chats).

### Extension: Controller pattern

The VS Code extension uses a single **Controller** (`packages/vscode/src/controller.ts`) that owns:

- Session and config
- Run state, indexer, MCP client, checkpoint
- Resolution of config from `.nexus/nexus.yaml` and VS Code settings

The **NexusProvider** owns the webview(s) and delegates all messages to `controller.handleWebviewMessage()`. State is pushed via `postStateToWebview()` / `getStateToPostToWebview()`. The agent runs either in-process (`runAgentLoop`) or against the NexusCode server (sessions, pagination).

---

## Key Decisions

### Unified config flow

Config is loaded from **`.nexus/nexus.yaml`** (project) and **`~/.nexus/nexus.yaml`** (global). Both VS Code and CLI persist updates into the project file with deep-merge of nested sections (`model`, `embeddings`, `indexing`, `vectorDb`, `tools`, `mcp`, etc.). Env vars override file config; VS Code settings (`nexuscode.*`) override when the extension runs.

### MCP server filtering (not tool filtering)

When the number of **MCP servers** exceeds `tools.classifyThreshold` (default 20) and `tools.classifyToolsEnabled` is true, an LLM classifier selects **which MCP servers** to use for the task. All tools from selected servers are included; custom tools (no `serverName__toolName` pattern) are always included. Skill filtering uses `skillClassifyThreshold` (default 20) and selects skills by task. Thresholds default to 20 in schema and UI.

### Vector index factory

`createCodebaseIndexer()` wires embeddings and vector store only when prerequisites are valid. If embeddings or Qdrant are missing, the indexer falls back to FTS-only. This avoids silent misconfiguration.

### Qdrant availability and auto-start

`ensureQdrantRunning()` performs a health check and can auto-start Qdrant (local binary, then Docker). Auto-start is local-only. If Qdrant is unavailable, vector search is disabled; FTS remains available.

### Mention resolution in prompts

Before each agent loop, the latest user message is parsed for `@file`, `@folder`, `@url`, `@problems`, `@git`. Resolved context is injected as a dedicated prompt block so the model gets deterministic, task-relevant context.

### Agent presets

Presets (model/vector/skills/MCP/rules) are stored in **`.nexus/agent-configs.json`**. The extension and CLI discover skill paths from local `SKILL.md` and `AGENTS.md`; MCP server names come from config. Applying a preset updates the active config via the host’s `saveConfig` and reconnects MCP / indexer as needed.

### Bundled MCP (context-mode)

The repo ships **`sources/claude-context-mode`** (Context Mode MCP). Config can reference `bundle: "context-mode"`; hosts resolve it to `node sources/claude-context-mode/start.mjs` with `CLAUDE_PROJECT_DIR` set to the agent cwd. See `resolveBundledMcpServers` in core.

---

## Invariants

- **Mode permissions** are enforced in core (not only in the UI). Blocked tools are never passed to the model.
- **Built-in tools** are always available per mode; filtering applies only to dynamic (MCP/custom) tools, and by **MCP server** count (not individual tool count) when classification is enabled.
- **MCP config**: enable/disable is per **server** (all tools of that server). The classifier selects servers, not individual tools.
- If vector prerequisites are invalid, the agent runs with **FTS-only** search.
- Host UI must not change `runAgentLoop` contracts (options, events, tool results).
- When the **tool-call budget** is exceeded, the loop allows one more iteration with tools disabled so the model can emit a final text-only answer.
- **`config.agentLoop.toolCallBudget`** and **`config.agentLoop.maxIterations`** override per-mode limits when set.
- **Models catalog**: CLI and extension use models.dev (`NEXUS_MODELS_PATH` / `NEXUS_MODELS_URL`) and live gateway model list where applicable; unavailable free IDs are filtered from pickers.

---

## Data flow

1. User message enters the VS Code webview or CLI TUI.
2. **Without server:** the host appends the message to the local session (JSONL). **With server:** the message is sent to the NexusCode server; sessions and messages live in the server SQLite DB.
3. Core (in-process or on server) builds prompt blocks (role, rules, skills, system, mentions, compaction).
4. The model streams text and tool calls.
5. Tools run via the host adapter with permission checks (rules, approval dialogs).
6. Session and tool traces are saved (local or server) and sent back to the UI. With the server, extension and CLI can list/switch sessions; messages are loaded in pages to avoid OOM.
7. Index updates run in the background and emit status events (in-process only; server mode does not run the indexer in the extension).

---

## Project layout

```
NexusCode/
├── packages/
│   ├── core/           ← Agent engine
│   │   ├── agent/      ← Loop, modes, classifier (tools/skills/MCP servers), prompts
│   │   ├── tools/      ← Built-in tool registry
│   │   ├── session/    ← JSONL storage, compaction
│   │   ├── indexer/    ← AST + FTS + Qdrant
│   │   ├── provider/   ← LLM providers + embeddings
│   │   ├── checkpoint/  ← Shadow git
│   │   ├── context/    ← @mentions, rules, condense
│   │   ├── skills/     ← Skill loader + FTS + classifier
│   │   ├── mcp/        ← MCP client, resolveBundledMcpServers
│   │   └── config/     ← Schema, load, merge
│   ├── vscode/         ← Extension + React webview (controller, settings, chat, presets)
│   ├── cli/            ← CLI host + TUI (slash commands, agent-config, sessions)
│   └── server/         ← Optional: SQLite sessions, streaming API
├── sources/
│   └── claude-context-mode/  ← Bundled MCP (context compression, FTS, batch_execute)
└── .nexus/             ← Project config (nexus.yaml, agent-configs.json, mcp-servers.json, rules, skills)
```

---

## External dependencies

| Dependency        | Purpose                                      |
|-------------------|----------------------------------------------|
| Vercel AI SDK     | Provider abstraction, tool-call streaming   |
| Qdrant REST client| Semantic vector retrieval                    |
| SQLite (FTS5, better-sqlite3) | Local keyword/symbol indexing        |
| MCP SDK           | External tool ecosystem                      |

---

## Version requirements

- **Node.js**: **20+** is required for packaging the VS Code extension (`pnpm package:vscode`) — `vsce` needs the global `File` API. The rest of the build (`pnpm build`, core, webview, extension bundle) runs on Node 18. `.nvmrc` is set to `20` for nvm/fnm.
- **pnpm**: used for the workspace and scripts; no minimum version enforced in code.

---

## Known constraints

- Auto-started Qdrant supports only local endpoints.
- In a multi-root VS Code workspace, the first folder is used as the active project root.
- Type-checking across the workspace expects built `core` artifacts (package exports are dist-first).
