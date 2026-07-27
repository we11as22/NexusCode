import {
  approveWorkspaceProjectAuthority,
  getPendingProjectAuthorityRequests,
  getClaudeCompatibilityOptions,
  hydrateWorkspaceAuthority,
  loadConfig,
  loadProjectSettings,
  type NexusConfig,
  type WorkspaceAuthorityStoreOptions,
} from "@nexuscode/core"

export interface VsCodeWorkspaceConfigOptions {
  loadEnv: boolean
  globalConfigPath?: string | false
  hostAuthority: boolean
  authorityStoreOptions?: WorkspaceAuthorityStoreOptions
}

export type VsCodeProjectAuthorityApprovalOptions = Omit<
  VsCodeWorkspaceConfigOptions,
  "hostAuthority"
>

export async function approvePendingVsCodeProjectAuthority(
  cwd: string,
  fingerprint: string,
  options: VsCodeProjectAuthorityApprovalOptions,
): Promise<void> {
  const normalized = fingerprint.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("Project authority fingerprint is invalid")
  }
  const config = await loadConfig(cwd, {
    loadEnv: options.loadEnv,
    ...(options.globalConfigPath !== undefined
      ? { globalConfigPath: options.globalConfigPath }
      : {}),
  })
  const matches = getPendingProjectAuthorityRequests(config).filter(
    (request) => request.fingerprint === normalized,
  )
  if (matches.length !== 1) {
    throw new Error(
      `Project authority request ${normalized} is no longer pending`,
    )
  }
  await approveWorkspaceProjectAuthority(
    cwd,
    matches[0]!,
    options.authorityStoreOptions,
  )
}

/**
 * Load extension runtime policy without confusing repository requests with
 * host authority. Project compatibility files may tighten command policy;
 * only the exact-workspace host store contributes persistent grants.
 */
export async function loadVsCodeWorkspaceConfig(
  cwd: string,
  options: VsCodeWorkspaceConfigOptions,
): Promise<NexusConfig> {
  const config = await loadConfig(cwd, {
    loadEnv: options.loadEnv,
    ...(options.globalConfigPath !== undefined
      ? { globalConfigPath: options.globalConfigPath }
      : {}),
  })
  try {
    const settings = loadProjectSettings(cwd, {
      compatibility: getClaudeCompatibilityOptions(config),
    })
    const permissions = settings.permissions
    if (permissions) {
      if (Array.isArray(permissions.deny)) {
        config.permissions.denyCommandPatterns = permissions.deny
      }
      if (Array.isArray(permissions.ask)) {
        config.permissions.askCommandPatterns = permissions.ask
      }
    }
  } catch {
    // A malformed compatibility file must never manufacture an allow grant.
  }
  if (options.hostAuthority) {
    await hydrateWorkspaceAuthority(
      config,
      cwd,
      options.authorityStoreOptions,
    )
  }
  return config
}
