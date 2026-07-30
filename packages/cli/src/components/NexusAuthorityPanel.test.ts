import { describe, expect, it } from "vitest"

import { formatAuthorityRequestLabel } from "./NexusAuthorityPanel.js"

describe("formatAuthorityRequestLabel", () => {
  it("describes the request without exposing its internal fingerprint", () => {
    const fingerprint = "f".repeat(64)
    const request = {
      kind: "custom-tools",
      fingerprint,
      payload: { name: "local-tools" },
    }
    const label = formatAuthorityRequestLabel(request)

    expect(label).toBe("custom-tools")
    expect(label).not.toContain(fingerprint)
  })
})
