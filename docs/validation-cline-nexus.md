# Валидация: Cline → NexusCode Extension

Проверка того, что расширение NexusCode **архитектурно скопировано с Cline**, **адаптировано под агента на сервере** и под **все фичи агента** (стриминг, тулзы, векторная БД, БД диалогов/сессий с динамической загрузкой), а также что **вид чата и прогресса** соответствует целевой картинке (Cline-like UX).

---

## 1. Что скопировано с Cline (архитектура)

| Элемент Cline | В NexusCode | Статус |
|---------------|-------------|--------|
| **Controller** — единственный владелец задачи и состояния | `packages/vscode/src/controller.ts`: класс `Controller` владеет session, config, isRunning, indexer, mcpClient, checkpoint, serverSessionId | ✅ |
| **getStateToPostToWebview** | `controller.getStateToPostToWebview()` — собирает messages, mode, todo, indexStatus, context tokens, serverUrl | ✅ |
| **postStateToWebview** | `controller.postStateToWebview()` — шлёт stateUpdate в webview | ✅ |
| **clearTask / cancelTask** | `controller.clearTask()`, `controller.cancelTask()` | ✅ |
| **Провайдер только держит webview и делегирует** | `NexusProvider` создаёт Controller, все сообщения из webview идут в `controller.handleWebviewMessage()` | ✅ |
| **Инициализация без блокировки UI** | `ensureInitialized()` в фоне, stateUpdate после загрузки конфига/сессии | ✅ |

**Чего нет (и не переносилось):** полный код Cline (Task с `initiateTaskLoop`/`recursivelyMakeClineRequests`, ToolExecutorCoordinator, StateManager на диске, gRPC webview↔extension, 30+ Cline-специфичных tool handlers). Вместо этого бэкенд — **NexusCode core** (`runAgentLoop`) и **NexusCode server**.

---

## 2. Адаптация под агента на сервере

| Требование | Реализация | Статус |
|------------|------------|--------|
| Запуск агента на сервере при заданном `serverUrl` | При `getServerUrl()` не пусто: POST `/session`, POST `/session/:id/message`, стрим из `res.body` парсится по строкам, каждую строку как `agentEvent` в webview | ✅ |
| Сессии и сообщения в БД | Сервер (packages/server): SQLite, сессии + сообщения, пагинация GET `/session/:id/message?limit=&offset=` | ✅ |
| Динамическая загрузка сессий | Список сессий: GET `/session?directory=` при serverUrl; при переключении — GET сообщений с `limit=100&offset=meta.messageCount-100` | ✅ |
| Ограничение памяти | После прогона подгружаются только последние 100 сообщений сессии; в памяти не более 100 | ✅ |

---

## 3. Фичи агента (стриминг, тулзы, векторная БД, БД диалогов)

| Фича | Где реализовано | Статус |
|------|-----------------|--------|
| **Стриминг** | Core эмитит `text_delta`, `reasoning_delta`, `tool_start`, `tool_end`, `done`, `error`; controller при локальном run передаёт в `postMessageToWebview({ type: "agentEvent", event })`; при server — те же события из SSE-подобного потока тела ответа | ✅ |
| **Тулзы** | `runAgentLoop` с `ToolRegistry`, MCP tools, builtin tools; VsCodeHost + approvals (Allow / Allow Always / Deny) | ✅ |
| **Векторная БД** | `createCodebaseIndexer(cwd, config)` при `config.indexing.enabled`; `config.indexing.vector` и `config.vectorDb`; статус в webview через `indexStatus` / `index_update` | ✅ |
| **БД диалогов/сессий** | Сервер: сессии и сообщения в SQLite; расширение при serverUrl использует только API сервера для списка и переключения сессий и загрузки сообщений с пагинацией | ✅ |
| **Чекпоинты** | `CheckpointTracker` в core; при `config.checkpoint.enabled` создаётся в controller, передаётся в host и в `runAgentLoop` | ✅ |
| **Compaction** | Команда compact → `compaction.compact(session, client)`; события `compaction_start` / `compaction_end` в webview | ✅ |
| **Apply settings в runtime** | После saveConfig: при смене MCP — `reconnectMcpServers()`; при смене indexing/vectorDb — `initializeIndexer(cwd)` | ✅ |

