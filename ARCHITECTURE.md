# Architecture

## System Overview

NexusCode has three runtime layers:

1. **`packages/core`** — Agent runtime: LLM loop, modes, tool execution, permissions, MCP client, skills, indexing, session, compaction, checkpoints. No VS Code or CLI dependencies.
2. **`packages/vscode`** — VS Code host + React webview UI (settings, chat, sessions, agent presets).
3. **`packages/cli`** — Terminal host + TUI (Ink/React, reference UI from claude-code). Same agent loop as the extension.

Both hosts call the same `runAgentLoop()` in core, so behavior is consistent across VS Code and CLI. The CLI uses a **Nexus query bridge** (`nexus-query.ts`): REPL and `--print` both call `queryNexus()` (no legacy Anthropic-only print path). The bridge runs `runAgentLoop()` with a `CliHost` that queues `AgentEvent`s and maps them to the REPL’s `Message` types (AssistantMessage, ProgressMessage, UserMessage) so the existing Ink UI renders tool progress and responses. Model, mode, index, session, checkpoints, and profile are passed via CLI options and bootstrap; task checkpoints and restore are available as `nexus task checkpoints` and `nexus task restore <id>`.
`bootstrapNexus` is an object-argument API; CLI must call it as `bootstrapNexus({ cwd, ... })` so host/tool paths resolve against the real project root.

#### Nexus CLI feature wiring

| Feature | Where | Notes |
|--------|--------|--------|
| **Mode** (agent / ask / plan / debug / review) | `--mode` + bootstrap | Passed to `runAgentLoop`; Logo shows `mode=…` when Nexus is active. |
| **Model** | `--model` + config / bootstrap | Override in bootstrap; Logo shows `model=…`. |
| **Vector index** | `--no-index` + config | `indexEnabled` in bootstrap; Logo shows `index=on|off`. |
| **Profile** | `--profile` + config | Merges profile into model config in bootstrap. |
| **Session** | `--session`, `--continue` | Session create/resume in bootstrap; `nexusSessionId` passed to REPL. |
| **Checkpoints** | `nexus task checkpoints` / `nexus task restore <id>` | REPL receives `nexusGetCheckpointList`, `nexusOnRestoreCheckpoint`. |
| **Progress display** | REPL + `utils/messages.tsx` | Matches reference: `reorderMessages`, `getInProgressToolUseIDs`, ProgressMessage with `content[0]` = tool_use, MessageResponse + loader semantics. Nexus `part_*` tool events render through generic core tool views to avoid legacy-shape crashes. |
| **Permissions** | CliHost `showApprovalDialog` | Approval can render inline in TUI (`NexusApprovalPanel`) and resolves through `tuiApprovalRef` in Nexus mode. |

Optional **`packages/server`** stores sessions and messages in SQLite; extension and CLI can connect to it for shared sessions and pagination (no OOM on long chats).

### Extension: Controller pattern

The VS Code extension uses a single **Controller** (`packages/vscode/src/controller.ts`) that owns:

- Session and config
- Run state, indexer, MCP client, checkpoint
- Resolution of config from `.nexus/nexus.yaml` and VS Code settings

The **NexusProvider** owns the webview(s) and delegates all messages to `controller.handleWebviewMessage()`. State is pushed via `postStateToWebview()` / `getStateToPostToWebview()`. The agent runs either in-process (`runAgentLoop`) or against the NexusCode server (sessions, pagination).

During streaming, the extension does not rely on `agentEvent` alone. The controller now also pushes incremental `stateUpdate` snapshots while visible assistant/tool/reasoning events arrive. In server mode it maintains a local shadow of the streamed assistant message so the webview keeps rendering even before the final paginated session snapshot is reloaded from the server.

The provider/webview bridge is readiness-gated. `onDidReceiveMessage` is attached before HTML is assigned, the webview marks itself ready via its first inbound message, and extension-to-webview payloads are only posted after that point. Outgoing messages are also cloned before `postMessage()` so non-cloneable values cannot silently break delivery. This avoids the startup race where early state/config snapshots are emitted before the webview has registered its message listeners.

