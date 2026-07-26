import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createApp } from "./app.js"
import { ServerHost } from "./host.js"
import { enforceServerPermissionBoundary } from "./run-session.js"
import {
  appendRunEvent,
  createActiveRun,
  finishRun,
  waitForRunApproval,
} from "./active-runs.js"
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
      new Request("http://localhost/session/session_test/abort", {
        method: "POST",
        body: "{}",
      }),
      new Request("http://localhost/session/session_test/run/run_test/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partId: "part_test", approved: true }),
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

  it("rejects unsafe durable run identifiers before storage lookup", async () => {
    const response = await app().request("/session/session_test/message", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId: "../outside" }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invalid run id" })
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

  it("accepts an authenticated decision for the matching pending run approval", async () => {
    const created = await createActiveRun(
      "session_approval",
      root,
      "agent",
      {
        runId: "run_approval",
        homeDir: path.join(path.dirname(root), ".nexus-test"),
      },
    )
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "run the focused tests",
    }
    appendRunEvent(created.id, {
      type: "tool_approval_needed",
      partId: "part_approval",
      action,
    })
    const waiting = waitForRunApproval(created.id, action, created.abortController.signal)

    const response = await app().request(
      "/session/session_approval/run/run_approval/approval",
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          partId: "part_approval",
          approved: true,
        }),
      },
    )

    expect(response.status).toBe(200)
    await expect(waiting).resolves.toMatchObject({ approved: true })
    await finishRun(created.id)
  })

  it("rejects an approval submitted from a different allowed workspace", async () => {
    const multiRootApp = createApp({
      token,
      allowedOrigins: [],
      workspaceRoots: [root, outside],
    })
    const created = await createActiveRun(
      "session_scoped_approval",
      root,
      "agent",
      {
        runId: "run_scoped_approval",
        homeDir: path.join(path.dirname(root), ".nexus-test"),
      },
    )
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "run tests",
    }
    appendRunEvent(created.id, {
      type: "tool_approval_needed",
      partId: "part_scoped_approval",
      action,
    })

    const response = await multiRootApp.request(
      "/session/session_scoped_approval/run/run_scoped_approval/approval",
      {
        method: "POST",
        headers: {
          ...authHeaders(outside),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          partId: "part_scoped_approval",
          approved: true,
        }),
      },
    )

    expect(response.status).toBe(404)
    created.abortController.abort()
    await finishRun(created.id, "aborted")
  })

  it("turns an explicit authenticated stop into a run abort", async () => {
    const created = await createActiveRun(
      "session_abort",
      root,
      "agent",
      {
        runId: "run_abort",
        homeDir: path.join(path.dirname(root), ".nexus-test"),
      },
    )

    const response = await app().request("/session/session_abort/abort", {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(created.abortController.signal.aborted).toBe(true)
    await finishRun(created.id, "aborted")
  })
})
