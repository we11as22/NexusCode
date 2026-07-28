# Nexus Context, Compaction, and Host Validation Checkpoint — 2026-07-29

This checkpoint records the final source-backed hardening pass after the turn
contract checkpoint. It records executable behavior and host observations, not
product claims.

## Source-backed decisions

- **Codex:** the provider-visible tool manifest and execution policy must stay
  aligned; mode is immutable for an admitted turn; context thresholds follow
  model capability metadata and preserve response headroom.
- **OpenClaude:** skills and delegated roles are durable system contracts, not
  one-shot user text; large tool output needs owner-scoped storage and bounded
  retrieval.
- **Kilo Code:** specialized tools may be deferred behind deterministic local
  discovery; tool output uses one common preview/spill boundary; compaction
  replaces the old head while preserving a recent tail.
- **Kimi CLI and Qwen Code:** compaction preserves recent turns verbatim,
  provider context limits are explicit, and queued/child execution must retain
  its exact admitted contract.
- **MiMo Code:** explicitly invoked skills and compact deterministic discovery
  are preferable to unconditional injection of every discovered skill body.

Nexus does not use an LLM classifier to hide MCP tools or skills. Mode policy
filters the deterministic catalog, `ToolSearch` activates deferred schemas, and
`Skill` loads a named full body after an explicit successful invocation.

## Implemented

### Context, prompts, and modes

- Removed the synthetic final user message that previously placed environment
  metadata after the real user request.
- Mention resolution is permission-aware: `@file` and `@folder` use host
  authority; `@url` and `@git` no longer perform hidden network/process I/O
  during prompt construction.
- Hidden compatibility fallbacks are excluded from both provider manifests and
  capability prose.
- The active mode cannot change during a running turn in either the webview or
  controller; queued turns retain their own mode, images, preset, and text.
- Legacy filesystem-search aliases remain executable for old transcripts but
  are not advertised as duplicate tools.

### Skills, tools, and delegated agents

- Full skill bodies are no longer injected automatically. The discovery
  description is capped at 8,000 characters and preserves exact skill names.
- Successful `Skill` activation is stored in a typed tool part and is
  re-projected after resume or compaction.
- Specialized plugin, MCP, remote, team, memory, and workflow tools are
  deferred through deterministic `ToolSearch`.
- Delegated agent role is a persistent system contract. Explore and plan roles
  default to read-only ask mode; a stricter parent narrows resume.
- Every textual tool result passes the shared output boundary: at most 2,000
  lines/50 KiB in the transcript, with an owner-scoped private artifact capped
  at 50 MiB and bounded `ToolOutputRead`.

### Compaction and model limits

- The automatic trigger is the minimum of 85% of the resolved model context
  window and a 20,000-token response reserve.
- Known MiniMax, Qwen, and GPT-5 family limits are resolved from catalog
  metadata or conservative local fallbacks.
- The summarizer input budget follows the resolved model window instead of a
  fixed 45,000-token cap.
- Compaction summarizes the older head, preserves a turn-aligned recent tail
  verbatim, and keeps the original JSONL journal entries for audit/recovery.
- CAS rejects a summary if history changes while the summarizer is running.
  Failure or incomplete output leaves the transcript untouched.

### CLI and VS Code surfaces

- CLI streaming uses stable message ids, replaces live drafts without duplicate
  final rows, and never exposes hidden reasoning through text previews.
- The real installed VSIX creates a fresh session and publishes a fresh context
  snapshot. Its status now uses the unique suffix of a local session id instead
  of displaying the identical `session_` prefix for every tab.
- The context indicator intentionally includes the provider-visible baseline
  tool schemas. A non-zero value in an empty session is therefore honest next
  request usage, not inherited chat history.

## Safe verification

- Pinned runtime: Node `24.18.0`.
- Monorepo typecheck: all six executable workspace packages passed.
- Workspace tests: **1,666 passed**:
  - core: 1,026
  - state: 119
  - VS Code webview: 23
  - CLI: 150
  - server: 103
  - VS Code extension: 245
- Production workspace build: passed, including `node:sqlite` dist-import
  checks.
- Runtime/storage/installer portability suite: **13/13 passed**.
- MCP and skills end-to-end validation: passed.
- VSIX packaging: passed; 168 files, 12.49 MB.
- Fresh VSIX installation into the local VS Code: passed.
- Real VS Code reload and new-session UI check: passed; the visible id changed
  from `5cc38094` to `e86c6220` and the blank session stayed empty.
- `nexus doctor --cwd /Users/mac/Projects/nexus/test`: Node, workspace, model,
  Git, and ripgrep checks passed.

No paid model call, destructive restore, arbitrary agent-authored shell
mutation, or real external plugin/MCP mutation was used in this pass.

## Honest remaining platform gaps

1. Local shell still lacks Codex-grade per-command kernel/seatbelt brokers.
2. Trusted plugin hooks still inherit host OS authority; the next security
   boundary is a capability-confined runner.
3. Complex multi-root editor workflows need deeper automated Extension Host
   coverage.
4. Multi-file ApplyPatch is one atomic accept/revert proposal; partial hunk
   acceptance must create a new proposal hash.
5. The VS Code controller remains large and should only be decomposed behind
   host-level behavioral tests.
