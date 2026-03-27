/**
 * Skill tool catalog and helpers — uses only Nexus `loadSkills` (manager.ts) discovery.
 */
import type { Dirent } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type { NexusConfig, SkillDef } from "../types.js"
import { loadSkills } from "./manager.js"

export type SkillToolDescriptionRow = { name: string; description: string; location: string }

export type ResolvedSkillBody = { displayName: string; content: string; skillDir: string }

/** Rows for the `Skill` tool description (`<available_skills>`), from the same set as `loadSkills`. */
export async function loadSkillToolCatalogRows(cwd: string, config: NexusConfig): Promise<SkillToolDescriptionRow[]> {
  const skills = await loadSkills(config.skills ?? [], cwd, config.skillsUrls).catch(() => [] as SkillDef[])
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
 * Resolve skill body from `loadSkills` only (case-insensitive / normalized / partial match).
 */
export async function resolveSkillBody(
  query: string,
  cwd: string,
  config: NexusConfig,
): Promise<ResolvedSkillBody | null> {
  const q = query.trim()
  if (!q) return null

  const loaded = await loadSkills(config.skills ?? [], cwd, config.skillsUrls).catch(() => [] as SkillDef[])
  const inputNorm = normalizeName(q)

  let found = loaded.find((s) => s.name.toLowerCase() === q.toLowerCase())
  if (!found) {
    found = loaded.find((s) => normalizeName(s.name) === inputNorm)
  }
  if (!found) {
    found = loaded.find((s) => {
      const sn = normalizeName(s.name)
      return sn.includes(inputNorm) || inputNorm.includes(sn)
    })
  }
  if (!found) return null

  return {
    displayName: found.name,
    content: found.content,
    skillDir: path.dirname(found.path),
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
    return "Load a specialized skill (markdown instructions). No skills are listed here yet; project skills may still appear under Active Skills in the system prompt when the classifier selects them."
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

/** Sample files under the skill directory (paths containing `skill.md` skipped). */
export async function sampleSkillSiblingFiles(skillDir: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (signal?.aborted || out.length >= SAMPLE_LIMIT) return
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    for (const ent of entries) {
      if (signal?.aborted || out.length >= SAMPLE_LIMIT) return
      const full = path.join(dir, String(ent.name))
      if (relPathHasGit(full, skillDir)) continue
      if (ent.isDirectory()) {
        await walk(full)
        continue
      }
      if (!ent.isFile()) continue
      if (full.replace(/\\/g, "/").toLowerCase().includes("skill.md")) continue
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
