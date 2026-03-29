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
import { normalizedAppliedReplacementsFromMetadata } from "../tools/applied-replacements.js"
import * as path from "node:path"
import { READ_ONLY_TOOLS, MANDATORY_END_TOOL, PLAN_MODE_ALLOWED_WRITE_PATTERN } from "./modes.js"
import {
  buildUserMessageForInvalidSdkToolArgs,
  isAiSdkInvalidToolArgumentsError,
} from "./tool-sdk-recovery.js"
import {
  executeToolCall,
  detectDoomLoop,
  extractWriteTargetPath,
  DOOM_LOOP_THRESHOLD,
  DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND,
  type CompletionState,
} from "./tool-execution.js"
import type { ApprovalAction, PermissionResult } from "../types.js"
import {
  buildReasoningProviderOptions,
  getDefaultTemperature,
  getDefaultTopK,
  getDefaultTopP,
} from "../provider/provider-options.js"
import { findLastOpenReasoningPartIndex } from "./reasoning-segment-utils.js"

const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

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
  promptCacheKey?: string
  maxTokens: number
  temperature?: number
  topP?: number
  topK?: number
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
  /** AI SDK rejected tool-call args; a user message was injected — outer loop should call the model again. */
  sdkInvalidToolArgsRecovery?: boolean
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
    promptCacheKey,
    maxTokens,
    temperature,
    topP,
    topK,
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
    onToolBudgetExceeded,
    emitContextUsage,
  } = opts

  let currentText = ""
  let currentReasoning = ""
  let currentReasoningId: string | undefined
  let currentReasoningMetadata: Record<string, unknown> | undefined
  let currentReasoningDurationMs: number | undefined
  let currentReasoningStartedAt: number | undefined
  let sawReasoningSignal = false
  const pendingReads: Array<{ toolCallId: string; toolName: string; toolInput: Record<string, unknown> }> = []
  let lastToolName = ""
  let sawNativeToolCall = false
  let executedToolThisIteration = false
  let attemptedCompletionThisIteration = false
  let finishReason: string | undefined
  let fatalStreamError = false
  let sdkInvalidToolArgsRecovery = false
  let budgetExceededThisIteration = false
  let needsCompaction = false

  const emit = async (e: import("../types.js").AgentEvent) => {
    await (host.emit(e) ?? Promise.resolve())
  }

  const flushAssistantContent = () => {
    const msg = session.messages.find((m) => m.id === newMessageId)
    const existingParts = msg && Array.isArray(msg.content) ? (msg.content as MessagePart[]) : []
    const parts: MessagePart[] = [...existingParts]
    if (currentReasoning || sawReasoningSignal || currentReasoningDurationMs != null) {
      const openIdx = findLastOpenReasoningPartIndex(parts, currentReasoningId)
      const reasoningText =
        currentReasoning ||
        (openIdx >= 0 ? ((parts[openIdx] as ReasoningPart).text ?? "") : "") ||
        THOUGHT_PLACEHOLDER
      if (openIdx >= 0) {
        parts[openIdx] = {
          ...(parts[openIdx] as ReasoningPart),
          text: reasoningText,
          ...(currentReasoningId ? { reasoningId: currentReasoningId } : {}),
          ...(currentReasoningDurationMs != null ? { durationMs: currentReasoningDurationMs } : {}),
          ...(currentReasoningMetadata ? { providerMetadata: currentReasoningMetadata } : {}),
        } as ReasoningPart
      } else if (currentReasoning || sawReasoningSignal) {
        parts.push({
          type: "reasoning",
          text: reasoningText,
          ...(currentReasoningId ? { reasoningId: currentReasoningId } : {}),
          ...(currentReasoningDurationMs != null ? { durationMs: currentReasoningDurationMs } : {}),
          ...(currentReasoningMetadata ? { providerMetadata: currentReasoningMetadata } : {}),
        } as ReasoningPart)
      }
    }
    if (currentText) {
      const textIdx = parts.findIndex((p) => p.type === "text")
      if (textIdx >= 0) {
        parts[textIdx] = {
          ...(parts[textIdx] as TextPart),
          text: currentText,
        } as TextPart
      } else {
        parts.push({ type: "text", text: currentText } as TextPart)
      }
    }
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
        output: result.output,
        error: result.success ? undefined : result.output,
        metadata: "metadata" in result ? result.metadata : undefined,
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
    const appliedReplacements = normalizedAppliedReplacementsFromMetadata(result.metadata)
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
            ...(appliedReplacements ? { appliedReplacements } : {}),
          }
        : {}),
    })
  }

  try {
    const providerOptions = buildReasoningProviderOptions(config.model, client.providerName)
    const retryMaxAttempts = config.retry?.enabled === false
      ? 1
      : Math.max(1, config.retry?.maxAttempts ?? 3)
    streamLoop: for await (const event of client.stream({
      messages,
      tools: llmTools,
      systemPrompt,
      signal,
      cacheableSystemBlocks,
      promptCacheKey,
      maxTokens,
      temperature: temperature ?? config.model.temperature ?? getDefaultTemperature(config.model),
      topP: topP ?? getDefaultTopP(config.model),
      topK: topK ?? getDefaultTopK(config.model),
      providerOptions,
      reasoningHistoryMode: config.model.reasoningHistoryMode ?? "auto",
      maxRetries: retryMaxAttempts,
      initialRetryDelayMs: config.retry?.initialDelayMs,
      maxRetryDelayMs: config.retry?.maxDelayMs,
      retryOnStatus: config.retry?.retryOnStatus,
    })) {
      if (signal.aborted) break

      switch (event.type) {
        case "reasoning_start":
          sawReasoningSignal = true
          currentReasoningId = event.reasoningId ?? currentReasoningId ?? "reasoning-0"
          currentReasoningMetadata = event.providerMetadata ?? currentReasoningMetadata
          currentReasoningStartedAt = currentReasoningStartedAt ?? Date.now()
          currentReasoningDurationMs = undefined
          flushAssistantContent()
          await emit({
            type: "reasoning_start",
            messageId: newMessageId,
            reasoningId: currentReasoningId,
            providerMetadata: event.providerMetadata,
          })
          break

        case "text_delta":
          if (event.delta) {
            currentText += event.delta
            flushAssistantContent()
            await emit({ type: "text_delta", delta: event.delta, messageId: newMessageId })
          }
          break

        case "reasoning_delta":
          sawReasoningSignal = true
          currentReasoningId = event.reasoningId ?? currentReasoningId
          currentReasoningMetadata = event.providerMetadata ?? currentReasoningMetadata
          currentReasoningStartedAt = currentReasoningStartedAt ?? Date.now()
          if (event.delta) {
            currentReasoning += event.delta
            flushAssistantContent()
          } else {
            flushAssistantContent()
          }
          await emit({
            type: "reasoning_delta",
            delta: event.delta ?? "",
            messageId: newMessageId,
            reasoningId: event.reasoningId,
            providerMetadata: event.providerMetadata,
          })
          break

        case "reasoning_end":
          if (currentReasoningStartedAt != null) {
            currentReasoningDurationMs = Math.max(1, Date.now() - currentReasoningStartedAt)
          }
          currentReasoningId = event.reasoningId ?? currentReasoningId
          currentReasoningMetadata = event.providerMetadata ?? currentReasoningMetadata
          currentReasoningStartedAt = undefined
          flushAssistantContent()
          await emit({
            type: "reasoning_end",
            messageId: newMessageId,
            reasoningId: currentReasoningId ?? event.reasoningId,
            providerMetadata: event.providerMetadata,
          })
          currentReasoning = ""
          currentReasoningDurationMs = undefined
          break

        case "tool_call": {
          if (currentReasoning.trim().length > 0 || currentReasoningStartedAt != null) {
            if (currentReasoningStartedAt != null) {
              currentReasoningDurationMs = Math.max(1, Date.now() - currentReasoningStartedAt)
            }
            flushAssistantContent()
            await emit({
              type: "reasoning_end",
              messageId: newMessageId,
              reasoningId: currentReasoningId,
            })
            currentReasoning = ""
            currentReasoningStartedAt = undefined
            currentReasoningDurationMs = undefined
          }
          let { toolCallId, toolName, toolInput } = event
          if (!toolCallId || !toolName || !toolInput) break
          sawNativeToolCall = true

          // CLI/gateway may send list_dir or ListDirectory; resolve to builtin "List"
          if (
            toolName === "list_dir" ||
            toolName === "ListDirectory" ||
            toolName === "list_directory"
          )
            toolName = "List"

          // Normalize List: some providers/models send "paths" (array) or omit path; we only accept "path". Default ".".
          let normalizedToolInput: Record<string, unknown> =
            typeof toolInput === "object" && toolInput !== null ? { ...toolInput } : {}
          if (toolName === "List") {
            const pathVal =
              typeof normalizedToolInput.path === "string" && normalizedToolInput.path.length > 0
                ? normalizedToolInput.path
                : Array.isArray(normalizedToolInput.paths) && normalizedToolInput.paths.length > 0 && typeof normalizedToolInput.paths[0] === "string"
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
            const tty = typeof process !== "undefined" && process.stdin && process.stdin.isTTY
            let proceed = false
            if (tty) {
              const doomAction: ApprovalAction = {
                type: "doom_loop",
                tool: toolName,
                description: `Potential infinite loop: "${toolName}" called ${threshold} times with same args. Continue anyway? [y]es [n]o (abort).`,
              }
              await emit({ type: "tool_approval_needed", action: doomAction, partId })
              const doomApproval = await Promise.race([
                host.showApprovalDialog(doomAction),
                new Promise<PermissionResult>((resolve) =>
                  setTimeout(() => resolve({ approved: false }), 60_000)
                ),
              ]).catch((): PermissionResult => ({ approved: false }))
              proceed = doomApproval.approved
            }
            if (!proceed) {
              const errMsg =
                toolName === "Bash"
                  ? `Same Bash command was run ${threshold} times with identical arguments. Stop repeating it: read prior output and errors, fix the command or approach, then continue differently.`
                  : `Same tool "${toolName}" was called ${threshold} times with identical arguments. Stop the loop: check prior tool results, correct inputs, or choose another action.`
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
                error: errMsg,
              })
              lastToolName = toolName
              executedToolThisIteration = true
              executedToolCallsTotalRef.current++
              break
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
              ...(result.success && (toolName === "Write" || toolName === "Edit")
                ? {
                    path: extractWriteTargetPath(toolName, normalizedToolInput),
                    ...(typeof (result.metadata as { addedLines?: number; removedLines?: number })?.addedLines === "number" &&
                    typeof (result.metadata as { addedLines?: number; removedLines?: number })?.removedLines === "number"
                      ? { diffStats: { added: (result.metadata as { addedLines: number; removedLines: number }).addedLines, removed: (result.metadata as { addedLines: number; removedLines: number }).removedLines } }
                      : {}),
                  }
                : {}),
            })

            await emitToolEndPayload(toolName, normalizedToolInput, partId, result)

            if (toolName === "TodoWrite") {
              await emit({ type: "todo_updated", todo: session.getTodo() })
            }

            lastToolName = toolName
            executedToolThisIteration = true
            executedToolCallsTotalRef.current++
            if ((result.metadata as { questionRequest?: boolean } | undefined)?.questionRequest) {
              attemptedCompletionThisIteration = true
              await flushPendingReads()
              break streamLoop
            }
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
            const err = event.error
            const message = err.message
            const isRetrying = message.startsWith("Retrying after error")
            if (!isRetrying && isAiSdkInvalidToolArgumentsError(err)) {
              sdkInvalidToolArgsRecovery = true
              session.addMessage({
                role: "user",
                content: buildUserMessageForInvalidSdkToolArgs(err),
              })
              await emit({ type: "error", error: message, fatal: false })
              break
            }
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
      sdkInvalidToolArgsRecovery,
    }
  }

  let result: "continue" | "compact" | "stop" = "continue"
  // Provider/gateway may close stream without explicit finish event.
  const normalizedFinishReason = finishReason ?? (fatalStreamError ? undefined : "stop")
  if (fatalStreamError || budgetExceededThisIteration) {
    result = "stop"
  } else if (needsCompaction) {
    result = "compact"
  }

  return {
    result,
    finishReason: normalizedFinishReason,
    sawNativeToolCall,
    currentText,
    currentReasoning,
    executedToolThisIteration,
    lastToolName,
    attemptedCompletionThisIteration,
    fatalStreamError,
    budgetExceededThisIteration,
    needsCompaction,
    ...(sdkInvalidToolArgsRecovery ? { sdkInvalidToolArgsRecovery: true } : {}),
  }
}
