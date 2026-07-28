# NexusCode First-Run and Product Audit Design

**Date:** 2026-07-28  
**Status:** Approved direction

## Goal

Make a clean installation of NexusCode usable on the first launch, then validate
the complete CLI and VS Code workflows against the source agents in
`source_projects`. Fix demonstrated product defects without copying source
projects blindly or introducing a second architecture.

## Source-selection rule

Every important mechanism must have a working analogue in at least one source
agent. The implementation chosen for NexusCode is the one that best fits its
shared-core architecture:

- Codex and OpenClaude are the primary references for agent-loop correctness,
  durable sessions, permissions, compaction, secrets, and host boundaries.
- Kilo Code is a primary reference for extension workflows, modes, MCP, diff
  review, settings, and VS Code lifecycle.
- Roo Code is a reference for extension services and vector-index integration,
  but its UI/backend coupling is not copied into the core.
- Kimi Code and Kimi CLI are first-class references for ACP-style transport,
  atomic JSON state, streaming tool-call identity, background MCP startup,
  session forks, approvals, and subagents.
- MiMo Code and OpenCode are references for typed event/session services,
  SQLite-backed structured state where justified, tool execution, and terminal
  UX. SQLite is not introduced merely because a source uses it.
- Qwen Code, Cline, and Claw Code are secondary references for headless
  operation, settings, tool presentation, hooks, and plugin ergonomics.

## Configuration and local state

NexusCode keeps one canonical product configuration:

- project: `.nexus/nexus.yaml`;
- global: `~/.nexus/nexus.yaml`;
- secrets: the surface-owned secret store;
- CLI presentation state: a small local JSON document.

The inherited CLI `config.json` is treated as presentation and compatibility
state only. It may contain onboarding, theme, terminal display preferences,
history, workspace trust identities, and transient usage metadata. It must not
be the authority for model/provider, MCP, skills, modes, or permissions.

First-run writes must:

1. create the parent directory with owner-only permissions;
2. reject writes through a symlink;
3. serialize writers;
4. write through a same-directory temporary file and atomic rename;
5. use owner-only file permissions;
6. preserve a readable legacy document where possible;
7. never persist an API key in presentation state.

Legacy `primaryApiKey` is ignored by normal Nexus authentication and removed on
the next state mutation. The canonical CLI secrets store remains the only
persistent API-key authority.

## Workflow validation

Validation follows user-visible paths rather than isolated modules:

1. empty home → install → first launch;
2. onboarding and workspace trust;
3. provider/model setup and secret persistence;
4. new, resumed, compacted, cancelled, and failed turns;
5. tool approval, execution, output storage, retry, and denial;
6. edits → durable change set → diff → accept/reject/revert;
7. MCP/skills/plugins discovery, activation, invocation, and reconnect;
8. root agent → subagent delegation → result/lifecycle propagation;
9. CLI rendering, print/headless behavior, and exit;
10. extension activation → webview transport → settings → agent events;
11. extension diff, approval, terminal, memory, and disposal flows;
12. crash/restart recovery and concurrent-writer behavior.

Tests use temporary homes/workspaces and mocked providers. Real model calls,
destructive shell commands, and changes outside the temporary workspace are not
part of validation.

## Audit output

The audit produces a Markdown comparison matrix covering all source projects
and all requested product layers. Each adopted design records:

- source analogue;
- source strength;
- source weakness or incompatibility;
- NexusCode implementation;
- verification evidence;
- remaining limitation, if any.

Only verified behavior is described as implemented. Documentation-only claims
are marked separately from tested capabilities.

