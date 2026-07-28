import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import type { ToolContext, ToolDef } from "../../types.js"
import { parallelTool } from "../../tools/built-in/parallel.js"
import { getToolOutputSpill } from "../../context/tool-output-registry.js"
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
    executionIdentityBase: {
      workspaceId: "workspace-test",
      sessionId: "session-test",
      turnId: "turn-test",
      runId: "run-test",
    },
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
          expect(childContext.executionIdentity).toEqual({
            workspaceId: "workspace-test",
            sessionId: "session-test",
            turnId: "turn-test",
            runId: "run-test",
            messageId: "message-1",
            partId: "part_call-1",
            toolCallId: "call-1",
          })
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

it("routes every Parallel inner call through the authoritative pipeline", async () => {
  const context = createContext([])
  const hooks: Array<{ event: string; toolName: unknown; origin: unknown }> = []
  const inner: ToolDef = {
    name: "Read",
    description: "inner read",
    parameters: z.object({ file_path: z.string() }),
    readOnly: true,
    async execute(args, childContext) {
      expect(args).toEqual({ file_path: "README.md" })
      expect(childContext.partId).toBe("part_outer.parallel.1")
      expect(childContext.toolExecutionMessageId).toBe("message-outer")
      expect(childContext.executionIdentity).toEqual({
        workspaceId: "workspace-test",
        sessionId: "session-test",
        turnId: "turn-test",
        runId: "run-test",
        messageId: "message-outer",
        partId: "part_outer.parallel.1",
        toolCallId: "outer.parallel.1",
      })
      return { success: true, output: "inner-ok" }
    },
  }
  context.resolvedTools = [parallelTool, inner]

  const result = await executeToolPipeline(
    {
      callId: "outer",
      messageId: "message-outer",
      partId: "part_outer",
      toolName: "Parallel",
      input: {
        tool_uses: [{
          recipient_name: "Read",
          parameters: { file_path: "README.md" },
        }],
      },
      origin: "native",
    },
    {
      tools: context.resolvedTools,
      context,
      autoApproveActions: new Set(["read"]),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner(_cwd, _host, _config, event, payload) {
        hooks.push({
          event,
          toolName: payload.toolName,
          origin: payload.origin,
        })
        return []
      },
    },
  )

  expect(result.success).toBe(true)
  expect(result.output).toContain("inner-ok")
  expect(hooks).toEqual([
    { event: "before_tool", toolName: "Parallel", origin: "native" },
    { event: "before_tool", toolName: "Read", origin: "parallel" },
    { event: "after_tool", toolName: "Read", origin: "parallel" },
    { event: "after_tool", toolName: "Parallel", origin: "native" },
  ])
})

it("fails closed when a composite tool is invoked without a nested executor", async () => {
  const context = createContext([])
  let innerExecuted = false
  const inner: ToolDef = {
    name: "Read",
    description: "inner read",
    parameters: z.object({ file_path: z.string() }),
    readOnly: true,
    async execute() {
      innerExecuted = true
      return { success: true, output: "unexpected" }
    },
  }
  context.resolvedTools = [parallelTool, inner]

  const result = await parallelTool.execute({
    tool_uses: [{
      recipient_name: "Read",
      parameters: { file_path: "README.md" },
    }],
  }, context)

  expect(result.success).toBe(false)
  expect(result.output).toContain("authoritative nested tool executor")
  expect(innerExecuted).toBe(false)
})

