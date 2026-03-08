import type { LLMClient } from "../provider/index.js"
import type { LLMStreamEvent, LLMMessage, LLMToolDef } from "../provider/types.js"
import type {
  IHost,
  ISession,
  ToolDef,
  ToolContext,
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolPart,
  NexusConfig,
  Mode,
} from "../types.js"
import * as path from "node:path"
import { READ_ONLY_TOOLS, MANDATORY_END_TOOL, PLAN_MODE_ALLOWED_WRITE_PATTERN } from "./modes.js"
import {
  executeToolCall,
  detectDoomLoop,
  extractWriteTargetPath,
  DOOM_LOOP_THRESHOLD,
  DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND,
  type CompletionState,
} from "./tool-execution.js"
import type { ApprovalAction } from "../types.js"

const MAX_CONSECUTIVE_INVALID = 3

function messageHasPlanFileWrite(session: ISession, messageId: string, cwd: string): boolean {
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg || !Array.isArray(msg.content)) return false
  const parts = msg.content as MessagePart[]
  for (const p of parts) {
    if (p.type !== "tool") continue
    const tp = p as ToolPart
    if (tp.tool !== "Write" && tp.tool !== "Edit") continue
    const raw = (tp.input?.file_path ?? tp.input?.path) as string | undefined
    if (!raw || typeof raw !== "string") continue
    const rel = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw
    const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "")
    if (PLAN_MODE_ALLOWED_WRITE_PATTERN.test(normalized)) return true
  }
  return false
}

export interface ProcessStreamStepOptions {
  client: LLMClient
  messages: LLMMessage[]
  tools: LLMToolDef[]
  systemPrompt: string
  cacheableSystemBlocks?: number
  maxTokens: number
  temperature?: number
  signal: AbortSignal
  session: ISession
  host: IHost
  config: NexusConfig
  mode: Mode
  resolvedTools: ToolDef[]
  toolCtx: ToolContext
  autoApproveActions: Set<string>
  mcpToolNames: Set<string>
  completionState: CompletionState | undefined
  newMessageId: string
  toolCallBudget: number
  /** Mutable ref: total tool calls executed so far (this session). */
  executedToolCallsTotalRef: { current: number }
  /** Mutable ref: consecutive invalid tool names (for doom detection). */
  consecutiveInvalidToolCallsRef: { current: number }
  /** Call when tool budget exceeded; sets forceFinalAnswerNext and emits. */
  onToolBudgetExceeded: () => void
  /** Call after token usage may have changed. */
  emitContextUsage: () => void | Promise<void>
}

export interface ProcessStepResult {
  /** Kilocode-style: continue next step, run compaction, or stop. */
  result: "continue" | "compact" | "stop"
  finishReason?: string
  sawNativeToolCall: boolean
  currentText: string
  currentReasoning: string
  executedToolThisIteration: boolean
  lastToolName: string
  attemptedCompletionThisIteration: boolean
  fatalStreamError: boolean
  budgetExceededThisIteration: boolean
  /** Set when context is near limit after this step (loop should compact). */
  needsCompaction?: boolean
}

/**
 * Kilocode-style inner processor: one stream() call, consume fullStream,
 * execute tools ourselves (approval, doom loop, plan mode, batching).
 * Returns result so the outer loop can decide: next step / compaction / stop.
 */
