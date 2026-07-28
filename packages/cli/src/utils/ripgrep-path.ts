import { existsSync } from "node:fs"
import path from "node:path"

export type RipgrepCommand = {
  command: string
  args: string[]
  source: "system" | "bundled"
}

export interface ChooseRipgrepCommandOptions {
  systemExecutablePath: string
  bundledExecutablePath: string
  bundledExists: boolean
  forceBundled: boolean
}

/**
 * Selects a real ripgrep binary. `spawn-rx` returns the unresolved string
 * "rg" when the executable is absent from PATH, so that value is not proof
 * that a system installation exists.
 */
export function chooseRipgrepCommand({
  systemExecutablePath,
  bundledExecutablePath,
  bundledExists,
  forceBundled,
}: ChooseRipgrepCommandOptions): RipgrepCommand {
  const hasSystem = systemExecutablePath !== "rg"
  if (hasSystem && !forceBundled) {
    return {
      command: systemExecutablePath,
      args: [],
      source: "system",
    }
  }
  if (bundledExists) {
    return {
      command: bundledExecutablePath,
      args: [],
      source: "bundled",
    }
  }
  throw new Error(
    `ripgrep is unavailable: neither a system rg nor the packaged binary exists at ${bundledExecutablePath}`,
  )
}

export function getBundledRipgrepPath(
  runtimeRoot: string,
  platform = process.platform,
  arch = process.arch,
): string {
  if (platform === "win32") {
    return path.join(runtimeRoot, "vendor", "ripgrep", "x64-win32", "rg.exe")
  }
  return path.join(
    runtimeRoot,
    "vendor",
    "ripgrep",
    `${arch}-${platform}`,
    "rg",
  )
}

export function resolveRipgrepCommand(options: {
  runtimeRoot: string
  systemExecutablePath: string
  forceBundled?: boolean
}): RipgrepCommand {
  const bundledExecutablePath = getBundledRipgrepPath(options.runtimeRoot)
  return chooseRipgrepCommand({
    systemExecutablePath: options.systemExecutablePath,
    bundledExecutablePath,
    bundledExists: existsSync(bundledExecutablePath),
    forceBundled: options.forceBundled === true,
  })
}
