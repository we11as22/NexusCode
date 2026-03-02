# ⚡ NexusCode

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

---

## Установка в одну команду (как OpenCode)

**Актуальная версия NexusCode — только из этого репо.** Одна и та же сборка поддерживает запуск без сервера и с сервером (`--server`). Если раньше ставили `nexus` глобально не отсюда — удали: `npm uninstall -g nexus 2>/dev/null || true`.

Из корня репозитория, в среде с **Node.js 20** (например `nvm use`):

```bash
pnpm run ready
```

Одна команда делает: установка зависимостей → пресобранные бинарники **better-sqlite3** → полная сборка → упаковка расширения **.vsix** → глобальная команда `nexus`. После этого:

- **CLI:** из любого каталога запускай `nexus`.
- **Расширение:** установи в VS Code файл `packages/vscode/nexuscode-0.1.0.vsix` (**Extensions** → «…» → **Install from VSIX...**).

Если pnpm выдаёт `Unexpected store location`, один раз задай store и снова запусти:  
`pnpm config set store-dir <путь из ошибки> --global` → `pnpm run ready`.

**Если при запуске `nexus` появляется ошибка про `NODE_MODULE_VERSION` или `ERR_DLOPEN_FAILED`** — в этом терминале используется Node 18, а сборка была под Node 20. Выполни в том же терминале: `nvm use 20`, затем снова `nexus`. Сервер (`pnpm run serve`) тоже нужно запускать с Node 20.

---

## Сборка и установка (по шагам)

### Запуск за две команды (CLI)

Из корня репозитория, в среде с **Node.js 20** (например `nvm use`):

```bash
pnpm run setup
nexus
```

Команда `pnpm run setup` делает: `pnpm install` → загрузка пресобранных бинарников **better-sqlite3** (`setup:native`) → `pnpm build`. После этого `nexus` запускает CLI (если делал `npm link` из `packages/cli`), иначе: `node packages/cli/dist/index.js`.

**Если pnpm выдаёт `Unexpected store location`** — один раз укажи store, откуда уже стоят пакеты (путь из сообщения об ошибке), затем снова запусти setup:

```bash
pnpm config set store-dir /root/.local/share/pnpm/store/v10 --global
pnpm run setup
nexus
```

**Если `setup:native` не находит пресобранный бинарь** (например, редкая платформа) — нужны инструменты сборки (python3, make, g++). Тогда после `pnpm install` выполни вручную: `pnpm rebuild better-sqlite3`, затем `pnpm build`.

Запуск CLI после setup: `node packages/cli/dist/index.js` (или `nexus`, если сделал `cd packages/cli && npm link`).

### Полный билд: глобальная команда `nexus` + .vsix для теста

Проще всего — одна команда **`pnpm run ready`** (см. раздел выше). Вручную то же самое:

```bash
nvm use
pnpm run fullbuild
cd packages/cli && npm link && cd ../..
```

После этого: **CLI** — команда `nexus` доступна глобально; **расширение** — `packages/vscode/nexuscode-0.1.0.vsix` (установка: **Extensions** → «…» → **Install from VSIX...**). После следующих полных билдов достаточно снова выполнить `cd packages/cli && npm link`.

### Требования (версии)

| Что | Версия | Заметка |
|-----|--------|---------|
| **Node.js** | **20+** | Обязательно для сборки, **и для запуска** `nexus` и `pnpm run serve`: нативный модуль better-sqlite3 привязан к версии Node. Если в терминале Node 18 и вы видите ошибку `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED` — выполните в этом же терминале `nvm use 20` и снова запустите `nexus` или `pnpm run serve`. Для упаковки .vsix тоже нужен Node 20 (в Node 18 vsce падает). |
| **pnpm** | актуальная | Рекомендуется: `npm install -g pnpm` |

