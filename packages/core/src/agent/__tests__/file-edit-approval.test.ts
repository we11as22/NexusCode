import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileChangeSetStore } from "../../changes/file-store.js"
import { ChangeSetService } from "../../changes/service.js"
import type { CapturedFileState } from "../../changes/types.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type {
  PermissionResult,
  ToolContext,
} from "../../types.js"
import { writeFileTool } from "../../tools/built-in/write-file.js"
import { createNexusRunServices } from "../run-services.js"
import { executeToolPipeline } from "../tool-pipeline.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

async function runWrite(options: {
  rule?: "allow" | "ask" | "deny"
  rulePattern?: string
  autoApproveWrite?: boolean
  approval?: PermissionResult
  mode?: "agent" | "plan"
  filePath?: string
}) {
  const order: string[] = []
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-file-approval-"))
  roots.push(cwd)
  let state: CapturedFileState = {
    exists: false,
    content: null,
    mode: null,
  }
  const host = createFakeHost({
    cwd,
    async readFileState() {
      order.push("stage")
      return state.exists
        ? {
            exists: true,
            content: Buffer.from(state.content),
            mode: state.mode,
          }
        : state
    },
    async applyFileMutation(mutation) {
      order.push("apply")
      state = mutation.next.exists
        ? {
            exists: true,
            content: Buffer.from(mutation.next.content),
            mode: mutation.next.mode,
          }
        : {
            exists: false,
            content: null,
            mode: null,
          }
    },
    async showApprovalDialog() {
      order.push("approval")
      return options.approval ?? { approved: true }
    },
  })
  const config = createTestConfig({
    permissions: {
      autoApproveWrite: options.autoApproveWrite ?? false,
      rules: options.rule
        ? [{
            tool: "Write",
            pathPattern: options.rulePattern ?? "src/**",
            action: options.rule,
          }]
        : [],
    },
  })
  const session = createFakeSession(cwd)
  const changeSetService = new ChangeSetService({
    workspaceId: "workspace-approval",
    store: new FileChangeSetStore("workspace-approval", { rootDir: cwd }),
    files: {
      readFileState: (filePath) => host.readFileState!(filePath),
      applyFileMutation: (mutation) => host.applyFileMutation!(mutation),
    },
  })
  const context: ToolContext = {
    cwd,
    host,
    session,
    config,
    mode: options.mode ?? "agent",
    signal: new AbortController().signal,
    services: createNexusRunServices(),
    executionIdentity: {
      workspaceId: "workspace-approval",
      sessionId: session.id,
      turnId: "turn-approval",
      runId: "run-approval",
      messageId: "message",
      partId: "part_file-edit",
      toolCallId: "file-edit",
    },
    changeSetService,
  }

  const result = await executeToolPipeline(
    {
      callId: "file-edit",
      messageId: "message",
      partId: "part_file-edit",
      toolName: "Write",
      input: {
        file_path: options.filePath ?? "src/new.ts",
        content: "export const value = 1\n",
      },
      origin: "native",
    },
    {
      tools: [writeFileTool],
      context,
      autoApproveActions: new Set(),
      mode: options.mode ?? "agent",
      mcpToolNames: new Set(),
      async hookRunner() {
        return []
      },
    },
  )

  return { result, host, order }
}

describe("file edit approval authority", () => {
  it("lets an allow rule suppress the host prompt without bypassing staging", async () => {
    const { result, host, order } = await runWrite({ rule: "allow" })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(order.filter((step) => step === "stage").length).toBeGreaterThan(0)
    expect(order.at(-1)).toBe("apply")
  })

  it("uses exactly one diff-aware prompt for an ask rule", async () => {
    const { result, host, order } = await runWrite({ rule: "ask" })

    expect(result.success).toBe(true)
    expect(host.approvals).toHaveLength(1)
    expect(host.approvals[0]).toMatchObject({
      type: "write",
      tool: "Write",
      diff: expect.stringContaining("src/new.ts"),
    })
    expect(order.filter((step) => step === "approval")).toHaveLength(1)
    expect(order.indexOf("approval")).toBeGreaterThan(order.indexOf("stage"))
    expect(order.indexOf("apply")).toBeGreaterThan(order.indexOf("approval"))
  })

  it("never applies a proposal before approval and durably rejects a denial", async () => {
    const { result, order } = await runWrite({
      approval: { approved: false },
    })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({ changeSetState: "rejected" })
    expect(order.filter((step) => step === "approval")).toHaveLength(1)
    expect(order).not.toContain("apply")
  })

  it("denies by rule before staging any edit", async () => {
    const { result, host, order } = await runWrite({ rule: "deny" })

    expect(result.success).toBe(false)
    expect(host.approvals).toEqual([])
    expect(order).toEqual([])
  })

  it("does not interrupt plan mode for its only allowed write target", async () => {
    const { result, host, order } = await runWrite({
      mode: "plan",
      filePath: ".nexus/plans/review.md",
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(order).toContain("apply")
  })

  it("still honors an explicit ask rule for an allowed plan file", async () => {
    const { result, host, order } = await runWrite({
      mode: "plan",
      filePath: ".nexus/plans/review.md",
      rule: "ask",
      rulePattern: ".nexus/plans/**",
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toHaveLength(1)
    expect(order).toContain("approval")
  })
})