it("fails closed with a sanitized diagnostic when before_tool dispatch is unavailable", async () => {
  const context = createContext([])
  let executed = false
  const result = await executeToolPipeline(
    {
      callId: "hook-failure",
      messageId: "message",
      partId: "part_hook-failure",
      toolName: "Read",
      input: { file_path: "README.md" },
      origin: "native",
    },
    {
      tools: [{
        name: "Read",
        description: "read",
        parameters: z.object({ file_path: z.string() }),
        readOnly: true,
        async execute() {
          executed = true
          return { success: true, output: "ok" }
        },
      }],
      context,
      autoApproveActions: new Set(["read"]),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner() {
        throw new Error("apiKey=must-not-leak")
      },
    },
  )

  expect(result.success).toBe(false)
  expect(result.stoppedByHook).toBe(true)
  expect(result.beforeHookResults).toMatchObject([{
    pluginName: "nexus-plugin-runtime",
    hookEvent: "before_tool",
    success: false,
    preventContinuation: true,
  }])
  expect(result.afterHookResults).toBeUndefined()
  expect(executed).toBe(false)
  expect(JSON.stringify(result)).not.toContain("must-not-leak")
})

it("keeps a successful tool result when only after_tool dispatch fails", async () => {
  const context = createContext([])
  const result = await executeToolPipeline(
    {
      callId: "after-hook-failure",
      messageId: "message",
      partId: "part_after-hook-failure",
      toolName: "Read",
      input: { file_path: "README.md" },
      origin: "native",
    },
    {
      tools: [{
        name: "Read",
        description: "read",
        parameters: z.object({ file_path: z.string() }),
        readOnly: true,
        async execute() {
          return { success: true, output: "ok" }
        },
      }],
      context,
      autoApproveActions: new Set(["read"]),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner(_cwd, _host, _config, event) {
        if (event === "after_tool") {
          throw new Error("apiKey=must-not-leak")
        }
        return []
      },
    },
  )

  expect(result.success).toBe(true)
  expect(result.output).toBe("ok")
  expect(result.afterHookResults).toMatchObject([{
    pluginName: "nexus-plugin-runtime",
    hookEvent: "after_tool",
    success: false,
  }])
  expect(JSON.stringify(result)).not.toContain("must-not-leak")
})

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

