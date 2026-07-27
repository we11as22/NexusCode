import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import {
  extractGithubSkillFromBlobUrl,
  parseGithubBlobUrl,
} from "./services/marketplace/github-skill.js"
import { MarketplaceInstaller } from "./services/marketplace/installer.js"
import { MarketplacePaths } from "./services/marketplace/paths.js"
import {
  DEFAULT_SAFE_ARCHIVE_LIMITS,
  extractArchivePlanAtomically,
  preflightTarGzArchive,
  readResponseBodyWithLimit,
  selectArchiveSubtree,
  type SafeArchivePlan,
} from "./services/marketplace/safe-archive.js"
import type { SkillMarketplaceItem } from "./services/marketplace/types.js"

interface TarFixtureEntry {
  name: string
  type?: string
  body?: string | Buffer
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8")
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, "0")
  header.write(encoded, offset, length - 2, "ascii")
  header[offset + length - 2] = 0
  header[offset + length - 1] = 0x20
}

function tarGz(entries: TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body)
      ? entry.body
      : Buffer.from(entry.body ?? "", "utf8")
    const header = Buffer.alloc(512)
    writeTarString(header, 0, 100, entry.name)
    writeTarOctal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, body.length)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = (entry.type ?? "0").charCodeAt(0)
    writeTarString(header, 257, 6, "ustar")
    writeTarString(header, 263, 2, "00")
    writeTarOctal(
      header,
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    )
    parts.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function paxRecord(key: string, value: string): string {
  const payload = `${key}=${value}\n`
  let length = Buffer.byteLength(payload) + 2
  for (;;) {
    const nextLength = Buffer.byteLength(payload) + String(length).length + 1
    if (nextLength === length) return `${length} ${payload}`
    length = nextLength
  }
}

describe("parseGithubBlobUrl", () => {
  it("parses a normal GitHub skill directory", () => {
    expect(
      parseGithubBlobUrl(
        "https://github.com/example/skills/blob/main/catalog/code-review/",
      ),
    ).toEqual({
      owner: "example",
      repo: "skills",
      ref: "main",
      pathInRepo: "catalog/code-review",
      codeloadUrl: "https://codeload.github.com/example/skills/tar.gz/main",
    })
  })

  it.each([
    "https://github.com/example/skills/blob/main/../secrets",
    "https://github.com/example/skills/blob/main/%2e%2e/secrets",
    "https://github.com/example/skills/blob/main/%252e%252e/secrets",
    "https://github.com/example/skills/blob/main/catalog%2f..%2fsecrets",
    "https://github.com/example/skills/blob/main/catalog%5c..%5csecrets",
    "https://github.com/example/skills/blob/main//absolute",
  ])("rejects unsafe or encoded repository paths: %s", (url) => {
    expect(parseGithubBlobUrl(url)).toBeNull()
  })
})

