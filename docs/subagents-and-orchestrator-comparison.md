# Subagents and orchestrator: NexusCode vs KiloCode

## 1. Как устроены субагенты в NexusCode

### 1.1 Интеграция

- **Менеджер:** `ParallelAgentManager` в `packages/core/src/agent/parallel.ts`.
- **Тул:** `spawn_agent` создаётся через `createSpawnAgentTool(manager, config)` и регистрируется в `ToolRegistry` вместе с остальными built-in тулами.
- **Точка входа:** В `run-session.ts` (server) и в CLI при запуске сессии создаётся один экземпляр `ParallelAgentManager`, тул `spawn_agent` добавляется в реестр, после чего все режимы (agent, plan, ask, debug) получают этот тул в наборе инструментов (с учётом режима: в plan/ask субагенты всегда в ask).

### 1.2 Как выполняется spawn_agent

1. Главный агент вызывает тул `spawn_agent(description, context_summary?, mode?)`.
2. `ParallelAgentManager.spawn()`:
   - проверяет дубликаты по короткому ключу задачи (RECENT_SPAWN_CAP = 3);
   - ждёт свободный слот (лимит `config.parallelAgents.maxParallel`);
   - создаёт новый `Session` в том же `cwd`;
   - формирует user-сообщение: `context_summary + "\n\n---\n\nTask: " + description`;
   - эмитит `subagent_start`, затем вызывает `runSubAgent()`.
3. `runSubAgent()`:
   - создаёт новый LLM-клиент, тот же `ToolRegistry.getForMode(mode)` (agent/plan/ask/debug);
   - загружает rules, skills, compaction так же, как главный цикл;
   - поднимает **mockHost** (те же readFile/writeFile/runCommand и т.д., но без реального approval — `showApprovalDialog` всегда `{ approved: true }`);
   - вызывает **`runAgentLoop()`** с этой сессией, тулами, правилами и т.д. — то есть **полноценный вложенный цикл агента в том же процессе**;
   - перехватывает `tool_start`/`tool_end` и текст из стрима, пробрасывает их как `subagent_tool_start`/`subagent_tool_end` и накапливает `output`;
   - по завершении цикла эмитит `subagent_done` и возвращает `{ subagentId, sessionId, success, output, error? }`.
4. Результат тула возвращается главному агенту строкой: `Sub-agent <id> completed:\n\n<output>` (или ошибка).

Итого: субагент — это **отдельная сессия + полный runAgentLoop** в том же процессе, с тем же набором режимов (agent/plan/ask/debug), но с упрощённым host (авто-апрув). MCP/индексер в субагент не передаются (используется только встроенный набор тулов из `getForMode(mode)`).

### 1.3 UI и события

- В `types.ts`: события `subagent_start`, `subagent_tool_start`, `subagent_tool_end`, `subagent_done`.
- CLI (`index.ts`): пишет в stderr краткий лог по этим событиям.
- TUI (`App.tsx`): состояние `subAgents: SubAgentState[]`, обработка событий, `SubAgentCard` в интерфейсе.
- VS Code webview: store `subagents`, `SubagentStrip` в UI.

### 1.4 Промпты для субагентов и «оркестратор»

- В `packages/core/src/agent/prompts/components/index.ts` есть **SUB_AGENT_PROMPTS**: `explore` и `orchestrator` — готовые тексты для «исследователя» и «координатора».
- **Сейчас они нигде не подставляются:** `buildSystemPrompt(ctx)` не принимает флаг «это субагент» и не добавляет эти блоки. Субагент получает тот же системный промпт, что и главный агент, только с блоком режима по переданному `mode` (agent/plan/ask/debug) из `getModeBlock(ctx.mode)`. То есть **SUB_AGENT_PROMPTS — задел на будущее**, а не активная часть пайплайна.

---

## 2. Как устроен режим Orchestrator и субагенты в KiloCode (sources/kilocode)

