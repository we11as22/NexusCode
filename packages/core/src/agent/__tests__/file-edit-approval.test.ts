import { describe, expect, it } from "vitest"

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

async function runWrite(options: {
  rule?: "allow" | "ask" | "deny"
  autoApproveWrite?: boolean
  approval?: PermissionResult
}) {
  const order: string[] = []
  const cwd = process.cwd()
  const host = createFakeHost({
    cwd,
    async openFileEdit() {
      order.push("open")
    },
    async saveFileEdit() {
      order.push("save")
    },
    async revertFileEdit() {
      order.push("revert")
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
            pathPattern: "src/**",
            action: options.rule,
          }]
        : [],
    },
  })
  const context: ToolContext = {
    cwd,
    host,
    session: createFakeSession(cwd),
    config,
    mode: "agent",
    signal: new AbortController().signal,
    services: createNexusRunServices(),
  }

  const result = await executeToolPipeline(
    {
      callId: "file-edit",
      messageId: "message",
      partId: "part_file-edit",
      toolName: "Write",
      input: {
        file_path: "src/new.ts",
        content: "export const value = 1\n",
      },
      origin: "native",
    },
    {
      tools: [writeFileTool],
      context,
      autoApproveActions: new Set(),
      mode: "agent",
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
    expect(order).toEqual(["open", "save"])
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
    expect(order).toEqual(["open", "approval", "save"])
  })

  it("never saves before a required approval and reverts a denial", async () => {
    const { result, order } = await runWrite({
      approval: { approved: false },
    })

    expect(result.success).toBe(false)
    expect(order).toEqual(["open", "approval", "revert"])
  })

  it("denies by rule before staging any edit", async () => {
    const { result, host, order } = await runWrite({ rule: "deny" })

    expect(result.success).toBe(false)
    expect(host.approvals).toEqual([])
    expect(order).toEqual([])
  })
})
