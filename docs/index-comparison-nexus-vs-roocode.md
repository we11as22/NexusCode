# Сравнение индекса кода: NexusCode vs Roo-Code

Полное сравнение реализаций индексации кода (scan → chunks → vector store) в NexusCode и Roo-Code. Цель: выявить отличия и возможные проблемы у нас.

---

## 1. Архитектура

| Аспект | NexusCode | Roo-Code |
|--------|------------|----------|
| **Слой** | Один класс `CodebaseIndexer` (core), фабрика `createCodebaseIndexer` | Отдельный сервис: `CodeIndexManager` → `CodeIndexOrchestrator` → `DirectoryScanner` + `FileWatcher` + `QdrantVectorStore` + `CacheManager` |
| **Запуск** | `startIndexing()` — один сценарий (всегда полный скан + фильтр toIndex) | `startIndexing()`: если `hasIndexedData()` и коллекция не только что создана → **инкрементальный** скан; иначе — полный скан. После скана запускается **File Watcher**. |
| **Кэш** | `FileTracker` (path → mtime, hash, chunks) в `.nexus/<project>/file-tracker.json` | `CacheManager` (path → hash) в `globalStorageUri/roo-index-cache-<workspaceHash>.json`, debounced save |
| **Векторный store** | `VectorIndex` (Qdrant), один класс в core | `QdrantVectorStore`, интерфейс `IVectorStore` |

**Потенциальные проблемы у нас:**
- Нет разделения full vs incremental run: при каждом старте мы делаем полный обход всех файлов и читаем контент для Phase 1. У Roo-Code при уже заполненной коллекции делается только инкрементальный скан (файлы проверяются по кэшу, неизменённые пропускаются до парсинга).
- Нет постоянного file watcher’а: у нас только `refreshFile`/`refreshFileNow` по запросу (например после git-событий). Roo-Code после скана поднимает `vscode.workspace.createFileSystemWatcher` и обрабатывает create/change/delete батчами с debounce 500 ms.

---

## 2. Две фазы: «найденные чанки» vs «проиндексированные»

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **chunksTotal** | После Phase 1: сумма чанков по **всем** файлам репозитория (полный скан, все файлы читаются и парсятся). | **totalItems** = «blocks found» — накапливается по мере парсинга **только новых/изменённых** файлов (`onFileParsed(fileBlockCount)` → `cumulativeBlocksFoundSoFar`). |
| **chunksProcessed** | Только чанки, по которым реально вызван embed + upsert (Phase 2, только toIndex). Обновляется через `onProgress` из `VectorIndex.upsertSymbols`. | **processedItems** = «blocks indexed» — накапливается при завершении каждого батча эмбеддингов (`onBlocksIndexed(indexedCount)`). |
| **Семантика** | chunksTotal = размер всего репо в чанках; chunksProcessed ≤ chunksTotal, растёт только за счёт индексации нового/изменённого. | total = сколько блоков «найдено» в новых/изменённых файлах; processed = сколько уже отправлено в Qdrant. total может расти по мере парсинга, processed — по мере завершения батчей. |

**Потенциальные проблемы у нас:**
- Phase 1 всегда читает и парсит **все** файлы. На больших репо это долго и даёт большую память (preparedAll). У Roo-Code при инкрементальном запуске парсятся только файлы с изменённым хэшем.
- У нас нет отдельного «инкрементального» режима при уже существующем индексе — мы всё равно сначала строим полный список и полный chunksTotal.

---

## 3. Парсинг и чанки

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **Парсер** | Regex-based в `ast-extractor.ts`: символы по языкам (TS/JS, Python, Rust, Go, Java), markdown по заголовкам, fallback `extractChunks` (50 строк, overlap 15). | **Tree-sitter** в `parser.ts`: загрузка грамматик по расширению, запросы по узлам, разбиение больших узлов по строкам (`_chunkTextByLines`), markdown через отдельный парсер. Fallback chunking при пустых captures или неподдерживаемом языке. |
| **ID чанка** | `file.hash + "_" + startLine + "_" + kind + "_" + name + "_" + parent` → md5 в Qdrant point id. | `uuidv5(block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)`. segmentHash = sha256(filePath, start_line, end_line, length, contentPreview). |
| **Размер блока** | Чанки до 50 строк с overlap 15; символы — до 5–15 строк контента в поле content. | MIN_BLOCK_CHARS=50, MAX_BLOCK_CHARS=1000, допуск 1.15x; длинные строки режутся на сегменты. |

