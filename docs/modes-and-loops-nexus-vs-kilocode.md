# Режимы, агенты и лупы: NexusCode vs Kilocode

Краткое сравнение: где какая лупа, какие режимы, какие агенты и как они связаны.

---

## 1. NexusCode

### 1.1 Одна лупа — один цикл

| Где | Что |
|-----|-----|
| **Точка входа** | `runAgentLoop(opts)` в `packages/core/src/agent/loop.ts` |
| **Кто вызывает** | CLI (`packages/cli/src/index.ts` → `runMessage` → `runAgentLoop`), Extension (`packages/vscode/src/controller.ts` → `runAgent` → `runAgentLoop`), Server (`packages/server/src/run-session.ts` → `runAgentLoop`) |
| **Структура** | Один `while`-цикл: на каждой итерации — сбор system prompt, messages, tools → **один** `client.stream(...)` → обработка стрима (text_delta, reasoning_delta, tool_call, finish). Если есть tool_calls — выполняем тулы, пишем в сессию, **не выходим** — следующая итерация с теми же сообщениями + результаты тулов. |
| **Выход из лупы** | `attempt_completion` или `plan_exit` выполнен; `finishReason === "stop"` без тулов; аборт; превышен лимит итераций/тулов; фатальная ошибка. При лимите итераций тулы отключаются, запрашивается только текст. |

Итого: **одна лупа на один «ход» пользователя**; режим задаётся параметром `mode` при входе в `runAgentLoop` и не меняется внутри лупы.

### 1.2 Режимы (modes)

| Режим | Файл | Группы тулов | Заблокированные тулы | Смысл |
|-------|------|--------------|----------------------|--------|
| **agent** | `modes.ts` | always, read, write, execute, search, browser, mcp, skills, agents, context | plan_exit | Полный доступ: чтение/запись/команды/поиск/MCP/скиллы/субагенты. Выполнение задач до конца. |
| **plan** | `modes.ts` | always, read, write, search, browser, mcp, skills, agents, context, **plan_exit** | execute_command | Только план: писать можно только в `.nexus/plans/*.md|.txt`. execute_command запрещён. Завершение фазы планирования — вызов **plan_exit**. |
| **ask** | `modes.ts` | always, read, search, browser, mcp, skills, agents, context | write_to_file, replace_in_file, execute_command, create_rule, plan_exit | Только чтение: ответы, объяснения, анализ. Субагенты разрешены (в ask). |
| **debug** | `modes.ts` | как agent (read, write, execute, search, …) | plan_exit | Диагностика и точечные правки: сначала разобраться, потом минимальные фиксы. |

- Режим задаётся **до** входа в `runAgentLoop` (CLI/Extension/Server передают `mode` из UI или команды).
- Внутри лупы набор тулов фиксирован по `getBuiltinToolsForMode(mode)` и `getBlockedToolsForMode(mode)`; смена режима по ходу одного запуска **не предусмотрена**.

### 1.3 Агенты и субагенты

| Роль | Где | Как |
|------|-----|-----|
| **Основной агент** | Один вызов `runAgentLoop` на одно сообщение пользователя | Одна сессия (`session`), один `mode`, один цикл до `attempt_completion` / `plan_exit` / stop / abort / лимит. |
| **Субагент** | Тул `spawn_agent` → `ParallelAgentManager.spawn()` → `runSubAgent()` | Новая `Session`, **тот же** `runAgentLoop` в том же процессе. Режим субагента задаётся при вызове (в plan/ask главного агента субагенты по контракту запускаются в **ask**). Host — mockHost (авто-апрув). MCP/индексер в субагент не передаются. |

То есть **нет отдельных «типов агентов» (orchestrator / explore / general)** — есть один тип лупы (`runAgentLoop`) и четыре режима; субагент — это та же лупа с другой сессией и (часто) режимом ask.

### 1.4 Plan: двухфазность (Kilocode-style)

- **Фаза 1:** пользователь в режиме **plan**; агент изучает кодовую базу, пишет план в `.nexus/plans/`, вызывает **plan_exit** с кратким итогом.
- **Фаза 2:** UI показывает «Ready to implement?» (New session / Continue / Dismiss). При Approve/Continue следующий запуск — уже в режиме **agent** с текстом плана в контексте (новая сессия или «Implement the plan above»).

