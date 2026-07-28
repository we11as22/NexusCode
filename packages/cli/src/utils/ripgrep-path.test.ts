import { describe, expect, it } from "vitest"
import { chooseRipgrepCommand } from "./ripgrep-path.js"

describe("CLI ripgrep resolution", () => {
  it("prefers a working system executable", () => {
    expect(
      chooseRipgrepCommand({
        systemExecutablePath: "/usr/local/bin/rg",
        bundledExecutablePath: "/bundle/rg",
        bundledExists: true,
        forceBundled: false,
      }),
    ).toEqual({
      command: "/usr/local/bin/rg",
      args: [],
      source: "system",
    })
  })

  it("uses the packaged binary when rg is absent from PATH", () => {
    expect(
      chooseRipgrepCommand({
        systemExecutablePath: "rg",
        bundledExecutablePath: "/bundle/rg",
        bundledExists: true,
        forceBundled: false,
      }),
    ).toEqual({
      command: "/bundle/rg",
      args: [],
      source: "bundled",
    })
  })

  it("fails explicitly when neither system nor packaged ripgrep exists", () => {
    expect(() =>
      chooseRipgrepCommand({
        systemExecutablePath: "rg",
        bundledExecutablePath: "/bundle/rg",
        bundledExists: false,
        forceBundled: false,
      }),
    ).toThrow(/ripgrep/i)
  })
})
