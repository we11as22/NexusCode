# Integration comparison: Plugins, Rules, Skills, MCP, Agent profiles

Comparison of NexusCode with OpenCode, KiloCode, Cline, and Roo-Code for plugins, rules (AGENTS.md / CLAUDE.md), skills, MCP servers, and agent profiles. Goal: same settings can be managed and toggled in both the extension and the CLI, and agent profiles can be configured and selected.

---

## 1. Plugins

| Repo        | Concept | Config | Extension UI | CLI UI |
|------------|---------|--------|--------------|--------|
| **OpenCode** | `plugin` array (file URLs, npm specifiers) | `config.plugin` | — | Status dialog (read-only list) |
| **KiloCode** | Same as OpenCode | Same | — | Same |
| **Cline**   | No plugins | — | — | — |
| **Roo-Code** | No generic plugins; marketplace for MCP/modes | — | — | — |
| **NexusCode** | No plugin array | — | — | — |

**NexusCode:** We do not have an OpenCode-style plugin system (loadable npm/file plugins). Our extensibility is via **skills** (SKILL.md), **MCP servers**, and **rules**. No change planned unless we add a plugin loader.

---

## 2. Rules (AGENTS.md, CLAUDE.md, instruction files)

| Repo        | Config key | Loading | Extension UI | CLI UI |
|------------|------------|---------|--------------|--------|
| **OpenCode** | `instructions` (paths, globs, URLs) | Fixed AGENTS.md, CLAUDE.md + `instructions` | — | Tips only |
| **KiloCode** | `instructions` (+ migration from rules) | Same + Kilo rules migration | Agent Behaviour → Rules (instruction files list) | — |
| **Cline**   | Per-source toggles (Cline, Cursor, Windsurf, AGENTS) | .clinerules, .cursor/rules, AGENTS.md | Rules modal with per-file toggles | — |
| **Roo-Code** | .roo/rules, .roo/rules-{mode}, AGENTS.md | Mode + path; `useAgentRules` gating | Context Management (no per-rule toggles) | — |
| **NexusCode** | `rules.files` (e.g. CLAUDE.md, AGENTS.md, .nexus/rules/**) | `loadRules(cwd, rules.files)`; walk-up + glob + global ~/.nexus/rules | Settings → Integrations → Rules & Skills; Instructions tab (rules files list); CLAUDE.md path | Settings → Advanced: Rules files (one per line), CLAUDE.md path |

**NexusCode behaviour:**

- **Config:** `rules.files` array. Default includes `CLAUDE.md`, `AGENTS.md`, `.nexus/rules/**`. Merged with global `~/.nexus/rules/**`.
- **Extension:** Integrations tab → Rules & Skills; rules list and CLAUDE.md path; Apply saves to config. All listed files are loaded (no per-file toggle).
- **CLI:** Advanced form: “Rules files (one per line)”, “CLAUDE.md path”. Save updates `config.rules.files`. Same config as extension; changes apply to next run.
- **Dynamic:** Yes. Changing rules in Settings (extension or CLI) and saving updates in-memory config; next message uses new rules.

---

## 3. Skills

| Repo        | Config | Toggle | Extension UI | CLI UI |
|------------|--------|--------|--------------|--------|
| **OpenCode** | `skills.paths`, `skills.urls` | No global on/off; skill tool chooses at runtime | — | Skills dialog (list, pick to insert) |
| **KiloCode** | Same | Permission-based | Agent Behaviour → Skills (paths, urls) | Same |
| **Cline**   | Dirs under .cline/.agents/.clinerules | Per-skill toggle (state) | Rules modal → Skills tab, toggles | CLI Skills panel |
| **Roo-Code** | .roo/skills, .agents/skills (+ mode) | By mode (no per-skill toggle) | Settings → Skills (CRUD, mode association) | — |
| **NexusCode** | `skills` (paths), normalized `skillsConfig` (path + enabled) | Per-skill `enabled` in config | Settings → Integrations → Skills: list with enable/disable per path | Settings → Advanced: “Skills (one per line)” (list only; remove line = remove skill) |

**NexusCode behaviour:**

- **Config:** `skills` array (paths). Normalized to `skillsConfig: { path, enabled }[]`; only `enabled: true` are passed to the agent.
- **Extension:** Integrations → Skills: add/remove paths, toggle each skill (enabled/disabled). Saves `skillsConfig`; backend normalizes to `skills`.
- **CLI:** Advanced → “Skills (one per line)”. Saves `skills` only (all treated as enabled). No per-skill checkbox in CLI; remove a line to drop a skill.
- **Dynamic:** Yes. Changes in extension or CLI apply to next run.

**Gap:** CLI has no per-skill enable/disable (no `skillsConfig` in Advanced form). Workaround: remove a path from the list to “disable” it.

---

## 4. MCP servers

| Repo        | Config | Per-server enabled | Extension UI | CLI UI |
|------------|--------|--------------------|--------------|--------|
| **OpenCode** | `mcp` record (name → local/remote) | `enabled` in config; connect/disconnect at runtime | — | MCP dialog: list, Space toggles connect |
| **KiloCode** | Same | Same | Agent Behaviour → MCP (read-only list) | Same |
| **Cline**   | cline_mcp_settings.json | `disabled` per server | ServersToggleModal + McpConfigurationView | — |
| **Roo-Code** | Global + project mcp JSON | `disabled`; global MCP on/off | McpView: enable/disable, per-tool toggles; Marketplace | — |
| **NexusCode** | `mcp.servers[]` (name, command/url, `enabled`) | `enabled` per server (default true) | Settings → Integrations → MCP Configure: checkbox per server, Add/Remove, Test, raw JSON | Settings → Advanced: MCP servers JSON (edit JSON; set `"enabled": false` to disable) |

**NexusCode behaviour:**

- **Config:** `mcp.servers` array; each entry may have `enabled: boolean` (default true). Core and MCP client skip `enabled === false`.
- **Extension:** MCP Configure: one checkbox per server (enabled/disabled), Add/Remove, Test, “Edit raw JSON”. Saves full `mcp.servers` including `enabled`.
- **CLI:** Advanced: single “MCP servers JSON” field. To disable a server, set `"enabled": false` in its object and save.
- **Dynamic:** Yes. Toggling in extension or editing JSON in CLI and saving updates config; reconnection uses new list.

---

## 5. Agent profiles / presets

| Repo        | Concept | Extension UI | CLI UI |
|------------|---------|--------------|--------|
| **OpenCode** | `agent` record + `default_agent`; built-in + .md from dirs | — | Agent list dialog; cycle keybinds |
| **KiloCode** | Same + custom modes migration | Agent Behaviour → Agents (default + per-agent edit) | Same |
| **Cline**   | Subagent YAML in ~/Documents/Cline/Agents | No profile selector; subagents via tool call | — |
| **Roo-Code** | Modes (built-in + custom_modes.yaml / .roomodes) | ModesView: select, create, edit, export/import | — |
| **NexusCode** | (1) **Model profiles** `profiles` (name → model overrides); (2) **Agent presets** (CLI) vector+skills+MCP+rules bundle | Profile dropdown (Default + profile names); Settings → Profiles (JSON) | Profile dropdown (default + profileNames); /agent-config: presets (create/apply/delete) |

**NexusCode behaviour:**

- **Model profiles**
  - **Config:** `profiles`: record of name → `{ provider?, id?, apiKey?, baseUrl?, temperature? }`. Applied on top of default model.
  - **Extension:** Chat header Profile dropdown (Default + keys of `config.profiles`). Settings → Profiles: edit JSON. Selecting a profile sends `setProfile`; controller applies that profile to `config.model` and posts `configLoaded`.
  - **CLI:** Profile dropdown in sidebar (default + `profileNames` from config). `onProfileSelect` updates `config.model`, refreshes snapshot, re-renders. Next run uses selected profile.
  - **Dynamic:** Yes. Changing profile in extension or CLI applies immediately to the next message.

- **Agent presets (CLI only)**
  - **Storage:** `.nexus/agent-configs.json` (name, vector, skills, mcpServers, rulesFiles, createdAt).
  - **CLI:** /agent-config: create preset from discovered skills/MCP/rules and vector toggle; list presets; apply preset (writes vector, skills, mcp, rules into config via `saveConfig`); delete preset.
  - **Extension:** No agent presets (no bundle of vector+skills+MCP+rules). Only model profiles. Possible future: “Agent presets” view similar to CLI.

---

## 6. Summary: what works in NexusCode

| Area | Extension | CLI | Dynamic |
|------|-----------|-----|--------|
| **Rules** | Integrations → Rules & Skills + Instructions; edit list, CLAUDE path | Advanced: rules files, CLAUDE path | Yes |
| **Skills** | Integrations → Skills: list + per-skill enable/disable | Advanced: skills list (no per-skill toggle) | Yes |
| **MCP** | Integrations → MCP Configure: list, per-server enabled, Add/Remove, Test, JSON | Advanced: MCP JSON (`"enabled": false` to disable) | Yes |
| **Model profiles** | Profile dropdown + Settings → Profiles JSON | Profile dropdown + Advanced → Profiles JSON | Yes |
| **Agent presets** | — | /agent-config: create/apply/delete presets (vector+skills+MCP+rules) | Yes (on apply) |

All of the above settings can be changed during a dialog; saving updates in-memory config (and, where applicable, disk); the next message uses the updated rules, skills, MCP, and model profile. Agent presets in CLI apply immediately when “Apply” is used.

---

## 7. References

- **NexusCode:** `packages/core/src/config/schema.ts`, `packages/core/src/context/rules.ts`, `packages/core/src/skills/manager.ts`, `packages/core/src/mcp/client.ts`, `packages/vscode/webview-ui/src/App.tsx` (Integrations, Profiles), `packages/cli/src/tui/App.tsx` (Advanced, agent-config, profile dropdown), `packages/cli/src/index.ts` (configSnapshot, saveConfig).
- **OpenCode:** plugins/rules/skills/MCP/agents in config + TUI dialogs (see explore summary).
- **KiloCode:** same core + kilo-vscode Agent Behaviour tab.
- **Cline:** Rules modal, skills toggles, MCP config view.
- **Roo-Code:** Context Management, Skills settings, McpView, ModesView.
