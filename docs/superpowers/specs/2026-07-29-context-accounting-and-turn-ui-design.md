# Точный контекст и семантический UI хода — дизайн

**Дата:** 2026-07-29

**Статус:** утверждён пользователем

**Выбранный вариант:** гибридный учёт фактического provider usage и локальной оценки ещё не учтённого хвоста

## Цель

NexusCode должен одинаково и правдиво определять размер контекстного окна,
занятое место и момент автоматической компактации в core, CLI, локальном
расширении и server-backed расширении. Интерфейс должен отображать ход агента
семантическими блоками в духе предоставленных скриншотов Cursor: без дублей,
без отдельной карточки на каждое низкоуровневое событие и с единым блоком
принятия или отката изменений.

## Подтверждённые проблемы

1. Kilo gateway `/models` возвращает полную metadata, в том числе
   `context_length`, но Nexus сохраняет только множество идентификаторов.
   Например, `kilo-auto/free` объявляет `context_length: 256000`, а Nexus
   показывает общий fallback `128000`.
2. Provider usage уже доходит до agent loop и сохраняется на сообщении, но
   `computeContextUsageMetrics()` не использует его. Контекст полностью
   пересчитывается эвристикой, включая фиксированные 750 токенов на каждый
   инструмент.
3. Накопительный расход сессии и размер текущего provider-visible контекста
   концептуально не разделены.
4. После компактации usage сохранённых сообщений может описывать старый,
   докомпактационный запрос и не должен становиться новой точной опорой.
5. До инициализации VS Code controller и webview публикуют `128000`, даже
   когда окно неизвестно.
6. VS Code уже умеет группировать exploration, показывать Bash и inline diff,
   но завершённый ход не имеет единой семантической оболочки, а панель
   изменений по умолчанию визуально тяжелее референса.

## Эталонные решения

- **Codex:** хранит `last_token_usage` отдельно от накопительного
  `total_token_usage`; текущую занятость берёт из последнего provider usage,
  локально оценивает только элементы после последнего model-generated item и
  отделяет полное окно от эффективного порога компактации.
- **OpenClaude:** `tokenCountWithEstimation()` начинает с usage последнего API
  ответа и добавляет только сообщения после него; cache read/write и output
  входят в текущий контекст; после compaction не доверяет старому usage.
- **Kilo:** provider catalog является источником `model.limit.context`;
  provider-reported usage и request-scoped estimate используются совместно,
  а JSON сообщений и реальных tool schemas оценивается целиком с safety factor.
- **Kimi:** персистит последнюю точную `_usage`, отдельно хранит pending
  estimate и заменяет оценку фактическим usage после следующего ответа.
- **Qwen:** UI выбирает последнее положительное `inputTokens`, не суммирует
  usage разных запросов и не смешивает usage субагентов с главным контекстом.
- **MiMo:** нормализует non-cached input, cache read/write, output и reasoning;
  UI берёт последнее assistant-сообщение с usage, а compaction использует
  отдельные hard/effective/usable границы.

## Архитектура

### 1. Model capability pipeline

`packages/core/src/models/catalog.ts` должен разбирать Kilo `/models` как
полноценный источник `CatalogModel`, а не как фильтрующий `Set<string>`.

Для gateway-модели сохраняются:

- `id`;
- `name`;
- `contextWindow` из `context_length` или
  `top_provider.context_length`;
- `maxOutputTokens` из `top_provider.max_completion_tokens`, если поле есть;
- `free`;
- `recommendedIndex`.

Gateway metadata имеет приоритет для provider `nexus`, потому что описывает
фактический endpoint. `models.dev` остаётся независимым каталогом и fallback
для остальных поддерживаемых OpenAI-compatible источников. Модели, которые
есть только в gateway, не должны исчезать.

Выбор модели продолжает записывать `contextWindow` в runtime config. Для
существующих конфигураций `kilo-auto/free` поддерживается точный безопасный
fallback `256000`, но произвольной неизвестной модели больше не присваивается
ложное окно `128000`.

Неизвестный limit представляется как `0` внутри runtime-контракта:

- UI показывает `ctx —`, а не выдуманную цифру;
- proactive compaction по проценту отключена;
- provider overflow recovery остаётся активным;
- после получения достоверной capability следующий state/event обновляет UI.

### 2. Нормализованный provider usage

`LLMStreamEvent.finish.usage` получает единый смысл:

