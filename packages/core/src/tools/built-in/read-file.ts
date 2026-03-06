import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_FILE_SIZE = 200 * 1024 // 200 KB — over this without offset/limit we return head+tail
const DEFAULT_LIMIT = 2000
const MAX_LINES = 3000
/** Refuse to read file into memory above this (avoids OOM). Agent must use offset/limit or grep. */
const MAX_READ_SIZE = 20 * 1024 * 1024 // 20 MB

const schema = z.object({
  file_path: z.string().min(1).describe("The absolute path to the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."),
  offset: z.number().int().positive().optional().describe("The line number to start reading from. Only provide if the file is too large to read at once."),
  limit: z.number().int().positive().max(MAX_LINES).optional().describe(`The number of lines to read. Only provide if the file is too large to read at once. Defaults to ${DEFAULT_LIMIT} when reading from the start.`),
}).refine(
  (data) => data.offset == null || data.limit == null || data.limit > 0,
  { message: "limit must be positive", path: ["limit"] }
)

export const readFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "Read",
  description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${DEFAULT_LIMIT} lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files in a batch that are potentially useful
- If you read a file that exists but has empty contents you will receive 'File is empty.'

Image Support:
- This tool can also read image files when called with the appropriate path.
- Supported image formats: jpeg/jpg, png, gif, webp.`,
  parameters: schema,
  readOnly: true,

  async execute({ file_path, offset, limit }, ctx: ToolContext) {
    const filePath = file_path
    const absPath = path.resolve(ctx.cwd, filePath)

    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(absPath)
    } catch {
      return { success: false, output: `File not found: ${filePath}` }
    }

    if (stat.isDirectory()) {
      return { success: false, output: `Path is a directory, not a file: ${filePath}. Use ListFiles instead.` }
    }

    if (await isBinaryFile(absPath)) {
      return {
        success: true,
        output: `[Binary file: ${filePath}]\nSize: ${formatBytes(stat.size)}\nCannot read binary content.`,
      }
    }

    if (stat.size > MAX_READ_SIZE) {
      return {
        success: false,
        output: `File too large (${formatBytes(stat.size)}). Use offset and limit to read specific sections, or use Grep to search. Max readable size is ${MAX_READ_SIZE / 1024 / 1024} MB.`,
      }
    }

    if (stat.size > MAX_FILE_SIZE && !offset) {
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
    const startLine = offset ? Math.max(1, offset) : 1
    const effectiveLimit = limit ?? (offset ? MAX_LINES : DEFAULT_LIMIT)
    const start = Math.max(0, startLine - 1)
    const end = Math.min(totalLines, start + effectiveLimit)
    const slicedLines = lines.slice(start, end)

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
    `      |... ${truncated} lines truncated. Use offset and limit to read specific sections ...`,
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
