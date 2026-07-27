import { describe, expect, it, vi } from "vitest"
import { type TurnRunnerResult } from "./session-coordinator.js"
import {
  deferred,
  FakeStorage,
  setup,
  text,
} from "./session-coordinator.test-support.js"

describe("SessionCoordinator recovery and lifecycle", () => {
  it("reconciles a lost finish reply without rejecting the accepted turn", async () => {
    const storage = new FakeStorage()
    const firstRun = deferred<TurnRunnerResult>()
    const secondRun = deferred<TurnRunnerResult>()
    let invocation = 0
    const { coordinator, contexts } = setup({
      storage,
      run: () => invocation++ === 0 ? firstRun.promise : secondRun.promise,
    })
    const first = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("first"),
    })
    await coordinator.queue({
      inputId: "turn-2",
      mode: "agent",
      parts: text("second"),
    })
    storage.finishFailure = "after_commit"

    firstRun.resolve({ status: "completed" })

    await expect(first.settled).resolves.toEqual({ status: "completed" })
    await vi.waitFor(() => expect(contexts).toHaveLength(2))
    expect(contexts[1]!.turnId).toBe("turn-2")

    secondRun.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("interrupts an ambiguously unfinished turn and continues its durable queue", async () => {
    const storage = new FakeStorage()
    const firstRun = deferred<TurnRunnerResult>()
    const secondRun = deferred<TurnRunnerResult>()
    let invocation = 0
    const { coordinator, contexts } = setup({
      storage,
      run: () => invocation++ === 0 ? firstRun.promise : secondRun.promise,
    })
    const first = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("first"),
    })
    await coordinator.queue({
      inputId: "turn-2",
      mode: "agent",
      parts: text("second"),
    })
    storage.finishFailure = "before_commit"

    firstRun.resolve({ status: "completed" })

    await expect(first.settled).resolves.toMatchObject({
      status: "interrupted",
    })
    await vi.waitFor(() => expect(contexts).toHaveLength(2))
    expect(contexts[1]!.turnId).toBe("turn-2")

    secondRun.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("reconciles an ambiguous settling phase instead of wedging the session", async () => {
    const storage = new FakeStorage()
    const firstRun = deferred<TurnRunnerResult>()
    const secondRun = deferred<TurnRunnerResult>()
    let invocation = 0
    const { coordinator, contexts } = setup({
      storage,
      run: () => invocation++ === 0 ? firstRun.promise : secondRun.promise,
    })
    const first = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("first"),
    })
    await coordinator.queue({
      inputId: "turn-2",
      mode: "agent",
      parts: text("second"),
    })
    storage.settlingPhaseFailure = "after_commit"

    firstRun.resolve({ status: "completed" })

    await expect(first.settled).resolves.toMatchObject({
      status: "interrupted",
    })
    await vi.waitFor(() => expect(contexts).toHaveLength(2))
    expect(contexts[1]!.turnId).toBe("turn-2")

    secondRun.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("reconciles a commit-unknown claim without replaying its runner", async () => {
    const storage = new FakeStorage()
    storage.claimFailureAfterCommit = true
    const nextRun = deferred<TurnRunnerResult>()
    const { coordinator, run, contexts } = setup({
      storage,
      run: () => nextRun.promise,
    })

    const ambiguous = await coordinator.start({
      inputId: "turn-ambiguous",
      mode: "agent",
      parts: text("must not replay"),
    })

    expect(ambiguous.started).toBe(false)
    await expect(ambiguous.settled).resolves.toMatchObject({
      status: "interrupted",
    })
    expect(run).not.toHaveBeenCalled()

    await coordinator.queue({
      inputId: "turn-next",
      mode: "agent",
      parts: text("safe next turn"),
    })
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(contexts[0]!.turnId).toBe("turn-next")

    nextRun.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("retries a claim after recovery proves the first attempt did not commit", async () => {
    const storage = new FakeStorage()
    storage.claimFailureBeforeCommit = true
    const running = deferred<TurnRunnerResult>()
    const { coordinator, contexts, run } = setup({
      storage,
      run: () => running.promise,
    })

    const handle = await coordinator.start({
      inputId: "turn-retry-safe-claim",
      mode: "agent",
      parts: text("retry only after durable reconciliation"),
    })

    expect(handle.started).toBe(true)
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(run).toHaveBeenCalledTimes(1)
    expect(contexts[0]!.turnId).toBe("turn-retry-safe-claim")

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("never publishes an external event before the matching repository commit", async () => {
    const storage = new FakeStorage()
    storage.admitGate = deferred<void>()
    const { coordinator, publish } = setup({ storage })

    const queued = coordinator.queue({
      inputId: "turn-gated",
      mode: "agent",
      parts: text("wait"),
    })
    await vi.waitFor(() =>
      expect(storage.order).toContain("admit:start:turn-gated"),
    )
    expect(publish).not.toHaveBeenCalled()

    storage.admitGate.resolve()
    await queued
    expect(storage.order).toContain("admit:commit:turn-gated")
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "input_admitted", inputId: "turn-gated" }),
    )
    await coordinator.close()
  })

  it("captures immutable configuration and context epochs once per turn", async () => {
    const runs = [
      deferred<TurnRunnerResult>(),
      deferred<TurnRunnerResult>(),
    ]
    let runIndex = 0
    let epochs = { configEpoch: 1, contextEpoch: 7 }
    const { coordinator, contexts, capture } = setup({
      capture: () => ({ ...epochs }),
      run: () => runs[runIndex++]!.promise,
    })
    const first = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("first"),
    })
    await coordinator.queue({
      inputId: "turn-2",
      mode: "agent",
      parts: text("second"),
    })
    epochs = { configEpoch: 2, contextEpoch: 8 }

    expect(contexts[0]!.epochs).toEqual({ configEpoch: 1, contextEpoch: 7 })
    expect(Object.isFrozen(contexts[0]!.epochs)).toBe(true)
    expect(capture).toHaveBeenCalledTimes(1)

    runs[0]!.resolve({ status: "completed" })
    await first.settled
    await vi.waitFor(() => expect(contexts).toHaveLength(2))
    expect(contexts[1]!.epochs).toEqual({ configEpoch: 2, contextEpoch: 8 })
    expect(capture).toHaveBeenCalledTimes(2)

    runs[1]!.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("delivers approval decisions only after durable resolution", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, storage, deliverApproval } = setup({
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })

    await coordinator.approve({
      approvalId: "approval-1",
      expectedTurnId: "turn-1",
      status: "approved",
    })

    expect(storage.approvals).toEqual([
      "turn-1:approval-1:approved",
    ])
    expect(deliverApproval).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedTurnId: "turn-1",
      approvalId: "approval-1",
      status: "approved",
    })
    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("reconciles a committed approval when its reply is lost", async () => {
    const storage = new FakeStorage()
    storage.approvalFailure = "after_commit"
    const running = deferred<TurnRunnerResult>()
    const { coordinator, deliverApproval } = setup({
      storage,
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "turn-approval-unknown",
      mode: "agent",
      parts: text("wait for approval"),
    })

    await expect(
      coordinator.approve({
        approvalId: "approval-unknown",
        expectedTurnId: "turn-approval-unknown",
        status: "approved",
      }),
    ).resolves.toBeUndefined()

    expect(storage.approvals).toEqual([
      "turn-approval-unknown:approval-unknown:approved",
    ])
    expect(deliverApproval).toHaveBeenCalledOnce()
    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("does not deliver an approval that durable reconciliation says was absent", async () => {
    const storage = new FakeStorage()
    storage.approvalFailure = "before_commit"
    const running = deferred<TurnRunnerResult>()
    const { coordinator, deliverApproval } = setup({
      storage,
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "turn-approval-retry",
      mode: "agent",
      parts: text("wait for approval"),
    })

    await expect(
      coordinator.approve({
        approvalId: "approval-retry",
        expectedTurnId: "turn-approval-retry",
        status: "approved",
      }),
    ).rejects.toThrow("approval failed before commit")
    expect(deliverApproval).not.toHaveBeenCalled()

    await coordinator.approve({
      approvalId: "approval-retry",
      expectedTurnId: "turn-approval-retry",
      status: "approved",
    })
    expect(deliverApproval).toHaveBeenCalledOnce()

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("keeps the mailbox live when the approval wake channel hangs", async () => {
    const running = deferred<TurnRunnerResult>()
    const deliveryGate = deferred<void>()
    const { coordinator, storage } = setup({
      run: () => running.promise,
      deliverApproval: () => deliveryGate.promise,
      approvalDeliveryTimeoutMs: 10,
    })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })

    const approval = coordinator.approve({
      approvalId: "approval-1",
      expectedTurnId: "turn-1",
      status: "approved",
    })
    const steering = coordinator.steer({
      inputId: "steer-after-approval",
      expectedTurnId: "turn-1",
      parts: text("continue"),
    })
    const outcome = await Promise.race([
      Promise.all([approval, steering]).then(() => "mailbox-live" as const),
      new Promise<"mailbox-blocked">((resolve) => {
        const timeout = setTimeout(() => resolve("mailbox-blocked"), 30)
        timeout.unref?.()
      }),
    ])

    deliveryGate.resolve()
    running.resolve({ status: "completed" })
    await coordinator.close()

    expect(outcome).toBe("mailbox-live")
    expect(storage.approvals).toEqual([
      "turn-1:approval-1:approved",
    ])
    expect(
      storage.inputs.some((input) => input.id === "steer-after-approval"),
    ).toBe(true)
  })

  it("keeps durable progress independent from disconnected event subscribers", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, contexts, storage, publishError, deliverApproval } =
      setup({
        run: () => running.promise,
        publish: async () => {
          throw new Error("subscriber disconnected")
        },
      })

    const handle = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })
    expect(contexts).toHaveLength(1)
    await coordinator.steer({
      inputId: "steer-1",
      expectedTurnId: "turn-1",
      parts: text("continue"),
    })
    await expect(contexts[0]!.safeBoundary()).resolves.toHaveLength(1)
    await coordinator.approve({
      approvalId: "approval-1",
      expectedTurnId: "turn-1",
      status: "approved",
    })
    expect(deliverApproval).toHaveBeenCalledTimes(1)

    running.resolve({ status: "completed" })
    await expect(handle.settled).resolves.toEqual({ status: "completed" })
    await expect(coordinator.snapshot()).resolves.toMatchObject({
      phase: "idle",
      activeTurn: undefined,
    })
    expect(storage.finished).toHaveLength(1)
    expect(publishError).toHaveBeenCalled()
    await coordinator.close()
  })

  it("aborts after a durable interrupt even when notification fails", async () => {
    const { coordinator, contexts, storage } = setup({
      publish: async () => {
        throw new Error("subscriber disconnected")
      },
      run: async (context) =>
        new Promise<TurnRunnerResult>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => resolve({ status: "interrupted" }),
            { once: true },
          )
        }),
    })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })

    await expect(
      coordinator.interrupt({ expectedTurnId: "turn-1" }),
    ).resolves.toBe(true)

    expect(contexts[0]!.signal.aborted).toBe(true)
    expect(storage.order.indexOf("interrupt:commit:turn-1")).toBeLessThan(
      storage.order.indexOf("finish:commit:turn-1"),
    )
    await coordinator.close()
  })

  it("abandons a live runner locally after ownership loss without stale durable writes", async () => {
    const { coordinator, contexts, storage } = setup({
      run: async (context) =>
        new Promise<TurnRunnerResult>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => resolve({ status: "interrupted" }),
            { once: true },
          )
        }),
    })
    const handle = await coordinator.start({
      inputId: "turn-lease-lost",
      mode: "agent",
      parts: text("must stop when fenced"),
    })

    await coordinator.abandon(new Error("lease ownership lost"))

    expect(contexts[0]?.signal.aborted).toBe(true)
    await expect(handle.settled).resolves.toEqual({
      status: "interrupted",
      error: "Workspace runtime lost session ownership",
    })
    expect(storage.finished).toEqual([])
    await expect(coordinator.close()).resolves.toBeUndefined()
  })

  it.each(["before_commit", "after_commit"] as const)(
    "reconciles a shutdown interrupt with a %s failure",
    async (failure) => {
      const storage = new FakeStorage()
      storage.interruptFailure = failure
      const { coordinator, contexts } = setup({
        storage,
        run: async (context) =>
          new Promise<TurnRunnerResult>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => resolve({ status: "interrupted" }),
              { once: true },
            )
          }),
      })
      const handle = await coordinator.start({
        inputId: `turn-close-${failure}`,
        mode: "agent",
        parts: text("close safely"),
      })

      await expect(coordinator.close()).resolves.toBeUndefined()

      expect(contexts[0]!.signal.aborted).toBe(true)
      await expect(handle.settled).resolves.toMatchObject({
        status: "interrupted",
      })
      expect(storage.finished.at(-1)?.turnId).toBe(handle.turnId)
    },
  )

  it("does not let a hung notification subscriber stall a committed turn", async () => {
    const { coordinator, run, storage } = setup({
      publish: () => new Promise<void>(() => {}),
    })

    const handle = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })

    await expect(handle.settled).resolves.toEqual({ status: "completed" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(storage.finished).toHaveLength(1)
    await coordinator.close()
  })

  it("atomically requeues steering accepted after the final safe boundary", async () => {
    const runs = [
      deferred<TurnRunnerResult>(),
      deferred<TurnRunnerResult>(),
    ]
    let runIndex = 0
    const { coordinator, contexts, publish } = setup({
      run: () => runs[runIndex++]!.promise,
    })
    const first = await coordinator.start({
      inputId: "turn-1",
      mode: "review",
      selection: {
        profileId: "profile-review",
        selectionEpoch: 11,
      },
      parts: text("start"),
    })
    const lateSteer = coordinator.steer({
      inputId: "steer-late",
      expectedTurnId: "turn-1",
      parts: text("late but durable"),
    })
    await lateSteer
    runs[0]!.resolve({ status: "completed" })

    await first.settled
    await vi.waitFor(() => expect(contexts).toHaveLength(2))
    expect(contexts[1]!.turnId).toBe("steer-late")
    expect(contexts[1]!.input.delivery).toBe("queue")
    expect(contexts[1]!.execution).toEqual({
      mode: "review",
      selection: {
        profileId: "profile-review",
        selectionEpoch: 11,
      },
    })
    expect(publish).toHaveBeenCalledWith({
      type: "steering_requeued",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-turn-1",
      inputIds: ["steer-late"],
    })

    runs[1]!.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("uses a bounded fenced hard-stop when a runner ignores abort", async () => {
    const { coordinator, storage, contexts } = setup({
      run: () => new Promise<TurnRunnerResult>(() => {}),
      shutdownTimeoutMs: 5,
    })
    const handle = await coordinator.start({
      inputId: "turn-stuck",
      mode: "agent",
      parts: text("start"),
    })

    await expect(
      coordinator.interrupt({ expectedTurnId: "turn-stuck" }),
    ).resolves.toBe(true)

    await expect(handle.settled).resolves.toMatchObject({
      status: "interrupted",
    })
    expect(contexts[0]!.signal.aborted).toBe(true)
    expect(storage.finished.at(-1)).toMatchObject({
      turnId: "turn-stuck",
      result: { status: "interrupted" },
    })
    await coordinator.close()
  })

  it("keeps the awaited hard-stop timer referenced until reconciliation", async () => {
    const timeoutMs = 37
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
    try {
      const { coordinator } = setup({
        run: () => new Promise<TurnRunnerResult>(() => {}),
        shutdownTimeoutMs: timeoutMs,
      })
      const handle = await coordinator.start({
        inputId: "turn-referenced-timeout",
        mode: "agent",
        parts: text("do not exit before the durable hard-stop"),
      })

      const interrupted = coordinator.interrupt({
        expectedTurnId: handle.turnId,
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const timeoutIndex = timeoutSpy.mock.calls.findIndex(
        ([, delay]) => delay === timeoutMs,
      )
      expect(timeoutIndex).toBeGreaterThanOrEqual(0)
      const timeout = timeoutSpy.mock.results[timeoutIndex]!
        .value as ReturnType<typeof setTimeout>
      expect(timeout.hasRef?.()).toBe(true)

      await expect(interrupted).resolves.toBe(true)
      await expect(handle.settled).resolves.toMatchObject({
        status: "interrupted",
      })
      await coordinator.close()
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it.each(["before_commit", "after_commit"] as const)(
    "reconciles a fenced hard-stop with a %s failure",
    async (failure) => {
      const storage = new FakeStorage()
      storage.finishFailure = failure
      const { coordinator } = setup({
        storage,
        run: () => new Promise<TurnRunnerResult>(() => {}),
        shutdownTimeoutMs: 5,
      })
      const handle = await coordinator.start({
        inputId: `turn-force-${failure}`,
        mode: "agent",
        parts: text("ignore abort"),
      })

      await expect(
        coordinator.interrupt({
          expectedTurnId: handle.turnId,
          reason: "force safely",
        }),
      ).resolves.toBe(true)

      await expect(handle.settled).resolves.toMatchObject({
        status: "interrupted",
      })
      expect(storage.finished.at(-1)?.turnId).toBe(handle.turnId)
      await coordinator.close()
    },
  )

  it("rejects in-process handles while preserving queued input on shutdown", async () => {
    const { coordinator, storage } = setup({
      run: () => new Promise<TurnRunnerResult>(() => {}),
      shutdownTimeoutMs: 5,
    })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })
    const queued = await coordinator.start({
      inputId: "turn-2",
      mode: "agent",
      parts: text("preserve"),
    })

    await coordinator.close()

    await expect(queued.settled).rejects.toMatchObject({ code: "closed" })
    expect(
      (await storage.snapshot("session-1")).pendingQueue.map((input) => input.id),
    ).toEqual(["turn-2"])
  })
})
