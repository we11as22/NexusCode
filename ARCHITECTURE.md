# Architecture

## System Overview

NexusCode has three runtime layers:

1. **`packages/core`** — Agent runtime: LLM loop, modes, tool execution, permissions, MCP client, skills, indexing, session, compaction, checkpoints. No VS Code or CLI dependencies.
2. **`packages/vscode`** — VS Code host + React webview UI (settings, chat, sessions, agent presets).
3. **`packages/cli`** — Terminal host + TUI (Ink/React, reference UI from claude-code). Same agent loop as the extension.

Both hosts call the same `runAgentLoop()` in core, so behavior is consistent across VS Code and CLI. The CLI uses a **Nexus query bridge** (`nexus-query.ts`): REPL and `--print` both call `queryNexus()` (no legacy Anthropic-only print path). The bridge runs `runAgentLoop()` with a `CliHost` that queues `AgentEvent`s and maps them to the REPL’s `Message` types (AssistantMessage, ProgressMessage, UserMessage) so the existing Ink UI renders tool progress and responses. Model, mode, index, session, checkpoints, and profile are passed via CLI options and bootstrap; task checkpoints and restore are available as `nexus task checkpoints` and `nexus task restore <id>`.

**Tool-call validation is two-phase:** `BaseLLMClient` passes each tool’s **real** Zod schema to the Vercel AI SDK so the provider JSON Schema lists correct types (booleans, arrays, etc.). The SDK may still emit `AI_InvalidToolArgumentsError` on hard mismatches; `runAgentLoop` then treats that as **recoverable** (user message + continue) via `tool-sdk-recovery.ts`. Before strict parse in `executeToolCall`, `normalizeToolInputForParse` fixes common drift: `paths`→`path` (List); string/JSON list→`string[]` for **ReadLints**, **CodebaseSearch** `target_directories`, **List/Grep** `ignore` (ignore is never comma-split — commas may be inside a glob); **Glob** `path` placeholders (`"undefined"`, `"null"`); **Bash** `timeout`, **WebFetch** `max_length`, **WebSearch** `max_results`, **Exa** numeric fields as strings; **Grep** `output_mode` / **CodebaseSearch** `kind` case and light aliases; **TodoWrite** `todos` as JSON string; string CSV / loose JSON→`options[]` for AskFollowupQuestion; **`"False"`/`"true"`→boolean** on known boolean keys. **Parallel** already re-runs this normalizer per nested tool. Remaining failures return `formatToolValidationError` (with extra tips for boolean/number/array mismatches) so the model can retry.
`bootstrapNexus` is an object-argument API; CLI must call it as `bootstrapNexus({ cwd, ... })` so host/tool paths resolve against the real project root.

#### Nexus CLI feature wiring

| Feature | Where | Notes |
|--------|--------|--------|
| **Mode** (agent / ask / plan / debug / review) | `--mode` + bootstrap | Passed to `runAgentLoop`; Logo shows `mode=…` when Nexus is active. |
| **Model** | `--model` + config / bootstrap | Override in bootstrap; Logo shows `model=…`. |
| **Vector index** | `--no-index` + config | `indexEnabled` in bootstrap; Logo shows `index=on|off`. |
| **Profile** | `--profile` + config | Merges profile into model config in bootstrap. |
| **Session** | `--session`, `--continue` | Session create/resume in bootstrap; `nexusSessionId` passed to REPL. |
| **Checkpoints** | `nexus task checkpoints` / `nexus task restore <id>` | REPL: `/undo` opens an Ink menu (last turn vs numbered checkpoints; Tab toggles workspace-only vs chat+workspace). Also `nexusGetCheckpointList` / `applyCheckpointRestore` for in-process restore without exiting. |
| **Progress display** | REPL + `utils/messages.tsx` | Matches reference: `reorderMessages`, `getInProgressToolUseIDs`, ProgressMessage with `content[0]` = tool_use, MessageResponse + loader semantics. Nexus `part_*` tool events render through generic core tool views to avoid legacy-shape crashes. |
| **Permissions** | CliHost `showApprovalDialog` | Approval can render inline in TUI (`NexusApprovalPanel`) and resolves through `tuiApprovalRef` in Nexus mode. |

