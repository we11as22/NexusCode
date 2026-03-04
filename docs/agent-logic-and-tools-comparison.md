# Агентная логика и тулзы: NexusCode и сравнение с Cline, Kilocode, Roo-Code, OpenCode

## 1. Как у нас (NexusCode) работает агентная логика и тулзы

### 1.1 Общий цикл

- **Точка входа:** `runAgentLoop()` в `packages/core/src/agent/loop.ts`.
- **Один «ход» пользователя** = внешний `while`-цикл: на каждой итерации собирается системный промпт, сообщения, список тулов, вызывается **один** стрим к модели (`client.stream(...)`), обрабатываются события стрима (текст, reasoning, tool_call, finish). Если модель вернула tool_calls — выполняем тулы, сохраняем сессию, **не** выходим из цикла: следующая итерация снова строит промпт уже с результатами тулов и снова вызывает модель. Цикл заканчивается при: `attempt_completion` / `plan_exit`, `finishReason === "stop"` без тулов, аборте, превышении бюджета тулов/итераций, фатальной ошибке.

### 1.2 Схемы тулов

- **Определение тула:** `ToolDef` в `packages/core/src/types.ts`: `name`, `description`, **`parameters: z.ZodType<TArgs>`**, `execute(args, ctx)`.
- **Встроенные тулы:** в `packages/core/src/tools/built-in/*.ts` — у каждого тула своя Zod-схема (`z.object({ ... })` с `.describe()` на полях).
- **MCP-тулы:** в `packages/core/src/mcp/client.ts`: у MCP приходят `inputSchema` (сырая JSON Schema). Мы вызываем **`normalizeToolSchema(inputSchema)`** (`packages/core/src/provider/tool-schema.ts`), затем **`buildZodSchema(normalizedSchema)`** — получается Zod. Итоговый тул отдаётся как обычный `ToolDef` с `parameters: buildZodSchema(...)`.
- **В провайдер:** в `packages/core/src/provider/base.ts` в `stream()` тулы передаются в AI SDK как `{ name, description, parameters }` (Zod). SDK сам конвертирует Zod → JSON Schema и отдаёт провайдеру. В loop при выполнении тула вызывается **`tool.parameters.parse(toolInput)`** — валидация по той же Zod-схеме.

Итого: **тулзы везде описываются схемами (Zod → JSON Schema у провайдера); модель «просто делает» вызовы по этим схемам, без отдельного шага «решить по схеме» в коде — решение принимает модель.**

### 1.3 Где модель именно «размышляет», а не просто делает

- **Нативный reasoning (thinking) провайдера:**  
  В `provider/base.ts` в цикле по `result.fullStream` обрабатывается `part.type === "reasoning"`: дельта передаётся как `reasoning_delta` и уходит в UI. В loop в `event.type === "reasoning_delta"` мы накапливаем `currentReasoning` и при каждом `flushAssistantContent()` пишем в сообщение ассистента часть `{ type: "reasoning", text: currentReasoning }`. В **`buildMessagesFromSession()`** при сборке сообщений для следующего запроса к модели мы **сначала** кладём все `reasoning`-части, потом текст, потом tool-call'ы. То есть **размышление модели — это поток reasoning от провайдера (o1, R1, OpenRouter thinking и т.д.)**, который мы сохраняем в сообщении и при следующем запросе снова отдаём модели. Отдельного «режима только подумать» в коде нет — модель сама стримит reasoning вместе с текстом/тулами.

- **Тул `thinking_preamble`:**  
  В `packages/core/src/tools/built-in/thinking-preamble.ts`: модель может **явно** вызвать тул с полями `reasoning_and_next_actions` и опционально `user_message`. Это не нативный reasoning провайдера, а **явная запись плана/рассуждений в контекст**: выполнение тула только проверяет «не два раза подряд», в сессию reasoning не пишется отдельным блоком — но текст из `reasoning_and_next_actions` попадает в контент сообщения как часть следующего запроса (через то, что тул уже в `content` сообщения ассистента и его результат в истории). То есть **модель «размышляет» в двух вариантах:** (1) стриминг reasoning от провайдера (если есть) и (2) опциональный вызов `thinking_preamble` с текстом рассуждений и следующих шагов.

