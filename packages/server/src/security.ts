import { timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export interface ServerSecurityOptions {
  token: string
  allowedOrigins: readonly string[]
  workspaceRoots: readonly string[]
}

export interface ServerVariables {
  security: ServerSecurityOptions
  workspaceRoot: string
}

export type ServerEnv = {
  Variables: ServerVariables
}

export function authorizeBearer(
  header: string | undefined,
  token: string,
): boolean {
  if (!header || !token || !header.startsWith("Bearer ")) return false
  const supplied = header.slice("Bearer ".length)
  if (!supplied || supplied.trim() !== supplied) return false

  const suppliedBuffer = Buffer.from(supplied)
  const expectedBuffer = Buffer.from(token)
  if (suppliedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(suppliedBuffer, expectedBuffer)
}

export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true
  return allowedOrigins.includes(origin)
}

function canonicalizePotentialPath(input: string): string {
  const absolute = path.resolve(input)
  let cursor = absolute
  const missingSegments: string[] = []

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      throw new Error(`Workspace path cannot be resolved: ${input}`)
    }
    missingSegments.unshift(path.basename(cursor))
    cursor = parent
  }

  const existing = fs.realpathSync.native(cursor)
  return path.resolve(existing, ...missingSegments)
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

export function resolveWorkspaceRoot(
  requested: string,
  allowedRoots: readonly string[],
): string {
  if (allowedRoots.length === 0) {
    throw new Error("Server workspace root allowlist is empty")
  }
  if (!requested.trim()) {
    throw new Error("A workspace directory is required")
  }

  const candidate = canonicalizePotentialPath(requested)
  const roots = allowedRoots.map((root) => canonicalizePotentialPath(root))
  if (!roots.some((root) => isWithinRoot(candidate, root))) {
    throw new Error(`Requested workspace is outside the configured roots: ${requested}`)
  }
  return candidate
}

export function readServerSecurityOptions(
  environment: NodeJS.ProcessEnv = process.env,
): ServerSecurityOptions {
  const token = environment.NEXUS_SERVER_TOKEN?.trim() ?? ""
  if (!token) {
    throw new Error(
      "NEXUS_SERVER_TOKEN is required (or start nexus-serve with --generate-local-token)",
    )
  }

  const workspaceRoots = (environment.NEXUS_SERVER_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (workspaceRoots.length === 0) {
    throw new Error("NEXUS_SERVER_ROOTS must contain at least one allowed workspace")
  }

  const allowedOrigins = (environment.NEXUS_SERVER_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)

  return {
    token,
    workspaceRoots,
    allowedOrigins,
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
}
