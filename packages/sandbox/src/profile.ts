import * as path from "node:path"
import {
  NEXUS_SANDBOX_PROTOCOL_VERSION,
  type CreateSandboxRequestInput,
  type NativeSandboxRequest,
} from "./types.js"
import { sanitizeSandboxEnvironment } from "./environment.js"

const PROTECTED_METADATA = [".git", ".nexus", ".agents", ".codex"] as const

export function createSandboxRequest(
  input: CreateSandboxRequestInput,
): NativeSandboxRequest {
  const platform = input.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const cwd = normalizeAbsolute(input.cwd, pathApi, "cwd")
  const workspaceRoots = uniquePaths(
    input.workspaceRoots.map((root) =>
      normalizeAbsolute(root, pathApi, "workspace root"),
    ),
    platform,
  )
  const protectedRoots = uniquePaths(
    (input.protectedRoots ?? []).map((root) =>
      normalizeAbsolute(root, pathApi, "protected runtime root"),
    ),
    platform,
  )
  if (workspaceRoots.length === 0) {
    throw new Error("sandbox requires at least one workspace root")
  }
  if (!workspaceRoots.some((root) => containsPath(root, cwd, pathApi, platform))) {
    throw new Error(`sandbox cwd is outside workspace roots: ${cwd}`)
  }
  if (!input.executionId.trim() || input.executionId.length > 256) {
    throw new Error("sandbox executionId must be non-empty and at most 256 characters")
  }
  if (input.command.includes("\0")) {
    throw new Error("sandbox command contains NUL")
  }

  const tempDir = normalizeAbsolute(
    input.tempDir,
    pathApi,
    "temp directory",
  )
  const readableRoots =
    platform === "win32"
      ? uniquePaths(
          [cwd, ...workspaceRoots, ...protectedRoots, tempDir]
            .map((root) => path.win32.parse(root).root)
            .filter(Boolean),
          platform,
        )
      : ["/"]
  const writableRoots =
    input.profile === "workspace-write"
      ? uniquePaths([...workspaceRoots, tempDir], platform)
      : [tempDir]
  const readOnlyRoots =
    input.profile === "workspace-write"
      ? uniquePaths(
          [
            ...workspaceRoots.flatMap((root) =>
              PROTECTED_METADATA.map((name) => pathApi.join(root, name)),
            ),
            ...protectedRoots,
          ],
          platform,
        )
      : []

  const argv =
    platform === "win32"
      ? [
          normalizeAbsolute(
            input.windowsComSpec ?? "C:\\Windows\\System32\\cmd.exe",
            path.win32,
            "Windows command shell",
          ),
          "/d",
          "/s",
          "/c",
          input.command,
        ]
      : ["/bin/sh", "-c", input.command]
  const environment = buildCommandEnvironment(
    process.env,
    input.environment,
    platform,
  )
  setEnvironmentValue(environment, "TMPDIR", tempDir, platform)
  setEnvironmentValue(environment, "TMP", tempDir, platform)
  setEnvironmentValue(environment, "TEMP", tempDir, platform)
  setEnvironmentValue(environment, "NEXUS_SANDBOX", "1", platform)
  if ((input.network ?? "restricted") === "restricted") {
    setEnvironmentValue(
      environment,
      "NEXUS_SANDBOX_NETWORK_DISABLED",
      "1",
      platform,
    )
  } else {
    deleteEnvironmentValue(
      environment,
      "NEXUS_SANDBOX_NETWORK_DISABLED",
      platform,
    )
  }

  return {
    version: NEXUS_SANDBOX_PROTOCOL_VERSION,
    executionId: input.executionId,
    argv,
    cwd,
    readableRoots,
    writableRoots,
    readOnlyRoots,
    deniedRoots: [],
    network: input.network ?? "restricted",
    timeoutMillis: input.timeoutMs ?? 120_000,
    // Match the proven Codex spawn model: construct an explicit environment,
    // then let the native runner clear its own environment before exec. This
    // avoids duplicate/case-variant keys and accidental helper-only leakage.
    inheritEnv: false,
    environment,
    allowUnixSockets: input.allowUnixSockets ?? [],
  }
}

function buildCommandEnvironment(
  ambient: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined,
  platform: NodeJS.Platform,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue
    setEnvironmentValue(environment, key, value, platform)
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error(`invalid sandbox environment entry: ${key}`)
    }
    setEnvironmentValue(environment, key, value, platform)
  }
  const sanitized = sanitizeSandboxEnvironment(environment)
  if (
    platform === "win32" &&
    findEnvironmentKey(sanitized, "PATHEXT", platform) === undefined
  ) {
    sanitized.PATHEXT = ".COM;.EXE;.BAT;.CMD"
  }
  return sanitized
}

function setEnvironmentValue(
  environment: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  const existing = findEnvironmentKey(environment, key, platform)
  if (existing !== undefined && existing !== key) delete environment[existing]
  environment[key] = value
}

function deleteEnvironmentValue(
  environment: Record<string, string>,
  key: string,
  platform: NodeJS.Platform,
): void {
  const existing = findEnvironmentKey(environment, key, platform)
  if (existing !== undefined) delete environment[existing]
}

function findEnvironmentKey(
  environment: Record<string, string>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return Object.prototype.hasOwnProperty.call(environment, key)
      ? key
      : undefined
  }
  const normalized = key.toLowerCase()
  return Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === normalized,
  )
}

function normalizeAbsolute(
  candidate: string,
  pathApi: typeof path.posix | typeof path.win32,
  label: string,
): string {
  if (!candidate || candidate.includes("\0") || !pathApi.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute native path: ${candidate}`)
  }
  return pathApi.normalize(candidate)
}

function uniquePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of paths) {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function containsPath(
  root: string,
  candidate: string,
  pathApi: typeof path.posix | typeof path.win32,
  platform: NodeJS.Platform,
): boolean {
  const relative = pathApi.relative(root, candidate)
  if (relative === "") return true
  const normalized =
    platform === "win32" ? relative.toLowerCase() : relative
  return normalized !== ".." && !normalized.startsWith(`..${pathApi.sep}`)
}
