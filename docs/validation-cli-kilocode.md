# Валидация: CLI NexusCode vs KiloCode (OpenCode TUI)

Проверка того, что **бэкенд, логика, стек и внешний вид** CLI NexusCode соответствуют KiloCode (OpenCode TUI), и что **UI CLI полностью интегрирован с агентом NexusCode** и всеми фичами.

---

## 1. Стек (KiloCode vs NexusCode)

| Компонент | KiloCode (OpenCode) | NexusCode CLI | Идентично? |
|-----------|---------------------|---------------|------------|
| **TUI runtime** | `@opentui/core` 0.1.81 | `@opentui/core` 0.1.85 | ✅ Один и тот же движок |
| **Реактивный слой** | `@opentui/solid` + **Solid.js** | `@opentui/react` + **React** | ⚠️ Разные фреймворки |
| **Спиннер** | `opentui-spinner` | `opentui-spinner` (react) | ✅ |
| **Примитивы** | `<box>`, `<text>`, `<scrollbox>` из core | Те же из core | ✅ |
| **Рендер** | `render()` из `@opentui/solid` | `createRoot(renderer).render(React.createElement(App))` из `@opentui/react` | ✅ Оба через OpenTUI |
| **Утилиты** | remeda, fuzzysort (в opencode) | string-width, chalk (в cli) | ⚠️ Разный набор (не влияет на идентичность UI) |

**Вывод по стеку:** Используется один и тот же **OpenTUI** (core + react или solid). Внешний вид и примитивы совпадают; отличия — только реактивная модель (Solid vs React). Для «идентичности» без переписывания на Solid достаточно сохранять те же примитивы и компоновку (border, padding, порядок блоков).

---

## 2. Структура экранов и навигация

