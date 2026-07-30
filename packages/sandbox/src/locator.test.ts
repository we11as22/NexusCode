import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { resolveSandboxBinary, sandboxTarget } from "./locator.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture(platform: NodeJS.Platform = process.platform, arch = process.arch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-locator-"))
  roots.push(root)
  const target = sandboxTarget(platform, arch)
  const binaryName = platform === "win32" ? "nexus-sandbox.exe" : "nexus-sandbox"
  const binary = path.join(root, "vendor", target, binaryName)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, "fixture", { mode: 0o700 })
  fs.writeFileSync(
    path.join(path.dirname(binary), "SHA256SUMS.json"),
    JSON.stringify({
      schema: 1,
      target,
      files: {
        [binaryName]: createHash("sha256").update("fixture").digest("hex"),
      },
    }),
  )
  return { root, binary }
}

describe("sandboxTarget", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["linux", "x64", "linux-x64"],
    ["win32", "arm64", "win32-arm64"],
    ["win32", "x64", "win32-x64"],
  ] as const)("maps %s/%s", (platform, arch, expected) => {
    expect(sandboxTarget(platform, arch)).toBe(expected)
  })

  it("rejects unsupported targets", () => {
    expect(() => sandboxTarget("freebsd", "x64")).toThrow(/unsupported/i)
    expect(() => sandboxTarget("darwin", "ia32")).toThrow(/unsupported/i)
  })
})

describe("resolveSandboxBinary", () => {
  it("resolves only the expected binary under a trusted root", () => {
    const { root, binary } = fixture()
    expect(resolveSandboxBinary({ trustedRoots: [root] })).toBe(
      fs.realpathSync.native(binary),
    )
  })

  it("fails closed when the helper is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-missing-"))
    roots.push(root)
    expect(() => resolveSandboxBinary({ trustedRoots: [root] })).toThrow(
      /unavailable/i,
    )
  })

  it("rejects a helper whose bytes do not match the release manifest", () => {
    const { root, binary } = fixture()
    fs.appendFileSync(binary, "tampered")
    expect(() => resolveSandboxBinary({ trustedRoots: [root] })).toThrow(
      /integrity/i,
    )
  })

  it("verifies every native companion listed by the release manifest", () => {
    const { root, binary } = fixture()
    const directory = path.dirname(binary)
    const companion = path.join(directory, "nexus-bwrap")
    fs.writeFileSync(companion, "trusted companion", { mode: 0o700 })
    const manifestPath = path.join(directory, "SHA256SUMS.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>
    }
    manifest.files["nexus-bwrap"] = createHash("sha256")
      .update("trusted companion")
      .digest("hex")
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    fs.appendFileSync(companion, "tampered")

    expect(() => resolveSandboxBinary({ trustedRoots: [root] })).toThrow(
      /nexus-bwrap/u,
    )
  })

  it.skipIf(process.platform === "win32")(
    "rejects a symlink that escapes the trusted root",
    () => {
      const { root, binary } = fixture()
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-outside-"))
      roots.push(outsideRoot)
      const outside = path.join(outsideRoot, "nexus-sandbox")
      fs.writeFileSync(outside, "outside", { mode: 0o700 })
      fs.unlinkSync(binary)
      fs.symlinkSync(outside, binary)
      expect(() => resolveSandboxBinary({ trustedRoots: [root] })).toThrow(
        /trusted root/i,
      )
    },
  )

  it.skipIf(process.platform === "win32")(
    "rejects a non-executable Unix helper",
    () => {
      const { root, binary } = fixture()
      fs.chmodSync(binary, 0o600)
      expect(() => resolveSandboxBinary({ trustedRoots: [root] })).toThrow(
        /executable/i,
      )
    },
  )
})
