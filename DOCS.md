# NexusCode — полная документация

**NexusCode** — AI-агент для кодинга, объединяющий лучшие практики vibe-coding инструментов (Cursor, Aider, Continue, Pi и др.) с поддержкой VS Code, CLI и собственных фич.

---

## Содержание

1. [Установка](#установка)
2. [Быстрый старт](#быстрый-старт)
3. [Конфигурация](#конфигурация)
4. [Режимы работы](#режимы-работы)
5. [Индексация кодовой базы](#индексация-кодовой-базы)
6. [Инструменты агента](#инструменты-агента)
7. [CLI](#cli)
8. [Расширение VS Code](#расширение-vs-code)
9. [Мультиагентность и сабагенты](#мультиагентность-и-сабагенты)
10. [Безопасность и права](#безопасность-и-права)
11. [Переменные окружения](#переменные-окружения)
12. [Чекпоинты и откат](#чекпоинты-и-откат)
13. [MCP](#mcp)
14. [Skills](#skills)
15. [Правила и правила проекта](#правила-и-правила-проекта)
16. [Устранение неполадок](#устранение-неполадок)

---

## Установка

### Требования

- **Node.js** 18+
- **pnpm** (рекомендуется для монорепозитория) или npm

### Установка pnpm

Если `pnpm` не найден:

**Вариант 1 — через npm** (если уже есть Node.js):

```bash
npm install -g pnpm
```

**Вариант 2 — через Corepack** (встроен в Node.js 16+):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Проверка: `pnpm -v`.

### Из репозитория (разработка)

```bash
git clone <repo-url>
cd NexusCode
pnpm install
pnpm build
```

### Установка CLI глобально

После сборки из репозитория:

```bash
cd NexusCode
pnpm install
pnpm build
# Создать симлинк или добавить в PATH
ln -s "$(pwd)/packages/cli/dist/index.js" /usr/local/bin/nexus
# или (после сборки в dist появляется скрипт nexus)
export PATH="$(pwd)/packages/cli/dist:$PATH"
nexus
```

### Устранение неполадок

**Ошибка `better_sqlite3.node was compiled against a different Node.js version` (NODE_MODULE_VERSION)**  
Нативный модуль `better-sqlite3` собран под другую версию Node. Пересоберите его под текущую:

1. В проекте включена сборка нативных модулей: в `pnpm-workspace.yaml` задано `allowBuilds: better-sqlite3: true`. Если после свежего `pnpm install` скрипты сборки не запускались — проверьте этот пункт.
2. Пересборка под текущий Node:
   ```bash
   pnpm rebuild better-sqlite3
   ```
   Если после этого ошибка сохраняется (например, в сообщении фигурируют 108 и 109), пересоберите в каталоге пакета тем же `node`, которым запускаете `nexus`:
   ```bash
   cd node_modules/.pnpm/better-sqlite3@9.6.0/node_modules/better-sqlite3 && npm run build-release
   ```
   Запускайте `nexus` той же версией Node, под которую собирали модуль (например: `nvm use 20 && nexus`).
3. Если пересборка падает из‑за отсутствия компилятора, установите (Debian/Ubuntu): `sudo apt-get install -y build-essential python3`.
4. После смены мажорной версии Node (20 ↔ 18) лучше переустановить зависимости: `rm -rf node_modules packages/*/node_modules && pnpm install`.

**Временно обойтись без индекса** (индексация и `codebase_search` отключены, остальное работает):

```bash
nexus --no-index
```

### Установка расширения VS Code

1. Собрать проект: `pnpm build` в корне NexusCode.
2. В VS Code: **Extensions** → **...** → **Install from VSIX** (если есть .vsix).
3. Либо **Run and Debug** → **Run Extension** из корня `packages/vscode` для разработки.
4. Либо скопировать папку `packages/vscode` в `~/.vscode/extensions/nexuscode-0.1.0/` и перезапустить VS Code.

---

## Быстрый старт

### CLI

```bash
# Убедитесь, что API-ключ задан (см. раздел Переменные окружения)
export ANTHROPIC_API_KEY="sk-ant-..."

# Интерактивный режим в текущей папке
nexus

# Режим агента с первым сообщением
nexus agent "Добавь в README секцию про установку"

# Режим «только план» (без изменений кода)
nexus plan "Предложи план рефакторинга auth модуля"

# Печать ответа без интерактива (CI)
nexus agent --print "Что делает функция parseConfig?"
```

### VS Code

1. Откройте палитру команд: **Ctrl+Shift+P** (macOS: **Cmd+Shift+P**).
2. **NexusCode: Open NexusCode Panel** или **Ctrl+Shift+N**.
3. Либо откройте боковую панель **NexusCode** на Activity Bar.
4. Введите запрос в поле ввода и нажмите Enter.

---

## Конфигурация

Конфиг загружается из:

1. **Глобальный**: `~/.nexus/nexus.yaml`
2. **Проектный**: `.nexus/nexus.yaml` или `.nexusrc.yaml` (поиск вверх от текущей директории)
3. Проектный переопределяет глобальный; переменные окружения переопределяют оба.

### Минимальный пример `.nexus/nexus.yaml`

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-5
  # apiKey задаётся через ANTHROPIC_API_KEY

maxMode:
  enabled: false
  tokenBudgetMultiplier: 2
```

### Полная схема конфигурации

| Секция | Ключ | Тип | По умолчанию | Описание |
|--------|------|-----|--------------|----------|
| **model** | provider | string | anthropic | Провайдер LLM: anthropic, openai, google, ollama, azure, bedrock, groq, mistral, xai, deepinfra, cerebras, cohere, togetherai, perplexity, openai-compatible (OpenRouter через openai-compatible + baseUrl) |
| | id | string | claude-sonnet-4-5 | Идентификатор модели |
| | apiKey | string | — | API-ключ (можно не указывать, если задан в env) |
| | baseUrl | string | — | Кастомный URL API (для openai-compatible) |
| **maxMode** | enabled | boolean | false | Включить «макс» режим (та же модель, но глубже и дольше работает) |
| | tokenBudgetMultiplier | number | 2 | Множитель бюджета токенов на запрос в max mode (1-6) |
| **indexing** | enabled | boolean | true | Включить индексацию кодовой базы |
| | excludePatterns | string[] | node_modules/**, .git/**, dist/**, ... | Glob-паттерны исключения при индексации |
| | symbolExtract | boolean | true | Извлекать символы (классы, функции) для умной индексации |
| | fts | boolean | true | Полнотекстовый поиск (SQLite FTS5) |
| | vector | boolean | false | Векторный поиск (нужен Qdrant и embeddings) |
| | batchSize | number | 50 | Размер батча при индексации |
| | embeddingBatchSize | number | 60 | Размер батча embedding-запросов при векторной индексации |
| | embeddingConcurrency | number | 2 | Параллелизм embedding-запросов при векторной индексации |
| | debounceMs | number | 1500 | Задержка перед обновлением индекса при изменении файла |
| **vectorDb** | enabled | boolean | false | Включить векторную БД |
| | url | string | http://localhost:6333 | URL Qdrant |
| | collection | string | nexus | Имя коллекции |
| **permissions** | autoApproveRead | boolean | true | Авто-одобрение чтения файлов |
| | autoApproveWrite | boolean | false | Авто-одобрение записи |
| | autoApproveCommand | boolean | false | Авто-одобрение выполнения команд |
| | autoApproveReadPatterns | string[] | [] | Glob-паттерны путей с авто-одобрением чтения |
| | denyPatterns | string[] | **/.env, **/secrets/**, ... | Пути, запрещённые для доступа |
| | rules | array | [] | Тонкие правила: tool, pathPattern, commandPattern, action (allow/deny/ask), reason |
| **modes** | agent, plan, debug, ask | object | {} | autoApprove, systemPrompt, customInstructions для каждого режима |
| **retry** | enabled | boolean | true | Повторы при сбоях API |
| | maxAttempts | number | 3 | Максимум попыток |
| | initialDelayMs, maxDelayMs | number | 1000, 30000 | Задержки между попытками |
| | retryOnStatus | number[] | [429,500,502,503,504] | HTTP-коды для повтора |
| **checkpoint** | enabled | boolean | true | Чекпоинты (требуется git) |
| | timeoutMs | number | 15000 | Таймаут создания чекпоинта |
| | createOnWrite | boolean | true | Создавать чекпоинт при записи файлов |
| **mcp** | servers | array | [] | Список MCP-серверов (name, command, args, env, url, transport) |
| **skills** | — | string[] | [] | Пути к SKILL.md или папкам с навыками |
| **tools** | custom | string[] | [] | Кастомные инструменты |
| | classifyThreshold | number | 15 | Порог: выше — классификатор выбирает подмножество инструментов по задаче |
| | parallelReads | boolean | true | Параллельное выполнение read-only инструментов |
| | maxParallelReads | number | 5 | Макс. параллельных чтений |
| **skillClassifyThreshold** | — | number | 8 | Порог для классификации skills |
| **summarization** | auto | boolean | true | Авто-компактизация контекста |
| | threshold | number | 0.80 | Доля контекста (0–1), при которой запускается компактизация |
| | keepRecentMessages | number | 8 | Сколько последних сообщений не трогать |
| **parallelAgents** | maxParallel | number | 4 | Макс. число одновременных сабагентов |
| **rules** | files | string[] | CLAUDE.md, AGENTS.md, .nexus/rules/** | Файлы с правилами проекта |
| **profiles** | &lt;name&gt; | object | {} | Именованные профили (переопределения model), выбор через --profile |

---

## Режимы работы

| Режим | Описание | Чтение | Запись | Команды | Поиск | MCP/Skills/Agents |
|-------|----------|--------|--------|---------|--------|-------------------|
| **agent** | Полноценный агент: чтение, запись, команды, поиск, браузер, MCP, сабагенты | ✅ | ✅ | ✅ | ✅ | ✅ |
| **plan** | Только план: чтение + поиск; запись только в `.nexus/plans/*.md` | ✅ | Только .md в .nexus/plans | ❌ | ✅ | Skills |
| **debug** | Фокус на отладке: как agent, но с акцентом на воспроизведение → изоляция → фикс | ✅ | ✅ | ✅ | ✅ | Skills |
| **ask** | Только вопросы: объяснения, анализ кода; без изменений и команд | ✅ | ❌ | ❌ | ✅ | — |

Переключение режима: в CLI — **Tab**; в VS Code — кнопки режимов в панели NexusCode.

**Max Mode**: при включении для сложных шагов используется модель из `maxMode` (например, Claude Opus). В CLI: **Ctrl+M**; в VS Code — переключатель «Max» в панели.

---

## Индексация кодовой базы

Индексация даёт семантический и полнотекстовый поиск по коду (`codebase_search`).

### Возможности

- **Умная разметка**: классы, функции, методы, интерфейсы, типы, enum (TypeScript/JavaScript, Python, Rust, Go, Java и др.).
- **Fallback**: для остальных файлов — чанки по строкам с перекрытием (overlap), чтобы не терять код на границах.
- **Один индекс на проект**: директория индекса — `~/.nexus/index/<hash_проекта>/`; при нескольких проектах в workspace они не смешиваются.
- **Автообновление**: при изменении файлов индекс обновляется с debounce (по умолчанию 1.5 с).
- **Без векторного индекса**: можно отключить `indexing.vector` и/или `vectorDb.enabled` — будет только FTS по символам и чанкам.

### Где хранится

- **FTS (SQLite)**: `~/.nexus/index/<project_hash>/fts.db`
- **Векторный индекс (Qdrant)**: коллекция `nexus_<project_hash>` по адресу `vectorDb.url`

### Управление в VS Code

- **Re-index** (↺): полная переиндексация.
- **Clear index** (✕): очистка индекса и пересборка с нуля.
- В заголовке отображается статус: «indexing», «✓ Nf Ns» (файлы/символы), ошибка.

### Отключение индекса

- В конфиге: `indexing.enabled: false`.
- В CLI: флаг `--no-index`.

---

## Инструменты агента

### Встроенные

| Инструмент | Описание | Режимы |
|------------|----------|--------|
| **read_file** | Чтение файла с опциональным диапазоном строк (start_line, end_line). Для больших файлов — обрезка по размеру/строкам. | agent, plan, debug, ask |
| **write_to_file** | Создание/перезапись файла | agent, debug |
| **replace_in_file** | Несколько search/replace блоков в одном вызове | agent, debug |
| **apply_patch** | Применение унифицированного патча | agent, debug |
| **execute_command** | Выполнение shell-команды (таймаут, обрезка вывода) | agent, debug |
| **search_files** | Поиск по содержимому (ripgrep), regex | agent, plan, debug, ask |
| **list_files** | Список файлов/папок с опциональным glob include | все |
| **list_code_definitions** | Список определений кода в файле/папке | все |
| **codebase_search** | Семантический/ключевой поиск по индексу (FTS + опционально вектор) | все при включённом индексе |
| **web_fetch** | GET-запрос по URL | agent, plan, debug, ask |
| **use_skill** | Подключение навыка из SKILL.md | agent, plan, debug |
| **spawn_agent** | Запуск параллельного сабагента с описанием задачи и режимом | agent |
| **attempt_completion** | Финализация ответа пользователю | все |
| **ask_followup_question** | Уточняющий вопрос пользователю | все |
| **update_todo_list** | Обновление чек-листа прогресса (task_progress) | все |

### Ограничения для больших файлов и логов

- **read_file**: лимит размера файла и числа строк за один вызов; для больших файлов рекомендуется указывать `start_line`/`end_line`.
- **execute_command**: вывод обрезается (head + tail), убираются ANSI-коды и дубликаты строк прогресса.
- Контекст защищён от переполнения: компактизация (prune + LLM-summary) при приближении к лимиту; при ошибках «context length» контекст автоматически сжимается.

---

## CLI

### Запуск

```bash
nexus [mode] [message...] [options]
```

### Режимы (позиционный аргумент)

- `agent` (по умолчанию)
- `plan`
- `debug`
- `ask`

### Опции

| Опция | Короткая | Описание |
|-------|----------|----------|
| --model, -m | | Провайдер/модель, например `anthropic/claude-sonnet-4-5` или `openai/gpt-4o` |
| --max-mode | | Включить max mode |
| --auto | | Авто-одобрение всех действий (для CI) |
| --project | | Рабочая директория проекта |
| --no-index | | Отключить индексацию |
| --session, -s | | Продолжить сессию по ID |
| --continue, -c | | Продолжить последнюю сессию |
| --print, -p | | Неинтерактивный вывод: напечатать ответ и выйти |
| --profile | | Имя профиля из `profiles` в nexus.yaml |
| --nexus-version, -v | | Показать версию |
| --help, -h | | Справка |

### Горячие клавиши в TUI

- **Enter** — отправить сообщение.
- **Ctrl+C** — прервать агента или выйти.
- **Ctrl+K** — очистить чат.
- **Ctrl+S** — компактизировать историю.
- **Ctrl+M** — переключить max mode.
- **Tab** — сменить режим (agent → plan → debug → ask).
- **↑ / ↓** — история ввода.

---

## Расширение VS Code

### Команды

| Команда | Описание | Горячая клавиша |
|---------|----------|------------------|
| NexusCode: Open NexusCode Panel | Открыть панель справа | Ctrl+Shift+N (Cmd+Shift+N) |
| NexusCode: New Task | Фокус на панели NexusCode | Ctrl+Shift+A |
| NexusCode: Add to NexusCode Chat | Добавить выделение в чат | Из контекстного меню редактора |
| NexusCode: Compact Conversation History | Запустить компактизацию | — |
| NexusCode: Clear Chat | Очистить чат | — |
| NexusCode: Reindex | Переиндексировать кодовую базу | — |
| NexusCode: Clear Index | Очистить и пересобрать индекс | — |

### Настройки (Settings)

- `nexuscode.provider` — провайдер по умолчанию.
- `nexuscode.model` — модель по умолчанию.
- `nexuscode.apiKey` — API-ключ (альтернатива переменным окружения).
- `nexuscode.enableCheckpoints` — включить чекпоинты (нужен git).
- `nexuscode.enableIndexing` — включить индексацию.

Конфиг из `.nexus/nexus.yaml` имеет приоритет над настройками VS Code; переменные окружения — наивысший приоритет.

### UI панели

- Заголовок: логотип, статус индекса, кнопки Compact / Re-index / Clear index / Clear chat.
- Переключатель режимов: Agent, Plan, Debug, Ask.
- Переключатель Max Mode.
- Блок «Progress» (todo list от агента).
- Список сообщений с раскрываемыми карточками инструментов.
- Строка статуса: провайдер/модель, индикатор «thinking» при работе.
- Поле ввода с подсказками по @ (file, folder, url, problems, git).

---

## Мультиагентность и сабагенты

В режиме **agent** доступен инструмент **spawn_agent**:

- Описание задачи и опциональный режим сабагента (agent, plan, debug, ask).
- Сабагент работает в отдельной сессии с полным набором инструментов выбранного режима.
- Ограничение одновременных сабагентов задаётся в `parallelAgents.maxParallel` (по умолчанию 4).
- Результат возвращается в основной чат по завершении.

Использование: когда задача разбивается на независимые подзадачи, которые можно выполнять параллельно.

---

## Безопасность и права

- **Чтение**: по умолчанию авто-одобрение (`autoApproveRead: true`). Исключения — `denyPatterns` и правила в `permissions.rules`.
- **Запись и команды**: по умолчанию запрос подтверждения; в VS Code показывается диалог Allow / Allow Always / Deny.
- **Правила** `permissions.rules`: первый совпавший правило определяет действие (allow / deny / ask). Задаются по инструменту, пути (pathPattern), команде (commandPattern), с опциональным reason.

Пример:

```yaml
permissions:
  rules:
    - tool: execute_command
      commandPattern: "rm -rf"
      action: deny
      reason: "Block recursive delete"
    - tool: write_to_file
      pathPattern: "**/.env*"
      action: deny
```

---

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| **NEXUS_API_KEY** | Универсальный API-ключ (если в конфиге не указан apiKey) |
| **ANTHROPIC_API_KEY** | Ключ Anthropic |
| **OPENAI_API_KEY** | Ключ OpenAI |
| **GOOGLE_API_KEY**, **GEMINI_API_KEY** | Ключ Google |
| **OPENROUTER_API_KEY** | Ключ OpenRouter |
| И другие по провайдеру (GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, …) | См. код конфига (PROVIDER_API_KEY_ENV) |
| **NEXUS_MODEL** | Модель: `provider/id` или только `id` |
| **NEXUS_BASE_URL** | Базовый URL API |
| **NEXUS_MAX_MODE** | `1` или `true` — включить max mode |
| **OPENROUTER_MODEL**, **ANTHROPIC_MODEL**, … | Переопределение модели для конкретного провайдера |

---

## Чекпоинты и откат

При `checkpoint.enabled: true` и наличии git в проекте:

- Перед записью файлов создаётся чекпоинт (git stash / commit или тег в зависимости от реализации).
- Таймаут создания — `checkpoint.timeoutMs`.
- Используется для отката изменений агента (детали зависят от реализации CheckpointTracker).

---

## MCP

Model Context Protocol позволяет подключать внешние инструменты (базы, API, браузер и т.д.).

В конфиге:

```yaml
mcp:
  servers:
    - name: my-server
      command: npx
      args: ["-y", "my-mcp-server"]
      env:
        API_KEY: "xxx"
    # или HTTP/SSE
    - name: remote
      url: https://mcp.example.com
      transport: sse
```

После подключения инструменты MCP появляются в агенте и подчиняются тем же режимам и правилам прав.

---

## Skills

**Skills** — переиспользуемые инструкции и сценарии (аналог правил с приоритетом под задачу).

В конфиге задаётся список путей к файлам или папкам с `SKILL.md`:

```yaml
skills:
  - /path/to/skill
  - .nexus/skills/refactor.md
```

При большом количестве skills срабатывает классификатор (`skillClassifyThreshold`): по описанию задачи выбирается подмножество релевантных skills, чтобы не перегружать контекст.

---

## Правила и правила проекта

Текст из файлов правил подставляется в системный промпт. По умолчанию подключаются:

- `CLAUDE.md`
- `AGENTS.md`
- `.nexus/rules/**`

Настройка:

```yaml
rules:
  files:
    - CLAUDE.md
    - AGENTS.md
    - .nexus/rules/**"
```

Файлы ищутся от корня проекта вверх; можно задать абсолютные пути.

---

## Версии и сборка

- **Версия**: в конфиге пакетов и в CLI (`nexus --nexus-version`) — 0.1.0.
- **Сборка всего**: `pnpm build` в корне.
- **Только core**: `pnpm --filter @nexuscode/core build`.
- **Только CLI**: `pnpm --filter @nexuscode/cli build`.
- **Только VS Code**: `pnpm --filter nexuscode build` (собирает extension и webview-ui).

Документация актуальна для текущего состояния репозитория; при добавлении новых фич и опций конфига их стоит дополнять в этот файл.
