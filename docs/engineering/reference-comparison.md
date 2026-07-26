# NexusCode reference-agent comparison

**Audit date:** 2026-07-27

**Compared source trees:** Codex, OpenClaude, Kilo Code, Roo Code, Cline, OpenCode, and Claw Code.

This document records implementation evidence, not README claims. The audit followed each capability through configuration, construction, execution, persistence, host rendering, and cleanup where those layers existed.

## Reference order

Codex and OpenClaude are equal primary references, for different reasons:

- **Codex:** execution discipline, approvals, sandbox boundaries, durable rollouts, process lifecycle, remote protocol, and recovery invariants.
- **OpenClaude:** instructions, skills, memory, hooks, plugins, subagents, teammates, background work, and terminal-agent ergonomics.
- **Kilo Code:** broad provider support, practical OpenCode-derived runtime work, packaging, telemetry, and productized integrations.
- **Roo Code:** VS Code behavior, Tree-sitter/Qdrant indexing, checkpoints, ignore rules, and tool UX.
- **Cline, OpenCode, and Claw Code:** secondary sources for IDE host bridges, browser/checkpoint UX, scoped services, durable prompt admission, MCP recovery, and security diagnostics.

Nexus does not copy one project wholesale. It uses one shared TypeScript core for CLI, VS Code, and server, and adopts a reference only when its invariant fits that portable runtime.

## Current capability matrix

| Domain | NexusCode after hardening | Strongest references | Assessment |
| --- | --- | --- | --- |
| Agent loop | One authoritative `runAgentLoop` and one tool-execution pipeline | Codex, OpenClaude | Implemented; dead duplicate permission engine removed |
| Modes | Agent, plan, ask, debug, review with mode-specific tool policy | OpenClaude, Kilo, Roo | Implemented and shared by all hosts |
| Sessions | Checksummed JSONL journal, repair, migration, bounded active context | Codex, OpenCode | Implemented without native database dependency |
| Remote runs | Authenticated NDJSON, durable event replay, sequence reconnect, explicit abort and approval | Codex, OpenCode | Implemented; user turn is admitted before execution and a run has one execution owner |
| Permissions | Mode policy, ordered rules, path/command checks, serialized interactive approvals, fail-closed server | Codex, OpenCode, Claw | Implemented at application boundary; privileged plugin and agent-hook actions cannot inherit read auto-approval; OS process sandbox remains a separate gap |
| Tool lifecycle | Validation, normalization, hooks, timeout/cancel, output spill, durable task events | Codex, Kilo | Implemented |
| Subagents | Task-first delegated runs, batches, snapshots, resume, worktree isolation, narrowed modes | OpenClaude, Codex, Cline | Implemented; approval requests are serialized across root/delegated hosts and agent-hook paths are confined |
| Teams/orchestration | Durable tasks, teams, inbox, members, messages, worktrees, remote sessions | OpenClaude | Implemented with checksummed snapshot + journal |
| Memory | Global/project/session/team and bound task/agent records, markdown import, scrolling memory, relevance retrieval, redaction, access accounting | OpenClaude, Kilo | Implemented; complete eligible scopes are ranked before prompt budgeting and private scopes fail closed |
| Rules and skills | Managed/user/project cascade, includes, Claude compatibility, deferred skill discovery | OpenClaude, Codex | Implemented; server loading is bounded and fail-soft with visible diagnostics |
| Plugins | Manifest validation, explicit trust, lifecycle hooks, agents, skills, commands, MCP, install/remove/reload | OpenClaude, OpenCode | Implemented for trusted local plugins; trust/install/remove/manual hook calls require user approval, and one-shot hooks are success-only and session-scoped |
| MCP | stdio/HTTP/SSE, timeout, pagination, resources, auth handoff, schema normalization, list-change refresh, safe reconnect | Cline, OpenCode | Implemented; dropped transports reconnect without replaying a possibly mutating call |
| Code intelligence | Tree-sitter symbols, incremental tracking, optional embeddings/Qdrant, LSP in VS Code | Roo, Kilo | Implemented; semantic index is optional and the agent works without it |
| Checkpoints | Shadow Git, task/workspace restore, diffs, CLI and VS Code surfaces | Cline, Roo | Implemented |
| Terminal | Foreground/background tasks, output/stop lifecycle, integrated VS Code terminal, cancellation | Codex, Cline | Implemented |
| Providers | Anthropic, OpenAI-compatible, OpenAI, Google, Azure, Bedrock and compatible gateways | Kilo, OpenCode | Implemented with compatibility tests for the AI SDK generation in this repository |
| Browser | Web search/fetch built in; interactive browser only through a present plugin or MCP tool | Cline | Intentionally external; prompt no longer claims a nonexistent built-in browser |
| Surface parity | Shared core in CLI, server, and VS Code; host-specific capability adapters | Codex app server, Cline SDK | Substantial parity; VS Code secrets use SecretStorage and the extension is disabled for untrusted workspaces; deep real-host E2E coverage is still weaker than Cline |