---

## 4. Контракт webview ↔ extension (по Cline-дополнению)

| Требование из cline.md §20–21 | Реализация | Статус |
|-------------------------------|------------|--------|
| newMessage/abort/saveConfig/switchSession/reindex → немедленный stateUpdate | handleWebviewMessage по типам вызывает соответствующие методы и в конце нужных веток вызывается `postStateToWebview()` | ✅ |
| При ошибке раннера — agentEvent.error и сброс isRunning | В store при `event.type === "error"` выставляется `isRunning: false` и показывается сообщение об ошибке | ✅ |
| Текст/reasoning/tool-события раздельно | text_delta, reasoning_delta, tool_start, tool_end приходят отдельными agentEvent | ✅ |
| Не оставлять UI в Running без done/error | done и error в core; в store обрабатываются и сбрасывают isRunning | ✅ |
| После saveConfig — применение в runtime (LLM/MCP/indexer) | saveConfig в controller перезаписывает config, при изменении MCP/index — переподключение MCP и переинициализация indexer | ✅ |
| Approve для write/execute; Allow Always на сессию | VsCodeHost.showApprovalDialog с Allow / Allow Always / Deny; alwaysApprove запоминается в host | ✅ |

---

## 5. Вид чата и прогресса (Cline-like UX)

Реализовано по описанию из cline.md и распакованного VSIX:

| Элемент | Реализация | Статус |
|---------|------------|--------|
| **Автоскролл только если пользователь «у дна»** | MessageList: `stickToBottom`, при скролле вверх `distanceToBottom >= 24` → false | ✅ |
| **Кнопка "Jump to latest"** | При `!stickToBottom` показывается кнопка `nexus-jump-latest` | ✅ |
| **Thought/Reasoning блок** | `ThoughtBlock`: "Thought for Xs" с таймером, превью reasoning текста (как в целевой картинке) | ✅ |
| **Прогресс (todo)** | `ProgressTodoBlock`: чеклист с галочками/спиннером, заголовок — последнее user-сообщение, счётчик current/total | ✅ |
| **Карточки тулов** | `ToolCallCard`: иконка, имя тула, статус (pending/running/completed/error), раскрываемый input/output, diff-стиль для вывода с +/- строками, ссылки "Open path:line" | ✅ |
| **Загрузка списка сессий** | SessionsView: при sessionsLoading — "Loading..." с анимированными точками (nexus-loading-dots, как Cline) | ✅ |
| **Баннер ожидания апрува** | При awaitingApproval — баннер «Action awaiting your approval — check the VS Code notification» | ✅ |
| **Компактинг** | Баннер "Compacting conversation..." и после — "Summarized Chat context summarized." | ✅ |
| **Статус-бар** | provider/model, session id, контекст (tokens, %), бейдж "Running" со спиннером при isRunning | ✅ |

**Картинка, которую вы кидали:** в текущем контексте её нет. Если пришлёте скрин ещё раз, можно точечно подогнать отступы, цвета и подписи под неё (например, точный вид Thought block или полоски прогресса).

---

## 6. Итоговая таблица

| Категория | Полнота | Комментарий |
|-----------|---------|-------------|
| Копирование расширения Cline | Архитектура | Controller + делегирование в провайдере; бэкенд — NexusCode core/server, не код Cline |
| Агент на сервере | ✅ | serverUrl, POST/GET API, стрим из ответа, пагинация 100 сообщений |
| Стриминг | ✅ | text_delta, reasoning_delta, tool_*, done, error |
| Тулзы | ✅ | ToolRegistry, MCP, builtin, approvals в host |
| Векторная БД | ✅ | Indexer с vector+Qdrant, настройки в Settings |
| БД диалогов/сессий | ✅ | Сервер SQLite, список сессий, переключение, динамическая подгрузка последних 100 сообщений |
| Вид чата и прогресса | ✅ | Scroll + Jump to latest, ThoughtBlock, ProgressTodoBlock, ToolCallCard (diff-style), Loading dots, баннеры |

Если нужно добить что-то под конкретную картинку чата — пришлите её, можно точечно поправить разметку и стили.
