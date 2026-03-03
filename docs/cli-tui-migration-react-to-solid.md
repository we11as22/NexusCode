# Миграция CLI TUI: React → Solid (стек opencode/kilocode)

## Текущее состояние

- **Стек:** React 19 + `@opentui/react` + `createRoot(renderer)` в `packages/cli/src/index.ts`.
- **UI:** Один большой `App.tsx` (~2800 строк) с `useState`, `useEffect`, `useKeyboard`, рендер через `root.render(React.createElement(App, appProps))`.

## Целевой стек (opencode/kilocode)

- **Стек:** Solid.js + `@opentui/solid` + `render(() => <App />, options)`.
- **API:** `useKeyboard`, `useTerminalDimensions`, `useRenderer` из `@opentui/solid`; состояние через `createSignal`, `createEffect`, `createMemo`; разметка — Solid JSX (похож на React, но без виртуального DOM и с реактивностью по сигналам).

## Зачем переходить

1. **Один стек с opencode/kilocode** — проще переносить правки из upstream (layout, диалоги, темы, keybinds).
2. **Надёжный Ctrl+C и выход** — в opencode выход и keybinds завязаны на контексты (ExitProvider, KeybindProvider) и команды (`/exit`, ctrl+c).
3. **Меньше багов layout** — в opencode TUI изначально спроектирован под `render()` и flex-модель opentui/solid.

## План миграции

### 1. Зависимости

- В `packages/cli/package.json`:
  - Удалить: `react`, `@opentui/react`, `@types/react`.
  - Добавить: `solid-js`, `@opentui/solid` (версии как в opencode/kilocode).

### 2. Точка входа (`packages/cli/src/index.ts`)

- Убрать динамический импорт React и `createRoot`.
- Импортировать `render` из `@opentui/solid` и корневой компонент приложения (Solid).
- Вызов вида:
  ```ts
  const { render } = await import("@opentui/solid")
  const { App } = await import("./tui/App.js")
  render(() => <App {...appProps} />, {
    targetFps: 60,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    // ... остальное по образцу opencode app.tsx
  })
  ```
- `appProps` передавать в App через контекст (например ArgsProvider/ExitProvider) или пропсы, как в opencode.

### 3. App и компоненты (React → Solid)

- **App.tsx** переписать на Solid:
  - `useState` → `createSignal` (или несколько сигналов).
  - `useEffect` → `createEffect` / `onMount` / `onCleanup`.
  - `useMemo` → `createMemo`.
  - `useRef` → либо сигнал, либо `createStore` для сложного состояния.
  - Обработчик `useKeyboard` оставить, но подписываться через API Solid (в opencode это один общий `useKeyboard` в App и вызов `exit()` из контекста).
- **Дочерние компоненты** (Logo, HeaderBar, Footer, InputBar, ChatViewport, GettingStartedTip, все конфиг-экраны и т.д.) переписать на Solid-компоненты (функции, возвращающие JSX, с сигналами/эффектами где нужно).
- События и данные от хоста (events, onMessage, onExit, configSnapshot, sessionId, getSessionList, onSwitchSession и т.д.) передавать через пропсы или контексты (по аналогии с opencode: ArgsProvider, ExitProvider, SDKProvider и т.д.).

### 4. Контексты (по образцу opencode)

- Ввести минимально необходимые провайдеры, например:
  - **ExitProvider** — `onExit` (вызов `renderer.destroy(); process.exit(0)`).
  - **ArgsProvider** — аргументы CLI и appProps (projectDir, sessionId, configSnapshot, onMessage, onAbort, getSessionList, onSwitchSession и т.д.).
- При желании позже добавить аналог KeybindProvider, DialogProvider, ToastProvider из opencode.

### 5. Рендер и жизненный цикл

- В Solid нет `root.render()` при обновлении пропсов: реактивность идёт через сигналы. Все данные, приходящие «снаружи» (events, session list, config), нужно держать в сигналах/сторах и обновлять из эффектов или колбеков (например, при получении нового event из `events` обновлять сигнал сообщений).

### 6. Тесты и сборка

- Заменить/удалить тесты, завязанные на React (если есть).
- Убедиться, что `tsup` (или текущий бандлер) корректно собирает Solid и JSX для Solid (обычно `"jsx": "preserve"` и плагин для Solid).
- В opencode используется Bun; у NexusCode — Node + tsup: проверить, что импорт `@opentui/solid` и `solid-js` в сборе работают.

### 7. Поэтапность

- **Вариант A:** Полная замена: новый `App.solid.tsx` (или `App.tsx` с Solid), все компоненты переписать, index.ts переключить на `render()` и новый App. Старый React-App удалить после проверки.
- **Вариант B:** Сначала вынести только layout и оболочку в Solid (один экран-заглушка с header/footer/input и выход по Ctrl+C), подключить в index через `render()`; затем по частям переносить экраны (chat, settings, model, sessions и т.д.) из React-компонентов в Solid.

Рекомендуется **вариант B** для понижения риска и возможности проверять выход и базовый UI после первого же шага.

## Ссылки

- opencode TUI: `sources/opencode/packages/opencode/src/cli/cmd/tui/app.tsx`, `routes/home.tsx`, `routes/session/index.tsx`.
- kilocode TUI: `sources/kilocode/packages/opencode/src/cli/cmd/tui/app.tsx` (тот же подход, плюс kilo-команды и контекст).
