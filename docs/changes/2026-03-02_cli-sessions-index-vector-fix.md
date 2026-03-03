# CLI: список сессий (KiloCode-style), вкладка Index с прогресс-баром, фикс спама векторной индексации

## Изменения

### 1. Список сессий (KiloCode-style)
- В CLI добавлена команда **/sessions** и вкладка **Sessions**.
- При открытии загружается список сессий: через `getSessionList()` (server: `NexusServerClient.listSessions()`, локально: `listSessions(cwd)`).
- ↑↓ — выбор сессии, Enter — переключение (`onSwitchSession(id)`), Esc — назад.
- При переключении: для server обновляются refs и перерисовывается App с новыми `initialMessages`/`sessionId`; для локального режима подгружается `Session.resume(id, cwd)` и также перерисовка.
- Сессия в CLI хранится в `sessionRef.current`; при server используется прокси с `currentSessionIdRef`/`currentMessagesRef` для смены без перезапуска.

### 2. Вкладка Index (Sync, Delete, прогресс-бар)
- Вкладка **Index & embeddings** (открывается по `/index` или из Settings → 3):
  - **Прогресс индексации:** зелёная полоска (█/░) и процент по чанкам (`chunksProcessed/chunksTotal`).
  - **Sync** — Enter: полная переиндексация (`onReindex`).
  - **Delete** — D: очистка индекса без переиндексации (`onIndexDelete` → `indexer.deleteIndex()`).
  - **Stop** — S: остановка текущей индексации (`onIndexStop`).
- В core добавлен метод `CodebaseIndexer.deleteIndex()`: stop, fileTracker.clear, vector?.clearCollection, notifyStatus(idle).

### 3. Векторная индексация без спама при отсутствии API key
- При ошибке аутентификации эмбеддингов (Missing Authentication header и т.п.):
  - В **vector.ts**: сообщение выводится **один раз** (`authErrorLogged`), затем выбрасывается `VectorAuthError`.
  - В **indexer** при поимке `VectorAuthError` в `processBatch` вектор отключается на этот запуск (`this.vector = undefined`), индексация продолжается без векторного апсерта.
- Итог: при отсутствии/неверном embeddings API key не будет десятков одинаковых логов; приложение работает без векторного поиска, тулза `codebase_search` просто недоступна до настройки ключа.

### 4. Работа без векторной индексации
- Если `indexing.vector: false` или не настроены embeddings / vectorDb / API key, индексер создаётся без вектора (factory уже возвращал `CodebaseIndexer` без vector).
- CLI и агент работают как раньше; тулза семантического поиска по коду недоступна, пока вектор не включён и индекс не построен.

## Файлы

- `packages/core/src/indexer/vector.ts`: флаг `authErrorLogged`, `VectorAuthError`, один лог при auth error и throw.
- `packages/core/src/indexer/index.ts`: импорт `VectorAuthError`, в `processBatch` try/catch вокруг `upsertSymbols` и сброс `this.vector` при auth error; метод `deleteIndex()`.
- `packages/cli/src/index.ts`: refs для сессии (server), `sessionRef`, `getSessionList`, `onSwitchSession`, перерисовка App при смене сессии, `onIndexDelete` в appProps.
- `packages/cli/src/tui/App.tsx`: view `sessions`, `/sessions`, `SessionsListView`, `IndexManageView` с прогресс-баром (█/░ + %), кнопки Sync/Delete, `onIndexDelete`, `getSessionList`, `onSwitchSession`.
- `docs/validation-cli-kilocode.md`: отмечено наличие эквивалента DialogSessionList (вкладка Sessions).
