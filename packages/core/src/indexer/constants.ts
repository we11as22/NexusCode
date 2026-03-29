/** Roo-aligned limits for codebase indexing. */

export const MAX_INDEX_FILE_BYTES = 1024 * 1024

/** Schema default; Roo parity: `maxIndexedFiles === 0` disables listing. */
export const DEFAULT_MAX_INDEXED_FILES = 50_000

export const DEFAULT_MAX_PENDING_EMBED_BATCHES = 20

export const DEFAULT_BATCH_PROCESSING_CONCURRENCY = 10

/** Fraction of chunks that may fail to embed before treating run as partial failure (Roo-style). */
export const DEFAULT_MAX_INDEXING_FAILURE_RATE = 0.1

/** VS Code–style batch debounce for file watcher (ms). */
export const INDEX_FILE_WATCHER_DEBOUNCE_MS = 500
