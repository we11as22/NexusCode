# Индексация и поиск по кодовой базе

## Обзор

- **FTS** (SQLite FTS5): символы (классы, функции, методы и т.д.) и чанки по содержимому. Всегда используется при `indexing.enabled`.
- **Векторный индекс** (Qdrant): при `indexing.vector` и `vectorDb.enabled` — семантический поиск по эмбеддингам.
- Результаты поиска содержат `path`, `startLine`, `endLine` (если есть), `content` — по ним можно точечно читать файл через `read_file(path, start_line, end_line)`.

## Что держит индекс актуальным

| Событие | Действие |
|--------|----------|
| **Старт** | `startIndexing()` — полный обход, FTS + вектор. |
| **Запись агента** | После `write_to_file`, `replace_in_file`, batch (replaces) — в loop после успешного вызова вызывается refresh для целевого пути. |
| **Файлы в workspace** | File watcher (onDidChange, onDidCreate, onDidDelete) вызывает `indexer.refreshFile(uri.fsPath)` (с debounce). При удалении файла `refreshFileNow` видит, что файла нет, и удаляет его из FTS и вектора. |
| **Git** | Перед каждым запуском агента `refreshIndexerFromGit` обновляет по `git diff` и `git status` только изменённые/удалённые файлы через `refreshFileNow`. |
| **Ручной reindex** | Кнопка Reindex в UI → `indexer.reindex()` (clear + startIndexing). |

Инструментов удаления файла у агента нет; удаление делается снаружи (IDE, терминал) и подхватывается watcher или следующим git-refresh.

## Поиск и чтение куска файла

- **codebase_search**: возвращает строки вида `path:startLine` или `path:startLine-endLine`, плюс превью контента. В описании тула указано использовать `read_file` с тем же path и диапазоном строк.
- **pathScope** (опция поиска): при указании пути/папки фильтрация по пути выполняется **и в FTS, и в Qdrant** на стороне хранилища (в FTS — условие по path в SQL; в Qdrant — фильтр по pathSegments). Дедупликация по path:startLine и маркер завершения индексации в Qdrant применяются ко всему поиску по кодовой базе в целом.
- **search_files**: вывод в формате `path:line:content`; агент может взять path и line и вызвать `read_file(path, start_line, end_line)` (например, ±10 строк).
- **read_file**: поддерживает `start_line` и `end_line` (1-based, включительно); для больших файлов без диапазона возвращается head+tail с подсказкой использовать диапазон.