The webview store treats `agentEvent` as the live source of truth during a run and merges later `stateUpdate` snapshots conservatively. If a snapshot arrives without the assistant tail that was already assembled from streamed events, the store preserves the richer local tail instead of dropping the in-flight assistant reply. This prevents the common race where a stale snapshot temporarily rewinds the visible chat back to only the user message.

The sessions sidebar uses the same anti-stale rule for optimistic deletes. When the user deletes a session, the row is hidden immediately and marked with a short-lived tombstone in the store. Any stale `sessionList` that still contains that session is filtered out until a fresh list confirms the deletion or the tombstone expires, so the row cannot flicker back into view during refresh.

File-edit preview/approval uses a two-stage flow in the extension: `tool_start` creates the visible file-edit block first, then `tool_approval_needed` raises the approval UI if write auto-approval is off. If the user denies the edit or responds with an alternative instruction, that pending file-edit block must disappear from the chat instead of remaining as an error artifact. Only approved edits may survive into the post-run "N Files" review panel.

Assistant rendering is timeline-first, not message-prefix-first. `thought` timers are bound to the active `(messageId, reasoningId)` pair, so a new reasoning block cannot reset an older Thought label in place. `explored` is only a compression layer for contiguous code-exploration sequences (reasoning + read/list/search tools) and is merged across adjacent assistant messages when no visible non-exploration content interrupts the sequence. While a sequence is still active it is rendered as `exploring`: collapsed by default, with a live preview window of the last four events, while the full accumulated sequence remains available on expand. When a visible text reply or a non-exploration tool arrives, that sequence is finalized into `explored` without losing its accumulated history or changing its local counters.

Todo state is delivered over its own `todo_updated` stream and rendered in dedicated todo panels. `TodoWrite` / `update_todo_list` must not appear as ordinary tool rows in either the webview or the CLI bridge, and they must not interrupt chronological chat grouping such as `exploring/explored`.

Subagent orchestration also has a split between execution and presentation. Multiple subagents must be launched through the `Parallel` tool with `SpawnAgent` entries, but the user-facing UI must not expose that orchestration layer directly. The webview and CLI should render subagent task cards/progress from `subagent_*` events and task descriptions, while hiding pure subagent `Parallel` wrappers and the deprecated `SpawnAgents` alias from normal chat/tool output. The declared tasks from a pure subagent `Parallel` input are the stable UI skeleton: if only one subagent has emitted live events so far, the other declared tasks must still remain visible as pending cards instead of disappearing until their first event arrives.

The extension controller must mirror `subagent_*` events into its server-stream shadow session before posting `stateUpdate`. Otherwise a live `agentEvent` can briefly show subagent progress and the next snapshot can erase it. `subagent_tool_start` input payloads are also part of the UI contract because the card subtitle derives from them (`Read(path)`, `List(path)`, `Grep(pattern)`, etc.), not just from the bare tool name.

Polling/control tools such as `SpawnAgentOutput` and `SpawnAgentStop` are orchestration-only and must not render as ordinary chat tool rows in either the webview or CLI. Their effect should be reflected indirectly through the subagent cards and the parent assistant summary, otherwise the chat timeline becomes noisy and duplicates the already-visible subagent state.

Live state merges also need adjacent duplicate protection. When a streamed assistant tail is later reintroduced by a snapshot with the same visible reasoning/tool/subagent content, the webview should collapse those adjacent duplicates instead of showing the same thought + subagent block twice in a row.

All diff previews opened from the extension must use read-only virtual documents, not dirty untitled editors created with `openTextDocument({ content })`. This applies to pending file approvals, accepted-but-unreviewed session edits, and checkpoint diffs. The user must be able to close those diff tabs without any save prompt, while still seeing proper red/green line diffs and opening the real workspace file by its actual path when needed.

The webview CSP must allow `${webview.cspSource}` in `connect-src`, not only localhost URLs. The bundled Vite runtime uses `fetch()` for module-preload chunk loading, so blocking the webview resource origin can leave the sidebar blank even though `index.js` exists and the extension host is healthy.

---

## Agent loop and mandatory end tools

The agent loop runs until one of:

- **Mandatory end tool** for the current mode is executed (turn ends).
- **finishReason === "stop"** and no tool calls in the last step (natural end of turn).
- Abort, fatal error, or tool/iteration budget exceeded.

