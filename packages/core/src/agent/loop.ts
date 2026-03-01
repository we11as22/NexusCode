import type { LLMClient } from "../provider/index.js"
import type {
  IHost,
  ISession,
  ToolDef,
  ToolContext,
  AgentEvent,
  NexusConfig,
  Mode,
  SkillDef,
  ApprovalAction,
  IIndexer,
  PermissionResult,
  TextPart,
  ReasoningPart,
  ToolPart,
  SessionRole,
  MessagePart,
} from "../types.js"
import type { LLMStreamEvent, LLMMessage, LLMToolDef } from "../provider/types.js"
import { buildSystemPrompt, type PromptContext } from "./prompts/components/index.js"
import { READ_ONLY_TOOLS, getBuiltinToolsForMode, getAutoApproveActions, getBlockedToolsForMode, PLAN_MODE_BLOCKED_EXTENSIONS, PLAN_MODE_ALLOWED_WRITE_PATTERN } from "./modes.js"
import { classifyTools, classifySkills } from "./classifier.js"
import { estimateTokens } from "../context/condense.js"
import { parseMentions } from "../context/mentions.js"
import type { SessionCompaction } from "../session/compaction.js"
import * as path from "node:path"

const DOOM_LOOP_THRESHOLD = 3
const BASE_TOOL_CALL_BUDGET_BY_MODE: Record<Mode, number> = {
  ask: 24,
  plan: 40,
  agent: 120,
  debug: 120,
}

export interface AgentLoopOptions {
  session: ISession
  client: LLMClient
  host: IHost
  config: NexusConfig
  mode: Mode
  tools: ToolDef[]
  skills: SkillDef[]
  rulesContent: string
  indexer?: IIndexer
  compaction: SessionCompaction
  signal: AbortSignal
  gitBranch?: string
}