Логика «plan_exit завершил ход» и показ панели выбора — в CLI/Extension; в core — только тул `plan_exit` и `hadPlanExit(session)` / `getPlanContentForFollowup(session, cwd)` в `session/plan-followup.ts`.

---

## 2. Kilocode / OpenCode (по документации и анализу)

### 2.1 Лупа: цикл по шагам + процессор

| Где | Что |
|-----|-----|
| **Точка входа цикла** | `packages/opencode/src/session/prompt.ts` — цикл по шагам |
| **Один шаг** | Собираются `tools`, `system`, `messages` → **`processor.process(streamInput)`** в `session/processor.ts` |
| **Внутри process** | Один вызов `LLM.stream(streamInput)`, обход `stream.fullStream`: reasoning-start/delta/end → ReasoningPart; tool-call → выполнение тулов. Результат возвращается в prompt.ts. |
| **Продолжение цикла** | Если был вызов **StructuredOutput** (при включённом format json_schema) — цикл завершается. Иначе при `finish === "tool-calls"` — следующий шаг с теми же сообщениями + результаты тулов. Есть лимит шагов (аналог нашего лимита итераций). |

Итого: **одна лупа = цикл шагов**, на шаге — один вызов процессора (один stream к модели + выполнение тулов). Отдельно — режим **structured output по JSON Schema** (тул + tool_choice required), после которого цикл завершается.

### 2.2 Режимы и план в Kilocode

- **Plan:** есть тулы **plan_enter** и **plan_exit**; plan mode — режим, в котором агент пишет план в файл и завершает фазу планирования вызовом **plan_exit** (по смыслу близко к нашему plan + plan_exit).
- **Reasoning:** в процессоре явно обрабатываются `reasoning-start`, `reasoning-delta`, `reasoning-end` → части сообщения типа ReasoningPart; связь «встроенный ризонинг модели» ↔ «части сообщения» задаётся в API моделей (`reasoning: true`, `interleaved: { field: "reasoning_content" }`).

### 2.3 Агенты и субагенты в Kilocode

| Роль | Где | Как |
|------|-----|-----|
| **Primary-агенты** | Конфиг агентов, выбор пользователем | Например **orchestrator** — отдельный агент с промптом «только координируй и делегируй», права в основном deny, разрешён тул **task**. Режим `mode: "primary"` — можно выбрать как основной. |
| **Subagent-типы** | explore, general и т.д. | `mode: "subagent"` — **нельзя** выбрать в UI, только через вызов тула **task**. |
| **Тул task** | `packages/opencode/src/tool/task.ts` | Параметры: description, prompt, **subagent_type** (explore / general). Создаётся/берётся дочерняя Session, вызывается **SessionPrompt.prompt()** с агентом explore или general — **вложенный цикл запросов** с другим системным промптом и набором тулов. Результат оборачивается в `<task_result>` и возвращается вызывающему агенту. |

Итого: в Kilocode **несколько типов агентов** (orchestrator, explore, general): разные промпты и наборы тулов; оркестратор только делегирует через **task(subagent_type, …)**; субагенты — отдельные «лупы» через SessionPrompt с типом explore/general.

---

## 3. Сводная таблица

| Аспект | NexusCode | Kilocode / OpenCode |
|--------|-----------|----------------------|
| **Главная лупа** | Одна функция `runAgentLoop`: на итерации один `client.stream()`, при tool_calls выполняем тулы и повторяем итерацию | Цикл по шагам в prompt.ts; на шаге один `processor.process()` (один LLM.stream + выполнение тулов) |
| **Режимы** | Один параметр `mode`: agent | plan | ask | debug. Один набор тулов на весь запуск | Режим/агент задаётся конфигом (primary vs subagent); plan через plan_enter/plan_exit |
| **Выход из лупы** | attempt_completion, plan_exit, stop без тулов, аборт, лимиты | StructuredOutput (если включён); иначе при tool_calls — следующий шаг; лимит шагов |
| **Plan** | Режим **plan** + тул **plan_exit**; после plan_exit UI: New session / Continue / Dismiss | plan_enter / plan_exit; план в файле; по смыслу тот же двухфазный сценарий |
| **Субагенты** | Один тип лупы: **spawn_agent** → новая Session + **runAgentLoop** (тот же код). Режим субагента — agent/ask и т.д. | Отдельные **типы агентов**: explore, general (mode: "subagent"). Тул **task(subagent_type, …)** → SessionPrompt.prompt() с выбранным агентом — другая лупа с другим промптом и тулами |
| **Оркестратор** | Нет отдельного агента; главный агент в режиме agent может вызывать spawn_agent | Отдельный агент **orchestrator** (primary), промпт «только координируй», тул **task** для делегирования explore/general |
| **Где агенты** | Одна реализация агента в core (loop.ts); «режимы» = разные наборы тулов и блокировок | Несколько агентов в конфиге (orchestrator, explore, general); у каждого свой промпт и права; субагенты — вложенные вызовы SessionPrompt |

