# NexusCode reference-agent comparison

**Audit date:** 2026-07-28

**Compared source trees:** Codex, OpenClaude, Kilo Code, Roo Code, Cline,
OpenCode, Claw Code, Kimi Code, Kimi CLI, MiMo Code, and Qwen Code.

This document records implementation evidence, not README claims. The audit followed each capability through configuration, construction, execution, persistence, host rendering, and cleanup where those layers existed.

**Audited revisions:** Codex `61a4488`, OpenClaude `a3dc345`, Kilo Code
`614c21ee81`, Roo Code `b867ec9`, Cline `dd7a1c5`, OpenCode `7534d23`,
Claw Code `4ea31c1`, Kimi Code `77618e3`, Kimi CLI `4a550ef`, MiMo Code
`076b790`, and Qwen Code `3209b89`.

## Reference order

Codex and OpenClaude are equal primary references, for different reasons:

- **Codex:** execution discipline, approvals, sandbox boundaries, durable rollouts, process lifecycle, remote protocol, and recovery invariants.
- **OpenClaude:** instructions, skills, memory, hooks, plugins, subagents, teammates, background work, and terminal-agent ergonomics.
- **Kilo Code:** broad provider support, practical OpenCode-derived runtime work, packaging, telemetry, and productized integrations.
- **Roo Code:** VS Code behavior, Tree-sitter/Qdrant indexing, checkpoints, ignore rules, and tool UX.
- **Cline, OpenCode, and Claw Code:** secondary sources for IDE host bridges,
  browser/checkpoint UX, scoped services, durable prompt admission, MCP
  recovery, and security diagnostics.
- **Kimi Code, Kimi CLI, MiMo Code, and Qwen Code:** durable content baselines,
  terminal history semantics, exact edit/rewind identity, reconnect cursors,
  and complete side-effect-free Git review.

Nexus does not copy one project wholesale. It uses one shared TypeScript core for CLI, VS Code, and server, and adopts a reference only when its invariant fits that portable runtime.

## Per-project strengths and limits

| Source | Strongest verified ideas | Limits or risks that Nexus does not copy |
| --- | --- | --- |
| Codex | Central approval/sandbox/retry orchestrator; real platform sandbox brokers; rollout reconstruction; cancellation and multi-agent lifecycle; replacement compaction | The Rust/platform stack cannot be transplanted into a portable TypeScript extension wholesale; it is not the broadest reference for provider-neutral plugins, skills, or VS Code product UX |
| OpenClaude | Deep instruction cascade, memory, skills, hooks, plugins, subagents, teams, mailboxes, background tasks, resume and terminal ergonomics | Several contracts are Anthropic/product-specific, and trusted local hooks still need a stronger OS capability boundary; Nexus keeps the behavior but removes provider coupling |
| Kilo Code | Clean typed service composition, event-sourced session runner, permission rules, provider breadth, extension packaging and operational integrations | The V2 surface is evolving and coexists with older paths; large inherited extension/service breadth should not become a second Nexus core or duplicate policy |
| Roo Code | Mature VS Code task UX, editor diff provider, Tree-sitter/Qdrant pipeline, ignore/watch behavior and checkpoints | Very large task/controller surfaces are hard to reason about; blanket shadow-repository reset/clean semantics are too broad for authoritative per-turn undo |
| Cline | Polished diff/checkpoint/browser/terminal UX, MCP recovery, diagnostics and Extension Host lifecycle | Extension-centric architecture and checkpoint snapshots do not by themselves provide durable multi-agent coordination or exact multi-file ownership |
| OpenCode | Scoped services, server/TUI separation, durable prompt admission, deterministic plugin ordering and operational SQL storage | Its service/database topology is useful on a server but unnecessary as mandatory local transcript storage; broad plugin execution still needs explicit trust boundaries |
| Claw Code | Explicit security capability reporting, expiring approval concepts, degraded MCP diagnostics and path-scope tests | The repository mixes executable runtime with roadmap/experimental material; only behavior proven in code and tests is used |
| Kimi Code | Layered agent-core-v2 services, event bus, session lifecycle, config overlays, plugins, exact edit/Git services and wire-oriented product boundaries | V2 and legacy services coexist, so architecture names alone are not evidence of one completed path; Nexus adopts tested invariants, not unfinished duplication |
| Kimi CLI | Atomic file writes, ACP/wire sessions, fork/resume, conservative compaction, background jobs and validated subagent metadata | It is primarily a terminal/Python runtime and is not the reference for native VS Code diff UX or Codex-grade process sandboxing |
| MiMo Code | Small Codex-like tool ABI, QuickJS composition, BM25 MCP/memory discovery, token-efficient output and message-bound patch history | Its own security/architecture notes acknowledge no OS shell sandbox and non-transactional multi-file patch risks; Nexus keeps deterministic discovery but uses durable atomic change sets |
| Qwen Code | Stateless reusable AgentCore, explicit subagent tool restrictions, workflow journal, MCP transport pooling and complete side-effect-free Git enumeration | Intent classification can hide MCP/skill capabilities behind model behavior; Nexus uses deterministic BM25/exact activation and avoids parallel core variants |

