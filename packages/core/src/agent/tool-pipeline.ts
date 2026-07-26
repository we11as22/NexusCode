import { z } from "zod"

import type {
  IHost,
  Mode,
  PermissionAction,
  ToolContext,
  ToolDef,
  ToolResult,
} from "../types.js"
import {
  runPluginHooks,
  type PluginHookExecution,
  type PluginHookEvent,
} from "../plugins/runtime.js"
import {
  executeValidatedTool,
  formatToolValidationError,
  normalizeToolInputForParse,
  type CompletionState,
} from "./tool-execution.js"
import { resolveToolNameAlias } from "../tools/aliases.js"

export type ToolExecutionOrigin =
  | "native"
  | "textual"
  | "parallel"
  | "mcp"
  | "plugin"
  | "subagent"

export interface ToolExecutionRequest {
  callId: string
  messageId: string
  partId: string
  toolName: string
  input: Record<string, unknown>
  origin: ToolExecutionOrigin
}

type HookRunner = (
  cwd: string,
  host: IHost,
  config: ToolContext["config"],
  event: PluginHookEvent,
  payload: Record<string, unknown>,
) => Promise<PluginHookExecution[]>

export type ToolPipelineStage =
  | "validate"
  | "before_tool"
  | "approve"
  | "execute"
  | "spill"
  | "after_tool"

export interface ToolExecutionEnvironment {
  tools: readonly ToolDef[]
  context: ToolContext
  autoApproveActions: ReadonlySet<PermissionAction>
  mode: Mode
  mcpToolNames: ReadonlySet<string>
  completionState?: CompletionState
  hookRunner?: HookRunner
  onStage?: (stage: ToolPipelineStage) => void
}

export interface ToolExecutionOutcome extends ToolResult {
  toolName: string
  normalizedInput: Record<string, unknown>
  denied?: boolean
  stoppedByHook?: boolean
  outputSpillPath?: string
  beforeHookResults?: PluginHookExecution[]
  afterHookResults?: PluginHookExecution[]
}

function stopReason(results: PluginHookExecution[]): string | undefined {
  const stopped = results.find((result) => result.preventContinuation)
  return stopped?.stopReason?.trim() ||
    (stopped
      ? `${stopped.pluginName} requested that the agent stop the current continuation.`
      : undefined)
}

export async function executeToolPipeline(
  request: ToolExecutionRequest,
  environment: ToolExecutionEnvironment,
): Promise<ToolExecutionOutcome> {
  const {
    context,
    mode,
    completionState,
    onStage,
  } = environment
  const resolvedToolName = resolveToolNameAlias(
    request.toolName,
    environment.tools.map((tool) => tool.name),
  )
  const tool = environment.tools.find(
    (candidate) => candidate.name === resolvedToolName,
  )
  const normalizedInput = normalizeToolInputForParse(
    resolvedToolName,
    request.input,
  ) as Record<string, unknown>

  onStage?.("validate")
  if (!tool) {
    return {
      success: false,
      output: `ERROR: Tool "${request.toolName}" does not exist.`,
      toolName: resolvedToolName,
      normalizedInput,
    }
  }
  try {
    tool.parameters.parse(normalizedInput)
  } catch (error) {
    const output =
      error instanceof z.ZodError && tool.formatValidationError
        ? tool.formatValidationError(error)
        : formatToolValidationError(resolvedToolName, error, normalizedInput)
    return {
      success: false,
      output,
      toolName: resolvedToolName,
      normalizedInput,
    }
  }

  const hookRunner = environment.hookRunner ?? runPluginHooks
  const hookPayload = {
    mode,
    sessionId: context.session.id,
    toolName: resolvedToolName,
    toolInput: normalizedInput,
    origin: request.origin,
  }
  onStage?.("before_tool")
  const beforeHookResults = await hookRunner(
    context.cwd,
    context.host,
    context.config,
    "before_tool",
    hookPayload,
  ).catch(() => [])
  const beforeStopReason = stopReason(beforeHookResults)
  if (beforeStopReason) {
    return {
      success: false,
      output: beforeStopReason,
      toolName: resolvedToolName,
      normalizedInput,
      stoppedByHook: true,
      beforeHookResults,
    }
  }

  let denied = false
  const childHost = new Proxy(context.host, {
    get(target, property, receiver) {
      if (property === "showApprovalDialog") {
        return async (...args: Parameters<IHost["showApprovalDialog"]>) => {
          onStage?.("approve")
          const result = await target.showApprovalDialog(...args)
          if (!result.approved) denied = true
          return result
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const childContext: ToolContext = {
    ...context,
    host: childHost,
    partId: request.partId,
    toolExecutionMessageId: request.messageId,
  }
  const wrappedTool: ToolDef = {
    ...tool,
    async execute(args) {
      onStage?.("execute")
      return tool.execute(args, childContext)
    },
  }
  const tools = environment.tools.map((candidate) =>
    candidate === tool ? wrappedTool : candidate,
  )

  const result = await executeValidatedTool(
    request.callId,
    resolvedToolName,
    normalizedInput,
    [...tools],
    childContext,
    new Set(environment.autoApproveActions),
    context.config,
    childHost,
    context.session,
    request.messageId,
    completionState,
    mode,
    new Set(environment.mcpToolNames),
  )
  onStage?.("spill")

  onStage?.("after_tool")
  const afterHookResults = await hookRunner(
    context.cwd,
    context.host,
    context.config,
    "after_tool",
    {
      ...hookPayload,
      success: result.success,
      output: result.output,
    },
  ).catch(() => [])
  const afterStopReason = stopReason(afterHookResults)
  const outputSpillPath =
    typeof result.metadata?.["outputSpillAbsolutePath"] === "string"
      ? result.metadata["outputSpillAbsolutePath"]
      : undefined

  return {
    ...result,
    toolName: resolvedToolName,
    normalizedInput,
    ...(denied ? { denied: true } : {}),
    ...(afterStopReason ? { stoppedByHook: true } : {}),
    ...(outputSpillPath ? { outputSpillPath } : {}),
    beforeHookResults,
    afterHookResults,
  }
}
