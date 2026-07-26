# Nexus Integrations and Subagents Hardening Plan

**Goal:** Make local plugins, MCP servers, skills, commands, hooks, and delegated agents real runtime capabilities with explicit trust, bounded failure behavior, and identical semantics in CLI, server, and VS Code.

**Reference priorities:** Codex and OpenClaude equally; Kilo next; Roo for MCP lifecycle, status, and restart patterns.

## Task 1: Establish a trusted plugin capability graph

- [ ] Canonically discover global/project/Claude-compatible manifests with deterministic precedence.
- [ ] Reject traversal and symlink escapes for every declared capability.
- [ ] Require runtime enablement and trust before plugin instructions, commands, agents, hooks, or MCP servers become active.
- [ ] Parse plugin MCP files per server so one invalid sibling does not discard valid servers.
- [ ] Load plugin commands into the same slash-command catalog as native commands.
- [ ] Add provenance and actionable diagnostics for every accepted or rejected capability.
- [ ] Test project precedence, trust, blocked plugins, symlink escape, invalid sibling isolation, commands, skills, agents, and MCP.

## Task 2: Replace the best-effort MCP client with a managed runtime

- [ ] Track connecting/connected/failed/needs-auth/disabled status and bounded error history per server.
- [ ] Add startup and tool-call timeouts, retry only transient remote startup failures, and always clean up failed transports.
- [ ] Make reconnect atomic so stale clients/tools cannot survive a failed refresh.
- [ ] Preserve MCP provenance instead of inferring it from `__` in a tool name.
- [ ] Recursively translate JSON Schema for arrays, enums, unions, nullable values, and additional properties.
- [ ] Respect read-only annotations, model-visibility metadata, tool-list change notifications, and bounded descriptions.
- [ ] Preserve structured/rich tool output without injecting unbounded binary data into prompts.
- [ ] Test stdio and HTTP lifecycle, timeout, reconnect, schema conversion, catalog replacement, resources, and auth state.

## Task 3: Make delegated agents inherit real runtime safety and capabilities

- [ ] Replace the auto-approving mock host with a delegated host backed by the parent host and permission boundary.
- [ ] Inherit MCP, plugins, rules, skills, mode restrictions, and durable run services.
- [ ] Add bounded nesting and fail-fast behavior that cannot deadlock the global concurrency pool.
- [ ] Remove abort listeners on completion and persist killed/failed/completed states distinctly.
- [ ] Atomically persist subagent snapshots and recover/list them after restart.
- [ ] Add stable task names/lineage, targeted messages, follow-up turns, interrupt, list, and event-driven wait semantics.
- [ ] Test denied writes/commands, server fail-closed behavior, MCP inheritance, nested saturation, abort, restart, and delivery ordering.

## Task 4: Close surface and lifecycle parity gaps

- [ ] Build one shared integration bootstrap used by CLI, server, VS Code, and subagents.
- [ ] Remove silent fallback-to-empty behavior; emit structured diagnostics while isolating optional failures.
- [ ] Ensure reload/dispose/config changes close old MCP transports and invalidate plugin catalogs exactly once.
- [ ] Render plugin, MCP, auth, and subagent states consistently in CLI and VS Code.
- [ ] Add cross-surface integration fixtures and executable census evidence.
- [ ] Run all tests, typechecks, builds, runtime checks, and commit each coherent layer.
