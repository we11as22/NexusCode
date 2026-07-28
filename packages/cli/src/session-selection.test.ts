import { describe, expect, it, vi } from "vitest"
import {
  cycleRuntimeMode,
  resolveRuntimeServerUrl,
  resolveRuntimeMode,
  selectSession,
} from "./session-selection.js"

describe("session selection", () => {
  it("prefers an explicit server URL and falls back to the environment", () => {
    expect(resolveRuntimeServerUrl(" http://explicit:4097 ", "http://env:4097"))
      .toBe("http://explicit:4097")
    expect(resolveRuntimeServerUrl(undefined, " http://env:4097 "))
      .toBe("http://env:4097")
    expect(resolveRuntimeServerUrl("", "  ")).toBeNull()
  })

  it("validates runtime modes instead of silently falling back", () => {
    expect(resolveRuntimeMode("review")).toBe("review")
    expect(() => resolveRuntimeMode("typo")).toThrow(
      "Invalid mode: typo",
    )
  })

  it("cycles through every supported interactive mode", () => {
    expect(cycleRuntimeMode("agent")).toBe("plan")
    expect(cycleRuntimeMode("plan")).toBe("ask")
    expect(cycleRuntimeMode("ask")).toBe("debug")
    expect(cycleRuntimeMode("debug")).toBe("review")
    expect(cycleRuntimeMode("review")).toBe("agent")
    expect(cycleRuntimeMode("unknown")).toBe("agent")
  })

  it("fails clearly when an explicitly requested session does not exist", async () => {
    await expect(selectSession({
      sessionId: "missing",
      continueSession: false,
      list: vi.fn(),
      load: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    })).rejects.toThrow('Session not found: missing')
  })

  it("continues the newest available session", async () => {
    const existing = { id: "latest" }
    const create = vi.fn()
    await expect(selectSession({
      continueSession: true,
      list: vi.fn().mockResolvedValue([{ id: "latest" }, { id: "older" }]),
      load: vi.fn().mockResolvedValue(existing),
      create,
    })).resolves.toBe(existing)
    expect(create).not.toHaveBeenCalled()
  })

  it("creates a session when there is nothing to continue", async () => {
    const created = { id: "new" }
    await expect(selectSession({
      continueSession: true,
      list: vi.fn().mockResolvedValue([]),
      load: vi.fn(),
      create: vi.fn().mockResolvedValue(created),
    })).resolves.toBe(created)
  })
})
