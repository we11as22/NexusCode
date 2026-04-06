import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import yaml from "js-yaml"
import type { SkillDef } from "../types.js"
import { loadPluginManifests, resolvePluginDeclaredPath } from "../plugins/index.js"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"

/**
 * Load skills from configured paths and standard locations.
 *
 * Config paths can be:
 *  - A directory path like ".nexus/skills/my-skill" → loads SKILL.md + subdirectory context
 *  - A glob pattern like ".nexus/skills/**\/*.md"
 *  - A direct file path like ".nexus/skills/my-skill/SKILL.md"
 *
 * Standard locations are also auto-searched: **`~/.nexus/skills`** and **walk-up** from `cwd` for each ancestor’s **`.nexus/skills`** (monorepos / nested roots).
 *
 * Optional `skillsUrls`: remote registries (each base URL must serve `index.json` + skill files); cached under `~/.nexus/cache/skills/`.
 */
export async function loadSkills(skillPaths: string[], cwd: string, skillsUrls?: string[], compatibility?: ClaudeCompatibilityOptions): Promise<SkillDef[]> {
  const skills: SkillDef[] = []
  const seen = new Set<string>()

  const configPaths = skillPaths.map(p => (path.isAbsolute(p) ? p : path.resolve(cwd, p)))
  const pluginSkillPaths = (await loadPluginManifests(cwd, compatibility).catch(() => []))
    .flatMap((plugin) => plugin.skills.map((skillPath) => resolvePluginDeclaredPath(plugin, skillPath)))

  const home = os.homedir()
  const standardGlobs = [
    path.join(home, ".nexus", "skills", "**", "SKILL.md"),
    path.join(home, ".nexus", "skills", "**", "*.md"),
    ...(compatibility?.includeGlobalDir && compatibility?.includeSkills
      ? [
          path.join(home, ".claude", "skills", "**", "SKILL.md"),
          path.join(home, ".claude", "skills", "**", "*.md"),
        ]
      : []),
  ]

  for (const cfgPath of configPaths) {
    await collectSkillFiles(cfgPath, seen, skills, cwd)
  }

  for (const pluginSkillPath of pluginSkillPaths) {
    await collectSkillFiles(pluginSkillPath, seen, skills, cwd)
  }

  for (const pattern of standardGlobs) {
    await globAndLoadSkills(pattern, seen, skills, cwd)
  }

  for (const pattern of await walkupNexusSkillPatterns(cwd, compatibility)) {
    await globAndLoadSkills(pattern, seen, skills, cwd)
  }

  if (skillsUrls && skillsUrls.length > 0) {
    const { fetchSkillUrlRegistryRoots } = await import("./url-registry.js")
    for (const raw of skillsUrls) {
      const url = raw.trim()
      if (!url) continue
      const roots = await fetchSkillUrlRegistryRoots(url).catch(() => [] as string[])
      for (const root of roots) {
        const pattern = path.join(root, "**", "SKILL.md")
        await globAndLoadSkills(pattern, seen, skills, cwd)
      }
    }
  }

  const byName = new Map<string, SkillDef>()
  for (const skill of skills) {
    if (!byName.has(skill.name)) {
      byName.set(skill.name, skill)
    }
  }

  return Array.from(byName.values())
}

async function globAndLoadSkills(
  pattern: string,
  seen: Set<string>,
  skills: SkillDef[],
  cwd: string,
): Promise<void> {
  let files: string[]
  try {
    files = await glob(pattern, { absolute: true })
  } catch {
    return
  }
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    const skill = await loadSkillFile(file, cwd)
    if (skill) skills.push(skill)
  }
}

