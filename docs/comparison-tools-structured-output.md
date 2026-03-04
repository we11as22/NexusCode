# Сравнение: тулы и structured output (Cline, Kilocode, Roo-Code, NexusCode)

## Сводка по системам

| Аспект | Cline | Kilocode | Roo-Code | NexusCode |
|--------|--------|----------|----------|-----------|
| **Схема параметров тулов** | ClineToolSpec.parameters → ручная сборка JSON Schema (properties, required, additionalProperties: false) в spec.ts | Тулы с параметрами в формате провайдера (JSON Schema) | Zod / MCP inputSchema → normalizeToolSchema() → JSON Schema 2020-12, strict | Zod → конвертация в AI SDK → JSON Schema у провайдера |
| **Structured output ответа агента** | Нет | Да: тул StructuredOutput + при поддержке response_format с json_schema | Нет | Нет (есть только generateObject для отдельных сценариев) |
| **Нормализация схем** | Минимальная: additionalProperties: false, базовая object | Не выделена | Полная: draft 2020-12, additionalProperties, anyOf, форматы, сведение anyOf/oneOf/allOf | Нет — полностью на совести AI SDK |

---

## 1. Схема параметров тулов

### Cline
- Схема задаётся в `ClineToolSpec.parameters` (массив полей с name, required, instruction, type, items, properties).
- `toolSpecFunctionDefinition()` в spec.ts собирает OpenAI-формат: `function.parameters` = `{ type: "object", properties, required, additionalProperties: false }`.
- Провайдеры передают `tool.function.parameters` как есть.

### Kilocode
- Тулы с параметрами в формате провайдера (в т.ч. JSON Schema); API «tools with JSON schema parameters».

### Roo-Code
- **Custom tools:** Zod-схема → `parametersSchema.toJSONSchema(parameters)`.
- **Нормализация:** `normalizeToolSchema()` в `src/utils/json-schema.ts`:
  - JSON Schema 2020-12, `additionalProperties: false` по умолчанию для object;
  - преобразование `type: ["T", "null"]` в anyOf;
  - обрезка неподдерживаемых format;
  - сведение верхнеуровневых anyOf/oneOf/allOf для OpenRouter/Claude и др.
- **MCP:** для каждого MCP-тула вызывается `normalizeToolSchema(originalSchema)` → `function.parameters`.
- В AI SDK используется `jsonSchema(t.function.parameters)` как inputSchema.

### NexusCode (сейчас)
- **Где:** `packages/core/src/types.ts` — `ToolDef` с `parameters: z.ZodType<TArgs>`; `packages/core/src/provider/base.ts` — передаём в `streamText()` объект `tools` с `description` и `parameters` (zod).
- Конвертация zod → JSON Schema выполняется внутри AI SDK; мы не задаём явно `additionalProperties: false` и не нормализуем под провайдеров.
- Валидация: в `loop.ts` в `executeToolCall()` вызывается `tool.parameters.parse(toolInput)`.

**Что можно поменять у нас:**

- **A) Явная строгость и нормализация (по мотивам Cline/Roo):**
  - Не меняя контракт с AI SDK (оставляем zod в коде), можно:
    - Проверить все встроенные тулы: не использовать `.passthrough()` / `.strip()`, чтобы объекты по сути были строгими.
    - Опционально: добавить слой нормализации для **MCP-тулов** (и любых тулов с «сырой» JSON Schema), если позже будем прокидывать их схему в API: новый модуль `packages/core/src/provider/tool-schema.ts` с `normalizeToolSchema(schema: Record<string, unknown>): Record<string, unknown>` и вызов его перед передачей схемы в провайдер (когда/если появится путь с сырой схемой).
  - Места: все `packages/core/src/tools/built-in/*.ts` (проверка zod), при появлении MCP/сырых схем — `provider/base.ts` или отдельный слой перед вызовом SDK.

