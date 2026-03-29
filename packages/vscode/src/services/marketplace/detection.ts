import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { MarketplaceInstalledMetadata } from "./types.js"
import { MarketplacePaths } from "./paths.js"

type Entry = [string, { type: string }]

export class InstallationDetector {
  constructor(private paths: MarketplacePaths) {}

  async detect(workspace?: string): Promise<MarketplaceInstalledMetadata> {
    const project = workspace
      ? Object.fromEntries([
          ...(await this.mcpEntriesFromFile(this.paths.mcpServersJsonPath("project", workspace))),
          ...(await this.mergedSkillEntries("project", workspace)),
        ])
      : {}

    const global = Object.fromEntries([
      ...(await this.mcpEntriesFromFile(this.paths.mcpServersJsonPath("global"))),
      ...(await this.mergedSkillEntries("global")),
    ])

    return { project, global }
  }

  private async mergedSkillEntries(scope: "project" | "global", workspace?: string): Promise<Entry[]> {
    const base =
      scope === "project" && workspace ? this.paths.skillsDir("project", workspace) : this.paths.skillsDir("global")
    return await this.skillDirEntries(base)
  }

  private async mcpEntriesFromFile(filepath: string): Promise<Entry[]> {
    try {
      const content = await fs.readFile(filepath, "utf-8")
      const parsed = JSON.parse(content) as unknown
      const servers = Array.isArray(parsed)
        ? parsed
        : (parsed as { servers?: unknown })?.servers ?? (parsed as { mcp?: { servers?: unknown } })?.mcp?.servers
      if (!Array.isArray(servers)) return []
      const entries: Entry[] = []
      for (const s of servers) {
        if (s && typeof s === "object" && !Array.isArray(s)) {
          const name = (s as { name?: string }).name
          if (typeof name === "string" && name.trim()) {
            entries.push([name.trim(), { type: "mcp" }])
          }
        }
      }
      return entries
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[nexus marketplace] Failed to read MCP file ${filepath}:`, err)
      }
      return []
    }
  }

  private async skillDirEntries(base: string): Promise<Entry[]> {
    const entries: Entry[] = []
    try {
      const dirents = await fs.readdir(base, { withFileTypes: true })
      for (const d of dirents) {
        if (!d.isDirectory()) continue
        const id = d.name
        if (!id || id.startsWith(".")) continue
        const skillMd = path.join(base, id, "SKILL.md")
        try {
          await fs.access(skillMd)
        } catch {
          continue
        }
        entries.push([id, { type: "skill" }])
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[nexus marketplace] Failed to list skills under ${base}:`, err)
      }
    }
    return entries
  }
}
