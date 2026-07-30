import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("workspace trust copy", () => {
  it("describes the installed native sandbox instead of claiming none exists", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./components/TrustDialog.tsx", import.meta.url)),
      "utf8",
    )

    expect(source).toContain("native OS sandbox")
    expect(source).not.toContain("it is not an OS-level sandbox")
  })
})
