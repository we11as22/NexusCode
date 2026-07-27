import { describe, expect, it } from "vitest"

import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import type {
  NexusConfig,
  PermissionAction,
  PermissionResult,
  ToolContext,
  ToolDef,
} from "../../types.js"
import { bashTool } from "../../tools/built-in/execute-command.js"
import { killBashTool } from "../../tools/built-in/kill-bash.js"
import { listTool as builtInListTool } from "../../tools/built-in/search-files.js"
import {
  enterWorktreeTool,
  exitWorktreeTool,
  interruptRemoteSessionTool,
  mcpAuthenticateTool,
  planDraftWorkflowTool,
  powerShellTool,
  reconnectRemoteSessionTool,
  sendRemoteMessageTool,
  taskCreateTool,
  taskStopTool,
} from "../../tools/built-in/orchestration-tools.js"
import { createNexusRunServices } from "../run-services.js"
import {
  createSpawnAgentStopTool,
  ParallelAgentManager,
} from "../parallel.js"
import { executeToolPipeline } from "../tool-pipeline.js"
import { executeValidatedTool } from "../tool-execution.js"
import { mergeNexusConfigLayers } from "../../config/index.js"
import { NexusConfigSchema } from "../../config/schema.js"

type RunOptions = {
  tool: ToolDef
  input: Record<string, unknown>
  permissions?: Partial<NexusConfig["permissions"]>
  autoApproveActions?: PermissionAction[]
  mcpToolNames?: string[]
  approve?: boolean
  approvalResult?: PermissionResult
}