**CLI explore block (`Exploring` / `Explored`):** `reorderMessages` runs on `timelineSourceMessages(messages)` — **unsplit** assistant/user rows (per-block `normalizeMessages` would inject text-only rows between tools and split one wave into many). `buildChatTimeline` merges Read/Grep/List/… and **glue** rows (`TodoWrite`, `update_todo_list`) plus their `tool_result`s into a single wave; anything else (Bash, Write, real assistant text, non–pure-explore Parallel) ends the wave. Explore JSX is **always transient** (never Ink `Static`) so loaders and ctrl+o keep updating. `NexusExploringBlock` uses the same **marginTop + 2-col bullet** layout as assistant text/tool rows so Exploring/Explored is not flush against the preceding user or tool line. The **✓ Explored** header uses `waveFinalized`: it stays **● Exploring** while the transcript tail is still “only this wave” (e.g. model thinking) or a **non-explore** tool is **unresolved**; glue/todo rows do not finalize the wave. If a wave starts right after a **SpawnAgent** / subagent-only **Parallel** progress row (skipping `tool_result`-only user rows), it is tagged **`subagentChild`**: the REPL **skips** `NexusExploringBlock` for that slice so sub-agent tools are not shown twice — only the parent `SpawnAgent` row (`AssistantToolUseMessage`) shows progress (last tool line while running, indented `⎿ Done` when finished). Host-only waves use `host_explore` with read/search counts.

**CLI subagent rows:** Parent `SpawnAgent*` and pure-subagent `Parallel` **must** emit `ProgressMessage` + `tool_result` in `queryNexus` (only `SpawnAgentOutput` / `SpawnAgentStop` are hidden from the timeline). Otherwise `onSubagentEvent` updates `subagentsByPartId` with no matching `part_*` row. `lastSpawnAgentPartId` is not cleared on parent `tool_end` so late `subagent_*` events still associate when `parentPartId` is absent. For **multiple** parallel subagents on one parent row, `AssistantToolUseMessage` keeps **Running N agents…** (N = total spawned) until all finish—never **Running 1 agent…** after the first completes. Each agent keeps **Mode(task)** plus **⎿** last tool or **Done** so finished agents stay visible; when all complete, **● N agents finished** (success-colored bullet) with the same per-agent tree. A **single** finished sub-agent uses the same two-line shape (task + **⎿ Done**), not only a bare Done under the spawn row. Sub-agent UI uses the same **2-col gutter** (`minWidth={2}`) as **Exploring** so single and parallel blocks align with the tool bullet column instead of extra `marginLeft`. The REPL **Spinner** (esc to interrupt) stays visible for the whole in-flight Nexus run, including parallel sub-agents. **`packages/core`:** after `SpawnAgent` / `SpawnAgentsParallel` completes, completed **Write** / **Edit** parts from the sub-agent ephemeral session are **copied** onto the parent assistant message that owns the spawn `part_*` id (flag `mergedFromSubagent`) so session-diff still counts them while `sessionMessageToAssistantContent` **skips** them—no extra `● Write` row under the parent spawn. The tool return text is the sub-agent’s output only (no `Sub-agent … completed:` wrapper). **`Parallel`** with several `SpawnAgent` calls sets `ToolContext.skipSubagentDuplicateCheck` for the batch so the shared `recentSpawnTasks` duplicate guard does not drop the second concurrent spawn (which would otherwise skip merge and leave edits out of session diff). `SpawnAgentsParallel` passes `skipDuplicateCheck` on spawn directly.

**Nexus CLI chat order:** In Nexus mode the message list is rendered **in timeline order** (header in `Static`, then every row in sequence). The legacy split “all static messages first, then all transient” would pin `Exploring`/`Explored` blocks **below** final assistant text because explore is always transient. **ctrl+o** expands tool details on the parent spawn row; sub-agent explore is not duplicated as a second timeline block. **Escape** cancels the in-flight Nexus run via `AbortController` mirrored in a ref (`useCancelRequest` + `assignAbortController`) so cancel works even when Ink’s handler would otherwise see a stale signal; cancel is allowed while **`isLoading` or any sub-agent is still running**, and `onCancel` clears `subagentsByPartId` after abort.


Optional **`packages/server`** runs the agent and persists sessions/messages via the **same JSONL store** as in-process hosts (`@nexuscode/core` session storage under `~/.nexus/sessions/…`, keyed by **canonical project root**). Extension and CLI connect over HTTP for shared runs, pagination, and long chats without loading full history into memory.

**Context usage bar (CLI + VS Code):** The “used / limit” indicator is driven by a single formula in `packages/core/src/context/context-usage.ts`: **active session messages** (same window as the next request; tool text is whatever is stored after execution-time truncation / compaction, with no extra per-request cap in `buildMessagesFromSession`), plus **last built system prompt** tokens, plus a **heuristic for tool definitions** (name + description + fixed schema overhead per tool). The agent loop calls `emitContextUsage` after each system build and records `contextUsage` on the session (persisted in JSONL meta). The snapshot is **cleared only on a new user message**, not on every assistant/tool mutation, so idle UIs can still show the last full estimate after a run. When no snapshot exists yet, hosts show **session + tools** (and optional MCP server count fudge), not system — until the next loop iteration emits.

