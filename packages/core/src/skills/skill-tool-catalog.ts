/**
 * Skill tool catalog and helpers — uses only Nexus `loadSkills` (manager.ts) discovery.
 */
import type { BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  NexusConfig,
  SkillAuthority,
  SkillDef,
} from "../types.js"
import {
  loadSkills,
  type SkillLoadOptions,
} from "./manager.js"
import { getClaudeCompatibilityOptions } from "../compat/claude.js"

export type SkillToolDescriptionRow = { name: string; description: string; location: string }

export type ResolvedSkillBody = {
  displayName: string
  content: string
  skillDir: string
  authority: SkillAuthority
}

export class SkillNameAmbiguityError extends Error {
  constructor(
    readonly query: string,
    readonly candidates: string[],
  ) {
    super(
      `Skill "${query}" is ambiguous. Candidates: ${candidates.join(", ")}.`,
    )
    this.name = "SkillNameAmbiguityError"
  }
}

/** Rows for the `Skill` tool description (`<available_skills>`), from the same set as `loadSkills`. */
export async function loadSkillToolCatalogRows(cwd: string, config: NexusConfig): Promise<SkillToolDescriptionRow[]> {
  const skills = await loadSkills(
    config.skills ?? [],
    cwd,
    config.skillsUrls,
    getClaudeCompatibilityOptions(config),
    config,
  ).catch(() => [] as SkillDef[])
  return skills
    .map((s) => ({
      name: s.name,
      description: (s.summary ?? "").trim() || s.name,
      location: s.path,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/[-_\s]+/g, "-")
}

/**
 * Resolve skill body from `loadSkills` only.
 * Exact and normalized-exact names take precedence. Ambiguous partial matches
 * throw `SkillNameAmbiguityError` with deterministic candidate names.
 */
export async function resolveSkillBody(
  query: string,
  cwd: string,
  config: NexusConfig,
  loadOptions: SkillLoadOptions = {},
): Promise<ResolvedSkillBody | null> {
  const q = query.trim()
  if (!q) return null

  const loaded = await loadSkills(
    config.skills ?? [],
    cwd,
    config.skillsUrls,
    getClaudeCompatibilityOptions(config),
    config,
    loadOptions,
  ).catch(() => [] as SkillDef[])
  const inputNorm = normalizeName(q)

  const compareSkills = (left: SkillDef, right: SkillDef): number => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1
    if (left.path === right.path) return 0
    return left.path < right.path ? -1 : 1
  }
  const select = (matches: SkillDef[]): SkillDef | undefined => {
    const ordered = [...matches].sort(compareSkills)
    if (ordered.length > 1) {
      throw new SkillNameAmbiguityError(
        q,
        [...new Set(ordered.map((skill) => skill.name))],
      )
    }
    return ordered[0]
  }

  let found = select(
    loaded.filter((skill) => skill.name.toLowerCase() === q.toLowerCase()),
  )
  if (!found) {
    found = select(
      loaded.filter((skill) => normalizeName(skill.name) === inputNorm),
    )
  }
  if (!found) {
    found = select(
      loaded.filter((skill) => normalizeName(skill.name).includes(inputNorm)),
    )
  }
  if (!found) {
    found = select(
      loaded.filter((skill) => inputNorm.includes(normalizeName(skill.name))),
    )
  }
  if (!found) return null
  const skillDir = path.dirname(found.path)
  const authority = found.authority ?? {
    lexicalRoot: skillDir,
    realRoot: await fs.realpath(skillDir).catch(() => path.resolve(skillDir)),
  }

  return {
    displayName: found.name,
    content: found.content,
    skillDir,
    authority,
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Dynamic `Skill` tool description: lists discoverable skills for the LLM. */
export function buildSkillToolDynamicDescription(rows: SkillToolDescriptionRow[]): string {
  if (rows.length === 0) {
    return "Load a specialized skill (markdown instructions). No skills are listed here yet; discover project skills deterministically by exact name or through ToolSearch."
  }
  const examples = rows
    .map((s) => `'${s.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples ? ` (e.g. ${examples}, ...)` : ""
  return [
    "Load a specialized skill that provides domain-specific instructions and workflows.",
    "",
    "When a task matches one of the skills below, call this tool with the exact `name` to load the full markdown body into the conversation.",
    "",
    'The response uses a `<skill_content name="...">` block plus a sampled `<skill_files>` list under the skill directory.',
    "",
    "<available_skills>",
    ...rows.flatMap((skill) => [
      `  <skill>`,
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${pathToFileURL(skill.location).href}</location>`,
      `  </skill>`,
    ]),
    "</available_skills>",
    "",
    `Use parameter \`name\` — must match a skill name above${hint}.`,
  ].join("\n")
}

const SAMPLE_LIMIT = 10

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

async function inspectAuthorizedSamplePath(
  candidatePath: string,
  authority: SkillAuthority,
): Promise<BigIntStats | null> {
  try {
    const currentRealRoot = await fs.realpath(authority.lexicalRoot)
    if (currentRealRoot !== authority.realRoot) return null

    const absolutePath = path.resolve(candidatePath)
    if (!isPathInside(authority.lexicalRoot, absolutePath)) return null

    const relative = path.relative(authority.lexicalRoot, absolutePath)
    let current = authority.lexicalRoot
    let candidateStat: BigIntStats | null = null
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component)
      candidateStat = await fs.lstat(current, { bigint: true })
      if (candidateStat.isSymbolicLink()) return null
    }

    const realPath = await fs.realpath(absolutePath)
    if (!isPathInside(authority.realRoot, realPath)) return null
    // The declared authority root itself may be an intentional absolute
    // symlink; its captured real target above is the authority in that case.
    return candidateStat ?? await fs.stat(absolutePath, { bigint: true })
  } catch {
    return null
  }
}

function sameSamplePathVersion(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

/** Sample files under the skill directory (paths containing `skill.md` skipped). */
export async function sampleSkillSiblingFiles(
  skillDir: string,
  signal?: AbortSignal,
  capturedAuthority?: SkillAuthority,
): Promise<string[]> {
  const authority = capturedAuthority ?? {
    lexicalRoot: path.resolve(skillDir),
    realRoot: await fs.realpath(skillDir).catch(() => path.resolve(skillDir)),
  }
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (signal?.aborted || out.length >= SAMPLE_LIMIT) return
    const before = await inspectAuthorizedSamplePath(dir, authority)
    if (!before?.isDirectory()) return
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    const after = await inspectAuthorizedSamplePath(dir, authority)
    if (!after || !sameSamplePathVersion(before, after)) return

    entries.sort()
    for (const entryName of entries) {
      if (signal?.aborted || out.length >= SAMPLE_LIMIT) return
      const full = path.join(dir, entryName)
      if (relPathHasGit(full, skillDir)) continue
      const entry = await inspectAuthorizedSamplePath(full, authority)
      if (!entry) continue
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (full.replace(/\\/g, "/").toLowerCase().includes("skill.md")) continue
      const verified = await inspectAuthorizedSamplePath(full, authority)
      if (!verified || !sameSamplePathVersion(entry, verified)) continue
      out.push(full)
    }
  }
  await walk(skillDir)
  return out.slice(0, SAMPLE_LIMIT)
}

function relPathHasGit(full: string, skillDir: string): boolean {
  const rel = path.relative(skillDir, full)
  return rel.split(path.sep).some((p) => p === ".git")
}
