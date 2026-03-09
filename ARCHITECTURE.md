# Architecture

## System Overview

NexusCode has three runtime layers:

1. **`packages/core`** — Agent runtime: LLM loop, modes, tool execution, permissions, MCP client, skills, indexing, session, compaction, checkpoints. No VS Code or CLI dependencies.
2. **`packages/vscode`** — VS Code host + React webview UI (settings, chat, sessions, agent presets).
3. **`packages/cli`** — Terminal host + TUI (Ink/React, reference UI from claude-code). Same agent loop as the extension.

Both hosts call the same `runAgentLoop()` in core, so behavior is consistent across VS Code and CLI. The CLI uses a **Nexus query bridge** (`nexus-query.ts`): when started with Nexus bootstrap (interactive mode), the REPL calls `queryNexus()` instead of the reference Anthropic `query()`. The bridge runs `runAgentLoop()` with a `CliHost` that queues `AgentEvent`s and maps them to the REPL’s `Message` types (AssistantMessage, ProgressMessage, UserMessage) so the existing Ink UI renders tool progress and responses. Model, mode, index, session, checkpoints, and profile are passed via CLI options and bootstrap; task checkpoints and restore are available as `nexus task checkpoints` and `nexus task restore <id>`.

#### Nexus CLI feature wiring

| Feature | Where | Notes |
|--------|--------|--------|
| **Mode** (agent / ask / plan / debug) | `--mode` + bootstrap | Passed to `runAgentLoop`; Logo shows `mode=…` when Nexus is active. |
| **Model** | `--model` + config / bootstrap | Override in bootstrap; Logo shows `model=…`. |
| **Vector index** | `--no-index` + config | `indexEnabled` in bootstrap; Logo shows `index=on|off`. |
| **Profile** | `--profile` + config | Merges profile into model config in bootstrap. |
| **Session** | `--session`, `--continue` | Session create/resume in bootstrap; `nexusSessionId` passed to REPL. |
| **Checkpoints** | `nexus task checkpoints` / `nexus task restore <id>` | REPL receives `nexusGetCheckpointList`, `nexusOnRestoreCheckpoint`. |
| **Progress display** | REPL + `utils/messages.tsx` | Matches reference: `reorderMessages`, `getInProgressToolUseIDs`, ProgressMessage with `content[0]` = tool_use, MessageResponse + loader semantics. |
| **Permissions** | CliHost `showApprovalDialog` | Approval via readline (or future tuiApprovalRef). |

Optional **`packages/server`** stores sessions and messages in SQLite; extension and CLI can connect to it for shared sessions and pagination (no OOM on long chats).

### Extension: Controller pattern

The VS Code extension uses a single **Controller** (`packages/vscode/src/controller.ts`) that owns:

- Session and config
- Run state, indexer, MCP client, checkpoint
- Resolution of config from `.nexus/nexus.yaml` and VS Code settings

The **NexusProvider** owns the webview(s) and delegates all messages to `controller.handleWebviewMessage()`. State is pushed via `postStateToWebview()` / `getStateToPostToWebview()`. The agent runs either in-process (`runAgentLoop`) or against the NexusCode server (sessions, pagination).

---

## Agent loop and mandatory end tools

The agent loop runs until one of:

- **Mandatory end tool** for the current mode is executed (turn ends).
- **finishReason === "stop"** and no tool calls in the last step (then the loop may force-call the mandatory end tool).
- Abort, fatal error, or tool/iteration budget exceeded.

**Mandatory end tool per mode** (`MANDATORY_END_TOOL` in `packages/core/src/agent/modes.ts`):

| Mode   | Mandatory end tool        | Meaning |
|--------|---------------------------|--------|
| agent  | `final_report_to_user`    | Turn ends after the model reports the result to the user. |
| plan   | `plan_exit`               | Turn ends when the plan is ready (plan written to `.nexus/plans/*.md`). |
| ask    | `final_report_to_user`   | Turn ends after the model reports the answer. |
| debug  | `final_report_to_user`   | Turn ends after the model reports the diagnosis/fix. |

When the model stops without calling the mandatory tool, the loop force-calls it (with a summary of the current text) so the user always gets a final message. After the mandatory tool runs, the loop breaks and the turn is complete. There is no separate “completion” tool; **final_report_to_user** is the single way to deliver the final answer and end the turn in agent/ask/debug.

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

The repo ships **`sources/claude-context-mode`** (Context Mode MCP). Config can reference `bundle: "context-mode"`; hosts resolve it via **`resolveBundledMcpServers`** in core (`packages/core/src/mcp/resolve-bundled.ts`) to a full server config (command/args/env). `CLAUDE_PROJECT_DIR` is set to the agent cwd when running from the NexusCode repo.

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
- **End of turn**: In agent/ask/debug the turn ends when **final_report_to_user** is executed; in plan when **plan_exit** is executed. The loop does not run another LLM request after that.

---

## Data flow

1. User message enters the VS Code webview or CLI TUI.
2. **Without server:** the host appends the message to the local session (JSONL). **With server:** the message is sent to the NexusCode server; sessions and messages live in the server SQLite DB.
3. Core (in-process or on server) builds prompt blocks (role, rules, skills, system, mentions, compaction).
4. The model streams text and tool calls.
5. Tools run via the host adapter with permission checks (rules, approval dialogs).
6. When **final_report_to_user** (or **plan_exit** in plan mode) runs, its output is merged into the last text part’s `user_message` and the loop exits after that iteration.
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

- **always:** `final_report_to_user`, `ask_followup_question`, `update_todo_list`
- **read:** `read_file`, `list`, `list_code_definitions`, `read_lints`
- **write:** `write_to_file`, `replace_in_file`, `create_rule`
- **execute:** `execute_command`
- **search:** `grep`, `codebase_search`, `web_fetch`, `web_search`, `glob`
- **browser:** `browser_action`
- **skills:** `use_skill`
- **agents:** `SpawnAgents`
- **context:** `condense`, `summarize_task`
- **plan_exit:** `plan_exit` (plan mode only)

Mode-specific blocks: **plan** blocks `execute_command`; **ask** blocks `write_to_file`, `replace_in_file`, `execute_command`, `create_rule`, `plan_exit`. **agent** and **debug** block `plan_exit`.

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

Built-in tool schemas are **strict** (Zod `.strict()` or explicit required/optional). We send a single **`path`** (string) for **List**; we do **not** use a **`paths`** array for that tool.

Some providers or gateways (e.g. Minimax, Kilo gateway) may expose a list-dir–style tool with a **`paths`** (array) schema or validate model tool-call args against such a schema. If the model returns `{}` or `{ paths: [] }`, the gateway can respond with an error like *"paths[0] must be string, got undefined"* **before** we see the tool_call. To avoid that:

1. We **normalize** as soon as we receive a **tool_call** for List: if the payload has **paths**, we set **path** from **paths[0]** and default to **"."** when missing.
2. We use a **distinct tool name** (**List**) and a **strict schema** so the provider is less likely to map our tool to an internal "LS" that expects **paths**.

So the **paths[0]** error, when it appears, comes from **provider-side validation**, not from our Zod. Normalization at receive + at execute ensures our code always works with **path** only.

---

## Known constraints

- Auto-started Qdrant supports only local endpoints.
- In a multi-root VS Code workspace, the first folder is used as the active project root.
- Type-checking across the workspace expects built `core` artifacts (package exports are dist-first).