async function runPolicy(options: RunOptions) {
  const cwd = process.cwd()
  let executed = false
  const persistedCommands: string[] = []
  const persistedPatterns: string[] = []
  const persistedMcpTools: string[] = []
  const host = createFakeHost({
    cwd,
    async showApprovalDialog() {
      return options.approvalResult ?? { approved: options.approve ?? false }
    },
    async addAllowedCommand(_cwd, command) {
      persistedCommands.push(command)
    },
    async addAllowedPattern(_cwd, pattern) {
      persistedPatterns.push(pattern)
    },
    async addAllowedMcpTool(_cwd, toolName) {
      persistedMcpTools.push(toolName)
    },
  })
  const config = createTestConfig({
    permissions: options.permissions ?? {},
  })
  const context: ToolContext = {
    cwd,
    host,
    session: createFakeSession(cwd),
    config,
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
  const wrappedTool: ToolDef = {
    ...options.tool,
    async execute() {
      executed = true
      return { success: true, output: "executed" }
    },
  }

  const result = await executeToolPipeline(
    {
      callId: "approval-policy",
      messageId: "message",
      partId: "part_approval-policy",
      toolName: wrappedTool.name,
      input: options.input,
      origin: "native",
    },
    {
      tools: [wrappedTool],
      context,
      autoApproveActions: new Set(options.autoApproveActions ?? []),
      mode: "agent",
      mcpToolNames: new Set(options.mcpToolNames ?? []),
      async hookRunner() {
        return []
      },
    },
  )

  return {
    result,
    host,
    executed,
    config,
    persistedCommands,
    persistedPatterns,
    persistedMcpTools,
  }
}

describe("integration provenance", () => {
  it("fails closed to an always-prompt plugin capability for custom provenance", async () => {
    const tool: ToolDef = {
      name: "TrustedLocalTool",
      description: "A locally loaded executable tool",
      parameters: taskStopTool.parameters,
      integration: {
        kind: "custom",
        sourceId: "custom:/workspace/tools",
        sourcePath: "/workspace/tools",
        fingerprint: `sha256:${"a".repeat(64)}`,
        bundleFingerprint: `sha256:${"b".repeat(64)}`,
        generation: `sha256:${"c".repeat(64)}`,
      },
      async execute() {
        return { success: true, output: "unexpected" }
      },
    }

    const { result, host, executed } = await runPolicy({
      tool,
      input: { taskId: "local" },
      permissions: {
        autoApproveRead: true,
        autoApproveWrite: true,
        autoApproveCommand: true,
        autoApproveMcp: true,
      },
      approve: false,
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "plugin",
        tool: "TrustedLocalTool",
      }),
    ])
    expect(executed).toBe(false)
  })

  it("requires MCP permission from ToolDef.integration even when the name has no delimiter", async () => {
    const tool: ToolDef = {
      name: "calendar_create",
      description: "Create a calendar event",
      parameters: taskStopTool.parameters,
      integration: {
        kind: "mcp",
        serverName: "calendar",
        originalName: "create",
      },
      approval: {
        capability: "read",
        description() {
          return "Incorrect local downgrade"
        },
      },
      async execute() {
        return { success: true, output: "unexpected" }
      },
    }

    const { result, host, executed } = await runPolicy({
      tool,
      input: { taskId: "event-1" },
      permissions: { autoApproveMcp: false, autoApproveRead: true },
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "mcp",
        tool: "calendar_create",
        description: "MCP calendar/create",
      }),
    ])
    expect(executed).toBe(false)
  })

  it("does not grant MCP authority from a stale name set", async () => {
    const tool: ToolDef = {
      name: "local__read",
      description: "A local read-only tool",
      parameters: taskStopTool.parameters,
      readOnly: true,
      async execute() {
        return { success: true, output: "ok" }
      },
    }

    const { result, host, executed } = await runPolicy({
      tool,
      input: { taskId: "local" },
      permissions: { autoApproveRead: true, autoApproveMcp: false },
      mcpToolNames: ["local__read"],
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(executed).toBe(true)
  })

  it("does not label a local sensitive tool as MCP because its name contains a delimiter", async () => {
    const tool: ToolDef = {
      name: "local__sensitive",
      description: "A local sensitive tool",
      parameters: taskStopTool.parameters,
      requiresApproval: true,
      async execute() {
        return { success: true, output: "unexpected" }
      },
    }

    const { host } = await runPolicy({
      tool,
      input: { taskId: "local" },
    })

    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "read",
        tool: "local__sensitive",
      }),
    ])
  })

  it("binds a persistent MCP grant to the exact approved tool", async () => {
    const tool: ToolDef = {
      name: "calendar_create",
      description: "Create a calendar event",
      parameters: taskStopTool.parameters,
      integration: {
        kind: "mcp",
        serverName: "calendar",
        originalName: "create",
      },
      async execute() {
        return { success: true, output: "ok" }
      },
    }

    const mismatched = await runPolicy({
      tool,
      input: { taskId: "event-1" },
      permissions: { autoApproveMcp: false },
      approvalResult: {
        approved: true,
        addToAllowedMcpTool: "calendar_delete_everything",
      },
    })
    expect(mismatched.result.success).toBe(true)
    expect(mismatched.persistedMcpTools).toEqual([])
    expect(mismatched.config.permissions.allowedMcpTools).not.toContain(
      "calendar_delete_everything",
    )

    const exact = await runPolicy({
      tool,
      input: { taskId: "event-2" },
      permissions: { autoApproveMcp: false },
      approvalResult: {
        approved: true,
        addToAllowedMcpTool: "calendar_create",
      },
    })
    expect(exact.persistedMcpTools).toEqual(["calendar_create"])
    expect(exact.config.permissions.allowedMcpTools).toContain(
      "calendar_create",
    )
  })
})