/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const {
    session, client, host, config, mode,
    tools, skills, rulesContent, indexer, compaction,
    signal, gitBranch,
  } = opts

  const activeClient = client

  // 1. Resolve tools: built-ins always active + MCP/custom classified if >threshold
  //    Hard-blocked tools for this mode are NEVER included (even if sent as dynamic tools)
  const blockedTools = getBlockedToolsForMode(mode)
  const builtinToolNames = new Set(getBuiltinToolsForMode(mode))
  const builtinTools = tools.filter(t => builtinToolNames.has(t.name) && !blockedTools.has(t.name))
  const dynamicTools = tools.filter(t => !builtinToolNames.has(t.name) && !blockedTools.has(t.name))

  let resolvedDynamicTools: ToolDef[]
  if (dynamicTools.length > config.tools.classifyThreshold) {
    const lastMessage = session.messages[session.messages.length - 1]
    const taskDesc = typeof lastMessage?.content === "string"
      ? lastMessage.content
      : (lastMessage?.content as Array<{type: string; text?: string}>)?.find(p => p.type === "text")?.text ?? ""

    const selectedNames = await classifyTools(dynamicTools, taskDesc, activeClient)
    const selectedSet = new Set(selectedNames)
    resolvedDynamicTools = dynamicTools.filter(t => selectedSet.has(t.name))
  } else {
    resolvedDynamicTools = dynamicTools
  }

  const resolvedTools = [...builtinTools, ...resolvedDynamicTools]

  // 2. Resolve skills: classify if >threshold
  let resolvedSkills: SkillDef[]
  if (skills.length > config.skillClassifyThreshold) {
    const lastMessage = session.messages[session.messages.length - 1]
    const taskDesc = typeof lastMessage?.content === "string"
      ? lastMessage.content
      : (lastMessage?.content as Array<{type: string; text?: string}>)?.find(p => p.type === "text")?.text ?? ""

    resolvedSkills = await classifySkills(skills, taskDesc, activeClient)
  } else {
    resolvedSkills = skills
  }

  // Tool context
  const toolCtx: ToolContext = {
    cwd: host.cwd,
    host,
    session,
    config,
    indexer,
    signal,
  }

  const autoApproveActions = getAutoApproveActions(mode, config.modes[mode])
  const mentionsContext = await resolveMentionsContext(session, host)
  /**
   * Keep tracking across outer iterations; otherwise one invalid tool call per turn
   * can bypass the threshold forever.
   */
  let consecutiveInvalidToolCalls = 0
  const MAX_CONSECUTIVE_INVALID = 3
  let loopIterations = 0
  const baseMaxIterationsByMode: Record<Mode, number> = {
    ask: 10,
    plan: 16,
    agent: 32,
    debug: 32,
  }
  const maxIterations = config.maxMode.enabled
    ? Math.floor(baseMaxIterationsByMode[mode] * Math.max(1, Math.min(3, Number(config.maxMode.tokenBudgetMultiplier || 2))))
    : baseMaxIterationsByMode[mode]
  const toolBudgetMultiplier = config.maxMode.enabled
    ? Math.max(1, Math.min(3, Number(config.maxMode.tokenBudgetMultiplier || 2)))
    : 1
  const toolCallBudget = Math.max(8, Math.floor(BASE_TOOL_CALL_BUDGET_BY_MODE[mode] * toolBudgetMultiplier))
  let executedToolCallsTotal = 0
  let forceFinalAnswerNext = false
  let lastAssistantMessageId = ""
  const emitContextUsage = () => {
    const limitTokens = getContextLimit(activeClient.modelId)
    const usedTokens = session.getTokenEstimate()
    const percent = limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : 0
    host.emit({ type: "context_usage", usedTokens, limitTokens, percent })
  }
  emitContextUsage()

  while (!signal.aborted) {
    loopIterations++
    if (loopIterations > maxIterations) {
      host.emit({
        type: "error",
        error: `Agent loop stopped after ${maxIterations} iterations in ${mode} mode (safety limit).`,
        fatal: true,
      })
      break
    }
    const isFinalIteration = forceFinalAnswerNext || loopIterations === maxIterations

    // 3. Build system prompt (cache-aware)
    const promptCtx: PromptContext = {
      mode,
      maxMode: config.maxMode.enabled,
      config,
      cwd: host.cwd,
      modelId: activeClient.modelId,
      providerName: activeClient.providerName,
      skills: resolvedSkills,
      rulesContent,
      indexStatus: indexer?.status(),
      gitBranch,
      todoList: session.getTodo(),
      compactionSummary: getCompactionSummary(session),
      mentionsContext,
    }

    const { blocks, cacheableCount } = buildSystemPrompt(promptCtx)
    if (isFinalIteration) {
      blocks.push("FINAL ITERATION: do not call tools. Return a concise final answer from gathered context.")
    }
    const systemPrompt = blocks.join("\n\n---\n\n")

    // 4. Build LLM tool definitions
    const llmTools: LLMToolDef[] = (isFinalIteration ? [] : resolvedTools).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    // 5. Build messages from session
    const messages = buildMessagesFromSession(session)
    if (isFinalIteration) {
      messages.push({
        role: "user",
        content: "Provide the final answer now in plain text only. Do not emit tool-call markup, XML, or JSON function calls.",
      })
    }

    // 6. Start streaming
    const newMessageId = session.addMessage({
      role: "assistant",
      content: "",
    }).id
    lastAssistantMessageId = newMessageId

    let currentText = ""
    const pendingReads: Array<{ toolCallId: string; toolName: string; toolInput: Record<string, unknown> }> = []
    let lastToolName = ""
    let sawNativeToolCall = false
    let executedToolThisIteration = false
    let attemptedCompletionThisIteration = false
    let finishReason: string | undefined
    let fatalStreamError = false
    let budgetExceededThisIteration = false

    const markToolBudgetExceeded = () => {
      if (budgetExceededThisIteration) return
      budgetExceededThisIteration = true
      forceFinalAnswerNext = true
      host.emit({
        type: "error",
        error: `Tool-call budget reached (${toolCallBudget}). Forcing final answer without additional tools.`,
        fatal: false,
      })
    }

    const flushPendingReads = async () => {
      if (pendingReads.length === 0) return

      const tasks = pendingReads.map(tc =>
        executeToolCall(tc.toolCallId, tc.toolName, tc.toolInput, resolvedTools, toolCtx, autoApproveActions, config, host, session, newMessageId)
          .catch(err => ({ success: false, output: `Error: ${err.message}` }))
      )

      const results = await Promise.all(tasks)
      for (let i = 0; i < pendingReads.length; i++) {
        const tc = pendingReads[i]!
        const result = results[i]!
        const partId = `part_${tc.toolCallId}`

        // CRITICAL: update the tool part in the session with the result
        // This is what buildMessagesFromSession reads to include in the next LLM call
        session.updateToolPart(newMessageId, partId, {
          status: result.success ? "completed" : "error",
          output: result.output,
          timeEnd: Date.now(),
        })

        host.emit({
          type: "tool_end",
          tool: tc.toolName,
          partId,
          messageId: newMessageId,
          success: result.success,
        })
        executedToolThisIteration = true
        executedToolCallsTotal++
      }

      pendingReads.length = 0
    }

    try {
      const tokenMultiplier = config.maxMode.enabled
        ? Math.max(1, Math.min(6, Number(config.maxMode.tokenBudgetMultiplier || 2)))
        : 1
      const maxTokens = Math.floor(8192 * tokenMultiplier)

      streamLoop: for await (const event of activeClient.stream({
        messages,
        tools: llmTools,
        systemPrompt,
        signal,
        cacheableSystemBlocks: cacheableCount,
        maxTokens,
        temperature: config.model.temperature,
      })) {
        if (signal.aborted) break

        switch (event.type) {
          case "text_delta":
            if (event.delta) {
              currentText += event.delta
              session.updateMessage(newMessageId, { content: currentText })
              host.emit({ type: "text_delta", delta: event.delta, messageId: newMessageId })
            }
            break

          case "reasoning_delta":
            if (event.delta) {
              host.emit({ type: "reasoning_delta", delta: event.delta, messageId: newMessageId })
            }
            break

          case "tool_call": {
            const { toolCallId, toolName, toolInput } = event
            if (!toolCallId || !toolName || !toolInput) break
            sawNativeToolCall = true

            // Track invalid tool calls — if model keeps calling non-existent tools, stop it
            const isKnownTool = resolvedTools.some(t => t.name === toolName)
            if (!isKnownTool) {
              consecutiveInvalidToolCalls++
              if (consecutiveInvalidToolCalls >= MAX_CONSECUTIVE_INVALID) {
                throw new Error(
                  `Model called ${consecutiveInvalidToolCalls} non-existent tools in a row ("${toolName}" etc). ` +
                  `This likely indicates model confusion. Stopping to prevent infinite loop.`
                )
              }
            } else {
              consecutiveInvalidToolCalls = 0
            }

            if (executedToolCallsTotal + pendingReads.length >= toolCallBudget) {
              markToolBudgetExceeded()
              break
            }

            // Create pending tool part
            const partId = `part_${toolCallId}`
            session.addToolPart(newMessageId, {
              type: "tool",
              id: partId,
              tool: toolName,
              status: "pending",
              input: toolInput,
              timeStart: Date.now(),
            })

            host.emit({ type: "tool_start", tool: toolName, partId, messageId: newMessageId })

            // Inform host of available tools list so UI/user knows context
            // Check task_progress parameter
            if (toolInput["task_progress"] && typeof toolInput["task_progress"] === "string") {
              session.updateTodo(toolInput["task_progress"])
            }

            // DOOM LOOP DETECTION — halt if same tool called 3x with identical args
            if (await detectDoomLoop(session, toolName, toolInput)) {
              host.emit({ type: "doom_loop_detected", tool: toolName })
              // In non-interactive mode always abort to prevent infinite loops
              if (!process.stdin.isTTY) {
                throw new Error(`Doom loop: tool "${toolName}" called ${DOOM_LOOP_THRESHOLD} times with same arguments. Aborting.`)
              }
              const doomApproval = await host.showApprovalDialog({
                type: "doom_loop",
                tool: toolName,
                description: `Potential infinite loop: "${toolName}" called ${DOOM_LOOP_THRESHOLD} times with same args.`,
              })
              if (!doomApproval.approved) {
                throw new Error(`User aborted doom loop for "${toolName}"`)
              }
            }

            // Parallel reads: batch
            if (READ_ONLY_TOOLS.has(toolName) && config.tools.parallelReads && !toolInput["task_progress"]) {
              pendingReads.push({ toolCallId, toolName, toolInput })
              if (pendingReads.length >= config.tools.maxParallelReads) {
                await flushPendingReads()
              }
            } else {
              // Sequential: flush pending reads first
              await flushPendingReads()

              const result = await executeToolCall(
                toolCallId, toolName, toolInput,
                resolvedTools, toolCtx, autoApproveActions, config, host, session, newMessageId
              )

              session.updateToolPart(newMessageId, partId, {
                status: result.success ? "completed" : "error",
                output: result.output,
                timeEnd: Date.now(),
              })

              host.emit({
                type: "tool_end",
                tool: toolName,
                partId,
                messageId: newMessageId,
                success: result.success,
              })

              lastToolName = toolName
              executedToolThisIteration = true
              executedToolCallsTotal++
              if (toolName === "attempt_completion") {
                attemptedCompletionThisIteration = true
              }
            }
            break
          }

          case "finish":
            await flushPendingReads()
            finishReason = event.finishReason

            // Update token usage
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
            emitContextUsage()

            break

          case "error":
            if (event.error) {
              await flushPendingReads()
              const message = event.error.message
              const isRetrying = message.startsWith("Retrying after error")
              host.emit({ type: "error", error: message, fatal: !isRetrying })
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
      if (signal.aborted) break
      const errMsg = err instanceof Error ? err.message : String(err)
      host.emit({ type: "error", error: errMsg })

      // Check for context overflow error
      if (isContextOverflowError(errMsg)) {
        await handleCompaction(session, activeClient, config, host, compaction, signal)
        continue
      }
      break
    }

    if (!isFinalIteration && !sawNativeToolCall) {
      const textualCalls = parseTextualToolCalls(currentText)
      if (textualCalls.length > 0) {
        const cleaned = stripTextualToolCalls(currentText).trim()
        if (cleaned !== currentText) {
          currentText = cleaned
          session.updateMessage(newMessageId, { content: currentText })
        }

        for (let i = 0; i < textualCalls.length; i++) {
          if (executedToolCallsTotal >= toolCallBudget) {
            markToolBudgetExceeded()
            break
          }
          const call = textualCalls[i]!
          const syntheticCallId = `textual_${loopIterations}_${i}_${Date.now()}`
          const partId = `part_${syntheticCallId}`
          session.addToolPart(newMessageId, {
            type: "tool",
            id: partId,
            tool: call.toolName,
            status: "pending",
            input: call.toolInput,
            timeStart: Date.now(),
          })
          host.emit({ type: "tool_start", tool: call.toolName, partId, messageId: newMessageId })

          if (call.toolInput["task_progress"] && typeof call.toolInput["task_progress"] === "string") {
            session.updateTodo(call.toolInput["task_progress"])
          }

          if (await detectDoomLoop(session, call.toolName, call.toolInput)) {
            host.emit({ type: "doom_loop_detected", tool: call.toolName })
            throw new Error(`Doom loop: tool "${call.toolName}" repeatedly called via textual tool-call markup.`)
          }

          const result = await executeToolCall(
            syntheticCallId,
            call.toolName,
            call.toolInput,
            resolvedTools,
            toolCtx,
            autoApproveActions,
            config,
            host,
            session,
            newMessageId
          )

          session.updateToolPart(newMessageId, partId, {
            status: result.success ? "completed" : "error",
            output: result.output,
            timeEnd: Date.now(),
          })

          host.emit({
            type: "tool_end",
            tool: call.toolName,
            partId,
            messageId: newMessageId,
            success: result.success,
          })

          lastToolName = call.toolName
          executedToolThisIteration = true
          executedToolCallsTotal++
          if (call.toolName === "attempt_completion") {
            attemptedCompletionThisIteration = true
          }
        }

        finishReason = "tool_calls"
      }
    }

    // Stop on fatal stream errors; without this the outer loop can repeat forever.
    if (fatalStreamError) {
      break
    }
    if (budgetExceededThisIteration) {
      await session.save()
      emitContextUsage()
      continue
    }

    // Check if done
    if (attemptedCompletionThisIteration || lastToolName === "attempt_completion") break
    if (finishReason === "stop" && !executedToolThisIteration) break
    if (signal.aborted) break

    // Check for context overflow proactively
    const tokenCount = session.getTokenEstimate()
    const contextLimit = getContextLimit(activeClient.modelId)
    if (contextLimit > 0 && tokenCount / contextLimit > config.summarization.threshold) {
      host.emit({ type: "compaction_start" })
      await handleCompaction(session, activeClient, config, host, compaction, signal)
      host.emit({ type: "compaction_end" })
    }

    await session.save()
    emitContextUsage()
  }

  if (!signal.aborted && lastAssistantMessageId) {
    emitContextUsage()
    host.emit({ type: "done", messageId: lastAssistantMessageId })
  }
}

function parseTextualToolCalls(text: string): Array<{ toolName: string; toolInput: Record<string, unknown> }> {
  if (!text || !text.includes("<tool_call>")) return []
  const calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
  const blockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRe.exec(text)) !== null) {
    const block = blockMatch[1] ?? ""
    const fnMatch = block.match(/<function=([A-Za-z0-9_\-]+)>/i)
    if (!fnMatch?.[1]) continue
    const toolName = fnMatch[1].trim()
    const toolInput: Record<string, unknown> = {}

    const paramRe = /<parameter=([A-Za-z0-9_\-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi
    let paramMatch: RegExpExecArray | null
    while ((paramMatch = paramRe.exec(block)) !== null) {
      const key = (paramMatch[1] ?? "").trim()
      const valueRaw = (paramMatch[2] ?? "").trim()
      if (!key) continue
      toolInput[key] = parseLooseValue(valueRaw)
    }

    if (Object.keys(toolInput).length === 0) {
      const argsMatch = block.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/i)
      if (argsMatch?.[1]) {
        try {
          const parsed = JSON.parse(argsMatch[1]) as Record<string, unknown>
          Object.assign(toolInput, parsed)
        } catch {
          // Ignore malformed JSON arguments blocks.
        }
      }
    }

    calls.push({ toolName, toolInput })
  }
  return calls
}

function stripTextualToolCalls(text: string): string {
  if (!text) return text
  return text.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, "").trim()
}