**Mandatory end tool per mode** (`MANDATORY_END_TOOL` in `packages/core/src/agent/modes.ts`):

| Mode   | Mandatory end tool        | Meaning |
|--------|---------------------------|--------|
| agent  | *(none)*                  | Turn ends naturally when the model stops without tool calls. |
| plan   | `plan_exit`               | Turn ends when the plan is ready (plan written to `.nexus/plans/*.md`). |
| ask    | *(none)*                  | Turn ends naturally when the model stops without tool calls. |
| debug  | *(none)*                  | Turn ends naturally when the model stops without tool calls. |
| review | *(none)*                  | Turn ends naturally when the model stops without tool calls. |

Only modes with a configured mandatory tool are force-gated by that tool (currently `plan_exit` in plan mode). Other modes end naturally when the model returns a stop with no pending tool calls.

---

## Key Decisions

### Unified config flow

Config is loaded from **`.nexus/nexus.yaml`** (project) and **`~/.nexus/nexus.yaml`** (global). Both VS Code and CLI persist updates into the project file with deep-merge of nested sections (`model`, `embeddings`, `indexing`, `vectorDb`, `tools`, `mcp`, etc.). Env vars override file config; VS Code settings (`nexuscode.*`) override when the extension runs.

### MCP server filtering (not tool filtering)

When the number of **MCP servers** exceeds `tools.classifyThreshold` (default 20) and `tools.classifyToolsEnabled` is true, an LLM classifier selects **which MCP servers** to use for the task. All tools from selected servers are included; custom tools (no `serverName__toolName` pattern) are always included. Skill filtering uses `skillClassifyThreshold` (default 20) and selects skills by task. Thresholds default to 20 in schema and UI.

### Inline reasoning fallback for gateway streams

Core streaming supports provider-native `reasoning_delta` and fallback extraction from structured gateway fields (`reasoning`, `reasoning_details`, `thinking`, provider metadata), OpenAI Responses-style raw events (`response.reasoning.*`, `response.output_item.*`, `response.content_part.*`, final `response.completed` payloads), and `<think>...</think>` blocks in streamed text.

Raw Responses-style text is also emitted as live `text_delta` when the provider does not surface normal text parts. When a provider exposes reasoning only in done/final payloads, core now promotes that reasoning into the same Thought event pipeline instead of dropping it. For OpenAI Responses-compatible providers we also request `reasoning.summary: "auto"` in compatible provider options so summaries arrive in the stream when supported. Fallback extraction is disabled once native `reasoning_delta` is observed. This keeps extension/CLI thought blocks populated for providers that do not emit separate reasoning events.

For OpenAI-compatible gateways, reasoning provider options are tried as an ordered fallback chain. If a gateway answers with an unsupported-parameter style error, or with a generic HTTP 400 `Bad Request` while a reasoning option set is active, the client automatically retries with the next safer provider-options candidate before giving up. This is important for OpenRouter-style model routing where some models accept streamed reasoning but reject one or more optional reasoning fields.

OpenRouter-style endpoints are treated as their own provider path rather than as a generic OpenAI-compatible endpoint. This mirrors the reference implementations more closely: OpenRouter uses its own SDK/provider namespace, and explicit reasoning controls are only sent to model families that are known to accept them reliably through OpenRouter routing. For other OpenRouter models, Nexus falls back to plain streaming without forcing reasoning parameters, which avoids hard 400 failures on models such as many Qwen/DeepSeek/GLM/Kimi variants.

For router/free-tier models where tool support is inconsistent, runtime fallback is also defensive: if an OpenRouter-style request fails with a tool-related 400, or a bare `400 Bad Request` on a `:free` model, the client retries once without tool definitions instead of surfacing an immediate hard failure. This mirrors the capability-gating intent used by the reference projects, even when local model metadata is incomplete.

### Vector index factory

`createCodebaseIndexer()` wires embeddings and vector store only when prerequisites are valid. If embeddings or Qdrant are missing, the indexer falls back to FTS-only. This avoids silent misconfiguration.

### Qdrant availability and auto-start

