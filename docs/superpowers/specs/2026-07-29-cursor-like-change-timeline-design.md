# Cursor-подобная лента изменений: дизайн

**Статус:** утверждено исходным карт-бланшем пользователя и активной целью

**Дата:** 2026-07-29
**Область:** расширение VS Code, CLI, durable session transcript, streaming/reload

## Проблема

В текущем UI один и тот же успешный вызов `Write` или `Edit` выглядит по-разному
до и после восстановления сессии:

- live-событие `tool_end` содержит точные `diffHunks` и
  `appliedReplacements`;
- durable `ToolPart` сохраняет только `path` и `diffStats`;
- после reload webview пытается восстановить смысл из текстового `output`;
- `Write` показывает строку `Successfully wrote ...`, хотя известен точный diff;
- `Edit` разбирает `<updated_content>` и ошибочно красит весь итоговый файл как
  добавление.

На приложенном скриншоте это приводит к семантически ложному результату:
заголовок сообщает `+1 −1`, а тело показывает две зелёные строки и ни одной
красной.

Вторая независимая проблема — нарушенный вертикальный ритм. Верхнеуровневый
`message-list-item` имеет `padding-bottom: 16px`, а раскрытый `Worked` повторно
оборачивает каждый дочерний элемент тем же классом. В результате техническая
лента получает вложенные глобальные отступы.

## Проверенные образцы

### Kilo Code

Kilo вычисляет unified patch в инструменте и сохраняет ограниченный patch,
additions и deletions в durable metadata. При сериализации удаляются полные
`before`/`after`, но небольшой patch сохраняется специально для inline diff:

- `source_projects/kilocode/packages/opencode/src/tool/edit.ts`
- `source_projects/kilocode/packages/opencode/src/tool/write.ts`
- `source_projects/kilocode/packages/opencode/src/session/message-v2.ts`
- `source_projects/kilocode/packages/kilo-vscode/src/kilo-provider/slim-metadata.ts`

Это лучший прототип durable UI-проекции: точность сохраняется без хранения
полных файлов в истории.

### OpenClaude

OpenClaude строит структурированный diff из фактического файла и
`old_string`/`new_string`. Если файл нельзя прочитать безопасно, fallback
строится из самих входных замен, а не из полного итогового содержимого:

- `source_projects/openclaude/src/components/FileEditToolDiff.tsx`
- `source_projects/openclaude/src/hooks/useTurnDiffs.ts`

Это лучший прототип честного fallback: UI не выдумывает удалённые или
добавленные строки.

### Codex

Codex отделяет событие изменения файлов (`file_change`) от произвольного
текстового результата инструмента:

- `source_projects/codex/sdk/typescript/src/items.ts`

Это правильная граница протокола: статус операции и структурированное изменение
не должны извлекаться из человекочитаемой строки.

### Kimi Code

Kimi держит отдельную панель изменений, baseline и явные действия
View/Undo/Keep:

- `source_projects/kimi-code/apps/vscode/src/managers/file.manager.ts`
- `source_projects/kimi-code/apps/vscode/webview-ui/src/components/FileChangesPanel.tsx`

Это полезный образец для согласования inline diff с нижней панелью
Review/Undo/Keep.

### Roo Code

Roo передаёт unified diff и точные `diffStats` от инструмента к CLI:

- `source_projects/Roo-Code/src/core/tools/WriteToFileTool.ts`
- `source_projects/Roo-Code/apps/cli/src/ui/components/tools/FileWriteTool.tsx`

Это образец паритета CLI и расширения.

## Выбранная архитектура

### 1. Каноническая bounded-проекция

`ToolPart` получает устойчивые поля:

```ts
type ToolDiffLine = {
  type: "add" | "remove"
  lineNum: number
  line: string
}

type AppliedReplacement = {
  oldSnippet: string
  newSnippet: string
}
```

`diffHunks` и `appliedReplacements` вычисляются инструментом один раз и
сохраняются в том же `ToolPart`, который отправляется live и загружается после
reload. Полное `writtenContent` не сохраняется в transcript.

Ограничение уже реализовано в core: не более 200 изменённых строк для
`diffHunks`; snippets дополнительно ограничиваются инструментом. Счётчики
`diffStats` остаются полными и поэтому могут быть больше видимого preview.