export async function processStreamStep(opts: ProcessStreamStepOptions): Promise<ProcessStepResult> {
  const {
    client,
    messages,
    tools: llmTools,
    systemPrompt,
    cacheableSystemBlocks,
    maxTokens,
    temperature,
    signal,
    session,
    host,
    config,
    mode,
    resolvedTools,
    toolCtx,
    autoApproveActions,
    mcpToolNames,
    completionState,
    newMessageId,
    toolCallBudget,
    executedToolCallsTotalRef,
    consecutiveInvalidToolCallsRef,
    onToolBudgetExceeded,
    emitContextUsage,
  } = opts

  let currentText = ""
  let currentReasoning = ""
  const pendingReads: Array<{ toolCallId: string; toolName: string; toolInput: Record<string, unknown> }> = []
  let lastToolName = ""
  let sawNativeToolCall = false
  let executedToolThisIteration = false
  let attemptedCompletionThisIteration = false
  let finishReason: string | undefined
  let fatalStreamError = false
  let budgetExceededThisIteration = false
  let needsCompaction = false

  const emit = async (e: import("../types.js").AgentEvent) => {
    await (host.emit(e) ?? Promise.resolve())
  }

  const flushAssistantContent = () => {
    const msg = session.messages.find((m) => m.id === newMessageId)
    const existingParts = msg && Array.isArray(msg.content) ? (msg.content as MessagePart[]) : []
    const toolParts = existingParts.filter((p): p is ToolPart => p.type === "tool")
    const parts: MessagePart[] = []
    if (currentReasoning) parts.push({ type: "reasoning", text: currentReasoning } as ReasoningPart)
    if (currentText) {
      parts.push({ type: "text", text: currentText } as TextPart)
    }
    parts.push(...toolParts)
    session.updateMessage(newMessageId, { content: parts.length > 0 ? parts : currentText || "" })
  }

  const flushPendingReads = async () => {
    if (pendingReads.length === 0) return

    const tasks = pendingReads.map(tc =>
      executeToolCall(
        tc.toolCallId,
        tc.toolName,
        tc.toolInput,
        resolvedTools,
        toolCtx,
        autoApproveActions,
        config,
        host,
        session,
        newMessageId,
        completionState,
        mode,
        mcpToolNames
      ).catch(err => ({ success: false, output: `Error: ${err.message}` }))
    )

    const results = await Promise.all(tasks)
    for (let i = 0; i < pendingReads.length; i++) {
      const tc = pendingReads[i]!
      const result = results[i]!
      const partId = `part_${tc.toolCallId}`

      session.updateToolPart(newMessageId, partId, {
        status: result.success ? "completed" : "error",
        output: result.output,
        timeEnd: Date.now(),
      })

      await emit({
        type: "tool_end",
        tool: tc.toolName,
        partId,
        messageId: newMessageId,
        success: result.success,
      })
      if (tc.toolName === "TodoWrite") {
        await emit({ type: "todo_updated", todo: session.getTodo() })
      }
      executedToolThisIteration = true
      executedToolCallsTotalRef.current++
    }

    pendingReads.length = 0
  }

  const emitToolEndPayload = async (
    toolName: string,
    toolInput: Record<string, unknown>,
    partId: string,
    result: { success: boolean; output: string; metadata?: Record<string, unknown> }
  ) => {
    await emit({
      type: "tool_end",
      tool: toolName,
      partId,
      messageId: newMessageId,
      success: result.success,
      output: result.output,
      error: result.success ? undefined : result.output,
      compacted: (result as { compacted?: boolean }).compacted,
      ...(result.success && (toolName === "Write" || toolName === "Edit")
        ? {
            path: extractWriteTargetPath(toolName, toolInput),
            writtenContent:
              typeof (result.metadata as { writtenContent?: string })?.writtenContent === "string"
                ? (result.metadata as { writtenContent: string }).writtenContent
                : undefined,
            ...(typeof (result.metadata as { addedLines?: number; removedLines?: number })?.addedLines === "number" &&
            typeof (result.metadata as { addedLines?: number; removedLines?: number })?.removedLines === "number"
              ? {
                  diffStats: {
                    added: (result.metadata as { addedLines: number; removedLines: number }).addedLines,
                    removed: (result.metadata as { addedLines: number; removedLines: number }).removedLines,
                  },
                }
              : {}),
            ...(Array.isArray((result.metadata as { diffHunks?: unknown[] })?.diffHunks)
              ? { diffHunks: (result.metadata as { diffHunks: Array<{ type: string; lineNum: number; line: string }> }).diffHunks }
              : {}),
          }
        : {}),
    })
  }

  try {
    streamLoop: for await (const event of client.stream({
      messages,
      tools: llmTools,
      systemPrompt,
      signal,
      cacheableSystemBlocks,
      maxTokens,
      temperature,
    })) {
      if (signal.aborted) break

      switch (event.type) {
        case "text_delta":
          if (event.delta) {
            currentText += event.delta
            flushAssistantContent()
            await emit({ type: "text_delta", delta: event.delta, messageId: newMessageId })
          }
          break

        case "reasoning_delta":
          if (event.delta) {
            currentReasoning += event.delta
            flushAssistantContent()
            await emit({ type: "reasoning_delta", delta: event.delta, messageId: newMessageId })
          }
          break

        case "tool_call": {
          const { toolCallId, toolName, toolInput } = event
          if (!toolCallId || !toolName || !toolInput) break
          sawNativeToolCall = true

          // Normalize ListDir: some providers/models send "paths" (array) or omit path; we only accept "path". Default ".".
          let normalizedToolInput: Record<string, unknown> =
            typeof toolInput === "object" && toolInput !== null ? { ...toolInput } : {}
          if (toolName === "ListDir") {
            const pathVal =
              typeof normalizedToolInput.path === "string" && normalizedToolInput.path.length > 0
                ? normalizedToolInput.path
                : Array.isArray(normalizedToolInput.paths) && typeof normalizedToolInput.paths[0] === "string"
                  ? normalizedToolInput.paths[0]
                  : "."
            normalizedToolInput = {
              path: pathVal,
              ignore: normalizedToolInput.ignore,
              recursive: normalizedToolInput.recursive,
              include: normalizedToolInput.include,
              max_entries: normalizedToolInput.max_entries,
              task_progress: normalizedToolInput.task_progress,
            }
          }

          const isKnownTool = resolvedTools.some(t => t.name === toolName)
          if (!isKnownTool) {
            consecutiveInvalidToolCallsRef.current++
            if (consecutiveInvalidToolCallsRef.current >= MAX_CONSECUTIVE_INVALID) {
              throw new Error(
                `Model called ${MAX_CONSECUTIVE_INVALID} non-existent tools in a row ("${toolName}" etc). Stopping to prevent infinite loop.`
              )
            }
          } else {
            consecutiveInvalidToolCallsRef.current = 0
          }

          if (executedToolCallsTotalRef.current + pendingReads.length >= toolCallBudget) {
            onToolBudgetExceeded()
            budgetExceededThisIteration = true
            break streamLoop
          }

          const partId = `part_${toolCallId}`
          session.addToolPart(newMessageId, {
            type: "tool",
            id: partId,
            tool: toolName,
            status: "pending",
            input: normalizedToolInput,
            timeStart: Date.now(),
          })

          await emit({ type: "tool_start", tool: toolName, partId, messageId: newMessageId, input: normalizedToolInput })

          if (await detectDoomLoop(session, toolName, normalizedToolInput)) {
            await emit({ type: "doom_loop_detected", tool: toolName })
            const threshold = toolName === "Bash" ? DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND : DOOM_LOOP_THRESHOLD
            if (typeof process !== "undefined" && process.stdin && !process.stdin.isTTY) {
              throw new Error(`Doom loop: tool "${toolName}" called ${threshold} times with same arguments. Aborting.`)
            }
            const doomAction: ApprovalAction = {
              type: "doom_loop",
              tool: toolName,
              description: `Potential infinite loop: "${toolName}" called ${threshold} times with same args. Continue anyway? [y]es [n]o (abort).`,
            }
            await emit({ type: "tool_approval_needed", action: doomAction, partId })
            const doomApproval = await Promise.race([
              host.showApprovalDialog(doomAction),
              new Promise<{ approved: boolean }>((_, reject) =>
                setTimeout(() => reject(new Error("Doom loop approval timed out (no response). Aborting.")), 60_000)
              ),
            ])
            if (!doomApproval.approved) {
              throw new Error(`User aborted doom loop for "${toolName}"`)
            }
          }

          if (READ_ONLY_TOOLS.has(toolName) && config.tools.parallelReads && !normalizedToolInput["task_progress"]) {
            pendingReads.push({ toolCallId, toolName, toolInput: normalizedToolInput })
            if (pendingReads.length >= config.tools.maxParallelReads) {
              await flushPendingReads()
            }
          } else {
            await flushPendingReads()

            // Plan mode: force writing the plan to .nexus/plans/ before PlanExit
            if (toolName === "PlanExit" && mode === "plan") {
              if (!messageHasPlanFileWrite(session, newMessageId, toolCtx.cwd)) {
                const errMsg =
                  "You must write the plan to a file in .nexus/plans/ (e.g. .nexus/plans/plan.md) before calling PlanExit. Create or update the plan file now, then call PlanExit again."
                session.updateToolPart(newMessageId, partId, {
                  status: "error",
                  output: errMsg,
                  timeEnd: Date.now(),
                })
                await emit({
                  type: "tool_end",
                  tool: toolName,
                  partId,
                  messageId: newMessageId,
                  success: false,
                  output: errMsg,
                })
                lastToolName = toolName
                executedToolThisIteration = true
                executedToolCallsTotalRef.current++
                break
              }
            }

            const result = await executeToolCall(
              toolCallId,
              toolName,
              normalizedToolInput,
              resolvedTools,
              toolCtx,
              autoApproveActions,
              config,
              host,
              session,
              newMessageId,
              completionState,
              mode,
              mcpToolNames
            )

            session.updateToolPart(newMessageId, partId, {
              status: result.success ? "completed" : "error",
              output: result.output,
              timeEnd: Date.now(),
            })

            await emitToolEndPayload(toolName, normalizedToolInput, partId, result)

            if (toolName === "TodoWrite") {
              await emit({ type: "todo_updated", todo: session.getTodo() })
            }

            lastToolName = toolName
            executedToolThisIteration = true
            executedToolCallsTotalRef.current++
            if (toolName === MANDATORY_END_TOOL[mode]) {
              attemptedCompletionThisIteration = true
            }
          }
          break
        }

        case "finish":
          await flushPendingReads()
          finishReason = event.finishReason

          if (event.usage) {
            session.updateMessage(newMessageId, {
              tokens: {
                input: event.usage.inputTokens,
                output: event.usage.outputTokens,
                cacheRead: event.usage.cacheReadTokens,
                cacheWrite: event.usage.cacheWriteTokens,
              },
            })
          }
          await (emitContextUsage() ?? Promise.resolve())
          break

        case "error":
          if (event.error) {
            await flushPendingReads()
            const message = event.error.message
            const isRetrying = message.startsWith("Retrying after error")
            await emit({ type: "error", error: message, fatal: !isRetrying })
            if (!isRetrying) {
              fatalStreamError = true
            }
          }
          break
      }

      if (budgetExceededThisIteration) {
        await flushPendingReads()
        break streamLoop
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await emit({ type: "error", error: errMsg })
    }
    return {
      result: "stop",
      sawNativeToolCall,
      currentText,
      currentReasoning,
      executedToolThisIteration,
      lastToolName,
      attemptedCompletionThisIteration,
      fatalStreamError: true,
      budgetExceededThisIteration,
    }
  }

  let result: "continue" | "compact" | "stop" = "continue"
  if (fatalStreamError || budgetExceededThisIteration) {
    result = "stop"
  } else if (needsCompaction) {
    result = "compact"
  }

  return {
    result,
    finishReason,
    sawNativeToolCall,
    currentText,
    currentReasoning,
    executedToolThisIteration,
    lastToolName,
    attemptedCompletionThisIteration,
    fatalStreamError,
    budgetExceededThisIteration,
    needsCompaction,
  }
}
