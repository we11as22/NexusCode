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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

type IncludeBudget = { chars: number }

/**
 * Expand `@relative-or-absolute` lines (OpenClaude @include parity).
 * Includes retain the authority boundary of the original instruction file:
 * recursive traversal, absolute paths, and symlinks cannot escape `baseDir`.
 */
export async function expandInstructionIncludes(
  content: string,
  baseDir: string,
  seen: Set<string>,
  depth = 0,
  authorityRoot = path.resolve(baseDir),
  budget: IncludeBudget = { chars: 0 },
): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) return "[nexus] include depth limit reached"

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
    if (!abs) continue
    const real = await fs.realpath(abs).catch(() => null)
    const realRoot = await fs.realpath(authorityRoot).catch(() => path.resolve(authorityRoot))
    if (!real || !isWithin(realRoot, real)) {
      out.push(`[nexus] blocked include outside approved root: ${m[1]}`)
      continue
    }
    if (seen.has(real)) {
      out.push(`[nexus] skipped cyclic include: ${m[1]}`)
      continue
    }
    seen.add(real)
    const raw = await readInstructionFileRaw(real)
    if (!raw) continue
    const remaining = MAX_INSTRUCTION_FILE_CHARS * 4 - budget.chars
    if (remaining <= 0) {
      out.push("[nexus] include budget exhausted")
      continue
    }
    const bounded = raw.slice(0, remaining)
    budget.chars += bounded.length
    const expanded = await expandInstructionIncludes(
      bounded,
      path.dirname(real),
      seen,
      depth + 1,
      realRoot,
      budget,
    )
    out.push(`<!-- included: ${m[1]} → ${real} -->\n${expanded}`)
  }

  return out.join("\n")
}
