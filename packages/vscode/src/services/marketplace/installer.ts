import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execa } from "execa"
import type { McpServerConfig } from "@nexuscode/core"
import type {
  MarketplaceItem,
  SkillMarketplaceItem,
  McpMarketplaceItem,
  McpInstallationMethod,
  InstallMarketplaceItemOptions,
  InstallResult,
  RemoveResult,
} from "./types.js"
import { MarketplacePaths } from "./paths.js"
import { extractGithubSkillFromBlobUrl } from "./github-skill.js"

export class MarketplaceInstaller {
  constructor(private paths: MarketplacePaths) {}

  async install(
    item: MarketplaceItem,
    options: InstallMarketplaceItemOptions,
    workspace?: string,
  ): Promise<InstallResult> {
    const scope = options.target ?? "project"
    if (item.type === "skill") return this.installSkill(item, scope, workspace)
    return this.installMcp(item, options, scope, workspace)
  }

  async installMcp(
    item: McpMarketplaceItem,
    options: InstallMarketplaceItemOptions,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<InstallResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope install" }
    }

    const servers = await this.readMcpServers(scope, workspace)
    if (servers.some((s) => s.name === item.id)) {
      return { success: false, slug: item.id, error: "MCP server already installed. Remove it first." }
    }

    const content = this.resolveMcpContent(item, options)
    if (!content) {
      return { success: false, slug: item.id, error: "No installation content for MCP server" }
    }

    const filtered = Object.fromEntries(
      Object.entries(options.parameters ?? {}).filter(([k]) => k !== "__method"),
    )
    const jsonText = Object.keys(filtered).length > 0 ? substituteParams(content, filtered) : content

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(jsonText) as Record<string, unknown>
    } catch (err) {
      return { success: false, slug: item.id, error: `Invalid MCP JSON: ${err}` }
    }

    try {
      const entry = rawToNexusServer(item.id, raw)
      servers.push(entry)
      await this.writeMcpServers(scope, workspace, servers)
      return { success: true, slug: item.id }
    } catch (err) {
      return { success: false, slug: item.id, error: String(err) }
    }
  }

  private resolveMcpContent(item: McpMarketplaceItem, options: InstallMarketplaceItemOptions): string | undefined {
    if (typeof item.content === "string") return item.content
    if (!Array.isArray(item.content) || item.content.length === 0) return undefined
    const name = options.parameters?.__method as string | undefined
    if (name) {
      const found = item.content.find((m: McpInstallationMethod) => m.name === name)
      if (found) return found.content
    }
    return item.content[0].content
  }

  async installSkill(
    item: SkillMarketplaceItem,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<InstallResult> {
    if (item.skillInstall?.kind === "github_blob") {
      return this.installSkillFromGithubBlob(item, scope, workspace)
    }
    if (!item.content) {
      return { success: false, slug: item.id, error: "Skill has no archive URL" }
    }
    if (!isSafeId(item.id)) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope install" }
    }

    const skillsBase = this.paths.skillsDir(scope, workspace)
    const dir = path.join(skillsBase, item.id)
    if (!path.resolve(dir).startsWith(path.resolve(skillsBase))) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }

    const existing = path.join(skillsBase, item.id)
    try {
      await fs.access(existing)
      return { success: false, slug: item.id, error: "Skill already installed. Remove it before installing again." }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }

    const base = skillsBase
    const stamp = Date.now()
    const tarball = path.join(os.tmpdir(), `nexus-skill-${item.id}-${stamp}.tar.gz`)
    await fs.mkdir(base, { recursive: true })
    const staging = path.join(base, `.staging-${item.id}-${stamp}`)

    try {
      const response = await fetch(item.content)
      if (!response.ok) {
        return { success: false, slug: item.id, error: `Download failed: ${response.status}` }
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      await fs.writeFile(tarball, buffer)

      await fs.mkdir(staging, { recursive: true })
      const tarResult = await execa("tar", ["-xzf", tarball, "--strip-components=1", "-C", staging], {
        reject: false,
      })
      if (tarResult.exitCode !== 0) {
        throw new Error(tarResult.stderr || `tar exited ${tarResult.exitCode}`)
      }

      const escaped = await findEscapedPaths(staging)
      if (escaped.length > 0) {
        await fs.rm(staging, { recursive: true })
        return { success: false, slug: item.id, error: "Skill archive contains unsafe paths" }
      }

      try {
        await fs.access(path.join(staging, "SKILL.md"))
      } catch {
        await fs.rm(staging, { recursive: true })
        return { success: false, slug: item.id, error: "Extracted archive missing SKILL.md" }
      }

      await fs.rename(staging, dir)
      return { success: true, slug: item.id, filePath: path.join(dir, "SKILL.md"), line: 1 }
    } catch (err) {
      try {
        await fs.rm(staging, { recursive: true })
      } catch {
        /* */
      }
      return { success: false, slug: item.id, error: String(err) }
    } finally {
      try {
        await fs.unlink(tarball)
      } catch {
        /* */
      }
    }
  }

  /** SkillNet / GitHub blob links: full repo tarball + extract path to skill folder. */
  private async installSkillFromGithubBlob(
    item: SkillMarketplaceItem,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<InstallResult> {
    const url = item.skillInstall?.url
    if (!url) {
      return { success: false, slug: item.id, error: "Missing skill URL" }
    }
    if (!isSafeId(item.id)) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope install" }
    }

    const skillsBase = this.paths.skillsDir(scope, workspace)
    const dir = path.join(skillsBase, item.id)
    if (!path.resolve(dir).startsWith(path.resolve(skillsBase))) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }

    const existingGh = path.join(skillsBase, item.id)
    try {
      await fs.access(existingGh)
      return { success: false, slug: item.id, error: "Skill already installed. Remove it before installing again." }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }

    await fs.mkdir(skillsBase, { recursive: true })

    try {
      await extractGithubSkillFromBlobUrl(url, dir)
      return { success: true, slug: item.id, filePath: path.join(dir, "SKILL.md"), line: 1 }
    } catch (err) {
      try {
        await fs.rm(dir, { recursive: true })
      } catch {
        /* */
      }
      return { success: false, slug: item.id, error: String(err) }
    }
  }

  async remove(item: MarketplaceItem, scope: "project" | "global", workspace?: string): Promise<RemoveResult> {
    if (item.type === "skill") return this.removeSkill(item, scope, workspace)
    return this.removeMcp(item as McpMarketplaceItem, scope, workspace)
  }

  async removeMcp(item: McpMarketplaceItem, scope: "project" | "global", workspace?: string): Promise<RemoveResult> {
    const servers = await this.readMcpServers(scope, workspace)
    const next = servers.filter((s) => s.name !== item.id)
    if (next.length === servers.length) {
      return { success: true, slug: item.id }
    }
    await this.writeMcpServers(scope, workspace, next)
    return { success: true, slug: item.id }
  }

  async removeSkill(
    item: SkillMarketplaceItem,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<RemoveResult> {
    if (!isSafeId(item.id)) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }
    const base = this.paths.skillsDir(scope, workspace)
    const dir = path.join(base, item.id)
    if (!path.resolve(dir).startsWith(path.resolve(base))) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }
    let removed = false
    let lastErr: unknown
    try {
      await fs.access(dir)
      await fs.rm(dir, { recursive: true })
      removed = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") lastErr = err
    }
    if (removed) return { success: true, slug: item.id }
    if (lastErr) return { success: false, slug: item.id, error: String(lastErr) }
    return { success: true, slug: item.id }
  }

  private async readMcpServers(scope: "project" | "global", workspace?: string): Promise<McpServerConfig[]> {
    const filepath = this.paths.mcpServersJsonPath(scope, workspace)
    try {
      const content = await fs.readFile(filepath, "utf-8")
      const parsed = JSON.parse(content) as unknown
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed as { servers?: unknown })?.servers ?? (parsed as { mcp?: { servers?: unknown } })?.mcp?.servers
      if (!Array.isArray(arr)) return []
      return arr.filter((s): s is McpServerConfig => s !== null && typeof s === "object" && typeof (s as McpServerConfig).name === "string")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
  }

  private async writeMcpServers(
    scope: "project" | "global",
    workspace: string | undefined,
    servers: McpServerConfig[],
  ): Promise<void> {
    const filepath = this.paths.mcpServersJsonPath(scope, workspace)
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    const body = JSON.stringify({ servers }, null, 2) + "\n"
    await fs.writeFile(filepath, body, "utf-8")
  }
}

