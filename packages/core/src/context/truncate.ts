/**
 * KiloCode `Truncate.output` parity: max lines + max bytes, head/tail direction,
 * full output spooled to disk, model-facing message matches OpenCode wording.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { getToolOutputDir } from "../data-dir.js"

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024 // 50 KB
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
/** Cap size of saved file to protect disk (OpenCode-style). */
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB

export interface TruncateOptions {
  /** Unused for output path (always global data dir); kept for call-site compatibility. */
  cwd: string
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /**
   * When true, hint mentions KiloCode's Task tool (explore agent). Nexus has no Task tool by default.
   */
  suggestTaskTool?: boolean
}

export interface TruncateResult {
  content: string
  truncated: false
}

export interface TruncateResultTruncated {
  content: string
  truncated: true
  /** Display path (may use `~`). */
  outputPath: string
  /** Absolute filesystem path to the spilled `.out` file. */
  absolutePath: string
}

export type TruncateOutputResult = TruncateResult | TruncateResultTruncated

/**
 * Same decision tree as KiloCode `Truncate.output` (tool/truncation.ts).
 */
function buildTruncatedMessage(
  lines: string[],
  maxLines: number,
  maxBytes: number,
  direction: "head" | "tail",
  absoluteFilePath: string,
  suggestTaskTool: boolean,
): string {
  const text = lines.join("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  const out: string[] = []
  let hitBytes = false
  let bytes = 0

  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i]!, "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(lines[i]!)
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i]!, "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(lines[i]!)
      bytes += size
    }
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
  const unit = hitBytes ? "bytes" : "lines"
  const preview = out.join("\n")

  const hint = suggestTaskTool
    ? `The tool call succeeded but the output was truncated. Full output saved to: ${absoluteFilePath}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
    : `The tool call succeeded but the output was truncated. Full output saved to: ${absoluteFilePath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

  return direction === "head"
    ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
    : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`
}

export async function truncateOutput(
  text: string,
  options: TruncateOptions,
): Promise<TruncateOutputResult> {
  const maxLines = options.maxLines ?? MAX_LINES
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const direction = options.direction ?? "head"
  const suggestTaskTool = options.suggestTaskTool ?? false

  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  const outDir = getToolOutputDir()
  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch {
    const fallback = buildTruncatedMessage(lines, maxLines, maxBytes, direction, "(could not save)", suggestTaskTool)
    return {
      content: `${fallback}\n\n(Output truncated; could not save full output to disk.)`,
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

  const content = buildTruncatedMessage(lines, maxLines, maxBytes, direction, filePath, suggestTaskTool)

  const displayPath = filePath.startsWith(os.homedir())
    ? path.join("~", ".nexus", "data", "tool-output", `${id}.out`).replace(/\\/g, "/")
    : filePath.replace(/\\/g, "/")

  return {
    content,
    truncated: true,
    outputPath: displayPath,
    absolutePath: filePath,
  }
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