**Потенциальные проблемы у нас:**
- Нет tree-sitter: меньше точности границ символов и типов узлов, возможны пропуски или лишние куски на сложном коде.
- Один и тот же id (hash+line+kind+name) при изменении файла даёт новый hash файла → новые point id; старые точки с тем же path но старым содержимым в Qdrant не удаляются явно (мы делаем upsert по новым id). Если у файла стало меньше символов/чанков, старые точки по этому path могут остаться. Roo-Code перед upsert для **изменённых** файлов вызывает `deletePointsByMultipleFilePaths`.

---

## 4. Удаление старых точек при изменении файла

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **При изменении файла** | Только upsert новых/обновлённых точек (id = hash файла + line + …). Старые точки с тем же path, но от предыдущей версии файла, **не удаляются** явно. | Для **modified** файлов перед upsert батча вызывается `deletePointsByMultipleFilePaths(uniqueFilePaths)` по путям изменённых файлов, затем upsert новых блоков. |
| **При удалении файла** | В конце Phase 2: по `existing` (из FileTracker) и `seen` (из текущего скана) удаляются пути, которых нет в `seen`: `fileTracker.deleteFile`, `vector.deleteByPath`. | При скане: по кэшу `getAllHashes()` и `processedFiles` удаляются точки для путей, которых нет в текущем списке обработанных. File watcher при delete сразу удаляет точки по path. |

**Потенциальные проблемы у нас:**
- **Мусор в Qdrant**: после правки файла (например удаления функции) старые точки с тем же path и старыми id остаются, т.к. мы не делаем deleteByPath перед upsert для этого файла. Roo-Code явно удаляет по path перед вставкой новых блоков изменённого файла.
- Удаление «исчезнувших» файлов у нас делается только в конце полного прохода; при только refreshFile мы не чистим другие пути.

---

## 5. Конкуррентность и семафоры

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **Обход файлов** | Последовательный `for await (walkDir)` + последовательный цикл Phase 1 по `discovered`. | `listFiles` один раз, затем `supportedPaths.map` → `parseLimiter(pLimit(PARSING_CONCURRENCY))` — до 10 файлов парсятся параллельно. |
| **Батчи эмбеддингов** | В `VectorIndex.upsertSymbols`: батчи по `embeddingBatchSize`, до `embeddingConcurrency` батчей параллельно (`Promise.all` по группе). | В scanner: накопление блоков в `currentBatchBlocks`; при достижении `batchSegmentThreshold` батч отправляется в `batchLimiter(pLimit(BATCH_PROCESSING_CONCURRENCY))` (до 10 батчей). Ограничение `MAX_PENDING_BATCHES=20` — если уже 20 батчей в полёте, парсинг ждёт. |
| **Константы** | `embeddingBatchSize`, `embeddingConcurrency` из конфига (indexing). | PARSING_CONCURRENCY=10, BATCH_PROCESSING_CONCURRENCY=10, BATCH_SEGMENT_THRESHOLD=60, MAX_PENDING_BATCHES=20. |

**Потенциальные проблемы у нас:**
- Phase 1 полностью последовательна: один файл за раз читается и парсится. На больших репо Roo-Code быстрее за счёт параллельного парсинга (10 потоков) и пайплайна парсинг ↔ батчи эмбеддингов.
- Мы не ограничиваем «pending batches»: все toIndex файлы режем батчами по файлам и каждый батч вызывает `upsertSymbols`; внутри vector уже есть семафор по embeddingConcurrency, но очереди батчей файлов нет.

---

## 6. Повторные попытки и ошибки

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **Повтор батча** | Нет. При ошибке эмбеддинга/upsert исключение пробрасывается, вектор может быть отключён (`VectorAuthError`). | `MAX_BATCH_RETRIES=3`, экспоненциальная задержка `INITIAL_RETRY_DELAY_MS * 2^(attempts-1)`. После неудачи вызывается `onError`. |
| **Ошибка при скане** | Не перехватываются пофайлово в Phase 1 (кроме `readFile` .catch → skip). В Phase 2 при ошибке upsert весь процесс падает. | Каждый файл в try/catch, ошибка уходит в `onError`, телеметрия. Батч при повторных неудачах сообщает через onError, но скан идёт дальше. |

**Потенциальные проблемы у нас:**
- Один упавший батч эмбеддингов роняет весь индекс; нет retry и нет «продолжить с остальными файлами».

---

