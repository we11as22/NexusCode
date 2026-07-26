import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createApp } from "./app.js"
import { ServerHost } from "./host.js"
import { enforceServerPermissionBoundary } from "./run-session.js"
import { NexusConfigSchema, type NexusConfig } from "@nexuscode/core"

const token = "server-test-token"
let root = ""
let outside = ""

beforeAll(() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-server-app-"))
  root = path.join(parent, "allowed")
  outside = path.join(parent, "outside")
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
})

afterAll(() => {
  if (root) fs.rmSync(path.dirname(root), { recursive: true, force: true })
})

function app() {
  return createApp({
    token,
    allowedOrigins: ["https://trusted.example"],
    workspaceRoots: [root],
  })
}

function authHeaders(directory = root): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-nexus-directory": directory,
  }
}

describe("server boundary", () => {
  it("keeps health public without exposing configuration", async () => {
    const response = await app().request("/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it("rejects every unauthenticated session operation", async () => {
    const requests = [
      new Request("http://localhost/session"),
      new Request("http://localhost/session", { method: "POST", body: "{}" }),
      new Request("http://localhost/session/session_test/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      }),
      new Request("http://localhost/session/session_test", {
        method: "DELETE",
      }),
    ]

    for (const request of requests) {
      expect((await app().request(request)).status).toBe(401)
    }
  })

  it("rejects wrong browser origins and outside workspaces", async () => {
    const wrongOrigin = await app().request("/session", {
      headers: {
        ...authHeaders(),
        Origin: "https://evil.example",
      },
    })
    expect(wrongOrigin.status).toBe(403)

    const outsideRoot = await app().request("/session", {
      headers: authHeaders(outside),
    })
    expect(outsideRoot.status).toBe(403)
  })

  it("allows authenticated requests inside a configured workspace", async () => {
    const response = await app().request("/session", {
      headers: {
        ...authHeaders(),
        Origin: "https://trusted.example",
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://trusted.example",
    )
  })

  it("rejects unsafe session identifiers before they reach storage", async () => {
    const response = await app().request("/session/%2e%2e%5cescape", {
      headers: authHeaders(),
    })
    expect(response.status).toBe(400)
  })

  it("does not auto-approve privileged server tool calls", async () => {
    const host = new ServerHost(root, () => {})

    await expect(
      host.showApprovalDialog({
        type: "execute",
        tool: "Bash",
        description: "run command",
      }),
    ).resolves.toEqual({ approved: false })

    const hardened = enforceServerPermissionBoundary(
      NexusConfigSchema.parse({
        permissions: {
          autoApproveWrite: true,
          autoApproveCommand: true,
          autoApproveMcp: true,
          allowedCommands: ["rm -rf project"],
          allowedMcpTools: ["danger__mutate"],
          rules: [{ tool: "Bash", action: "allow" }],
        },
        modes: {
          agent: { autoApprove: ["read", "write", "execute", "mcp"] },
        },
      }) as NexusConfig,
    )
    expect(hardened.permissions.autoApproveWrite).toBe(false)
    expect(hardened.permissions.autoApproveCommand).toBe(false)
    expect(hardened.permissions.autoApproveMcp).toBe(false)
    expect(hardened.permissions.allowedCommands).toEqual([])
    expect(hardened.permissions.allowedMcpTools).toEqual([])
    expect(hardened.permissions.rules).toEqual([])
    expect(hardened.modes.agent?.autoApprove).toEqual(["read"])
  })

  it("confines host file and command paths to the authenticated workspace", async () => {
    const host = new ServerHost(root, () => {})

    await expect(host.readFile(path.join(outside, "secret.txt"))).rejects.toThrow(
      /outside/i,
    )
    await expect(host.runCommand("pwd", outside)).rejects.toThrow(/outside/i)
  })
})