- **Где модель «просто делает»:**  
  Любой другой тул (`read_file`, `write_to_file`, `replace_in_file`, `execute_command`, MCP и т.д.) — это действие по схеме: модель решает, что вызвать и с какими аргументами; мы валидируем через Zod и выполняем. Отдельного шага «сначала подумать по JSON Schema, потом действовать» в коде нет — всё в одном ответе модели (текст + reasoning при наличии + tool_calls).

---

## 2. Сравнение с другими проектами

### 2.1 Cline (`sources/cline`)

- **Агентный цикл / тулы:**  
  Задача создаётся в `newTask.ts` → `controller.initTask()`. Обработка стрима — в `StreamResponseHandler.ts`: отдельно **ToolUseHandler** (накопление tool_use дельт, парсинг JSON аргументов, маппинг в `ClineAssistantToolUseBlock`) и **ReasoningHandler** (накопление reasoning дельт в `PendingReasoning`, конвертация в `ClineAssistantThinkingBlock` с `type: "thinking"`). То есть **размышление** — это отдельный поток от провайдера (reasoning/thinking), обрабатываемый ReasoningHandler и сохраняемый в контент сообщения.
- **Схемы тулов:**  
  В `ClineToolSet` используются `ClineToolSpec`; в `spec.ts` — **`toolSpecFunctionDefinition()`** собирает OpenAI-формат: `function.parameters` = JSON Schema (type: "object", properties, required, additionalProperties: false). Провайдеры передают `tool.function.parameters` как есть. Отдельного «модель решает по схеме» нет — модель стримит tool_use с аргументами по этой схеме.
- **Где размышляет:**  
  Нативный reasoning/thinking провайдера (например DeepSeek R1, o1) — через ReasoningHandler; в `r1-format.ts` и др. reasoning из сообщений при необходимости прокидывается обратно в API (например `reasoning_content`). Дополнительно есть UI/настройки «Reasoning effort», «Thinking budget» — они влияют на запрос к API, а не на отдельный шаг «только подумать» в коде.

**Итого по Cline:** цикл «стрим → тулы + reasoning»; схемы тулов — ручная JSON Schema в spec; размышление — нативный reasoning провайдера, без отдельного тула «подумать».

---

### 2.2 Kilocode / OpenCode (`sources/kilocode`, `sources/opencode`)

- **Агентный цикл:**  
  В `packages/opencode/src/session/prompt.ts`: цикл по шагам; на каждом шаге собираются `tools`, `system`, `messages` (в т.ч. через `MessageV2.toModelMessages`), затем **`processor.process({ ... tools, toolChoice, ... })`**. Если в запросе включён **structured output по JSON Schema** (`lastUser.format?.type === "json_schema"`), в набор тулов добавляется **тул StructuredOutput** с `createStructuredOutputTool({ schema, onSuccess })`, в системный промпт — инструкция обязательно использовать этот тул, **`toolChoice: "required"`**. После `processor.process()` если `structuredOutput !== undefined`, он записывается в `processor.message.structured` и цикл завершается. Иначе цикл продолжается (следующий шаг с результатами тулов).
- **Схемы тулов:**  
  Тулы приходят в `processor.process()` в формате провайдера (в т.ч. JSON Schema для параметров); StructuredOutput тул строится через `jsonSchema(toolSchema)` (AI SDK). То есть **и параметры обычных тулов, и финальный ответ по схеме** задаются через схемы.
- **Где размышляет:**  
  Нет отдельного «режима только подумать». Модель в одном ответе может вызывать тулы и в конце — при включённом format — обязана вызвать StructuredOutput с JSON по схеме. Рассуждения модели — обычный текст/reasoning провайдера внутри этого же ответа.

**Итого по Kilocode/OpenCode:** цикл «process → тулы → при необходимости StructuredOutput»; размышление — в рамках одного ответа модели; отдельно выделен **structured output ответа по JSON Schema** (тул + tool_choice required).

---

### 2.3 Roo-Code (`sources/Roo-Code`)

