import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"
import { expandInstructionIncludes, readInstructionFileRaw, MAX_INSTRUCTION_FILE_CHARS } from "./instruction-include.js"

/**
 * Load markdown instructions (OpenClaude-class cascade):
 * - Lowest priority first in the concatenated string; **later blocks override** (closer to cwd wins).
 * - Managed → user global → project tree (repo root → cwd) → optional glob patterns from config.
 * - `@include` on its own line expands recursively (see instruction-include.ts).
 */

async function readFileSafe(filePath: string): Promise<string | null> {
  return readInstructionFileRaw(filePath)
}

function getManagedInstructionsPath(): string | null {
  const fromEnv = process.env.NEXUS_MANAGED_INSTRUCTIONS?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  if (process.platform === "win32") return null
  const p = "/etc/nexus-code/NEXUS.md"
  return p
}

async function loadManagedBlock(): Promise<string | null> {
  const p = getManagedInstructionsPath()
  if (!p) return null
  const text = await readFileSafe(p)
  if (!text) return null
  const seen = new Set<string>([p])
  const expanded = await expandInstructionIncludes(text, path.dirname(p), seen)
  return `<!-- Managed instructions: ${p} -->\n${expanded}`
}

async function loadUserGlobalBlock(compatibility?: ClaudeCompatibilityOptions): Promise<string> {
  const chunks: string[] = []
  const home = os.homedir()
  const candidates = [
    path.join(home, ".nexus", "NEXUS.md"),
    path.join(home, ".nexus", "CLAUDE.md"),
  ]
  if (compatibility?.includeGlobalDir) {
    candidates.push(path.join(home, ".claude", "CLAUDE.md"))
  }
  const seen = new Set<string>()
  for (const abs of candidates) {
    if (seen.has(abs)) continue
    const text = await readFileSafe(abs)
    if (!text) continue
    seen.add(abs)
    const expanded = await expandInstructionIncludes(text, path.dirname(abs), new Set())
    chunks.push(`<!-- User: ${path.relative(home, abs)} -->\n${expanded}`)
  }

  const globalNexusRules = await glob(path.join(home, ".nexus", "rules", "**/*.md")).catch(() => [] as string[])
  for (const match of globalNexusRules.sort()) {
    if (seen.has(match)) continue
    const text = await readFileSafe(match)
    if (!text) continue
    seen.add(match)
    const expanded = await expandInstructionIncludes(text, path.dirname(match), new Set())
    chunks.push(`<!-- Global rule: ${path.basename(match)} -->\n${expanded}`)
  }

  if (compatibility?.includeGlobalDir && compatibility?.includeRules) {
    const globalClaudeRules = await glob(path.join(home, ".claude", "rules", "**/*.md")).catch(() => [] as string[])
    for (const match of globalClaudeRules.sort()) {
      if (seen.has(match)) continue
      const text = await readFileSafe(match)
      if (!text) continue
      seen.add(match)
      const expanded = await expandInstructionIncludes(text, path.dirname(match), new Set())
      chunks.push(`<!-- Claude-compatible global: ${path.basename(match)} -->\n${expanded}`)
    }
  }

  return chunks.join("\n\n")
}

