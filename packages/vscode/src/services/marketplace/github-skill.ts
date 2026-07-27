import {
  DEFAULT_SAFE_ARCHIVE_LIMITS,
  extractArchivePlanAtomically,
  preflightTarGzArchive,
  readResponseBodyWithLimit,
  selectArchiveSubtree,
  type SafeArchiveLimits,
} from "./safe-archive.js"

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
  const [, rawOwner, rawRepo, rawRef, rawPathInRepo] = m
  const owner = decodeSafeUrlSegment(rawOwner)
  const repo = decodeSafeUrlSegment(rawRepo)
  const ref = decodeSafeUrlSegment(rawRef)
  const pathInRepo = decodeSafeRepoPath(rawPathInRepo)
  if (!owner || !repo || !ref || !pathInRepo) return null
  return {
    owner,
    repo,
    ref,
    pathInRepo,
    codeloadUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
  }
}

function repeatedlyDecodeUrlComponent(value: string): string | null {
  let decoded = value
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return decoded
      decoded = next
    }
  } catch {
    return null
  }
  return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded
}

function decodeSafeUrlSegment(value: string): string | null {
  const decoded = repeatedlyDecodeUrlComponent(value)
  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    return null
  }
  return decoded
}

function decodeSafeRepoPath(value: string): string | null {
  const decoded = repeatedlyDecodeUrlComponent(value)
  if (!decoded || decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return null
  }
  const segments = decoded.replace(/\/$/, "").split("/")
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null
  }
  return segments.join("/")
}

export interface GithubSkillExtractionOptions {
  limits?: Partial<SafeArchiveLimits>
  containmentRoot?: string
}

/**
 * Download repo tarball, extract skill folder matching GitHub blob path, copy to `destDir`.
 */
export async function extractGithubSkillFromBlobUrl(
  blobUrl: string,
  destDir: string,
  options: GithubSkillExtractionOptions = {},
): Promise<void> {
  const parsed = parseGithubBlobUrl(blobUrl)
  if (!parsed) {
    throw new Error("Skill URL must be a github.com/.../blob/... link")
  }

  const response = await fetch(parsed.codeloadUrl)
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }
  const archive = await readResponseBodyWithLimit(
    response,
    options.limits?.maxDownloadBytes ?? DEFAULT_SAFE_ARCHIVE_LIMITS.maxDownloadBytes,
  )
  const repositoryPlan = await preflightTarGzArchive(archive, options.limits)
  const skillPlan = selectArchiveSubtree(repositoryPlan, parsed.pathInRepo)
  await extractArchivePlanAtomically(skillPlan, destDir, {
    containmentRoot: options.containmentRoot,
  })
}
