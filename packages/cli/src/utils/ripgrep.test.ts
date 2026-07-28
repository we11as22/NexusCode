import path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveCliRuntimeRoot } from "./ripgrep.js"

describe("CLI ripgrep runtime root", () => {
  it("uses filesystem path resolution without the deprecated URL resolver", () => {
    expect(
      resolveCliRuntimeRoot("/repo/packages/cli/dist/cli.js", "production"),
    ).toBe(path.resolve("/repo/packages/cli/dist"))
    expect(
      resolveCliRuntimeRoot("/repo/packages/cli/src/utils/ripgrep.ts", "test"),
    ).toBe(path.resolve("/repo/packages/cli"))
  })
})
