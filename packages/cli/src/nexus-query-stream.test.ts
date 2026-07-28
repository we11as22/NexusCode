import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  path.join(process.cwd(), "src", "nexus-query.ts"),
  "utf8",
)
const replSource = readFileSync(
  path.join(process.cwd(), "src", "screens", "REPL.tsx"),
  "utf8",
)

describe("CLI agent-event stream", () => {
  it("does not suppress legitimate events by content fingerprints", () => {
    const start = source.indexOf("function* drainQueue()")
    const end = source.indexOf("const modeMessage =", start)
    const body = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(body).not.toContain("seenRecently")
    expect(body).not.toContain("Coarse fingerprint")
    expect(body).not.toContain("(e.todo ?? '').length")
  })

  it("projects every task lifecycle event into the terminal surface", () => {
    for (const eventType of [
      "task_created",
      "task_updated",
      "task_progress",
      "task_tool_start",
      "task_tool_end",
      "task_completed",
      "background_task_updated",
    ]) {
      expect(source).toContain(`event.type === '${eventType}'`)
    }
  })

  it("does not expose mode cycling while a turn is active", () => {
    expect(replSource).toContain("nexusBootstrap && !isLoading")
  })

  it("replaces the live TUI with a bounded compaction boundary", () => {
    expect(source).toContain("type: 'nexus_session_sync'")
    expect(source).toContain("compactTimelineAfterBoundary(consumed)")
    expect(replSource.match(/message\.type === 'nexus_session_sync'/g)).toHaveLength(3)
  })
})