## Current capability matrix

| Domain | NexusCode after hardening | Strongest references | Assessment |
| --- | --- | --- | --- |
| Agent loop | One authoritative `runAgentLoop` and one tool-execution pipeline | Codex, OpenClaude | Implemented; dead duplicate permission engine removed |
| Prompts and modes | Agent, plan, ask, debug, review with mode-specific prompt and tool policy | Codex, OpenClaude, Kilo, Roo | Implemented and shared by all hosts; CLI flag, slash command and Shift+Tab use the same five-mode set |
| Compaction | Deterministic pruning/microcompaction before bounded LLM summary, CAS persistence and memory continuity | Codex, OpenClaude, Kilo, Kimi CLI | Implemented; failures do not destroy the previous transcript and active instructions are re-projected |
| Sessions | Checksummed JSONL transcript plus built-in SQLite transactional coordination, repair, migration, bounded active context | Codex, OpenCode, MiMo | Implemented; JSONL remains portable history while SQLite owns leases, admission, approvals, queues, replay and orchestration |
| Remote runs | Authenticated NDJSON, durable event replay, sequence reconnect, pre-request client outbox, exact turn identity, explicit abort and approval | Codex, OpenCode, Kimi Code | Implemented; the canonical command is persisted before POST, admission is idempotent, exact terminal replay survives lost responses and queued/active/terminal restart races, and failed/expired cursors cannot permanently block the surface |
| Permissions | Mode policy, ordered rules, path/command checks, serialized interactive approvals, fail-closed server | Codex, OpenCode, Claw | Implemented at application boundary; privileged plugin and agent-hook actions cannot inherit read auto-approval; OS process sandbox remains a separate gap |
| Tool lifecycle and large output | Validation, normalization, hooks, timeout/cancel, bounded previews, durable output spill/read and task events | Codex, Kilo, MiMo | Implemented; spilled data is outside the project tree and remains explicitly retrievable |
| Subagents | Task-first delegated runs, batches, snapshots, resume, worktree isolation, narrowed modes | OpenClaude, Codex, Cline | Implemented; approval requests are serialized across root/delegated hosts and agent-hook paths are confined |
| Teams/orchestration | Durable tasks, teams, inbox, members, messages, worktrees, remote sessions | OpenClaude | Implemented with checksummed snapshot + journal |
| Memory | Global/project/session/team and bound task/agent records, markdown import, scrolling memory, relevance retrieval, redaction, access accounting | OpenClaude, Kilo | Implemented; complete eligible scopes are ranked before prompt budgeting and private scopes fail closed |
| Rules and skills | Managed/user/project cascade, includes, Claude compatibility, deferred skill discovery | OpenClaude, Codex | Implemented; server loading is bounded and fail-soft with visible diagnostics |
| Plugins | Manifest validation, explicit trust, lifecycle hooks, agents, skills, commands, MCP, install/remove/reload, isolated custom-tool workers | OpenClaude, OpenCode, Roo | Implemented for trusted local plugins; trust/install/remove/manual hook calls require user approval, one-shot hooks are success-only and session-scoped, and the installed VSIX ships the cross-platform custom-tool compiler instead of depending on a source checkout or platform-native optional binary |
| MCP | stdio/HTTP/SSE, timeout, pagination, resources, auth handoff, schema normalization, list-change refresh, safe reconnect | Cline, OpenCode | Implemented; dropped transports reconnect without replaying a possibly mutating call |
| Code intelligence | Tree-sitter symbols, incremental tracking, optional embeddings/Qdrant, LSP in VS Code | Roo, Kilo | Implemented; semantic index is optional and the agent works without it |
| Checkpoints and change review | Durable content-addressed change sets, exact proposal approval, CAS apply/revert/recovery, path-scoped checkpoint restore, bounded Git status/diff, and CLI/server/VS Code review | Codex, Kimi Code, Qwen, MiMo | Implemented; legacy shadow checkpoints without exact message binding are preview-only and no restore path runs blanket reset/clean or renames nested Git metadata |
| File mutation | Write, Edit, and strict multi-file ApplyPatch share one proposal-first durable mutation flow | Codex, Kilo, Roo, MiMo | Implemented; ApplyPatch validates every exact hunk before one atomic review action, retains binary delete bytes, compensates partial host failures, and identifies grouped multi-file review actions honestly |
| Terminal | Foreground/background tasks, output/stop lifecycle, integrated VS Code terminal, cancellation | Codex, Cline | Implemented |
| Providers | Anthropic, OpenAI-compatible, OpenAI, Google, Azure, Bedrock and compatible gateways | Kilo, OpenCode | Implemented with compatibility tests for the AI SDK generation in this repository |
| Config, credentials and first run | Layered YAML authority, destination-bound secrets, owner-only atomic CLI state and Kilo free-model default | Codex, Kimi CLI, Qwen, Kilo | Implemented; the installer selects the exact pinned Node runtime and does not persist the retired plaintext CLI key |
| Install and packaging | Pinned Node/pnpm, reproducible monorepo build, wrapper CLI and self-contained VSIX assets | Kilo, Roo, Cline | Implemented and smoke-tested from a shell initially pointing at an older Node runtime |
| Browser | Web search/fetch built in; interactive browser only through a present plugin or MCP tool | Cline | Intentionally external; prompt no longer claims a nonexistent built-in browser |
| Surface parity | Shared core in CLI, server, and VS Code; host-specific capability adapters | Codex app server, Cline SDK | Substantial parity; CLI resumes only canonical Nexus sessions, VS Code secrets use SecretStorage, and the extension is disabled for untrusted workspaces; deep real-host E2E coverage is still weaker than Cline |

