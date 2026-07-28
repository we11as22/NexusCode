# Nexus Turn Contract and Surface Parity Checkpoint — 2026-07-28

This checkpoint records executable behavior, not documentation-only claims.

## Source-backed decisions

- **Codex:** an active turn owns one immutable mode; interaction-level mode
  cycling is unavailable while the task runs.
- **Kilo and Kimi Code:** every queued prompt is a complete next-turn payload,
  not only a string. Nexus snapshots text, images, mode, preset, identity and
  ordering.
- **OpenClaude:** plan handoff is a guarded workflow, capability descriptions
  follow the real surface, and a plan must be materialized before exit.
- **Roo/Cline:** extension activity, terminal state and diff review belong in
  native editor surfaces, but authority remains in the shared backend.

Nexus deliberately does not add a second global `nextMode` state machine.
The selector is disabled during a run. A queued turn carries its own mode and
becomes the selected mode only when that exact turn starts.

## Implemented

### Core

- The exact resolved tool names are projected into prompt construction.
- Constrained modes receive a capability-specific tool guide rather than
  generic instructions for unavailable tools.
- Configured mode `systemPrompt` and `customInstructions` are included while
  remaining unable to expand the enforced permission boundary.
- PLAN blocks shell, MCP authentication and memory mutation; it permits
  read-only discovery/memory plus plan-file/workflow operations.
- `PlanExit` now enforces its mode and completed plan-file write inside the
  tool itself, including synthetic/nested execution paths. Failed synthetic
  or explicit exit is not reported as successful completion and cannot clear
  the active plan todo state.
- Background execution ids and large-output artifact capabilities persist in
  transcript tool parts.

### VS Code

- Enter during a run queues a follow-up instead of silently doing nothing.
- Queue items preserve text, images, mode and preset through reorder, edit,
  admission failure and automatic drain.
- Mode selection is disabled for the duration of the active turn.
- Modern task and background events have a visible bounded activity surface.
- Bash cards show command, cwd, background id, duration, exit status, bounded
  output and the opaque full-output capability without exposing private paths.
- Exploring/Explored rows use one stable key and become `Explored` when their
  own activity completes, even if a later part of the same run is active.
- Proposed edits use Reject/Apply language; applied edits use Revert/Keep;
  Git colors inherit the VS Code theme.
- Light/dark/high-contrast colors inherit host variables rather than forcing
  a dark color scheme.
- The dead duplicate chat render projection and duplicate subagent reducer were
  removed from the executed component/store paths.

### CLI

- Shift+Tab mode cycling is unavailable while a turn is running.
- Created/updated/progress/tool/completed/background task events are projected
  into terminal activity banners.
- The installer discovers the pinned Node runtime even when the invoking shell
  currently resolves Node 20.

## Safe verification

- Workspace test suite: **1,580 passed** across core, state, CLI, server,
  extension and webview packages.
- TypeScript typecheck: all packages passed.
- Runtime/SQLite/portability/feature-census tests: **12 passed**.
- Production workspace build: passed.
- MCP and skills workflow validation: passed.
- VSIX packaging: passed; produced
  `packages/vscode/nexuscode-0.1.0.vsix`.
- Installer smoke: invoked from the ordinary shell, selected
  `/Users/mac/.nvm/versions/node/v24.18.0/bin/node`, built core/CLI and created
  a temporary wrapper.
- First-run mutation through that wrapper created `config.json` in an isolated
  `NEXUS_CONFIG_DIR`; directory mode was `0700`, file mode `0600`, JSON was
  valid, and the wrapper reported version `0.1.0`.
- No paid LLM call, real external MCP/plugin mutation, arbitrary agent command,
  destructive workspace restore or user-profile state mutation was used.

## Honest remaining platform gaps

1. Local shell commands still lack Codex-grade kernel/seatbelt sandbox brokers;
   application policy, path confinement and approvals are present.
2. Trusted plugin hooks still share host OS authority; a separate
   capability-confined worker is the next security boundary.
3. Real VS Code Extension Host automation and complex multi-root coverage are
   shallower than the core/server integration suite.
4. A multi-file patch is intentionally one atomic accept/revert proposal;
   selective hunk acceptance requires generating a new proposal hash.
5. The VS Code controller remains large and should be decomposed only behind
   behavioral tests.
