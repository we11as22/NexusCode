import { getWorkspaceTrustIdentity } from "./utils/config.js"
import { execFileNoThrow } from "./utils/execFileNoThrow.js"
import { loadCliWorkspaceConfig } from "./nexus-bootstrap.js"
import { getRipgrepStatus } from "./utils/ripgrep.js"
import {
  resolveSandboxBinary,
  sandboxTarget,
} from "@nexuscode/sandbox"

const REQUIRED_NODE_VERSION = "24.18.0"

export interface DoctorReport {
  ok: boolean
  lines: string[]
}

interface DoctorDependencies {
  runtimeVersion: string
  loadConfig(cwd: string): Promise<{ model: { provider: string; id: string } }>
  commandVersion(command: string): Promise<boolean>
  ripgrepStatus(): Promise<{
    available: boolean
    source: "system" | "bundled" | "missing"
    version?: string
  }>
  sandboxStatus(): Promise<{
    available: boolean
    target: string
    version?: string
    error?: string
  }>
}

const defaultDependencies: DoctorDependencies = {
  runtimeVersion: process.versions.node,
  loadConfig: cwd =>
    loadCliWorkspaceConfig(cwd, {
      loadEnv: false,
      // Doctor is read-only: validating config must not create or migrate the
      // host workspace-authority store.
      hostAuthority: false,
    }),
  commandVersion: async command => {
    const result = await execFileNoThrow(command, ["--version"])
    return result.code === 0
  },
  ripgrepStatus: getRipgrepStatus,
  sandboxStatus: async () => {
    const target = sandboxTarget(process.platform, process.arch)
    try {
      const binary = resolveSandboxBinary()
      const [version, backend] = await Promise.all([
        execFileNoThrow(binary, ["--version"]),
        execFileNoThrow(binary, ["--check"]),
      ])
      if (version.code !== 0 || backend.code !== 0) {
        return {
          available: false,
          target,
          error:
            backend.stderr ||
            version.stderr ||
            `helper/backend exited ${version.code}/${backend.code}`,
        }
      }
      return {
        available: true,
        target,
        version: `${version.stdout.trim()}; ${backend.stdout.trim()}`,
      }
    } catch (error) {
      return {
        available: false,
        target,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  },
}

export async function collectDoctorReport(
  cwd: string,
  overrides: Partial<DoctorDependencies> = {},
): Promise<DoctorReport> {
  const dependencies = { ...defaultDependencies, ...overrides }
  const lines = ["NexusCode doctor"]
  let ok = true

  if (dependencies.runtimeVersion === REQUIRED_NODE_VERSION) {
    lines.push(`✓ Node ${dependencies.runtimeVersion}`)
  } else {
    ok = false
    lines.push(
      `✗ Node ${dependencies.runtimeVersion}; required ${REQUIRED_NODE_VERSION}`,
    )
  }

  let workspace: string
  try {
    workspace = getWorkspaceTrustIdentity(cwd).canonicalPath
    lines.push(`✓ Workspace ${workspace}`)
  } catch (error) {
    ok = false
    lines.push(
      `✗ Workspace ${error instanceof Error ? error.message : String(error)}`,
    )
    return { ok, lines }
  }

  try {
    const config = await dependencies.loadConfig(workspace)
    lines.push(`✓ Model ${config.model.provider}/${config.model.id}`)
  } catch (error) {
    ok = false
    lines.push(
      `✗ Config ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const [hasGit, ripgrep, sandbox] = await Promise.all([
    dependencies.commandVersion("git"),
    dependencies.ripgrepStatus(),
    dependencies.sandboxStatus(),
  ])
  lines.push(
    hasGit
      ? "✓ Git available"
      : "• Git unavailable; checkpoints and Git review are limited",
  )
  if (ripgrep.available) {
    lines.push(
      `✓ ${ripgrep.version ?? "ripgrep available"} (${ripgrep.source})`,
    )
  } else {
    ok = false
    lines.push(
      "✗ ripgrep unavailable; rerun `pnpm run cli` to repair the packaged search runtime",
    )
  }
  if (sandbox.available) {
    lines.push(
      `✓ OS sandbox ${sandbox.target} (${sandbox.version ?? "helper available"})`,
    )
  } else {
    ok = false
    lines.push(
      `✗ OS sandbox ${sandbox.target} unavailable: ${sandbox.error ?? "reinstall or rebuild NexusCode"}`,
    )
  }

  return { ok, lines }
}
