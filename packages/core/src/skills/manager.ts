import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import type { SkillDef } from "../types.js"

/**
 * Load skills from configured paths and standard locations.
 *
 * Config paths can be:
 *  - A directory path like ".nexus/skills/my-skill" → loads SKILL.md + subdirectory context
 *  - A glob pattern like ".nexus/skills/**\/*.md"
 *  - A direct file path like ".nexus/skills/my-skill/SKILL.md"
 *
 * Standard locations are also auto-searched.
 */
export async function loadSkills(skillPaths: string[], cwd: string): Promise<SkillDef[]> {
  const skills: SkillDef[] = []
  const seen = new Set<string>()

  // Resolve all configured paths (could be dirs, files, or globs)
  const configPaths = skillPaths.map(p =>
    path.isAbsolute(p) ? p : path.resolve(cwd, p)
  )

  // Standard auto-search locations
  const standardGlobs = [
    path.join(cwd, ".nexus", "skills", "**", "SKILL.md"),
    path.join(cwd, ".nexus", "skills", "**", "*.md"),
    path.join(cwd, ".agents", "skills", "**", "*.md"),
    path.join(os.homedir(), ".nexus", "skills", "**", "SKILL.md"),
    path.join(os.homedir(), ".nexus", "skills", "**", "*.md"),
    path.join(os.homedir(), ".agents", "skills", "**", "*.md"),
  ]

  // Process config paths first (they take priority)
  for (const cfgPath of configPaths) {
    await collectSkillFiles(cfgPath, seen, skills, cwd)
  }

  // Then standard locations
  for (const pattern of standardGlobs) {
    let files: string[]
    try {
      files = await glob(pattern, { absolute: true })
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

  // Deduplicate by name (keep first seen)
  const byName = new Map<string, SkillDef>()
  for (const skill of skills) {
    if (!byName.has(skill.name)) {
      byName.set(skill.name, skill)
    }
  }

  return Array.from(byName.values())
}

async function collectSkillFiles(
  cfgPath: string,
  seen: Set<string>,
  skills: SkillDef[],
  cwd: string
): Promise<void> {
  // Glob pattern
  if (cfgPath.includes("*")) {
    const files = await glob(cfgPath, { absolute: true }).catch(() => [] as string[])
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      const skill = await loadSkillFile(file, cwd)
      if (skill) skills.push(skill)
    }
    return
  }

  const stat = await fs.stat(cfgPath).catch(() => null)
  if (!stat) return

  if (stat.isFile()) {
    if (seen.has(cfgPath)) return
    seen.add(cfgPath)
    const skill = await loadSkillFile(cfgPath, cwd)
    if (skill) skills.push(skill)
    return
  }

  if (stat.isDirectory()) {
    // Try SKILL.md first, then any .md file
    const candidates = [
      path.join(cfgPath, "SKILL.md"),
      path.join(cfgPath, "skill.md"),
      path.join(cfgPath, "README.md"),
    ]
    for (const c of candidates) {
      if (seen.has(c)) continue
      const cStat = await fs.stat(c).catch(() => null)
      if (cStat?.isFile()) {
        seen.add(c)
        const skill = await loadSkillFile(c, cwd)
        if (skill) {
          skills.push(skill)
          return
        }
      }
    }
    // Fallback: any .md in directory tree (recursive — catches skills organized in subdirs)
    const files = await glob(path.join(cfgPath, "**", "*.md"), { absolute: true }).catch(() => [] as string[])
    for (const file of files.sort()) {
      if (seen.has(file)) continue
      seen.add(file)
      const skill = await loadSkillFile(file, cwd)
      if (skill) skills.push(skill)
    }
  }
}

// Subdirectory names whose files are included as additional skill context
const SKILL_CONTEXT_DIRS = new Set(["examples", "example", "templates", "template", "docs", "doc", "snippets", "snippet", "reference", "references"])
// File extensions included from context subdirectories
const SKILL_CONTEXT_EXTENSIONS = new Set([".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".yaml", ".yml", ".json", ".sh", ".sql", ".graphql", ".toml", ".go", ".rs", ".java", ".cs"])
// Max total skill content size (main + subdirectory context)
const MAX_SKILL_TOTAL_BYTES = 80_000
// Max size per individual extra file
const MAX_EXTRA_FILE_BYTES = 20_000

/**
 * Load additional context from well-known subdirectories of a skill directory.
 * Finds files in examples/, templates/, docs/, snippets/, reference/ etc. and appends
 * them to the skill content so the agent sees the full skill directory, not just SKILL.md.
 */
async function loadSkillDirContext(skillDir: string, mainContent: string): Promise<string> {
  let totalSize = Buffer.byteLength(mainContent, "utf8")
  const extras: string[] = []

  // Only look at immediate subdirectories that are known context dirs
  let entryNames: string[]
  try {
    const raw = await fs.readdir(skillDir, { withFileTypes: true })
    entryNames = raw.filter(e => e.isDirectory()).map(e => String(e.name))
  } catch {
    return mainContent
  }

  for (const entryName of entryNames) {
    if (!SKILL_CONTEXT_DIRS.has(entryName.toLowerCase())) continue

    const subDirPath = path.join(skillDir, entryName)
    const subFiles = await glob(path.join(subDirPath, "**", "*"), { absolute: true, nodir: true }).catch(() => [] as string[])

    for (const file of subFiles.sort()) {
      const ext = path.extname(file).toLowerCase()
      if (!SKILL_CONTEXT_EXTENSIONS.has(ext)) continue

      const fileStat = await fs.stat(file).catch(() => null)
      if (!fileStat?.isFile()) continue
      if (fileStat.size > MAX_EXTRA_FILE_BYTES) continue
      if (totalSize + fileStat.size > MAX_SKILL_TOTAL_BYTES) continue

      const fileContent = await fs.readFile(file, "utf8").catch(() => null)
      if (!fileContent?.trim()) continue

      const relPath = path.relative(skillDir, file)
      const lang = ext.slice(1) // Remove dot: .ts -> ts
      const isMarkdown = ext === ".md"

      totalSize += Buffer.byteLength(fileContent, "utf8")
      extras.push(
        isMarkdown
          ? `### ${relPath}\n\n${fileContent}`
          : `### ${relPath}\n\n\`\`\`${lang}\n${fileContent.trimEnd()}\n\`\`\``
      )
    }
  }

  return extras.length > 0
    ? mainContent + "\n\n---\n\n" + extras.join("\n\n---\n\n")
    : mainContent
}

async function loadSkillFile(filePath: string, _cwd: string): Promise<SkillDef | null> {
  try {
    const content = await fs.readFile(filePath, "utf8")
    if (!content.trim()) return null

    // Determine skill name: prefer parent directory name over file name
    const dirName = path.basename(path.dirname(filePath))
    const fileName = path.basename(filePath, path.extname(filePath))

    // Skip files that live inside context subdirectories — they're included as part of the
    // parent skill's content (via loadSkillDirContext), not separate skills.
    if (SKILL_CONTEXT_DIRS.has(dirName.toLowerCase())) return null
    // If parent dir is a skill dir (not "skills" itself), use its name
    const name = !["skills", ".nexus", ".agents"].includes(dirName.toLowerCase())
      ? dirName
      : fileName

    // Extract first heading line as title, otherwise first non-empty line
    const lines = content.split("\n").filter(l => l.trim())
    const headingLine = lines.find(l => l.startsWith("#"))
    const summaryLine = headingLine
      ? headingLine.replace(/^#+\s*/, "")
      : lines.find(l => !l.startsWith("#")) ?? ""
    const summary = summaryLine.replace(/^[-*]\s*/, "").slice(0, 120)

    // Load additional context from skill subdirectories (examples/, templates/, docs/, etc.)
    const skillDir = path.dirname(filePath)
    const fullContent = await loadSkillDirContext(skillDir, content)

    return { name, path: filePath, summary, content: fullContent }
  } catch {
    return null
  }
}
