import {
  approveWorkspaceProjectAuthority,
  getPendingProjectAuthorityRequests,
  loadConfig,
  type PendingProjectAuthorityRequest,
  type WorkspaceAuthorityStoreOptions,
} from "@nexuscode/core"

export interface CliProjectAuthorityOptions
  extends WorkspaceAuthorityStoreOptions {
  globalConfigPath?: string | false
  loadEnv?: boolean
}

export async function listPendingProjectAuthority(
  workspacePath: string,
  options: CliProjectAuthorityOptions = {},
): Promise<readonly PendingProjectAuthorityRequest[]> {
  const config = await loadConfig(workspacePath, {
    loadEnv: options.loadEnv ?? true,
    ...(options.globalConfigPath !== undefined
      ? { globalConfigPath: options.globalConfigPath }
      : {}),
  })
  return getPendingProjectAuthorityRequests(config)
}

export async function approvePendingProjectAuthorityByFingerprint(
  workspacePath: string,
  fingerprint: string,
  options: CliProjectAuthorityOptions = {},
): Promise<PendingProjectAuthorityRequest> {
  const normalized = fingerprint.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("Project authority fingerprint is invalid")
  }
  const pending = await listPendingProjectAuthority(workspacePath, options)
  const matches = pending.filter(
    (request) => request.fingerprint === normalized,
  )
  if (matches.length !== 1) {
    throw new Error(
      `Project authority request ${normalized} is no longer pending`,
    )
  }
  const request = matches[0]!
  await approveWorkspaceProjectAuthority(
    workspacePath,
    request,
    options.storePath ? { storePath: options.storePath } : {},
  )
  return request
}