**Terminal output (Kilo-style):** Bash run logs and large tool output are written to the **global data dir** (`~/.nexus/data` or `$NEXUS_DATA_HOME`), not in the project. So `run_*.log` and `tool-output/*.out` never appear in the project tree, in git status, or in the extension/CLI "N Files" / session-edits list (those lists only include paths from Write/Edit tool results). The agent can read these files via `Read("~/.nexus/data/run/run_<id>.log")` or `Read("~/.nexus/data/tool-output/...")`; the Read tool expands `~` to the home directory, and `autoApproveReadPatterns` includes `**/.nexus/data/run/**` and `**/.nexus/data/tool-output/**` so no approval is required.

#### Connection modes and server stream contract

| Mode | Who runs the agent | Where sessions live | How client connects |
|------|--------------------|----------------------|----------------------|
| **Extension in-process** | `runAgentLoop()` in extension process, `VsCodeHost` | JSONL under `~/.nexus/sessions/<project-hash>/` (see `session/storage.ts`) | N/A |
| **Extension + server** | Server process (`runSession` → `runAgentLoop` with `ServerHost`) | Same JSONL as local (per canonical `directory`) | Extension uses `nexuscode.serverUrl`; `NexusServerClient` (core) for list/get messages and **stream** |
| **CLI in-process** | `runAgentLoop()` in CLI process, `CliHost` | Local JSONL | N/A |
| **CLI + server** | Server process | Same JSONL as local (per canonical `directory`) | CLI `--server <url>` (or `NEXUS_SERVER_URL`); `queryNexus` reuses the bootstrap session id with `streamMessage` (no per-message session fork); REPL consumes identically |

Server stream (POST `/session/:id/message`) returns **NDJSON** (`Content-Type: application/x-ndjson`, chunked): one JSON object per line. Each object is an `AgentEvent` or a **heartbeat** line `{"type":"heartbeat","ts":<ms>}` sent every 10s so proxies and clients can detect dead connections. Clients skip heartbeat lines; if no event (including heartbeat) is received for `DEFAULT_HEARTBEAT_TIMEOUT_MS` (20s), the client treats the stream as dead and surfaces an error (extension: connection state "error" + retry by sending again). Malformed lines yield an `AgentEvent` `{ type: "error", error: "Invalid stream line: ..." }`. Abort is via client closing the request (`AbortController.signal`); the server forwards `c.req.raw.signal` to `runSession` so the run stops when the client disconnects.

**Health:** GET `/health` returns `{ ok: true, ts }` for liveness checks.

**Extension → webview:** `agentEvent` still flows to the webview immediately so tool and text progress stay live, but heavier `stateUpdate` snapshots are now **coalesced** in the extension before posting. This keeps streaming responsive while avoiding repeated full-state serialization, token re-estimation, diff-stat recomputation, and React store churn on every visible event. Connection state (`connecting` / `streaming` / `error`) and optional `serverConnectionError` remain in `stateUpdate` so the UI can show an indicator and "Send again to retry" on error.

### Extension: Controller pattern

The VS Code extension uses a single **Controller** (`packages/vscode/src/controller.ts`) that owns:

- Session and config
- Run state, indexer, MCP client, checkpoint
- Resolution of config from `.nexus/nexus.yaml` and VS Code settings

The **NexusProvider** owns the webview(s) and delegates all messages to `controller.handleWebviewMessage()`. State is pushed via `postStateToWebview()` / `getStateToPostToWebview()`. The agent runs either in-process (`runAgentLoop`) or against the NexusCode server (sessions, pagination).

During streaming, the extension does not rely on `agentEvent` alone. The controller now also pushes incremental `stateUpdate` snapshots while visible assistant/tool/reasoning events arrive. In server mode it maintains a local shadow of the streamed assistant message so the webview keeps rendering even before the final paginated session snapshot is reloaded from the server.

Local JSONL sessions now follow the same UI loading pattern as server sessions: the webview opens a recent message window first and exposes `Load older` when earlier turns exist. To preserve agent correctness, the controller rehydrates the full local session before starting a new local run if that session was only partially loaded in the UI.

The provider/webview bridge is readiness-gated. `onDidReceiveMessage` is attached before HTML is assigned, the webview marks itself ready via its first inbound message, and extension-to-webview payloads are only posted after that point. Snapshot/cache payloads are cloned when they are stored for replay/queue safety, but hot-path live posts avoid redundant cloning. Blocking file debug logs are also disabled by default and only enabled through an explicit environment flag. This avoids the startup race where early state/config snapshots are emitted before the webview has registered its message listeners, while keeping the extension host responsive during long agent runs.