```ts
type NormalizedLLMUsage = {
  inputTokens: number        // только non-cached input
  outputTokens: number       // видимый output без reasoning, если provider делит его
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens: number        // полный текущий контекст после ответа
  modelId?: string           // фактически ответившая модель, если provider сообщает
}
```

Нормализация выполняется на provider boundary:

- OpenAI-compatible `promptTokens` уже включает cached prompt tokens, поэтому
  cached часть вычитается из `inputTokens` и сохраняется отдельно.
- Anthropic `promptTokens` не включает cache creation/read, поэтому эти поля
  добавляются к `totalTokens`.
- reasoning вычитается из обычного output только если provider явно сообщает
  отдельное значение.
- отрицательные, `NaN` и отсутствующие значения нормализуются в ноль.
- если provider сообщает корректный `totalTokens`, он используется; иначе
  total вычисляется как сумма нормализованных bucket-ов.

Это соответствует Kilo/MiMo и не допускает двойного учёта cache.

### 3. Provider context anchor

У `Session` появляется отдельная персистируемая опорная точка:

```ts
type ProviderContextAnchor = {
  messageId: string
  usedTokens: number
  modelId?: string
  recordedAt: number
}
```

Anchor обновляется только после успешного provider finish. Он не является
накопительным расходом и не очищается при добавлении следующего user message:
новый user message — это pending-хвост поверх последнего точного контекста.

Anchor очищается:

- при полной/ручной компактации до публикации нового context snapshot;
- при rewind/fork, если anchor message больше не входит в активную историю;
- при смене модели или контекстного поколения, когда usage старой модели
  больше нельзя считать точной базой;
- при восстановлении старой сессии без валидного anchor.

Старые JSONL-сессии остаются совместимыми и используют estimate до первого
нового provider finish.

### 4. Гибридный расчёт занятого контекста

Новый расчёт возвращает:

```ts
type ContextUsageSnapshot = {
  usedTokens: number
  limitTokens: number
  percent: number
  source: "provider" | "hybrid" | "estimated"
  providerTokens: number
  pendingTokens: number
}
```

Алгоритм:

1. Построить exact provider-visible manifest: активные messages, system prompt
   и реально активированные tool definitions.
2. Если валидного anchor нет, оценить весь manifest и вернуть `estimated`.
3. Если anchor есть, начать с `anchor.usedTokens`.
4. Добавить только контент после anchor:
   - последующие user/assistant/tool сообщения;
   - tool result output в anchor assistant message, поскольку он появился
     локально после model output и не входил в provider usage;
   - новый system/tool-schema delta, если manifest изменился относительно
     сохранённого anchor.
5. При наличии pending-хвоста вернуть `hybrid`, иначе `provider`.
6. Процент — занятая доля raw context window. Порог компактации вычисляется
   отдельно с output/safety reserve, но использует тот же `usedTokens`.

Чтобы корректно учитывать изменение system prompt и набора инструментов,
anchor также хранит оценённый размер provider-visible system/tools manifest.
При следующем расчёте добавляется только положительная разница. Уменьшение
manifest не уменьшает provider-reported anchor задним числом; следующая
модельная итерация заменяет anchor точным usage.

Tool schemas оцениваются из сериализованного JSON Schema, имени и description.
Фиксированный overhead на каждый инструмент удаляется. Для preflight оценки
применяется консервативный safety factor, а точный provider usage всегда имеет
приоритет после ответа.

### 5. Compaction

UI, preflight и end-of-turn compaction используют один
`computeContextUsageMetrics()` и один model limit.

Разделяются:

- `hard`: provider context/input limit;
- `usable`: hard limit минус зарезервированный output/safety budget;
- `threshold`: настраиваемая доля usable.

Compaction:

- не запускается по неизвестному окну;
- перед retry очищает старый anchor;
- публикует estimated snapshot нового compacted manifest;
- после первого post-compaction provider ответа получает новый точный anchor;
- не может повторно суммировать старый usage с summary.

### 6. Транспорт и хранение

`context_usage` расширяется опциональными полями, чтобы старый remote client
не ломался:

```ts
{
  type: "context_usage"
  usedTokens: number
  limitTokens: number
  percent: number
  source?: "provider" | "hybrid" | "estimated"
  providerTokens?: number
  pendingTokens?: number
}
```

Core, server event stream, CLI projection, VS Code controller, webview store и
replay переносят значения без самостоятельного пересчёта. Core остаётся
единственным владельцем семантики.

Persisted `contextUsage` получает те же поля и валидируется обратно
совместимо. Приватная provider metadata в UI не отправляется.