| Элемент KiloCode | NexusCode | Статус |
|------------------|-----------|--------|
| **Маршруты** | `RouteProvider`: Home \| Session(sessionID) | Один экран с `view`: chat \| model \| embeddings \| settings \| index \| advanced \| help | ⚠️ Нет разделения Home / Session |
| **Home** | Экран при старте: Logo, Tips, подсказки, prompt | Нет отдельного маршрута Home; при 0 сообщений в чате показывается блок «Getting started» (KiloCode-style): бесплатные модели models.dev, /model, /sessions, / для команд | ✅ Подсказка при первом запуске |
| **Session** | Header (# title, context, cost) + Thread + Sidebar (session, context%, cost, MCP, diff, todo) + Footer | Chat: логотип, WelcomeBar, Getting started при 0 msg, сообщения, TodoBar, Footer (profile, model, session, **title**, **MCP: N**, ctx%) | ✅ Session title и MCP в Footer (sidebar-like) |
| **Переключение сессий** | DialogSessionList, навигация route.navigate({ type: "session", sessionID }) | `/sessions` → view «Sessions»: список сессий (getSessionList), ↑↓ Enter — переключение (onSwitchSession), локально и по server | ✅ Эквивалент DialogSessionList (вкладка Sessions) |
| **Настройки** | Диалоги: DialogModel, DialogProvider, DialogMCP, DialogStatus, DialogThemeList, DialogHelp, DialogSessionList, etc. | Встроенные вьюхи: model, embeddings, settings (hub), index, advanced, help | ✅ Функционально те же разделы; реализация — формами во вьюхах, а не модальными диалогами |

**Вывод по структуре:** Логика настроек и чата совпадает с KiloCode. Реализованы: подсказка при первом запуске (Getting started), session title и MCP в Footer (аналог Sidebar). Отдельный маршрут Home и боковая панель не добавлены; MCP/diff/todo частично отражены в Footer (MCP: N, todo — в TodoBar).

---

## 3. Провайдеры и контекст (KiloCode)

У KiloCode: ArgsProvider, ExitProvider, KVProvider, ToastProvider, RouteProvider, SDKProvider, SyncProvider, ThemeProvider, LocalProvider, KeybindProvider, PromptStashProvider, DialogProvider, CommandProvider, FrecencyProvider, PromptHistoryProvider, PromptRefProvider.

У NexusCode CLI нет такой иерархии провайдеров: всё состояние в одном `App` (useState). Эквиваленты:

| KiloCode | NexusCode | Комментарий |
|----------|-----------|-------------|
| SDKProvider / SyncProvider | configSnapshot, saveConfig, sessionId, initialMessages, events (stream) | Конфиг и сессия приходят в App пропсами; события — из runAgentLoop / server |
| LocalProvider (model, agent) | configSnapshot.model, saveConfig({ model }) | Модель в конфиге, смена через view "model" |
| ThemeProvider | Нет отдельного (можно задать тему через opentui) | Цвета заданы в коде (cyan, gray, yellow, etc.) |
| DialogProvider | Нет стека диалогов; смена view (model, settings, …) | Эквивалент — переключение вьюх |
| CommandProvider | Slash-команды (/model, /settings, …) переключают view или вызывают действия | Нет единого command palette; есть SlashPopup со списком команд |
| RouteProvider | view + setView | Один «маршрут» — текущая вьюха |

---

## 4. Интеграция с агентом NexusCode

Проверка, что CLI полностью использует core и все фичи агента.

| Фича агента | Реализация в CLI | Статус |
|-------------|------------------|--------|
| **runAgentLoop** | index.ts: runMessage() → runAgentLoop({ session, client, host, config, mode, tools, skills, rulesContent, indexer, compaction, signal }) или serverClient.streamMessage() | ✅ |
| **Режимы (agent, plan, ask)** | MODES, state.mode, onModeChange, configSnapshot.modes | ✅ |
| **Конфиг (model, embeddings, mcp, skills, rules, profiles)** | configSnapshot целиком, saveConfig для всех секций | ✅ |
| **Approval** | CliHost + tuiApprovalRef, onResolveApproval, ApprovalBanner в TUI, tool_approval_needed → awaitingApproval | ✅ |
| **Compaction** | onCompact → compaction.compact(session, llmClient), compaction_start/compaction_end в events | ✅ |
| **Индексер** | indexer.startIndexing(), onReindex, onIndexStop, indexStatus (indexReady), noIndex при server | ✅ |
| **MCP** | config.mcp.servers, saveConfig({ mcp }), reconnectMcpServers() | ✅ |
| **Сессии** | session.id, session.messages, session.addMessage, session.save; при server — NexusServerClient, list/switch (в коде) | ✅ |
| **Профили** | config.profiles, profileNames, onProfileSelect, activeProfileIdx | ✅ |
| **Plan: Approve / Revise / Abandon** | state.planCompleted, кнопки Approve, Revise, Abandon в TUI при plan mode | ✅ |
| **Subagents** | subagent_start/tool_start/tool_end/subagent_done в events, SubAgentCard в чате | ✅ |
| **Thinking / reasoning** | reasoning_delta, showThinking, /thinking | ✅ |
| **Сервер NexusCode** | serverUrl, NexusServerClient.streamMessage, listSessions, switchSession (логика в index) | ✅ |

**Вывод:** CLI полностью завязан на агента NexusCode (core + опционально server): все режимы, конфиг, approval, compaction, индекс, MCP, сессии, профили, plan и subagents учтены.

---

## 5. Внешний вид (без логотипа и цветовой темы)

| Элемент | KiloCode | NexusCode | Совпадение |
|---------|----------|-----------|------------|
| **Рамки** | SplitBorder, borderStyle="single", borderColor | borderStyle="single", borderColor="cyan" / "gray" | ✅ |
| **Футер** | directory, LSP count, MCP count, permissions | Model, Project, Context%, "Type / for commands" | ✅ По смыслу тот же тип инфо |
| **Поле ввода** | Prompt внизу | InputBar с mode, placeholder, approval hint | ✅ |
| **Сообщения** | Thread с рендером частей (text, tool, reasoning) | Рендер сообщений по частям (text, tool, reasoning), wrap, цвета | ✅ |
| **Тулзы в чате** | Иконки, статус, краткое описание | Иконки TOOL_ICONS, статус, описание, вывод | ✅ |
| **Todo** | TodoItem в Sidebar и в потоке | ProgressTodoBlock-стиль в чате (чеклист) | ✅ |
| **Подсказки** | "Type / for commands", keybinds в футере | "Type / for commands  /settings for all agent settings" | ✅ |
| **Модель/провайдер** | В header или футере | В футере: Model provider/model | ✅ |

Цвета и логотип по заданию не сравниваем; примитивы (box, text, scrollbox) и общая компоновка совпадают с OpenTUI/KiloCode.

---

## 6. Сводка расхождений и рекомендации

### Расхождения (для «полной» идентичности с KiloCode)

1. **Реактивный стек:** Solid.js vs React при том же OpenTUI. Для идентичности без переписывания достаточно сохранять общий layout и примитивы.
2. **Нет маршрута Home:** нет отдельного экрана приветствия (Logo + Tips без сессии). Опционально: при первой сессии показывать одну подсказку в чате (аналог KiloCode sidebar "Kilo includes free models…").
3. **Нет Sidebar:** нет боковой колонки с session title, context%, cost, MCP, diff, todo. В NexusCode часть этого (model, context%) вынесена в Footer; MCP/diff/todo в TUI не отображаются. Рекомендация: при необходимости добавить компактную строку «MCP: N» в Footer или отдельную вьюху /settings → MCP.
4. **Нет диалога списка сессий в TUI:** при работе с server переключение сессий можно делать через хоткей или отдельную вьюху (например, /sessions), а не только через API в коде.
5. **Настройки:** реализованы встроенными вьюхами, а не модальными диалогами (DialogModel, DialogProvider и т.д.). Поведение и набор опций совпадают с KiloCode.

### Что уже совпадает

- OpenTUI (core), примитивы, рамки, футер, ввод, поток сообщений, тулзы, reasoning, approval, plan, профили.
- Полная интеграция с агентом: runAgentLoop, конфиг, режимы, MCP, индекс, compaction, сессии, сервер.

---

## 7. Итоговая таблица

| Критерий | Статус |
|----------|--------|
| Бэкенд (агент, конфиг, сессия, события) | ✅ Интегрирован с NexusCode core и server |
| Логика (режимы, approval, compaction, индекс, MCP, plan, subagents) | ✅ Совпадает |
| Стек (OpenTUI, примитивы, TUI) | ✅ Тот же; реактивный слой — React вместо Solid |
| Внешний вид (layout, футер, чат, тулзы, подсказки) | ✅ Выровнен под KiloCode/OpenCode |
| Структура (Home, Sidebar, диалоги) | ⚠️ Упрощена: нет Home, нет Sidebar, настройки — вьюхи вместо диалогов |

CLI NexusCode можно считать **валидным** по бэкенду, логике и интеграции с агентом; по стеку и внешнему виду он соответствует KiloCode в рамках выбора React и без отдельных экранов Home/Sidebar. При необходимости максимального сближения с KiloCode имеет смысл добавить экран Home (опционально), строку MCP в Footer и, при использовании server, вьюху или хоткей для списка сессий.

---

## 8. Сборка и запуск CLI одной командой

- **Требование:** для TUI нужен **Bun** (пакет `@opentui/core` использует `bun:ffi`; в Node будет ошибка «protocol bun:»).
- **Одна команда (из корня репозитория):** `pnpm run cli` (или `sh scripts/install-nexus-cli.sh`).
  - Скрипт: ставит зависимости (pnpm + Node), пересобирает native-модули под Node, собирает проект, ищет **Bun** и кладёт обёртку `nexus` в `~/bin`, которая запускает CLI через `bun`.
- **После установки:** из любой директории запуск командой `nexus` (обязательно установите Bun: `curl -fsSL https://bun.sh/install | bash`).
  - Скрипт при необходимости добавляет в `~/.bashrc` строку `export PATH="$HOME/bin:$PATH"` и выводит подсказку выполнить `source ~/.bashrc`.
  - Проверка: `which nexus` должен показывать `~/bin/nexus`.
- **Ошибка «bun:» при запуске через node:** TUI рассчитан на Bun. Запускайте через обёртку из `pnpm run cli` (она использует `bun`) или явно: `bun path/to/NexusCode/packages/cli/dist/index.js`.
