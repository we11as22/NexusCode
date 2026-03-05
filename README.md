# ⚡ NexusCode

**⚠️ Проект находится в разработке. Это не финальная версия.** Интерфейсы, поведение и документация могут меняться. Актуальное состояние — в [ARCHITECTURE.md](ARCHITECTURE.md) и [DOCS.md](DOCS.md).

> AI coding agent combining the best practices from Cline, Continue, KiloCode, OpenCode, Pi, and Roo-Code.

**VS Code extension + CLI** with:
- Modes: **agent** | **plan** | **debug** | **ask**
- **AST-based codebase indexing** (classes, functions, methods by language)
- **Optional semantic vector index** with embeddings + Qdrant auto-start (local binary/docker)
- **All LLM providers** including any OpenAI-compatible API
- **Model temperature control**
- **Parallel tool execution** (read operations run concurrently)
- **Doom loop detection** — no artificial step limits
- **Structured output** with JSON schema when supported by provider
- **Skill & tool classification** — smart context selection from large sets
- **Parallel sub-agents** for concurrent task execution
- **Shadow git checkpoints** with task/workspace restore
- **Two-level context compaction** (prune output → LLM summary with OpenCode-style structure)
- **MCP support** with OAuth and tool classification
- **Optional NexusCode Server**: DB-backed sessions and dialogs; extension and CLI can connect to the server, switch sessions, and avoid OOM on long chats (pagination)
- Beautiful Cline/agent-style UI: thought progress ("Thought for Xs"), loading states, todo checklist, diff-style tool output
- CLI TUI refactored to KiloCode-style Home + Prompt shell: centered logo/prompt/tips, Kilo-like slash command palette, and `Vector index` + `/agent-config` in menu

---

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System layers, key decisions, invariants, data flow, project layout.
- **[DOCS.md](DOCS.md)** — Full project documentation in Russian: installation, configuration reference, modes, indexing, tools, CLI, VS Code extension, MCP, skills, rules, troubleshooting.

---

## One-command CLI setup (after clone)

Clone the repo, then a **single command** installs everything; `nexus` can be run from anywhere afterward.

**Important:** use **Node 20** for both install and when running `nexus` (the native module `better-sqlite3` is tied to the Node version). For the TUI you also need **Bun** (OpenTUI runtime): `curl -fsSL https://bun.sh/install | bash`.

```bash
git clone <repo> NexusCode && cd NexusCode
nvm use 20          # or: nvm use (if .nvmrc exists)
pnpm run cli        # one command: install → rebuild native → build → install nexus to ~/bin
```

Add to `~/.bashrc` (or `~/.profile`) once:

```bash
export PATH="$HOME/bin:$PATH"
```

Then in **any** terminal and from **any** directory:

```bash
nexus
```

To update after code changes (with the same Node 20):

```bash
cd NexusCode && nvm use 20 && pnpm run cli
```

If on first run you see `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`, `nexus` is running under a different Node version than at install time. Run `nvm use 20` in that terminal and start `nexus` again. The wrapper in `~/bin/nexus` remembers the Node from install; if you switched nvm after install, reinstall with `pnpm run cli`.

---

## One-command full install (clean reinstall)

**The only up-to-date NexusCode build is from this repo.** The project uses a **local store** (`.npmrc` → `store-dir=.pnpm-store`), so there is no conflict with the global pnpm store.

From the repo root with **Node.js 20** (e.g. `nvm use 20`):

```bash
pnpm run one
```

This single command: removes `node_modules` and `.pnpm-store` → installs dependencies → builds native **better-sqlite3** → full build. Then run the CLI: `node packages/cli/dist/index.js` (or make a global command: `cd packages/cli && npm link`).

**Option “everything at once” (global CLI + .vsix extension):**

```bash
pnpm run ready
```

Does the same as `pnpm run one`, plus packages the extension and `npm link` for the `nexus` command. Result: **CLI** — `nexus` from any directory; **extension** — install `packages/vscode/nexuscode-0.1.0.vsix` in VS Code (Extensions → "…" → Install from VSIX).