### 2.1 Режим Orchestrator как отдельный агент

- В `packages/opencode/src/agent/agent.ts` объявлен агент **orchestrator**:
  - `name: "orchestrator"`, `description: "Coordinate complex tasks by delegating to specialized agents."`
  - `prompt: PROMPT_ORCHESTRATOR` (из `prompt/orchestrator.txt`)
  - `mode: "primary"` — пользователь может выбрать его как основной режим (в отличие от subagent-режимов).
  - **Permissions:** почти всё `deny`, явно разрешены: `read`, `grep`, `glob`, `list`, `bash`, `question`, **`task`**, `todoread`, `todowrite`, `webfetch`, `websearch`, `codesearch`, `external_directory` (truncate). То есть оркестратор **не может** редактировать файлы и вызывать edit-тулы — только читать, искать и вызывать **task** (субагентов).

### 2.2 Промпт оркестратора (orchestrator.txt)

- Стратегический координатор, который делегирует подзадачи специализированным агентам.
- Шаги: понять задачу → план → зависимости (независимые в одну волну, зависимые — в разные волны, один файл — не параллелить) → выполнять волнами → синтез.
- Для каждой подзадачи — тул **task** с типом агента: **explore** (исследование кодовой базы) или **general** (реализация, анализ). Оркестратор сам файлы не редактирует.

### 2.3 Тул Task и субагенты в KiloCode

- **Инструмент:** `packages/opencode/src/tool/task.ts` — тул **task** с параметрами: `description`, `prompt`, **`subagent_type`** (тип агента: explore, general и т.д.), опционально `task_id` (продолжить сессию).
- **Права:** у каждого агента в конфиге есть permission для `task` по паттернам (например `orchestrator-*`). Оркестратору явно дано `task: "allow"`. Субагенты (explore, general) имеют `mode: "subagent"` — их **нельзя** выбрать как default agent, они только через вызов task.
- **Выполнение task:**
  1. Создаётся или поднимается **новая Session** (при необходимости с `parentID: ctx.sessionID`), с заголовком типа `description + (@explore subagent)`.
  2. У этой сессии свои permission (например, у explore/general отключены todoread/todowrite; у general может быть отключён task, чтобы не плодить вложенные вызовы).
  3. Вызывается **SessionPrompt.prompt()** с этой сессией, `agent: agent.name` (explore / general), своими tools (по пермиссиям агента), и контентом из `params.prompt`.
  4. Это **полноценный цикл запросов к модели** (тот же SessionPrompt loop), только в контексте дочерней сессии и с другим агентом (другой системный промпт и набор тулов). Результат — текст ответа агента; он оборачивается в `<task_result>` и возвращается вызывающему агенту как output тула.

Итого в KiloCode: оркестратор — **отдельный режим (primary agent)** с промптом «только координируй и делегируй», а делегирование — через тул **task(subagent_type, prompt, ...)**, который запускает **вложенный цикл SessionPrompt** с агентом explore или general.

### 2.4 Explore и General как subagent-типы

- **explore:** промпт PROMPT_EXPLORE, быстрый поиск по коду, grep, glob, list, read, webfetch, websearch, codesearch. Реализацию не делает.
- **general:** общий агент для исследований и многошаговых задач; может выполнять несколько единиц работы (но без todoread/todowrite в типовой конфигурации).

Оба имеют `mode: "subagent"` в конфиге агентов — доступны только через вызов task, не через выбор режима пользователем.

---

## 3. Сравнительная таблица