function parseLooseValue(value: string): unknown {
  if (!value) return ""
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

async function executeToolCall(
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  tools: ToolDef[],
  ctx: ToolContext,
  autoApproveActions: Set<string>,
  config: NexusConfig,
  host: IHost,
  session: ISession,
  messageId: string
): Promise<{ success: boolean; output: string }> {
  const tool = tools.find(t => t.name === toolName)
  if (!tool) {
    const availableList = tools.map(t => t.name).join(", ")
    return {
      success: false,
      output: `ERROR: Tool "${toolName}" does not exist. IMPORTANT: Use ONLY these available tools: ${availableList}. To run shell commands, use execute_command. To present final results, use attempt_completion.`,
    }
  }

  // Restricted modes (plan/ask): allow writes only to .nexus/plans/*.md|*.txt
  if (ctx.config.modes && ["write_to_file", "replace_in_file", "apply_patch"].includes(toolName)) {
    // We infer restricted modes by tool availability: execute_command is unavailable in plan/ask.
    const isRestrictedMode = !tools.some(t => t.name === "execute_command")
    if (isRestrictedMode) {
      const targetPath = extractWriteTargetPath(toolName, toolInput)
      if (!targetPath) {
        return {
          success: false,
          output: "In the current mode, write operations require an explicit target path under .nexus/plans/*.md or .txt.",
        }
      }
      const rel = path.isAbsolute(targetPath) ? path.relative(ctx.cwd, targetPath) : targetPath
      const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "")
      if (!PLAN_MODE_ALLOWED_WRITE_PATTERN.test(normalized)) {
        const extMatch = normalized.match(/\.[a-zA-Z0-9]+$/)
        const ext = extMatch ? extMatch[0].toLowerCase() : ""
        if (ext && PLAN_MODE_BLOCKED_EXTENSIONS.has(ext)) {
          return {
            success: false,
            output: `In the current mode, you cannot modify source code files (${ext}). You may only write plan docs in .nexus/plans/*.md or .txt.`,
          }
        }
        return {
          success: false,
          output: "In the current mode, you may only write plan documentation files under .nexus/plans/ (*.md or *.txt).",
        }
      }
    }
  }

  // --- Evaluate permission rules (fine-grained, first-match wins) ---
  const ruleResult = evaluatePermissionRules(toolName, toolInput, config)
  if (ruleResult === "deny") {
    const ruleReason = findRuleReason(toolName, toolInput, config)
    return { success: false, output: `Access denied by permission rule${ruleReason ? `: ${ruleReason}` : ""}` }
  }
  if (ruleResult === "ask") {
    const action = buildApprovalAction(toolName, toolInput)
    action.description = `[Permission Rule] ${action.description}`
    host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` })
    const approval = await host.showApprovalDialog(action)
    if (!approval.approved) {
      return { success: false, output: `User denied ${toolName}` }
    }
  }

  // --- Legacy deny patterns (kept for backwards compat) ---
  if (ruleResult === null && toolInput["path"] && typeof toolInput["path"] === "string") {
    for (const pattern of config.permissions.denyPatterns) {
      if (matchesGlob(toolInput["path"], pattern)) {
        return { success: false, output: `Access denied: path matches deny pattern "${pattern}"` }
      }
    }
  }

  // --- Standard approval flow (only when no explicit rule matched) ---
  if (ruleResult === null) {
    const needsApproval = toolNeedsApproval(toolName, toolInput, autoApproveActions, config)
    if (needsApproval) {
      const action = buildApprovalAction(toolName, toolInput)
      host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` })

      const approval = await host.showApprovalDialog(action)
      if (!approval.approved) {
        return { success: false, output: `User denied ${toolName}` }
      }
    }
  }

  // Validate args
  let validatedArgs: unknown
  try {
    validatedArgs = tool.parameters.parse(toolInput)
  } catch (err) {
    return { success: false, output: `Invalid arguments for ${toolName}: ${err}` }
  }

  // Execute
  try {
    const result = await tool.execute(validatedArgs as Record<string, unknown>, ctx)

    // Keep code index fresh after successful file edits in both CLI and VSCode hosts.
    if (result.success && ctx.indexer && ["write_to_file", "replace_in_file", "apply_patch"].includes(toolName)) {
      const targetPath = extractWriteTargetPath(toolName, validatedArgs as Record<string, unknown>)
      const refreshFile = ctx.indexer.refreshFile
      const refreshFileNow = ctx.indexer.refreshFileNow
      if (targetPath && (refreshFileNow || refreshFile)) {
        const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(ctx.cwd, targetPath)
        try {
          if (refreshFileNow) {
            await refreshFileNow.call(ctx.indexer, absolutePath)
          } else if (refreshFile) {
            await refreshFile.call(ctx.indexer, absolutePath)
          }
        } catch {
          // Ignore index refresh errors; they should not fail a successful write.
        }
      }
    }

    return { success: result.success, output: result.output }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: `Tool ${toolName} error: ${msg}` }
  }
}

