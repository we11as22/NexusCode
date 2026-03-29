# NexusCode — полная документация

**NexusCode** — AI-агент для кода: расширение VS Code, CLI (TUI) и опциональный HTTP-сервер. Сессии и сообщения хранятся в **JSONL** под `~/.nexus/sessions/<хэш канонического корня проекта>/` через `@nexuscode/core`. Сервер (`packages/server`) пишет в **те же файлы**, что и локальный CLI/расширение (`session-fs-store.ts`), а не в отдельную SQLite.

- **README** (English): [README.md](README.md) — установка, быстрый старт, ссылки.
- **Архитектура** (English): [ARCHITECTURE.md](ARCHITECTURE.md) — слои, инварианты, потоки данных, детали UI/loop.

---

## Содержание

1. [Установка](#установка)
2. [Быстрый старт](#быстрый-старт)
3. [Конфигурация](#конфигурация)
4. [Режимы работы](#режимы-работы)
5. [Индексация](#индексация-кодовой-базы)
6. [Инструменты агента](#инструменты-агента)
7. [CLI](#cli)
8. [Расширение VS Code](#расширение-vs-code)
9. [Сабагенты и параллельность](#мультиагентность-и-сабагенты)
10. [Безопасность и права](#безопасность-и-права)
11. [Переменные окружения](#переменные-окружения)
12. [Чекпоинты](#чекпоинты-и-откат)
13. [MCP](#mcp)
14. [Skills](#skills)
15. [Правила](#правила-и-правила-проекта)
16. [Сервер NexusCode](#сервер-nexuscode)
17. [Устранение неполадок](#устранение-неполадок)

---

## Установка

### Требования

- **Node.js 20+** — рекомендуется для `better-sqlite3`, `pnpm run serve`, сборки .vsix и CLI; в корне репозитория в `package.json` формально указано `>=18`, но скрипты сервера и практика проекта ориентированы на 20 (файл `.nvmrc`: `20`).
- **pnpm** — монорепозиторий и скрипты в корне.
- **Bun** — для OpenTUI в CLI (см. README).

### Установка pnpm

```bash
npm install -g pnpm
# или
corepack enable && corepack prepare pnpm@latest --activate
```

### Из репозитория

```bash
git clone <repo-url>
cd NexusCode
nvm use 20   # при использовании nvm
pnpm install
pnpm build
```

Одна команда «всё для CLI»: `pnpm run cli` (см. README). Полная переустановка: `pnpm run one`; CLI + .vsix: `pnpm run ready`.

### Глобальная команда `nexus`

После `pnpm run cli` или `cd packages/cli && npm link` добавьте `~/bin` (или каталог установки) в `PATH`. Запуск: `nexus`.

### Устранение (native module)

Ошибка `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`: запускайте `nexus` той же мажорной версией Node, под которой собирали `better-sqlite3` (обычно `nvm use 20`, затем `pnpm run one` или `pnpm rebuild better-sqlite3`).

Временно без индекса: `nexus --no-index`.

### Расширение VS Code

1. `pnpm build` в корне (или `pnpm run ready`).
2. `pnpm package:vscode` → установить `packages/vscode/nexuscode-0.1.0.vsix` (**Install from VSIX**).
3. Разработка: открыть `packages/vscode`, **F5** (Extension Development Host).

---

## Быстрый старт

### CLI

По умолчанию в `NexusConfigSchema` задан бесплатный маршрут Kilo/OpenRouter (`minimax/minimax-m2.5:free`, `https://api.kilo.ai/api/openrouter`) — отдельный API-ключ для старта не обязателен.

```bash
cd /path/to/your/project
nexus

# Одно сообщение и выход (неинтерактивно)
nexus -p "Кратко опиши структуру пакета"

# Режим (флаг, не позиционный аргумент)
nexus --mode plan -p "План рефакторинга модуля auth"
nexus --mode ask -p "Как устроен слой конфигурации?"
nexus --mode debug -p "Почему падает тест X?"
```

**Важно:** в `packages/cli/src/entrypoints/cli.tsx` флаг `--mode` допускает только `agent` | `ask` | `plan` | `debug`. Значение `review` не распознаётся и сбрасывается в `agent`. Режим **review** в ядре есть; в интерактивном TUI его можно выбрать через **`/mode`** (см. `PromptInput.tsx`, `VALID_MODES`). Цикл **Shift+Tab** в `REPL.tsx` переключает только `agent → plan → ask → debug` (без `review`).

### VS Code

Панель: **Ctrl+Shift+N** (macOS: **Cmd+Shift+N**) или команда **NexusCode: Open NexusCode Panel**.

---

## Конфигурация

### Где читается конфиг

Реализация: `packages/core/src/config/index.ts`.

1. Глобальный файл: `~/.nexus/nexus.yaml`
2. Проектный (поиск вверх от cwd): `.nexus/nexus.yaml`, `.nexus/nexus.yml`, `.nexusrc.yaml`, `.nexusrc.yml`
3. MCP дополняется merge из `~/.nexus/mcp-servers.json` и `<project>/.nexus/mcp-servers.json` (по имени сервера, позднее побеждает)
4. Переменные окружения и настройки VS Code (`nexuscode.*`) могут переопределять значения в рантайме хоста

### Дефолт модели (schema)

```yaml
model:
  provider: openai-compatible
  id: minimax/minimax-m2.5:free
  baseUrl: https://api.kilo.ai/api/openrouter
```

Старые `baseUrl` с `/api/gateway` при загрузке нормализуются на `/api/openrouter` (`normalizeModelConfig` в CLI bootstrap).

### Опорная таблица полей (`NexusConfigSchema`)

| Секция | Ключ | По умолчанию / тип | Комментарий |
|--------|------|-------------------|-------------|
| **model** | provider | `openai-compatible` | см. список в schema |
| | id | `minimax/minimax-m2.5:free` | |
| | baseUrl | `https://api.kilo.ai/api/openrouter` | |
| | reasoningEffort | `"auto"` | |
| | reasoningHistoryMode | `"auto"` | `auto` \| `inline` \| `reasoning_content` \| `reasoning_details` |
| | temperature, apiKey, contextWindow, … | опционально | |
| **embeddings** | | опционально | провайдер embeddings для вектора |
| **vectorDb** | enabled | `false` | без этого + `indexing.vector` нет семантического `CodebaseSearch` |
| | url | `http://localhost:6333` | |
| | collection | `nexus` | фактическое имя коллекции в коде индексатора: `nexus_<projectHash>` |
| | autoStart | `true` | локальный Qdrant |
| | apiKey, upsertWait, searchMinScore, searchHnswEf, searchExact | опционально | |
| **indexing** | enabled | `true` | |
| | excludePatterns | массив glob | включая `".nexus/**"` |
| | symbolExtract | `true` | AST / символы для `ListCodeDefinitions` |
| | vector | `false` | вместе с `vectorDb.enabled` включает векторный пайплайн |
| | maxIndexedFiles | `50000` | **0 = не сканировать дерево** (Roo-совместимость) |
| | debounceMs | `800` | дебаунс watcher |
| | searchWhileIndexing | `true` | частичный поиск при наличии точек в Qdrant |
| | maxIndexingFailureRate | `0.1` | порог сброса индекса |
| | batchSize, embeddingBatchSize, embeddingConcurrency, maxPendingEmbedBatches, batchProcessingConcurrency, codebaseSearchSnippetMaxChars | см. schema | |
| **permissions** | autoApproveRead / Write / Command / Mcp / Browser / SkillLoad | см. schema | `autoApproveSkillLoad` по умолчанию `true` |
| | autoApproveReadPatterns | дефолт включает пути к `~/.nexus/data/run/**` и tool-output | |
| | allowedCommands, allowCommandPatterns, allowedMcpTools, denyCommandPatterns, askCommandPatterns, denyPatterns, rules | см. schema | |
| **modes** | agent, plan, ask, debug, review | опционально | `autoApprove`, `systemPrompt`, `customInstructions` |
| **retry** | | см. schema | |
| **checkpoint** | enabled, timeoutMs, createOnWrite, doubleCheckCompletion | см. schema | |
| **ui** | showReasoningInChat | `false` | показ потокового reasoning в чате |
| **mcp** | servers | `[]` | `name`, `command`, `args`, `env`, `url`, `transport`, `type`, `headers`, `enabled`, `bundle` |
| **skills** | | `[]` | строки или `{ path, enabled? }` |
| **skillsUrls** | | опционально | удалённые реестры → `~/.nexus/cache/skills/` |
| **tools** | classifyToolsEnabled | `false` | при `true` и числе MCP-серверов > threshold — классификация **серверов** |
| | classifyThreshold | `20` | |
| | parallelReads, maxParallelReads | `true`, `5` | |
| **skillClassifyEnabled** | | `false` | |
| **skillClassifyThreshold** | | `20` | |
| **structuredOutput** | | `"auto"` | `auto` \| `always` \| `never` |
| **summarization** | auto, threshold, keepRecentMessages, model | `true`, `0.80`, `8`, `""` | |
| **parallelAgents** | maxParallel, maxTasksPerCall | `4`, `12` | второе — устаревший задел; параллельные сабагенты через `Parallel` / `SpawnAgentsParallel` |
| **rules** | files | `CLAUDE.md`, `AGENTS.md`, `.nexus/rules/**` | |
| **agentLoop** | toolCallBudget, maxIterations | опционально по режимам | включая `review` |
| **profiles** | | `{}` | именованные профили модели |

---

## Режимы работы

Источник: `packages/core/src/agent/modes.ts`, `MANDATORY_END_TOOL`.

| Режим | Смысл | Запись | Bash | Обязательное завершение |
|-------|--------|--------|------|-------------------------|
| **agent** | Полный агент | да | да | нет (стоп без tool calls) |
| **plan** | План в `.nexus/plans/*.md\|*.txt` | только туда | **заблокирован** | **PlanExit** |
| **ask** | Только чтение / поиск | нет | нет | нет |
| **debug** | Диагностика и правки | да | да | нет |
| **review** | Обзор изменений (git и т.д.) | нет | да (для git) | нет |

Заблокированные имена инструментов: у **ask** — `Write`, `Edit`, `Bash`, `PlanExit`; у **review** — `Write`, `Edit`, `PlanExit`; у **agent**/**debug** — `PlanExit`; у **plan** — `Bash`.

---

## Индексация кодовой базы

- **Символы (AST)** и файловый трекер: для навигации и `ListCodeDefinitions`; трекер в VS Code под `globalStorageUri`, в CLI — `~/.nexus/index/<hash>/file-tracker.json`.
- **Вектор (Qdrant):** коллекция `nexus_<projectHash>`. Включается **`indexing.vector: true`** и **`vectorDb.enabled: true`**.
- **`CodebaseSearch`** в промпт модели попадает **только** при включённом векторе (`runAgentLoop` удаляет имя инструмента иначе). Сообщение об ошибке в теле инструмента указывает на эти флаги.
- Игноры: `DEFAULT_EXCLUDE`, `indexing.excludePatterns`, `.gitignore`, `.nexusignore`, `.cursorignore` (см. ARCHITECTURE).
- **debounce** индекса по умолчанию **800 ms** (не 1.5 с).

---

## Инструменты агента

Имена ниже — те, что видит модель (PascalCase для основного набора). В логах провайдера могут встречаться алиасы; исполнение нормализует часть из них (`tool-execution.ts`).

### Статические built-in (`getAllBuiltinTools`)

| Имя | Назначение |
|-----|------------|
| **AskFollowupQuestion** | Структурированные вопросы пользователю |
| **TodoWrite** | Чеклист задач |
| **Parallel** | Пакет read-only инструментов и/или несколько **SpawnAgent** |
| **Read** | Чтение файла (`file_path`, `offset`, `limit`); `~` → домашний каталог |
| **List** | Один каталог — параметр **`path`** (не массив `paths`) |
| **ListCodeDefinitions** | Символы в файле/каталоге |
| **ReadLints** | Диагностики по путям |
| **Write** | Запись файла |
| **Edit** | Замены в файле (search/replace блоки) |
| **Bash** | Shell; `run_in_background` → лог в `~/.nexus/data/run/` |
| **BashOutput** | Вывод/статус фонового Bash |
| **KillBash** | Остановка фонового процесса |
| **Grep** | Ripgrep |
| **CodebaseSearch** | Семантический поиск (только при векторе) |
| **WebFetch**, **WebSearch** | Сеть (для WebSearch могут нуждаться внешние ключи — см. описание инструмента) |
| **Glob** | Поиск путей по glob |
| **Condense** | Сжатие контекста |
| **PlanExit** | Выход из режима плана |
| **Skill** | Загрузка навыка по имени из каталога |

### Регистрация хостом

| Имя | Примечание |
|-----|------------|
| **SpawnAgent**, **SpawnAgentsParallel**, **SpawnAgentOutput**, **SpawnAgentStop** | CLI и VS Code (`nexus-bootstrap` / `controller`) |
| **SpawnAgent**, **SpawnAgents** (алиас), **SpawnAgentOutput**, **SpawnAgentStop** | HTTP-сервер (`run-session.ts`) — **`SpawnAgentsParallel` на сервере не регистрируется**; для параллельных сабагентов используйте **`Parallel`** с несколькими `SpawnAgent` |

**Не зарегистрировано в типичном рантайме:** `create_rule` (файл `report-and-control.ts`), инструменты **exa_*** из `exa-search.ts` — в реестр не попадают.

---

## CLI

### Синтаксис

Интерактивно: `nexus` или `nexus "текст"`. Неинтерактивно: обязателен промпт или stdin с **`-p` / `--print`**.

Короткий help без загрузки TUI: `nexus -h` (`packages/cli/src/index.ts`). Полный Commander — в `entrypoints/cli.tsx`.

### Основные опции

| Опция | Описание |
|-------|----------|
| `-c, --cwd` | Текущая директория shell |
| `--project <dir>` | Корень проекта (резолвится относительно cwd) |
| `-p, --print` | Печать ответа и выход |
| `--mode` | `agent` \| `ask` \| `plan` \| `debug` (см. ограничение для `review` выше) |
| `-m, --model` | Модель |
| `--temperature`, `--reasoning-effort` | См. help |
| `--no-index` | Отключить индексацию в bootstrap |
| `-s, --session`, `--continue` | Сессия |
| `--server`, `NEXUS_SERVER_URL` | URL HTTP-сервера |
| `--profile` | Профиль из `nexus.yaml` |
| `--dangerously-skip-permissions` | Только изолированные сценарии |
| `-d, --debug`, `--verbose` | Отладка / логирование |

### Подкоманды и slash-команды

В TUI: `/settings`, `/model`, `/embeddings`, `/index`, `/sessions`, `/agent-config`, `/mode`, … См. `useSlashCommandTypeahead.ts` и README.

Команды верхнего уровня: `task` (чекпоинты), `config`, `approved-tools`, `mcp`, `doctor` — см. help Commander.

### Горячие клавиши (Nexus TUI)

Enter — отправить; Shift+Enter — новая строка; Shift+Tab — смена режима (четырёхрежимный цикл); Ctrl+S — компактизация; Ctrl+K — очистка чата; Ctrl+C — прервать/выход.

---

## Расширение VS Code

### Команды (фрагмент `package.json`)

| Команда | Назначение |
|---------|------------|
| NexusCode: Open NexusCode Panel | Панель чата |
| NexusCode: New Task | Новая задача (**Ctrl+Shift+A**) |
| NexusCode: Add to Chat / Explain / Improve / Fix | Контекст редактора |
| NexusCode: Compact Conversation History | Компактизация |
| NexusCode: Clear Chat | Очистка |
| NexusCode: Sync Codebase Index (Incremental) | Инкрементальный sync |
| NexusCode: Delete Codebase Index (Workspace) | Удаление индекса воркспейса |
| NexusCode: Rebuild Codebase Index from Scratch | Полная пересборка |
| NexusCode: Delete Index for This Path… | Explorer |
| NexusCode: Open NexusCode Terminal | Терминал |
| NexusCode: Generate Inline Completion / … | Автодополнение |

### Настройки

Секция `nexuscode.*`: `serverUrl`, `provider`, `model`, `apiKey`, `baseUrl`, `temperature`, `enableIndexing`, `enableVectorIndex`, `enableVectorDb`, … — см. `packages/vscode/package.json` → `contributes.configuration`. Приоритет: переменные окружения и YAML vs UI зависят от порядка merge в контроллере (обзор — ARCHITECTURE).

---

## Мультиагентность и сабагенты

- Параллельные независимые вызовы: инструмент **`Parallel`** (только read-only + **SpawnAgent** внутри по правилам).
- Несколько сабагентов одним вызовом: **`SpawnAgentsParallel`** — в **CLI и VS Code**; на **HTTP-сервере** этот инструмент не подключается к реестру, там — **`Parallel`** с несколькими **`SpawnAgent`** (или последовательные вызовы).
- Фон: **`SpawnAgent`** с `run_in_background`, ожидание через **`SpawnAgentOutput`** (`block: true` по умолчанию), отмена — **`SpawnAgentStop`**.
- Лимит параллельности: **`parallelAgents.maxParallel`** (по умолчанию 4).

---

## Безопасность и права

- Чтение: `autoApproveRead`, `denyPatterns`, `permissions.rules`.
- Запись и команды: подтверждение в UI; allowlist команд — `.nexus/allowed-commands.json`, паттерны в настройках.
- MCP и браузер: отдельные флаги auto-approve в конфиге.
- Пример `permissions.rules` в YAML — инструменты указывайте **реальными именами** (`Bash`, `Write`, …), а не legacy-строки вроде `execute_command`.

---

## Переменные окружения

Ключи провайдеров задаются через стандартные имена (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …) и/или универсальный **`NEXUS_API_KEY`** — детали резолва в слое конфигурации core/hosts.

Для сервера: **`NEXUS_SERVER_PORT`**, **`PORT`**, **`NEXUS_SERVER_HOST`** (см. `packages/server/src/index.ts`).

---

## Чекпоинты и откат

При `checkpoint.enabled` и git: shadow-git чекпоинты (см. `packages/core/src/checkpoint/`). В CLI: `nexus task checkpoints`, `nexus task restore <id>`; в TUI — `/undo` (см. README / ARCHITECTURE).

---

## MCP

Конфигурация списка серверов в `mcp.servers` + merge с `mcp-servers.json`. Включение/выключение — **по серверу целиком**. При большом числе серверов и **`tools.classifyToolsEnabled`** классификатор выбирает **какие серверы** подключить; инструменты встроенного набора не отфильтровываются этим механизмом.

Транспорты в schema: `stdio`, `http`, `sse`; поле `type` — расширенные варианты для SDK.

Встроенный bundle **`context-mode`**: `bundle: "context-mode"` → `resolveBundledMcpServers` (см. ARCHITECTURE).

---

## Skills

Пути из `skills`, удалённые индексы `skillsUrls`, walk-up `.nexus/skills`, глобальный `~/.nexus/skills`, установки маркетплейса. При **`skillClassifyEnabled`** и числе навыков > **`skillClassifyThreshold`** — LLM-отбор под задачу.

---

## Правила и правила проекта

Файлы из `rules.files` плюс walk-up `AGENTS.md`, `CLAUDE.md`, `.nexus/rules/**`, `~/.nexus/rules/**` — см. `loadRules` / ARCHITECTURE.

---

## Сервер NexusCode

Запуск из корня: `pnpm build` затем **`pnpm serve`** (через `scripts/check-node.js`, Node 20+). Порт по умолчанию **4097**, хост **127.0.0.1**.

API: поток сообщений **NDJSON** с heartbeat; health **GET /health** — см. ARCHITECTURE.

---

## Устранение неполадок

| Симптом | Что проверить |
|---------|----------------|
| `CodebaseSearch` «disabled» | `indexing.vector` и `vectorDb.enabled`, доступность Qdrant |
| Расхождение Node / native | Одна версия Node при build и run; `pnpm rebuild better-sqlite3` |
| Пустая коллекция после индексации | Нормализация ответа Qdrant `getCollection` (`vector.ts`) |
| Сервер не стартует на Node 18 | `pnpm serve` требует 20+ (`check-node.js`) |

---

## См. также

- [README.md](README.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)

Документ синхронизирован с состоянием кода в репозитории NexusCode (packages/core, cli, vscode, server) на момент правки.
