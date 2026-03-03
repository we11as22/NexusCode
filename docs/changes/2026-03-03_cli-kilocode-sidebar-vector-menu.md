# CLI: KiloCode-like Home/Prompt shell, command palette, and Nexus agent presets

**Date:** 2026-03-03
**Type:** feature

## What Changed

CLI TUI in `packages/cli/src/tui/App.tsx` was refactored to follow KiloCode Home/Prompt composition while staying wired to Nexus runtime events. The default screen now uses a centered logo + prompt shell + tip line + bottom path/version row, and slash commands render in a Kilo-like command palette panel. Prompt keybinds were aligned with this flow (`ctrl+p` opens command list from input).

The Settings Hub gained a dedicated `Vector index` menu field (`3`) with immediate toggle behavior. The remaining settings navigation was shifted to keep explicit sections for index management, advanced settings, help, and agent config presets.

Added a new slash-menu entry: `/agent-config`. It opens a dedicated view to:
- select and apply an existing agent preset;
- create a preset from current **skills + MCP servers + AGENTS/CLAUDE rules + vector state**;
- persist presets in `.nexus/agent-configs.json`.

Skill and rule candidates in this view are now auto-discovered from `SKILL.md` files (`.nexus/.agents` local + home) and from `AGENTS.md` file references, so preset creation can be driven directly from the same agent-discipline sources used by the project.

Applying a preset updates active runtime config (`indexing.vector`, `skills`, `mcp.servers`, `rules.files`, and optional model provider/id), so Nexus agent behavior changes immediately without leaving CLI.

Additional rendering stabilization was applied after initial rollout:
- slash command palette now uses fixed-width, single-line rows (ASCII-safe), preventing line overlap/garbling;
- slash `Enter` now resolves exact command matches first (e.g. `/settings`, `/model`) before fallback to selected row;
- model picker list now uses a fixed-window, fixed-width row renderer to avoid mixed-line artifacts during async catalog refresh.

## Why

The previous CLI UI drifted from the requested KiloCode structure (header/sidebar-heavy layout) and did not match expected Home/Prompt behavior. This change aligns first-screen interaction and slash-navigation visuals with Kilo-like patterns, while keeping all Nexus agent functionality.

## What This Replaces

Replaces the previous header+sidebar-heavy layout with a centered Kilo-like Home shell; keeps existing Nexus settings/index/advanced views and runtime wiring.

## Watch Out For

OpenTUI CLI runtime requires Bun. Running interactive TUI via Node directly will fail on `bun:` protocol imports.

## Related

- `packages/cli/src/tui/App.tsx`
- `README.md`
- `ARCHITECTURE.md`
