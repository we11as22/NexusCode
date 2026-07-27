import { describe, expect, it, vi } from "vitest"
import {
  SessionCoordinator,
  SessionCoordinatorError,
  type AdmittedSessionInput,
  type TurnRunnerContext,
  type TurnRunnerResult,
} from "./session-coordinator.js"
import {
  deferred,
  FakeStorage,
  setup,
  text,
} from "./session-coordinator.test-support.js"

describe("SessionCoordinator", () => {
  it("rejects an incompatible durable storage port before accepting work", () => {
    const storage = new FakeStorage()
    Object.defineProperty(storage, "portVersion", { value: 2 })

    expect(() => setup({ storage })).toThrow(/storage port version/i)
  })

  it("returns the durable reserved turn identity and freezes execution policy at admission", async () => {
    const storage = new FakeStorage()
    storage.reservedTurnIds.set("input-1", "reserved-turn-1")
    const { coordinator, contexts } = setup({ storage })
    const selection = {
      profileId: "profile-main",
      selectionEpoch: 7,
    }

    const started = coordinator.start({
      inputId: "input-1",
      mode: "plan",
      selection,
      parts: text("inspect"),
    })
    selection.profileId = "mutated-after-admission"
    selection.selectionEpoch = 99
    const handle = await started
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    await coordinator.close()

    expect(handle.turnId).toBe("reserved-turn-1")
    await expect(handle.settled).resolves.toEqual({ status: "completed" })
    expect(contexts[0]!.turnId).toBe("reserved-turn-1")
    expect(contexts[0]!.execution).toEqual({
      mode: "plan",
      selection: {
        profileId: "profile-main",
        selectionEpoch: 7,
      },
    })
    expect(Object.isFrozen(contexts[0]!.execution)).toBe(true)
    expect(Object.isFrozen(contexts[0]!.execution.selection)).toBe(true)
  })

  it("accepts a durable next-mode override only when model selection is preserved", async () => {
    const storage = new FakeStorage()
    storage.claimExecutionOverride = {
      mode: "plan",
      selection: {
        profileId: "profile-main",
        selectionEpoch: 7,
      },
    }
    storage.claimModeOverride = { requestedByTurnId: "previous-turn" }
    const { coordinator, contexts } = setup({ storage })

    const handle = await coordinator.start({
      inputId: "input-next-mode",
      mode: "agent",
      selection: {
        profileId: "profile-main",
        selectionEpoch: 7,
      },
      parts: text("continue in plan mode"),
    })
    await handle.settled
    await coordinator.close()

    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.input.execution.mode).toBe("agent")
    expect(contexts[0]!.execution).toEqual({
      mode: "plan",
      selection: {
        profileId: "profile-main",
        selectionEpoch: 7,
      },
    })
  })

  it("rejects a durable mode override that changes model selection", async () => {
    const storage = new FakeStorage()
    storage.claimExecutionOverride = {
      mode: "plan",
      selection: {
        profileId: "profile-other",
        selectionEpoch: 8,
      },
    }
    storage.claimModeOverride = { requestedByTurnId: "previous-turn" }
    const { coordinator, contexts } = setup({ storage })

    await expect(
      coordinator.start({
        inputId: "input-selection-drift",
        mode: "agent",
        selection: {
          profileId: "profile-main",
          selectionEpoch: 7,
        },
        parts: text("must preserve the admitted selection"),
      }),
    ).rejects.toThrow(/invalid or stale snapshot/i)
    expect(contexts).toHaveLength(0)
    await coordinator.close()
  })

  it("keeps the durable run identity allocated at admission through the runner", async () => {
    const storage = new FakeStorage()
    storage.reservedTurnIds.set("input-with-run", "turn-durable")
    storage.reservedRunIds.set("input-with-run", "run-durable")
    const running = deferred<TurnRunnerResult>()
    const { coordinator, contexts } = setup({
      storage,
      run: () => running.promise,
    })

    const handle = await coordinator.start({
      inputId: "input-with-run",
      mode: "agent",
      parts: text("preserve both identities"),
    })

    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(
      (handle as typeof handle & { readonly runId?: string }).runId,
    ).toBe("run-durable")
    expect(
      (contexts[0] as TurnRunnerContext & { readonly runId?: string }).runId,
    ).toBe("run-durable")
    expect(
      (
        contexts[0]!.input as AdmittedSessionInput & {
          readonly reservedRunId?: string
        }
      ).reservedRunId,
    ).toBe("run-durable")

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("rejects an idempotent input retry with a different execution policy", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, storage } = setup({
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "input-stable",
      mode: "agent",
      selection: {
        profileId: "profile-main",
        selectionEpoch: 1,
      },
      parts: text("same prompt"),
    })

    await expect(
      coordinator.start({
        inputId: "input-stable",
        mode: "plan",
        selection: {
          profileId: "profile-other",
          selectionEpoch: 2,
        },
        parts: text("same prompt"),
      }),
    ).rejects.toThrow(/idempotency mismatch/i)
    expect(storage.inputs).toHaveLength(1)

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("serializes simultaneous starts and leaves the second input durably queued", async () => {
    const firstRun = deferred<TurnRunnerResult>()
    const { coordinator, storage, run } = setup({
      run: () => firstRun.promise,
    })

    const [first, second] = await Promise.all([
      coordinator.start({
        inputId: "turn-1",
        mode: "agent",
        parts: text("one"),
      }),
      coordinator.start({
        inputId: "turn-2",
        mode: "agent",
        parts: text("two"),
      }),
    ])

    expect(first.started).toBe(true)
    expect(second.started).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(storage.activeTurn?.turnId).toBe("turn-1")
    expect((await storage.snapshot("session-1")).pendingQueue.map((item) => item.id))
      .toEqual(["turn-2"])

    firstRun.resolve({ status: "completed" })
    await first.settled
    await coordinator.close()
  })

  it("fails closed when distinct inputs receive the same reserved turn identity", async () => {
    const storage = new FakeStorage()
    storage.reservedTurnIds.set("input-first", "turn-collision")
    storage.reservedRunIds.set("input-first", "run-first")
    storage.reservedTurnIds.set("input-second", "turn-collision")
    storage.reservedRunIds.set("input-second", "run-second")
    const running = deferred<TurnRunnerResult>()
    const { coordinator, run } = setup({
      storage,
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "input-first",
      mode: "agent",
      parts: text("first"),
    })

    await expect(
      coordinator.start({
        inputId: "input-second",
        mode: "agent",
        parts: text("must never share a settlement"),
      }),
    ).rejects.toMatchObject({
      code: "turn_conflict",
    })
    expect(run).toHaveBeenCalledTimes(1)

    running.resolve({ status: "completed" })
    await vi.waitFor(() => expect(storage.finished).toHaveLength(1))
    expect(run).toHaveBeenCalledTimes(1)
    await coordinator.close()
  })

  it("fails closed when distinct turns receive the same reserved run identity", async () => {
    const storage = new FakeStorage()
    storage.reservedRunIds.set("run-owner-first", "run-collision")
    storage.reservedRunIds.set("run-owner-second", "run-collision")
    const running = deferred<TurnRunnerResult>()
    const { coordinator, run } = setup({
      storage,
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "run-owner-first",
      mode: "agent",
      parts: text("first"),
    })

    await expect(
      coordinator.start({
        inputId: "run-owner-second",
        mode: "agent",
        parts: text("must not share a run"),
      }),
    ).rejects.toMatchObject({ code: "turn_conflict" })
    expect(run).toHaveBeenCalledTimes(1)

    running.resolve({ status: "completed" })
    await vi.waitFor(() => expect(storage.finished).toHaveLength(1))
    await coordinator.close()
  })

  it("rejects an idempotent input retry that changes its reserved identities", async () => {
    const storage = new FakeStorage()
    storage.reservedTurnIds.set("stable-input", "stable-turn")
    storage.reservedRunIds.set("stable-input", "stable-run")
    const running = deferred<TurnRunnerResult>()
    const { coordinator } = setup({
      storage,
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "stable-input",
      mode: "agent",
      parts: text("same request"),
    })
    storage.inputs.splice(0, storage.inputs.length)
    storage.reservedTurnIds.set("stable-input", "changed-turn")
    storage.reservedRunIds.set("stable-input", "changed-run")

    await expect(
      coordinator.start({
        inputId: "stable-input",
        mode: "agent",
        parts: text("same request"),
      }),
    ).rejects.toMatchObject({ code: "turn_conflict" })

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("fails closed on duplicate durable identities discovered during recovery", async () => {
    const storage = new FakeStorage()
    storage.inputs.push(
      {
        id: "persisted-first",
        reservedTurnId: "persisted-collision",
        reservedRunId: "persisted-run-first",
        sessionId: "session-1",
        delivery: "queue",
        parts: text("first"),
        execution: { mode: "agent" },
        admittedSequence: 1,
      },
      {
        id: "persisted-second",
        reservedTurnId: "persisted-collision",
        reservedRunId: "persisted-run-second",
        sessionId: "session-1",
        delivery: "queue",
        parts: text("second"),
        execution: { mode: "agent" },
        admittedSequence: 2,
      },
    )
    const { coordinator, run } = setup({ storage })

    await expect(coordinator.recover()).rejects.toMatchObject({
      code: "turn_conflict",
    })
    expect(run).not.toHaveBeenCalled()
    await expect(
      coordinator.queue({
        inputId: "must-not-start",
        mode: "agent",
        parts: text("blocked after collision"),
      }),
    ).rejects.toMatchObject({ code: "turn_conflict" })
  })

  it("rejects mismatched steering before admitting it and keeps the mailbox usable", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, storage } = setup({ run: () => running.promise })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })

    await expect(
      coordinator.steer({
        inputId: "steer-wrong",
        expectedTurnId: "turn-other",
        parts: text("wrong"),
      }),
    ).rejects.toMatchObject({
      code: "turn_conflict",
    } satisfies Partial<SessionCoordinatorError>)
    expect(storage.inputs.some((input) => input.id === "steer-wrong")).toBe(false)

    await expect(
      coordinator.steer({
        inputId: "steer-right",
        expectedTurnId: "turn-1",
        parts: text("right"),
      }),
    ).resolves.toMatchObject({ id: "steer-right" })

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("rejects direct steering that changes the active execution policy", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, storage } = setup({ run: () => running.promise })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      selection: {
        profileId: "profile-active",
        selectionEpoch: 4,
      },
      parts: text("start"),
    })

    await expect(
      coordinator.admit({
        inputId: "steer-policy-bypass",
        delivery: "steer",
        expectedTurnId: "turn-1",
        parts: text("switch policy"),
        execution: {
          mode: "plan",
          selection: {
            profileId: "profile-other",
            selectionEpoch: 5,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "execution_conflict",
    })
    expect(
      storage.inputs.some((input) => input.id === "steer-policy-bypass"),
    ).toBe(false)

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("publishes both reserved and target identities for admitted steering", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, publish } = setup({ run: () => running.promise })
    await coordinator.start({
      inputId: "turn-steer-target",
      mode: "agent",
      parts: text("start"),
    })

    await coordinator.steer({
      inputId: "steer-with-identities",
      expectedTurnId: "turn-steer-target",
      parts: text("continue"),
    })

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input_admitted",
        inputId: "steer-with-identities",
        turnId: "steer-with-identities",
        runId: "run-steer-with-identities",
        expectedTurnId: "turn-steer-target",
      }),
    )
    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("promotes a fixed FIFO steering cutoff only at an explicit safe boundary", async () => {
    const running = deferred<TurnRunnerResult>()
    const { coordinator, storage, contexts } = setup({
      run: () => running.promise,
    })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("start"),
    })
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    await coordinator.steer({
      inputId: "steer-1",
      expectedTurnId: "turn-1",
      parts: text("first"),
    })

    expect(storage.inputs.find((input) => input.id === "steer-1")?.promotedSequence)
      .toBeUndefined()
    const firstBoundary = contexts[0]!.safeBoundary()
    const laterSteer = coordinator.steer({
      inputId: "steer-2",
      expectedTurnId: "turn-1",
      parts: text("second"),
    })
    expect((await firstBoundary).map((input) => input.id)).toEqual(["steer-1"])
    await laterSteer
    expect(
      (await contexts[0]!.safeBoundary()).map((input) => input.id),
    ).toEqual(["steer-2"])

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("starts a queued input as a distinct turn after the active turn settles", async () => {
    const runs = [
      deferred<TurnRunnerResult>(),
      deferred<TurnRunnerResult>(),
    ]
    let runIndex = 0
    const { coordinator, contexts, run } = setup({
      run: () => runs[runIndex++]!.promise,
    })
    const first = await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("first"),
    })
    const queued = await coordinator.queue({
      inputId: "turn-2",
      mode: "agent",
      parts: text("follow-up"),
    })

    expect(queued.promotedSequence).toBeUndefined()
    runs[0]!.resolve({ status: "completed" })
    await first.settled
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(contexts.map((context) => context.turnId)).toEqual(["turn-1", "turn-2"])

    runs[1]!.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("commits interrupt intent before aborting and preserves queued work", async () => {
    const storage = new FakeStorage()
    storage.interruptGate = deferred<void>()
    const secondRun = deferred<TurnRunnerResult>()
    let invocation = 0
    const { coordinator, contexts, run } = setup({
      storage,
      run: async (context) => {
        invocation++
        if (invocation === 1) {
          return new Promise<TurnRunnerResult>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                storage.order.push(`runner:abort:${context.turnId}`)
                resolve({ status: "interrupted" })
              },
              { once: true },
            )
          })
        }
        return secondRun.promise
      },
    })
    await coordinator.start({
      inputId: "turn-1",
      mode: "agent",
      parts: text("first"),
    })
    await coordinator.queue({
      inputId: "turn-2",
      mode: "agent",
      parts: text("keep me"),
    })

    const interrupted = coordinator.interrupt({
      expectedTurnId: "turn-1",
      reason: "user",
    })
    await vi.waitFor(() =>
      expect(storage.order).toContain("interrupt:start:turn-1"),
    )
    expect(contexts[0]!.signal.aborted).toBe(false)
    storage.interruptGate.resolve()

    await expect(interrupted).resolves.toBe(true)
    expect(storage.order.indexOf("interrupt:commit:turn-1")).toBeLessThan(
      storage.order.indexOf("runner:abort:turn-1"),
    )
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(contexts[1]!.turnId).toBe("turn-2")

    secondRun.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("settles as interrupted when the runner finishes during interrupt commit", async () => {
    const storage = new FakeStorage()
    storage.interruptGate = deferred<void>()
    const running = deferred<TurnRunnerResult>()
    const { coordinator, contexts } = setup({
      storage,
      run: () => running.promise,
    })
    const handle = await coordinator.start({
      inputId: "turn-racing-interrupt",
      mode: "agent",
      parts: text("finish while interrupt commits"),
    })

    const interrupted = coordinator.interrupt({
      expectedTurnId: handle.turnId,
      reason: "user stop wins after durable commit",
    })
    await vi.waitFor(() =>
      expect(storage.order).toContain(`interrupt:start:${handle.turnId}`),
    )
    running.resolve({ status: "completed" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(contexts[0]!.signal.aborted).toBe(false)

    storage.interruptGate.resolve()

    await expect(interrupted).resolves.toBe(true)
    await expect(handle.settled).resolves.toMatchObject({
      status: "interrupted",
    })
    expect(storage.finished.at(-1)?.result).toMatchObject({
      status: "interrupted",
    })
    await coordinator.close()
  })

  it("requires an expected turn identity for every external interrupt", async () => {
    const { coordinator, storage } = setup({
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
      inputId: "turn-required-interrupt-id",
      mode: "agent",
      parts: text("keep running"),
    })

    try {
      await expect(
        coordinator.interrupt(
          {} as Parameters<SessionCoordinator["interrupt"]>[0],
        ),
      ).rejects.toThrow(/expected turn id/i)
      expect(storage.order).not.toContain(
        "interrupt:start:turn-required-interrupt-id",
      )
    } finally {
      await coordinator.close()
    }
  })

  it.each(["before_commit", "after_commit"] as const)(
    "aborts first and durably reconciles an interrupt with a %s failure",
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
        inputId: `turn-interrupt-${failure}`,
        mode: "agent",
        parts: text("stop safely"),
      })

      try {
        await expect(
          coordinator.interrupt({
            expectedTurnId: handle.turnId,
            reason: "user requested stop",
          }),
        ).resolves.toBe(true)
        expect(contexts[0]!.signal.aborted).toBe(true)
        await expect(handle.settled).resolves.toMatchObject({
          status: "interrupted",
        })
        expect(storage.finished.at(-1)?.turnId).toBe(handle.turnId)
      } finally {
        await coordinator.close()
      }
    },
  )

  it("recovers ambiguous persisted execution as interrupted before new execution", async () => {
    const storage = new FakeStorage()
    const persisted: AdmittedSessionInput = {
      id: "orphan-turn",
      reservedTurnId: "orphan-turn",
      reservedRunId: "run-orphan-turn",
      sessionId: "session-1",
      delivery: "queue",
      parts: text("orphan"),
      execution: { mode: "agent" },
      admittedSequence: 1,
      promotedSequence: 1,
    }
    storage.inputs.push(persisted)
    storage.activeTurn = {
      turnId: persisted.id,
      runId: persisted.reservedRunId,
      input: persisted,
      phase: "executing_tools",
      epochs: { configEpoch: 4, contextEpoch: 9 },
      execution: persisted.execution,
      fence: { ownerId: "orphan-owner", leaseEpoch: 2 },
    }
    storage.phase = "executing_tools"
    const running = deferred<TurnRunnerResult>()
    const { coordinator, run, publish } = setup({
      storage,
      run: () => running.promise,
    })

    await coordinator.recover()

    expect(storage.finished).toEqual([
      {
        turnId: "orphan-turn",
        result: {
          status: "interrupted",
          error: "Recovered an ambiguous in-progress turn",
        },
      },
    ])
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn_finished",
        turnId: "orphan-turn",
        status: "interrupted",
      }),
    )
    await coordinator.start({
      inputId: "new-turn",
      mode: "agent",
      parts: text("new"),
    })
    expect(run).toHaveBeenCalledTimes(1)

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("fails closed when recovery leaves an ambiguous active turn", async () => {
    const storage = new FakeStorage()
    const persisted: AdmittedSessionInput = {
      id: "ambiguous-active-input",
      reservedTurnId: "ambiguous-active-turn",
      reservedRunId: "ambiguous-active-run",
      sessionId: "session-1",
      delivery: "queue",
      parts: text("must not replay"),
      execution: { mode: "agent" },
      admittedSequence: 1,
      promotedSequence: 1,
    }
    storage.inputs.push(persisted)
    storage.activeTurn = {
      turnId: persisted.reservedTurnId,
      runId: persisted.reservedRunId,
      input: persisted,
      phase: "executing_tools",
      epochs: { configEpoch: 1, contextEpoch: 1 },
      execution: persisted.execution,
      fence: { ownerId: "previous-owner", leaseEpoch: 2 },
    }
    storage.phase = "executing_tools"
    storage.recoverLeavesActiveTurn = true
    const { coordinator, run } = setup({ storage })

    await expect(coordinator.recover()).rejects.toMatchObject({
      code: "turn_conflict",
    })
    expect(run).not.toHaveBeenCalled()

    storage.recoverLeavesActiveTurn = false
    await expect(coordinator.recover()).resolves.toMatchObject({
      activeTurn: undefined,
      phase: "interrupted",
    })
    await coordinator.close()
  })

  it("launches durable queued work during recovery without a new command", async () => {
    const storage = new FakeStorage()
    storage.inputs.push({
      id: "queued-before-restart",
      reservedTurnId: "turn-before-restart",
      reservedRunId: "run-before-restart",
      sessionId: "session-1",
      delivery: "queue",
      parts: text("resume me"),
      execution: { mode: "agent" },
      admittedSequence: 1,
    })
    const running = deferred<TurnRunnerResult>()
    const { coordinator, contexts } = setup({
      storage,
      run: () => running.promise,
    })

    const snapshot = await coordinator.recover()

    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(contexts[0]!.turnId).toBe("turn-before-restart")
    expect(snapshot.activeTurn?.turnId).toBe("turn-before-restart")
    expect(snapshot.pendingQueue).toEqual([])

    running.resolve({ status: "completed" })
    await coordinator.close()
  })

  it("kicks durable queued work on the first snapshot after restart", async () => {
    const storage = new FakeStorage()
    storage.inputs.push({
      id: "queued-before-snapshot",
      reservedTurnId: "turn-before-snapshot",
      reservedRunId: "run-before-snapshot",
      sessionId: "session-1",
      delivery: "queue",
      parts: text("resume from snapshot"),
      execution: { mode: "agent" },
      admittedSequence: 1,
    })
    const running = deferred<TurnRunnerResult>()
    const { coordinator, contexts } = setup({
      storage,
      run: () => running.promise,
    })

    const snapshot = await coordinator.snapshot()

    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(snapshot.activeTurn?.turnId).toBe("turn-before-snapshot")

    running.resolve({ status: "completed" })
    await coordinator.close()
  })
})
