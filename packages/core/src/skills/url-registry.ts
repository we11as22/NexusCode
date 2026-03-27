/**
 * Remote skill registries: base URL serves index.json listing skill packs; files are cached under ~/.nexus/cache/skills/.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

type SkillIndex = {
  skills: Array<{ name?: string; files?: string[] }>
}

function cacheRoot(): string {
  return path.join(os.homedir(), ".nexus", "cache", "skills")
}

/**
 * Download registry from `baseUrl` (append index.json), return directories under cache that contain SKILL.md.
 */
export async function fetchSkillUrlRegistryRoots(baseUrl: string): Promise<string[]> {
  const result: string[] = []
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const indexHref = new URL("index.json", base).href
  const host = base.slice(0, -1)

  let data: SkillIndex | undefined
  try {
    const res = await fetch(indexHref)
    if (!res.ok) return result
    data = (await res.json()) as SkillIndex
  } catch {
    return result
  }

  if (!data?.skills || !Array.isArray(data.skills)) return result
  const list = data.skills.filter((s) => s?.name && Array.isArray(s.files))
  const cache = cacheRoot()
  await fs.mkdir(cache, { recursive: true })

  for (const skill of list) {
    const skillName = String(skill.name)
    const root = path.join(cache, skillName)
    for (const file of skill.files!) {
      const link = new URL(file, `${host}/${skillName}/`).href
      const dest = path.join(root, file)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      try {
        await fs.access(dest)
        continue
      } catch {
        /* fetch */
      }
      try {
        const r = await fetch(link)
        if (!r.ok) continue
        await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()))
      } catch {
        /* */
      }
    }
    const md = path.join(root, "SKILL.md")
    try {
      await fs.access(md)
      result.push(root)
    } catch {
      /* */
    }
  }
  return result
}