- **B) Передача уже нормализованной JSON Schema в провайдер (как в Roo):**
  - Потребует изменений в том, как мы передаём тулы в AI SDK: сейчас SDK принимает zod; чтобы подставлять свою JSON Schema, нужно либо форкать/оборачивать вызов провайдера, либо использовать API, которое принимает уже готовый JSON Schema (если такое есть у `streamText`/провайдеров AI SDK). Сейчас это неочевидно без правок в зависимостях — можно отложить и зафиксировать как идею на будущее.

---

## 2. Structured output для ответа агента

### Kilocode
- В `MessageV2` задаётся формат ответа: `OutputFormatJsonSchema: { type: "json_schema", schema, retryCount }`.
- В `SessionPrompt.prompt()` можно передать `format: { type: "json_schema", schema, retryCount }`.
- В `packages/opencode/src/session/prompt.ts`: если у последнего user-сообщения `format?.type === "json_schema"`, в набор тулов добавляется тул **StructuredOutput** (`createStructuredOutputTool({ schema, onSuccess })`), в системный промпт — инструкция обязательно использовать этот тул, `toolChoice = "required"`.
- Результат вызова тула попадает в `structuredOutput` → `processor.message.structured`, цикл завершается.
- При поддержке провайдера используется нативный `response_format` / `text.format` с `json_schema`.

### NexusCode (сейчас)
- **Где:** `packages/core/src/provider/structured-output.ts` — `generateObject()` и fallback `extractJsonFromStream()`; используется для отдельных сценариев (например, классификация), не для основного ответа агента в чате.
- В основном цикле агента (`loop.ts`) нет ни тула «ответ по схеме», ни `response_format` для финального ответа.

**Что можно поменять у нас:**

- **C) Опциональный structured output для финального ответа (по мотивам Kilocode):**
  - Добавить опцию в конфиг/запрос: «финальный ответ агента по JSON Schema» (например, `replyFormat: { type: "json_schema", schema }`).
  - Два варианта реализации:
    1. **Тул StructuredOutput:** в `loop.ts` при включённом replyFormat добавлять в список тулов специальный тул с `schema`; в системный промпт — инструкцию вызвать его один раз с JSON по схеме; при необходимости выставлять `toolChoice: "required"` (если SDK и провайдер поддерживают). После вызова тула — брать результат как финальный структурированный ответ и завершать цикл.
    2. **Нативный response_format:** при `client.supportsStructuredOutput()` и включённом replyFormat передавать в вызов провайдера (через опции `streamText` или провайдер-специфичные параметры) `response_format` / аналог с `json_schema` для основного ответа. Зависит от того, поддерживает ли AI SDK и конкретные провайдеры это в `streamText`.
  - Места: конфиг/типы (`config/schema.ts`, `types.ts`), `loop.ts` (условие, добавление тула, обработка ответа), при необходимости `provider/base.ts` или провайдер-специфичные обёртки для `response_format`.

---

## 3. Рекомендуемый порядок изменений

1. **Сейчас (низкий риск):**
   - Проверить все встроенные тулы: строгие zod-схемы без `.passthrough()`, явные описания полей (.describe()) — уже в духе Cline/Roo по строгости параметров.
   - Задокументировать в коде/ARCHITECTURE: «параметры тулов задаются через Zod, в API уходят в виде JSON Schema через AI SDK; structured output по схеме для основного ответа не используется».

2. **При появлении MCP или сырых JSON Schema:**
   - Ввести `packages/core/src/provider/tool-schema.ts` с `normalizeToolSchema()` (additionalProperties: false, при необходимости anyOf/oneOf и обрезка format) и применять к сырым схемам перед передачей в провайдер.

3. **При запросе финального ответа по схеме:**
   - Реализовать опцию replyFormat (json_schema) и один из вариантов: тул StructuredOutput в loop или нативный response_format в провайдере, как в Kilocode.

После этих шагов наша модель будет ближе к Cline/Roo по схемам тулов и при необходимости — к Kilocode по structured output ответа.