---

## 4. Реализация режимов plan / ask / agent / debug: код и подход

### 4.1 NexusCode: один агент, четыре режима в коде

**Где задаётся:** `packages/core/src/agent/modes.ts` + `packages/core/src/types.ts` (`Mode = "agent" | "plan" | "ask" | "debug"`).

**Как реализовано:**

| Элемент | Реализация |
|--------|-------------|
| **Список режимов** | Константа `MODES`, тип `Mode` — фиксированный enum из четырёх значений. |
| **Набор тулов на режим** | `MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]>` — для каждого режима список **групп** (always, read, write, execute, search, …). Группы разворачиваются в имена тулов через `TOOL_GROUP_MEMBERS`. |
| **Блокировки** | `MODE_BLOCKED_TOOLS: Record<Mode, string[]>` — тулы, которые в этом режиме **никогда** не отдаются в LLM (в loop при сборке `resolvedTools` выкидываются). |
| **Спецправила plan** | В plan режиме write не запрещён глобально, но в **loop** при выполнении `write_to_file`/`replace_in_file` проверяется путь: разрешён только `PLAN_MODE_ALLOWED_WRITE_PATTERN` (`.nexus/plans/*.md|.txt`). Исходники блокируются через `PLAN_MODE_BLOCKED_EXTENSIONS` при записи. |
| **Промпт на режим** | В `packages/core/src/agent/prompts/components/index.ts`: `getModeBlock(mode)` возвращает кусок системного промпта для данного режима. Один и тот же `buildSystemPrompt(ctx)` подставляет разный текст в зависимости от `ctx.mode`. |
| **Вход в лупу** | CLI/Extension/Server передают `mode` в `runAgentLoop({ ..., mode })`. В loop: `getBuiltinToolsForMode(mode)`, `getBlockedToolsForMode(mode)` — набор тулов фиксируется на весь запуск. |

Итого: **режим = параметр типа `Mode`**. Одна лупа, один системный промпт (с подстановкой блока по режиму), один реестр тулов; различие только в том, **какие тулы включены и какие заблокированы**, и в тексте промпта. Отдельного конфига «агентов» нет — всё зашито в `modes.ts` и промптах.

### 4.2 Kilocode: агенты из конфига, права по пермиссиям

**Где задаётся:** конфиг агентов (например `packages/opencode/src/agent/agent.ts` и связанные конфиги/файлы промптов). Нет единого enum «plan | ask | agent | debug» — есть **набор агентов** с именами, промптами и правами.

**Как реализовано (по документации):**

| Элемент | Реализация |
|--------|-------------|
| **«Режимы»** | Это не режимы, а **отдельные агенты**: у каждого `name`, `prompt` (файл или строка), `mode: "primary"` или `"subagent"`, и **permissions** — разрешения по тулам/категориям (allow/deny). Пользователь выбирает **агента** (primary), а не «режим». |
| **Набор тулов** | Определяется **permissions** агента: например `read: "allow"`, `write: "deny"`, `task: "allow"`. Набор тулов для сессии собирается по этим правилам, а не по одному общему табличному разбиению на группы. |
| **Plan** | Реализуется тулами **plan_enter** и **plan_exit** и, при необходимости, агентом/контекстом, у которого разрешён только план (ограничение write по пути и т.п.). Отдельного «режима plan» как в NexusCode может не быть — план как фаза работы с теми же тулами plan_enter/plan_exit. |
| **Ask-подобное** | Агент **explore** (subagent): промпт PROMPT_EXPLORE, права в основном read/search (grep, glob, list, read, webfetch, websearch, codesearch). Реализацию не делает — по смыслу аналог нашего **ask** (read-only), но как **отдельный тип агента**, а не переключатель режима. |
| **Agent-подобное** | Агент **general** или основной «full» агент: больше прав (в т.ч. write/execute при необходимости). Реализация задач через этого агента или через делегирование task(explore | general). |
| **Debug** | В документации Kilocode отдельный агент/режим «debug» не выделен; диагностика и точечные правки могли бы быть либо промптом основного агента, либо отдельным агентом с ограниченными правами. |
| **Промпт** | У каждого агента **свой** системный промпт (файл `prompt/orchestrator.txt`, PROMPT_EXPLORE и т.д.). Не один общий промпт + подстановка блока по режиму, а разные промпты для разных агентов. |

