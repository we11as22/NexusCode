import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  path.join(process.cwd(), "src", "provider.ts"),
  "utf8",
)

describe("webview outbound buffering", () => {
  it("replays snapshots instead of duplicating them in the pending queue", () => {
    const start = source.indexOf("private queueMessageForWebview(")
    const end = source.indexOf(
      "private async flushPendingMessages(",
      start,
    )
    const body = source.slice(start, end)

    expect(body).toContain("REPLAYABLE_MESSAGE_TYPES.has(msg.type)")
    expect(body).toContain("MAX_PENDING_WEBVIEW_MESSAGES")
  })

  it("preserves the failed tail and concurrently arrived messages", () => {
    const start = source.indexOf("private async flushPendingMessages(")
    const end = source.indexOf("private rememberLatestMessage(", start)
    const body = source.slice(start, end)

    expect(body).toContain("...queued.slice(index)")
    expect(body).toContain("...arrived")
    expect(body).toContain(".slice(-MAX_PENDING_WEBVIEW_MESSAGES)")
  })
})
