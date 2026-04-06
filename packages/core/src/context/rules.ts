import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"

/**
 * Load rules from NEXUS.md, CLAUDE.md, AGENTS.md, .nexus/rules/** etc.
 * Walks up from cwd to find all applicable rule files.
 */
export async function loadRules(cwd: string, rulePatterns: string[], compatibility?: ClaudeCompatibilityOptions): Promise<string> {
  const contents: string[] = []
  const seen = new Set<string>()

  // Walk up from cwd to find files like NEXUS.md, CLAUDE.md, AGENTS.md
  const topLevelFiles = [
    ...rulePatterns.filter(p => !p.includes("**") && !p.includes("*")),
    "NEXUS.local.md",
    ...(compatibility?.includeLocalInstructions ? ["CLAUDE.local.md"] : []),
  ]
  const globPatterns = rulePatterns.filter(p => p.includes("**") || p.includes("*"))

  // Walk up for top-level files
  let dir = cwd
  let maxUp = 10
  while (maxUp-- > 0) {
    for (const file of topLevelFiles) {
      const candidate = path.join(dir, file)
      if (!seen.has(candidate)) {
        const content = await readFileSafe(candidate)
        if (content) {
          seen.add(candidate)
          const rel = path.relative(cwd, candidate)
          contents.push(`<!-- Rules from ${rel} -->\n${content}`)
        }
      }
    }
    for (const file of topLevelFiles) {
      const candidate = path.join(dir, ".nexus", file)
      if (!seen.has(candidate)) {
        const content = await readFileSafe(candidate)
        if (content) {
          seen.add(candidate)
          const rel = path.relative(cwd, candidate)
          contents.push(`<!-- Rules from ${rel} -->\n${content}`)
        }
      }
    }
    const nexusRulesDir = path.join(dir, ".nexus", "rules")
    const nexusRuleFiles = await glob(path.join(nexusRulesDir, "**/*.md")).catch(() => [] as string[])
    for (const match of nexusRuleFiles.sort()) {
      if (!seen.has(match)) {
        const content = await readFileSafe(match)
        if (content) {
          seen.add(match)
          const rel = path.relative(cwd, match)
          contents.push(`<!-- Rules from ${rel} -->\n${content}`)
        }
      }
    }
    if (compatibility?.includeProjectDir && compatibility?.includeRules) {
      const claudeRulesDir = path.join(dir, ".claude", "rules")
      const claudeRuleFiles = await glob(path.join(claudeRulesDir, "**/*.md")).catch(() => [] as string[])
      for (const match of claudeRuleFiles.sort()) {
        if (!seen.has(match)) {
          const content = await readFileSafe(match)
          if (content) {
            seen.add(match)
            const rel = path.relative(cwd, match)
            contents.push(`<!-- Claude-compatible rules from ${rel} -->\n${content}`)
          }
        }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Expand glob patterns from cwd
  for (const pattern of globPatterns) {
    const expandedPath = pattern.startsWith("~")
      ? pattern.replace("~", os.homedir())
      : path.join(cwd, pattern)

    const matches = await glob(expandedPath).catch(() => [] as string[])
    for (const match of matches.sort()) {
      if (!seen.has(match)) {
        const content = await readFileSafe(match)
        if (content) {
          seen.add(match)
          const rel = path.relative(cwd, match)
          contents.push(`<!-- Rules from ${rel} -->\n${content}`)
        }
      }
    }
  }

  // Also check global ~/.nexus/rules/**
  const globalRulesDir = path.join(os.homedir(), ".nexus", "rules")
  const globalRules = await glob(path.join(globalRulesDir, "**/*.md")).catch(() => [] as string[])
  for (const match of globalRules.sort()) {
    if (!seen.has(match)) {
      const content = await readFileSafe(match)
      if (content) {
        seen.add(match)
        contents.push(`<!-- Global rule: ${path.basename(match)} -->\n${content}`)
      }
    }
  }
  if (compatibility?.includeGlobalDir && compatibility?.includeRules) {
    const globalClaudeRulesDir = path.join(os.homedir(), ".claude", "rules")
    const globalClaudeRules = await glob(path.join(globalClaudeRulesDir, "**/*.md")).catch(() => [] as string[])
    for (const match of globalClaudeRules.sort()) {
      if (!seen.has(match)) {
        const content = await readFileSafe(match)
        if (content) {
          seen.add(match)
          contents.push(`<!-- Claude-compatible global rule: ${path.basename(match)} -->\n${content}`)
        }
      }
    }
  }

  return contents.join("\n\n")
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null
    if (stat.size > 100 * 1024) return null // Skip files >100KB
    return await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }
}
