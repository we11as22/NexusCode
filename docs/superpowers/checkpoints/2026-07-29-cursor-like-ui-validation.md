# Чекпоинт проверки Cursor-подобной ленты и CLI

**Дата:** 2026-07-29
**Среда:** macOS, Node `24.18.0`, VS Code Extension Host, модель
`openai-compatible/kilo-auto/free`
**Безопасная тестовая область:** `/Users/mac/Projects/nexus/test`

## Что проверено в настоящем VS Code

1. Полный инструментальный ход: Glob, Grep, Read, Bash `pwd`, атомарный
   ApplyPatch для двух файлов, Edit и один read-only субагент.
2. `Explored` считает отдельно файлы и поиски; состояние `Exploring` сохраняет
   стабильную идентичность и после завершения становится `Explored`.
3. Write/Edit/ApplyPatch показывают фактический красно-зелёный diff, а не
   синтетические строки из human-readable output.
4. Предварительный Edit до Allow показал точные пары `GAMMA → DELTA` и
   `DELTA → OMEGA`.
5. Два Edit одного пути дали две хронологические карточки, но review-панель
   корректно показала один уникальный `1 File`.
6. Следующая реплика, отправленная во время активного хода, появилась в очереди,
   автоматически запустилась после `done` и завершилась `QUEUE_AUTO_OK`.
7. Live-события и authoritative snapshot больше не копируют завершённый tool
   part в новый provider round: покадровая проверка сразу после Allow показала
   одну карточку, затем отдельную карточку следующего Edit.
8. Финальный ответ остаётся прикреплённым над composer, техническая работа
   сворачивается в один `Worked for …`, а native scroll не создаёт переходных
   дублей.
9. Review/Keep и Review/Undo проверены отдельно; итоговый тестовый файл
   возвращён к `ALPHA / GAMMA`.
10. UI получил реальное окно модели `256.0k`; занятый контекст показан как
    provider-reported usage плюс ограниченная оценка pending, без накопительного
    двойного счёта.

## Что проверено в CLI

- `nexus doctor --cwd /Users/mac/Projects/nexus/test`: Node, workspace, модель,
  Git и ripgrep исправны.
- Headless API: `nexus --no-index --print --mode ask ...` вернул
  `CLI_API_OK`.
- Настоящий Ink UI показал welcome, cwd, mode, модель, `index=off`, динамический
  контекст, spinner и финальный `CLI_INTERACTIVE_OK`.
- Индексация во всех ручных CLI smoke-тестах была отключена.

## Автоматические доказательства

- `pnpm typecheck`: 6/6 исполняемых workspace-пакетов.
- `pnpm test`: 1722/1722 теста.
- `pnpm test:runtime`: 13/13.
- `pnpm census:features:check`: актуальный детерминированный список из 243
  возможностей.
- `pnpm validate:mcp-skills`: `OK`.
- Production build и VSIX: 168 файлов, 12.48 MB.

## Исправленные причины, а не визуальные маски

- Удалена неподходящая для ограниченного окна истории виртуализация: она
  создавала переходные измерительные состояния. Использован прямой bounded
  render с Kilo-подобной политикой follow/unpin и `ResizeObserver`.
- Новый provider round больше не переименовывает заполненное предыдущее
  assistant-сообщение.
- Reconciliation не переносит content между разными message id.
- Очередь хранит provenance полного следующего хода и при admission race
  возвращается в очередь, а не в composer.
- Предварительный diff Edit строится только из точных `old_string/new_string`,
  а завершённый — из долговечной canonical diff projection.

## Сознательные ограничения проверки

- Не запускались тяжёлая индексация, нагрузочные сценарии, платные модели,
  произвольные shell-команды агента или разрушительное восстановление Git.
- Полностью автоматизированный Extension Host E2E в CI остаётся отдельной
  задачей; перечисленные UI-сценарии проверены в настоящем VS Code под
  наблюдением.