describe("GitHub skill archive installation", () => {
  it("applies the bounded downloader before extracting a repository archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-github-skill-limit-"))
    const destination = path.join(root, "installed")
    const archive = tarGz([{ name: "repo/catalog/review/SKILL.md", body: "# Review" }])
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(archive, {
        headers: { "content-length": String(archive.length) },
      })
    try {
      await expect(
        extractGithubSkillFromBlobUrl(
          "https://github.com/example/skills/blob/main/catalog/review",
          destination,
          { limits: { maxDownloadBytes: 5 } },
        ),
      ).rejects.toThrow(/download.*5 bytes/i)
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
  })

  it("publishes only the selected safe skill subtree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-github-skill-safe-"))
    const destination = path.join(root, "installed")
    const archive = tarGz([
      { name: "repo/catalog/review/SKILL.md", body: "# Review" },
      { name: "repo/catalog/review/reference.md", body: "Reference" },
      { name: "repo/catalog/other/SKILL.md", body: "# Other" },
    ])
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(archive)
    try {
      await extractGithubSkillFromBlobUrl(
        "https://github.com/example/skills/blob/main/catalog/review",
        destination,
      )

      await expect(readFile(path.join(destination, "SKILL.md"), "utf8")).resolves.toBe(
        "# Review",
      )
      await expect(lstat(path.join(destination, "catalog", "other"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("marketplace skill installation", () => {
  it("rejects an oversized direct archive before invoking extraction", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-limit-"))
    const archive = tarGz([{ name: "repo/SKILL.md", body: "# Review" }])
    const item: SkillMarketplaceItem = {
      id: "review",
      name: "Review",
      description: "Review skill",
      type: "skill",
      category: "development",
      githubUrl: "https://github.com/example/skills",
      content: "https://downloads.example.test/review.tar.gz",
      displayName: "Review",
      displayCategory: "Development",
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(archive, {
        headers: {
          "content-length": String(DEFAULT_SAFE_ARCHIVE_LIMITS.maxDownloadBytes + 1),
        },
      })
    try {
      const result = await new MarketplaceInstaller(new MarketplacePaths()).installSkill(
        item,
        "project",
        workspace,
      )

      expect(result).toMatchObject({ success: false, slug: "review" })
      expect(result.error).toMatch(/download.*maximum/i)
      await expect(
        lstat(path.join(workspace, ".nexus", "skills", "review")),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("installs a safe direct archive without a system tar process", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-safe-"))
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Review" },
      { name: "repo/references/guide.md", body: "Guide" },
    ])
    const item: SkillMarketplaceItem = {
      id: "review",
      name: "Review",
      description: "Review skill",
      type: "skill",
      category: "development",
      githubUrl: "https://github.com/example/skills",
      content: "https://downloads.example.test/review.tar.gz",
      displayName: "Review",
      displayCategory: "Development",
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(archive)
    try {
      const result = await new MarketplaceInstaller(new MarketplacePaths()).installSkill(
        item,
        "project",
        workspace,
      )

      expect(result).toMatchObject({ success: true, slug: "review", line: 1 })
      await expect(
        readFile(path.join(workspace, ".nexus", "skills", "review", "SKILL.md"), "utf8"),
      ).resolves.toBe("# Review")
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("does not create a destination or escaped file for an unsafe direct archive", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-traversal-"))
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Review" },
      { name: "repo/../../escaped.txt", body: "owned" },
    ])
    const item: SkillMarketplaceItem = {
      id: "review",
      name: "Review",
      description: "Review skill",
      type: "skill",
      category: "development",
      githubUrl: "https://github.com/example/skills",
      content: "https://downloads.example.test/review.tar.gz",
      displayName: "Review",
      displayCategory: "Development",
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(archive)
    try {
      const result = await new MarketplaceInstaller(new MarketplacePaths()).installSkill(
        item,
        "project",
        workspace,
      )

      expect(result).toMatchObject({ success: false, slug: "review" })
      await expect(
        lstat(path.join(workspace, ".nexus", "skills", "review")),
      ).rejects.toMatchObject({ code: "ENOENT" })
      await expect(lstat(path.join(workspace, "escaped.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("preserves a concurrently-created GitHub skill when atomic publication loses the race", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-race-"))
    const destination = path.join(workspace, ".nexus", "skills", "review")
    const archive = tarGz([{ name: "repo/catalog/review/SKILL.md", body: "# Incoming" }])
    const item: SkillMarketplaceItem = {
      id: "review",
      name: "Review",
      description: "Review skill",
      type: "skill",
      category: "development",
      githubUrl: "https://github.com/example/skills",
      content: "",
      displayName: "Review",
      displayCategory: "Development",
      skillInstall: {
        kind: "github_blob",
        url: "https://github.com/example/skills/blob/main/catalog/review",
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      await mkdir(destination, { recursive: true })
      await writeFile(path.join(destination, "keep.txt"), "concurrent install")
      return new Response(archive)
    }
    try {
      const result = await new MarketplaceInstaller(new MarketplacePaths()).installSkill(
        item,
        "project",
        workspace,
      )

      expect(result).toMatchObject({ success: false, slug: "review" })
      await expect(readFile(path.join(destination, "keep.txt"), "utf8")).resolves.toBe(
        "concurrent install",
      )
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("refuses to stage through a project skills-directory symlink", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-link-root-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-outside-"))
    const archive = tarGz([{ name: "repo/SKILL.md", body: "# Safe" }])
    const item: SkillMarketplaceItem = {
      id: "review",
      name: "Review",
      description: "Review skill",
      type: "skill",
      category: "development",
      githubUrl: "https://github.com/example/skills",
      content: "https://downloads.example.test/review.tar.gz",
      displayName: "Review",
      displayCategory: "Development",
    }
    await mkdir(path.join(workspace, ".nexus"))
    await symlink(outside, path.join(workspace, ".nexus", "skills"))
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(archive)
    try {
      const result = await new MarketplaceInstaller(new MarketplacePaths()).installSkill(
        item,
        "project",
        workspace,
      )

      expect(result).toMatchObject({ success: false, slug: "review" })
      expect(result.error).toMatch(/unsafe|symbolic link|symlink/i)
      await expect(lstat(path.join(outside, "review"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("refuses to create a skills directory through a project .nexus symlink", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-link-parent-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "nexus-marketplace-parent-outside-"))
    const archive = tarGz([{ name: "repo/SKILL.md", body: "# Safe" }])
    const item: SkillMarketplaceItem = {
      id: "review",
      name: "Review",
      description: "Review skill",
      type: "skill",
      category: "development",
      githubUrl: "https://github.com/example/skills",
      content: "https://downloads.example.test/review.tar.gz",
      displayName: "Review",
      displayCategory: "Development",
    }
    await symlink(outside, path.join(workspace, ".nexus"))
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(archive)
    try {
      const result = await new MarketplaceInstaller(new MarketplacePaths()).installSkill(
        item,
        "project",
        workspace,
      )

      expect(result).toMatchObject({ success: false, slug: "review" })
      expect(result.error).toMatch(/unsafe|symbolic link|symlink|outside/i)
      await expect(lstat(path.join(outside, "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("safe marketplace archives", () => {
  it("rejects a declared download larger than the compressed-byte limit", async () => {
    const response = new Response("123456", {
      headers: { "content-length": "6" },
    })

    await expect(readResponseBodyWithLimit(response, 5)).rejects.toThrow(
      /download.*5 bytes/i,
    )
  })

  it("enforces the compressed-byte limit while streaming without Content-Length", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("123"))
          controller.enqueue(Buffer.from("456"))
          controller.close()
        },
      }),
    )

    await expect(readResponseBodyWithLimit(response, 5)).rejects.toThrow(
      /download.*5 bytes/i,
    )
  })

  it("returns a bounded response body without a live network request", async () => {
    const response = new Response("archive")

    await expect(readResponseBodyWithLimit(response, 7)).resolves.toEqual(
      Buffer.from("archive"),
    )
  })

  it("rejects traversal before any extraction can happen", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: "repo/../../escaped.txt", body: "owned" },
    ])

    await expect(preflightTarGzArchive(archive)).rejects.toThrow(/unsafe.*path|traversal/i)
  })

  it.each([
    "/absolute/SKILL.md",
    "C:/absolute/SKILL.md",
    "repo\\escaped\\SKILL.md",
  ])("rejects absolute or platform-ambiguous paths: %s", async (unsafePath) => {
    await expect(
      preflightTarGzArchive(tarGz([{ name: unsafePath, body: "# Unsafe" }])),
    ).rejects.toThrow(/unsafe.*path/i)
  })

  it.each([
    "repo/CON",
    "repo/file:stream",
    "repo/trailing.",
  ])("rejects non-portable filesystem paths: %s", async (unsafePath) => {
    await expect(
      preflightTarGzArchive(tarGz([
        { name: "repo/SKILL.md", body: "# Safe" },
        { name: unsafePath, body: "unsafe" },
      ])),
    ).rejects.toThrow(/unsafe|non-portable|segment/i)
  })

  it("rejects an overlong path component supplied through metadata", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      {
        name: "metadata",
        type: "x",
        body: paxRecord("path", `repo/${"x".repeat(256)}`),
      },
      { name: "repo/placeholder", body: "unsafe" },
    ])

    await expect(preflightTarGzArchive(archive)).rejects.toThrow(/segment.*255 bytes/i)
  })

  it.each([
    ["hard link", "1"],
    ["symbolic link", "2"],
    ["character device", "3"],
    ["block device", "4"],
    ["fifo", "6"],
    ["special contiguous file", "7"],
  ])("rejects %s entries during preflight", async (_label, type) => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: "repo/unsafe", type },
    ])

    await expect(preflightTarGzArchive(archive)).rejects.toThrow(/unsupported.*type/i)
  })

  it("accepts Git-style PAX global metadata without materializing it", async () => {
    const archive = tarGz([
      {
        name: "pax_global_header",
        type: "g",
        body: paxRecord("comment", "0123456789abcdef"),
      },
      { name: "repo/SKILL.md", body: "# Safe" },
    ])

    await expect(preflightTarGzArchive(archive)).resolves.toEqual({
      entries: [
        {
          path: "SKILL.md",
          kind: "file",
          data: Buffer.from("# Safe"),
          mode: 0o644,
        },
      ],
    })
  })

  it.each([
    ["PAX", "x", paxRecord("path", `repo/${"nested/".repeat(15)}guide.md`)],
    ["GNU", "L", `repo/${"nested/".repeat(15)}guide.md\0`],
  ])("accepts a safe %s long path after validating the metadata", async (_label, type, body) => {
    const expectedPath = `${"nested/".repeat(15)}guide.md`
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: "metadata", type, body },
      { name: "repo/placeholder", body: "Guide" },
    ])

    await expect(preflightTarGzArchive(archive)).resolves.toEqual({
      entries: [
        {
          path: "SKILL.md",
          kind: "file",
          data: Buffer.from("# Safe"),
          mode: 0o644,
        },
        {
          path: expectedPath,
          kind: "file",
          data: Buffer.from("Guide"),
          mode: 0o644,
        },
      ],
    })
  })

  it("rejects traversal supplied through PAX path metadata", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: "metadata", type: "x", body: paxRecord("path", "repo/../../escaped") },
      { name: "repo/placeholder", body: "owned" },
    ])

    await expect(preflightTarGzArchive(archive)).rejects.toThrow(/traversal|unsafe.*path/i)
  })

  it("bounds archive entry count", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: "repo/extra.txt", body: "x" },
    ])

    await expect(
      preflightTarGzArchive(archive, { maxEntries: 1 }),
    ).rejects.toThrow(/entry count.*1/i)
  })

  it("bounds each extracted file", async () => {
    const archive = tarGz([{ name: "repo/SKILL.md", body: "1234" }])

    await expect(
      preflightTarGzArchive(archive, { maxFileBytes: 3 }),
    ).rejects.toThrow(/file.*3 bytes/i)
  })

  it("bounds total extracted file bytes", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "1234" },
      { name: "repo/extra.txt", body: "5678" },
    ])

    await expect(
      preflightTarGzArchive(archive, { maxTotalFileBytes: 7 }),
    ).rejects.toThrow(/total.*7 bytes/i)
  })

  it("bounds archive path length", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: `repo/${"nested".repeat(8)}.txt`, body: "x" },
    ])

    await expect(
      preflightTarGzArchive(archive, { maxPathBytes: 24 }),
    ).rejects.toThrow(/path.*24 bytes/i)
  })

  it("bounds the expanded tar stream before parsing it", async () => {
    const archive = tarGz([{ name: "repo/SKILL.md", body: "x".repeat(2048) }])

    await expect(
      preflightTarGzArchive(archive, { maxExpandedArchiveBytes: 1024 }),
    ).rejects.toThrow(/expanded archive.*1024 bytes/i)
  })

  it("rechecks the compressed-byte limit at the preflight boundary", async () => {
    const archive = tarGz([{ name: "repo/SKILL.md", body: "# Safe" }])

    await expect(
      preflightTarGzArchive(archive, { maxDownloadBytes: archive.length - 1 }),
    ).rejects.toThrow(/compressed archive.*bytes/i)
  })

  it("rejects a tar header whose checksum does not match its contents", async () => {
    const unpacked = gunzipSync(
      tarGz([{ name: "repo/SKILL.md", body: "# Safe" }]),
    )
    unpacked[0] = "x".charCodeAt(0)

    await expect(preflightTarGzArchive(gzipSync(unpacked))).rejects.toThrow(/checksum/i)
  })

  it("rejects duplicate paths before starting extraction", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# First" },
      { name: "repo/SKILL.md", body: "# Second" },
    ])

    await expect(preflightTarGzArchive(archive)).rejects.toThrow(/duplicate path/i)
  })

  it("rejects case-folded path collisions that alias on common filesystems", async () => {
    const archive = tarGz([
      { name: "repo/SKILL.md", body: "# Safe" },
      { name: "repo/Readme.md", body: "first" },
      { name: "repo/README.md", body: "second" },
    ])

    await expect(preflightTarGzArchive(archive)).rejects.toThrow(
      /platform-ambiguous paths/i,
    )
  })

  it("rejects an archive without the tar end marker", async () => {
    const unpacked = gunzipSync(
      tarGz([{ name: "repo/SKILL.md", body: "# Safe" }]),
    )
    const withoutEndMarker = unpacked.subarray(0, unpacked.length - 1024)

    await expect(
      preflightTarGzArchive(gzipSync(withoutEndMarker)),
    ).rejects.toThrow(/end marker|truncated/i)
  })

  it("extracts a validated plan through private staging and atomically publishes it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-safe-archive-"))
    const destination = path.join(root, "installed-skill")
    try {
      const plan = await preflightTarGzArchive(
        tarGz([
          { name: "repo/SKILL.md", body: "# Installed" },
          { name: "repo/scripts/", type: "5" },
          { name: "repo/scripts/run.sh", body: "#!/bin/sh\n" },
        ]),
      )

      await extractArchivePlanAtomically(plan, destination)

      await expect(readFile(path.join(destination, "SKILL.md"), "utf8")).resolves.toBe(
        "# Installed",
      )
      expect((await lstat(path.join(destination, "scripts", "run.sh"))).isSymbolicLink()).toBe(
        false,
      )
      expect((await readdir(root)).filter((name) => name.includes(".staging-"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("never overwrites an existing destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-safe-archive-existing-"))
    const destination = path.join(root, "installed-skill")
    try {
      await mkdir(destination)
      await writeFile(path.join(destination, "keep.txt"), "original")
      const plan = await preflightTarGzArchive(
        tarGz([{ name: "repo/SKILL.md", body: "# Replacement" }]),
      )

      await expect(extractArchivePlanAtomically(plan, destination)).rejects.toThrow(
        /already exists/i,
      )

      await expect(readFile(path.join(destination, "keep.txt"), "utf8")).resolves.toBe(
        "original",
      )
      expect((await readdir(root)).filter((name) => name.includes(".staging-"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("defensively rejects an unsafe extraction plan before creating files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-safe-archive-plan-"))
    const destination = path.join(root, "installed-skill")
    const plan: SafeArchivePlan = {
      entries: [
        {
          path: "../escaped.txt",
          kind: "file",
          data: Buffer.from("owned"),
          mode: 0o644,
        },
      ],
    }
    try {
      await expect(extractArchivePlanAtomically(plan, destination)).rejects.toThrow(
        /unsafe|traversal/i,
      )
      await expect(lstat(path.join(root, "escaped.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["catalog/review", "catalog/review/SKILL.md"])(
    "selects only the requested GitHub skill subtree: %s",
    async (pathInRepo) => {
      const repository = await preflightTarGzArchive(
        tarGz([
          { name: "repo/catalog/review/SKILL.md", body: "# Review" },
          { name: "repo/catalog/review/references/checklist.md", body: "Checklist" },
          { name: "repo/catalog/other/SKILL.md", body: "# Other" },
        ]),
      )

      expect(selectArchiveSubtree(repository, pathInRepo)).toEqual({
        entries: [
          {
            path: "SKILL.md",
            kind: "file",
            data: Buffer.from("# Review"),
            mode: 0o644,
          },
          {
            path: "references/checklist.md",
            kind: "file",
            data: Buffer.from("Checklist"),
            mode: 0o644,
          },
        ],
      })
    },
  )

  it("rejects a GitHub subtree without a root SKILL.md", async () => {
    const repository = await preflightTarGzArchive(
      tarGz([{ name: "repo/catalog/not-a-skill/readme.md", body: "No skill" }]),
    )

    expect(() => selectArchiveSubtree(repository, "catalog/not-a-skill")).toThrow(
      /missing SKILL\.md/i,
    )
  })
})
