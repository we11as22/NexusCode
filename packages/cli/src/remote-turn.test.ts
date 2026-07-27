import { describe, expect, it } from "vitest"

import type {
  AgentEvent,
  PermissionResult,
} from "@nexuscode/core"
import {
  PROTOCOL_VERSION,
  SessionProtocolError,
} from "@nexuscode/core"
import {
  assertRemoteCliSelectionSupported,
  resumeRemoteCliTurn,
  runRemoteCliTurn,
  type CliRemoteAttachClient,
  type CliRemoteTurnClient,
  type RemoteTurnCursorRecord,
  type RemoteTurnCursorStore,
} from "./remote-turn.js"

function approvalEvent(partId = "part-visible"): AgentEvent {
  return {
    type: "tool_approval_needed",
    partId,
    action: {
      type: "execute",
      tool: "Bash",
      description: "Run tests",
    },
  }
}

function memoryCursorStore(initial?: RemoteTurnCursorRecord): {
  store: RemoteTurnCursorStore
  saves: RemoteTurnCursorRecord[]
  clears: string[]
} {
  let current = initial
  const saves: RemoteTurnCursorRecord[] = []
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

describe("remote CLI protocol-v2 turn", () => {
  it("reattaches a streaming turn from the persisted cursor without starting another turn", async () => {
    let startCalls = 0
    let attachedAfterSequence: number | undefined
    const client: CliRemoteAttachClient = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-resume",
          phase: "streaming",
          activeTurnId: "turn-resume",
          activeRunId: "run-resume",
          activeTurnFirstSequence: 3,
          activeExecution: {
            mode: "debug",
            selection: {
              profileId: "server-profile",
              selectionEpoch: 11,
            },
          },
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 8,
        }
      },
      async *attachSessionTurn(options) {
        attachedAfterSequence = options.afterSequence
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
        startCalls++
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const cursors = memoryCursorStore({
      turnId: "turn-resume",
      runId: "run-resume",
      afterSequence: 7,
    })
    const events: AgentEvent[] = []
    const deliveryOrder: string[] = []

    const attached = await resumeRemoteCliTurn({
      client,
      sessionId: "session-resume",
      signal: new AbortController().signal,
      deliver: (event) => {
        deliveryOrder.push("event")
        events.push(event)
      },
      onActiveExecution: (execution) => {
        expect(execution).toEqual({
          mode: "debug",
          selection: {
            profileId: "server-profile",
            selectionEpoch: 11,
          },
        })
        deliveryOrder.push("execution")
      },
      cursorStore: cursors.store,
    })

    expect(attached).toBe(true)
    expect(startCalls).toBe(0)
    expect(attachedAfterSequence).toBe(7)
    expect(events).toEqual([
      {
        type: "text_delta",
        messageId: "message-resume",
        delta: "continued",
      },
    ])
    expect(cursors.saves.at(-1)).toEqual({
      turnId: "turn-resume",
      runId: "run-resume",
      afterSequence: 9,
    })
    expect(cursors.clears).toEqual(["session-resume"])
    expect(deliveryOrder).toEqual(["execution", "event"])
  })

  it("restores a waiting approval and resolves its exact opaque identity", async () => {
    const approvalRef: {
      current: ((result: PermissionResult) => void) | null
    } = { current: null }
    const resolutions: string[] = []
    let attachedAfterSequence: number | undefined
    let release!: () => void
    const resolved = new Promise<void>((resolve) => {
      release = resolve
    })
    const client: CliRemoteAttachClient = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-approval-resume",
          phase: "waiting_approval",
          activeTurnId: "turn-approval-resume",
          activeRunId: "run-approval-resume",
          activeTurnFirstSequence: 2,
          activeExecution: { mode: "agent" },
          pendingApprovals: [{
            approvalId: "approval-resume-opaque",
            turnId: "turn-approval-resume",
            toolName: "Bash",
            redactedSummary: "Run tests",
          }],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 6,
        }
      },
      async *attachSessionTurn(options) {
        attachedAfterSequence = options.afterSequence
        options.onTurn?.({
          turnId: options.turnId,
          runId: options.runId,
        })
        options.onApproval?.({
          turnId: options.turnId,
          runId: options.runId,
          approvalId: "approval-resume-opaque",
          toolName: "Bash",
          redactedSummary: "Run tests",
        })
        yield approvalEvent("part-resume-visible")
        await resolved
      },
      async *runSessionTurn() {
        throw new Error("must not start")
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval(sessionId, turnId, approvalId, result) {
        resolutions.push(
          `${sessionId}:${turnId}:${approvalId}:${result.approved}`,
        )
        release()
      },
    }

    const attached = await resumeRemoteCliTurn({
      client,
      sessionId: "session-approval-resume",
      signal: new AbortController().signal,
      approvalRef,
      cursorStore: memoryCursorStore().store,
      deliver: (event) => {
        if (event.type === "tool_approval_needed") {
          approvalRef.current?.({ approved: false })
        }
      },
    })

    expect(attached).toBe(true)
    expect(attachedAfterSequence).toBe(1)
    expect(resolutions).toEqual([
      "session-approval-resume:turn-approval-resume:approval-resume-opaque:false",
    ])
  })

  it("treats a turn finishing between snapshot and attach as a clean resume race", async () => {
    let starts = 0
    const client: CliRemoteAttachClient = {
      async getSessionProtocolSnapshot() {
        return {
          version: PROTOCOL_VERSION,
          sessionId: "session-race",
          phase: "streaming",
          activeTurnId: "turn-race",
          activeRunId: "run-race",
          activeTurnFirstSequence: 2,
          activeExecution: { mode: "agent" },
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 4,
        }
      },
      async *attachSessionTurn() {
        throw new SessionProtocolError({
          code: "no_active_turn",
          message: "finished",
          retryable: false,
        })
      },
      async *runSessionTurn() {
        starts++
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }
    const cursors = memoryCursorStore()

    await expect(
      resumeRemoteCliTurn({
        client,
        sessionId: "session-race",
        signal: new AbortController().signal,
        deliver: () => {},
        cursorStore: cursors.store,
      }),
    ).resolves.toBe(false)

    expect(starts).toBe(0)
    expect(cursors.clears).toEqual(["session-race"])
  })

  it("rejects client-side model selection without a server selection epoch", () => {
    expect(() =>
      assertRemoteCliSelectionSupported({
        modelOverride: "openai/gpt-5",
      }),
    ).toThrow(/server-owned.*selection epoch/i)
    expect(() =>
      assertRemoteCliSelectionSupported({
        temperatureOverride: 0,
      }),
    ).toThrow(/server-owned.*selection epoch/i)
    expect(() => assertRemoteCliSelectionSupported({})).not.toThrow()
  })

  it("starts a v2 turn without inventing a preset or model selection", async () => {
    let capturedOptions:
      | Parameters<CliRemoteTurnClient["runSessionTurn"]>[0]
      | undefined
    const events: AgentEvent[] = []
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        capturedOptions = options
        options.onTurn?.({ turnId: "turn-1", runId: "run-1" })
        yield {
          type: "text_delta",
          messageId: "message-1",
          delta: "hello",
        }
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval() {},
    }

    await runRemoteCliTurn({
      client,
      sessionId: "session-1",
      input: [{ type: "text", text: "hello" }],
      mode: "agent",
      signal: new AbortController().signal,
      deliver: (event) => events.push(event),
    })

    expect(capturedOptions).toMatchObject({
      sessionId: "session-1",
      input: [{ type: "text", text: "hello" }],
      mode: "agent",
    })
    expect(capturedOptions).not.toHaveProperty("selection")
    expect(events).toEqual([
      {
        type: "text_delta",
        messageId: "message-1",
        delta: "hello",
      },
    ])
  })

  it("interrupts the exact admitted turn even when abort wins the admission race", async () => {
    const abortController = new AbortController()
    const interrupts: Array<{
      sessionId: string
      turnId: string
      reason?: string
    }> = []
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        abortController.abort()
        options.onTurn?.({ turnId: "turn-race", runId: "run-race" })
      },
      async interruptSessionTurn(sessionId, turnId, reason) {
        interrupts.push({ sessionId, turnId, reason })
        return true
      },
      async resolveSessionApproval() {},
    }

    await runRemoteCliTurn({
      client,
      sessionId: "session-race",
      input: [{ type: "text", text: "stop" }],
      mode: "agent",
      signal: abortController.signal,
      deliver: () => {},
    })

    expect(interrupts).toEqual([
      {
        sessionId: "session-race",
        turnId: "turn-race",
        reason: "client aborted the turn",
      },
    ])
  })

  it("interrupts the admitted turn when event delivery fails", async () => {
    const interrupts: string[] = []
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-delivery", runId: "run-delivery" })
        yield {
          type: "text_delta",
          messageId: "message-delivery",
          delta: "partial",
        }
      },
      async interruptSessionTurn(sessionId, turnId, reason) {
        interrupts.push(`${sessionId}:${turnId}:${reason}`)
        return true
      },
      async resolveSessionApproval() {},
    }

    await expect(
      runRemoteCliTurn({
        client,
        sessionId: "session-delivery",
        input: [{ type: "text", text: "hello" }],
        mode: "agent",
        signal: new AbortController().signal,
        deliver: () => {
          throw new Error("renderer failed")
        },
      }),
    ).rejects.toThrow("renderer failed")

    expect(interrupts).toEqual([
      "session-delivery:turn-delivery:client event delivery failed",
    ])
  })

  it("interrupts an admitted turn when the event stream fails", async () => {
    const interrupts: string[] = []
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-stream", runId: "run-stream" })
        if (options.sessionId) {
          throw new Error("stream failed")
        }
      },
      async interruptSessionTurn(sessionId, turnId, reason) {
        interrupts.push(`${sessionId}:${turnId}:${reason}`)
        return true
      },
      async resolveSessionApproval() {},
    }

    await expect(
      runRemoteCliTurn({
        client,
        sessionId: "session-stream",
        input: [{ type: "text", text: "hello" }],
        mode: "agent",
        signal: new AbortController().signal,
        deliver: () => {},
      }),
    ).rejects.toThrow("stream failed")

    expect(interrupts).toEqual([
      "session-stream:turn-stream:client lost the turn event stream",
    ])
  })

  it("preserves the primary stream error when cleanup interruption also fails", async () => {
    const client: CliRemoteTurnClient = {
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

    await expect(
      runRemoteCliTurn({
        client,
        sessionId: "session-primary",
        input: [{ type: "text", text: "hello" }],
        mode: "agent",
        signal: new AbortController().signal,
        deliver: () => {},
      }),
    ).rejects.toThrow("primary stream failure")
  })

  it("denies a headless approval with the protocol approval id, not the UI part id", async () => {
    const resolutions: Array<{
      sessionId: string
      turnId: string
      approvalId: string
      result: Pick<PermissionResult, "approved">
    }> = []
    let releaseApproval!: () => void
    const approvalResolved = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-approval", runId: "run-approval" })
        options.onApproval?.({
          turnId: "turn-approval",
          runId: "run-approval",
          approvalId: "approval-opaque",
          toolName: "Bash",
          redactedSummary: "Run tests",
        })
        yield approvalEvent("part-visible")
        await approvalResolved
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval(
        sessionId,
        turnId,
        approvalId,
        result,
      ) {
        resolutions.push({ sessionId, turnId, approvalId, result })
        releaseApproval()
      },
    }

    await runRemoteCliTurn({
      client,
      sessionId: "session-approval",
      input: [{ type: "text", text: "please run" }],
      mode: "agent",
      signal: new AbortController().signal,
      deliver: () => {},
    })

    expect(resolutions).toEqual([
      {
        sessionId: "session-approval",
        turnId: "turn-approval",
        approvalId: "approval-opaque",
        result: { approved: false },
      },
    ])
  })

  it("routes an interactive approval response through the exact active identity", async () => {
    const approvalRef: {
      current: ((result: PermissionResult) => void) | null
    } = { current: null }
    const resolutions: string[] = []
    let releaseApproval!: () => void
    const approvalResolved = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-interactive", runId: "run-2" })
        options.onApproval?.({
          turnId: "turn-interactive",
          runId: "run-2",
          approvalId: "approval-interactive",
          toolName: "Write",
          redactedSummary: "Update file",
        })
        yield approvalEvent("part-for-rendering")
        await approvalResolved
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval(_sessionId, turnId, approvalId, result) {
        resolutions.push(`${turnId}:${approvalId}:${result.approved}`)
        releaseApproval()
      },
    }

    await runRemoteCliTurn({
      client,
      sessionId: "session-interactive",
      input: [{ type: "text", text: "edit" }],
      mode: "agent",
      signal: new AbortController().signal,
      approvalRef,
      deliver: (event) => {
        if (event.type === "tool_approval_needed") {
          approvalRef.current?.({ approved: true })
        }
      },
    })

    expect(resolutions).toEqual([
      "turn-interactive:approval-interactive:true",
    ])
    expect(approvalRef.current).toBeNull()
  })

  it("allows the next approval after the prior response has been claimed", async () => {
    const approvalRef: {
      current: ((result: PermissionResult) => void) | null
    } = { current: null }
    let firstStarted!: () => void
    const firstWasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const resolutions: string[] = []
    const client: CliRemoteTurnClient = {
      async *runSessionTurn(options) {
        options.onTurn?.({ turnId: "turn-two", runId: "run-two" })
        options.onApproval?.({
          turnId: "turn-two",
          runId: "run-two",
          approvalId: "approval-one",
          toolName: "Bash",
          redactedSummary: "First",
        })
        yield approvalEvent("part-one")
        await firstWasStarted
        options.onApproval?.({
          turnId: "turn-two",
          runId: "run-two",
          approvalId: "approval-two",
          toolName: "Write",
          redactedSummary: "Second",
        })
        yield approvalEvent("part-two")
      },
      async interruptSessionTurn() {
        return true
      },
      async resolveSessionApproval(_sessionId, _turnId, approvalId) {
        resolutions.push(approvalId)
        if (approvalId === "approval-one") {
          firstStarted()
          await firstCanFinish
        } else {
          releaseFirst()
        }
      },
    }

    await runRemoteCliTurn({
      client,
      sessionId: "session-two",
      input: [{ type: "text", text: "continue" }],
      mode: "agent",
      signal: new AbortController().signal,
      approvalRef,
      deliver: (event) => {
        if (event.type === "tool_approval_needed") {
          approvalRef.current?.({ approved: true })
        }
      },
    })

    expect(resolutions).toEqual(["approval-one", "approval-two"])
  })
})
