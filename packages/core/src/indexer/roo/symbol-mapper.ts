import type { SymbolEntry, SymbolKind } from "../../types.js"
import type { CodeBlock } from "./types.js"

function blockTypeToKind(type: string): SymbolKind {
  const t = type.toLowerCase()
  if (t.includes("function") || t.includes("func") || t === "function_declaration") return "function"
  if (t.includes("class")) return "class"
  if (t.includes("method")) return "method"
  if (t.includes("interface")) return "interface"
  if (t.includes("enum")) return "enum"
  if (t.includes("type") || t.includes("typedef")) return "type"
  if (t.includes("const") || t.includes("property")) return "const"
  return "chunk"
}

/** Map semantic `CodeBlock` rows to `SymbolEntry` for vector upsert. */
export function rooBlocksToSymbolEntries(relPath: string, blocks: CodeBlock[]): SymbolEntry[] {
  return blocks.map((b) => ({
    path: relPath,
    name: (b.identifier ?? b.type).slice(0, 512) || "chunk",
    kind: blockTypeToKind(b.type),
    parent: undefined,
    startLine: b.start_line,
    endLine: b.end_line,
    content: b.content,
    segmentHash: b.segmentHash,
  }))
}
