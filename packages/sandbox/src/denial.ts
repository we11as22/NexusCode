import type { SandboxKind } from "./types.js"

const DENIED_KEYWORDS = [
  "operation not permitted",
  "permission denied",
  "read-only file system",
  "seccomp",
  "sandbox",
  "landlock",
  "failed to write file",
] as const

export function isLikelySandboxDenied(input: {
  sandbox: SandboxKind
  exitCode: number
  stdout: string
  stderr: string
  aggregatedOutput?: string
  platform?: NodeJS.Platform
}): boolean {
  if (input.sandbox === "none" || input.exitCode === 0) return false
  const text = `${input.stderr}\n${input.stdout}\n${input.aggregatedOutput ?? ""}`.toLowerCase()
  if (DENIED_KEYWORDS.some((keyword) => text.includes(keyword))) return true
  if ([2, 126, 127].includes(input.exitCode)) return false
  return (
    (input.platform ?? process.platform) === "linux" &&
    input.sandbox === "bwrap-seccomp" &&
    input.exitCode === 128 + 31
  )
}