/** Walk from cwd to root; load `.nexus/skills` at each ancestor (monorepo / workspace roots). */
async function walkupNexusSkillPatterns(startDir: string, compatibility?: ClaudeCompatibilityOptions, maxHops = 40): Promise<string[]> {
  const patterns: string[] = []
  const seen = new Set<string>()
  let dir = path.resolve(startDir)
  for (let h = 0; h < maxHops; h++) {
    const bases = [
      path.join(dir, ".nexus", "skills"),
      ...(compatibility?.includeProjectDir && compatibility?.includeSkills ? [path.join(dir, ".claude", "skills")] : []),
    ]
    for (const base of bases) {
      try {
        const st = await fs.stat(base)
        if (st.isDirectory()) {
          for (const tail of [["**", "SKILL.md"], ["**", "*.md"]] as const) {
            const g = path.join(base, ...tail)
            if (!seen.has(g)) {
              seen.add(g)
              patterns.push(g)
            }
          }
        }
      } catch {
        /* */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return patterns
}

async function collectSkillFiles(
  cfgPath: string,
  seen: Set<string>,
  skills: SkillDef[],
  cwd: string,
): Promise<void> {
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
    const files = await glob(path.join(cfgPath, "**", "*.md"), { absolute: true }).catch(() => [] as string[])
    for (const file of files.sort()) {
      if (seen.has(file)) continue
      seen.add(file)
      const skill = await loadSkillFile(file, cwd)
      if (skill) skills.push(skill)
    }
  }
}

const SKILL_CONTEXT_DIRS = new Set([
  "examples",
  "example",
  "templates",
  "template",
  "docs",
  "doc",
  "snippets",
  "snippet",
  "reference",
  "references",
])
const SKILL_CONTEXT_EXTENSIONS = new Set([
  ".md",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".yaml",
  ".yml",
  ".json",
  ".sh",
  ".sql",
  ".graphql",
  ".toml",
  ".go",
  ".rs",
  ".java",
  ".cs",
])
const MAX_SKILL_TOTAL_BYTES = 80_000
const MAX_EXTRA_FILE_BYTES = 20_000

/** Parse optional YAML frontmatter (Claude / Roo / Kilo style). */
function splitYamlFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/^\uFEFF/, "")
  if (!text.startsWith("---")) {
    return { frontmatter: {}, body: text }
  }
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/)
  if (!m) {
    return { frontmatter: {}, body: text }
  }
  try {
    const data = yaml.load(m[1])
    const fm =
      data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
    return { frontmatter: fm, body: m[2] }
  } catch {
    return { frontmatter: {}, body: text }
  }
}

async function loadSkillDirContext(skillDir: string, mainContent: string): Promise<string> {
  let totalSize = Buffer.byteLength(mainContent, "utf8")
  const extras: string[] = []

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
    const subFiles = await glob(path.join(subDirPath, "**", "*"), { absolute: true, nodir: true }).catch(
      () => [] as string[],
    )

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
      const lang = ext.slice(1)
      const isMarkdown = ext === ".md"

      totalSize += Buffer.byteLength(fileContent, "utf8")
      extras.push(
        isMarkdown
          ? `### ${relPath}\n\n${fileContent}`
          : `### ${relPath}\n\n\`\`\`${lang}\n${fileContent.trimEnd()}\n\`\`\``,
      )
    }
  }

  return extras.length > 0
    ? mainContent + "\n\n---\n\n" + extras.join("\n\n---\n\n")
    : mainContent
}

const GENERIC_SKILL_PARENTS = new Set([
  "skills",
  ".nexus",
  ".agents",
  ".claude",
  ".kilo",
  ".kilocode",
  ".roo",
  ".opencode",
  "skill",
])

async function loadSkillFile(filePath: string, _cwd: string): Promise<SkillDef | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    if (!raw.trim()) return null

    const { frontmatter, body } = splitYamlFrontmatter(raw)
    const contentForMeta = body.trim() ? body : raw

    const dirName = path.basename(path.dirname(filePath))
    const fileName = path.basename(filePath, path.extname(filePath))

    if (SKILL_CONTEXT_DIRS.has(dirName.toLowerCase())) return null

    const fmName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : ""
    const fmDesc = typeof frontmatter.description === "string" ? frontmatter.description.trim() : ""

    const heuristicName = !GENERIC_SKILL_PARENTS.has(dirName.toLowerCase()) ? dirName : fileName
    const name = fmName || heuristicName

    const lines = contentForMeta.split("\n").filter(l => l.trim())
    const headingLine = lines.find(l => l.startsWith("#"))
    const summaryLine = fmDesc
      ? fmDesc
      : headingLine
        ? headingLine.replace(/^#+\s*/, "")
        : lines.find(l => !l.startsWith("#")) ?? ""
    const summary = summaryLine.replace(/^[-*]\s*/, "").slice(0, 200)

    const skillDir = path.dirname(filePath)
    const fullContent = await loadSkillDirContext(skillDir, body.trim() ? body : raw)

    return { name, path: filePath, summary, content: fullContent }
  } catch {
    return null
  }
}