### 2. Один проектор для native и textual tool calls

Native и textual ветки agent loop сейчас дублируют сбор полей. Выделяется
чистый helper, который:

- принимает имя инструмента, input и metadata;
- валидирует и нормализует строки diff;
- возвращает `Partial<ToolPart>`;
- используется и для `session.updateToolPart`, и для `tool_end`.

Это исключает повторение текущего бага, когда live event и durable session
получают разные данные.

### 3. Никакого ложного diff

UI использует источники в следующем порядке:

1. `appliedReplacements` для точного компактного preview `Edit`;
2. `diffHunks` для `Write`, полного `Edit` и других мутаций;
3. старый unified diff, если он действительно присутствует;
4. честный status-only fallback с путём и `+N −M`.

Запрещено:

- считать весь `<updated_content>` добавлением;
- извлекать смысл изменения из `Successfully wrote ...`;
- показывать зелёные строки без доказанного add-hunk;
- отображать счётчики, не совпадающие с durable metadata.

### 4. Визуальный контракт

Карточка изменения следует референсу Cursor:

- компактная строка заголовка высотой около 32 px;
- маленькая монохромная file-иконка вместо крупного цветного `TXT` badge;
- имя файла и `+N −M` находятся в одном кластере;
- preview начинается сразу под заголовком;
- добавления зелёные, удаления красные, line number приглушён;
- до 6 изменённых строк в компактном виде;
- при большем diff показывается `N more changed lines`;
- клик по имени открывает diff/review;
- незавершённое или потерянное legacy-содержимое не маскируется под diff.

### 5. Thought, Explored и Worked

- Во время работы reasoning и tool calls идут хронологически.
- Read/List/Glob/Grep/Search и связанные reasoning-сегменты собираются в
  `Exploring…`/`Explored N files`, при этом search считается exploration.
- После завершения техническая работа одного пользовательского turn находится
  под одним `Worked for …`.
- `Worked` свёрнут по умолчанию и скрывает всё от пользовательского сообщения
  до канонического финального ответа.
- В раскрытом `Worked` используется локальный gap 8 px; глобальный
  `message-list-item` внутри него не применяется.
- Отдельные `Thought for Ns` допустимы между мутациями, но не создают пустые
  блоки и не получают двойные вертикальные отступы.

### 6. Паритет поверхностей

Расширение и CLI используют одинаковые durable поля:

- live-stream показывает точный diff;
- восстановленная сессия показывает тот же diff;
- compaction может удалить большой `output`, но не bounded diff projection;
- Review/Undo/Keep опираются на `changeSetId`, а карточка — на сохранённый
  preview;
- subagent-изменения сохраняют происхождение, но используют тот же формат.

## Совместимость

Старые transcripts могут не иметь `diffHunks`. Они остаются читаемыми.
Для них UI показывает путь, счётчики и кнопку Review/Open Diff, но не рисует
синтетические строки.

Новые поля additive и не требуют миграции JSONL. Protocol v2 уже принимает
`diffHunks` и `appliedReplacements` в live `tool_end`.

## Безопасность и производительность

- Не сохранять полные файлы или `writtenContent` в transcript.
- Не читать изменённый файл из UI для реконструкции прошлого diff: файл мог
  измениться после turn.
- Ограничить preview и persisted hunks существующими лимитами.
- В UI не строить diff на каждом render.
- Для manual smoke использовать только `/Users/mac/Projects/nexus/test`.
- Не запускать индексацию, массовые filesystem scans или нагрузочные тесты.

## Критерии приёмки

1. Новый файл `ALPHA\nBETA\n` показывает `+2` и две зелёные строки live и
   после reload.
2. Замена `BETA` на `GAMMA` показывает `+1 −1`, красный `BETA`, зелёный
   `GAMMA` live и после reload.
3. Legacy tool part без hunks не показывает итоговый файл как additions.
4. Раскрытый `Worked` не содержит вложенных 16px-отступов.
5. Write/Edit/ApplyPatch, Review/Undo/Keep и session reload сохраняют
   одинаковую семантику.
6. CLI и расширение используют одинаковые счётчики и hunks.
7. Read/Search/Bash/subagents/approvals/queue/streaming/compaction не получают
   дублированных или пустых строк.
8. Все автоматические проверки и безопасные smoke-сценарии проходят до push.
