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
  modeSpecificToolInputError,
  normalizeToolInputForParse,
  type CompletionState,
} from "./tool-execution.js"
import { resolveToolNameAlias } from "../tools/aliases.js"
import { isToolDefinitionAllowedInMode } from "./modes.js"
import { toolExecutionIdentity } from "./execution-identity.js"

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

async function runHooksWithDiagnostic(
  hookRunner: HookRunner,
  cwd: string,
  host: IHost,
  config: ToolContext["config"],
  event: PluginHookEvent,
  payload: Record<string, unknown>,
  failurePolicy: "block" | "continue",
): Promise<PluginHookExecution[]> {
  try {
    return await hookRunner(cwd, host, config, event, payload)
  } catch (error) {
    // Before-tool hooks may enforce security policy and therefore fail closed.
    // After-tool hooks are observability and must never erase a completed tool
    // result. Both paths surface a structured, sanitized diagnostic.
    // Do not include the exception message because hook errors can contain
    // payloads, environment values, or command output with credentials.
    const errorKind =
      error instanceof Error && error.name.trim() ? error.name.trim() : "UnknownError"
    const blocked = failurePolicy === "block"
    return [{
      pluginName: "nexus-plugin-runtime",
      hookEvent: event,
      success: false,
      output:
        `Plugin hook dispatcher failed during ${event} (${errorKind}). ` +
        (blocked
          ? "The tool execution was blocked because policy hooks could not be evaluated."
          : "Observability hooks were skipped and the completed tool result was preserved."),
      ...(blocked
        ? {
            preventContinuation: true,
            stopReason:
              "Tool execution blocked because before_tool policy hooks could not be evaluated.",
          }
        : {}),
    }]
  }
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
  if (!isToolDefinitionAllowedInMode(tool, mode)) {
    return {
      success: false,
      output: `ERROR: Tool "${resolvedToolName}" is disabled in ${mode} mode.`,
      toolName: resolvedToolName,
      normalizedInput,
    }
  }
  let validatedInput: Record<string, unknown>
  try {
    const parsed = tool.parameters.parse(normalizedInput)
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("Tool arguments must resolve to a JSON object")
    }
    validatedInput = parsed as Record<string, unknown>
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

  const modeInputError = modeSpecificToolInputError(
    mode,
    resolvedToolName,
    validatedInput,
  )
  if (modeInputError) {
    return {
      success: false,
      output: `ERROR: ${modeInputError}`,
      toolName: resolvedToolName,
      normalizedInput,
    }
  }

  const hookRunner = environment.hookRunner ?? runPluginHooks
  const hookPayloadBase = {
    mode,
    sessionId: context.session.id,
    toolName: resolvedToolName,
    origin: request.origin,
  }
  onStage?.("before_tool")
  const beforeHookResults = await runHooksWithDiagnostic(
    hookRunner,
    context.cwd,
    context.host,
    context.config,
    "before_tool",
    {
      ...hookPayloadBase,
      toolInput: cloneToolInput(validatedInput),
    },
    "block",
  )
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
    ...(context.executionIdentityBase
      ? {
          executionIdentity: toolExecutionIdentity(
            context.executionIdentityBase,
            {
              messageId: request.messageId,
              partId: request.partId,
              toolCallId: request.callId,
            },
          ),
        }
      : {}),
    async executeNestedTool(nestedRequest) {
      if (
        !Number.isSafeInteger(nestedRequest.ordinal) ||
        nestedRequest.ordinal < 0
      ) {
        return {
          success: false,
          output: "Nested tool execution requires a non-negative safe integer ordinal.",
        }
      }
      const nestedCallId = `${request.callId}.parallel.${nestedRequest.ordinal + 1}`
      return executeToolPipeline(
        {
          callId: nestedCallId,
          messageId: request.messageId,
          partId: `${request.partId}.parallel.${nestedRequest.ordinal + 1}`,
          toolName: nestedRequest.toolName,
          input: nestedRequest.input,
          origin: "parallel",
        },
        {
          ...environment,
          // A nested call receives a fresh per-call context from this pipeline.
          // Reusing childContext would leak the parent's part identity.
          context,
        },
      )
    },
  }
  const wrappedTool: ToolDef = {
    ...tool,
    async execute(args, executionContext) {
      onStage?.("execute")
      return tool.execute(args, executionContext)
    },
  }
  const tools = environment.tools.map((candidate) =>
    candidate === tool ? wrappedTool : candidate,
  )

  const result = await executeValidatedTool(
    request.callId,
    resolvedToolName,
    validatedInput,
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
    validatedInput,
  )
  onStage?.("spill")

  onStage?.("after_tool")
  const afterHookResults = await runHooksWithDiagnostic(
    hookRunner,
    context.cwd,
    context.host,
    context.config,
    "after_tool",
    {
      ...hookPayloadBase,
      toolInput: cloneToolInput(validatedInput),
      success: result.success,
      output: result.output,
    },
    "continue",
  )
  const afterStopReason = stopReason(afterHookResults)
  return {
    ...result,
    toolName: resolvedToolName,
    normalizedInput: validatedInput,
    ...(denied ? { denied: true } : {}),
    ...(afterStopReason ? { stoppedByHook: true } : {}),
    beforeHookResults,
    afterHookResults,
  }
}

function cloneToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return structuredClone(input)
  } catch {
    // Valid tool arguments are JSON-compatible. A custom schema that returns
    // an exotic value must not gain a shared mutable reference through hooks.
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>
  }
}
