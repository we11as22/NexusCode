import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execa } from "execa"

export interface ParsedGithubBlob {
  owner: string
  repo: string
  ref: string
  pathInRepo: string
  codeloadUrl: string
}

/** `https://github.com/owner/repo/blob/ref/path/to/skill-dir` */
export function parseGithubBlobUrl(url: string): ParsedGithubBlob | null {
  const m = url
    .trim()
    .match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (!m) return null
  const [, owner, repo, ref, pathInRepo] = m
  return {
    owner,
    repo,
    ref,
    pathInRepo: pathInRepo.replace(/\/$/, ""),
    codeloadUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
  }
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

/**
 * Download repo tarball, extract skill folder matching GitHub blob path, copy to `destDir`.
 */
export async function extractGithubSkillFromBlobUrl(blobUrl: string, destDir: string): Promise<void> {
  const parsed = parseGithubBlobUrl(blobUrl)
  if (!parsed) {
    throw new Error("Skill URL must be a github.com/.../blob/... link")
  }

  const stamp = Date.now()
  const tarball = path.join(os.tmpdir(), `nexus-skillnet-${parsed.owner}-${parsed.repo}-${stamp}.tar.gz`)
  const staging = path.join(os.tmpdir(), `nexus-skillnet-staging-${stamp}`)

  try {
    const response = await fetch(parsed.codeloadUrl)
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(tarball, buffer)

    await fs.mkdir(staging, { recursive: true })
    const tarResult = await execa("tar", ["-xzf", tarball, "-C", staging], { reject: false })
    if (tarResult.exitCode !== 0) {
      throw new Error(tarResult.stderr || `tar exited ${tarResult.exitCode}`)
    }

    const topEntries = await fs.readdir(staging, { withFileTypes: true })
    const topDirs = topEntries.filter((e) => e.isDirectory())
    if (topDirs.length !== 1) {
      throw new Error("Unexpected archive layout (expected one top-level folder)")
    }
    const top = path.join(staging, topDirs[0]!.name)

    const segments = parsed.pathInRepo.split("/").filter(Boolean)
    let skillPath = path.join(top, ...segments)
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      stat = await fs.stat(skillPath)
    } catch {
      stat = null
    }
    if (stat?.isFile()) {
      skillPath = path.dirname(skillPath)
    }

    try {
      await fs.access(path.join(skillPath, "SKILL.md"))
    } catch {
      throw new Error("Could not find SKILL.md for this path (wrong URL or not a skill folder)")
    }

    const escaped = await findEscapedPaths(skillPath)
    if (escaped.length > 0) {
      throw new Error("Skill folder contains unsafe paths")
    }

    await fs.mkdir(path.dirname(destDir), { recursive: true })
    await fs.cp(skillPath, destDir, { recursive: true })
  } finally {
    try {
      await fs.unlink(tarball)
    } catch {
      /* */
    }
    try {
      await fs.rm(staging, { recursive: true })
    } catch {
      /* */
    }
  }
}
