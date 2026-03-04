# Context Mode (claude-context-mode) integration

## Summary

Integrated the **claude-context-mode** MCP and plugin (from `sources/claude-context-mode`) into NexusCode so it can be used as a bundled MCP server across CLI, server, and VS Code extension.

## Changes

- **Core**
  - `McpServerConfig` and schema: added optional `bundle?: string`.
  - New `resolveBundledMcpServers(servers, { cwd, nexusRoot })` in `packages/core/src/mcp/resolve-bundled.ts`. When `bundle === "context-mode"`, resolves to `node <nexusRoot>/sources/claude-context-mode/start.mjs` with `env.CLAUDE_PROJECT_DIR = cwd`. If `nexusRoot` is missing or `start.mjs` is absent, bundled entries are skipped.
- **Server** (`packages/server/src/run-session.ts`)
  - Before MCP `connectAll`, resolves servers via `resolveBundledMcpServers`, sets `process.env.CLAUDE_PROJECT_DIR = cwd`, connects with resolved list. `NEXUS_ROOT` derived from `import.meta.url` (packages/server/dist → repo root).
- **CLI** (`packages/cli/src/index.ts`)
  - Same resolution and `CLAUDE_PROJECT_DIR` in all three MCP connect paths: non-interactive run, initial TUI connect, and `reconnectMcpServers()`. `NEXUS_ROOT` from `import.meta.url` (packages/cli/dist).
- **VS Code** (`packages/vscode/src/controller.ts`)
  - `getNexusRoot()`: `path.resolve(extensionPath, "..", "..")` and check for `sources/claude-context-mode/start.mjs` (so bundled context-mode only when running from repo, e.g. F5). `getResolvedMcpServers()` uses `resolveBundledMcpServers` with that root. `reconnectMcpServers()` and `testMcpServers` use resolved list and set `CLAUDE_PROJECT_DIR`.
- **Build**
  - Root `package.json`: `build:context-mode` script (cd `sources/claude-context-mode`, npm install, build, optional bundle). Main `build` runs `build:context-mode` first.
- **Config**
  - Repo `.nexus/nexus.yaml`: `mcp.servers` includes `{ name: "context-mode", bundle: "context-mode" }`.
- **Docs**
  - README: MCP section updated with bundle example and “Context Mode (bundled)” subsection (how to enable, build, use cases, link to context-mode README).
  - ARCHITECTURE: note on bundled MCP and `resolveBundledMcpServers`.

## Use cases covered

- **CLI / Server / Extension (from repo):** With `bundle: "context-mode"` in config, context-mode MCP starts with correct project dir; tools like `execute`, `batch_execute`, `search`, `fetch_and_index`, `index`, `stats` are available and reduce context usage.
- **Extension from .vsix:** No `sources/` next to extension; `getNexusRoot()` returns null, bundled context-mode is skipped; users can still add context-mode via absolute path in `mcp.servers` if they install it separately.
- **Security:** Context-mode reads `.claude/settings.json` (and project `.claude/`) for deny/allow; NexusCode does not change that. Project-level permissions remain in `.nexus/settings.json` / `settings.local.json` for NexusCode tools.

## Invariants

- Hosts never pass raw `config.mcp.servers` to `connectAll` when resolution is possible; they use `resolveBundledMcpServers` and pass resolved list so `CLAUDE_PROJECT_DIR` is set for bundled servers.
- If `bundle` is set and resolution fails (no nexusRoot or missing start.mjs), that server is omitted from the resolved list (no crash).
