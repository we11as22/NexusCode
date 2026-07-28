import type {
  ApprovalAction,
  PermissionResult,
} from "@nexuscode/core"
import { approvalActionsMatch } from "./approval-action-identity.js"

interface PendingApproval {
  readonly approvalId: string
  readonly turnId: string
  readonly action: ApprovalAction
  readonly promise: Promise<PermissionResult>
  readonly resolve: (result: PermissionResult) => void
  claimed: boolean
}

export class SessionApprovalBroker {
  readonly #pending = new Map<string, PendingApproval>()

  #key(turnId: string, approvalId: string): string {
    return `${turnId}\0${approvalId}`
  }

  register(input: {
    approvalId: string
    turnId: string
    action: ApprovalAction
  }): void {
    const key = this.#key(input.turnId, input.approvalId)
    const existing = this.#pending.get(key)
    if (existing) {
      if (
        existing.turnId !== input.turnId ||
        !approvalActionsMatch(existing.action, input.action)
      ) {
        throw new Error(
          `Approval ${input.approvalId} was registered with different content`,
        )
      }
      return
    }
    let resolve!: (result: PermissionResult) => void
    const promise = new Promise<PermissionResult>((done) => {
      resolve = done
    })
    this.#pending.set(key, {
      ...input,
      promise,
      resolve,
      claimed: false,
    })
  }

  async wait(
    turnId: string,
    action: ApprovalAction,
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    const pending = [...this.#pending.values()].find(
      (candidate) =>
        candidate.turnId === turnId &&
        !candidate.claimed &&
        approvalActionsMatch(candidate.action, action),
    )
    if (!pending || signal?.aborted) return { approved: false }
    pending.claimed = true
    let abortListener: (() => void) | undefined
    const aborted = new Promise<PermissionResult>((resolve) => {
      abortListener = () => resolve({ approved: false })
      signal?.addEventListener("abort", abortListener, { once: true })
    })
    try {
      return await Promise.race([pending.promise, aborted])
    } finally {
      if (abortListener) signal?.removeEventListener("abort", abortListener)
      this.#pending.delete(this.#key(pending.turnId, pending.approvalId))
    }
  }

  deliver(input: {
    expectedTurnId: string
    approvalId: string
    status: "approved" | "denied"
  }): void {
    const pending = this.#pending.get(
      this.#key(input.expectedTurnId, input.approvalId),
    )
    if (!pending) return
    pending.resolve({ approved: input.status === "approved" })
  }

  cancelRegistration(input: {
    turnId: string
    approvalId: string
  }): void {
    const key = this.#key(input.turnId, input.approvalId)
    const pending = this.#pending.get(key)
    if (!pending) return
    this.#pending.delete(key)
    pending.resolve({ approved: false })
  }

  cancelTurn(turnId: string): void {
    for (const [key, pending] of this.#pending) {
      if (pending.turnId !== turnId) continue
      this.#pending.delete(key)
      pending.resolve({ approved: false })
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      pending.resolve({ approved: false })
    }
    this.#pending.clear()
  }
}