The webview store treats `agentEvent` as the live source of truth during a run and merges later `stateUpdate` snapshots conservatively. If a snapshot arrives without the assistant tail that was already assembled from streamed events, the store preserves the richer local tail instead of dropping the in-flight assistant reply. This prevents the common race where a stale snapshot temporarily rewinds the visible chat back to only the user message.

The webview should not apply every streamed event in its own React/Zustand turn. Streaming `agentEvent`s are batched to animation frames before they hit the store, which keeps tool/text updates visually live but avoids per-token render thrash in long runs with reasoning, subagent, and tool progress updates.

The chat transcript uses `react-virtuoso` with **stable row keys** derived from tool part ids (not only array indices), a larger `atBottomThreshold`, extra viewport padding, explicit scroll-to-end when a new user message is appended, and layout hints from expandable bash blocks so dynamic row heights do not strand the latest content off-screen or recycle the wrong virtual row (ghost duplicates).

The sessions sidebar uses the same anti-stale rule for optimistic deletes. When the user deletes a session, the row is hidden immediately and marked with a short-lived tombstone in the store. Any stale `sessionList` that still contains that session is filtered out until a fresh list confirms the deletion or the tombstone expires, so the row cannot flicker back into view during refresh.

File-edit preview/approval uses a two-stage flow in the extension: `tool_start` creates the visible file-edit block first, then `tool_approval_needed` raises the approval UI if write auto-approval is off. If the user denies the edit or responds with an alternative instruction, that pending file-edit block must disappear from the chat instead of remaining as an error artifact. Only approved edits may survive into the post-run "N Files" review panel.

Assistant rendering is timeline-first, not message-prefix-first. `thought` timers are bound to the active `(messageId, reasoningId)` pair, so a new reasoning block cannot reset an older Thought label in place. `explored` is only a compression layer for contiguous code-exploration sequences (reasoning + read/list/search tools) and is merged across adjacent assistant messages when no visible non-exploration content interrupts the sequence. While a sequence is still active it is rendered as `exploring`: collapsed by default, with a live preview window of the last four events, while the full accumulated sequence remains available on expand. When a visible text reply or a non-exploration tool arrives, that sequence is finalized into `explored` without losing its accumulated history or changing its local counters.

Todo state is delivered over its own `todo_updated` stream and rendered in dedicated todo panels. `TodoWrite` / `update_todo_list` must not appear as ordinary tool rows in either the webview or the CLI bridge, and they must not interrupt chronological chat grouping such as `exploring/explored`.

Plan-mode handoff is explicit and host-driven after `PlanExit`. The host must render an action bar/panel with two primary branches: `implement` and `revise`. `implement` must switch the next run to `agent` mode. `revise` must keep the next run in `plan` mode and send the user's feedback back as plan-improvement input; it must not silently fall through into implementation. Dismissing the handoff must also leave the host out of the sticky plan-followup state so the user can continue normally.

Clarifying questions are also host-driven. `AskFollowupQuestion` no longer behaves like a yes/no approval prompt; it emits a structured `question_request` event and ends the current turn so the host can collect answers. Before Zod validation, core **coerces** common LLM shapes (`choices` vs `options`, object option rows with `label`/`value`, `text`/`prompt` vs `question`, `questions` as a JSON string) so real options are not dropped and the UI does not fall back to generic padding only. Hosts must support both the legacy single-question shape and the grouped questionnaire shape. Grouped questions may also be formed through `Parallel`, but only when the batch contains `AskFollowupQuestion` calls exclusively. In that case the host must render one pageable questionnaire, track answers per question, allow an optional custom typed answer per question, and only enable final submit once every question has an answer. In the CLI REPL, hiding the main prompt for a questionnaire or plan handoff must **not** skip rendering those panels—otherwise the lower viewport is blank and the user cannot answer or press Escape to dismiss.

**Option list contract:** Models must not put “Other”/“Custom”/equivalent freeform choices in `options`. Core normalizes every question: it strips reserved “custom bucket” labels (including duplicates and localized variants), then the UI adds **exactly one** synthetic row (`NEXUS_CUSTOM_OPTION_ID` / `__nexus_other__`) labeled from `custom_option_label` (default `Other`). If the model sends no options or fewer than two concrete choices after normalization, core **pads** with generic labels (rotated by question index so multi-question batches are not all identical) so validation and UI never fail—models should still prefer real choices when possible.

**Answer message contract:** When the user submits the questionnaire, the extension/CLI must inject a user turn for the agent using `formatQuestionnaireAnswersForAgent`, which prefixes content with `NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX` (`[nexus:questionnaire-response]\n`) followed by compact `Question → Answer` lines. The webview renders that prefix as a slim inline row (not the standard user bubble) so the transcript stays minimal.

**Plan file writes:** Updates under `.nexus/plans/` are **not** subject to the interactive write-approval flow and must **not** be tracked as “session unaccepted edits” in the extension’s N Files strip — they are planning artifacts, not implementation edits. The extension must not attach stale `planFollowupText` from an async load after the host has left plan follow-up state (mode switch, running guard).

