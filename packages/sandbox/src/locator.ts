import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

export interface ResolveSandboxBinaryOptions {
  trustedRoots?: string[]
  platform?: NodeJS.Platform
  arch?: string
}

export function sandboxTarget(
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Unsupported Nexus sandbox platform: ${platform}`)
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported Nexus sandbox architecture: ${arch}`)
  }
  return `${platform}-${arch}`
}

export function resolveSandboxBinary(
  options: ResolveSandboxBinaryOptions = {},
): string {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = sandboxTarget(platform, arch)
  const binaryName = platform === "win32" ? "nexus-sandbox.exe" : "nexus-sandbox"
  let unsafeError: Error | undefined

  for (const suppliedRoot of options.trustedRoots ?? defaultSandboxTrustedRoots()) {
    let trustedRoot: string
    try {
      trustedRoot = fs.realpathSync.native(suppliedRoot)
    } catch {
      continue
    }
    const candidate = path.join(trustedRoot, "vendor", target, binaryName)
    let resolved: string
    let stat: fs.Stats
    try {
      resolved = fs.realpathSync.native(candidate)
      stat = fs.statSync(resolved)
    } catch {
      continue
    }
    if (!containsPath(trustedRoot, resolved)) {
      unsafeError = new Error(
        `Nexus sandbox helper escapes its trusted root: ${resolved}`,
      )
      continue
    }
    if (!stat.isFile()) {
      unsafeError = new Error(`Nexus sandbox helper is not a regular file: ${resolved}`)
      continue
    }
    if (platform !== "win32" && (stat.mode & 0o111) === 0) {
      unsafeError = new Error(`Nexus sandbox helper is not executable: ${resolved}`)
      continue
    }
    return resolved
  }

  if (unsafeError) throw unsafeError
  throw new Error(
    `Nexus sandbox helper is unavailable for ${platform}/${arch}; reinstall or rebuild NexusCode`,
  )
}

export function defaultSandboxTrustedRoots(): string[] {
  const moduleUrl = import.meta.url
  const moduleDirectory =
    moduleUrl
      ? path.dirname(fileURLToPath(moduleUrl))
      : typeof __dirname === "string"
        ? __dirname
        : process.cwd()
  return [path.resolve(moduleDirectory, "..")]
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}