async function detectDoomLoop(
  session: ISession,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<boolean> {
  const allParts = session.messages
    .flatMap(m => {
      if (!Array.isArray(m.content)) return []
      return (m.content as Array<{type: string; tool?: string; input?: Record<string, unknown>}>)
        .filter(p => p.type === "tool" && p.tool === toolName)
        .map(p => p.input)
    })
    .slice(-DOOM_LOOP_THRESHOLD)

  if (allParts.length < DOOM_LOOP_THRESHOLD) return false

  const inputSig = JSON.stringify(toolInput)
  return allParts.every(p => JSON.stringify(p) === inputSig)
}

function getCompactionSummary(session: ISession): string | undefined {
  const summaryMsg = [...session.messages].reverse().find(m => m.summary)
  if (!summaryMsg) return undefined
  return typeof summaryMsg.content === "string" ? summaryMsg.content : undefined
}

async function handleCompaction(
  session: ISession,
  client: LLMClient,
  config: NexusConfig,
  host: IHost,
  compaction: SessionCompaction,
  signal: AbortSignal
) {
  try {
    // First try prune (no LLM call needed)
    compaction.prune(session)

    // Check again
    const tokenCount = session.getTokenEstimate()
    const contextLimit = getContextLimit(client.modelId)
    if (contextLimit > 0 && tokenCount / contextLimit > config.summarization.threshold) {
      // Full compaction with LLM
      await compaction.compact(session, client, signal)
    }
  } catch (err) {
    console.warn("[nexus] Compaction failed:", err)
  }
}

/**
 * Build messages for the LLM from session history.
 *
 * Vercel AI SDK expects interleaved format:
 *   [user] question
 *   [assistant] { type: "tool-call", toolCallId, toolName, args }
 *   [tool]      { type: "tool-result", toolCallId, toolName, result }
 *   [assistant] final text answer
 *
 * This function converts our session format (assistant messages that contain
 * both the text AND tool call parts) into that interleaved format.
 */
function buildMessagesFromSession(session: ISession): LLMMessage[] {
  const messages: LLMMessage[] = []

  for (const msg of session.messages) {
    // Compaction summary → inject as conversation_summary block
    if (msg.summary) {
      messages.push({
        role: "user",
        content: `<conversation_summary>\n${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}\n</conversation_summary>`,
      })
      continue
    }

    if (msg.role === "system") continue

    // ── Simple string content ────────────────────────────────────────────────
    if (typeof msg.content === "string") {
      if (!msg.content.trim()) continue
      if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content })
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content })
      }
      // role "tool" with string content = legacy, skip
      continue
    }

    // ── Complex content (array of parts) ────────────────────────────────────
    const parts = msg.content as MessagePart[]
    if (!Array.isArray(parts) || parts.length === 0) continue

    if (msg.role === "user") {
      // User messages with parts (mentions, etc.)
      const textContent = parts
        .filter((p): p is TextPart => p.type === "text")
        .map(p => p.text)
        .join("")
        .trim()
      if (textContent) {
        messages.push({ role: "user", content: textContent })
      }
      continue
    }

    if (msg.role !== "assistant") continue

    // ── Assistant message ────────────────────────────────────────────────────
    const textParts = parts.filter((p): p is TextPart => p.type === "text")
    const reasoningParts = parts.filter((p): p is ReasoningPart => p.type === "reasoning")
    const toolParts = parts.filter((p): p is ToolPart => p.type === "tool")

    const textContent = textParts.map(p => p.text).join("").trim()
    const toolCallParts = toolParts.filter(tp => tp.input != null)
    const completedToolParts = toolParts.filter(tp => tp.status === "completed" || tp.status === "error")

    if (toolCallParts.length > 0) {
      // Assistant message with tool calls
      const assistantContent: Array<Record<string, unknown>> = []

      if (textContent) {
        assistantContent.push({ type: "text", text: textContent })
      }
      for (const tp of toolCallParts) {
        assistantContent.push({
          type: "tool-call",
          toolCallId: tp.id,
          toolName: tp.tool,
          args: tp.input ?? {},
        })
      }
      messages.push({ role: "assistant", content: assistantContent as LLMMessage["content"] })

      // Tool results as a "tool" role message (AI SDK format)
      if (completedToolParts.length > 0) {
        const toolResultContent = completedToolParts.map(tp => ({
          type: "tool-result",
          toolCallId: tp.id,
          toolName: tp.tool,
          result: tp.compacted
            ? "[output pruned for context efficiency]"
            : (tp.output ?? ""),
          isError: tp.status === "error",
        }))
        messages.push({ role: "tool" as SessionRole, content: toolResultContent as LLMMessage["content"] })
      }
    } else if (textContent) {
      // Pure text response (no tool calls)
      messages.push({ role: "assistant", content: textContent })
    }
  }

  return messages
}

