import { randomUUID } from "node:crypto"

import {
  assertChangeSetTransition,
  hashChangeProposal,
  hashFileContent,
  normalizeChangePath,
  sameChangeIdentity,
} from "./hash.js"
import type {
  CapturedFileState,
  ChangeFileRecord,
  ChangeProposalFile,
  ChangeSetFilePort,
  ChangeSetRecord,
  ChangeSetState,
  ChangeSetStore,
  CreateChangeProposal,
  FileStateRef,
  HostFileMutation,
  HostFileMutationNext,
} from "./types.js"

export class ChangeSetApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChangeSetApprovalError"
  }
}

export class ChangeSetConflictError extends Error {
  readonly changeSetId?: string
  readonly path?: string

  constructor(
    message: string,
    options: {
      cause?: unknown
      changeSetId?: string
      path?: string
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {})
    this.name = "ChangeSetConflictError"
    this.changeSetId = options.changeSetId
    this.path = options.path
  }
}

export class FileMutationConflictError extends Error {
  readonly path: string

  constructor(filePath: string) {
    super(`File mutation precondition failed: ${filePath}`)
    this.name = "FileMutationConflictError"
    this.path = filePath
  }
}

export interface ChangeSetServiceOptions {
  workspaceId: string
  store: ChangeSetStore
  files: ChangeSetFilePort
  now?: () => number
  idFactory?: () => string
}

export interface ChangeSetBatchConflict {
  readonly changeSetId: string
  readonly paths: readonly string[]
  readonly message: string
}

export type ChangeSetBatchRevertResult =
  | {
      readonly status: "reverted"
      /** Newest-to-oldest order in which records reached `reverted`. */
      readonly reverted: readonly ChangeSetRecord[]
    }
  | {
      readonly status: "conflicted"
      /** Records still reverted after best-effort compensation. */
      readonly reverted: readonly ChangeSetRecord[]
      readonly conflicts: readonly ChangeSetBatchConflict[]
    }

interface PreparedMutation {
  mutation: HostFileMutation
  nextRef: FileStateRef
}

type MutationAssessment = "expected" | "next" | "partial" | "ambiguous"

function absentRef(): FileStateRef {
  return {
    exists: false,
    hash: null,
    blob: null,
    byteLength: 0,
    mode: null,
  }
}

function validTime(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Change-set time must be a non-negative safe integer")
  }
  return value
}

function operationFor(
  before: FileStateRef,
  after: FileStateRef,
  oldPath?: string,
): ChangeFileRecord["operation"] {
  if (oldPath) return "rename"
  if (!before.exists && after.exists) return "create"
  if (before.exists && !after.exists) return "delete"
  if (before.exists && after.exists) return "modify"
  throw new Error("A file proposal cannot keep a missing file missing")
}