## What Nexus took from each implementation

### Codex

- Fail-closed privileged execution and explicit approval boundaries.
- Durable, replayable run events rather than treating a live stream as the source of truth.
- Session/run identity, cancellation trees, process cleanup, and idempotent reconnect semantics.
- Worktree-aware delegated coding and truthful verification contracts.
- Portable canonical transcripts with database-like projections kept conceptually separate from the transcript.

Nexus uses portable JSONL as transcript/audit history and built-in `node:sqlite`
for transactional coordination. This avoids a third-party native addon ABI
while still providing leases, idempotent admission, approvals, queues, replay,
orchestration mailboxes, and cleanup ledgers.

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

Nexus adopts the useful operational-database boundary without making SQLite the
canonical conversation format: portable transcript history and transactional
coordination have different failure and query requirements.

Kilo and Roo also informed the per-file diff projection and extension tool
metadata. Nexus keeps Codex-style whole-call ownership for a multi-file patch;
the extension marks those files as one atomic patch instead of implying that a
single row can be accepted independently.

### Roo Code

- Tree-sitter language coverage and query assets.
- Qdrant-backed semantic search with local cache/tracker state.
- Incremental indexing, ignore handling, failure thresholds, and partial-index policy.
- Checkpoint and VS Code interaction patterns.
- Cross-platform `esbuild-wasm` packaging for runtime-provided code tools.

Nexus corrected its production packaging so Tree-sitter WASM/query files and
the custom-tool compiler are present in the VSIX/build, rather than only
working from a source checkout. Unlike Roo's direct compiler invocation, the
Nexus bundler retains an import-resolution policy that rejects paths escaping
the exact trusted tool tree before worker execution.

### Cline

- Shadow-Git checkpoint UX and task/workspace restore distinction.
- VS Code host bridge, diff/diagnostic integration, and integrated-terminal behavior.
- Dynamic subagent definitions and rich subagent presentation.
- MCP connection recovery and explicit host lifecycle cleanup.
- A real interactive browser as evidence of what a browser feature requires.

Nexus adopted the lifecycle and UX lessons, but did not pretend WebFetch was equivalent to a browser. Interactive navigation, screenshots, and page actions require an installed browser plugin/MCP capability until a real bundled browser service is implemented.

### Kimi Code and Kimi CLI

- FIFO turn admission with stable client-owned identities.
- Serialized undo, exact preconditions, and retained terminal results.
- Step-request queues that deliver user answers at provider boundaries.
- Tail-preserving compaction and durable transcript fork/truncation behavior.

Nexus uses those invariants in its queued-turn store, pre-request remote
outbox, mailbox delivery, compaction CAS, and two-phase chat/file rewind.

### MiMo Code and Qwen Code

- MiMo's message/part-bound patch history, server SQLite/WAL ownership, and
  scoped restore validation.