describe.each([
  ["Bash", bashTool],
  ["PowerShell", powerShellTool],
] as const)("%s command policy", (toolName, tool) => {
  const command = "pnpm test packages/core"

  it("asks by default and includes the real command", async () => {
    const { result, host, executed } = await runPolicy({
      tool,
      input: { command, description: "Run focused core tests" },
      permissions: { autoApproveCommand: false },
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "execute",
        tool: toolName,
        description: `Run: ${command}`,
        content: command,
      }),
    ])
    expect(executed).toBe(false)
  })

  it.each([
    {
      name: "global command auto-approval",
      permissions: { autoApproveCommand: true },
      autoApproveActions: [] as PermissionAction[],
    },
    {
      name: "mode execute auto-approval",
      permissions: { autoApproveCommand: false },
      autoApproveActions: ["execute"] as PermissionAction[],
    },
    {
      name: "an exact allowed command",
      permissions: { allowedCommands: [command] },
      autoApproveActions: [] as PermissionAction[],
    },
    {
      name: "an allowed command pattern",
      permissions: { allowCommandPatterns: ["pnpm test:*"] },
      autoApproveActions: [] as PermissionAction[],
    },
  ])("honors $name", async ({ permissions, autoApproveActions }) => {
    const { result, host, executed } = await runPolicy({
      tool,
      input: { command, description: "Run focused core tests" },
      permissions,
      autoApproveActions,
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(executed).toBe(true)
  })

  it.each([
    {
      name: "ask pattern",
      permissions: {
        autoApproveCommand: true,
        askCommandPatterns: ["pnpm test:*"],
      },
    },
    {
      name: "project ask pattern over a host exact grant",
      permissions: {
        allowedCommands: [command],
        askCommandPatterns: ["pnpm test:*"],
      },
    },
    {
      name: "project ask pattern over a host prefix grant",
      permissions: {
        allowCommandPatterns: ["pnpm test:*"],
        askCommandPatterns: ["pnpm test:*"],
      },
    },
    {
      name: "deny pattern",
      permissions: {
        autoApproveCommand: true,
        denyCommandPatterns: ["pnpm test:*"],
      },
    },
  ])("requires confirmation for a matching $name", async ({ permissions }) => {
    const { result, host, executed } = await runPolicy({
      tool,
      input: { command, description: "Run focused core tests" },
      permissions,
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toHaveLength(1)
    expect(host.approvals[0]).toMatchObject({
      type: "execute",
      tool: toolName,
      content: command,
    })
    expect(executed).toBe(false)
  })

  it.each([
    "pnpm test packages/core && echo injected",
    "pnpm test packages/core; echo injected",
    "pnpm test packages/core\necho injected",
    "pnpm test packages/core | sh",
    "pnpm test packages/core > /tmp/nexus-injected",
    "pnpm test packages/core $(echo injected)",
    "pnpm test packages/core `echo injected`",
    "FOO=1 pnpm test packages/core",
  ])(
    "does not let a prefix grant authorize shell syntax: %s",
    async (unsafeCommand) => {
      const { result, host, executed } = await runPolicy({
        tool,
        input: {
          command: unsafeCommand,
          description: "Attempt a compound command",
        },
        permissions: {
          autoApproveCommand: false,
          allowCommandPatterns: ["pnpm test:*"],
        },
      })

      expect(result).toMatchObject({ success: false, denied: true })
      expect(host.approvals).toHaveLength(1)
      expect(host.approvals[0]).toMatchObject({
        type: "execute",
        tool: toolName,
        content: unsafeCommand,
      })
      expect(executed).toBe(false)
    },
  )

  it("keeps an explicitly exact compound-command grant exact", async () => {
    const exact = "pnpm test packages/core && echo explicitly-approved"
    const { result, host, executed } = await runPolicy({
      tool,
      input: { command: exact, description: "Run an exact approved command" },
      permissions: {
        autoApproveCommand: false,
        allowedCommands: [exact],
        allowCommandPatterns: ["pnpm test:*"],
      },
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(executed).toBe(true)
  })

  it("binds persistent exact and prefix grants to the approved command", async () => {
    const mismatched = await runPolicy({
      tool,
      input: { command, description: "Run focused core tests" },
      permissions: { autoApproveCommand: false },
      approvalResult: {
        approved: true,
        addToAllowedCommand: "rm -rf /tmp/unrelated",
        addToAllowedPattern: "rm:*",
      },
    })
    expect(mismatched.result.success).toBe(true)
    expect(mismatched.persistedCommands).toEqual([])
    expect(mismatched.persistedPatterns).toEqual([])

    const exact = await runPolicy({
      tool,
      input: { command, description: "Run focused core tests" },
      permissions: { autoApproveCommand: false },
      approvalResult: {
        approved: true,
        addToAllowedCommand: command,
        addToAllowedPattern: "pnpm test:*",
      },
    })
    expect(exact.persistedCommands).toEqual([command])
    expect(exact.persistedPatterns).toEqual(["pnpm test:*"])
  })
})

describe("dynamic orchestration approval policies", () => {
  it("always asks before terminating a legacy background shell", async () => {
    const { result, host, executed } = await runPolicy({
      tool: killBashTool,
      input: { shell_id: "background-1" },
      permissions: { autoApproveCommand: true },
      autoApproveActions: ["execute"],
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "execute",
        tool: "KillBash",
      }),
    ])
    expect(executed).toBe(false)
  })

  it("does not ask for a tracking-only TaskCreate", async () => {
    const { result, host, executed } = await runPolicy({
      tool: taskCreateTool,
      input: {
        kind: "tracking",
        subject: "Track documentation",
        description: "Record a coordination item without starting a process.",
      },
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(executed).toBe(true)
  })

  it("requires execute permission for a shell TaskCreate using its command and description", async () => {
    const command = "pnpm test packages/core"
    const description = "Run core tests in a background task"
    const { result, host, executed } = await runPolicy({
      tool: taskCreateTool,
      input: {
        kind: "shell",
        subject: "Run core tests",
        description,
        command,
      },
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "execute",
        tool: "TaskCreate",
        description: `Run: ${command}`,
        shortDescription: description,
        content: command,
      }),
    ])
    expect(executed).toBe(false)
  })

  it("requires execute permission before TaskCreate provisions a worktree", async () => {
    const description = "Investigate the parser in an isolated checkout"
    const { result, host, executed } = await runPolicy({
      tool: taskCreateTool,
      input: {
        kind: "agent",
        subject: "Inspect parser",
        description,
        isolation: "worktree",
      },
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "execute",
        tool: "TaskCreate",
        shortDescription: description,
      }),
    ])
    expect(host.approvals[0]?.description).toContain("worktree")
    expect(executed).toBe(false)
  })

  it.each([
    {
      tool: taskStopTool,
      input: { taskId: "task-7" },
      expectedTool: "TaskStop",
      expectedType: "execute",
    },
    {
      tool: enterWorktreeTool,
      input: { name: "approval-check" },
      expectedTool: "EnterWorktree",
      expectedType: "execute",
    },
    {
      tool: exitWorktreeTool,
      input: { worktree_id: "worktree-7", action: "remove" },
      expectedTool: "ExitWorktree",
      expectedType: "execute",
    },
    {
      tool: planDraftWorkflowTool,
      input: { workflow_id: "workflow-7", file_name: "workflow-7.md" },
      expectedTool: "PlanDraftWorkflow",
      expectedType: "write",
    },
  ])(
    "requires $expectedType permission for $expectedTool",
    async ({ tool, input, expectedTool, expectedType }) => {
      const { result, host, executed } = await runPolicy({ tool, input })

      expect(result).toMatchObject({ success: false, denied: true })
      expect(host.approvals).toEqual([
        expect.objectContaining({
          type: expectedType,
          tool: expectedTool,
        }),
      ])
      expect(executed).toBe(false)
    },
  )

  it("TaskStop still asks when execute is otherwise auto-approved", async () => {
    const { result, host, executed } = await runPolicy({
      tool: taskStopTool,
      input: { taskId: "task-7" },
      permissions: { autoApproveCommand: true },
      autoApproveActions: ["execute"],
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toHaveLength(1)
    expect(executed).toBe(false)
  })

  it("the legacy subagent stop alias cannot bypass TaskStop approval", async () => {
    const tool = createSpawnAgentStopTool(new ParallelAgentManager())
    const { result, host, executed } = await runPolicy({
      tool,
      input: { subagent_id: "agent-7" },
      permissions: { autoApproveCommand: true },
      autoApproveActions: ["execute"],
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "execute",
        tool: "SpawnAgentStop",
      }),
    ])
    expect(executed).toBe(false)
  })

  it.each([
    {
      tool: mcpAuthenticateTool,
      input: { server: "calendar" },
      expectedTool: "McpAuthenticate",
      expectedType: "mcp",
    },
    {
      tool: sendRemoteMessageTool,
      input: {
        remote_session_id: "remote-7",
        content: "Please inspect the failing test.",
      },
      expectedTool: "SendRemoteMessage",
      expectedType: "browser",
    },
    {
      tool: reconnectRemoteSessionTool,
      input: { remote_session_id: "remote-7" },
      expectedTool: "ReconnectRemoteSession",
      expectedType: "browser",
    },
  ])(
    "requires $expectedType permission for $expectedTool",
    async ({ tool, input, expectedTool, expectedType }) => {
      const { result, host, executed } = await runPolicy({ tool, input })

      expect(result).toMatchObject({ success: false, denied: true })
      expect(host.approvals).toEqual([
        expect.objectContaining({
          type: expectedType,
          tool: expectedTool,
        }),
      ])
      expect(executed).toBe(false)
    },
  )

  it("always asks before interrupting a remote session", async () => {
    const { result, host, executed } = await runPolicy({
      tool: interruptRemoteSessionTool,
      input: { remote_session_id: "remote-7" },
      permissions: {
        autoApproveCommand: true,
        autoApproveBrowser: true,
      },
      autoApproveActions: ["execute", "browser"],
    })

    expect(result).toMatchObject({ success: false, denied: true })
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "execute",
        tool: "InterruptRemoteSession",
      }),
    ])
    expect(executed).toBe(false)
  })
})

