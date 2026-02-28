import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import type { SkillDef } from "../types.js"

/**
 * Load skills from configured paths and standard locations.
 */
export async function loadSkills(skillPaths: string[], cwd: string): Promise<SkillDef[]> {
  const skills: SkillDef[] = []
  const seen = new Set<string>()

  const searchPaths = [
    ...skillPaths,
    path.join(cwd, ".nexus", "skills", "**", "*.md"),
    path.join(cwd, ".agents", "skills", "**", "*.md"),
    path.join(os.homedir(), ".nexus", "skills", "**", "*.md"),
    path.join(os.homedir(), ".agents", "skills", "**", "*.md"),
  ]

  for (const pattern of searchPaths) {
    const expanded = pattern.startsWith("~")
      ? pattern.replace("~", os.homedir())
      : pattern

    let files: string[]
    try {
      if (expanded.includes("*")) {
        files = await glob(expanded)
      } else {
        const stat = await fs.stat(expanded).catch(() => null)
        files = stat?.isFile() ? [expanded] : []
      }
    } catch {
      continue
    }

    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)

      const skill = await loadSkillFile(file, cwd)
      if (skill) skills.push(skill)
    }
  }

  return skills
}

async function loadSkillFile(filePath: string, cwd: string): Promise<SkillDef | null> {
  try {
    const content = await fs.readFile(filePath, "utf8")
    if (!content.trim()) return null

    // Determine skill name from file path
    const dirName = path.basename(path.dirname(filePath))
    const fileName = path.basename(filePath, path.extname(filePath))
    const name = dirName !== "skills" ? dirName : fileName

    // Extract first non-empty non-heading line as summary
    const lines = content.split("\n").filter(l => l.trim())
    const summaryLine = lines.find(l => !l.startsWith("#")) ?? lines[0] ?? ""
    const summary = summaryLine.replace(/^[-*]\s*/, "").slice(0, 100)

    return { name, path: filePath, summary, content }
  } catch {
    return null
  }
}