**Plan revision turns:** When the user message matches the host’s “revise plan” template (both the revise header and the “User feedback” block from `planFollowupChoice`), the agent loop must **not** inject a synthetic `PlanExit` on a text-only stop; it continues to another iteration so the model can apply feedback via `Write`/`Edit` under `.nexus/plans/` before calling `PlanExit` again.

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
| plan   | `PlanExit`                | Turn ends when the plan is ready (plan written to `.nexus/plans/*.md`). |
| ask    | *(none)*                  | Turn ends naturally when the model stops without tool calls. |
| debug  | *(none)*                  | Turn ends naturally when the model stops without tool calls. |
| review | *(none)*                  | Turn ends naturally when the model stops without tool calls. |

Only modes with a configured mandatory tool are force-gated by that tool (currently `PlanExit` in plan mode). Other modes end naturally when the model returns a stop with no pending tool calls.

**Doom-loop guard** (`detectDoomLoop` in `packages/core/src/agent/tool-execution.ts`): blocks only when the **longest trailing run** of the same tool with the same argument signature (noise keys `task_progress` / `reason` stripped) in the **active context** (same message window as the next LLM call, i.e. after the latest compaction summary) has length ≥ threshold (**3**, or **5** for `Bash`) and **every** finished part in that suffix is **`error`**. `pending` is never counted; any **`completed`** in the suffix resets the failure streak. This applies uniformly to built-ins, MCP, `Parallel`, `TodoWrite`, etc. Intentionally does **not** block repeated successful identical calls.

---

## Key Decisions

### Unified config flow

Config is loaded from **`.nexus/nexus.yaml`** / **`.nexus/nexus.yml`** / **`.nexusrc.yaml`** / **`.nexusrc.yml`** (walk up from cwd) and **`~/.nexus/nexus.yaml`** (global). MCP server lists are merged from **`~/.nexus/mcp-servers.json`** and **`<project>/.nexus/mcp-servers.json`**. Both VS Code and CLI persist updates into the project file with deep-merge of nested sections (`model`, `embeddings`, `indexing`, `vectorDb`, `tools`, `mcp`, etc.). Env vars override file config; VS Code settings (`nexuscode.*`) override when the extension runs. Default model `baseUrl` in schema: **`https://api.kilo.ai/api/openrouter`** (not legacy `/api/gateway`).

### MCP server filtering (not tool filtering)

When the number of **MCP servers** exceeds `tools.classifyThreshold` (default 20) and `tools.classifyToolsEnabled` is true, an LLM classifier selects **which MCP servers** to use for the task. All tools from selected servers are included; custom tools (no `serverName__toolName` pattern) are always included. Skill filtering uses `skillClassifyThreshold` (default 20) and selects skills by task. Thresholds default to 20 in schema and UI.

### Inline reasoning fallback for gateway streams

Core streaming supports provider-native `reasoning_delta` and fallback extraction from structured gateway fields (`reasoning`, `reasoning_details`, `thinking`, provider metadata), OpenAI Responses-style raw events (`response.reasoning.*`, `response.output_item.*`, `response.content_part.*`, final `response.completed` payloads), and `<think>...</think>` blocks in streamed text.

Raw Responses-style text is also emitted as live `text_delta` when the provider does not surface normal text parts. When a provider exposes reasoning only in done/final payloads, core now promotes that reasoning into the same Thought event pipeline instead of dropping it. For OpenAI Responses-compatible providers we also request `reasoning.summary: "auto"` in compatible provider options so summaries arrive in the stream when supported. Fallback extraction is disabled once native `reasoning_delta` is observed. This keeps extension/CLI thought blocks populated for providers that do not emit separate reasoning events.

For OpenAI-compatible gateways, reasoning provider options are tried as an ordered fallback chain. If a gateway answers with an unsupported-parameter style error, or with a generic HTTP 400 `Bad Request` while a reasoning option set is active, the client automatically retries with the next safer provider-options candidate before giving up. This is important for OpenRouter-style model routing where some models accept streamed reasoning but reject one or more optional reasoning fields.

OpenRouter-style endpoints are treated as their own provider path rather than as a generic OpenAI-compatible endpoint. This mirrors the reference implementations more closely: OpenRouter uses its own SDK/provider namespace, and explicit reasoning controls are only sent to model families that are known to accept them reliably through OpenRouter routing. For other OpenRouter models, Nexus falls back to plain streaming without forcing reasoning parameters, which avoids hard 400 failures on models such as many Qwen/DeepSeek/GLM/Kimi variants.

