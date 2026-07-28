import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const querySource = readFileSync(
  path.join(process.cwd(), "src", "nexus-query.ts"),
  "utf8",
)
const replSource = readFileSync(
  path.join(process.cwd(), "src", "screens", "REPL.tsx"),
  "utf8",
)
const entrypointSource = readFileSync(
  path.join(process.cwd(), "src", "entrypoints", "cli.tsx"),
  "utf8",
)

describe("CLI remote turn wiring", () => {
  it("restores the server-owned active mode before replaying events", () => {
    const resumeStart = querySource.indexOf("resumeRemoteCliTurn({")
    const resumeEnd = querySource.indexOf(
      "onRemoteResume?.(attached)",
      resumeStart,
    )
    const resumeBody = querySource.slice(resumeStart, resumeEnd)

    expect(resumeBody).toContain("onActiveExecution:")
    expect(resumeBody).toContain("nexus.mode = execution.mode")
    expect(resumeBody.indexOf("onActiveExecution:")).toBeLessThan(
      resumeBody.indexOf("deliver: deliverRemoteEvent"),
    )
  })

  it("persists admission before acknowledging live turn envelopes", () => {
    const liveStart = querySource.indexOf("await runRemoteCliTurn({")
    const liveEnd = querySource.indexOf(
      "if (!signal.aborted) await cursorStore.clear(sid)",
      liveStart,
    )
    const liveBody = querySource.slice(liveStart, liveEnd)

    expect(liveBody).toContain("afterSequence: acknowledgedSequence")
    expect(liveBody.indexOf("afterSequence: acknowledgedSequence")).toBeLessThan(
      liveBody.indexOf("onSequence: async (sequence)"),
    )
    expect(liveBody).toContain("prepared.afterSequence")
    expect(liveBody).toContain("await admissionCursorWrite")
  })

  it("reattaches before submitting an initial interactive prompt", () => {
    const initStart = replSource.indexOf("async function onInit()")
    const initEnd = replSource.indexOf(
      "async function processUserInput(",
      initStart,
    )
    const initBody = replSource.slice(initStart, initEnd)

    expect(initBody).toContain("await resumeActiveRemoteTurn()")
    expect(initBody.indexOf("await resumeActiveRemoteTurn()")).toBeLessThan(
      initBody.indexOf("processUserInput("),
    )
  })

  it("drains an active server turn before print-mode input", () => {
    const printStart = entrypointSource.indexOf("let lastAssistantText = ''")
    const printEnd = entrypointSource.indexOf(
      "console.log(lastAssistantText)",
      printStart,
    )
    const printBody = entrypointSource.slice(printStart, printEnd)

    expect(printBody).toContain("remoteResume: true")
    expect(printBody.indexOf("remoteResume: true")).toBeLessThan(
      printBody.indexOf("userPrompt: inputPrompt"),
    )
  })
})
