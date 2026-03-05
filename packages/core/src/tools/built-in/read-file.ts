import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_FILE_SIZE = 200 * 1024 // 200 KB — over this without start_line/end_line we return head+tail
const MAX_LINES = 3000
/** Refuse to read file into memory above this (avoids OOM). Agent must use start_line/end_line or grep. */
const MAX_READ_SIZE = 20 * 1024 * 1024 // 20 MB

const schema = z.object({
  path: z.string().min(1).describe("Relative or absolute path to the file"),
  start_line: z.number().int().positive().optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().positive().optional().describe("End line (1-indexed, inclusive)"),
}).refine(
  (data) => data.end_line == null || data.start_line == null || data.end_line >= data.start_line,
  { message: "end_line must be >= start_line", path: ["end_line"] }
)

export const readFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "read_file",
  description: `Read file contents with optional line range. Output format: "LINE_NUM|CONTENT". Prefer reading only ranges (start_line/end_line) after you have locations from list_code_definitions, grep, or codebase_search — do not read whole files to explore.

When to use:
- After codebase_search or grep: use path and start_line/end_line from results to load only the relevant section (saves context).
- After list_code_definitions: use the reported line numbers with start_line/end_line to read only that symbol (e.g. one function). Prefer this over reading the whole file.
- Reading config, README, or known paths.
- Inspecting implementation before editing.
- You can call read_file again with different start_line/end_line to view other parts of the same file (e.g. if the first read didn't contain what you need — "scroll" through the file by requesting the next or previous line range).

When NOT to use:
- Searching content: use codebase_search (semantic) or grep (regex) first.
- Listing directory: use list_files.
- Discovering structure: use list_code_definitions and grep first, then read_file with ranges.
- Re-reading the same range: when a previous tool result (codebase_search, grep, list_code_definitions) already returned full content for a path:line range, do not call read_file again for that range — use the content you already have.

Best practice: Use start_line and end_line whenever you have a line number (from grep, list_code_definitions, or codebase_search). Do not read entire large files when a small range is enough.

Limits: ${MAX_FILE_SIZE / 1024}KB or ${MAX_LINES} lines per read. Large files without start_line/end_line return head+tail. Files over ${MAX_READ_SIZE / 1024 / 1024}MB are not read in full — use start_line/end_line or grep. Binary files return metadata only.`,
  parameters: schema,
  readOnly: true,

  async execute({ path: filePath, start_line, end_line }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, filePath)

    // Check deny patterns (handled by caller, but double-check)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(absPath)
    } catch {
      return { success: false, output: `File not found: ${filePath}` }
    }

    if (stat.isDirectory()) {
      return { success: false, output: `Path is a directory, not a file: ${filePath}. Use list_files instead.` }
    }

    // Binary check (basic magic bytes)
    if (await isBinaryFile(absPath)) {
      return {
        success: true,
        output: `[Binary file: ${filePath}]\nSize: ${formatBytes(stat.size)}\nCannot read binary content.`,
      }
    }

    // Refuse to load huge files into memory (OOM protection)
    if (stat.size > MAX_READ_SIZE) {
      return {
        success: false,
        output: `File too large (${formatBytes(stat.size)}). Use start_line and end_line to read specific sections, or use grep to search. Max readable size is ${MAX_READ_SIZE / 1024 / 1024} MB.`,
      }
    }

    if (stat.size > MAX_FILE_SIZE && !start_line) {
      // Return truncated with head + tail
      const content = await fs.readFile(absPath, "utf8")
      return truncateWithHeadTail(content, filePath)
    }

    let content: string
    try {
      content = await fs.readFile(absPath, "utf8")
    } catch (err) {
      return { success: false, output: `Failed to read ${filePath}: ${(err as Error).message}` }
    }

    const lines = content.split("\n")
    const totalLines = lines.length

    // Apply line range
    const start = start_line ? Math.max(0, start_line - 1) : 0
    const end = end_line ? Math.min(totalLines, end_line) : totalLines

    const slicedLines = lines.slice(start, end)

    // Enforce max lines per read
    if (slicedLines.length > MAX_LINES) {
      const head = slicedLines.slice(0, 100)
      const tail = slicedLines.slice(-100)
      const truncated = slicedLines.length - 200
      const numbered = [
        ...head.map((l, i) => `${(start + i + 1).toString().padStart(6)}|${l}`),
        `      |... ${truncated} lines truncated (total: ${slicedLines.length}) ...`,
        ...tail.map((l, i) => `${(end - 100 + i + 1).toString().padStart(6)}|${l}`),
      ].join("\n")
      return {
        success: true,
        output: `<file_content path="${filePath}" lines="${start + 1}-${end}" total="${totalLines}">\n${numbered}\n</file_content>`,
      }
    }

    const numbered = slicedLines
      .map((l, i) => `${(start + i + 1).toString().padStart(6)}|${l}`)
      .join("\n")

    return {
      success: true,
      output: `<file_content path="${filePath}" lines="${start + 1}-${Math.min(end, totalLines)}" total="${totalLines}">\n${numbered}\n</file_content>`,
    }
  },
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, "r")
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, 512, 0)
    await handle.close()

    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i]!
      if (byte === 0) return true
      if (byte < 8) return true
    }
    return false
  } catch {
    return false
  }
}

function truncateWithHeadTail(content: string, filePath: string): ReturnType<typeof readFileTool.execute> {
  const lines = content.split("\n")
  const total = lines.length
  const head = lines.slice(0, 100)
  const tail = lines.slice(-100)
  const truncated = total - 200

  const numbered = [
    ...head.map((l, i) => `${(i + 1).toString().padStart(6)}|${l}`),
    `      |... ${truncated} lines truncated. Use start_line/end_line to read specific sections ...`,
    ...tail.map((l, i) => `${(total - 100 + i + 1).toString().padStart(6)}|${l}`),
  ].join("\n")

  return Promise.resolve({
    success: true,
    output: `<file_content path="${filePath}" lines="1-100..${total - 100}-${total}" total="${total}">\n${numbered}\n</file_content>`,
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
