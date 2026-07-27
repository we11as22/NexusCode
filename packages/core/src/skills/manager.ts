import { constants as fsConstants, type BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { TextDecoder } from "node:util"
import { glob } from "glob"
import yaml from "js-yaml"
import type {
  NexusConfig,
  SkillAuthority,
  SkillDef,
} from "../types.js"
import { resolvePluginDeclaredPath } from "../plugins/index.js"
import { loadTrustedPluginRuntimeRecords } from "../plugins/runtime.js"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"
import type { SkillUrlRegistryOptions } from "./url-registry.js"

export type SkillLoadDiagnosticCode =
  | "skill-too-large"
  | "skill-symlink"
  | "skill-frontmatter-invalid"
  | "skill-name-mismatch"
  | "skill-read-failed"
  | "skill-glob-failed"
  | "skill-registry-failed"

export interface SkillLoadDiagnostic {
  code: SkillLoadDiagnosticCode
  path: string
  message: string
}

export interface SkillLoadOptions {
  homeDirectory?: string
  onDiagnostic?: (diagnostic: SkillLoadDiagnostic) => void
  remoteRegistry?: SkillUrlRegistryOptions
}

class SkillFileError extends Error {
  constructor(
    readonly code: SkillLoadDiagnosticCode,
    message: string,
  ) {
    super(message)
    this.name = "SkillFileError"
  }
}

type SkillDiagnosticReporter = (diagnostic: SkillLoadDiagnostic) => void

function noopDiagnostic(): void {}

interface SkillPathAuthority extends SkillAuthority {
  /**
   * The declared root itself may be an intentional alias (for example an
   * explicitly configured absolute root). Every component below it must be a
   * real directory/file, and the resolved target must remain under realRoot.
   */
  lexicalRoot: string
  realRoot: string
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  )
}

async function createSkillPathAuthority(
  lexicalRoot: string,
): Promise<SkillPathAuthority> {
  const resolvedRoot = path.resolve(lexicalRoot)
  return {
    lexicalRoot: resolvedRoot,
    realRoot: await fs.realpath(resolvedRoot).catch(() => resolvedRoot),
  }
}

function staticGlobRoot(pattern: string): string {
  const absolute = path.resolve(pattern)
  const parsed = path.parse(absolute)
  const parts = absolute.slice(parsed.root.length).split(path.sep)
  const staticParts: string[] = []
  for (const part of parts) {
    if (part.includes("*")) break
    staticParts.push(part)
  }
  return path.join(parsed.root, ...staticParts)
}

async function configuredPathAuthority(
  configuredPath: string,
  resolvedPath: string,
  cwd: string,
): Promise<SkillPathAuthority> {
  // Relative configuration inherits the workspace authority. Only an
  // explicitly absolute declaration creates a separate filesystem authority.
  if (!path.isAbsolute(configuredPath)) {
    return createSkillPathAuthority(cwd)
  }
  if (resolvedPath.includes("*")) {
    return createSkillPathAuthority(staticGlobRoot(resolvedPath))
  }
  const stat = await fs.stat(resolvedPath).catch(() => null)
  return createSkillPathAuthority(
    stat?.isDirectory() ? resolvedPath : path.dirname(resolvedPath),
  )
}