async function resolveMentionsContext(session: ISession, host: IHost): Promise<string | undefined> {
  const latestUser = [...session.messages]
    .reverse()
    .find((msg) => msg.role === "user" && typeof msg.content === "string")

  if (!latestUser || typeof latestUser.content !== "string") return undefined
  if (!latestUser.content.includes("@")) return undefined

  try {
    const resolved = await parseMentions(latestUser.content, host.cwd, host)
    if (resolved.contextBlocks.length === 0) return undefined

    if (resolved.text !== latestUser.content) {
      session.updateMessage(latestUser.id, { content: resolved.text })
    }

    return resolved.contextBlocks.join("\n\n")
  } catch {
    return undefined
  }
}


function toolNeedsApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  autoApproveActions: Set<string>,
  config: NexusConfig
): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) {
    if (autoApproveActions.has("read")) return false
    // Check auto-approve patterns
    if (toolInput["path"] && typeof toolInput["path"] === "string") {
      for (const pattern of config.permissions.autoApproveReadPatterns) {
        if (matchesGlob(toolInput["path"], pattern)) return false
      }
    }
    return !config.permissions.autoApproveRead
  }
  if (["write_to_file", "replace_in_file", "apply_patch"].includes(toolName)) {
    return !config.permissions.autoApproveWrite && !autoApproveActions.has("write")
  }
  if (toolName === "execute_command") {
    return !config.permissions.autoApproveCommand && !autoApproveActions.has("execute")
  }
  return false
}

