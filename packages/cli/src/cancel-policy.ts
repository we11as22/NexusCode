export interface NexusCancelState {
  isLoading: boolean
  hasRunningSubagent: boolean
  hasApprovalPanel: boolean
}

export function shouldCancelActiveNexusRun(
  state: NexusCancelState,
): boolean {
  if (state.hasApprovalPanel) return false
  return state.isLoading || state.hasRunningSubagent
}

export function shouldEnableGlobalCancelInput(input: {
  hasApprovalPanel: boolean
}): boolean {
  return !input.hasApprovalPanel
}

export function shouldAnimateNexusActivity(input: {
  hasApprovalPanel: boolean
  hasLegacyPermissionPanel: boolean
  hasToolShell: boolean
  messageSelectorVisible: boolean
  primarySpinnerVisible: boolean
}): boolean {
  return (
    !input.hasApprovalPanel &&
    !input.hasLegacyPermissionPanel &&
    !input.hasToolShell &&
    !input.messageSelectorVisible &&
    !input.primarySpinnerVisible
  )
}