async function assertPathInsideSkillAuthority(
  filePath: string,
  authority: SkillPathAuthority,
): Promise<void> {
  const absolutePath = path.resolve(filePath)
  if (!isPathInside(authority.lexicalRoot, absolutePath)) {
    throw new SkillFileError(
      "skill-symlink",
      `Skill path is outside its declared authority: ${absolutePath}`,
    )
  }

  const relative = path.relative(authority.lexicalRoot, absolutePath)
  let current = authority.lexicalRoot
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) {
      throw new SkillFileError(
        "skill-symlink",
        `Skill path contains a symbolic link: ${current}`,
      )
    }
  }

  const realPath = await fs.realpath(absolutePath)
  if (!isPathInside(authority.realRoot, realPath)) {
    throw new SkillFileError(
      "skill-symlink",
      `Skill path resolves outside its declared authority: ${absolutePath}`,
    )
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function readStableSkillFile(
  filePath: string,
  authority: SkillPathAuthority,
  maxBytes: number,
): Promise<{ content: string; size: number }> {
  await assertPathInsideSkillAuthority(filePath, authority)
  const before = await fs.lstat(filePath, { bigint: true })
  if (before.isSymbolicLink()) {
    throw new SkillFileError(
      "skill-symlink",
      "Skill files must not be symbolic links",
    )
  }
  if (!before.isFile()) {
    throw new SkillFileError(
      "skill-read-failed",
      "Skill path is not a regular file",
    )
  }

  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | noFollow,
  )
  try {
    // All metadata and content after open come from this descriptor. Comparing
    // it with the pathname before and after closes the lstat/read TOCTOU gap.
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new SkillFileError(
        "skill-read-failed",
        "Skill file changed before it could be opened",
      )
    }
    if (opened.size > BigInt(maxBytes)) {
      throw new SkillFileError(
        "skill-too-large",
        `Skill file exceeds ${maxBytes} bytes`,
      )
    }

    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      )
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) {
      throw new SkillFileError(
        "skill-too-large",
        `Skill file exceeds ${maxBytes} bytes`,
      )
    }

    const after = await handle.stat({ bigint: true })
    if (
      BigInt(total) !== opened.size ||
      !sameFileVersion(opened, after)
    ) {
      throw new SkillFileError(
        "skill-read-failed",
        "Skill file changed while it was being read",
      )
    }

    await assertPathInsideSkillAuthority(filePath, authority)
    const pathAfter = await fs.lstat(filePath, { bigint: true })
    if (!sameFileIdentity(opened, pathAfter)) {
      throw new SkillFileError(
        "skill-read-failed",
        "Skill path changed while it was being read",
      )
    }

    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, total),
      )
    } catch {
      throw new SkillFileError(
        "skill-read-failed",
        "Skill file is not valid UTF-8",
      )
    }

    return { content, size: total }
  } finally {
    await handle.close()
  }
}

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
export async function loadSkills(
  skillPaths: string[],
  cwd: string,
  skillsUrls?: string[],
  compatibility?: ClaudeCompatibilityOptions,
  config?: NexusConfig,
  options: SkillLoadOptions = {},
): Promise<SkillDef[]> {
  const skills: SkillDef[] = []
  const seen = new Set<string>()
  const report = options.onDiagnostic ?? noopDiagnostic

  const configPaths = await Promise.all(
    skillPaths.map(async (configuredPath) => {
      const resolvedPath = path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(cwd, configuredPath)
      return {
        path: resolvedPath,
        authority: await configuredPathAuthority(
          configuredPath,
          resolvedPath,
          cwd,
        ),
      }
    }),
  )
  const pluginSkillPaths = (
    config
      ? await loadTrustedPluginRuntimeRecords(cwd, config)
      : []
  )
    .flatMap((plugin) => plugin.skills.map((skillPath) => resolvePluginDeclaredPath(plugin, skillPath)))

  const home = options.homeDirectory ?? os.homedir()
  const homeAuthority = await createSkillPathAuthority(home)
  const standardGlobs = [
    {
      pattern: path.join(home, ".nexus", "skills", "**", "SKILL.md"),
      authority: homeAuthority,
    },
    {
      pattern: path.join(home, ".nexus", "skills", "**", "*.md"),
      authority: homeAuthority,
    },
    ...(compatibility?.includeGlobalDir && compatibility?.includeSkills
      ? [
          {
            pattern: path.join(home, ".claude", "skills", "**", "SKILL.md"),
            authority: homeAuthority,
          },
          {
            pattern: path.join(home, ".claude", "skills", "**", "*.md"),
            authority: homeAuthority,
          },
        ]
      : []),
  ]

  for (const configured of configPaths) {
    await collectSkillFiles(
      configured.path,
      seen,
      skills,
      cwd,
      report,
      configured.authority,
    )
  }

  // Nearest project instructions override plugin/global defaults. Walk-up
  // patterns are produced from cwd toward the filesystem root.
  for (const source of await walkupNexusSkillPatterns(cwd, compatibility)) {
    await globAndLoadSkills(
      source.pattern,
      seen,
      skills,
      cwd,
      report,
      source.authority,
    )
  }

  for (const pluginSkillPath of pluginSkillPaths) {
    await collectSkillFiles(
      pluginSkillPath,
      seen,
      skills,
      cwd,
      report,
      await configuredPathAuthority(
        pluginSkillPath,
        pluginSkillPath,
        cwd,
      ),
    )
  }

  for (const source of standardGlobs) {
    await globAndLoadSkills(
      source.pattern,
      seen,
      skills,
      cwd,
      report,
      source.authority,
    )
  }

  if (skillsUrls && skillsUrls.length > 0) {
    const { fetchSkillUrlRegistryRoots } = await import("./url-registry.js")
    for (const raw of skillsUrls) {
      const url = raw.trim()
      if (!url) continue
      const roots = await fetchSkillUrlRegistryRoots(
        url,
        options.remoteRegistry,
      ).catch((error) => {
        report({
          code: "skill-registry-failed",
          path: url,
          message: error instanceof Error ? error.message : String(error),
        })
        return [] as string[]
      })
      for (const root of roots) {
        const pattern = path.join(root, "**", "SKILL.md")
        await globAndLoadSkills(
          pattern,
          seen,
          skills,
          cwd,
          report,
          await createSkillPathAuthority(root),
        )
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
  report: SkillDiagnosticReporter,
  authority: SkillPathAuthority,
): Promise<void> {
  let files: string[]
  try {
    files = await glob(pattern, { absolute: true })
  } catch (error) {
    report({
      code: "skill-glob-failed",
      path: pattern,
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }
  for (const file of files.sort()) {
    if (seen.has(file)) continue
    seen.add(file)
    const skill = await loadSkillFile(file, cwd, report, authority)
    if (skill) skills.push(skill)
  }
}

/** Walk from cwd to root; load `.nexus/skills` at each ancestor (monorepo / workspace roots). */
async function walkupNexusSkillPatterns(
  startDir: string,
  compatibility?: ClaudeCompatibilityOptions,
  maxHops = 40,
): Promise<Array<{ pattern: string; authority: SkillPathAuthority }>> {
  const patterns: Array<{
    pattern: string
    authority: SkillPathAuthority
  }> = []
  const seen = new Set<string>()
  let dir = path.resolve(startDir)
  for (let h = 0; h < maxHops; h++) {
    const bases = [
      path.join(dir, ".nexus", "skills"),
      ...(compatibility?.includeProjectDir && compatibility?.includeSkills ? [path.join(dir, ".claude", "skills")] : []),
    ]
    const authority = await createSkillPathAuthority(dir)
    for (const base of bases) {
      try {
        const st = await fs.stat(base)
        if (st.isDirectory()) {
          for (const tail of [["**", "SKILL.md"], ["**", "*.md"]] as const) {
            const g = path.join(base, ...tail)
            if (!seen.has(g)) {
              seen.add(g)
              patterns.push({ pattern: g, authority })
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
  report: SkillDiagnosticReporter,
  authority: SkillPathAuthority,
): Promise<void> {
  if (cfgPath.includes("*")) {
    const files = await glob(cfgPath, { absolute: true }).catch((error) => {
      report({
        code: "skill-glob-failed",
        path: cfgPath,
        message: error instanceof Error ? error.message : String(error),
      })
      return [] as string[]
    })
    for (const file of files.sort()) {
      if (seen.has(file)) continue
      seen.add(file)
      const skill = await loadSkillFile(file, cwd, report, authority)
      if (skill) skills.push(skill)
    }
    return
  }

  const stat = await fs.stat(cfgPath).catch(() => null)
  if (!stat) return

  if (stat.isFile()) {
    if (seen.has(cfgPath)) return
    seen.add(cfgPath)
    const skill = await loadSkillFile(cfgPath, cwd, report, authority)
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
        const skill = await loadSkillFile(c, cwd, report, authority)
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
      const skill = await loadSkillFile(file, cwd, report, authority)
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
    throw new SkillFileError(
      "skill-frontmatter-invalid",
      "YAML frontmatter is missing a valid closing delimiter",
    )
  }
  try {
    const data = yaml.load(m[1])
    const fm =
      data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
    return { frontmatter: fm, body: m[2] }
  } catch (error) {
    throw new SkillFileError(
      "skill-frontmatter-invalid",
      `YAML frontmatter is malformed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function loadSkillDirContext(
  skillDir: string,
  mainContent: string,
  report: SkillDiagnosticReporter,
  authority: SkillPathAuthority,
): Promise<string> {
  let totalSize = Buffer.byteLength(mainContent, "utf8")
  let renderedContent = mainContent

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

      let stableFile: { content: string; size: number }
      try {
        stableFile = await readStableSkillFile(
          file,
          authority,
          Math.min(
            MAX_EXTRA_FILE_BYTES,
            MAX_SKILL_TOTAL_BYTES - totalSize,
          ),
        )
      } catch (error) {
        if (
          error instanceof SkillFileError &&
          error.code === "skill-symlink"
        ) {
          report({
            code: "skill-symlink",
            path: file,
            message: error.message,
          })
        }
        continue
      }

      const fileContent = stableFile.content
      if (!fileContent?.trim()) continue

      const relPath = path.relative(skillDir, file)
      const lang = ext.slice(1)
      const isMarkdown = ext === ".md"
      const renderedFile =
        isMarkdown
          ? `### ${relPath}\n\n${fileContent}`
          : `### ${relPath}\n\n\`\`\`${lang}\n${fileContent.trimEnd()}\n\`\`\``
      const addition = `\n\n---\n\n${renderedFile}`
      const additionSize = Buffer.byteLength(addition, "utf8")
      if (totalSize + additionSize > MAX_SKILL_TOTAL_BYTES) continue

      totalSize += additionSize
      renderedContent += addition
    }
  }

  return renderedContent
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

async function loadSkillFile(
  filePath: string,
  _cwd: string,
  report: SkillDiagnosticReporter,
  authority: SkillPathAuthority,
): Promise<SkillDef | null> {
  try {
    const { content: raw } = await readStableSkillFile(
      filePath,
      authority,
      MAX_SKILL_TOTAL_BYTES,
    )
    if (!raw.trim()) return null

    const { frontmatter, body } = splitYamlFrontmatter(raw)
    const contentForMeta = body.trim() ? body : raw

    const dirName = path.basename(path.dirname(filePath))
    const fileName = path.basename(filePath, path.extname(filePath))

    if (SKILL_CONTEXT_DIRS.has(dirName.toLowerCase())) return null

    const fmName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : ""
    const fmDesc = typeof frontmatter.description === "string" ? frontmatter.description.trim() : ""
    if (fmName) {
      if (
        fmName.length > 64 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fmName)
      ) {
        throw new SkillFileError(
          "skill-frontmatter-invalid",
          "Skill frontmatter name must be a lowercase kebab-case name of at most 64 characters",
        )
      }
      if (
        path.basename(filePath).toLowerCase() === "skill.md" &&
        fmName !== dirName
      ) {
        throw new SkillFileError(
          "skill-name-mismatch",
          `Skill frontmatter name "${fmName}" does not match directory "${dirName}"`,
        )
      }
    }
    if (fmDesc.length > 1_024) {
      throw new SkillFileError(
        "skill-frontmatter-invalid",
        "Skill frontmatter description must be at most 1024 characters",
      )
    }

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
    const fullContent = await loadSkillDirContext(
      skillDir,
      body.trim() ? body : raw,
      report,
      authority,
    )

    return {
      name,
      path: filePath,
      summary,
      content: fullContent,
      authority: { ...authority },
    }
  } catch (error) {
    report({
      code:
        error instanceof SkillFileError
          ? error.code
          : "skill-read-failed",
      path: filePath,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
