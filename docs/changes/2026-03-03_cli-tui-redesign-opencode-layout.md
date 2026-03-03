# CLI TUI full redesign: OpenCode-style layout, fix merged text

## Summary

NexusCode CLI TUI переделан по образцу opencode: фиксированный header (заголовок + одна строка контекста), область контента с flexGrow/minHeight, фиксированные footer и input. Устранена склейка текста сверху и «уехавший» layout.

## Changes

### 1. Backup
- **packages/cli/src/tui/App.tsx.backup** — полная копия предыдущего App.tsx.

### 2. Header (opencode-style)
- Один блок с `flexShrink={0}`: заголовок «NexusCode CLI · Agent Hub» (Logo) и одна строка контекста (HeaderBar): модель, Vector, Context tokens, путь.
- Раньше: Logo + WelcomeBar с 4 строками в одной колонке — при нехватке места текст слипался.
- Теперь: два ряда в одном header-блоке с явным padding; контекст в одну строку.

### 3. Content area
- Область чата/настроек: `flexGrow={1} minHeight={0} flexShrink={1}`, чтобы занимала только остаток высоты и не «давила» header/footer/input.
- Chat-ветка обёрнута в `<box flexDirection="column" flexGrow={1} minHeight={0}>`.

### 4. Footer и Input
- Footer обёрнут в `<box flexShrink={0}>`, у самого компонента Footer добавлен `flexShrink={0}`.
- Input bar обёрнут в `<box flexShrink={0}>`.
- TodoBar, PlanActionsBar, SlashPopup обёрнуты в `<box flexShrink={0}>`, чтобы не сжимались.

### 5. Удаление дублирования
- Удалён компонент WelcomeBar (заменён на HeaderBar — одна строка контекста).
- В GettingStartedTip убран повтор заголовка «NexusCode CLI · Agent Hub» (остаётся только в header).

## Verification

- `cd packages/cli && pnpm run build` — успешно.
- Lint по `packages/cli/src/tui/App.tsx` без ошибок.

## Ctrl+C (выход) не работал

**Причина:** В `useKeyboard` символ ввода `inputChar` задаётся только когда `!evt.ctrl && !evt.meta` (чтобы не дублировать обычные буквы при Ctrl). При нажатии Ctrl+C приходит `evt.ctrl === true` и `evt.name === "c"`, но `inputChar` остаётся `""`, поэтому условие `key.ctrl && inputChar === "c"` никогда не выполнялось.

**Исправление:** В `handleKey` добавлен третий аргумент `evtName` (нижний регистр имени клавиши). Выход/abort по Ctrl+C проверяется так: `key.ctrl && (inputChar === "c" || evtName === "c")`.
