import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
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
    try {
      verifyIntegrity(path.dirname(resolved), target, binaryName, resolved)
    } catch (error) {
      unsafeError =
        error instanceof Error ? error : new Error(String(error))
      continue
    }
    return resolved
  }

  if (unsafeError) throw unsafeError
  throw new Error(
    `Nexus sandbox helper is unavailable for ${platform}/${arch}; reinstall or rebuild NexusCode`,
  )
}

function verifyIntegrity(
  directory: string,
  target: string,
  binaryName: string,
  binaryPath: string,
): void {
  const manifestPath = path.join(directory, "SHA256SUMS.json")
  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Nexus sandbox integrity manifest is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    (manifest as { schema?: unknown }).schema !== 1 ||
    (manifest as { target?: unknown }).target !== target
  ) {
    throw new Error("Nexus sandbox integrity manifest has an invalid schema or target")
  }
  const files = (manifest as { files?: Record<string, unknown> }).files
  const expected = files?.[binaryName]
  if (
    !files ||
    typeof expected !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expected)
  ) {
    throw new Error(`Nexus sandbox integrity manifest omits ${binaryName}`)
  }
  for (const [file, digest] of Object.entries(files)) {
    if (
      file !== path.basename(file) ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(digest)
    ) {
      throw new Error("Nexus sandbox integrity manifest contains an unsafe file entry")
    }
    const candidate = file === binaryName ? binaryPath : path.join(directory, file)
    const actual = createHash("sha256")
      .update(fs.readFileSync(candidate))
      .digest("hex")
    if (actual !== digest) {
      throw new Error(`Nexus sandbox integrity check failed for ${file}`)
    }
  }
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
