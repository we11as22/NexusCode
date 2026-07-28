import { getWorkspaceTrustIdentity } from "./utils/config.js"
import { execFileNoThrow } from "./utils/execFileNoThrow.js"
import { loadCliWorkspaceConfig } from "./nexus-bootstrap.js"

const REQUIRED_NODE_VERSION = "24.18.0"

export interface DoctorReport {
  ok: boolean
  lines: string[]
}

interface DoctorDependencies {
  runtimeVersion: string
  loadConfig(cwd: string): Promise<{ model: { provider: string; id: string } }>
  commandVersion(command: string): Promise<boolean>
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

  const [hasGit, hasRipgrep] = await Promise.all([
    dependencies.commandVersion("git"),
    dependencies.commandVersion("rg"),
  ])
  lines.push(
    hasGit
      ? "✓ Git available"
      : "• Git unavailable; checkpoints and Git review are limited",
  )
  lines.push(
    hasRipgrep
      ? "✓ ripgrep available"
      : "• ripgrep unavailable; filesystem fallbacks remain available",
  )

  return { ok, lines }
}