- **Агентный цикл:**  
  В `src/core/task/Task.ts`: цикл `while (!this.abort)` с **`recursivelyMakeClineRequests(nextUserContent, includeFileDetails)`**. В комментарии явно сказано: Cline получает задачу, вызывает тулы; без `attempt_completion` мы продолжаем слать ему ответы с результатами тулов, пока он не сделает `attempt_completion` или не перестанет вызывать тулы; если тулов нет — просим подумать и вызвать `attempt_completion`. Есть лимит MAX_REQUESTS_PER_TASK. То есть **агентная логика по сути «запрос к Cline-совместимому API → обработка тулов → повтор запроса»**, без своего отдельного «reasoning step» в коде.
- **Схемы тулов:**  
  В `src/utils/json-schema.ts` — **`normalizeToolSchema()`** для custom и MCP тулов (JSON Schema 2020-12, additionalProperties, anyOf и т.д.). В `src/api/transform/ai-sdk.ts` при конвертации в AI SDK используется **`jsonSchema(t.function.parameters)`** как inputSchema. То есть тулы описываются нормализованной JSON Schema и передаются в провайдер.
- **Где размышляет:**  
  Размышление остаётся на стороне модели/провайдера в рамках того же запроса; в коде Roo-Code отдельного шага «сначала подумать» нет. Состояние цикла (running / waiting / idle) определяется по типам сообщений (ask/say) и документировано в `AGENT_LOOP.md`.

**Итого по Roo-Code:** цикл «Cline-запросы + тулы», нормализация схем тулов; размышление — внутри ответа модели, без отдельного шага в коде.

---

## 3. Сводная таблица

| Аспект | NexusCode | Cline | Kilocode/OpenCode | Roo-Code |
|--------|-----------|--------|-------------------|----------|
| **Цикл агента** | Один `runAgentLoop`: на каждой итерации один `client.stream()`; при tool_calls выполняем тулы, сохраняем, следующая итерация с теми же сообщениями + результаты тулов | Обработка стрима (ToolUseHandler + ReasoningHandler); итерации определяются контроллером/задачей | Цикл по шагам; на каждом шаге `processor.process()` с tools/toolChoice; при structured output — обязательный тул и выход | Цикл `recursivelyMakeClineRequests`; по сути повтор запросов к Cline-API с контентом пользователя и результатами тулов |
| **Схемы тулов** | Zod везде; MCP: normalizeToolSchema + buildZodSchema → Zod; провайдер получает JSON Schema из SDK | ClineToolSpec → spec.ts → function.parameters (JSON Schema, additionalProperties: false) | Тулы с параметрами по формату провайдера; StructuredOutput — jsonSchema(schema) | normalizeToolSchema (JSON Schema) → function.parameters; в AI SDK — jsonSchema(parameters) |
| **Где модель «размышляет»** | 1) Нативный reasoning_delta провайдера (сохраняем в сообщении, отдаём дальше) 2) Опционально тул thinking_preamble (явная запись плана в контекст) | Нативный reasoning/thinking провайдера (ReasoningHandler → thinking block); при необходимости reasoning_content в API | В рамках одного ответа модели; при format json_schema — обязан вызвать StructuredOutput | В рамках ответа модели; отдельного шага «подумать» в коде нет |
| **Где модель «просто делает»** | Любой вызов тула (read_file, write, replace, execute_command, MCP и т.д.): модель решает по схеме, мы валидируем Zod и выполняем | Вызовы tool_use по схемам из spec; выполнение в соответствующих handler'ах | Вызовы тулов в process(); выполнение через processor | Вызовы тулов в запросах к Cline-совместимому API; выполнение на стороне Roo/Cline |

---

## 4. Выводы

- **Схемы:** У нас, как и в Cline/Roo, тулы задаются схемами (у нас Zod → JSON Schema через SDK; у Cline — ручная JSON Schema; у Roo — нормализованная JSON Schema). MCP мы уже пропускаем через `normalizeToolSchema` и строим из этого Zod.
- **Размышление:** У нас модель «размышляет» в двух формах: (1) нативный reasoning стрим провайдера (если есть) и (2) опциональный тул `thinking_preamble`. В Cline размышление — только нативный reasoning; в Kilocode/OpenCode — текст/reasoning в одном ответе плюс обязательный structured output по схеме при включённом format; в Roo — внутри ответа модели без отдельного шага.
- **Отличие от Kilocode:** У них явный «ответ по JSON Schema» через тул StructuredOutput и tool_choice required; у нас такого режима нет — только классические тулы и при необходимости `generateObject` для отдельных сценариев.
