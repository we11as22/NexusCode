export {
  assertChangeSetTransition,
  hashChangeProposal,
  hashFileContent,
  hashWorkspaceIdentity,
  normalizeChangePath,
  sameChangeIdentity,
} from "./hash.js"
export {
  ChangeSetStorageCorruptionError,
  ChangeSetStoreConflictError,
  FileChangeSetStore,
  type ChangeSetBlobPruneResult,
  type FileChangeSetStoreOptions,
} from "./file-store.js"
export {
  ChangeSetApprovalError,
  ChangeSetConflictError,
  ChangeSetService,
  FileMutationConflictError,
  reapplyRevertedChangeSets,
  revertEffectiveChangeSetsAfter,
  type ChangeSetBatchConflict,
  type ChangeSetBatchRevertResult,
  type ChangeSetServiceOptions,
} from "./service.js"
export {
  buildChangeSetRestorePlan,
  type BuildChangeSetRestorePlanOptions,
} from "./restore-plan.js"
export type {
  CapturedFileState,
  ChangeFileRecord,
  ChangeHunk,
  ChangeIdentity,
  ChangeOmission,
  ChangeRestoreDirection,
  ChangeRestorePlanMutation,
  ChangeSetFailure,
  ChangeSetListQuery,
  ChangeSetRecord,
  ChangeSetState,
  ChangeSetRestorePlan,
  ChangeSetStore,
  ChangeSetFilePort,
  ChangeProposalAfterState,
  ChangeProposalExpectedState,
  ChangeProposalFile,
  CreateChangeProposal,
  FileStateRef,
  HostFileMutation,
  HostFileMutationNext,
} from "./types.js"