`ensureQdrantRunning()` performs a health check and can auto-start Qdrant (local binary, then Docker). Auto-start is local-only. If Qdrant is unavailable, vector search is disabled; FTS remains available.

### Mention resolution in prompts

Before each agent loop, the latest user message is parsed for `@file`, `@folder`, `@url`, `@problems`, `@git`. Resolved context is injected as a dedicated prompt block so the model gets deterministic, task-relevant context.

### Agent presets

Presets (model/vector/skills/MCP/rules) are stored in **`.nexus/agent-configs.json`**. The extension and CLI discover skill paths from local `SKILL.md` and `AGENTS.md`; MCP server names come from config. Applying a preset updates the active config via the host’s `saveConfig` and reconnects MCP / indexer as needed.

### Bundled MCP (context-mode)

The repo ships **`sources/claude-context-mode`** (Context Mode MCP). Config can reference `bundle: "context-mode"`; hosts resolve it via **`resolveBundledMcpServers`** in core (`packages/core/src/mcp/resolve-bundled.ts`) to a full server config (command/args/env). `CLAUDE_PROJECT_DIR` is set to the agent cwd when running from the NexusCode repo.

---

## Invariants

- **Mode permissions** are enforced in core (not only in the UI). Blocked tools are never passed to the model.
- **Built-in tools** are always available per mode; filtering applies only to dynamic (MCP/custom) tools, and by **MCP server** count (not individual tool count) when classification is enabled.
- **MCP config**: enable/disable is per **server** (all tools of that server). The classifier selects servers, not individual tools.
- If vector prerequisites are invalid, the agent runs with **FTS-only** search.
- Host UI must not change `runAgentLoop` contracts (options, events, tool results).
- `write_to_file` and `replace_in_file` skip explicit approval dialogs in file-edit flow when `autoApproveWrite` (or mode auto-approve `write`) is enabled; otherwise they emit `tool_approval_needed` and wait for host approval.
- When the **tool-call budget** is exceeded, the loop allows one more iteration with tools disabled so the model can emit a final text-only answer.
- **`config.agentLoop.toolCallBudget`** and **`config.agentLoop.maxIterations`** override per-mode limits when set.
- **Models catalog**: CLI and extension use models.dev (`NEXUS_MODELS_PATH` / `NEXUS_MODELS_URL`) and live gateway model list where applicable; unavailable free IDs are filtered from pickers.
- **End of turn**: plan mode is force-gated by **PlanExit**; agent/ask/debug/review end naturally when the model stops without tool calls.

---

## Data flow

1. User message enters the VS Code webview or CLI TUI.
2. **Without server:** the host appends the message to the local session (JSONL). **With server:** the message is sent to the NexusCode server; sessions and messages live in the server SQLite DB.
3. Core (in-process or on server) builds prompt blocks (role, rules, skills, system, mentions, compaction).
4. The model streams text and tool calls.
5. Tools run via the host adapter with permission checks (rules, approval dialogs).
6. In **plan** mode, **PlanExit** ends the turn after a plan file is written to `.nexus/plans/`. In other modes, turns end naturally when the model stops without tool calls.
7. Session and tool traces are saved (local or server) and sent back to the UI. With the server, extension and CLI can list/switch sessions; messages are loaded in pages to avoid OOM.
8. Index updates run in the background and emit status events (in-process only; server mode does not run the indexer in the extension).

---

## Project layout

```
NexusCode/
├── packages/
│   ├── core/              ← Agent engine
│   │   ├── agent/         ← Loop, modes, classifier (MCP servers + skills), prompts
│   │   ├── tools/         ← Built-in tool registry + built-in implementations
│   │   ├── session/       ← JSONL storage, compaction
│   │   ├── indexer/       ← AST + FTS + Qdrant
│   │   ├── provider/      ← LLM providers + embeddings
│   │   ├── checkpoint/    ← Shadow git
│   │   ├── context/       ← @mentions, rules, condense
│   │   ├── skills/        ← Skill loader + FTS + classifier
│   │   ├── mcp/           ← MCP client, resolveBundledMcpServers
│   │   ├── config/        ← Schema (NexusConfigSchema), load, merge
│   │   └── review/        ← Review helpers (if any)
│   ├── vscode/            ← Extension + React webview (controller, settings, chat, presets)
│   ├── cli/               ← CLI host + TUI (slash commands, agent-config, sessions)
│   └── server/            ← Optional: SQLite sessions, streaming API
├── sources/
│   └── claude-context-mode/  ← Bundled MCP (context compression, FTS, batch_execute)
└── .nexus/                ← Project config (nexus.yaml, agent-configs.json, rules, skills)
```

