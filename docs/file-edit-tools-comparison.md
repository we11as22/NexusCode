# Тулзы редактирования файлов: NexusCode и сравнение с другими проектами

## 1. Как выглядят и работают тулзы эдита в NexusCode

### 1.1 Две тулзы: `write_to_file` и `replace_in_file`

**Файлы:** `packages/core/src/tools/built-in/write-file.ts`, `packages/core/src/tools/built-in/replace-in-file.ts`.

| Тулза | Назначение | Вход (схема) | Выход | Подтверждение |
|-------|------------|---------------|--------|----------------|
| **write_to_file** | Создать файл или полностью перезаписать существующий | `path` (string), `content` (string — полное содержимое) | `success`, `output` (текст + кол-во строк), `metadata: { addedLines, removedLines }` | Да (`requiresApproval: true`) |
| **replace_in_file** | Точечные правки через search/replace | `path` (string), `diff` (массив `{ search, replace }`) | `success`, `output` (отчёт по блокам + `<updated_content>...</updated_content>`), `metadata: { addedLines, removedLines }` | Да |

**Поведение:**
- Обе тулзы помечены `requiresApproval: true` — перед выполнением показывается диалог подтверждения (если нет правила auto-approve для пути/тула).
- Запись атомарная: пишем во временный файл `*.nexus_tmp_<ts>`, затем `rename`; при ошибке временный файл удаляется.
- После успешной записи вызывается `indexer.refreshFileNow` / `refreshFile` для обновления индекса (символы, вектор).
- В ответе для `replace_in_file` возвращается полное новое содержимое в `<updated_content>`, чтобы модель могла использовать его для следующих правок без повторного `read_file`.

**Правила в промптах:**
- `write_to_file`: для новых файлов, полной перезаписи или когда меняется больше половины файла; для мелких правок предпочтителен `replace_in_file`.
- `replace_in_file`: точное совпадение `search` (включая пробелы и отступы); блоки применяются по порядку; при нескольких вхождениях заменяется только первое.

### 1.2 Подтверждение (approval)

- В `loop.ts` перед выполнением проверяются правила из `config.permissions.rules` (allow/deny/ask по паттернам пути и тула).
- Для `write_to_file` и `replace_in_file` при отсутствии auto-approve вызывается `host.showApprovalDialog(action)`. Действие строится в `buildApprovalAction`: тип `"write"`, описание `Write to <path>`, в `content` передаётся либо полный контент (write), либо не используется в текущей реализации для replace (в action уходит только path/description).
- После отклонения тул возвращает `success: false`, `output: "User denied ..."`.

### 1.3 Интеграция с индексом

- После успешного `write_to_file` / `replace_in_file` в `executeToolCall` вызывается `ctx.indexer.refreshFileNow(absolutePath)` или `refreshFile`, чтобы индекс (символы, chunks) обновился без полной переиндексации.

---

## 2. Cline (`sources/cline`)

### 2.1 Один хендлер на три «тула»

- **WriteToFileToolHandler** обрабатывает три имени: **write_to_file**, **replace_in_file**, **new_rule** (один класс, разная логика по `block.name`).
- Параметры: `path` / `absolutePath`, для write — `content`, для replace — **`diff`** в формате Cline (текстовые блоки SEARCH/REPLACE с разделителями `------- SEARCH`, `=======`, `+++++++ REPLACE`).

### 2.2 UI: Diff View и стриминг

- Используется **diffViewProvider**: открывается редактор (или виртуальный diff view), контент **стримится в реальном времени** по мере прихода дельт от модели (`handlePartialBlock` → `diffViewProvider.update(newContent, false)`).
- После полного ответа: `update(newContent, true)`, скролл к первому изменению, затем **approval**: `ask("tool", ...)` — пользователь видит дифф и кнопки Approve / Reject.
- При approve вызывается **saveChanges()** — запись на диск; возможны пост-обработки (formatting, userEdits). При reject — **revertChanges()**, в ответ модели уходит «The user denied this operation».

### 2.3 Формат replace_in_file в Cline

