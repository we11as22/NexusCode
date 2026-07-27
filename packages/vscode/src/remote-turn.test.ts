import { describe, expect, it } from "vitest"

import type {
  AgentEvent,
  PermissionResult,
} from "@nexuscode/core"
import {
  PROTOCOL_VERSION,
} from "@nexuscode/core"
import {
  VsCodeRemoteTurn,
  assertRemoteHostSelectionSupported,
  assertRemotePresetSupported,
  resumeVsCodeRemoteTurn,
  type VsCodeRemoteCursorRecord,
  type VsCodeRemoteCursorStore,
  type VsCodeRemoteAttachClient,
  type VsCodeRemoteTurnClient,
} from "./remote-turn.js"

function memoryCursorStore(initial?: VsCodeRemoteCursorRecord): {
  store: VsCodeRemoteCursorStore
  saves: VsCodeRemoteCursorRecord[]
  clears: string[]
} {
  let current = initial
  const saves: VsCodeRemoteCursorRecord[] = []
  const clears: string[] = []
  return {
    saves,
    clears,
    store: {
      async load() {
        return current
      },
      async save(_sessionId, record) {
        current = record
        saves.push(record)
      },
      async clear(sessionId) {
        current = undefined
        clears.push(sessionId)
      },
    },
  }
}

