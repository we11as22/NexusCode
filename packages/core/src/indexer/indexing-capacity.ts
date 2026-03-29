/**
 * Capacity limits aligned with Roo-Code `sources/Roo-Code/src/services/code-index/constants`
 * (MAX_FILE_SIZE_BYTES, MAX_LIST_FILES_LIMIT_CODE_INDEX, PARSING_CONCURRENCY).
 */
export const INDEX_MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1 MiB
/** Roo `MAX_LIST_FILES_LIMIT_CODE_INDEX` — schema default for `indexing.maxIndexedFiles` matches. */
export const INDEX_MAX_LIST_FILES_ROO = 50_000
export const INDEX_PARSING_CONCURRENCY = 10
