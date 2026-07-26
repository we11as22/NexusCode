import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import type { ToolContext, ToolDef } from "../../types.js"
import { createNexusRunServices } from "../run-services.js"
import {
  executeToolPipeline,
  type ToolExecutionOrigin,
} from "../tool-pipeline.js"

function createContext(order: string[]): ToolContext {
  const cwd = process.cwd()
  return {
    cwd,
    host: createFakeHost({
      cwd,
      async showApprovalDialog() {
        return { approved: true }
      },
    }),
    session: createFakeSession(cwd),
    config: createTestConfig({
      permissions: { autoApproveCommand: false },
    }),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
}

describe.each<ToolExecutionOrigin>(["native", "textual", "parallel"])(
  "tool pipeline origin: %s",
  (origin) => {
    it("uses one validation, hook, approval, execution, and spill order", async () => {
      const order: string[] = []
      const context = createContext(order)
      const tool: ToolDef = {
        name: "Bash",
        description: "test",
        parameters: z.object({ command: z.string() }),
        async execute(_args, childContext) {
          expect(childContext.partId).toBe("part_call-1")
          expect(childContext.toolExecutionMessageId).toBe("message-1")
          return { success: true, output: "ok" }
        },
      }

      const result = await executeToolPipeline(
        {
          callId: "call-1",
          messageId: "message-1",
          partId: "part_call-1",
          toolName: "Bash",
          input: { command: "pwd" },
          origin,
        },
        {
          tools: [tool],
          context,
          autoApproveActions: new Set(),
          mode: "agent",
          mcpToolNames: new Set(),
          onStage(stage) {
            order.push(stage)
          },
          async hookRunner() {
            return []
          },
        },
      )

      expect(result.success).toBe(true)
      expect(order).toEqual([
        "validate",
        "before_tool",
        "approve",
        "execute",
        "spill",
        "after_tool",
      ])
    })
  },
)

it("does not run hooks or execute invalid input", async () => {
  const order: string[] = []
  const context = createContext(order)
  const tool: ToolDef = {
    name: "Bash",
    description: "test",
    parameters: z.object({ command: z.string() }),
    async execute() {
      order.push("execute")
      return { success: true, output: "unexpected" }
    },
  }

  const result = await executeToolPipeline(
    {
      callId: "bad",
      messageId: "message",
      partId: "part_bad",
      toolName: "Bash",
      input: {},
      origin: "native",
    },
    {
      tools: [tool],
      context,
      autoApproveActions: new Set(),
      mode: "agent",
      mcpToolNames: new Set(),
      onStage(stage) {
        order.push(stage)
      },
      async hookRunner() {
        order.push("hook")
        return []
      },
    },
  )

  expect(result.success).toBe(false)
  expect(order).toEqual(["validate"])
})

it("stops before approval when a before_tool hook denies continuation", async () => {
  const order: string[] = []
  const context = createContext(order)
  const tool: ToolDef = {
    name: "Bash",
    description: "test",
    parameters: z.object({ command: z.string() }),
    async execute() {
      order.push("unexpected-execute")
      return { success: true, output: "unexpected" }
    },
  }
  const result = await executeToolPipeline(
    {
      callId: "blocked",
      messageId: "message",
      partId: "part_blocked",
      toolName: "Bash",
      input: { command: "pwd" },
      origin: "native",
    },
    {
      tools: [tool],
      context,
      autoApproveActions: new Set(),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner(_cwd, _host, _config, event) {
        return event === "before_tool"
          ? [{
              pluginName: "guard",
              hookEvent: event,
              success: true,
              output: "",
              preventContinuation: true,
              stopReason: "blocked by guard",
            }]
          : []
      },
    },
  )

  expect(result).toMatchObject({
    success: false,
    stoppedByHook: true,
    output: "blocked by guard",
  })
  expect(order).not.toContain("approve")
  expect(order).not.toContain("unexpected-execute")
})

it("marks a rejected approval and does not execute", async () => {
  const cwd = process.cwd()
  const context: ToolContext = {
    cwd,
    host: createFakeHost({ cwd }),
    session: createFakeSession(cwd),
    config: createTestConfig({
      permissions: { autoApproveCommand: false },
    }),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
  let executed = false
  const result = await executeToolPipeline(
    {
      callId: "denied",
      messageId: "message",
      partId: "part_denied",
      toolName: "Bash",
      input: { command: "pwd" },
      origin: "native",
    },
    {
      tools: [{
        name: "Bash",
        description: "test",
        parameters: z.object({ command: z.string() }),
        async execute() {
          executed = true
          return { success: true, output: "unexpected" }
        },
      }],
      context,
      autoApproveActions: new Set(),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner() {
        return []
      },
    },
  )

  expect(result.denied).toBe(true)
  expect(result.success).toBe(false)
  expect(executed).toBe(false)
})

it("respects disabled automatic skill loading", async () => {
  const cwd = process.cwd()
  const context: ToolContext = {
    cwd,
    host: createFakeHost({ cwd }),
    session: createFakeSession(cwd),
    config: createTestConfig({
      permissions: { autoApproveSkillLoad: false },
    }),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
  let executed = false
  const result = await executeToolPipeline(
    {
      callId: "skill",
      messageId: "message",
      partId: "part_skill",
      toolName: "Skill",
      input: { name: "unsafe-skill" },
      origin: "native",
    },
    {
      tools: [{
        name: "Skill",
        description: "test",
        parameters: z.object({ name: z.string() }),
        async execute() {
          executed = true
          return { success: true, output: "unexpected" }
        },
      }],
      context,
      autoApproveActions: new Set(["read"]),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner() {
        return []
      },
    },
  )

  expect(result.denied).toBe(true)
  expect(executed).toBe(false)
})

it("uses a tool-specific validation formatter", async () => {
  const order: string[] = []
  const context = createContext(order)
  const result = await executeToolPipeline(
    {
      callId: "format",
      messageId: "message",
      partId: "part_format",
      toolName: "Custom",
      input: {},
      origin: "native",
    },
    {
      tools: [{
        name: "Custom",
        description: "test",
        parameters: z.object({ value: z.string() }),
        formatValidationError: () => "use { value: string }",
        async execute() {
          return { success: true, output: "unexpected" }
        },
      }],
      context,
      autoApproveActions: new Set(),
      mode: "agent",
      mcpToolNames: new Set(),
    },
  )

  expect(result.output).toBe("use { value: string }")
})

it("spills oversized output and returns its durable path", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "nexus-tool-spill-"))
  const previousDataHome = process.env.NEXUS_DATA_HOME
  process.env.NEXUS_DATA_HOME = dataHome
  try {
    const order: string[] = []
    const context = createContext(order)
    const fullOutput = "x".repeat(60 * 1024)
    const result = await executeToolPipeline(
      {
        callId: "spill",
        messageId: "message",
        partId: "part_spill",
        toolName: "LargeOutput",
        input: {},
        origin: "parallel",
      },
      {
        tools: [{
          name: "LargeOutput",
          description: "test",
          parameters: z.object({}),
          async execute() {
            return { success: true, output: fullOutput }
          },
        }],
        context,
        autoApproveActions: new Set(),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result.output.length).toBeLessThan(fullOutput.length)
    expect(result.outputSpillPath).toBeTruthy()
    expect(await readFile(result.outputSpillPath!, "utf8")).toBe(fullOutput)
  } finally {
    if (previousDataHome === undefined) delete process.env.NEXUS_DATA_HOME
    else process.env.NEXUS_DATA_HOME = previousDataHome
    await rm(dataHome, { recursive: true, force: true })
  }
})
