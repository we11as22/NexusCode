import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"

export interface ProjectInfo {
  root: string
  hash: string
  lastAccessed: number
  indexDir: string
}

const REGISTRY_PATH = path.join(os.homedir(), ".nexus", "projects.json")
const INDEX_BASE_DIR = path.join(os.homedir(), ".nexus", "index")
const MAX_PROJECTS = 10 // LRU eviction after this

/**
 * Project registry for multi-project support.
 * Assigns a unique hash-based index directory to each project root.
 */
export class ProjectRegistry {
  private projects: Map<string, ProjectInfo> = new Map()

  static async load(): Promise<ProjectRegistry> {
    const registry = new ProjectRegistry()
    try {
      const content = await fs.readFile(REGISTRY_PATH, "utf8")
      const data = JSON.parse(content) as ProjectInfo[]
      for (const p of data) {
        registry.projects.set(p.root, p)
      }
    } catch {}
    return registry
  }

  async registerProject(root: string): Promise<ProjectInfo> {
    const existing = this.projects.get(root)
    if (existing) {
      existing.lastAccessed = Date.now()
      await this.save()
      return existing
    }

    const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 16)
    const indexDir = path.join(INDEX_BASE_DIR, hash)
    await fs.mkdir(indexDir, { recursive: true })

    const info: ProjectInfo = {
      root,
      hash,
      lastAccessed: Date.now(),
      indexDir,
    }

    this.projects.set(root, info)

    // LRU eviction
    if (this.projects.size > MAX_PROJECTS) {
      await this.evictOldest()
    }

    await this.save()
    return info
  }

  getProject(root: string): ProjectInfo | undefined {
    return this.projects.get(root)
  }

  listProjects(): ProjectInfo[] {
    return Array.from(this.projects.values())
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
  }

  async removeProject(root: string): Promise<void> {
    const info = this.projects.get(root)
    if (info) {
      try {
        await fs.rm(info.indexDir, { recursive: true, force: true })
      } catch {}
      this.projects.delete(root)
      await this.save()
    }
  }

  private async evictOldest(): Promise<void> {
    const sorted = this.listProjects()
    const toEvict = sorted.slice(MAX_PROJECTS)
    for (const p of toEvict) {
      await this.removeProject(p.root)
    }
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(REGISTRY_PATH)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(REGISTRY_PATH, JSON.stringify(this.listProjects(), null, 2), "utf8")
    } catch {}
  }
}

export function getIndexDir(projectRoot: string): string {
  const hash = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 16)
  return path.join(INDEX_BASE_DIR, hash)
}