### 7. CLI и VS Code UI

Основная строка показывает именно занятый контекст:

```text
ctx 29.3k/256k (11%)
```

Если limit неизвестен:

```text
ctx 29.3k/—
```

Tooltip/детали VS Code показывают:

```text
29.3k used of 256k
27.8k provider-reported + 1.5k estimated pending
```

UI не маркирует hybrid как «точный», но и не добавляет шум в основную строку.

### 8. Семантическая проекция хода

Raw `AgentEvent` остаётся append-only transport contract. Группировка —
чистая UI-проекция:

- contiguous read/list/search и glue-события образуют один
  `Exploring/Explored` блок с независимыми счётчиками файлов, списков и
  поисков, например `Explored 3 files, 2 searches`;
- повторные `Read terminal`, wait/poll и короткие thought-события внутри
  exploration не создают внешние дубли;
- Bash, approval, question, error, compaction и существенные write/diff
  операции остаются отдельными хронологическими карточками;
- после `done` завершённая техническая активность сворачивается под
  `Worked for Ns`, а финальный ответ остаётся снаружи;
- раскрытие всегда восстанавливает полную хронологию;
- live run не скрывает текущую операцию;
- стабильные keys не меняются при переходе `Exploring` → `Explored`.

Для длительности `done` получает опциональный `durationMs`, а финальное
assistant message сохраняет её для replay. Старые сессии просто не показывают
`Worked for Ns`, если длительность неизвестна.

### 9. Изменения кода

Один sticky-блок отображает все Nexus-owned unresolved change sets:

```text
› 1 File                         Undo   Keep   Review
```

- по умолчанию он свёрнут;
- `Undo` откатывает только Nexus-owned unresolved changes;
- `Keep` принимает их;
- `Review` при одном файле сразу открывает diff, при нескольких раскрывает
  список и позволяет открыть каждый diff;
- атомарный multi-file patch принимается или откатывается целиком;
- inline diff остаётся в хронологии хода;
- accepted/reverted/manual/git-unrelated изменения не попадают в блок.

### 10. Безопасность и производительность

- Никаких дополнительных provider token-count запросов в основном пути.
- Kilo catalog fetch сохраняет существующий timeout и cache.
- В webview не отправляются абсолютные spill paths или закрытая provider
  metadata.
- Context calculation линейный по активному окну; anchor не требует
  накопительного пересчёта всей сессии после каждого delta.
- State sync не выполняется на каждом text/reasoning delta.
- Реальные LLM/терминальные проверки ограничиваются маленьким workspace
  `/Users/mac/Projects/nexus/test`.

## Проверка

### Автоматические контракты

1. Gateway parser сохраняет `kilo-auto/free = 256000` и gateway-only модели.
2. Неизвестная модель не получает `128000`.
3. Нормализация OpenAI/Anthropic cache не даёт двойного учёта.
4. Anchor + pending возвращает правильные provider/hybrid/estimated значения.
5. Compaction инвалидирует старый anchor.
6. Persist/reload сохраняет anchor и расширенный snapshot.
7. Server/CLI/VS Code transport переносит новые поля.
8. Проекция не дублирует Thought/Explored, отдельно считает files/lists/searches
   и сохраняет существенные tool cards.
9. Sticky change bar имеет безопасную семантику Undo/Keep/Review.
10. Старые сессии и старые remote events остаются читаемыми.

### Финальные команды

- узкие RED/GREEN тесты каждого слоя;
- полный `pnpm test`;
- typecheck/lint, предусмотренные workspace scripts;
- сборка core, CLI, server и webview/extension;
- упаковка VSIX;
- `nexus doctor` на `/Users/mac/Projects/nexus/test`;
- короткий CLI smoke без разрушительных команд;
- установка VSIX и проверка загрузки extension host;
- визуальная проверка webview на синтетическом/безопасном ходе;
- `git diff --check` и проверка чистого worktree после commit/push.

## Критерии готовности

Работа завершена только если:

- нигде не отображается ложное `128k` для `kilo-auto/free`;
- занятый контекст после provider ответа основан на provider usage;
- pending tool/user хвост не теряется и не удваивается;
- compaction использует ту же величину и не доверяет stale usage;
- CLI, local VS Code и remote VS Code согласованы;
- предоставленные Cursor-сценарии имеют компактную, хронологичную и
  недублирующую проекцию;
- изменения кода можно безопасно review/keep/undo;
- полный набор проверок проходит на текущем commit;
- результат закоммичен и запушен в `main`.