function buildApprovalAction(toolName: string, toolInput: Record<string, unknown>): ApprovalAction {
  if (["write_to_file", "replace_in_file"].includes(toolName)) {
    return {
      type: "write",
      tool: toolName,
      description: `Write to ${toolInput["path"] ?? "file"}`,
      content: toolInput["content"] as string | undefined,
    }
  }
  if (toolName === "execute_command") {
    return {
      type: "execute",
      tool: toolName,
      description: `Run: ${toolInput["command"]}`,
    }
  }
  return {
    type: "read",
    tool: toolName,
    description: `${toolName}(${JSON.stringify(toolInput).slice(0, 100)})`,
  }
}

/**
 * Evaluate fine-grained permission rules.
 * Returns "allow", "deny", "ask", or null (no rule matched → use default logic).
 */
function evaluatePermissionRules(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: NexusConfig
): "allow" | "deny" | "ask" | null {
  const rules = config.permissions.rules ?? []
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue
    if (rule.pathPattern && !ruleMatchesPath(rule.pathPattern, toolInput)) continue
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue
    return rule.action
  }
  return null
}

function findRuleReason(toolName: string, toolInput: Record<string, unknown>, config: NexusConfig): string | undefined {
  const rules = config.permissions.rules ?? []
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue
    if (rule.pathPattern && !ruleMatchesPath(rule.pathPattern, toolInput)) continue
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue
    return rule.reason
  }
  return undefined
}

