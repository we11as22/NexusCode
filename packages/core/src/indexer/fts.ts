import Database from "better-sqlite3"
import type { IndexSearchResult, SymbolKind } from "../types.js"

export interface SymbolEntry {
  path: string
  name: string
  kind: SymbolKind
  parent?: string
  startLine: number
  endLine: number
  docstring?: string
  content: string
}

export interface ChunkEntry {
  path: string
  offset: number
  content: string
}

/**
 * SQLite FTS5-based code index.
 * Stores symbols (classes, functions etc.) and fallback chunks.
 */
export class FTSIndex {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.setupSchema()
  }

  private setupSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols USING fts5(
        path UNINDEXED,
        name,
        kind UNINDEXED,
        parent UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        docstring,
        content,
        tokenize = 'unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        path UNINDEXED,
        offset UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `)
  }

  isFileIndexed(filePath: string, mtime: number, hash: string): boolean {
    const row = this.db.prepare(
      "SELECT hash, mtime FROM files WHERE path = ?"
    ).get(filePath) as { hash: string; mtime: number } | undefined

    return row !== undefined && row.hash === hash && row.mtime === mtime
  }

  upsertFile(filePath: string, mtime: number, hash: string): void {
    // Delete old entries
    this.db.prepare("DELETE FROM symbols WHERE path = ?").run(filePath)
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(filePath)
    this.db.prepare(
      "INSERT OR REPLACE INTO files (path, mtime, hash, indexed_at) VALUES (?, ?, ?, ?)"
    ).run(filePath, mtime, hash, Date.now())
  }

  insertSymbol(entry: SymbolEntry): void {
    this.db.prepare(`
      INSERT INTO symbols (path, name, kind, parent, start_line, end_line, docstring, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.path,
      entry.name,
      entry.kind,
      entry.parent ?? "",
      entry.startLine,
      entry.endLine,
      entry.docstring ?? "",
      entry.content,
    )
  }

  insertChunk(entry: ChunkEntry): void {
    this.db.prepare(
      "INSERT INTO chunks (path, offset, content) VALUES (?, ?, ?)"
    ).run(entry.path, entry.offset, entry.content)
  }

  deleteFile(filePath: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath)
    this.db.prepare("DELETE FROM symbols WHERE path = ?").run(filePath)
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(filePath)
  }

  /** Clear all indexed data (for full reindex). */
  clear(): void {
    this.db.prepare("DELETE FROM files").run()
    this.db.prepare("DELETE FROM symbols").run()
    this.db.prepare("DELETE FROM chunks").run()
  }

  /**
   * Search symbols by FTS query, optionally restricted to paths under the given prefixes.
   * When pathPrefixes is non-empty, filtering is done in the DB (same best practice as vector pathSegments).
   */
  searchSymbols(query: string, limit: number, kind?: SymbolKind, pathPrefixes?: string[]): IndexSearchResult[] {
    const pathCondition = buildPathCondition(pathPrefixes)
    let sql: string
    let params: (string | number)[]

    if (kind && pathCondition) {
      sql = `
        SELECT path, name, kind, parent, start_line, end_line, docstring, content,
          rank as score
        FROM symbols
        WHERE symbols MATCH ? AND kind = ? AND ${pathCondition.sql}
        ORDER BY rank
        LIMIT ?
      `
      params = [escapeQuery(query), kind, ...pathCondition.params, limit]
    } else if (kind) {
      sql = `
        SELECT path, name, kind, parent, start_line, end_line, docstring, content,
          rank as score
        FROM symbols
        WHERE symbols MATCH ? AND kind = ?
        ORDER BY rank
        LIMIT ?
      `
      params = [escapeQuery(query), kind, limit]
    } else if (pathCondition) {
      sql = `
        SELECT path, name, kind, parent, start_line, end_line, docstring, content,
          rank as score
        FROM symbols
        WHERE symbols MATCH ? AND ${pathCondition.sql}
        ORDER BY rank
        LIMIT ?
      `
      params = [escapeQuery(query), ...pathCondition.params, limit]
    } else {
      sql = `
        SELECT path, name, kind, parent, start_line, end_line, docstring, content,
          rank as score
        FROM symbols
        WHERE symbols MATCH ?
        ORDER BY rank
        LIMIT ?
      `
      params = [escapeQuery(query), limit]
    }

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        path: string; name: string; kind: string; parent: string;
        start_line: number; end_line: number; docstring: string; content: string; score: number
      }>

      return rows.map(r => ({
        path: r.path,
        name: r.name,
        kind: r.kind as SymbolKind,
        parent: r.parent || undefined,
        startLine: r.start_line,
        endLine: r.end_line,
        content: `${r.docstring ? r.docstring + "\n" : ""}${r.content}`,
        score: r.score,
      }))
    } catch {
      return []
    }
  }

  /**
   * Search chunks by FTS query, optionally restricted to paths under the given prefixes.
   * When pathPrefixes is non-empty, filtering is done in the DB (same best practice as vector pathSegments).
   */
  searchChunks(query: string, limit: number, pathPrefixes?: string[]): IndexSearchResult[] {
    const pathCondition = buildPathCondition(pathPrefixes)
    try {
      if (pathCondition) {
        const rows = this.db.prepare(`
          SELECT path, offset, content, rank as score
          FROM chunks
          WHERE chunks MATCH ? AND ${pathCondition.sql}
          ORDER BY rank
          LIMIT ?
        `).all(escapeQuery(query), ...pathCondition.params, limit) as Array<{ path: string; offset: number; content: string; score: number }>
        return rows.map(r => ({
          path: r.path,
          startLine: r.offset,
          content: r.content,
          score: r.score,
        }))
      }
      const rows = this.db.prepare(`
        SELECT path, offset, content, rank as score
        FROM chunks
        WHERE chunks MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(escapeQuery(query), limit) as Array<{ path: string; offset: number; content: string; score: number }>

      return rows.map(r => ({
        path: r.path,
        startLine: r.offset,
        content: r.content,
        score: r.score,
      }))
    } catch {
      return []
    }
  }

  getStats(): { files: number; symbols: number; chunks: number } {
    const files = (this.db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }).n
    const symbols = (this.db.prepare("SELECT COUNT(*) as n FROM symbols").get() as { n: number }).n
    const chunks = (this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }).n
    return { files, symbols, chunks }
  }

  close(): void {
    this.db.close()
  }

  getFilesWithHashes(): Map<string, { mtime: number; hash: string }> {
    const rows = this.db.prepare("SELECT path, mtime, hash FROM files").all() as Array<{ path: string; mtime: number; hash: string }>
    const map = new Map<string, { mtime: number; hash: string }>()
    for (const row of rows) {
      map.set(row.path, { mtime: row.mtime, hash: row.hash })
    }
    return map
  }
}

function escapeQuery(query: string): string {
  // Escape FTS5 special characters
  return query
    .replace(/["]/g, '""')
    .replace(/[*]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map(word => `"${word}"`)
    .join(" ")
}

/** Build SQL condition for path under any of the given prefixes (server-side path filter). */
function buildPathCondition(pathPrefixes?: string[]): { sql: string; params: string[] } | null {
  if (!pathPrefixes || pathPrefixes.length === 0) return null
  const normalized = pathPrefixes.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean)
  if (normalized.length === 0) return null
  const clauses = normalized.map(() => "(path = ? OR path LIKE ?)")
  const params = normalized.flatMap((pre) => [pre, `${pre}/%`])
  return { sql: `(${clauses.join(" OR ")})`, params }
}
