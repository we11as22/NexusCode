# Max mode removed

Max mode and all its artifacts have been removed from the codebase.

## Removed

- **Core**: `MaxModeConfig` type, `maxMode` from `NexusConfig`, schema `maxMode` block, `NEXUS_MAX_MODE` / `NEXUS_MAX_TOKEN_MULTIPLIER` env handling, `MAX_MODE_BLOCK` and `maxMode` from prompts, tool/iteration multipliers and token multiplier in the agent loop.
- **CLI**: `--max-mode` option, `config.maxMode` usage, timeout based on max mode, `onMaxModeChange` / `initialMaxMode`, `/max` slash command, Ctrl+M, `maxMode` in App state and InputBar, Max Mode row in Help and advanced config.
- **VS Code**: `setMaxMode` message, `maxMode` in `WebviewState`, Controller `maxMode` state and all references, ModeSelector Max toggle, chat store `maxMode` / `setMaxMode`, settings form Max Mode section, `nexuscode.maxModeEnabled` and `nexuscode.maxModeTokenBudgetMultiplier` contribution points.
- **Server**: `configOverride?.maxMode` in `run-session.ts`.
- **Docs**: Max Mode mentions and options in README, DOCS.md, ARCHITECTURE.md; `maxMode` block in `.nexus/nexus.yaml` example.

## Still present (historical)

- `docs/changes/2026-02-28_maxmode-openrouter-subagents-vector-batching.md` and other change logs that describe the previous max mode behavior are kept for history.