**If `nexus` shows `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`** — you are running under a different Node version than the one used at build time. Use Node 20 (`nvm use 20`), run `pnpm run one` from the repo root, then start `nexus` again.

---

## Build and install (step by step)

### Two-command CLI start

From the repo root with **Node.js 20** (e.g. `nvm use`):

```bash
pnpm run setup
nexus
```

`pnpm run setup` runs: `pnpm install` → downloads prebuilt **better-sqlite3** binaries (`setup:native`) → `pnpm build`. For a clean install without store issues, prefer **`pnpm run one`** (full reinstall into the local store).

**If `setup:native` does not find a prebuilt binary** (e.g. uncommon platform) — you need build tools (python3, make, g++). After `pnpm install` run manually: `pnpm rebuild better-sqlite3`, then `pnpm build`.

CLI after setup: `node packages/cli/dist/index.js` (or `nexus` if you ran `cd packages/cli && npm link`).

### Full build: global `nexus` command + .vsix for testing

Easiest is the single command **`pnpm run ready`** (see above). Manually, the same steps:

```bash
nvm use
pnpm run fullbuild
cd packages/cli && npm link && cd ../..
```

Result: **CLI** — `nexus` is available globally; **extension** — `packages/vscode/nexuscode-0.1.0.vsix` (install via **Extensions** → "…" → **Install from VSIX...**). After later full builds, run `cd packages/cli && npm link` again.

### Requirements (versions)

| Requirement | Version | Note |
|-------------|---------|------|
| **Node.js** | **20+** | Required for build **and** for running `nexus` and `pnpm run serve`: the native module better-sqlite3 is tied to the Node version. If you see `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED` in a terminal with Node 18, run `nvm use 20` in that terminal and start `nexus` or `pnpm run serve` again. Packaging .vsix also requires Node 20 (vsce fails on Node 18). |
| **pnpm** | current | Recommended: `npm install -g pnpm` |