В репозитории есть **`.nvmrc`** с версией `20` — при использовании nvm достаточно выполнить в корне:
```bash
nvm use
```
Проверка Node:
```bash
node -v   # для упаковки .vsix должно быть v20.x или выше
```
Если Node &lt; 20: `nvm use 20` или установи Node 20 с [nodejs.org](https://nodejs.org/).

---

### VS Code расширение

#### 1. Клонирование и зависимости

Из корня репозитория:

```bash
cd NexusCode
pnpm install
```

Если в CI или при жёстком lockfile: `pnpm install --no-frozen-lockfile`.

#### 2. Сборка

Собрать все пакеты (core, webview-ui, расширение):

```bash
pnpm build
```

Что происходит:
- `packages/core` — сборка движка агента (tsup)
- `packages/vscode/webview-ui` — сборка React-интерфейса (Vite)
- `packages/vscode` — сборка расширения (esbuild) и копирование webview в `webview-ui/dist`

Сборка только расширения (если core уже собран):

```bash
pnpm build:core && pnpm build:vscode
```

Или из каталога расширения:

```bash
cd packages/vscode
pnpm build
```

#### 3. Упаковка в .vsix

Из **корня** репозитория:

```bash
pnpm package:vscode
```

Эта команда выполняет `pnpm build` и затем упаковывает расширение в один файл.  
Файл создаётся в `packages/vscode/` с именем **`nexuscode-0.1.0.vsix`**.

Требуется **Node.js 20+**. Если версия Node меньше 20, скрипт выведет ошибку и подсказку.

Упаковка только из каталога расширения (если всё уже собрано):

```bash
cd packages/vscode
pnpm package
```

#### 4. Установка в VS Code

**Способ A — через интерфейс VS Code**

1. Открой VS Code.
2. Панель **Extensions** (Ctrl+Shift+X / Cmd+Shift+X).
3. Вверху панели нажми **«…»** → **Install from VSIX...**.
4. Укажи **полный путь** к файлу, например:
   - Windows: `C:\Users\...\NexusCode\packages\vscode\nexuscode-0.1.0.vsix`
   - Linux/macOS: `/home/user/NexusCode/packages/vscode/nexuscode-0.1.0.vsix`

**Способ B — из терминала**

В терминале (путь к `.vsix` — полный или относительный):

```bash
code --install-extension /полный/путь/к/NexusCode/packages/vscode/nexuscode-0.1.0.vsix
```

Пример из каталога репозитория:

```bash
code --install-extension "$(pwd)/packages/vscode/nexuscode-0.1.0.vsix"
```

После установки **перезапусти VS Code**. В боковой панели появится иконка NexusCode; панель открывается по **Ctrl+Shift+N** (Cmd+Shift+N на Mac).

**При работе через SSH:** команда `code --install-extension` может вести себя иначе; надёжнее установить расширение через меню **Extensions → … → Install from VSIX...**. Файл `.vsix` должен быть доступен на **той машине, где запущен VS Code Server** (при необходимости собери и упакуй расширение на сервере и укажи локальный путь к нему).

#### 5. Разработка расширения (без установки .vsix)

- Открой в VS Code папку **`NexusCode/packages/vscode`**.
- Нажми **F5** (Run → Start Debugging) — откроется окно **Extension Development Host** с загруженным расширением.
- После изменений: пересобери из корня `pnpm build` (или `pnpm build` в `packages/vscode`), затем в окне Extension Development Host нажми **Ctrl+R** (Cmd+R) для перезагрузки расширения.

Сборка в watch-режиме (только extension.js, без webview):

```bash
cd packages/vscode && pnpm dev
```

---

### CLI (терминал)

Сборка и установка CLI для использования в терминале:

```bash
# Из корня NexusCode
pnpm install
pnpm build:cli
```

Бинарник и скрипт попадают в `packages/cli/dist/`. Для вызова из любого каталога:

**Вариант 1 — через npm link (глобальная команда `nexus`):**

```bash
cd packages/cli
npm link
nexus --help
```

**Вариант 2 — запуск напрямую:**

```bash
node /полный/путь/к/NexusCode/packages/cli/dist/index.js --help
```

Или, если в `packages/cli` есть исполняемый скрипт:

```bash
/полный/путь/к/NexusCode/packages/cli/dist/nexus --help
```

После `npm link` команда `nexus` доступна глобально в терминале.

---

## Installation (English)

### Quick start (two commands)

From the repo root with **Node.js 20** (e.g. `nvm use`):

```bash
pnpm run setup
nexus
```

`pnpm run setup` runs: `pnpm install` → downloads prebuilt **better-sqlite3** binaries (`setup:native`) → `pnpm build`. Then `nexus` starts the CLI.

If pnpm reports **Unexpected store location**, set the store once (path from the error), then run setup again:

```bash
pnpm config set store-dir /path/from/error/message --global
pnpm run setup
nexus
```

If **bindings file** is missing after setup, run `pnpm rebuild better-sqlite3` (requires build tools: python3, make, g++), then `pnpm build`.  
Run CLI: `node packages/cli/dist/index.js` or `nexus` after `npm link` from `packages/cli`.

### Full build: global `nexus` command + .vsix for testing

To have the latest CLI as the global `nexus` command and a fresh VS Code extension file:

```bash
cd /path/to/NexusCode
nvm use
pnpm run fullbuild
cd packages/cli && npm link && cd ../..
```

Then:
- **CLI:** `nexus` is available globally and uses the newly built code (from any directory).
- **Extension:** `packages/vscode/nexuscode-0.1.0.vsix` is the latest build for testing. Install via **Extensions** (Ctrl+Shift+X) → "..." → **Install from VSIX...** and select that file.

If you already ran `npm link` from `packages/cli` before, run it again after each full build so the global `nexus` points to the new build.

### Requirements (versions)

| Requirement | Version | Note |
|-------------|---------|------|
| **Node.js** | **20+** | Required for `pnpm package:vscode`; on Node 18, `vsce` (undici) fails with `File is not defined`. The rest of the build (`pnpm build`) runs on Node 18. |
| **pnpm** | current | Recommended: `npm install -g pnpm` |

The repo includes **`.nvmrc`** set to `20`. With nvm, run in the project root: `nvm use`. If Node &lt; 20: `nvm use 20` or install Node 20 from [nodejs.org](https://nodejs.org/).

### VS Code Extension

**Build and install from source:**

1. Clone the repo and install dependencies:
   ```bash
   cd NexusCode
   pnpm install
   ```
   If install fails due to lockfile (e.g. in CI): `pnpm install --no-frozen-lockfile`

2. Build all packages (core, extension, webview):
   ```bash
   pnpm build
   ```
   Or only the extension: `pnpm build:core && pnpm build:vscode`

3. Package the extension as `.vsix`:
   ```bash
   pnpm package:vscode
   ```
   The file is created in `packages/vscode/` as `nexuscode-0.1.0.vsix`.  
   **Node.js 20+** is required (vsce fails on Node 18 with `File is not defined`). Use `nvm use 20` or install Node 20.  
   To package from the extension folder:
   ```bash
   cd packages/vscode && pnpm install && pnpm package
   ```

4. Install in VS Code:
   - Open VS Code → **Extensions** (Ctrl+Shift+X)
   - Click "…" at the top → **Install from VSIX...**
   - Choose the **full path** to the file, e.g.  
     `C:\...\NexusCode\packages\vscode\nexuscode-0.1.0.vsix` or  
     `/path/to/NexusCode/packages/vscode/nexuscode-0.1.0.vsix`

   Or from the terminal:
   ```bash
   code --install-extension /path/to/NexusCode/packages/vscode/nexuscode-0.1.0.vsix
   ```
   When using **SSH**, install via the IDE menu; ensure the `.vsix` file exists on the **remote** machine if needed.

5. Restart VS Code. The NexusCode icon appears in the sidebar; open the panel with **Ctrl+Shift+N** (Cmd+Shift+N on Mac).

**Development (run without installing):**
- Open the folder `NexusCode/packages/vscode` in VS Code
- Press **F5** (Run → Start Debugging) — a second window "Extension Development Host" opens with the extension loaded
- After code changes, rebuild (`pnpm build` from root or `packages/vscode`) and press **Ctrl+R** in the Extension Development Host to reload

### CLI

```bash
pnpm install
pnpm build:cli
npm link packages/cli
nexus --help
```

---

## Configuration

Create `.nexus/nexus.yaml` in your project root:

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-5
  temperature: 0.2
  # apiKey: from ANTHROPIC_API_KEY env var

embeddings:
  provider: openai
  model: text-embedding-3-small

indexing:
  enabled: true
  vector: false
  symbolExtract: true

vectorDb:
  enabled: false
  url: http://127.0.0.1:6333
  autoStart: true

permissions:
  autoApproveRead: true
  autoApproveWrite: false
  autoApproveCommand: false
```

OpenRouter should be configured as OpenAI-compatible:

```yaml
model:
  provider: openai-compatible
  id: anthropic/claude-sonnet-4
  baseUrl: https://openrouter.ai/api/v1
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
```

When many MCP tools are available, NexusCode automatically classifies which tools are relevant for the current task. Built-in tools are always available.

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
│   │   ├── agent/         ← Agent loop, modes, classifiers, prompts
│   │   ├── tools/         ← Tool registry + 19 built-in tools
│   │   ├── session/       ← JSONL storage + compaction
│   │   ├── indexer/       ← AST + FTS + Qdrant
│   │   ├── provider/      ← All LLM providers + embeddings
│   │   ├── checkpoint/    ← Shadow git
│   │   ├── context/       ← @mentions, rules, condense
│   │   ├── skills/        ← Skill loader + classifier
│   │   └── mcp/           ← MCP client
│   ├── vscode/            ← VS Code extension + React UI
│   └── cli/               ← CLI with Ink TUI
└── .nexus/               ← Project config
    ├── nexus.yaml
    ├── rules/
    └── skills/
```

---

## Key Design Decisions

1. **No step limits** — Doom loop detection (3 identical consecutive calls) prevents infinite loops
2. **Built-in tools always active** — Mode permissions gate which tools are available; classifier only filters MCP/custom tools
3. **Parallel reads** — Multiple read-only tools execute concurrently with `Promise.all`
4. **Cache-aware prompts** — Stable blocks (role, rules, skills) use `cache_control: ephemeral` on Anthropic
5. **Two-level compaction** — Fast prune (remove old tool outputs) + LLM compact (full summary) from OpenCode
6. **Multi-project** — Separate FTS/vector indices per project hash in `~/.nexus/index/`

---

## Further Reading

- Architecture details: `ARCHITECTURE.md`
- Semantic changes: `docs/changes/`

---

## License

MIT