describe.each(["plan", "ask", "review"] as const)(
  "constrained-mode dynamic tool enforcement: %s",
  (mode) => {
    it("rejects a mutating dynamic tool even if a caller passes it directly", async () => {
      const order: string[] = []
      const context = {
        ...createContext(order),
        mode,
      }
      const tool: ToolDef = {
        name: "external_mutation",
        description: "mutating integration",
        parameters: z.object({}),
        readOnly: false,
        async execute() {
          order.push("execute")
          return { success: true, output: "unexpected" }
        },
      }

      const result = await executeToolPipeline(
        {
          callId: "mutating-dynamic",
          messageId: "message",
          partId: "part_mutating-dynamic",
          toolName: tool.name,
          input: {},
          origin: "native",
        },
        {
          tools: [tool],
          context,
          autoApproveActions: new Set(),
          mode,
          mcpToolNames: new Set([tool.name]),
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
      expect(result.output).toContain(`disabled in ${mode} mode`)
      expect(order).toEqual(["validate"])
    })
  },
)

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

describe.each([
  {
    toolName: "WebFetch",
    input: { url: "https://example.com/docs" },
    parameters: z.object({ url: z.string() }),
  },
  {
    toolName: "WebSearch",
    input: { query: "nexus browser approval sentinel" },
    parameters: z.object({ query: z.string() }),
  },
] as const)("$toolName browser approval", ({ toolName, input, parameters }) => {
  it("is not auto-approved by read permissions", async () => {
    const cwd = process.cwd()
    let executed = false
    const host = createFakeHost({
      cwd,
      async showApprovalDialog() {
        return { approved: false }
      },
    })
    const context: ToolContext = {
      cwd,
      host,
      session: createFakeSession(cwd),
      config: createTestConfig({
        permissions: {
          autoApproveRead: true,
          autoApproveBrowser: false,
        },
      }),
      services: createNexusRunServices(),
      mode: "agent",
      signal: new AbortController().signal,
    }

    const result = await executeToolPipeline(
      {
        callId: `browser-denied-${toolName}`,
        messageId: "message",
        partId: `part_browser-denied-${toolName}`,
        toolName,
        input,
        origin: "native",
      },
      {
        tools: [{
          name: toolName,
          description: "network test",
          parameters,
          readOnly: true,
          async execute() {
            executed = true
            return { success: true, output: "unexpected" }
          },
        } as ToolDef],
        context,
        autoApproveActions: new Set(["read"]),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toHaveLength(1)
    expect(host.approvals[0]).toMatchObject({
      type: "browser",
      tool: toolName,
    })
    expect(executed).toBe(false)
  })

  it.each([
    {
      name: "the explicit browser permission",
      autoApproveActions: new Set(["read", "browser"] as const),
      autoApproveBrowser: false,
    },
    {
      name: "the global browser permission",
      autoApproveActions: new Set(["read"] as const),
      autoApproveBrowser: true,
    },
  ])("honors $name", async ({ autoApproveActions, autoApproveBrowser }) => {
    const cwd = process.cwd()
    let executed = false
    const host = createFakeHost({ cwd })
    const context: ToolContext = {
      cwd,
      host,
      session: createFakeSession(cwd),
      config: createTestConfig({
        permissions: {
          autoApproveRead: true,
          autoApproveBrowser,
        },
      }),
      services: createNexusRunServices(),
      mode: "agent",
      signal: new AbortController().signal,
    }

    const result = await executeToolPipeline(
      {
        callId: `browser-approved-${toolName}`,
        messageId: "message",
        partId: `part_browser-approved-${toolName}`,
        toolName,
        input,
        origin: "native",
      },
      {
        tools: [{
          name: toolName,
          description: "network test",
          parameters,
          readOnly: true,
          async execute() {
            executed = true
            return { success: true, output: "ok" }
          },
        } as ToolDef],
        context,
        autoApproveActions,
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(executed).toBe(true)
  })
})

it("honors requiresApproval for sensitive non-shell tools", async () => {
  const cwd = process.cwd()
  const actions: Array<{ type: string; tool: string }> = []
  let executed = false
  const context: ToolContext = {
    cwd,
    host: createFakeHost({
      cwd,
      async showApprovalDialog(action) {
        actions.push({ type: action.type, tool: action.tool })
        return { approved: false }
      },
    }),
    session: createFakeSession(cwd),
    config: createTestConfig({ permissions: { autoApproveRead: true } }),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
  const result = await executeToolPipeline(
    {
      callId: "sensitive",
      messageId: "message",
      partId: "part_sensitive",
      toolName: "PluginTrust",
      input: { name: "demo", trusted: true },
      origin: "native",
    },
    {
      tools: [{
        name: "PluginTrust",
        description: "test",
        parameters: z.object({ name: z.string(), trusted: z.boolean() }),
        requiresApproval: true,
        async execute() {
          executed = true
          return { success: true, output: "unexpected" }
        },
      }],
      context,
      autoApproveActions: new Set(["read", "execute"]),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner() {
        return []
      },
    },
  )

  expect(result).toMatchObject({ success: false, denied: true })
  expect(actions).toEqual([{ type: "plugin", tool: "PluginTrust" }])
  expect(executed).toBe(false)
})

it("preserves rich tool attachments through the shared execution pipeline", async () => {
  const context = createContext([])
  const result = await executeToolPipeline(
    {
      callId: "rich",
      messageId: "message",
      partId: "part_rich",
      toolName: "Rich",
      input: {},
      origin: "mcp",
    },
    {
      tools: [{
        name: "Rich",
        description: "rich result",
        parameters: z.object({}),
        readOnly: true,
        async execute() {
          return {
            success: true,
            output: "[image]",
            attachments: [{
              type: "image",
              content: "aGVsbG8=",
              mimeType: "image/png",
            }],
          }
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

  expect(result.attachments).toEqual([{
    type: "image",
    content: "aGVsbG8=",
    mimeType: "image/png",
  }])
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
    const spill = getToolOutputSpill(context.session.id, "part_spill")
    expect(spill?.artifactId).toMatch(/^artifact_/)
    expect(await readFile(spill!.absolutePath, "utf8")).toBe(fullOutput)
    expect(result.metadata).not.toHaveProperty("outputPath")
    expect(result.metadata).not.toHaveProperty("outputSpillAbsolutePath")
    expect(result.output).not.toContain(dataHome)
  } finally {
    if (previousDataHome === undefined) delete process.env.NEXUS_DATA_HOME
    else process.env.NEXUS_DATA_HOME = previousDataHome
    await rm(dataHome, { recursive: true, force: true })
  }
})

it("spills oversized failed output so an error cannot overflow the next prompt", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "nexus-tool-error-spill-"))
  const previousDataHome = process.env.NEXUS_DATA_HOME
  process.env.NEXUS_DATA_HOME = dataHome
  try {
    const context = createContext([])
    const fullOutput = `provider failed:\n${"x".repeat(60 * 1024)}`
    const result = await executeToolPipeline(
      {
        callId: "failed-spill",
        messageId: "message",
        partId: "part_failed-spill",
        toolName: "RemoteFailure",
        input: {},
        origin: "mcp",
      },
      {
        tools: [{
          name: "RemoteFailure",
          description: "test",
          parameters: z.object({}),
          readOnly: true,
          async execute() {
            return { success: false, output: fullOutput }
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

    expect(result.success).toBe(false)
    expect(result.output.length).toBeLessThan(fullOutput.length)
    const spill = getToolOutputSpill(
      context.session.id,
      "part_failed-spill",
    )
    expect(spill?.artifactId).toMatch(/^artifact_/)
    expect(await readFile(spill!.absolutePath, "utf8")).toBe(fullOutput)
    expect(result.metadata).not.toHaveProperty("outputPath")
    expect(result.metadata).not.toHaveProperty("outputSpillAbsolutePath")
    expect(result.output).not.toContain(dataHome)
  } finally {
    if (previousDataHome === undefined) delete process.env.NEXUS_DATA_HOME
    else process.env.NEXUS_DATA_HOME = previousDataHome
    await rm(dataHome, { recursive: true, force: true })
  }
})

it("approves and hooks the exact transformed arguments that execute", async () => {
  const order: string[] = []
  const context = createContext(order)
  let executedCommand = ""
  let beforeHookCommand = ""
  const result = await executeToolPipeline(
    {
      callId: "transformed",
      messageId: "message",
      partId: "part_transformed",
      toolName: "TransformingTool",
      input: { command: "display-value" },
      origin: "plugin",
    },
    {
      tools: [{
        name: "TransformingTool",
        description: "test",
        parameters: z.object({
          command: z.string().transform(() => "executed-value"),
        }),
        approval: {
          capability: "execute",
          command: (input) =>
            typeof input.command === "string" ? input.command : undefined,
          description: (input) => `Run ${String(input.command)}`,
          content: (input) =>
            typeof input.command === "string" ? input.command : undefined,
        },
        async execute(args) {
          executedCommand = String(args.command)
          return { success: true, output: "ok" }
        },
      }],
      context,
      autoApproveActions: new Set(),
      mode: "agent",
      mcpToolNames: new Set(),
      async hookRunner(_cwd, _host, _config, event, payload) {
        if (event === "before_tool") {
          const hookInput = payload["toolInput"] as Record<string, unknown>
          beforeHookCommand = hookInput["command"] as string
          hookInput["command"] = "hook-mutated-value"
        }
        return []
      },
    },
  )

  expect(result.success).toBe(true)
  expect(beforeHookCommand).toBe("executed-value")
  expect(context.host).toMatchObject({
    approvals: [
      expect.objectContaining({
        content: "executed-value",
        description: "Run executed-value",
      }),
    ],
  })
  expect(executedCommand).toBe("executed-value")
  expect(result.normalizedInput).toEqual({ command: "executed-value" })
})
