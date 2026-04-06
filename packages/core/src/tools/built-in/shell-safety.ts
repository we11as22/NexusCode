const FILE_DISCOVERY_COMMANDS = new Set([
  "find",
  "fd",
  "ls",
  "tree",
])

const CONTENT_SEARCH_COMMANDS = new Set([
  "grep",
  "rg",
  "ag",
  "ack",
])

const FILE_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
])

const FILE_EDIT_COMMANDS = new Set([
  "sed",
  "awk",
  "perl",
])

const LONG_RUNNING_PREFIXES = [
  "npm run dev",
  "npm run start",
  "npm run watch",
  "pnpm dev",
  "pnpm start",
  "pnpm watch",
  "yarn dev",
  "yarn start",
  "yarn watch",
  "next dev",
  "vite",
  "webpack --watch",
  "rollup --watch",
  "cargo watch",
  "docker compose up",
  "docker-compose up",
  "kubectl logs -f",
  "tail -f",
]

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\brm\s+-rf\s+\/($|\s)/i, message: "Refusing destructive root deletion command." },
  { pattern: /\bgit\s+reset\s+--hard\b/i, message: "Destructive git reset detected." },
  { pattern: /\bgit\s+clean\s+-f[d|x]*\b/i, message: "Destructive git clean detected." },
  { pattern: /\bmkfs(\.\w+)?\b/i, message: "Disk formatting command detected." },
  { pattern: /\bdd\s+.*\bof=/i, message: "Raw disk or file overwrite command detected." },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, message: "Host shutdown command detected." },
]

export type ShellRunner = "bash" | "powershell"

export function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim()
}

function firstToken(command: string): string {
  const normalized = normalizeShellCommand(command)
  return normalized.split(/\s+/)[0]?.toLowerCase() ?? ""
}

export function detectDangerousShellPattern(command: string): string | null {
  const normalized = normalizeShellCommand(command)
  for (const item of DANGEROUS_PATTERNS) {
    if (item.pattern.test(normalized)) return item.message
  }
  return null
}

export function detectPreferDedicatedToolMessage(command: string): string | null {
  const normalized = normalizeShellCommand(command)
  const token = firstToken(normalized)
  if (!token) return null

  if (FILE_DISCOVERY_COMMANDS.has(token)) {
    return "Use List or Glob instead of shell commands for file discovery."
  }
  if (CONTENT_SEARCH_COMMANDS.has(token)) {
    return "Use Grep instead of shell commands for content search."
  }
  if (FILE_READ_COMMANDS.has(token)) {
    return "Use Read instead of shell commands for reading file contents."
  }
  if (FILE_EDIT_COMMANDS.has(token)) {
    return "Use Edit instead of shell commands for in-place file edits."
  }
  if ((token === "echo" || token === "printf") && />|>>/.test(normalized)) {
    return "Use Write instead of shell redirection to create or overwrite files."
  }
  return null
}

export function detectBlockedSleepPattern(command: string, shellRunner: ShellRunner): string | null {
  const normalized = normalizeShellCommand(command)
  if (!normalized) return null
  if (shellRunner === "powershell") {
    const firstStatement = normalized.split(/[;|&\r\n]/)[0]?.trim() ?? ""
    const match = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\b/i.exec(firstStatement)
    if (!match) return null
    const secs = parseInt(match[1]!, 10)
    return secs >= 2 ? `Standalone sleep command detected (${secs}s).` : null
  }
  const firstStatement = normalized.split(/[;&|\r\n]/)[0]?.trim() ?? ""
  const match = /^(?:sleep)\s+(\d+)\b/i.exec(firstStatement)
  if (!match) return null
  const secs = parseInt(match[1]!, 10)
  return secs >= 2 ? `Standalone sleep command detected (${secs}s).` : null
}

export function isLikelyLongRunningShellCommand(command: string): boolean {
  const normalized = normalizeShellCommand(command).toLowerCase()
  if (!normalized) return false
  if (LONG_RUNNING_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  return /\b(--watch|-f|follow|serve|server|dev)\b/.test(normalized)
}
