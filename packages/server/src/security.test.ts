import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  authorizeBearer,
  isLoopbackHost,
  isOriginAllowed,
  readServerSecurityOptions,
  resolveWorkspaceRoot,
} from "./security.js"

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-server-security-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("bearer authorization", () => {
  it("rejects missing, malformed, and incorrect credentials", () => {
    expect(authorizeBearer(undefined, "correct-token")).toBe(false)
    expect(authorizeBearer("correct-token", "correct-token")).toBe(false)
    expect(authorizeBearer("Basic correct-token", "correct-token")).toBe(false)
    expect(authorizeBearer("Bearer wrong-token", "correct-token")).toBe(false)
  })

  it("accepts only the exact bearer token", () => {
    expect(authorizeBearer("Bearer correct-token", "correct-token")).toBe(true)
    expect(authorizeBearer("bearer correct-token", "correct-token")).toBe(false)
    expect(authorizeBearer("Bearer correct-token ", "correct-token")).toBe(false)
  })
})

describe("workspace root confinement", () => {
  it("accepts the configured root and descendants", () => {
    const root = makeTempDir()
    const child = path.join(root, "packages", "core")
    fs.mkdirSync(child, { recursive: true })

    expect(resolveWorkspaceRoot(root, [root])).toBe(fs.realpathSync(root))
    expect(resolveWorkspaceRoot(child, [root])).toBe(fs.realpathSync(child))
    expect(resolveWorkspaceRoot(path.join(child, "future"), [root])).toBe(
      path.join(fs.realpathSync(child), "future"),
    )
  })

  it("rejects siblings, traversal, absolute outsiders, and empty allowlists", () => {
    const parent = makeTempDir()
    const root = path.join(parent, "allowed")
    const sibling = path.join(parent, "allowed-sibling")
    fs.mkdirSync(root)
    fs.mkdirSync(sibling)

    expect(() => resolveWorkspaceRoot(sibling, [root])).toThrow(/outside/i)
    expect(() => resolveWorkspaceRoot(path.join(root, "..", "allowed-sibling"), [root])).toThrow(/outside/i)
    expect(() => resolveWorkspaceRoot(os.tmpdir(), [root])).toThrow(/outside/i)
    expect(() => resolveWorkspaceRoot(root, [])).toThrow(/allowlist/i)
  })

  it("rejects an in-root symlink that resolves outside the root", () => {
    const parent = makeTempDir()
    const root = path.join(parent, "allowed")
    const outside = path.join(parent, "outside")
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, "escape"), "dir")

    expect(() => resolveWorkspaceRoot(path.join(root, "escape"), [root])).toThrow(
      /outside/i,
    )
  })
})

describe("origin policy", () => {
  it("allows non-browser clients and exact configured origins only", () => {
    const origins = ["http://127.0.0.1:3000", "vscode-webview://nexus"]
    expect(isOriginAllowed(undefined, origins)).toBe(true)
    expect(isOriginAllowed("http://127.0.0.1:3000", origins)).toBe(true)
    expect(isOriginAllowed("http://127.0.0.1:3000.evil.test", origins)).toBe(false)
    expect(isOriginAllowed("null", origins)).toBe(false)
  })

  it("parses explicit server security configuration and loopback hosts", () => {
    expect(() => readServerSecurityOptions({})).toThrow(/token/i)
    expect(() =>
      readServerSecurityOptions({ NEXUS_SERVER_TOKEN: "token" }),
    ).toThrow(/roots/i)

    const parsed = readServerSecurityOptions({
      NEXUS_SERVER_TOKEN: "configured-token",
      NEXUS_SERVER_ROOTS: ["/workspace/one", "/workspace/two"].join(
        path.delimiter,
      ),
      NEXUS_SERVER_ORIGINS: "https://one.example, https://two.example",
    })
    expect(parsed.token).toBe("configured-token")
    expect(parsed.workspaceRoots).toEqual(["/workspace/one", "/workspace/two"])
    expect(parsed.allowedOrigins).toEqual([
      "https://one.example",
      "https://two.example",
    ])
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
  })
})