---

## Built-in tools (by group)

- **always:** `AskFollowupQuestion`, `TodoWrite`, `Parallel`
- **read:** `Read`, `List`, `ListCodeDefinitions`, `ReadLints`
- **write:** `Write`, `Edit`
- **execute:** `Bash`
- **search:** `Grep`, `CodebaseSearch`, `WebFetch`, `WebSearch`, `Glob`
- **skills:** `Skill`
- **agents:** `SpawnAgent`, `SpawnAgentOutput`, `SpawnAgentStop`
- **context:** `Condense`
- **plan_exit:** `PlanExit` (plan mode only)

Mode-specific blocks: **plan** blocks `Bash`; **ask** blocks `Write`, `Edit`, `Bash`, `PlanExit`; **review** blocks `Write`, `Edit`, `PlanExit`; **agent/debug** block `PlanExit`.

---

## External dependencies

| Dependency         | Purpose                                      |
|--------------------|----------------------------------------------|
| Vercel AI SDK      | Provider abstraction, tool-call streaming   |
| Qdrant REST client | Semantic vector retrieval                    |
| MCP SDK            | External tool ecosystem                      |

---

## Version requirements

- **Node.js**: **20+** is required for packaging the VS Code extension (`pnpm package:vscode`) — `vsce` needs the global `File` API. The rest of the build (`pnpm build`, core, webview, extension bundle) runs on Node 18+. `.nvmrc` is set to `20` for nvm/fnm.
- **pnpm**: used for the workspace and scripts; no minimum version enforced in code.

---

## Tool schemas and provider quirks

Built-in tool schemas are **strict** (Zod `.strict()` or explicit required/optional). Runtime List execution uses a single **`path`** (string).

Some providers or gateways (e.g. Minimax, Kilo gateway) may expose a list-dir–style tool name (`list_dir`, `ListDirectory`) or return malformed `paths[]` payloads. NexusCode no longer advertises a gateway-specific `paths[]` schema for `List`; the public tool contract is always a single strict `path` string. Compatibility is handled only on receive/execute:

1. The advertised `List` schema is always `path`-based.
2. When a provider still returns `paths[]`, we normalize it immediately into `path` as soon as the tool call is received.
3. We normalize again before Zod parse during execution, so provider quirks cannot leak into built-in tool contracts.

So the `paths[0]`-style error is treated as a provider compatibility bug, not as part of the intended NexusCode tool schema.

Additionally, List ignores `.nexus` only for top-level discovery; when user explicitly lists `.nexus` (or its children), it is not filtered out.

Provider request shaping now follows the Roo/Kilo pattern more closely for router-style backends:

- `openrouter.ai` and Kilo-hosted router endpoints go through dedicated OpenRouter-compatible routing instead of the generic OpenAI-compatible path.
- Kilo free/router defaults use `https://api.kilo.ai/api/openrouter` as the base route. Legacy saved configs using `/api/gateway` are normalized onto `/api/openrouter` at runtime.
- Streaming no longer retries by cycling through synthetic `providerOptions` variants or by silently stripping tools. Instead, the request is shaped correctly up front with provider-specific defaults.
- Router/openrouter requests get Kilo-style base options (`usage.include`) plus model-family sampling defaults (`temperature`, `topP`, `topK`) for families such as Qwen, Gemini, MiniMax, and Kimi.
- Explicit reasoning controls are only attached where the routed provider/model family matches the patterns used by the reference implementations; unsupported OpenRouter families do not receive forced reasoning params.

---

## Known constraints

- Auto-started Qdrant supports only local endpoints.
- In a multi-root VS Code workspace, the first folder is used as the active project root.
- Type-checking across the workspace expects built `core` artifacts (package exports are dist-first).