it("uses the resolved tool name for permission rules and approval actions", async () => {
  const cwd = process.cwd()
  let executed = false
  const host = createFakeHost({ cwd })
  const session = createFakeSession(cwd)
  const config = createTestConfig({
    permissions: {
      rules: [{ tool: "List", action: "ask" }],
    },
  })
  const listTool: ToolDef = {
    ...builtInListTool,
    name: "List",
    description: "List files",
    readOnly: true,
    async execute() {
      executed = true
      return { success: true, output: "unexpected" }
    },
  }
  const context: ToolContext = {
    cwd,
    host,
    session,
    config,
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }

  const result = await executeValidatedTool(
    "alias",
    "list_dir",
    { path: "directory" },
    [listTool],
    context,
    new Set(),
    config,
    host,
    session,
    "message",
    undefined,
    "agent",
    new Set(),
  )

  expect(result.success).toBe(false)
  expect(host.approvals).toEqual([
    expect.objectContaining({
      type: "read",
      tool: "List",
    }),
  ])
  expect(executed).toBe(false)
})

describe("layered permission rule authority", () => {
  it("does not let a project ask rule downgrade a matching host deny", async () => {
    const merged = NexusConfigSchema.parse(mergeNexusConfigLayers(
      {
        permissions: {
          rules: [{
            tool: "List",
            action: "deny",
            reason: "host policy",
          }],
        },
      },
      {
        permissions: {
          rules: [{
            tool: "List",
            action: "ask",
            reason: "project prompt",
          }],
        },
      },
    ))

    const { result, host, executed } = await runPolicy({
      tool: builtInListTool,
      input: { path: "." },
      permissions: merged.permissions,
      approve: true,
    })

    expect(result).toMatchObject({
      success: false,
      output: expect.stringContaining("host policy"),
    })
    expect(host.approvals).toEqual([])
    expect(executed).toBe(false)
  })

  it("preserves first-match semantics inside one trusted host rule layer", async () => {
    const { result, host, executed } = await runPolicy({
      tool: builtInListTool,
      input: { path: "src" },
      permissions: {
        rules: [
          { tool: "List", pathPattern: "src", action: "allow" },
          { tool: "List", pathPattern: "**", action: "deny" },
        ],
      },
    })

    expect(result.success).toBe(true)
    expect(host.approvals).toEqual([])
    expect(executed).toBe(true)
  })
})