/** Collect instruction files for a single directory on the walk chain (not yet merged). */
async function collectFilesForDir(
  dir: string,
  cwd: string,
  topLevelFiles: string[],
  compatibility?: ClaudeCompatibilityOptions,
): Promise<string[]> {
  const parts: string[] = []
  const seen = new Set<string>()

  for (const file of topLevelFiles) {
    const candidate = path.join(dir, file)
    if (seen.has(candidate)) continue
    const content = await readFileSafe(candidate)
    if (!content) continue
    seen.add(candidate)
    const expanded = await expandInstructionIncludes(content, path.dirname(candidate), new Set())
    const rel = path.relative(cwd, candidate)
    parts.push(`<!-- ${rel} -->\n${expanded}`)
  }

  for (const file of topLevelFiles) {
    const candidate = path.join(dir, ".nexus", file)
    if (seen.has(candidate)) continue
    const content = await readFileSafe(candidate)
    if (!content) continue
    seen.add(candidate)
    const expanded = await expandInstructionIncludes(content, path.dirname(candidate), new Set())
    const rel = path.relative(cwd, candidate)
    parts.push(`<!-- ${rel} -->\n${expanded}`)
  }

  const nexusRulesDir = path.join(dir, ".nexus", "rules")
  const nexusRuleFiles = await glob(path.join(nexusRulesDir, "**/*.md")).catch(() => [] as string[])
  for (const match of nexusRuleFiles.sort()) {
    if (seen.has(match)) continue
    const content = await readFileSafe(match)
    if (!content) continue
    seen.add(match)
    const expanded = await expandInstructionIncludes(content, path.dirname(match), new Set())
    const rel = path.relative(cwd, match)
    parts.push(`<!-- ${rel} -->\n${expanded}`)
  }

  if (compatibility?.includeProjectDir && compatibility?.includeRules) {
    const claudeMd = path.join(dir, ".claude", "CLAUDE.md")
    if (!seen.has(claudeMd)) {
      const c = await readFileSafe(claudeMd)
      if (c) {
        seen.add(claudeMd)
        const expanded = await expandInstructionIncludes(c, path.dirname(claudeMd), new Set())
        parts.push(`<!-- ${path.relative(cwd, claudeMd)} -->\n${expanded}`)
      }
    }
    const claudeRulesDir = path.join(dir, ".claude", "rules")
    const claudeRuleFiles = await glob(path.join(claudeRulesDir, "**/*.md")).catch(() => [] as string[])
    for (const match of claudeRuleFiles.sort()) {
      if (seen.has(match)) continue
      const content = await readFileSafe(match)
      if (!content) continue
      seen.add(match)
      const expanded = await expandInstructionIncludes(content, path.dirname(match), new Set())
      const rel = path.relative(cwd, match)
      parts.push(`<!-- Claude rules: ${rel} -->\n${expanded}`)
    }
  }

  return parts
}

export async function loadRules(cwd: string, rulePatterns: string[], compatibility?: ClaudeCompatibilityOptions): Promise<string> {
  const resolvedCwd = path.resolve(cwd)
  const contents: string[] = []

  const managed = await loadManagedBlock()
  if (managed) contents.push(managed)

  const userGlobal = await loadUserGlobalBlock(compatibility)
  if (userGlobal.trim()) contents.push(userGlobal)

  const topLevelFiles = [
    ...rulePatterns.filter((p) => !p.includes("**") && !p.includes("*")),
    "NEXUS.local.md",
    ...(compatibility?.includeLocalInstructions ? ["CLAUDE.local.md"] : []),
  ]
  const globPatterns = rulePatterns.filter((p) => p.includes("**") || p.includes("*"))

  const chain: string[] = []
  let dir = resolvedCwd
  let maxUp = 24
  while (maxUp-- > 0) {
    chain.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  chain.reverse()

  for (const d of chain) {
    const layer = await collectFilesForDir(d, resolvedCwd, topLevelFiles, compatibility)
    if (layer.length > 0) {
      contents.push(layer.join("\n\n"))
    }
  }

  for (const pattern of globPatterns) {
    const expandedPath = pattern.startsWith("~")
      ? pattern.replace("~", os.homedir())
      : path.join(resolvedCwd, pattern)

    const matches = await glob(expandedPath).catch(() => [] as string[])
    const globSeen = new Set<string>()
    for (const match of matches.sort()) {
      if (globSeen.has(match)) continue
      const content = await readFileSafe(match)
      if (!content) continue
      globSeen.add(match)
      const expanded = await expandInstructionIncludes(content, path.dirname(match), new Set())
      const rel = path.relative(resolvedCwd, match)
      contents.push(`<!-- Rules from ${rel} -->\n${expanded}`)
    }
  }

  const joined = contents.filter((c) => c.trim().length > 0).join("\n\n")
  if (joined.length <= MAX_INSTRUCTION_FILE_CHARS * 4) return joined
  return `${joined.slice(0, MAX_INSTRUCTION_FILE_CHARS * 4)}\n\n[nexus] Instruction bundle truncated in loader — shorten project rules.\n`
}

export { MAX_INSTRUCTION_FILE_CHARS }