| Аспект | NexusCode | KiloCode |
|--------|-----------|----------|
| **Режим «оркестратор»** | Отдельного режима нет. Есть текст `SUB_AGENT_PROMPTS.orchestrator`, но он не подставляется в системный промпт. Любой режим (agent/plan/ask/debug) может вызывать `spawn_agent`. | Отдельный primary-агент **orchestrator** с промптом из `orchestrator.txt`. Пользователь выбирает режим «Orchestrator». |
| **Как запускается субагент** | Тул **spawn_agent**(description, context_summary?, mode?). Один тип вызова, режим субагента (agent/plan/ask/debug) задаётся параметром. | Тул **task**(description, prompt, **subagent_type**, task_id?). Тип субагента — явно (explore, general и т.д.), у каждого типа свой агент с своим промптом и пермиссиями. |
| **Где выполняется субагент** | Тот же процесс: новая Session + **runAgentLoop** с mockHost. Отдельный процесс не поднимается. | Тот же процесс: новая Session + **SessionPrompt.prompt()** с выбранным агентом (explore/general). Отдельный процесс не поднимается. |
| **Промпт субагента** | Тот же системный промпт, что и у главного агента (buildSystemPrompt без учёта «субагент»). Отличие только в mode (getModeBlock) и в том, что контекст — одна задача (context_summary + description). Блоки SUB_AGENT_PROMPTS.explore/orchestrator не используются. | У каждого типа агента свой промпт (PROMPT_EXPLORE, конфиг general и т.д.). При вызове task(explore) или task(general) в цикл передаётся именно этот агент и его системный промпт. |
| **Специализация субагентов** | Один «тип» с вариацией по режиму (agent/ask/debug/plan). Специализация только за счёт описания задачи и режима (например ask = read-only). | Несколько типов: **explore** (поиск, чтение), **general** (анализ, многошаговые задачи). Разные промпты и пермиссии. |
| **Ограничения оркестратора** | Нет отдельного оркестратора; главный агент в agent-режиме может и сам всё делать, и спавнить субагентов. В plan/ask субагенты всегда в ask. | Оркестратор не может редактировать файлы; может только читать, искать и вызывать task(explore | general). Реализация только через субагентов. |
| **Волны и планирование** | В промпте (getModeBlock для agent) сказано использовать spawn_agent рано и не дублировать. Явной «волновой» модели в коде нет — модель сама решает, когда и сколько раз вызвать spawn_agent. | В промпте оркестратора явно: разбить на подзадачи, классифицировать зависимости, выполнять волнами (параллельные вызовы task в одном сообщении), потом следующая волна. |
| **Повторное использование сессии** | Нет. Каждый spawn_agent создаёт новую сессию, результат возвращается строкой. Продолжить ту же сессию субагента нельзя. | Есть: параметр **task_id** — продолжить существующую сессию субагента (те же сообщения и контекст). |
| **События в UI** | subagent_start, subagent_tool_start, subagent_tool_end, subagent_done; отображаются в CLI и в TUI/VS Code. | Аналогичная идея (сессия/тул субагента) в своей модели сообщений и UI. |

---

## 4. Выводы

- **NexusCode:** субагенты реализованы как один универсальный тул `spawn_agent` с выбором режима (agent/plan/ask/debug). Отдельного «режима оркестратор» нет; оркестраторский текст в SUB_AGENT_PROMPTS не используется. Все субагенты получают общий системный промпт, различие только в режиме и в одной задаче в user-сообщении.
- **KiloCode:** оркестратор — отдельный режим с промптом «только координируй, не редактируй», делегирование — через тул **task** с явным типом субагента (explore / general). У каждого типа свой промпт и права; поддерживается возобновление сессии по task_id.
- Если в NexusCode нужно поведение ближе к KiloCode: (1) можно ввести отдельный режим `orchestrator` и подставлять `SUB_AGENT_PROMPTS.orchestrator` в buildSystemPrompt при этом режиме, ограничив тулы (только read/search + spawn_agent); (2) при spawn_agent по желанию подставлять SUB_AGENT_PROMPTS.explore когда mode === "ask", чтобы субагент-исследователь получал явную инструкцию «explore»; (3) при необходимости добавить аналог task_id для продолжения сессии субагента (сейчас не реализовано).