The repo has **`.nvmrc`** set to `20`. With nvm, run in the root: `nvm use`. Check Node: `node -v` (for .vsix packaging you need v20.x or higher). If Node &lt; 20: `nvm use 20` or install Node 20 from [nodejs.org](https://nodejs.org/).

---

### VS Code extension

#### 1. Clone and dependencies

From the repo root:

```bash
cd NexusCode
pnpm install
```

If in CI or with a strict lockfile: `pnpm install --no-frozen-lockfile`.

#### 2. Build

Build all packages (core, webview-ui, extension):

```bash
pnpm build
```

What runs:
- `packages/core` — agent engine build (tsup)
- `packages/vscode/webview-ui` — React UI build (Vite)
- `packages/vscode` — extension build (esbuild) and webview copy to `webview-ui/dist`

Build only the extension (if core is already built):

```bash
pnpm build:core && pnpm build:vscode
```

Or from the extension directory:

```bash
cd packages/vscode
pnpm build
```

#### 3. Package as .vsix

From the **repo root**:

```bash
pnpm package:vscode
```

This runs `pnpm build` and then packages the extension into a single file. The file is created in `packages/vscode/` as **`nexuscode-0.1.0.vsix`**.

**Node.js 20+** is required. If Node is below 20, the script will print an error and a hint.

To package only from the extension directory (if everything is already built):

```bash
cd packages/vscode
pnpm package
```

#### 4. Install in VS Code

**Option A — via VS Code UI**

1. Open VS Code.
2. Open **Extensions** (Ctrl+Shift+X / Cmd+Shift+X).
3. At the top of the panel click **"…"** → **Install from VSIX...**.
4. Choose the **full path** to the file, e.g.:
   - Windows: `C:\Users\...\NexusCode\packages\vscode\nexuscode-0.1.0.vsix`
   - Linux/macOS: `/home/user/NexusCode/packages/vscode/nexuscode-0.1.0.vsix`

**Option B — from terminal**

In the terminal (full or relative path to the `.vsix`):

```bash
code --install-extension /full/path/to/NexusCode/packages/vscode/nexuscode-0.1.0.vsix
```

Example from the repo directory:

```bash
code --install-extension "$(pwd)/packages/vscode/nexuscode-0.1.0.vsix"
```

**Restart VS Code** after installing. The NexusCode icon appears in the sidebar; open the panel with **Ctrl+Shift+N** (Cmd+Shift+N on Mac).

**Over SSH:** `code --install-extension` may behave differently; it is more reliable to install via **Extensions → … → Install from VSIX...**. The `.vsix` file must be available on **the machine where VS Code Server is running** (if needed, build and package the extension on the server and point to the local path).

#### 5. Extension development (without installing .vsix)

- Open the folder **`NexusCode/packages/vscode`** in VS Code.
- Press **F5** (Run → Start Debugging) — an **Extension Development Host** window opens with the extension loaded.
- After changes: rebuild from root with `pnpm build` (or `pnpm build` in `packages/vscode`), then press **Ctrl+R** (Cmd+R) in the Extension Development Host to reload.

Watch build (extension.js only, no webview):

```bash
cd packages/vscode && pnpm dev
```

---

### CLI (terminal)

Build and install the CLI for use in the terminal:

```bash
# From NexusCode root
pnpm install
pnpm build:cli
```

The binary and script end up in `packages/cli/dist/`. To run from any directory:

**Option 1 — via npm link (global `nexus` command):**

```bash
cd packages/cli
npm link
nexus --help
```

**Option 2 — run directly:**

```bash
node /full/path/to/NexusCode/packages/cli/dist/index.js --help
```

Or, if there is an executable script in `packages/cli`:

```bash
/full/path/to/NexusCode/packages/cli/dist/nexus --help
```

After `npm link`, the `nexus` command is available globally in the terminal.

---

## Configuration

By default NexusCode uses the **Nexus free-model gateway** with `minimax/minimax-m2.5:free`:

```yaml
model:
  provider: openai-compatible
  id: minimax/minimax-m2.5:free
  baseUrl: https://api.kilo.ai/api/gateway
```

No API key is required for the default free gateway route.

Override the model in `.nexus/nexus.yaml` in your project root, or use Settings in the extension / `--model` in CLI.

**Free model selection:** In the extension open **Settings → LLM → Select model**. In CLI use **/model** and pick from the catalog; free models are listed first and validated against the live gateway model list.

Example — keep default (free gateway):

```yaml
# Optional: only if you want to override defaults
model:
  provider: openai-compatible
  id: minimax/minimax-m2.5:free
  baseUrl: https://api.kilo.ai/api/gateway
```

Example — use another OpenRouter model or your own provider:

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-5
  temperature: 0.2
  # apiKey: from ANTHROPIC_API_KEY env var
```

Or OpenRouter with a different model:

```yaml
model:
  provider: openai-compatible
  id: anthropic/claude-sonnet-4
  baseUrl: https://openrouter.ai/api/v1
  # apiKey: from OPENROUTER_API_KEY env var
```

See `.nexus/nexus.yaml` for the complete reference.

---

## NexusCode Server (optional)

When you run the **NexusCode server**, sessions and messages are stored in a **SQLite database** (`~/.nexus/nexus-server.db`). The extension and CLI can connect to the server to use the same sessions, switch between them, and load messages in pages (no OOM on long dialogs).

### 1. Start the server

From the repo root:

```bash
pnpm build
pnpm serve
```

Or from `packages/server`:

```bash
cd packages/server && pnpm build && node dist/cli.js
```

The server listens on **http://127.0.0.1:4097** by default. Set `NEXUS_SERVER_PORT` or `PORT` to change the port. If you see **EADDRINUSE** (port already in use), stop the other process (e.g. `lsof -i :4097` then `kill <pid>`) or run with another port: `NEXUS_SERVER_PORT=4098 pnpm run serve`.

### 2. Extension: use the server

1. Open **Settings** in the NexusCode sidebar (or **Chat** → gear icon).
2. In **Agent Settings**, find the **NexusCode Server** section.
3. Set **Server URL** to `http://127.0.0.1:4097` (or your host/port).
4. Leave empty to run the agent in-process (no server).

When the server URL is set:
- **Sessions** tab loads the session list from the server (with a loading indicator).
- You can switch between sessions; messages are loaded from the server (last 100 per session).
- Each new message is sent to the server; replies are streamed back. All data is persisted in the server DB.

### 3. CLI: use the server

Set the server URL via option or env:

```bash
nexus --server http://127.0.0.1:4097
# or
NEXUS_SERVER_URL=http://127.0.0.1:4097 nexus
```

- `--continue` uses the most recent session from the server.
- `--session <id>` resumes a specific session.
- Only the last 100 messages are loaded into memory; the rest stay in the DB.

### 4. Run order (extension + CLI with server)

1. Start the server once: `pnpm serve`.
2. In VS Code: set **Settings → NexusCode Server → Server URL** to `http://127.0.0.1:4097`.
3. Use the extension (sessions and chat) or CLI (`nexus --server http://127.0.0.1:4097`) — they share the same DB and sessions.

---

## CLI Usage

```bash
# Interactive agent (default)
nexus

# With initial message
nexus "Refactor the auth module to use JWT"

# Specific mode
nexus plan "Design the database schema for a blog"
nexus debug "The tests are failing with timeout errors"
nexus ask "How does the caching layer work?"

# Different model
nexus --model openai/gpt-4o "Add TypeScript generics to this API"
nexus --model ollama/qwen2.5-coder:32b "..."
nexus --temperature 0.2 "Refactor with deterministic output"

# OpenAI-compatible provider
NEXUS_BASE_URL=http://localhost:1234/v1 nexus

# Resume last session
nexus --continue

# CI/CD (no approval prompts)
nexus --auto "Run tests and fix all failures"

# Print mode (non-interactive)
nexus -p "Summarize this codebase"
```

### Key Bindings (CLI TUI)
| Key | Action |
|-----|--------|
| Enter | Send message |
| Shift+Enter | Newline |
| Tab | Switch mode |
| Ctrl+S | Compact history |
| Ctrl+K | Clear chat |
| Ctrl+C | Abort / Quit |

### Slash Commands (CLI TUI)
| Command | Action |
|---------|--------|
| `/settings` | Open full settings hub |
| `/model` | Open model picker/form |
| `/embeddings` | Configure embeddings |
| `/index` | Index sync/stop/delete |
| `/sessions` | List and switch sessions |
| `/agent-config` | Select/create agent presets from discovered `SKILL.md`, MCP servers, and AGENTS/CLAUDE rules |

Agent presets are stored in `.nexus/agent-configs.json` and can be assembled from `AGENTS.md` skill file references plus local `.nexus/.agents` skill directories.

---

## Modes

| Mode | Permissions | Use for |
|------|-------------|---------|
| **agent** | Full (read+write+execute+browser+mcp) | General coding tasks |
| **plan** | Read + create .md plan files | Planning without touching code |
| **debug** | Full (focused on tracing bugs) | Finding and fixing bugs |
| **ask** | Read only | Questions and explanations |

---

## Rules & Skills

### Rules
Create `.nexus/rules/` with markdown files for project guidelines. These are loaded into every session.

Also supported: `CLAUDE.md`, `AGENTS.md` in project root.

### Skills
Place skill files in `.nexus/skills/skill-name/SKILL.md`. Skills provide domain-specific knowledge and patterns.

When many skills are configured, NexusCode uses LLM classification to select only relevant ones for the task — keeping the context clean.

---

## MCP Integration

```yaml
# .nexus/nexus.yaml
mcp:
  servers:
    - name: github
      command: npx
      args: [-y, "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"
    - name: my-service
      url: "http://localhost:3100/mcp"
    # Bundled: Context Mode (saves ~98% context — sandboxed execute, FTS5 search, batch_execute)
    - name: context-mode
      bundle: context-mode
```

When many **MCP servers** are configured, you can enable "Filter MCP servers when list is large" in Settings (Tools tab). The classifier then selects which **servers** to use for the task; all tools from selected servers are included. Built-in tools are always available.

### Context Mode (bundled)

NexusCode includes **[claude-context-mode](sources/claude-context-mode)** (MCP + plugin for context compression). It reduces tool output in the context window by running code in a sandbox and returning only stdout, and provides FTS5/BM25 search, `batch_execute`, and session stats.

- **Enable:** add `{ "name": "context-mode", "bundle": "context-mode" }` to `mcp.servers` in `.nexus/nexus.yaml` or `.nexus/mcp-servers.json`. When running from the NexusCode repo (CLI, server, or extension F5), the bundle is resolved to `sources/claude-context-mode/start.mjs` and `CLAUDE_PROJECT_DIR` is set to the project cwd.
- **Build:** `pnpm build` runs `build:context-mode` (install + build + optional bundle in `sources/claude-context-mode`). Ensure Node 18+ there for `better-sqlite3`.
- **Use cases:** large log/JSON/Playwright output → only summaries in context; multi-query search via `search(queries: [...])`; repo research via `batch_execute`. See [sources/claude-context-mode/README.md](sources/claude-context-mode/README.md) for tools and security (permissions).

---

## Codebase Indexing

NexusCode indexes your codebase on startup (incremental updates on file save):

- **Symbols**: classes, functions, methods, interfaces, types, enums (via AST)
- **FTS**: SQLite FTS5 for keyword search
- **Vector** (optional): semantic search via Qdrant + embeddings (auto-start supported via `vectorDb.autoStart`)

Use `codebase_search` tool or `@problems` in chat to leverage the index.

---

## Architecture

```
NexusCode/
├── packages/
│   ├── core/              ← Provider-agnostic agent engine
│   │   ├── agent/        ← Agent loop, modes, classifiers (MCP servers + skills), prompts
│   │   ├── tools/        ← Tool registry + built-in tools
│   │   ├── session/     ← JSONL storage + compaction
│   │   ├── indexer/     ← AST + FTS + Qdrant
│   │   ├── provider/    ← All LLM providers + embeddings
│   │   ├── checkpoint/  ← Shadow git
│   │   ├── context/     ← @mentions, rules, condense
│   │   ├── skills/      ← Skill loader + classifier
│   │   └── mcp/         ← MCP client
│   ├── vscode/          ← VS Code extension + React UI
│   ├── cli/             ← CLI + TUI (OpenTUI/React)
│   └── server/          ← Optional: SQLite sessions, streaming API
└── .nexus/               ← Project config (nexus.yaml, agent-configs.json, rules, skills)
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for details.

---

## Key Design Decisions

1. **No step limits** — Doom loop detection (3 identical consecutive calls) prevents infinite loops
2. **Built-in tools always active** — Mode permissions gate which tools are available; the classifier filters by **MCP server** (and by skill) when thresholds are exceeded, not by individual tools.
3. **Parallel reads** — Multiple read-only tools execute concurrently with `Promise.all`
4. **Cache-aware prompts** — Stable blocks (role, rules, skills) use `cache_control: ephemeral` on Anthropic
5. **Two-level compaction** — Fast prune (remove old tool outputs) + LLM compact (full summary) from OpenCode
6. **Multi-project** — Separate FTS/vector indices per project hash in `~/.nexus/index/`

---

## Further Reading

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System layers, controller pattern, MCP server filtering, invariants, data flow, project layout, dependencies, version requirements.
- **[DOCS.md](DOCS.md)** — Full documentation (Russian): config reference, modes, indexing, tools, CLI, VS Code, MCP, skills, rules, troubleshooting.
- **Semantic changes:** `docs/changes/`

---

## License

MIT