- Qwen's writer-lease discipline, fail-closed compaction tiers, complete Git
  state enumeration, background agents, and permission-rule boundaries.

Nexus uses SQLite only where server concurrency needs transactions and keeps
local CLI/extension history portable. It does not copy Qwen's intent
classifier for MCP or skills: deterministic discovery and explicit activation
are easier to audit and do not hide capabilities behind another model call.

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
| Kimi Code / Kimi CLI | No SQLite requirement for the core terminal agent; portable session/event files own history |
| MiMo Code | SQLite/WAL for server-side state and locks; patch history remains explicitly message-bound |
| Qwen Code | Local operational/session persistence where useful, not a mandatory code-index backend |
| NexusCode | Built-in SQLite for transactional runtime coordination; checksummed JSONL transcript/audit history; JSON index tracker; optional Qdrant vectors |

Nexus already uses built-in `node:sqlite`, with migrations and integrity-tested
runtime repositories. It is not the code index and does not replace portable
JSONL transcript history. Adding another SQLite FTS/index subsystem remains
unjustified without a measured retrieval problem.

Full-text search is deliberately deferred. Existing agents operate successfully with targeted file search, AST/LSP navigation, bounded transcript loading, memory retrieval, and optional semantic search. FTS should be added only for a measured retrieval problem, not to justify a database.

## Verification performed

The audit finished with the repository-pinned Node `24.18.0`, not the older
Node initially present in the user's shell:

- monorepo typecheck: all six executable workspace packages passed;
- monorepo tests: 1569 tests passed across core, state, webview, CLI, server,
  and VS Code packages;
- full production build passed, including the built-in SQLite dist import
  checks;
- runtime/storage portability suite: 12/12 passed;
- deterministic feature census: 242 declared executable features, regenerated
  and freshness-checked;
- MCP/skills end-to-end validation passed;
- VSIX packaged with 168 files, including Tree-sitter assets and the
  cross-platform custom-tool compiler;
- isolated installer smoke started with Node 20 first in `PATH`, selected the
  pinned Node 24 binary, built the CLI, installed a temporary wrapper, and
  completed config set/get with `0700` directory and `0600` file modes;
- headless `nexus doctor` passed against `/Users/mac/Projects/nexus/test`
  without opening Ink/raw mode or mutating the host authority store;
- a loopback server smoke verified health, authentication failure, and
  authenticated workspace-scoped session listing.

No paid/provider request, destructive workspace restore, or real arbitrary
agent shell mutation was used for this validation. Those require explicit
user-controlled staging and are not appropriate as unattended smoke tests.

## Remaining real gaps

These are not hidden behind marketing language:

1. **OS-level command sandbox.** Nexus has path confinement, command policy, approvals, server workspace roots, cancellation, and Docker-only permission bypass checks. It does not yet provide Codex-grade platform sandboxing for every local command.
2. **Plugin capability isolation.** Plugins require explicit trust and declared paths, but a trusted hook still executes with the host process's OS privileges. Fine-grained capability grants and an isolated runner would improve this.
3. **Interactive browser.** Cline has a real Chrome/Puppeteer service. Nexus intentionally exposes only WebSearch/WebFetch unless a browser plugin or MCP tool is present.
4. **Crash continuation.** Durable events, admitted input, exact turn identity,
   and change recovery survive process restarts. An in-flight provider stream
   or arbitrary third-party tool cannot be resumed at the exact instruction
   boundary after process death; it is marked interrupted and safely retried
   or reviewed.
5. **Host-level E2E depth.** Core/server/CLI/VS Code unit and integration tests
   are broad, but real Extension Host UI automation remains shallower than
   Cline's.
6. **Multi-root IDE semantics.** Indexing supports multiple projects, but every
   mutation, checkpoint, terminal, and review workflow is not yet proven
   against complex VS Code multi-root workspaces.
7. **Partial multi-file acceptance.** A multi-file ApplyPatch is intentionally
   one proposal and one approval/revert boundary. The UI identifies that
   grouping. Selecting only some hunks/files would require a new proposal hash
   and is not silently emulated.
8. **Large controller decomposition.** Core policy is already separated from
   hosts, but the VS Code controller still contains too much UI orchestration.
   Further extraction should be behavior-preserving and driven by real host
   tests, not a speculative rewrite.

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

## Code evidence map

The paths below are the principal implementation points inspected during this
audit. They are intentionally narrower than each repository's documentation.

