const liveGrants = new WeakSet<object>()

export interface SandboxEscalationGrant {
  readonly executionId: string
  readonly command: string
  readonly cwd: string
}

/**
 * Mint a process-local, single-use capability after the authoritative
 * approval coordinator has received an explicit user decision.
 *
 * This module is deliberately not exported from @nexuscode/core.
 */
export function issueSandboxEscalationGrant(input: {
  executionId: string
  command: string
  cwd: string
}): SandboxEscalationGrant {
  const grant = Object.freeze({
    executionId: input.executionId,
    command: input.command,
    cwd: input.cwd,
  })
  liveGrants.add(grant)
  return grant
}

export function consumeSandboxEscalationGrant(
  candidate: unknown,
  expected: {
    executionId: string
    command: string
    cwd: string
  },
): boolean {
  if (!candidate || typeof candidate !== "object" || !liveGrants.has(candidate)) {
    return false
  }
  const grant = candidate as SandboxEscalationGrant
  if (
    grant.executionId !== expected.executionId ||
    grant.command !== expected.command ||
    grant.cwd !== expected.cwd
  ) {
    return false
  }
  liveGrants.delete(candidate)
  return true
}