For router/free-tier models where tool support is inconsistent, runtime fallback is also defensive: if an OpenRouter-style request fails with a tool-related 400, or a bare `400 Bad Request` on a `:free` model, the client retries once without tool definitions instead of surfacing an immediate hard failure. This mirrors the capability-gating intent used by the reference projects, even when local model metadata is incomplete.

### Vector index factory

`createCodebaseIndexer()` wires embeddings and vector store only when prerequisites are valid. If embeddings or Qdrant are missing, the indexer runs without vector upserts; **`CodebaseSearch` stays disabled** until `indexing.vector` and `vectorDb.enabled` are satisfied (see `codebase-search` tool).

### Qdrant availability and auto-start

`ensureQdrantRunning()` performs a health check and can auto-start Qdrant (local binary, then Docker). Auto-start is local-only. If Qdrant is unavailable, semantic (`CodebaseSearch`) indexing/search is off until Qdrant is reachable.

`@qdrant/js-client-rest` returns **`CollectionInfo` at the top level** from `getCollection` (the raw REST body nests it under `result`). `packages/core/src/indexer/vector.ts` normalizes both shapes when reading **`points_count`** and vector config; otherwise **`hasIndexedData()`** could stay false after indexing finished and **`codebase_search`** would never query Qdrant.

**Indexing pipeline (Roo-style):** One logical index per workspace: **one** Qdrant collection `nexus_{projectHash}`. **VS Code:** file-hash tracker JSON lives under **`globalStorageUri`** (`nexus-index-tracker-{hash}.json`); **CLI/server** keep tracker under `~/.nexus/index/{hash}/file-tracker.json`. Full scan uses **ripgrep `--files`** in the extension when available, then **`materializeIndexFileInfos`** (Nexus ignores); fallback is **`walkDir`**. **`indexing.maxIndexedFiles === 0`** means **no scan** (Roo `listFiles` limit 0). Watcher glob is **`buildIndexWatcherGlobPattern`**. Optional **`captureIndexTelemetry`** events go to the NexusCode output channel in VS Code. The scanner applies **`DEFAULT_EXCLUDE`**, YAML **`indexing.excludePatterns`**, **`.gitignore`**, **`.nexusignore`**, and **`.cursorignore`** (shared helper `createIndexerIgnore`); incremental **`refreshFilesBatchNow`** uses the same rules so ignored paths are removed from the index when touched. Walk / rg listing uses **`maxIndexedFiles`** (**0 = no scan**, Roo parity; default 50k), per-file **SHA-256**, and **`ignore-dirs`** where applicable. **`syncIndexing` / Sync** only runs `startIndexing()` (incremental / resume). **`fullRebuildIndex`** clears tracker + collection then indexes. **`deleteIndex`** clears workspace index without starting a new run; **`deleteIndexScope(prefix)`** removes tracker + vector points under a repo-relative prefix (Explorer command). **`CodebaseSearch`** scopes with **`target_directories`** → `pathScope` / Qdrant `pathSegments` filter. **`maxIndexingFailureRate`** (default 0.1) triggers a fatal reset when embed failures dominate after indexing has started.

**Indexing progress (Roo-aligned):** `CodebaseIndexer` emits `IndexStatus` with **`overallPercent`**, **`message`**, **`phase`**, optional **`paused`**, **`watcherQueue`**, and counters; UI bar under **Settings → Index**. With vector on, **`overallPercent`** follows Roo **`reportBlockIndexingProgress`**: **chunks indexed / max(chunks found, indexed)** (denominator grows as files parse). **`message`** leads with `Indexed … / … chunks found · Files … / …`. Full scan uses **all files queued on `p-limit(INDEX_PARSING_CONCURRENCY)`** (Roo `PARSING_CONCURRENCY` = 10), then applies results in **discovery order**. **Capacity:** **`INDEX_MAX_FILE_SIZE_BYTES`** (1 MiB) and list cap via **`indexing.maxIndexedFiles`** (schema default 50,000 = Roo `MAX_LIST_FILES_LIMIT_CODE_INDEX`). **`state: "stopping"`** is emitted when **`stop()`** aborts a run; aborted paths **`notifyStatus({ state: "idle" })`**. Debounced watcher → **`refreshFilesBatchNow`**: Roo-style **`Processing i / n files from queue. Current: basename`**, then **`ready`** (pause buttons hidden when **`watcherQueue`**). **`indexing.searchWhileIndexing`**: **`CodebaseSearch`** blocked while **`stopping`**; during **`indexing`**, partial search when **`hasSearchableCodePoints()`** (tool warns). **`pauseIndexing` / `resumeIndexing`** between checkpoints (in-flight embed HTTP not cancelled).

**Settings:** Advanced indexing knobs (batch size, concurrency, caps, `searchWhileIndexing`, failure rate) are editable under Settings → Index → “Vector DB & advanced”.