| Concern | Reference implementation evidence | Nexus implementation evidence |
| --- | --- | --- |
| Agent loop and tool execution | `source_projects/codex/codex-rs/core/src/tools/orchestrator.rs`; `source_projects/openclaude/src/tools/AgentTool/runAgent.ts`; `source_projects/kilocode/packages/core/src/session/runner/index.ts`; `source_projects/qwen-code/packages/core/src/agents/runtime/agent-core.ts` | `packages/core/src/agent/loop.ts`; `packages/core/src/agent/tool-pipeline.ts`; `packages/core/src/agent/tool-execution.ts`; `packages/core/src/agent/run-services.ts` |
| Compaction | `source_projects/codex/codex-rs/core/src/compact.rs`; `source_projects/kilocode/packages/core/src/session/compaction.ts`; `source_projects/kimi-cli/src/kimi_cli/soul/compaction.py` | `packages/core/src/session/compaction.ts`; `packages/core/src/context/compaction-projection.ts` |
| Sandbox and permissions | `source_projects/codex/codex-rs/core/src/tools/sandboxing.rs`; `source_projects/codex/codex-rs/core/src/tools/approvals.rs`; `source_projects/kilocode/packages/core/src/permission.ts`; `source_projects/MiMo-Code/SECURITY.md` | `packages/core/src/agent/approval-coordinator.ts`; `packages/core/src/agent/mode-input-policy.ts`; `packages/core/src/agent/tool-execution.ts`; host implementations under `packages/cli/src/host.ts`, `packages/vscode/src/host.ts`, and `packages/server/src/host.ts` |
| Subagents and orchestration | `source_projects/codex/codex-rs/core/src/tools/handlers/multi_agents.rs`; `source_projects/openclaude/src/tools/AgentTool`; `source_projects/kimi-cli/src/kimi_cli/subagents`; `source_projects/qwen-code/packages/core/src/agents/runtime` | `packages/core/src/agent/parallel.ts`; `packages/core/src/orchestration/runtime.ts`; `packages/core/src/orchestration/agents.ts`; `packages/core/src/tools/built-in/orchestration-tools.ts` |
| Memory and skills | `source_projects/openclaude/src/tools/AgentTool/agentMemory.ts`; `source_projects/openclaude/src/memdir`; `source_projects/openclaude/src/skills`; `source_projects/MiMo-Code/packages/opencode/src/tool/memory.ts` | `packages/core/src/context/auto-memory.ts`; `packages/core/src/session/session-memory.ts`; `packages/core/src/context/team-memory.ts`; `packages/core/src/memory/retrieval.ts`; `packages/core/src/skills/manager.ts` |
| MCP, plugins and deferred discovery | `source_projects/openclaude/src/plugins`; `source_projects/openclaude/src/skills/mcpSkills.ts`; `source_projects/qwen-code/packages/core/src/tools/mcp-transport-pool.ts`; `source_projects/MiMo-Code/packages/opencode/src/tool/mcp-tool-search.ts`; Kimi Code `packages/agent-core-v2/src/app/plugin` | `packages/core/src/mcp/client.ts`; `packages/core/src/mcp/transport-factory.ts`; `packages/core/src/plugins/runtime.ts`; `packages/core/src/plugins/capabilities.ts`; `packages/core/src/skills/skill-tool-catalog.ts` |
| Exact edits, Git and review | Roo `src/integrations/editor/DiffViewProvider.ts` and `src/services/checkpoints`; Kimi Code `packages/agent-core-v2/src/app/edit` and `src/app/git`; Qwen `packages/core/src` Git services; MiMo message-bound patch history | `packages/core/src/changes/service.ts`; `packages/core/src/changes/file-store.ts`; `packages/core/src/tools/file-change-flow.ts`; `packages/core/src/git`; CLI review in `packages/cli/src/change-review.ts`; VS Code host/controller in `packages/vscode/src` |
| Durable transport and server state | Codex `codex-rs/core/src/rollout.rs`; Kimi CLI `src/kimi_cli/wire` and `src/kimi_cli/session.py`; OpenCode server/session services; MiMo SQLite/WAL services | `packages/core/src/run/event-store.ts`; `packages/core/src/protocol/remote-turn-store.ts`; `packages/server/src/session-protocol-service.ts`; `packages/server/src/sqlite-workspace-runtime.ts`; `packages/server/src/sqlite-change-set-store.ts` |
| First-run persistence and packaging | Kimi CLI `src/kimi_cli/utils/io.py`; Qwen workflow/session stores; Kilo/Roo/Cline extension packaging | `packages/cli/src/utils/config.ts`; `scripts/install-nexus-cli.sh`; `scripts/runtime-version.test.mjs`; `packages/vscode/scripts/package-vsix.cjs` |
