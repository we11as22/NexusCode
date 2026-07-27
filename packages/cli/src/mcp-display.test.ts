import { describe, expect, it } from "vitest"
import { coreMcpDisplayStatuses } from "./mcp-display.js"

describe("MCP display snapshots", () => {
  it("projects and sorts core statuses without exposing live clients", () => {
    expect(coreMcpDisplayStatuses({
      zeta: {
        name: "zeta",
        state: "needs_auth",
        toolCount: 0,
        updatedAt: 2,
        error: "Sign in required",
      },
      alpha: {
        name: "alpha",
        state: "connected",
        toolCount: 3,
        updatedAt: 1,
      },
    })).toEqual([
      { name: "alpha", state: "connected" },
      { name: "zeta", state: "needs_auth", error: "Sign in required" },
    ])
  })

})