function capturedMatchesRef(
  captured: CapturedFileState,
  expected: FileStateRef,
): boolean {
  if (captured.exists !== expected.exists) return false
  if (!captured.exists || !expected.exists) return true
  const actual = hashFileContent(captured.content)
  return (
    actual.hash === expected.hash &&
    actual.byteLength === expected.byteLength &&
    captured.mode === expected.mode
  )
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function requestMatchesRecord(
  files: readonly ChangeProposalFile[],
  record: ChangeSetRecord,
): boolean {
  if (files.length !== record.files.length) return false
  const existingByPath = new Map(
    record.files.map((file) => [file.path, file] as const),
  )
  for (const requested of files) {
    const existing = existingByPath.get(requested.path)
    if (
      !existing ||
      existing.oldPath !== requested.oldPath ||
      existing.binary !== requested.binary ||
      !sameJson(existing.hunks, requested.hunks) ||
      !sameJson(existing.omission ?? null, requested.omission ?? null)
    ) {
      return false
    }
    if (requested.after.exists !== existing.after.exists) return false
    if (!requested.after.exists || !existing.after.exists) continue
    const digest = hashFileContent(requested.after.content)
    if (
      digest.hash !== existing.after.hash ||
      digest.byteLength !== existing.after.byteLength ||
      (
        requested.after.mode !== undefined &&
        requested.after.mode !== existing.after.mode
      )
    ) {
      return false
    }
  }
  return true
}

export class ChangeSetService {
  readonly #workspaceId: string
  readonly #store: ChangeSetStore
  readonly #files: ChangeSetFilePort
  readonly #now: () => number
  readonly #idFactory: () => string
  #operationQueue: Promise<void> = Promise.resolve()

  constructor(options: ChangeSetServiceOptions) {
    if (!options.workspaceId || options.workspaceId.includes("\0")) {
      throw new Error("Change-set workspace id must be non-empty and NUL-free")
    }
    this.#workspaceId = options.workspaceId
    this.#store = options.store
    this.#files = options.files
    this.#now = options.now ?? Date.now
    this.#idFactory = options.idFactory ?? randomUUID
  }

  propose(input: CreateChangeProposal): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      if (input.identity.workspaceId !== this.#workspaceId) {
        throw new Error(
          `Proposal workspace ${input.identity.workspaceId} does not match ${this.#workspaceId}`,
        )
      }
      if (input.files.length === 0) {
        throw new Error("A change proposal must contain at least one file")
      }

      const normalizedInputs = input.files.map((file) => ({
        ...file,
        path: normalizeChangePath(file.path),
        ...(file.oldPath
          ? { oldPath: normalizeChangePath(file.oldPath) }
          : {}),
      }))
      const canonicalPaths = new Set<string>()
      for (const file of normalizedInputs) {
        for (const candidate of [file.path, file.oldPath].filter(
          (value): value is string => value !== undefined,
        )) {
          if (canonicalPaths.has(candidate)) {
            throw new Error(`Duplicate proposal path: ${candidate}`)
          }
          canonicalPaths.add(candidate)
        }
      }

      const identityRecords = await this.#store.list({
        workspaceId: this.#workspaceId,
        sessionId: input.identity.sessionId,
        turnId: input.identity.turnId,
      })
      const priorAttempt = identityRecords.find((record) =>
        sameChangeIdentity(record.identity, input.identity),
      )
      if (priorAttempt) {
        if (requestMatchesRecord(normalizedInputs, priorAttempt)) {
          return priorAttempt
        }
        throw new ChangeSetConflictError(
          `Tool call identity ${input.identity.toolCallId} was reused for a different change proposal`,
          { changeSetId: priorAttempt.id },
        )
      }

      const prior =
        normalizedInputs.length === 1
          ? await this.#findCoalesciblePrior(
              input.identity.sessionId,
              input.identity.turnId,
              normalizedInputs[0]!.path,
            )
          : undefined
      const files: ChangeFileRecord[] = []
      for (const file of normalizedInputs) {
        files.push(await this.#captureProposalFile(file, prior))
      }
      const proposalHash = hashChangeProposal(input.identity, files)

      const duplicate = (
        await this.#store.list({
          workspaceId: this.#workspaceId,
          sessionId: input.identity.sessionId,
          turnId: input.identity.turnId,
          states: ["proposed", "approved", "applying", "applied"],
        })
      ).find(
        (record) =>
          record.identity.toolCallId === input.identity.toolCallId &&
          record.proposalHash === proposalHash,
      )
      if (duplicate) return duplicate

      const createdAt = validTime(this.#now)
      const record: ChangeSetRecord = {
        schemaVersion: 1,
        id: this.#idFactory(),
        identity: structuredClone(input.identity),
        proposalHash,
        ...(prior ? { supersedes: prior.id } : {}),
        state: "proposed",
        files,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      }
      try {
        await this.#store.insert(record)
      } catch (error) {
        // Another runtime may have admitted the exact tool call after our
        // initial list. The store owns the atomic uniqueness boundary; return
        // its winner only when this is an exact replay.
        const winner = (
          await this.#store.list({
            workspaceId: this.#workspaceId,
            sessionId: input.identity.sessionId,
            turnId: input.identity.turnId,
          })
        ).find((candidate) =>
          sameChangeIdentity(candidate.identity, input.identity),
        )
        if (winner && requestMatchesRecord(normalizedInputs, winner)) {
          return winner
        }
        if (winner) {
          throw new ChangeSetConflictError(
            `Tool call identity ${input.identity.toolCallId} was concurrently reused for a different change proposal`,
            { cause: error, changeSetId: winner.id },
          )
        }
        throw error
      }
      return structuredClone(record)
    })
  }

  get(id: string): Promise<ChangeSetRecord | undefined> {
    return this.#store.get(id)
  }

  approve(id: string, proposalHash: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const record = await this.#require(id)
      if (record.state !== "proposed") {
        throw new ChangeSetApprovalError(
          `Change set ${id} is ${record.state}, not proposed`,
        )
      }
      if (record.proposalHash !== proposalHash) {
        throw new ChangeSetApprovalError(
          `Approval hash does not match change set ${id}`,
        )
      }
      return this.#transition(record, "approved", {
        approvedHash: proposalHash,
      })
    })
  }

  reject(id: string, proposalHash: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const record = await this.#require(id)
      if (record.state !== "proposed") {
        throw new ChangeSetApprovalError(
          `Change set ${id} is ${record.state}, not proposed`,
        )
      }
      if (record.proposalHash !== proposalHash) {
        throw new ChangeSetApprovalError(
          `Rejection hash does not match change set ${id}`,
        )
      }
      return this.#transition(record, "rejected")
    })
  }

  apply(id: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const approved = await this.#require(id)
      if (
        approved.state !== "approved" ||
        approved.approvedHash !== approved.proposalHash
      ) {
        throw new ChangeSetApprovalError(
          `Change set ${id} does not have an exact approved proposal`,
        )
      }
      const applying = await this.#transition(approved, "applying")
      const prepared = await this.#prepareMutations(applying, "apply")
      try {
        await this.#preflight(prepared, applying.id)
      } catch (error) {
        await this.#transition(applying, "conflicted", {
          failure: {
            code: "apply_precondition",
            message: failureMessage(error),
            ...(error instanceof FileMutationConflictError
              ? { path: error.path }
              : {}),
          },
        })
        throw new ChangeSetConflictError(
          `Change set ${id} no longer matches the approved workspace state`,
          { cause: error, changeSetId: id },
        )
      }

      try {
        for (const item of prepared) {
          await this.#files.applyFileMutation(item.mutation)
        }
      } catch (error) {
        return this.#recoverFailedMutation(
          applying,
          prepared,
          "apply",
          error,
        )
      }
      return this.#transition(applying, "applied")
    })
  }

  revert(id: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const applied = await this.#require(id)
      if (applied.state === "reverted") return applied
      if (applied.state !== "applied") {
        throw new Error(`Change set ${id} is ${applied.state}, not applied`)
      }
      const reverting = await this.#transition(applied, "reverting")
      const prepared = await this.#prepareMutations(reverting, "revert")
      try {
        await this.#preflight(prepared, reverting.id)
      } catch (error) {
        await this.#transition(reverting, "conflicted", {
          failure: {
            code: "revert_precondition",
            message: failureMessage(error),
            ...(error instanceof FileMutationConflictError
              ? { path: error.path }
              : {}),
          },
        })
        throw new ChangeSetConflictError(
          `Change set ${id} cannot be reverted because files changed later`,
          { cause: error, changeSetId: id },
        )
      }
      try {
        for (const item of prepared) {
          await this.#files.applyFileMutation(item.mutation)
        }
      } catch (error) {
        return this.#recoverFailedMutation(
          reverting,
          prepared,
          "revert",
          error,
        )
      }
      return this.#transition(reverting, "reverted")
    })
  }

  /**
   * Compensate a reverted change after a surrounding transaction (for
   * example, conversation rewind) fails to commit. Unlike a normal apply,
   * this compares against the earliest before-state retained by coalescing.
   */
  reapply(id: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const reverted = await this.#require(id)
      if (
        reverted.state !== "reverted" ||
        reverted.approvedHash !== reverted.proposalHash
      ) {
        throw new ChangeSetApprovalError(
          `Change set ${id} is ${reverted.state}, not exactly approved and reverted`,
        )
      }
      const applying = await this.#transition(reverted, "applying", {
        failure: {
          code: "reapply_in_progress",
          message: "Reapplying after a surrounding transaction was aborted",
        },
      })
      const prepared = await this.#prepareMutations(applying, "reapply")
      try {
        await this.#preflight(prepared, applying.id)
      } catch (error) {
        await this.#transition(applying, "conflicted", {
          failure: {
            code: "reapply_precondition",
            message: failureMessage(error),
            ...(error instanceof FileMutationConflictError
              ? { path: error.path }
              : {}),
          },
        })
        throw new ChangeSetConflictError(
          `Change set ${id} cannot be reapplied because files changed later`,
          { cause: error, changeSetId: id },
        )
      }
      try {
        for (const item of prepared) {
          await this.#files.applyFileMutation(item.mutation)
        }
      } catch (error) {
        return this.#recoverFailedMutation(
          applying,
          prepared,
          "reapply",
          error,
        )
      }
      return this.#transition(applying, "applied", {
        failure: undefined,
      })
    })
  }

  accept(id: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const applied = await this.#require(id)
      if (applied.state === "accepted") return applied
      if (applied.state !== "applied") {
        throw new Error(`Change set ${id} is ${applied.state}, not applied`)
      }
      return this.#transition(applied, "accepted")
    })
  }

  recover(id: string): Promise<ChangeSetRecord> {
    return this.#enqueue(async () => {
      const record = await this.#require(id)
      if (record.state !== "applying" && record.state !== "reverting") {
        return record
      }
      const direction =
        record.state === "reverting"
          ? "revert"
          : record.failure?.code === "reapply_in_progress"
            ? "reapply"
            : "apply"
      const prepared = await this.#prepareMutations(record, direction)
      let assessment = await this.#assess(prepared)
      if (assessment === "partial") {
        try {
          await this.#compensate(prepared)
        } catch {
          // Re-assessment below distinguishes a completed compensation whose
          // acknowledgement failed from bytes that are still ambiguous.
        }
        assessment = await this.#assess(prepared)
        if (assessment === "expected") {
          return this.#transition(
            record,
            direction === "apply"
              ? "approved"
              : direction === "reapply"
                ? "reverted"
                : "applied",
            {
              failure: {
                code:
                  direction === "apply"
                    ? "apply_recovered_partial"
                    : direction === "reapply"
                      ? "reapply_recovered_partial"
                      : "revert_recovered_partial",
                message:
                  `Recovered an interrupted ${direction} by restoring its complete precondition boundary`,
              },
            },
          )
        }
      }
      if (direction === "apply") {
        if (assessment === "next") return this.#transition(record, "applied")
        if (assessment === "expected") return this.#transition(record, "approved")
      } else if (direction === "revert") {
        if (assessment === "next") return this.#transition(record, "reverted")
        if (assessment === "expected") return this.#transition(record, "applied")
      } else {
        if (assessment === "next") {
          return this.#transition(record, "applied", { failure: undefined })
        }
        if (assessment === "expected") {
          return this.#transition(record, "reverted")
        }
      }
      return this.#transition(record, "conflicted", {
        failure: {
          code: "recovery_ambiguous",
          message: "Observed file bytes match neither complete transition boundary",
        },
      })
    })
  }

  /**
   * Reconcile every transition whose intent was durable but whose final
   * acknowledgement was not. Hosts call this before starting a new agent run
   * or at another proven-quiescent session boundary, so a process crash cannot
   * leave applied bytes hidden behind an `applying`/`reverting` journal state.
   * It must not be invoked while the selected session can still be mutating
   * files.
   */
  async recoverInterrupted(input: {
    sessionId?: string
    turnId?: string
  } = {}): Promise<readonly ChangeSetRecord[]> {
    const interrupted = await this.#store.list({
      workspaceId: this.#workspaceId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      states: ["applying", "reverting"],
    })
    const recovered: ChangeSetRecord[] = []
    for (const record of interrupted) {
      recovered.push(await this.recover(record.id))
    }
    return recovered
  }

  async listEffectiveApplied(input: {
    sessionId: string
    turnId?: string
  }): Promise<readonly ChangeSetRecord[]> {
    const records = await this.#store.list({
      workspaceId: this.#workspaceId,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    })
    const superseded = new Set(
      records
        .filter((record) =>
          record.supersedes !== undefined &&
          ["applied", "accepted", "reverting", "reverted"].includes(
            record.state,
          ),
        )
        .map((record) => record.supersedes!),
    )
    return records
      .filter(
        (record) =>
          record.state === "applied" &&
          !superseded.has(record.id),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      )
  }

  async #captureProposalFile(
    input: ChangeProposalFile,
    prior: ChangeSetRecord | undefined,
  ): Promise<ChangeFileRecord> {
    const sourcePath = input.oldPath ?? input.path
    const captured = await this.#files.readFileState(sourcePath)
    const applyBase = await this.#storeCaptured(captured)
    if (input.expected) {
      const expectedMatches = input.expected.exists
        ? (
            applyBase.exists &&
            applyBase.hash === input.expected.hash &&
            applyBase.byteLength === input.expected.byteLength &&
            applyBase.mode === input.expected.mode
          )
        : !applyBase.exists
      if (!expectedMatches) {
        throw new ChangeSetConflictError(
          `File ${sourcePath} changed while its proposal was being prepared`,
          { path: sourcePath },
        )
      }
    }
    let targetBase: FileStateRef | undefined
    if (input.oldPath) {
      targetBase = await this.#storeCaptured(
        await this.#files.readFileState(input.path),
      )
      if (targetBase.exists) {
        throw new ChangeSetConflictError(
          `Rename destination already exists: ${input.path}`,
          { path: input.path },
        )
      }
    }

    let before = applyBase
    if (prior) {
      const priorFile = prior.files.find((file) => file.path === input.path)
      if (priorFile) {
        if (
          priorFile.after.hash !== applyBase.hash ||
          priorFile.after.exists !== applyBase.exists
        ) {
          throw new ChangeSetConflictError(
            `File ${input.path} changed between same-turn agent edits`,
            { path: input.path, changeSetId: prior.id },
          )
        }
        before = priorFile.before
      }
    }

    let after: FileStateRef
    if (input.after.exists) {
      const content =
        typeof input.after.content === "string"
          ? Buffer.from(input.after.content, "utf8")
          : Buffer.from(input.after.content)
      after = await this.#storeCaptured({
        exists: true,
        content,
        mode:
          input.after.mode !== undefined
            ? input.after.mode
            : applyBase.exists
              ? applyBase.mode
              : 0o644,
      })
    } else {
      after = absentRef()
    }
    return {
      path: input.path,
      ...(input.oldPath ? { oldPath: input.oldPath } : {}),
      // `operation` describes the net reversible effect of the effective
      // same-turn change. `applyBase` remains the CAS precondition for this
      // individual tool call, while `before` may come from an earlier
      // coalesced write (for example create -> edit must still undo to absent).
      operation: operationFor(before, after, input.oldPath),
      before,
      applyBase,
      ...(targetBase ? { targetBase } : {}),
      after,
      hunks: structuredClone(input.hunks),
      binary: input.binary,
      ...(input.omission ? { omission: structuredClone(input.omission) } : {}),
    }
  }

  async #storeCaptured(state: CapturedFileState): Promise<FileStateRef> {
    if (!state.exists) return absentRef()
    const content = Buffer.from(state.content)
    const digest = hashFileContent(content)
    await this.#store.putBlob(digest.hash, content)
    return {
      exists: true,
      hash: digest.hash,
      blob: digest.hash,
      byteLength: digest.byteLength,
      mode: state.mode,
    }
  }

  async #findCoalesciblePrior(
    sessionId: string,
    turnId: string,
    filePath: string,
  ): Promise<ChangeSetRecord | undefined> {
    const records = await this.listEffectiveApplied({ sessionId, turnId })
    return [...records]
      .reverse()
      .find(
        (record) =>
          record.files.length === 1 &&
          record.files[0]?.path === filePath,
      )
  }

  async #require(id: string): Promise<ChangeSetRecord> {
    const record = await this.#store.get(id)
    if (!record) throw new Error(`Unknown change set: ${id}`)
    if (record.identity.workspaceId !== this.#workspaceId) {
      throw new Error(`Change set ${id} belongs to another workspace`)
    }
    return record
  }

  async #transition(
    record: ChangeSetRecord,
    state: ChangeSetState,
    updates: Partial<
      Pick<
        ChangeSetRecord,
        "approvedHash" | "failure"
      >
    > = {},
  ): Promise<ChangeSetRecord> {
    assertChangeSetTransition(record.state, state)
    const next: ChangeSetRecord = {
      ...record,
      ...updates,
      state,
      revision: record.revision + 1,
      updatedAt: validTime(this.#now),
    }
    await this.#store.replace(next, record.revision)
    return next
  }

  async #nextFromRef(ref: FileStateRef): Promise<HostFileMutationNext> {
    if (!ref.exists) {
      return { exists: false, content: null, mode: null }
    }
    return {
      exists: true,
      content: await this.#store.getBlob(ref.blob),
      mode: ref.mode,
    }
  }

  async #prepareMutations(
    record: ChangeSetRecord,
    direction: "apply" | "revert" | "reapply",
  ): Promise<PreparedMutation[]> {
    const prepared: PreparedMutation[] = []
    for (const file of record.files) {
      if (file.operation === "rename") {
        if (!file.oldPath || !file.targetBase) {
          throw new Error(`Rename change ${record.id} is incomplete`)
        }
        if (direction === "apply" || direction === "reapply") {
          prepared.push({
            mutation: {
              path: file.oldPath,
              expected:
                direction === "reapply"
                  ? file.before
                  : file.applyBase,
              next: await this.#nextFromRef(absentRef()),
            },
            nextRef: absentRef(),
          })
          prepared.push({
            mutation: {
              path: file.path,
              expected: file.targetBase,
              next: await this.#nextFromRef(file.after),
            },
            nextRef: file.after,
          })
        } else {
          prepared.push({
            mutation: {
              path: file.path,
              expected: file.after,
              next: await this.#nextFromRef(file.targetBase),
            },
            nextRef: file.targetBase,
          })
          prepared.push({
            mutation: {
              path: file.oldPath,
              expected: absentRef(),
              next: await this.#nextFromRef(file.before),
            },
            nextRef: file.before,
          })
        }
        continue
      }
      const expected =
        direction === "apply"
          ? file.applyBase
          : direction === "reapply"
            ? file.before
            : file.after
      const nextRef =
        direction === "revert" ? file.before : file.after
      prepared.push({
        mutation: {
          path: file.path,
          expected,
          next: await this.#nextFromRef(nextRef),
        },
        nextRef,
      })
    }
    return prepared
  }

  async #preflight(
    prepared: readonly PreparedMutation[],
    _changeSetId: string,
  ): Promise<void> {
    for (const item of prepared) {
      const current = await this.#files.readFileState(item.mutation.path)
      if (!capturedMatchesRef(current, item.mutation.expected)) {
        throw new FileMutationConflictError(item.mutation.path)
      }
    }
  }

  async #assess(
    prepared: readonly PreparedMutation[],
  ): Promise<MutationAssessment> {
    let sawExpectedOnly = false
    let sawNextOnly = false
    for (const item of prepared) {
      const current = await this.#files.readFileState(item.mutation.path)
      const matchesExpected = capturedMatchesRef(
        current,
        item.mutation.expected,
      )
      const matchesNext = capturedMatchesRef(current, item.nextRef)
      if (!matchesExpected && !matchesNext) return "ambiguous"
      if (matchesExpected && !matchesNext) sawExpectedOnly = true
      if (matchesNext && !matchesExpected) sawNextOnly = true
    }
    if (sawExpectedOnly && sawNextOnly) return "partial"
    if (sawNextOnly) return "next"
    return "expected"
  }

  async #compensate(
    prepared: readonly PreparedMutation[],
  ): Promise<void> {
    for (const item of [...prepared].reverse()) {
      const current = await this.#files.readFileState(item.mutation.path)
      if (capturedMatchesRef(current, item.mutation.expected)) continue
      if (!capturedMatchesRef(current, item.nextRef)) {
        throw new FileMutationConflictError(item.mutation.path)
      }
      await this.#files.applyFileMutation({
        path: item.mutation.path,
        expected: item.nextRef,
        next: await this.#nextFromRef(item.mutation.expected),
      })
    }
  }

  async #recoverFailedMutation(
    record: ChangeSetRecord,
    prepared: readonly PreparedMutation[],
    direction: "apply" | "revert" | "reapply",
    error: unknown,
  ): Promise<ChangeSetRecord> {
    let assessment = await this.#assess(prepared)
    if (assessment === "partial") {
      try {
        await this.#compensate(prepared)
      } catch {
        // An adapter may throw after its bytes are durable. Always observe the
        // files again instead of treating notification failure as disk failure.
      }
      assessment = await this.#assess(prepared)
    }
    if (direction === "apply" && assessment === "next") {
      return this.#transition(record, "applied")
    }
    if (direction === "revert" && assessment === "next") {
      return this.#transition(record, "reverted")
    }
    if (direction === "reapply" && assessment === "next") {
      return this.#transition(record, "applied", { failure: undefined })
    }
    if (assessment === "expected") {
      const recovered = await this.#transition(
        record,
        direction === "apply"
          ? "approved"
          : direction === "reapply"
            ? "reverted"
            : "applied",
        {
          failure: {
            code: `${direction}_interrupted`,
            message: failureMessage(error),
          },
        },
      )
      throw error
    }
    await this.#transition(record, "conflicted", {
      failure: {
        code: `${direction}_partial`,
        message: failureMessage(error),
      },
    })
    throw new ChangeSetConflictError(
      `Change set ${record.id} ${direction} left an ambiguous partial state`,
      { cause: error, changeSetId: record.id },
    )
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationQueue.then(operation, operation)
    this.#operationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * Revert the effective Nexus-owned changes created at or after a durable
 * checkpoint boundary. The batch compensates back to the original workspace
 * state when any member conflicts, so callers never rewind chat after a
 * merely partial file restore.
 */
