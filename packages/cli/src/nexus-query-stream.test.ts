import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  path.join(process.cwd(), "src", "nexus-query.ts"),
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
})