describe("VS Code remote protocol-v2 turn", () => {
  it("restores a pending approval after restart with exact protocol identity", async () => {
    const resolutions: string[] = []
    let attachedAfterSequence: number | undefined
    const client = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-pending",
          phase: "waiting_approval" as const,
          activeTurnId: "turn-pending",
          activeRunId: "run-pending",
          activeTurnFirstSequence: 2,
          activeExecution: { mode: "agent" as const },
          pendingApprovals: [{
            approvalId: "approval-pending",
            turnId: "turn-pending",
            toolName: "Bash",
            redactedSummary: "Run tests",
          }],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 6,
        }
      },
      async *attachSessionTurn(options: Parameters<
        NonNullable<VsCodeRemoteTurnClient["attachSessionTurn"]>
      >[0]) {
        attachedAfterSequence = options.afterSequence
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        options.onApproval?.({
          turnId: options.turnId,
          runId: options.runId,
          approvalId: "approval-pending",
          toolName: "Bash",
          redactedSummary: "Run tests",
        })
        yield {
          type: "tool_approval_needed" as const,
          partId: "part-pending",
          action: {
            type: "execute" as const,
            tool: "Bash",
            description: "Run tests",
          },
        }
      },
      async *runSessionTurn() {
        throw new Error("must not start")
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval(
        sessionId: string,
        turnId: string,
        approvalId: string,
        result: Pick<PermissionResult, "approved">,
      ) {
        resolutions.push(
          `${sessionId}:${turnId}:${approvalId}:${result.approved}`,
        )
      },
    }

    const attached = await resumeVsCodeRemoteTurn({
      client,
      sessionId: "session-pending",
      signal: new AbortController().signal,
      cursorStore: memoryCursorStore().store,
      deliver: async (event, turn) => {
        if (event.type === "tool_approval_needed") {
          await turn.resolveApproval(event.partId, { approved: false })
        }
      },
    })

    expect(attached).toBe(true)
    expect(attachedAfterSequence).toBe(1)
    expect(resolutions).toEqual([
      "session-pending:turn-pending:approval-pending:false",
    ])
  })

  it("replays a snapshotted turn which finishes before attach", async () => {
    let starts = 0
    let followedAcceptedTurn = false
    const events: AgentEvent[] = []
    const client = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-finish-race",
          phase: "streaming" as const,
          activeTurnId: "turn-finish-race",
          activeRunId: "run-finish-race",
          activeTurnFirstSequence: 2,
          activeExecution: { mode: "agent" as const },
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 4,
        }
      },
      async *attachSessionTurn(options: Parameters<
        NonNullable<VsCodeRemoteTurnClient["attachSessionTurn"]>
      >[0]) {
        followedAcceptedTurn = options.followAcceptedTurn === true
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        yield {
          type: "text_delta" as const,
          messageId: "message-finish-race",
          delta: "tail after snapshot",
        }
        await options.onSequence?.(6)
      },
      async *runSessionTurn() {
        starts++
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }

    await expect(
      resumeVsCodeRemoteTurn({
        client,
        sessionId: "session-finish-race",
        signal: new AbortController().signal,
        cursorStore: memoryCursorStore().store,
        deliver: (event) => {
          events.push(event)
        },
      }),
    ).resolves.toBe(true)
    expect(starts).toBe(0)
    expect(followedAcceptedTurn).toBe(true)
    expect(events).toEqual([{
      type: "text_delta",
      messageId: "message-finish-race",
      delta: "tail after snapshot",
    }])
  })

  it("resumes a streaming snapshot from its exact persisted cursor", async () => {
    let starts = 0
    let attached:
      | {
          sessionId: string
          turnId: string
          runId: string
          afterSequence?: number
        }
      | undefined
    const cursors = memoryCursorStore({
      turnId: "turn-resume",
      runId: "run-resume",
      afterSequence: 7,
    })
    const client: VsCodeRemoteAttachClient = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-resume",
          phase: "streaming",
          activeTurnId: "turn-resume",
          activeRunId: "run-resume",
          activeTurnFirstSequence: 3,
          activeExecution: {
            mode: "plan",
            selection: {
              profileId: "server-profile",
              selectionEpoch: 13,
            },
          },
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 11,
        }
      },
      async *attachSessionTurn(options) {
        attached = options
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        yield {
          type: "text_delta",
          messageId: "message-resume",
          delta: "continued",
        }
        await options.onSequence?.(9)
      },
      async *runSessionTurn() {
        starts++
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const events: AgentEvent[] = []
    const deliveryOrder: string[] = []

    await expect(
      resumeVsCodeRemoteTurn({
        client,
        sessionId: "session-resume",
        signal: new AbortController().signal,
        cursorStore: cursors.store,
        deliver: (event) => {
          deliveryOrder.push("event")
          events.push(event)
        },
        onActiveExecution: (execution) => {
          expect(execution).toEqual({
            mode: "plan",
            selection: {
              profileId: "server-profile",
              selectionEpoch: 13,
            },
          })
          deliveryOrder.push("execution")
        },
      }),
    ).resolves.toBe(true)

    expect(starts).toBe(0)
    expect(attached).toMatchObject({
      sessionId: "session-resume",
      turnId: "turn-resume",
      runId: "run-resume",
      afterSequence: 7,
    })
    expect(cursors.saves.at(-1)).toEqual({
      turnId: "turn-resume",
      runId: "run-resume",
      afterSequence: 9,
    })
    expect(cursors.clears).toEqual(["session-resume"])
    expect(events).toEqual([
      {
        type: "text_delta",
        messageId: "message-resume",
        delta: "continued",
      },
    ])
    expect(deliveryOrder).toEqual(["execution", "event"])
  })

  it("resumes its queued turn without attaching another active turn", async () => {
    let attached:
      | { turnId: string; runId: string; afterSequence?: number }
      | undefined
    const cursors = memoryCursorStore({
      turnId: "turn-queued",
      runId: "run-queued",
      afterSequence: 0,
    })
    const client: VsCodeRemoteAttachClient = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-queued",
          phase: "streaming",
          activeTurnId: "turn-other",
          activeRunId: "run-other",
          activeTurnFirstSequence: 2,
          activeExecution: { mode: "agent" },
          pendingApprovals: [],
          pendingTurns: [{
            inputId: "input-queued",
            turnId: "turn-queued",
            runId: "run-queued",
            admittedSequence: 2,
            execution: { mode: "review" },
          }],
          pendingQueueCount: 1,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 8,
        }
      },
      async *attachSessionTurn(options) {
        attached = options
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        yield {
          type: "text_delta",
          messageId: "message-queued",
          delta: "queued result",
        }
        await options.onSequence?.(12)
      },
      async *runSessionTurn() {
        throw new Error("must not start")
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const events: AgentEvent[] = []
    const executionModes: string[] = []

    await expect(resumeVsCodeRemoteTurn({
      client,
      sessionId: "session-queued",
      signal: new AbortController().signal,
      cursorStore: cursors.store,
      onActiveExecution: (execution) => {
        executionModes.push(execution.mode)
      },
      deliver: (event) => {
        events.push(event)
      },
    })).resolves.toBe(true)

    expect(attached).toMatchObject({
      turnId: "turn-queued",
      runId: "run-queued",
      afterSequence: 8,
      followAcceptedTurn: true,
    })
    expect(executionModes).toEqual(["review"])
    expect(events).toEqual([{
      type: "text_delta",
      messageId: "message-queued",
      delta: "queued result",
    }])
  })

  it("trusts its accepted identity when the bounded pending list is not exhaustive", async () => {
    let attached:
      | {
          turnId: string
          runId: string
          afterSequence?: number
          followAcceptedTurn?: boolean
        }
      | undefined
    const cursors = memoryCursorStore({
      turnId: "turn-outside-window",
      runId: "run-outside-window",
      afterSequence: 21,
    })
    const client: VsCodeRemoteAttachClient = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-bounded-queue",
          phase: "streaming",
          activeTurnId: "turn-active",
          activeRunId: "run-active",
          activeTurnFirstSequence: 20,
          activeExecution: { mode: "agent" },
          pendingApprovals: [],
          pendingTurns: [{
            inputId: "input-visible",
            turnId: "turn-visible",
            runId: "run-visible",
            admittedSequence: 21,
            execution: { mode: "review" },
          }],
          pendingQueueCount: 2,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 24,
        }
      },
      async *attachSessionTurn(options) {
        attached = options
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        yield {
          type: "text_delta",
          messageId: "message-hidden-queued",
          delta: "eventually admitted",
        }
        await options.onSequence?.(27)
      },
      async *runSessionTurn() {
        throw new Error("must not start")
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const executionModes: string[] = []
    const events: AgentEvent[] = []

    await expect(resumeVsCodeRemoteTurn({
      client,
      sessionId: "session-bounded-queue",
      signal: new AbortController().signal,
      cursorStore: cursors.store,
      onActiveExecution: (execution) => {
        executionModes.push(execution.mode)
      },
      deliver: (event) => {
        events.push(event)
      },
    })).resolves.toBe(true)

    expect(attached).toMatchObject({
      turnId: "turn-outside-window",
      runId: "run-outside-window",
      afterSequence: 21,
      followAcceptedTurn: true,
    })
    expect(executionModes).toEqual([])
    expect(events).toEqual([{
      type: "text_delta",
      messageId: "message-hidden-queued",
      delta: "eventually admitted",
    }])
    expect(cursors.clears).toEqual(["session-bounded-queue"])
  })

  it("reattaches the exact streaming turn and advances its persisted cursor without a start", async () => {
    let starts = 0
    let attached:
      | { sessionId: string; turnId: string; runId: string; afterSequence?: number }
      | undefined
    const sequences: number[] = []
    const client: VsCodeRemoteTurnClient = {
      async *attachSessionTurn(options) {
        attached = options
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        yield {
          type: "text_delta",
          messageId: "message-attach",
          delta: "continued",
        }
        await options.onSequence?.(12)
      },
      async *runSessionTurn() {
        starts++
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-attach",
    })
    const events: AgentEvent[] = []

    for await (const event of turn.attach({
      turnId: "turn-attach",
      runId: "run-attach",
      afterSequence: 11,
      signal: new AbortController().signal,
      onSequence: (sequence) => {
        sequences.push(sequence)
      },
    })) {
      events.push(event)
    }

    expect(starts).toBe(0)
    expect(attached).toMatchObject({
      sessionId: "session-attach",
      turnId: "turn-attach",
      runId: "run-attach",
      afterSequence: 11,
    })
    expect(events).toEqual([
      {
        type: "text_delta",
        messageId: "message-attach",
        delta: "continued",
      },
    ])
    expect(sequences).toEqual([12])
  })

  it("keeps preset semantics separate from server model-profile selection", () => {
    expect(() => assertRemotePresetSupported("Default")).not.toThrow()
    expect(() => assertRemotePresetSupported("  Default  ")).not.toThrow()
    expect(() => assertRemotePresetSupported("Review preset")).toThrow(
      /not supported.*server/i,
    )
  })

  it("rejects a local provider profile without an authoritative epoch", () => {
    expect(() => assertRemoteHostSelectionSupported(undefined)).not.toThrow()
    expect(() => assertRemoteHostSelectionSupported("")).not.toThrow()
    expect(() => assertRemoteHostSelectionSupported("quality")).toThrow(
      /server-owned.*selection epoch/i,
    )
  })

  it("starts with structured image input and no invented selection", async () => {
    let captured:
      | Parameters<VsCodeRemoteTurnClient["runSessionTurn"]>[0]
      | undefined
    const client: VsCodeRemoteTurnClient = {
      async *runSessionTurn(options) {
        captured = options
        options.onTurn?.({ turnId: "turn-image", runId: "run-image" })
        yield {
          type: "text_delta",
          messageId: "message-image",
          delta: "seen",
        }
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-image",
    })
    const events: AgentEvent[] = []

    for await (const event of turn.run({
      input: [
        { type: "text", text: "inspect" },
        {
          type: "image",
          mimeType: "image/png",
          data: "aGVsbG8=",
        },
      ],
      mode: "ask",
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(captured).toMatchObject({
      sessionId: "session-image",
      mode: "ask",
      input: [
        { type: "text", text: "inspect" },
        {
          type: "image",
          mimeType: "image/png",
          data: "aGVsbG8=",
        },
      ],
    })
    expect(captured).not.toHaveProperty("selection")
    expect(events).toHaveLength(1)
  })

  it("interrupts the exact turn once when cancellation precedes admission", async () => {
    const interrupts: string[] = []
    let admit!: () => void
    const admitted = new Promise<void>((resolve) => {
      admit = resolve
    })
    const client: VsCodeRemoteTurnClient = {
      async *runSessionTurn(options) {
        await admitted
        options.onTurn?.({ turnId: "turn-late", runId: "run-late" })
      },
      async interruptSessionTurn(sessionId, turnId, reason) {
        interrupts.push(`${sessionId}:${turnId}:${reason}`)
        return true
      },
      async resolveSessionApproval() {},
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-late",
    })
    const run = (async () => {
      for await (const _event of turn.run({
        input: [{ type: "text", text: "start" }],
        mode: "agent",
        signal: new AbortController().signal,
      })) {
        // Drain.
      }
    })()

    await turn.interrupt("user requested stop")
    admit()
    await run
    await turn.interrupt("duplicate")

    expect(interrupts).toEqual([
      "session-late:turn-late:user requested stop",
    ])
  })

  it("interrupts the admitted turn when the UI stops consuming early", async () => {
    const interrupts: string[] = []
    const client: VsCodeRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-consumer", runId: "run-consumer" })
        yield {
          type: "text_delta",
          messageId: "message-consumer",
          delta: "partial",
        }
        yield {
          type: "text_delta",
          messageId: "message-consumer",
          delta: "unread",
        }
      },
      async interruptSessionTurn(sessionId, turnId, reason) {
        interrupts.push(`${sessionId}:${turnId}:${reason}`)
        return true
      },
      async resolveSessionApproval() {},
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-consumer",
    })

    for await (const _event of turn.run({
      input: [{ type: "text", text: "start" }],
      mode: "agent",
      signal: new AbortController().signal,
    })) {
      break
    }

    expect(interrupts).toEqual([
      "session-consumer:turn-consumer:client stopped consuming the turn",
    ])
  })

  it("preserves a stream error when cleanup interruption also fails", async () => {
    const client: VsCodeRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-primary", runId: "run-primary" })
        if (options.sessionId) {
          throw new Error("primary stream failure")
        }
      },
      async interruptSessionTurn() {
        throw new Error("secondary interrupt failure")
      },
      async resolveSessionApproval() {},
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-primary",
    })

    await expect(
      (async () => {
        for await (const _event of turn.run({
          input: [{ type: "text", text: "start" }],
          mode: "agent",
          signal: new AbortController().signal,
        })) {
          // Drain.
        }
      })(),
    ).rejects.toThrow("primary stream failure")
  })

  it("rejects a stale UI part while resolving the active opaque approval id", async () => {
    const resolutions: Array<{
      turnId: string
      approvalId: string
      result: Pick<PermissionResult, "approved">
    }> = []
    let release!: () => void
    const resolved = new Promise<void>((resolve) => {
      release = resolve
    })
    const client: VsCodeRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-approval", runId: "run-approval" })
        options.onApproval?.({
          turnId: "turn-approval",
          runId: "run-approval",
          approvalId: "approval-opaque",
          toolName: "Bash",
          redactedSummary: "Run tests",
        })
        yield {
          type: "tool_approval_needed",
          partId: "part-current",
          action: {
            type: "execute",
            tool: "Bash",
            description: "Run tests",
          },
        }
        await resolved
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval(_sessionId, turnId, approvalId, result) {
        resolutions.push({ turnId, approvalId, result })
        release()
      },
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-approval",
    })
    const run = (async () => {
      for await (const event of turn.run({
        input: [{ type: "text", text: "run" }],
        mode: "agent",
        signal: new AbortController().signal,
      })) {
        if (event.type === "tool_approval_needed") {
          turn.bindApprovalPart(event.partId)
          await expect(
            turn.resolveApproval("part-stale", { approved: true }),
          ).resolves.toBe(false)
          await expect(
            turn.resolveApproval(event.partId, { approved: false }),
          ).resolves.toBe(true)
        }
      }
    })()

    await run

    expect(resolutions).toEqual([
      {
        turnId: "turn-approval",
        approvalId: "approval-opaque",
        result: { approved: false },
      },
    ])
  })

  it("interrupts the exact turn when approval delivery fails", async () => {
    const interrupts: string[] = []
    const client: VsCodeRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-failed", runId: "run-failed" })
        options.onApproval?.({
          turnId: "turn-failed",
          runId: "run-failed",
          approvalId: "approval-failed",
          toolName: "Bash",
          redactedSummary: "Run",
        })
        yield {
          type: "tool_approval_needed",
          partId: "part-failed",
          action: {
            type: "execute",
            tool: "Bash",
            description: "Run",
          },
        }
      },
      async interruptSessionTurn(sessionId, turnId, reason) {
        interrupts.push(`${sessionId}:${turnId}:${reason}`)
        return true
      },
      async resolveSessionApproval() {
        throw new Error("approval transport failed")
      },
    }
    const turn = new VsCodeRemoteTurn({
      client,
      sessionId: "session-failed",
    })

    for await (const event of turn.run({
      input: [{ type: "text", text: "run" }],
      mode: "agent",
      signal: new AbortController().signal,
    })) {
      if (event.type === "tool_approval_needed") {
        turn.bindApprovalPart(event.partId)
        await expect(
          turn.resolveApproval(event.partId, { approved: true }),
        ).rejects.toThrow("approval transport failed")
      }
    }

    expect(interrupts).toEqual([
      "session-failed:turn-failed:approval resolution failed",
    ])
  })
})
