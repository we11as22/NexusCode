import { describe, expect, it } from "vitest"
import { isLikelySandboxDenied } from "./denial.js"

describe("isLikelySandboxDenied", () => {
  it.each([
    "Operation not permitted",
    "permission denied",
    "Read-only file system",
    "seccomp violation",
    "sandbox_apply failed",
    "landlock denied",
    "failed to write file",
  ])("recognizes Codex-compatible denial text: %s", (stderr) => {
    expect(
      isLikelySandboxDenied({
        sandbox: "seatbelt",
        exitCode: 1,
        stdout: "",
        stderr,
      }),
    ).toBe(true)
  })

  it("does not classify successful or unsandboxed output", () => {
    expect(
      isLikelySandboxDenied({
        sandbox: "seatbelt",
        exitCode: 0,
        stdout: "",
        stderr: "Operation not permitted",
      }),
    ).toBe(false)
    expect(
      isLikelySandboxDenied({
        sandbox: "none",
        exitCode: 1,
        stdout: "",
        stderr: "Operation not permitted",
      }),
    ).toBe(false)
  })

  it.each([2, 126, 127])("does not guess on quick-reject exit %d", (exitCode) => {
    expect(
      isLikelySandboxDenied({
        sandbox: "bwrap-seccomp",
        exitCode,
        stdout: "",
        stderr: "command failed",
      }),
    ).toBe(false)
  })

  it("recognizes Linux SIGSYS without denial text", () => {
    expect(
      isLikelySandboxDenied({
        sandbox: "bwrap-seccomp",
        exitCode: 128 + 31,
        stdout: "",
        stderr: "",
        platform: "linux",
      }),
    ).toBe(true)
  })
})