### Mention resolution in prompts

Before each agent loop, the latest user message is parsed for `@file`, `@folder`, `@url`, `@problems`, `@git`. Resolved context is injected as a dedicated prompt block so the model gets deterministic, task-relevant context.

### Agent presets

Presets (model/vector/skills/MCP/rules) are stored in **`.nexus/agent-configs.json`**. The extension and CLI discover skill paths from local `SKILL.md` and `AGENTS.md`; MCP server names come from config. Applying a preset updates the active config via the host’s `saveConfig` and reconnects MCP / indexer as needed.

### Bundled MCP (context-mode)

The repo ships **`sources/claude-context-mode`** (Context Mode MCP). Config can reference `bundle: "context-mode"`; hosts resolve it via **`resolveBundledMcpServers`** in core (`packages/core/src/mcp/resolve-bundled.ts`) to a full server config (command/args/env). `CLAUDE_PROJECT_DIR` is set to the agent cwd when running from the NexusCode repo.

---

## Invariants

- **Mode permissions** are enforced in core (not only in the UI). Blocked tools are never passed to the model.
- **Prompt and tool contracts must match runtime exactly.** System prompts, mode descriptions, sub-agent prompts, and tool descriptions must use the real tool names and parameter shapes: `PlanExit`, `SpawnAgent`, `Parallel`, `Read(file_path, offset, limit)`, and the exact-string `Edit` contract.
- **Mode switching is live within one chat.** When the mode changes, the current mode's permissions and end-of-turn rules override any earlier assumptions from the same conversation; prompts must make that explicit so the agent does not blend plan/ask/review/agent behaviors.
- **Built-in tools** are always available per mode; filtering applies only to dynamic (MCP/custom) tools, and by **MCP server** count (not individual tool count) when classification is enabled.
- **MCP config**: enable/disable is per **server** (all tools of that server). The classifier selects servers, not individual tools.
- If vector prerequisites are invalid, **`CodebaseSearch` is unavailable**; use **Grep** / **ListCodeDefinitions** for discovery until vector indexing is configured.
- Host UI must not change `runAgentLoop` contracts (options, events, tool results).
- **`Write`** and **`Edit`** skip explicit approval when `autoApproveWrite` (or mode `autoApprove` includes `write`) is enabled; otherwise they emit `tool_approval_needed` and wait for the host.
- When the **tool-call budget** is exceeded, the loop allows one more iteration with tools disabled so the model can emit a final text-only answer.
- **`config.agentLoop.toolCallBudget`** and **`config.agentLoop.maxIterations`** override per-mode limits when set.
- **Models catalog**: CLI and extension use models.dev (`NEXUS_MODELS_PATH` / `NEXUS_MODELS_URL`) and live gateway model list where applicable; unavailable free IDs are filtered from pickers.
- **End of turn**: plan mode is force-gated by **PlanExit**; agent/ask/debug/review end naturally when the model stops without tool calls.
- **Exploration discipline**: prompts should bias strongly toward search-first discovery (`Grep`/`Glob`/`CodebaseSearch`/`ListCodeDefinitions`) and only then targeted `Read` calls with `offset`/`limit`, avoiding exploratory whole-file reads.
- **Clarification discipline**: prompts should prefer tools and reasonable assumptions over questions; `AskFollowupQuestion` is for genuine blockers only, and plan approval must go through `PlanExit`, not ad hoc questions.
- **Sub-agent discipline**: parent prompts must tell sub-agents whether they are doing read-only research or implementation, define scope precisely, and request a clear final report format because each sub-agent invocation is stateless.
- **Compaction discipline**: once a compaction summary exists, active model context must be built from the latest summary plus only the messages after it. Older pre-summary turns must not continue to flow into the model alongside the summary, or the context duplicates and drifts.
- **Performance discipline**: live `agentEvent` delivery should stay low-latency, but full `stateUpdate` snapshots, diff stats, token estimates, and other derived state must be coalesced/cached so long streaming runs do not freeze the extension host or webview.

---

## Data flow

