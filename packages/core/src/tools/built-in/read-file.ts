import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_FILE_SIZE = 200 * 1024 // 200 KB — over this without offset/limit we return head+tail
const DEFAULT_LIMIT = 2000
const MAX_LINES = 3000
/** Refuse to read file into memory above this (avoids OOM). Agent must use offset/limit or grep. */
const MAX_READ_SIZE = 20 * 1024 * 1024 // 20 MB

/** 0 means “from start” (stripped); positive ints are 1-based line offsets. */
const offsetSchema = z
  .union([z.literal(0), z.coerce.number().int().positive()])
  .optional()
  .transform((v) => (v === 0 ? undefined : v))

const schema = z.object({
  file_path: z.string().min(1).describe("The absolute path to the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."),
  offset: offsetSchema.describe("1-based start line. Omit to read from the beginning; 0 is treated as omit."),
  limit: z.coerce.number().int().positive().max(MAX_LINES).optional().describe(`The number of lines to read. Only provide if the file is too large to read at once. Defaults to ${DEFAULT_LIMIT} when reading from the start.`),
}).refine(
  (data) => data.offset == null || data.limit == null || data.limit > 0,
  { message: "limit must be positive", path: ["limit"] }
)

export const readFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "Read",
  searchHint: "read file lines by path, inspect file contents with offset and limit, line-numbered file viewer",
  description: `Reads a file through the host-authorized filesystem. Local hosts may grant absolute paths; remote or sandboxed hosts can restrict access to their workspace capability. It is okay to request a file that does not exist; an error will be returned.

Usage:
- Use this after Grep, CodebaseSearch, List, Glob, ListCodeDefinitions, or LSP has already identified the relevant file and roughly the relevant range.
- Prefer the smallest useful read. If you know the symbol or line range, use \`offset\` and \`limit\` instead of reading from the top.
- file_path may be absolute or relative to the project root
- By default, it reads up to ${DEFAULT_LIMIT} lines starting from the beginning of the file
- Prefer specifying offset and limit for long files or when you already know the relevant range (e.g. from Grep, CodebaseSearch, or ListCodeDefinitions). Use whole-file reads only when the file is small or you genuinely need the entire file
- When full chunk contents were already provided by a previous tool (CodebaseSearch, Grep with context), do not call Read again for the same path and line range — use the content you already have. Call Read only to expand ranges when you got only signatures or snippets
- Each time you call Read, assess whether the contents are sufficient to proceed. If not, call again with a different offset/limit or run more searches; do not re-read the same range
- Any lines longer than 2000 characters will be truncated
- Results are returned with line numbers in the format \`LINE_NUMBER|LINE_CONTENT\`. Treat the \`LINE_NUMBER|\` prefix as metadata — never include it in old_string/new_string when editing
- You can call multiple tools in a single response. Prefer reading multiple potentially useful files in parallel; do not drip one-at-a-time
- If you read a file that exists but has empty contents you will receive 'File is empty.'
- Binary files are not decoded. For binary content this tool returns file metadata and states that the file cannot be read as text.

When NOT to use:
- Do not use Read for broad discovery across many files; use Grep, CodebaseSearch, Glob, List, or LSP first.
- Do not use Read to "double-check" content you just received from another tool for the exact same path and lines.
- Do not use Read through Bash (\`cat\`, \`sed\`, \`head\`, \`tail\`). Use this tool directly.`,
  parameters: schema,
  readOnly: true,

  async execute({ file_path, offset, limit }, ctx: ToolContext) {
    const filePath = file_path
    let content: string
    try {
      content = await ctx.host.readFile(filePath, { maxBytes: MAX_READ_SIZE })
    } catch (error) {
      return {
        success: false,
        output: `Failed to read ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }

    const size = Buffer.byteLength(content, "utf8")
    if (isBinaryContent(content)) {
      return {
        success: true,
        output: `[Binary file: ${filePath}]\nSize: ${formatBytes(size)}\nCannot read binary content.`,
      }
    }

    if (size > MAX_READ_SIZE) {
      return {
        success: false,
        output: `File too large (${formatBytes(size)}). Use Grep to search. Max readable size is ${MAX_READ_SIZE / 1024 / 1024} MB.`,
      }
    }

    if (size > MAX_FILE_SIZE && !offset) {
      return truncateWithHeadTail(content, filePath)
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

function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 512)
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    if (code === 0 || code < 8) return true
  }
  return false
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
