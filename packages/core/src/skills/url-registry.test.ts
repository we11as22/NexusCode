import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchSkillUrlRegistryRoots } from "./url-registry.js"

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function tempCache(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-skill-registry-"))
  roots.push(root)
  return root
}

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("fetchSkillUrlRegistryRoots", () => {
  it("rejects registry path traversal without writing outside its cache namespace", async () => {
    const cacheDirectory = await tempCache()
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith("/index.json")) {
        return response(JSON.stringify({
          skills: [
            { name: "../escaped-skill", files: ["SKILL.md"] },
            { name: "unsafe-pack", files: ["../escaped.txt", "SKILL.md"] },
            { name: "safe-pack", files: ["SKILL.md", "references/guide.md"] },
          ],
        }))
      }
      if (url.endsWith("/safe-pack/SKILL.md")) {
        return response("# Safe pack")
      }
      if (url.endsWith("/safe-pack/references/guide.md")) {
        return response("Safe reference")
      }
      throw new Error(`unexpected URL: ${url}`)
    })

    const result = await fetchSkillUrlRegistryRoots(
      "https://skills.example.test/catalog",
      { cacheDirectory, fetcher },
    )

    expect(result).toHaveLength(1)
    expect(path.basename(result[0]!)).toBe("safe-pack")
    expect(await readFile(path.join(result[0]!, "SKILL.md"), "utf8"))
      .toBe("# Safe pack")
    await expect(access(path.join(cacheDirectory, "escaped.txt"))).rejects.toThrow()
    expect(fetcher.mock.calls.map(([input]) => String(input)))
      .not.toContain("https://skills.example.test/escaped.txt")
  })

  it("bounds downloaded files and keeps a previously valid cached skill on refresh failure", async () => {
    const cacheDirectory = await tempCache()
    const baseUrl = "https://skills.example.test/catalog"
    const initialFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith("/index.json")) {
        return response(JSON.stringify({
          skills: [{ name: "stable", files: ["SKILL.md"] }],
        }))
      }
      return response("# Stable skill")
    })
    const initial = await fetchSkillUrlRegistryRoots(baseUrl, {
      cacheDirectory,
      fetcher: initialFetch,
      maxFileBytes: 64,
    })
    expect(initial).toHaveLength(1)

    const failedRefresh = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith("/index.json")) {
        return response(JSON.stringify({
          skills: [{ name: "stable", files: ["SKILL.md"] }],
        }))
      }
      return response("x".repeat(65))
    })
    const refreshed = await fetchSkillUrlRegistryRoots(baseUrl, {
      cacheDirectory,
      fetcher: failedRefresh,
      maxFileBytes: 64,
    })

    expect(refreshed).toEqual(initial)
    expect(await readFile(path.join(initial[0]!, "SKILL.md"), "utf8"))
      .toBe("# Stable skill")
  })

  it("cancels a chunked response as soon as its byte limit is exceeded", async () => {
    const cacheDirectory = await tempCache()
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 100) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array([120]))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetcher = vi.fn<typeof fetch>(async () => new Response(stream))

    const result = await fetchSkillUrlRegistryRoots(
      "https://skills.example.test/catalog",
      {
        cacheDirectory,
        fetcher,
        maxIndexBytes: 8,
      },
    )

    expect(result).toEqual([])
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(100)
  })

  it("isolates caches belonging to different registries", async () => {
    const cacheDirectory = await tempCache()
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith("/index.json")) {
        return response(JSON.stringify({
          skills: [{ name: "shared-name", files: ["SKILL.md"] }],
        }))
      }
      return response(url.includes("registry-a") ? "# Registry A" : "# Registry B")
    })

    const [a] = await fetchSkillUrlRegistryRoots("https://registry-a.test", {
      cacheDirectory,
      fetcher,
    })
    const [b] = await fetchSkillUrlRegistryRoots("https://registry-b.test", {
      cacheDirectory,
      fetcher,
    })

    expect(a).not.toBe(b)
    expect(await readFile(path.join(a!, "SKILL.md"), "utf8")).toBe("# Registry A")
    expect(await readFile(path.join(b!, "SKILL.md"), "utf8")).toBe("# Registry B")
  })

  it("rejects non-HTTP registry URLs and embedded credentials before fetching", async () => {
    const cacheDirectory = await tempCache()
    const fetcher = vi.fn<typeof fetch>()

    await expect(fetchSkillUrlRegistryRoots("file:///tmp/skills", {
      cacheDirectory,
      fetcher,
    })).rejects.toThrow(/https?/)
    await expect(fetchSkillUrlRegistryRoots("https://token@example.test/skills", {
      cacheDirectory,
      fetcher,
    })).rejects.toThrow(/credentials/)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