## What Nexus took from each implementation

### Codex

- Fail-closed privileged execution and explicit approval boundaries.
- Durable, replayable run events rather than treating a live stream as the source of truth.
- Session/run identity, cancellation trees, process cleanup, and idempotent reconnect semantics.
- Worktree-aware delegated coding and truthful verification contracts.
- Portable canonical transcripts with database-like projections kept conceptually separate from the transcript.

Nexus differs by using portable JSONL and atomic/checksummed journals instead of the Rust SQLite state layer. This avoids a native ABI requirement across Node, Electron/VSIX, and packaged CLI surfaces.

### OpenClaude

- Instruction cascade, Claude-compatible rules, skills, auto-memory, session memory, and compaction continuity.
- Plan workflow and explicit host handoff.
- Hooks around prompts, tools, turns, task completion, and subagent lifecycle.
- Task/subagent/team/inbox orchestration, snapshots, resume, remote state, and background work.
- Plugin-provided agents, skills, commands, hooks, and MCP declarations.
- Success-only one-shot hook lifecycle, scoped to the owning session rather than process-global state.

Nexus keeps these contracts provider-neutral and places them behind one tool policy. Plugin code is not trusted merely because it exists in the project.

### Kilo Code

- Broad provider and gateway compatibility.
- Recoverable tool-schema drift with useful validation feedback.
- Practical multi-surface settings and packaging concerns.
- OpenCode-derived task/storage ideas where they improve operational behavior.
- Productized code-index controls and graceful optional-service behavior.

Nexus does not adopt Kilo's operational SQLite dependency because Nexus sessions and orchestration already have portable canonical journals and do not require ad hoc SQL queries on the hot path.

### Roo Code

- Tree-sitter language coverage and query assets.
- Qdrant-backed semantic search with local cache/tracker state.
- Incremental indexing, ignore handling, failure thresholds, and partial-index policy.
- Checkpoint and VS Code interaction patterns.

Nexus corrected its production packaging so Tree-sitter WASM and query files are present in the VSIX/build, rather than only working from a source checkout.

### Cline

- Shadow-Git checkpoint UX and task/workspace restore distinction.
- VS Code host bridge, diff/diagnostic integration, and integrated-terminal behavior.
- Dynamic subagent definitions and rich subagent presentation.
- MCP connection recovery and explicit host lifecycle cleanup.
- A real interactive browser as evidence of what a browser feature requires.

Nexus adopted the lifecycle and UX lessons, but did not pretend WebFetch was equivalent to a browser. Interactive navigation, screenshots, and page actions require an installed browser plugin/MCP capability until a real bundled browser service is implemented.

### OpenCode

- Per-workspace scoped runtime services and deterministic disposal.
- Separation between durable prompt admission and active execution.
- Session busy/cancel state, permission requests, deterministic plugin ordering, and server/TUI protocol separation.
- Durable operational storage concepts and explicit status events.

The server now persists the user turn before provider/tool side effects and atomically grants only one request ownership of a `clientRunId`, closing a crash-loss and double-execution bug.