function rawToNexusServer(name: string, raw: Record<string, unknown>): McpServerConfig {
  const enabled = raw.enabled !== false

  if (typeof raw.url === "string") {
    const t = String(raw.type ?? raw.transport ?? "").toLowerCase()
    const transport =
      t.includes("streamable") || t === "http" ? ("http" as const) : ("sse" as const)
    const entry: McpServerConfig = {
      name,
      url: raw.url,
      transport,
      enabled,
    }
    if (raw.headers && typeof raw.headers === "object") {
      entry.headers = raw.headers as Record<string, string>
    }
    if (typeof raw.cwd === "string") entry.cwd = raw.cwd
    return entry
  }

  if (typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? (raw.args as string[]) : []
    const entry: McpServerConfig = {
      name,
      command: raw.command,
      args,
      enabled,
    }
    if (raw.env && typeof raw.env === "object") {
      entry.env = raw.env as Record<string, string>
    }
    if (typeof raw.cwd === "string") entry.cwd = raw.cwd
    return entry
  }

  throw new Error("Unsupported MCP config: need command or url")
}

function isSafeId(id: string): boolean {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) return false
  return /^[\w\-@.]+$/.test(id)
}

function escapeJsonValue(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

export function substituteParams(template: string, params: Record<string, unknown>): string {
  let result = template
  for (const [key, value] of Object.entries(params)) {
    if (key === "__method") continue
    const escaped = escapeJsonValue(String(value ?? ""))
    result = result.replaceAll(`{{${key}}}`, escaped)
    result = result.replaceAll(`\${${key}}`, escaped)
  }
  return result
}

async function findEscapedPaths(dir: string): Promise<string[]> {
  const resolved = path.resolve(dir)
  const escaped: string[] = []

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.resolve(current, entry.name)
      if (!full.startsWith(resolved + path.sep) && full !== resolved) {
        escaped.push(full)
        continue
      }
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(full)
        if (!target.startsWith(resolved + path.sep) && target !== resolved) {
          escaped.push(full)
          continue
        }
      }
      if (entry.isDirectory()) {
        await walk(full)
      }
    }
  }

  await walk(dir)
  return escaped
}
