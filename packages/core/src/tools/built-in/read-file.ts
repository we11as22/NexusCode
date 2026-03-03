import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_FILE_SIZE = 200 * 1024 // 200 KB
const MAX_LINES = 3000

const schema = z.object({
  path: z.string().describe("Relative or absolute path to the file"),
  start_line: z.number().int().positive().optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().positive().optional().describe("End line (1-indexed, inclusive)"),
})

export const readFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "read_file",
  description: `Read file contents with optional line range. Output format: "LINE_NUM|CONTENT".

When to use:
- After codebase_search or grep: use path and start_line/end_line from results to load only the relevant section (saves context).
- Reading config, README, or known paths.
- Inspecting implementation before editing.

When NOT to use:
- Searching content: use codebase_search (semantic) or grep (regex) first.
- Listing directory: use list_files.

Limits: ${MAX_FILE_SIZE / 1024}KB or ${MAX_LINES} lines per read. Large files without start_line/end_line return head+tail. Binary files return metadata only.`,
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
