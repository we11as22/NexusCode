# CLI: Home-подсказка и элементы Sidebar (session title, MCP в Footer)

## Изменения

### 1. Подсказка при первом запуске (аналог KiloCode Home / Sidebar «Getting started»)
- При **0 сообщений** в чате показывается блок **Getting started** (рамка cyan) с текстом:
  - «NexusCode includes free models from models.dev so you can start immediately.»
  - «Use /model to select a model, /sessions to switch conversations. Type / for all commands.»
  - «Connect from OpenRouter and other providers in /settings → Model; optional API key for higher limits.»
- Аналог KiloCode: экран Home с Tips и блок в Sidebar «Kilo includes free models…». Отдельный маршрут Home не добавлялся — подсказка встроена в чат при первой сессии.

### 2. Элементы Sidebar в Footer (session title, context%, MCP)
- **Session title:** выводится в Footer, если есть (из первого пользовательского сообщения через `deriveSessionTitle(state.messages)`). Формат: `title: <short>` (до 24 символов).
- **MCP:** в Footer добавлено отображение `MCP: N`, где N — число настроенных серверов (`configSnapshot.mcp.servers.length`). Показывается только при N > 0.
- **Context%** и модель/профиль/сессия в Footer уже были; добавлены поля title и MCP для сближения с KiloCode Sidebar (session title, context, cost, MCP). Cost в долларах в CLI не считается.

### 3. Файлы
- `packages/cli/src/tui/App.tsx`:
  - Импорт `deriveSessionTitle` из `@nexuscode/core`.
  - Компонент `GettingStartedTip`: показ при `state.messages.length === 0` в ветке чата.
  - В Footer передаются `sessionTitle` (useMemo от `deriveSessionTitle(state.messages)`) и `mcpServersCount` (из `configSnapshot?.mcp?.servers?.length`).
  - Footer: опциональные пропсы `sessionTitle`, `mcpServersCount`; в первой строке выводятся `title: <short>` и `MCP: N`.
- `docs/validation-cli-kilocode.md`: обновлены строки про Home и Session, вывод по структуре (учтены Getting started и sidebar-like Footer).

## Проверка
- `pnpm run build` — успешно.
