import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Session } from "./index.js"
import {
  getPlanContentForFollowup,
  getSessionModeForResume,
} from "./plan-followup.js"

describe("plan follow-up recovery", () => {
  it("prefers the durable session mode over legacy message inference", () => {
    const session = Session.createEphemeral(process.cwd())
    session.addMessage({ role: "user", content: "plan", mode: "plan" })
    session.setMode("agent")

    expect(getSessionModeForResume(session, "plan")).toBe("agent")
  })

  it("reads the exact most recently completed plan write instead of the first plan alphabetically", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-plan-followup-"))
    await mkdir(join(cwd, ".nexus", "plans"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "plans", "a-old.md"), "# Old plan\n")
    await writeFile(join(cwd, ".nexus", "plans", "z-current.md"), "# Current plan\n")

    const session = Session.createEphemeral(cwd)
    session.addMessage({ role: "user", content: "plan it", mode: "plan" })
    const assistant = session.addMessage({ role: "assistant", content: [] })
    session.addToolPart(assistant.id, {
      type: "tool",
      id: "write-current",
      tool: "Write",
      status: "completed",
      input: {
        file_path: ".nexus/plans/z-current.md",
        content: "# Current plan\n",
      },
    })
    session.addToolPart(assistant.id, {
      type: "tool",
      id: "plan-exit",
      tool: "PlanExit",
      status: "completed",
      input: { summary: "ready" },
    })

    await expect(getPlanContentForFollowup(session, cwd)).resolves.toBe(
      "# Current plan",
    )
  })

  it("does not follow a plan-file symlink outside the workspace plan directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-plan-symlink-"))
    const outside = await mkdtemp(join(tmpdir(), "nexus-plan-outside-"))
    await mkdir(join(cwd, ".nexus", "plans"), { recursive: true })
    await writeFile(join(outside, "secret.md"), "# Must not be read\n")
    await symlink(
      join(outside, "secret.md"),
      join(cwd, ".nexus", "plans", "linked.md"),
    )

    const session = Session.createEphemeral(cwd)
    const assistant = session.addMessage({ role: "assistant", content: [] })
    session.addToolPart(assistant.id, {
      type: "tool",
      id: "write-linked",
      tool: "Write",
      status: "completed",
      input: {
        file_path: ".nexus/plans/linked.md",
        content: "# Model input fallback must not override disk safety\n",
      },
    })
    session.addToolPart(assistant.id, {
      type: "tool",
      id: "plan-exit",
      tool: "PlanExit",
      status: "completed",
    })

    const recovered = await getPlanContentForFollowup(session, cwd)
    expect(recovered).not.toContain("Must not be read")
    expect(recovered).not.toContain("Model input fallback")
  })

  it("restores the mode recorded on the latest user turn", () => {
    const session = Session.createEphemeral("/tmp")
    session.addMessage({ role: "user", content: "inspect", mode: "ask" })
    session.addMessage({ role: "assistant", content: "answer" })
    session.addMessage({ role: "user", content: "plan", mode: "plan" })

    expect(getSessionModeForResume(session, "agent")).toBe("plan")
  })

  it("recovers legacy completed PlanExit sessions as plan mode", () => {
    const session = Session.createEphemeral("/tmp")
    session.addMessage({ role: "user", content: "legacy plan" })
    const assistant = session.addMessage({ role: "assistant", content: [] })
    session.addToolPart(assistant.id, {
      type: "tool",
      id: "legacy-plan-exit",
      tool: "PlanExit",
      status: "completed",
    })

    expect(getSessionModeForResume(session, "agent")).toBe("plan")
  })
})