- **diff.ts**: парсинг текстового формата с блоками SEARCH и REPLACE (разделители `--- SEARCH`, `===`, `+++ REPLACE`), несколько fallback-стратегий поиска (точное совпадение, line-trimmed, block-anchor). Из этого строится **newContent**; затем всё показывается в diff view и сохраняется через тот же путь, что и write_to_file.

**Итого по Cline:** один хендлер, богатый UI (diff view, стриминг контента, approve/reject по диффу), replace задаётся текстовым diff-форматом с разделителями, а не массивом `{ search, replace }`.

---

## 3. Kilocode / OpenCode (`sources/kilocode`)

### 3.1 Документация и контракт

- В **kilo-docs** и **fast-edits.md** упоминаются:
  - **write_to_file** — создание/полная перезапись файла, с интерактивным подтверждением и diff view.
  - **apply_diff** — применение целевых изменений (патчи); при отключённой опции «editing through diffs» все правки идут через полную перезапись через write_to_file.
- В тестах и конфигах встречаются имена `write_file`, `apply_diff`; в opencode-пакете самих определений тулов (Zod/schema) в репозитории не видно — вероятно, тулы приходят с бэкенда/сервера или из отдельного пакета моделей.

### 3.2 Отличия от NexusCode

- Есть **два режима редактирования**: через диффы (apply_diff) и через полную запись (write_to_file); переключается настройкой «Enable editing through diffs».
- Подтверждение и diff view упоминаются в документации по write_to_file (процесс с просмотром изменений перед применением).

**Итого по Kilocode:** концептуально — write_to_file (полный контент) + apply_diff (патчи); детали реализации тулов в рассмотренном коде не видны, опора на документацию и тесты.

---

## 4. Roo-Code (`sources/Roo-Code`)

- Roo-Code использует **Cline-совместимый API**: запросы уходят во внешний сервис (Cline), тулы выполняются на той стороне. Собственных определений write_to_file/replace_in_file в коде Roo нет — поведение такое же, как у того экземпляра Cline/API, к которому идёт запрос.

---

## 5. Сводная таблица

| Аспект | NexusCode | Cline | Kilocode/OpenCode | Roo-Code |
|--------|-----------|--------|-------------------|----------|
| **Тулзы эдита** | write_to_file, replace_in_file (отдельные тулы) | write_to_file, replace_in_file, new_rule (один WriteToFileToolHandler) | write_to_file, apply_diff (по доке) | Как у Cline-API |
| **Формат replace** | Массив `{ search, replace }`, первое вхождение на блок | Текстовый diff с блоками SEARCH/REPLACE и разделителями | apply_diff — патчи (формат в коде не прослеживается) | — |
| **Запись на диск** | Атомарная (temp + rename) | Через diffViewProvider.saveChanges() после approve | По документации — с подтверждением | — |
| **Подтверждение** | Диалог до выполнения (approval action с path/description) | Diff view + Approve/Reject; опционально auto-approve по пути | Diff view и подтверждение для write_to_file | — |
| **Стриминг в UI** | Нет (выполнение после полного ответа модели) | Да (handlePartialBlock → update diff view по мере дельт) | Не указано в рассмотренном коде | — |
| **Индекс после записи** | refreshFileNow / refreshFile после успеха | fileContextTracker, markFileAsEditedByCline | — | — |
| **Возврат контента модели** | replace_in_file возвращает `<updated_content>` в output | Результат тула — текст от formatResponse / saveChanges | — | — |

---

## 6. Выводы

- **NexusCode:** простая и предсказуемая модель: две тулзы с чёткими схемами (Zod), атомарная запись, подтверждение до выполнения, обновление индекса. Replace — явный массив search/replace без парсинга текстового диффа. Нет стриминга контента в редактор — выполнение после полного вызова тула.
- **Cline:** один хендлер на три «тула», сильный акцент на UX: стриминг в diff view, approve по диффу, продвинутый парсинг replace (несколько fallback-стратегий). Формат replace — текстовый (SEARCH/REPLACE блоки), а не структурированный массив.
- **Kilocode:** по документации — разделение на write_to_file (полная перезапись с подтверждением) и apply_diff (целевые изменения); возможность отключить диффы и всё вести через write_to_file.
- **Roo-Code:** делегирует выполнение тулов Cline-совместимому API, своих тулов эдита нет.
