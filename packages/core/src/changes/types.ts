export type ChangeSetState =
  | "proposed"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "accepted"
  | "reverting"
  | "reverted"
  | "conflicted"

import type { ToolExecutionIdentity } from "../types.js"

export type ChangeIdentity = ToolExecutionIdentity

export type FileStateRef =
  | {
      readonly exists: true
      readonly hash: string
      readonly blob: string
      readonly byteLength: number
      readonly mode: number | null
    }
  | {
      readonly exists: false
      readonly hash: null
      readonly blob: null
      readonly byteLength: 0
      readonly mode: null
    }

export interface ChangeHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly patch: string
}

export interface ChangeOmission {
  readonly reason:
    | "binary"
    | "oversize"
    | "unavailable"
    | "unsupported"
  readonly detail: string
}

export interface ChangeFileRecord {
  readonly path: string
  readonly oldPath?: string
  readonly operation: "create" | "modify" | "delete" | "rename"
  /** Earliest state restored by turn-level undo after coalesced edits. */
  readonly before: FileStateRef
  /** Exact current state that this proposal is allowed to replace. */
  readonly applyBase: FileStateRef
  /** Rename destination state captured before approval (normally absent). */
  readonly targetBase?: FileStateRef
  readonly after: FileStateRef
  readonly hunks: readonly ChangeHunk[]
  readonly binary: boolean
  readonly omission?: ChangeOmission
}

export interface ChangeSetFailure {
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly observedHash?: string | null
}

export interface ChangeSetRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly identity: ChangeIdentity
  readonly proposalHash: string
  readonly supersedes?: string
  readonly approvedHash?: string
  readonly state: ChangeSetState
  readonly files: readonly ChangeFileRecord[]
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly failure?: ChangeSetFailure
}

export interface ChangeSetListQuery {
  readonly workspaceId: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly states?: readonly ChangeSetState[]
}

export interface ChangeSetStore {
  putBlob(hash: string, content: Uint8Array): Promise<void>
  getBlob(hash: string): Promise<Buffer>
  /**
   * Atomically rejects duplicate ids and a second record with the same
   * execution identity, making replay idempotent across runtime instances.
   */
  insert(record: ChangeSetRecord): Promise<void>
  get(id: string): Promise<ChangeSetRecord | undefined>
  list(query: ChangeSetListQuery): Promise<readonly ChangeSetRecord[]>
  replace(
    record: ChangeSetRecord,
    expectedRevision: number,
  ): Promise<void>
}

export type CapturedFileState =
  | {
      readonly exists: true
      readonly content: Uint8Array
      readonly mode: number | null
    }
  | {
      readonly exists: false
      readonly content: null
      readonly mode: null
    }

export type HostFileMutationNext =
  | {
      readonly exists: true
      readonly content: Uint8Array
      readonly mode: number | null
    }
  | {
      readonly exists: false
      readonly content: null
      readonly mode: null
    }

export interface HostFileMutation {
  readonly path: string
  readonly expected: FileStateRef
  readonly next: HostFileMutationNext
}

export interface ChangeSetFilePort {
  readFileState(path: string): Promise<CapturedFileState>
  applyFileMutation(mutation: HostFileMutation): Promise<void>
}

export type ChangeProposalAfterState =
  | {
      readonly exists: true
      readonly content: string | Uint8Array
      readonly mode?: number | null
    }
  | {
      readonly exists: false
    }

export type ChangeProposalExpectedState =
  | {
      readonly exists: true
      readonly hash: string
      readonly byteLength: number
      readonly mode: number | null
    }
  | {
      readonly exists: false
    }

export interface ChangeProposalFile {
  readonly path: string
  readonly oldPath?: string
  /**
   * Exact state used to compute the proposed output. The service recaptures
   * the path and rejects drift before persisting a proposal.
   */
  readonly expected?: ChangeProposalExpectedState
  readonly after: ChangeProposalAfterState
  readonly hunks: readonly ChangeHunk[]
  readonly binary: boolean
  readonly omission?: ChangeOmission
}

export interface CreateChangeProposal {
  readonly identity: ChangeIdentity
  readonly files: readonly ChangeProposalFile[]
}

export type ChangeRestoreDirection = "apply" | "revert"

export interface ChangeRestorePlanMutation {
  /** Logical file item selected by the user. */
  readonly changePath: string
  /** Concrete path mutated by this CAS step. Renames have two steps. */
  readonly mutationPath: string
  readonly operation: ChangeFileRecord["operation"]
  readonly expected: FileStateRef
  readonly target: FileStateRef
}

export interface ChangeSetRestorePlan {
  readonly changeSetId: string
  readonly proposalHash: string
  readonly direction: ChangeRestoreDirection
  readonly selectedPaths: readonly string[]
  readonly mutations: readonly ChangeRestorePlanMutation[]
}