function ruleMatchesTool(pattern: string | undefined, toolName: string): boolean {
  if (!pattern) return true
  // Support glob patterns and exact matches
  if (pattern.includes("*") || pattern.includes("?")) {
    return matchesGlob(toolName, pattern)
  }
  return pattern === toolName || toolName.startsWith(pattern + "_")
}

function ruleMatchesPath(pathPattern: string, toolInput: Record<string, unknown>): boolean {
  const filePath = toolInput["path"] as string | undefined
  if (!filePath) return false
  return matchesGlob(filePath, pathPattern)
}

function ruleMatchesCommand(commandPattern: string, toolInput: Record<string, unknown>): boolean {
  const command = String(toolInput["command"] ?? "")
  try {
    return new RegExp(commandPattern).test(command)
  } catch {
    return command.includes(commandPattern)
  }
}

function matchesGlob(filePath: string, pattern: string): boolean {
  try {
    // Use basic glob matching without dynamic require
    return globMatch(filePath, pattern)
  } catch {
    return filePath.includes(pattern.replace(/\*/g, ""))
  }
}

/**
 * Simple glob matching without external deps.
 * Supports * (single segment), ** (any depth), ? (single char), {a,b} (alternatives).
 */
function globMatch(str: string, pattern: string): boolean {
  // Convert glob to regex
  let regexStr = ""
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*"
        i += 2
        if (pattern[i] === "/") i++ // skip trailing slash after **
      } else {
        regexStr += "[^/]*"
        i++
      }
    } else if (c === "?") {
      regexStr += "[^/]"
      i++
    } else if (c === "{") {
      const end = pattern.indexOf("}", i)
      if (end === -1) { regexStr += "\\{"; i++; continue }
      const alts = pattern.slice(i + 1, end).split(",").map(escapeRegex)
      regexStr += `(?:${alts.join("|")})`
      i = end + 1
    } else {
      regexStr += escapeRegex(c)
      i++
    }
  }
  try {
    return new RegExp(`^${regexStr}$`).test(str)
  } catch {
    return str.includes(pattern.replace(/[*?{}]/g, ""))
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^$|()[\]\\]/g, "\\$&")
}

function isContextOverflowError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("max tokens") ||
    lower.includes("too long") ||
    lower.includes("token limit")
  )
}

function extractWriteTargetPath(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  if (typeof toolInput["path"] === "string" && toolInput["path"]) {
    return toolInput["path"] as string
  }
  if (toolName === "apply_patch" && typeof toolInput["patch"] === "string") {
    const patch = toolInput["patch"] as string
    const match = patch.match(/^(?:---|\+\+\+)\s+(?:a\/|b\/)?(.+?)(?:\t.*)?$/m)
    if (match?.[1] && match[1] !== "/dev/null") {
      return match[1]
    }
  }
  return undefined
}

function getContextLimit(modelId: string): number {
  const lower = modelId.toLowerCase()
  if (lower.includes("claude-3") || lower.includes("claude-4") || lower.includes("claude-sonnet") || lower.includes("claude-opus")) return 200000
  if (lower.includes("gpt-4o")) return 128000
  if (lower.includes("gpt-4")) return 128000
  if (lower.includes("gpt-3.5")) return 16000
  if (lower.includes("gemini-2")) return 1000000
  if (lower.includes("gemini")) return 200000
  return 128000 // default
}

function estimateTokensFallback(text: string): number {
  return Math.ceil(text.length / 4)
}