The shared approval coordinator also treats the approval event and user dialog as one serialized operation. Parallel subagents can no longer overwrite a CLI/webview resolver or attach a response to the wrong privileged action.

### Claw Code

- Scoped, expiring, replay-resistant approval-token concepts.
- Explicit sandbox capability reporting rather than claiming unsupported isolation.
- Degraded MCP reports with phase-specific diagnostics.
- Security verification maps and path-scope tests.

Claw contains a mixture of implemented Rust runtime and roadmap material, so Nexus adopted only invariants confirmed in executable code.

## SQLite decision

SQLite is not a universal prerequisite for a coding agent:

| Project | Actual SQLite role |
| --- | --- |
| Codex | Rebuildable/local state projection and control-plane features alongside canonical rollout JSONL; not the code index |
| OpenClaude | Optional Bun knowledge-graph acceleration with JSON durability/fallback |
| Kilo Code | Operational session/event database; code-index cache remains separate from Qdrant |
| Roo Code | No SQLite code index; local cache/tracker data plus Qdrant |
| Cline | Core/CLI session metadata and discovery; checkpoints remain separate |
| OpenCode | Operational SQLite/Drizzle database and durable event model |
| Claw Code | Simple RAG store with linear cosine scan; Qdrant exists as the scale-up path |
| NexusCode | Canonical checksummed JSONL sessions, checksummed orchestration journal, JSON index tracker, optional Qdrant vectors |

Adding native SQLite to Nexus now would add Node/Electron ABI and packaging failure modes without fixing a current user scenario. It should only be introduced later as an **optional rebuildable projection** if measured session/task query volume requires it. Such a projection would need migrations, WAL/integrity handling, corruption rebuild, and a JSONL source of truth.

Full-text search is deliberately deferred. Existing agents operate successfully with targeted file search, AST/LSP navigation, bounded transcript loading, memory retrieval, and optional semantic search. FTS should be added only for a measured retrieval problem, not to justify a database.

## Remaining real gaps

These are not hidden behind marketing language:

1. **OS-level command sandbox.** Nexus has path confinement, command policy, approvals, server workspace roots, cancellation, and Docker-only permission bypass checks. It does not yet provide Codex-grade platform sandboxing for every local command.
2. **Plugin capability isolation.** Plugins require explicit trust and declared paths, but a trusted hook still executes with the host process's OS privileges. Fine-grained capability grants and an isolated runner would improve this.
3. **Interactive browser.** Cline has a real Chrome/Puppeteer service. Nexus intentionally exposes only WebSearch/WebFetch unless a browser plugin or MCP tool is present.
4. **Mid-run steering/queueing.** Remote clients reconnect to an active run and can abort it, but a second user message is not yet admitted as a queued/steering turn while that run is active.
5. **Crash continuation.** Durable events and admitted user input survive a server crash, and interrupted runs are truthfully marked. Provider streams or partially executed tools are not resumed across process death.
6. **Host-level E2E depth.** Core/server/CLI/VS Code unit and integration tests now exist, but Cline still has broader real-host UI coverage.
7. **Multi-root IDE semantics.** Indexing supports multiple projects, but every host workflow is not yet proven against complex VS Code multi-root workspaces.

The first two are the highest-value next architectural milestone. They require a real platform process broker/isolated plugin runner rather than another application-level flag. Browser bundling and SQLite are not prerequisites for reliable coding behavior.

## Why the resulting Nexus architecture is distinct

Nexus now combines features that are usually split across projects:

- Codex-style execution/replay/fail-closed boundaries;
- OpenClaude-style memory, instructions, plugins, hooks, tasks, teams, and resume;
- Kilo/OpenCode provider and operational breadth;
- Roo's Tree-sitter/Qdrant and VS Code patterns;
- Cline's checkpoint and host-lifecycle lessons;
- one provider-neutral core shared by terminal, server, and extension.

The important distinction is not the raw feature count. The same session, tool, permission, plugin, MCP, memory, task, and run contracts are used across surfaces, and optional services fail visibly without making the base coding agent unusable.
