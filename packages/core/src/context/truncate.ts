/**
 * Kilocode/OpenCode-style truncation of tool output.
 * When output exceeds MAX_LINES or MAX_BYTES, it is truncated; full output is saved to
 * .nexus/tool-output/ and the model gets a shortened version + hint to use Read/Grep.
 */
import * as fs from "node:fs"
import * as path from "node:path"

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024 // 50 KB
const TOOL_OUTPUT_DIR = "tool-output"
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
/** Cap size of saved file to protect disk (OpenCode-style). */
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB

export interface TruncateOptions {
  /** Working directory; output is saved under cwd/.nexus/tool-output/ */
  cwd: string
  maxLines?: number
  maxBytes?: number
  /** Which end to keep when truncating by lines: "head" (default) or "tail" */
  direction?: "head" | "tail"
}

export interface TruncateResult {
  content: string
  truncated: false
}

export interface TruncateResultTruncated {
  content: string
  truncated: true
  outputPath: string
}

export type TruncateOutputResult = TruncateResult | TruncateResultTruncated

const DEFAULT_HINT =
  "Full output saved to the file above. Use Read with offset/limit to view specific sections or Grep to search the full content. Do NOT paste the entire file — use tools to inspect it."

/**
 * If text exceeds maxLines or maxBytes, truncate it, write full output to .nexus/tool-output/<id>.out,
 * and return shortened content + path hint. Otherwise return content unchanged.
 */
export async function truncateOutput(
  text: string,
  options: TruncateOptions
): Promise<TruncateOutputResult> {
  const maxLines = options.maxLines ?? MAX_LINES
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const direction = options.direction ?? "head"

  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  const outDir = path.join(options.cwd, ".nexus", TOOL_OUTPUT_DIR)
  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch {
    // If we can't create dir, return truncated in-memory only (no file)
    const truncated = truncateInMemory(text, lines, totalBytes, maxLines, maxBytes, direction)
    return {
      content: truncated + "\n\n(Output truncated; could not save full output to disk.)",
      truncated: false,
    }
  }

  await cleanupOldFiles(outDir)

  const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const filePath = path.join(outDir, `${id}.out`)
  const fileContent =
    totalBytes <= MAX_FILE_BYTES
      ? text
      : Buffer.from(text, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8") +
        "\n\n[output truncated at 50 MB in file]\n"
  await fs.promises.writeFile(filePath, fileContent, "utf8").catch(() => {})

  const relPath = path.relative(options.cwd, filePath).replace(/\\/g, "/") || `.nexus/${TOOL_OUTPUT_DIR}/${id}.out`
  const truncated = truncateInMemory(text, lines, totalBytes, maxLines, maxBytes, direction)
  const hint = `\n\nFull output saved to: ${relPath}\n${DEFAULT_HINT}`

  return {
    content: truncated + hint,
    truncated: true,
    outputPath: relPath,
  }
}

function truncateInMemory(
  text: string,
  lines: string[],
  totalBytes: number,
  maxLines: number,
  maxBytes: number,
  direction: "head" | "tail"
): string {
  if (lines.length <= maxLines && totalBytes <= maxBytes) return text

  let result: string
  if (lines.length > maxLines) {
    const removedLines = lines.length - maxLines
    let out: string[]
    if (direction === "head") {
      const headCount = Math.ceil(maxLines / 2)
      const tailCount = maxLines - headCount
      out = [
        ...lines.slice(0, headCount),
        `... ${removedLines} lines truncated ...`,
        ...lines.slice(-tailCount),
      ]
    } else {
      const tailCount = Math.ceil(maxLines / 2)
      const headCount = maxLines - tailCount
      out = [
        ...lines.slice(0, headCount),
        `... ${removedLines} lines truncated ...`,
        ...lines.slice(-tailCount),
      ]
    }
    result = out.join("\n")
  } else {
    const buf = Buffer.from(text, "utf8")
    result = buf.subarray(0, maxBytes).toString("utf8")
    const removed = totalBytes - Buffer.byteLength(result, "utf8")
    result += `\n\n... ${removed} bytes truncated ...`
  }

  const resultBytes = Buffer.byteLength(result, "utf8")
  if (resultBytes > maxBytes) {
    const buf = Buffer.from(result, "utf8")
    result = buf.subarray(0, maxBytes).toString("utf8") + "\n\n... (output truncated by size) ..."
  }
  return result
}

async function cleanupOldFiles(dir: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith("tool_") || !e.name.endsWith(".out")) continue
      const full = path.join(dir, e.name)
      const stat = await fs.promises.stat(full).catch(() => null)
      if (stat?.mtimeMs != null && stat.mtimeMs < cutoff) {
        await fs.promises.unlink(full).catch(() => {})
      }
    }
  } catch {
    // ignore
  }
}