Итого: **«режим» в Kilocode = выбор агента из конфига**. Разные агенты = разные промпты и разные **permissions** (набор тулов). Одна и та же лупа (SessionPrompt / process) вызывается с разными `agent` и разным набором tools.

### 4.3 Сводка: реализация режимов

| Аспект | NexusCode | Kilocode |
|--------|-----------|----------|
| **Где определены режимы** | Один файл `modes.ts`: enum `Mode`, `MODE_TOOL_GROUPS`, `MODE_BLOCKED_TOOLS`, `TOOL_GROUP_MEMBERS`. Тип в `types.ts`. | Конфиг агентов: у каждого агента name, prompt, mode (primary/subagent), permissions. |
| **Как задаётся набор тулов** | По режиму: группы → имена тулов, минус заблокированные. Жёстко в коде. | По permissions агента (allow/deny по тулам или категориям). Гибко в конфиге. |
| **Промпт** | Один `buildSystemPrompt(ctx)`; кусок по режиму — `getModeBlock(ctx.mode)`. | У каждого агента свой промпт (файл/строка). |
| **Plan** | Режим **plan** + тул **plan_exit**; write только в `.nexus/plans/`; в коде проверка пути и расширений в loop. | Тулы **plan_enter** / **plan_exit**; ограничения по пути/контексту в рамках прав агента. |
| **Ask** | Режим **ask**: нет write, execute, plan_exit; есть read, search, browser, spawn_agent (субагент в ask). | Агент **explore** (subagent): read-only набор тулов, промпт «исследование». |
| **Agent** | Режим **agent**: все тулы кроме plan_exit. | Primary-агент с полными правами или **general** (субагент с нужными правами). |
| **Debug** | Режим **debug**: те же тулы что agent, без plan_exit; в промпте акцент на диагностику и минимальные фиксы. | Явного «debug» в документации нет; при необходимости — отдельный агент или промпт. |
| **Добавить новый «режим»** | Правка кода: добавить значение в `Mode`, строки в `MODE_TOOL_GROUPS` и `MODE_BLOCKED_TOOLS`, блок в `getModeBlock`. | Добавить нового агента в конфиг (prompt + permissions). |

---

## 5. Выводы

- **Лупа:** у нас одна — `runAgentLoop`; у Kilocode — цикл шагов с процессором на каждом шаге. И там и там «одна итерация = один запрос к модели + выполнение тулов», при наличии tool_calls цикл продолжается.
- **Режимы:** у нас — четыре режима (agent/plan/ask/debug) как варианты одного агента (разные тулы и блокировки в `modes.ts` + разный кусок промпта); у Kilocode — отдельные агенты (orchestrator, explore, general) с разными промптами и правами в конфиге, плюс plan через plan_enter/plan_exit.
- **Реализация:** у нас режим = enum + две таблицы (группы тулов и блокировки) + проверки путей для plan; у Kilocode «режим» = выбор агента с его permissions и промптом. Один код против конфигурируемых агентов.
- **Субагенты:** у нас субагент = та же `runAgentLoop` с новой сессией и (часто) режимом ask; у Kilocode субагент = вызов SessionPrompt с агентом типа explore или general, т.е. другая «лупа» с другим типом агента.
- **Оркестратор:** у нас нет выделенного оркестратора; в Kilocode есть отдельный primary-агент orchestrator с тулом task для делегирования.

Этот документ можно использовать как референс при выравнивании поведения с Kilocode или при добавлении режимов/агентов.
