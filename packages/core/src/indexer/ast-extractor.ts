import type { SymbolEntry } from "./fts.js"
import type { SymbolKind } from "../types.js"

/**
 * Extract symbols from source code using regex-based parsing.
 * Extracts: classes, functions, methods, interfaces, types, enums, exports.
 * Falls back to line-based chunking for unsupported languages.
 */
export function extractSymbols(
  content: string,
  filePath: string,
  ext: string
): SymbolEntry[] {
  const lower = ext.toLowerCase()

  switch (lower) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTypeScriptSymbols(content, filePath)
    case ".py":
      return extractPythonSymbols(content, filePath)
    case ".rs":
      return extractRustSymbols(content, filePath)
    case ".go":
      return extractGoSymbols(content, filePath)
    case ".java":
      return extractJavaSymbols(content, filePath)
    default:
      return extractChunks(content, filePath)
  }
}

function extractTypeScriptSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const stripped = line.trim()
    const lineNum = i + 1

    // Extract JSDoc comment above the symbol
    const docstring = extractJsDoc(lines, i)

    // Class
    let m = stripped.match(/^(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/)
    if (m) {
      const name = m[4]!
      const endLine = findClosingBrace(lines, i)
      symbols.push({
        path: filePath, name, kind: "class",
        startLine: lineNum, endLine,
        docstring, content: extractBlock(lines, i, Math.min(endLine - lineNum, 10)),
      })
      continue
    }

    // Function declaration
    m = stripped.match(/^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/)
    if (m) {
      const name = m[4]!
      const endLine = findClosingBrace(lines, i)
      symbols.push({
        path: filePath, name, kind: "function",
        startLine: lineNum, endLine,
        docstring, content: extractBlock(lines, i, Math.min(endLine - lineNum, 5)),
      })
      continue
    }

    // Arrow function: export const name = (async)? (...) =>
    m = stripped.match(/^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(/)
    if (m) {
      const name = m[3]!
      const endLine = findClosingBrace(lines, i)
      symbols.push({
        path: filePath, name, kind: "arrow",
        startLine: lineNum, endLine,
        docstring, content: extractBlock(lines, i, 3),
      })
      continue
    }

    // Interface
    m = stripped.match(/^(export\s+)?interface\s+(\w+)/)
    if (m) {
      const name = m[2]!
      const endLine = findClosingBrace(lines, i)
      symbols.push({
        path: filePath, name, kind: "interface",
        startLine: lineNum, endLine,
        docstring, content: extractBlock(lines, i, Math.min(endLine - lineNum, 15)),
      })
      continue
    }

    // Type alias
    m = stripped.match(/^(export\s+)?type\s+(\w+)\s*(<[^>]*>)?\s*=/)
    if (m) {
      const name = m[2]!
      symbols.push({
        path: filePath, name, kind: "type",
        startLine: lineNum, endLine: lineNum + 3,
        docstring, content: stripped,
      })
      continue
    }

    // Enum
    m = stripped.match(/^(export\s+)?(const\s+)?enum\s+(\w+)/)
    if (m) {
      const name = m[3]!
      const endLine = findClosingBrace(lines, i)
      symbols.push({
        path: filePath, name, kind: "enum",
        startLine: lineNum, endLine,
        docstring, content: extractBlock(lines, i, Math.min(endLine - lineNum, 10)),
      })
      continue
    }

    // Method inside class (indented, but we detect it)
    m = stripped.match(/^(public|private|protected|static|async|override)?\s*(public|private|protected|static|async|override)?\s*(\w+)\s*\(/)
    if (m && i > 0 && isInsideClass(lines, i)) {
      const name = m[3]!
      if (name !== "if" && name !== "for" && name !== "while" && name !== "switch") {
        const endLine = findClosingBrace(lines, i)
        symbols.push({
          path: filePath, name, kind: "method",
          parent: findContainingClass(lines, i),
          startLine: lineNum, endLine,
          docstring, content: extractBlock(lines, i, 3),
        })
      }
      continue
    }
  }

  // If no symbols found, fall back to chunks
  if (symbols.length === 0) return extractChunks(content, filePath)
  return symbols
}

function extractPythonSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const stripped = line.trim()
    const lineNum = i + 1

    let m = stripped.match(/^class\s+(\w+)/)
    if (m) {
      const name = m[1]!
      const endLine = findPythonBlockEnd(lines, i)
      const docstring = extractPythonDocstring(lines, i + 1)
      symbols.push({ path: filePath, name, kind: "class", startLine: lineNum, endLine, docstring, content: line })
      continue
    }

    m = stripped.match(/^(async\s+)?def\s+(\w+)/)
    if (m) {
      const name = m[2]!
      const endLine = findPythonBlockEnd(lines, i)
      const docstring = extractPythonDocstring(lines, i + 1)
      const indent = line.length - line.trimStart().length
      const parent = indent > 0 ? findPythonParentClass(lines, i) : undefined
      symbols.push({ path: filePath, name, kind: parent ? "method" : "function", parent, startLine: lineNum, endLine, docstring, content: line })
    }
  }

  return symbols.length > 0 ? symbols : extractChunks(content, filePath)
}

function extractRustSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const stripped = line.trim()
    const lineNum = i + 1

    let m = stripped.match(/^pub(?:\(.*?\))?\s+struct\s+(\w+)/)
    if (!m) m = stripped.match(/^struct\s+(\w+)/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "class", startLine: lineNum, endLine, content: stripped })
      continue
    }

    m = stripped.match(/^pub(?:\(.*?\))?\s+(?:async\s+)?fn\s+(\w+)/)
    if (!m) m = stripped.match(/^(?:async\s+)?fn\s+(\w+)/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "function", startLine: lineNum, endLine, content: stripped })
      continue
    }

    m = stripped.match(/^pub(?:\(.*?\))?\s+trait\s+(\w+)/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "interface", startLine: lineNum, endLine, content: stripped })
      continue
    }
  }

  return symbols.length > 0 ? symbols : extractChunks(content, filePath)
}

function extractGoSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const stripped = line.trim()
    const lineNum = i + 1

    let m = stripped.match(/^func\s+(?:\((\w+\s+\*?\w+)\)\s+)?(\w+)/)
    if (m) {
      const receiver = m[1]
      const name = m[2]!
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name, kind: receiver ? "method" : "function", parent: receiver, startLine: lineNum, endLine, content: stripped })
      continue
    }

    m = stripped.match(/^type\s+(\w+)\s+struct/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "class", startLine: lineNum, endLine, content: stripped })
      continue
    }

    m = stripped.match(/^type\s+(\w+)\s+interface/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "interface", startLine: lineNum, endLine, content: stripped })
    }
  }

  return symbols.length > 0 ? symbols : extractChunks(content, filePath)
}

function extractJavaSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const stripped = line.trim()
    const lineNum = i + 1

    let m = stripped.match(/(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "class", startLine: lineNum, endLine, content: stripped })
      continue
    }

    m = stripped.match(/(?:public|private|protected)?\s*interface\s+(\w+)/)
    if (m) {
      const endLine = findClosingBrace(lines, i)
      symbols.push({ path: filePath, name: m[1]!, kind: "interface", startLine: lineNum, endLine, content: stripped })
    }
  }

  return symbols.length > 0 ? symbols : extractChunks(content, filePath)
}

const CHUNK_SIZE = 50 // lines per chunk

export function extractChunks(content: string, filePath: string): SymbolEntry[] {
  const lines = content.split("\n")
  const chunks: SymbolEntry[] = []

  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE)
    chunks.push({
      path: filePath,
      name: `chunk_${i + 1}`,
      kind: "chunk",
      startLine: i + 1,
      endLine: Math.min(i + CHUNK_SIZE, lines.length),
      content: chunkLines.join("\n"),
    })
  }

  return chunks
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findClosingBrace(lines: string[], startLine: number): number {
  let depth = 0
  let found = false

  for (let i = startLine; i < lines.length && i < startLine + 500; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") { depth++; found = true }
      if (ch === "}") {
        depth--
        if (found && depth === 0) return i + 1
      }
    }
  }

  return Math.min(startLine + 50, lines.length)
}

function findPythonBlockEnd(lines: string[], startLine: number): number {
  const baseIndent = lines[startLine]!.length - lines[startLine]!.trimStart().length

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") continue
    const indent = line.length - line.trimStart().length
    if (indent <= baseIndent) return i
  }

  return lines.length
}

function findPythonParentClass(lines: string[], lineIdx: number): string | undefined {
  const currentIndent = lines[lineIdx]!.length - lines[lineIdx]!.trimStart().length

  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.trim() === "") continue
    const indent = line.length - line.trimStart().length
    if (indent < currentIndent) {
      const m = line.trim().match(/^class\s+(\w+)/)
      if (m) return m[1]
      return undefined
    }
  }
  return undefined
}

function extractPythonDocstring(lines: string[], startLine: number): string {
  const line = lines[startLine]?.trim() ?? ""
  if (line.startsWith('"""') || line.startsWith("'''")) {
    const quote = line.startsWith('"""') ? '"""' : "'''"
    const endIdx = line.indexOf(quote, 3)
    if (endIdx > -1) return line.slice(3, endIdx)
    // Multi-line
    let ds = line.slice(3)
    for (let i = startLine + 1; i < startLine + 5 && i < lines.length; i++) {
      const l = lines[i]!
      const end = l.indexOf(quote)
      if (end > -1) { ds += " " + l.slice(0, end); break }
      ds += " " + l.trim()
    }
    return ds.trim()
  }
  return ""
}

function extractJsDoc(lines: string[], symbolLine: number): string {
  // Look backwards for /** ... */ comment
  let i = symbolLine - 1
  if (i < 0) return ""
  // Skip blank lines
  while (i >= 0 && lines[i]?.trim() === "") i--
  if (i < 0 || !lines[i]?.trim().endsWith("*/")) return ""

  const docLines: string[] = []
  let j = i
  while (j >= 0) {
    const l = lines[j]!.trim()
    docLines.unshift(l.replace(/^\/?\*+\/?/, "").trim())
    if (l.startsWith("/**") || l.startsWith("/*")) break
    j--
  }
  return docLines.filter(Boolean).join(" ")
}

function extractBlock(lines: string[], start: number, maxLines: number): string {
  return lines.slice(start, Math.min(start + maxLines, lines.length)).join("\n")
}

function isInsideClass(lines: string[], lineIdx: number): boolean {
  const indent = lines[lineIdx]!.length - lines[lineIdx]!.trimStart().length
  if (indent === 0) return false

  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.trim() === "") continue
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent < indent) {
      return /class\s+\w+/.test(line.trim())
    }
  }
  return false
}

function findContainingClass(lines: string[], lineIdx: number): string | undefined {
  const indent = lines[lineIdx]!.length - lines[lineIdx]!.trimStart().length

  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.trim() === "") continue
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent < indent) {
      const m = line.trim().match(/class\s+(\w+)/)
      return m?.[1]
    }
  }
  return undefined
}
