import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  path.join(
    process.cwd(),
    "src",
    "tools",
    "built-in",
    "orchestration-tools.ts",
  ),
  "utf8",
)

describe("remote session network boundary", () => {
  it("routes remote session HTTP through the bounded host-authorized broker", () => {
    const start = source.indexOf("const remoteSessionMessageSchema")
    const end = source.indexOf("const taskSnapshotSchema", start)
    const remoteTools = source.slice(start, end > start ? end : undefined)

    expect(remoteTools).toContain("requestNetworkResource(ctx.host")
    expect(remoteTools).toContain('purpose: "remote_session"')
    expect(remoteTools).toContain("maxRedirects: 0")
    expect(remoteTools).toContain("maxRequestBytes:")
    expect(remoteTools).toContain("maxResponseBytes:")
    expect(remoteTools).toContain("timeoutMs:")
    expect(remoteTools).toContain("signal: ctx.signal")
    expect(remoteTools).toContain("encodeURIComponent(sessionId)")
    expect(remoteTools).not.toMatch(/\bfetch\s*\(/)
  })
})