export async function revertEffectiveChangeSetsAfter(input: {
  service: ChangeSetService
  sessionId: string
  createdAtOrAfter: number
}): Promise<ChangeSetBatchRevertResult> {
  if (
    !Number.isSafeInteger(input.createdAtOrAfter) ||
    input.createdAtOrAfter < 0
  ) {
    throw new RangeError(
      "Change-set restore boundary must be a non-negative safe integer",
    )
  }
  const recovered = await input.service.recoverInterrupted({
    sessionId: input.sessionId,
  })
  const recoveryConflicts = recovered.filter(
    (record) => record.state === "conflicted",
  )
  if (recoveryConflicts.length > 0) {
    return {
      status: "conflicted",
      reverted: [],
      conflicts: recoveryConflicts.map((record) => ({
        changeSetId: record.id,
        paths: record.files.map((file) => file.path),
        message:
          record.failure?.message ??
          "Interrupted change recovery is ambiguous",
      })),
    }
  }

  const records = (
    await input.service.listEffectiveApplied({
      sessionId: input.sessionId,
    })
  ).filter((record) => record.createdAt >= input.createdAtOrAfter)
  const reverted: ChangeSetRecord[] = []
  for (const record of [...records].reverse()) {
    try {
      const result = await input.service.revert(record.id)
      if (result.state !== "reverted") {
        throw new Error(
          `change set ${record.id} recovered to ${result.state}`,
        )
      }
      reverted.push(result)
    } catch (error) {
      const compensation = await reapplyRevertedChangeSets({
        service: input.service,
        reverted,
      })
      return {
        status: "conflicted",
        reverted: compensation.stillReverted,
        conflicts: [{
          changeSetId: record.id,
          paths: record.files.map((file) => file.path),
          message: failureMessage(error),
        }, ...compensation.conflicts],
      }
    }
  }
  return { status: "reverted", reverted }
}

/**
 * Compensation half of a two-phase chat+file rewind. Input records must be in
 * the newest-to-oldest order returned by `revertEffectiveChangeSetsAfter`.
 */
export async function reapplyRevertedChangeSets(input: {
  service: ChangeSetService
  reverted: readonly ChangeSetRecord[]
}): Promise<{
  readonly stillReverted: readonly ChangeSetRecord[]
  readonly conflicts: readonly ChangeSetBatchConflict[]
}> {
  const stillReverted = new Map(
    input.reverted.map((record) => [record.id, record] as const),
  )
  const conflicts: ChangeSetBatchConflict[] = []
  for (const record of [...input.reverted].reverse()) {
    try {
      const reapplied = await input.service.reapply(record.id)
      if (reapplied.state !== "applied") {
        throw new Error(
          `change set ${record.id} recovered to ${reapplied.state}`,
        )
      }
      stillReverted.delete(record.id)
    } catch (error) {
      conflicts.push({
        changeSetId: record.id,
        paths: record.files.map((file) => file.path),
        message:
          "Failed to compensate checkpoint restore: " +
          failureMessage(error),
      })
    }
  }
  return {
    stillReverted: [...stillReverted.values()],
    conflicts,
  }
}