1. User message enters the VS Code webview or CLI TUI.
2. **Without server:** the host appends the message to the local session (JSONL under `~/.nexus/sessions/…`). **With server:** the message is sent over HTTP; the server process appends to the **same JSONL files** for that canonical project root (`packages/server/src/session-fs-store.ts` → core `saveSession` / `loadSessionMessages`), not a separate SQLite DB.
3. Core (in-process or on server) builds prompt blocks (role, rules, skills, system, mentions, compaction).
4. The model streams text and tool calls.
5. Tools run via the host adapter with permission checks (rules, approval dialogs).
6. In **plan** mode, **PlanExit** ends the turn after a plan file is written to `.nexus/plans/`. In other modes, turns end naturally when the model stops without tool calls.
7. Session and tool traces are persisted to JSONL (whether the client talked to the server or not) and reflected in the UI. With the server, extension and CLI list/switch sessions via HTTP; messages are loaded in windows/pages to avoid OOM. Local extension sessions also open as a recent-message window first, then page older messages on demand.
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
│   └── server/            ← Optional: HTTP server + NDJSON streaming; JSONL session store (shared with CLI/extension)
├── sources/
│   └── claude-context-mode/  ← Bundled MCP (context compression, FTS, batch_execute)
└── .nexus/                ← Project config (nexus.yaml, agent-configs.json, rules, skills)
```

---

## Built-in tools (by group)

Static registry (`getAllBuiltinTools` in `packages/core/src/tools/built-in/index.ts`):

- **always:** `AskFollowupQuestion`, `TodoWrite`, `Parallel`
- **read:** `Read`, `List`, `ListCodeDefinitions`, `ReadLints`
- **write:** `Write`, `Edit`
- **execute:** `Bash`, `BashOutput`, `KillBash` (background jobs log under the global data dir; see `execute-command.ts`)
- **search:** `Grep`, `CodebaseSearch`, `WebFetch`, `WebSearch`, `Glob`
- **skills:** `Skill` — catalog in the tool description (`<available_skills>`) from `loadSkills` (configured paths, `skillsUrls` → cache under `~/.nexus/cache/skills`, **`~/.nexus/skills`**, walk-up **`.nexus/skills`** from cwd ancestors). Marketplace installs use **`<project>/.nexus/skills/<id>`** or **`~/.nexus/skills/<id>`**. `permissions.autoApproveSkillLoad` defaults to **true**; when approval is required, `Skill` must not run inside `Parallel`. **Integrations → Marketplace:** SkillNet skills index; MCP tab appends servers to **`.nexus/mcp-servers.json`** (project) or **`~/.nexus/mcp-servers.json`** (global). **Rules:** configured patterns plus walk-up **`AGENTS.md` / `CLAUDE.md`**, same filenames under **`.nexus/`**, **`.nexus/rules/**/*.md`**, **`~/.nexus/rules/**`**.
- **context:** `Condense`
- **plan_exit:** `PlanExit` (plan mode only)

Host registration (after `ToolRegistry` + MCP): **`packages/cli/src/nexus-bootstrap.ts`** and **`packages/vscode/src/controller.ts`** register `SpawnAgent`, `SpawnAgentsParallel`, `SpawnAgentOutput`, `SpawnAgentStop`. **`packages/server/src/run-session.ts`** registers `SpawnAgent`, the deprecated alias **`SpawnAgents`**, `SpawnAgentOutput`, and `SpawnAgentStop` — it does **not** call `createSpawnAgentsParallelTool`, so on the HTTP server the model must use **`Parallel` with multiple `SpawnAgent` calls** (or sequential `SpawnAgent` / `SpawnAgents`) instead of `SpawnAgentsParallel`.

`CodebaseSearch` is included in the loop only when **`indexing.vector`** and **`vectorDb.enabled`** (see `runAgentLoop`); otherwise the tool name is removed from the per-mode builtin set.

**Not wired into the runtime registry:** exported `createRuleTool` (`name: "create_rule"`) in `report-and-control.ts` — CLI, VS Code, and server never call `toolRegistry.register` for it, so the model does not see this tool (webview still has an icon mapping in `ToolCallCard` for future use). **`exa_web_search` / `exa_code_search`** in `exa-search.ts` are not registered anywhere; argument normalization for those names in `tool-execution.ts` exists for compatibility only.

Mode-specific blocks (`MODE_BLOCKED_TOOLS`): **plan** — `Bash`; **ask** — `Write`, `Edit`, `Bash`, `PlanExit`; **review** — `Write`, `Edit`, `PlanExit`; **agent** / **debug** — `PlanExit`.

---

## External dependencies

| Dependency         | Purpose                                      |
|--------------------|----------------------------------------------|
| Vercel AI SDK      | Provider abstraction, tool-call streaming   |
| Qdrant REST client | Semantic vector retrieval                    |
| MCP SDK            | External tool ecosystem                      |

---

## Version requirements

- **Node.js**: в корневом `package.json` указано `"engines": { "node": ">=18.0.0" }`, но **`pnpm run serve`** и `scripts/check-node.js` требуют **Node 20+** (совместимость с prebuild **better-sqlite3**). Сборка и публикация **.vsix** (`pnpm package:vscode` / vsce) на практике тоже ожидают **20+**. **`.nvmrc` = 20** — рекомендуемая версия для всего рабочего цикла.
- **pnpm**: workspace и скрипты; минимальная версия в коде не зафиксирована.

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
