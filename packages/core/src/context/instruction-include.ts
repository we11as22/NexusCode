import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

/** OpenClaude-style: @path on its own line, not inside fenced code blocks. */
const MAX_INCLUDE_DEPTH = 10
export const MAX_INSTRUCTION_FILE_CHARS = 40_000

export async function readInstructionFileRaw(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) return null
    let text = await fs.readFile(absPath, "utf8")
    if (text.length > MAX_INSTRUCTION_FILE_CHARS) {
      text = `${text.slice(0, MAX_INSTRUCTION_FILE_CHARS)}\n\n[truncated at ${MAX_INSTRUCTION_FILE_CHARS} chars]\n`
    }
    return text
  } catch {
    return null
  }
}

function resolveIncludeSpec(spec: string, baseDir: string): string | null {
  const s = spec.trim()
  if (!s || s.startsWith("#")) return null
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2))
  if (s.startsWith("~") && s.length > 1 && (s[1] === "/" || s[1] === path.sep)) {
    return path.join(os.homedir(), s.slice(2))
  }
  if (path.isAbsolute(s)) return s
  return path.resolve(baseDir, s)
}

/**
 * Expand `@relative-or-absolute` lines (OpenClaude @include parity).
 */
export async function expandInstructionIncludes(
  content: string,
  baseDir: string,
  seen: Set<string>,
  depth = 0,
): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) return content

  const lines = content.split("\n")
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    const m = line.match(/^\s*@([^\s#]+)\s*$/)
    if (!m) {
      out.push(line)
      continue
    }

    const abs = resolveIncludeSpec(m[1]!, baseDir)
    if (!abs || seen.has(abs)) continue
    seen.add(abs)
    const raw = await readInstructionFileRaw(abs)
    if (!raw) continue
    const expanded = await expandInstructionIncludes(raw, path.dirname(abs), seen, depth + 1)
    out.push(`<!-- included: ${m[1]} → ${abs} -->\n${expanded}`)
  }

  return out.join("\n")
}