## 7. Qdrant: коллекция и параметры

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **Имя коллекции** | `nexus_` + projectHash (md5 projectRoot, 16 символов). | `ws-` + sha256(workspacePath), 16 символов. |
| **Создание** | `createCollection` с `vectors.size`, `distance: "Cosine"`. Без on_disk и hnsw_config. | `createCollection` с `on_disk: true`, `hnsw_config: { m: 64, ef_construct: 512, on_disk: true }`. |
| **Upsert/Delete** | `client.upsert`, `client.delete` без `wait`. | `wait: true` в upsert и delete. |
| **Маркер завершения** | Точка с фиксированным id (md5 от константы), payload `type: "metadata", indexing_complete`. | Аналогично, uuidv5 от константы, `indexing_complete`, `completed_at`/`started_at`. |
| **Payload** | path, pathSegments (0..4), name, kind, parent, startLine, content (до 1000 символов). | filePath, pathSegments, codeChunk, startLine, endLine, segmentHash (и type для metadata). |

**Потенциальные проблемы у нас:**
- Без `on_disk` и без явного hnsw_config всё держится в памяти Qdrant и дефолтные параметры HNSW могут быть менее оптимальны для больших индексов.
- Без `wait: true` мы не гарантируем, что данные записаны до следующей операции (хотя на практике для нашего сценария это редко критично).

---

## 8. File Watcher (инкрементальные обновления)

| Аспект | NexusCode | Roo-Code |
|--------|-----------|----------|
| **Наличие** | Нет постоянного watcher’а в индексере. Есть вызовы `refreshFile`/`refreshFileNow` (например из контроллера при git-событиях). | После успешного скана запускается `FileWatcher`: `createFileSystemWatcher` по расширениям, события create/change/delete копятся в Map, через 500 ms debounce — батч: удаление из Qdrant по path, парсинг изменённых, эмбеддинг, upsert, обновление кэша. |
| **Состояние после скана** | Индекс «готов», дальнейшие изменения не подхватываются, пока не вызван refresh или повторный полный reindex. | Индекс «готов» + watcher продолжает обновлять индекс при изменениях файлов. |

**Потенциальные проблемы у нас:**
- Изменения в файлах после первого индекса не попадают в индекс до ручного reindex или точечного refresh (и то только если кто-то вызывает refresh при git и т.п.).

---

## 9. Итог: отличия и рекомендуемые улучшения у нас

**Отличия:**
1. **Full vs incremental**: у нас всегда полный скан + фильтр toIndex; у Roo-Code при существующем индексе — только инкрементальный скан и file watcher.
2. **chunksTotal**: у нас = все чанки репо (после полной Phase 1); у Roo-Code = только чанки в новых/изменённых файлах.
3. **Удаление старых точек**: мы не удаляем по path перед upsert изменённого файла → риск мусора в Qdrant.
4. **Парсинг**: regex vs tree-sitter (у них точнее границы и типы).
5. **Параллелизм**: у нас Phase 1 последовательная; у них параллельный парсинг и пайплайн с ограничением pending batches.
6. **Retry**: у нас нет retry батчей эмбеддингов.
7. **File watcher**: у нас нет; у них есть и обновляет индекс в фоне.
8. **Qdrant**: у нас без on_disk и без явного hnsw; у них on_disk и hnsw_config.

**Рекомендуемые улучшения в NexusCode:**
1. **Перед upsert изменённого файла** вызывать `vector.deleteByPath(filePath)` (или delete по path для всех файлов в батче, которые не «new»), чтобы не копить мусор в Qdrant.
2. **Режим incremental**: при `hasIndexedData() === true` не делать полный скан всех файлов; обходить файлы и проверять FileTracker/cache, парсить только new/changed, затем индексировать только их (как в Roo-Code).
3. **Параллелизм Phase 1**: обход и парсинг файлов ограниченным пулом (например p-limit 5–10), чтобы не держать один поток на чтении всех файлов подряд.
4. **Retry** для батча эмбеддингов: 2–3 попытки с экспоненциальной задержкой перед тем как пометить индекс как error.
5. **Опциональный file watcher** (хотя бы в расширении): при включённом индексе подписываться на create/change/delete, debounce, и вызывать аналог refresh для затронутых путей или батч-обновление.
6. **Qdrant**: рассмотреть `on_disk: true` и явный `hnsw_config` для больших коллекций.

После этих изменений поведение индекса и качество данных будут ближе к Roo-Code и устойчивее на больших репозиториях.
