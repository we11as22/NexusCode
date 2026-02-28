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
} from "../types.js"
import type { LLMStreamEvent, LLMMessage, LLMToolDef } from "../provider/types.js"
import { buildSystemPrompt, type PromptContext } from "./prompts/components/index.js"
import { READ_ONLY_TOOLS, getBuiltinToolsForMode, getAutoApproveActions } from "./modes.js"
import { classifyTools, classifySkills } from "./classifier.js"
import { estimateTokens } from "../context/condense.js"
import type { SessionCompaction } from "../session/compaction.js"

const DOOM_LOOP_THRESHOLD = 3

export interface AgentLoopOptions {
  session: ISession
  client: LLMClient
  maxModeClient?: LLMClient
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
    session, client, maxModeClient, host, config, mode,
    tools, skills, rulesContent, indexer, compaction,
    signal, gitBranch,
  } = opts

  const activeClient = (config.maxMode.enabled && maxModeClient) ? maxModeClient : client

  // 1. Resolve tools: built-ins always active + MCP/custom classified if >threshold
  const builtinToolNames = new Set(getBuiltinToolsForMode(mode))
  const builtinTools = tools.filter(t => builtinToolNames.has(t.name))
  const dynamicTools = tools.filter(t => !builtinToolNames.has(t.name))

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

  while (!signal.aborted) {
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
      mentionsContext: undefined,
    }

    const { blocks, cacheableCount } = buildSystemPrompt(promptCtx)
    const systemPrompt = blocks.join("\n\n---\n\n")

    // 4. Build LLM tool definitions
    const llmTools: LLMToolDef[] = resolvedTools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    // 5. Build messages from session
    const messages = buildMessagesFromSession(session)

    // 6. Start streaming
    const newMessageId = session.addMessage({
      role: "assistant",
      content: "",
    }).id

    let currentText = ""
    const pendingReads: Array<{ toolCallId: string; toolName: string; toolInput: Record<string, unknown> }> = []
    let lastToolName = ""
    let finishReason: string | undefined

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
        session.updateMessage(newMessageId, {
          content: currentText,
        })
        // Add tool result to messages for next iteration
        session.addMessage({
          role: "tool",
          content: JSON.stringify({ toolCallId: tc.toolCallId, result: result.output }),
        })
      }

      pendingReads.length = 0
    }

    try {
      for await (const event of activeClient.stream({
        messages,
        tools: llmTools,
        systemPrompt,
        signal,
        cacheableSystemBlocks: cacheableCount,
        maxTokens: config.maxMode.enabled ? 16384 : 8192,
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

            // Check task_progress parameter
            if (toolInput["task_progress"] && typeof toolInput["task_progress"] === "string") {
              session.updateTodo(toolInput["task_progress"])
            }

            // DOOM LOOP DETECTION
            if (await detectDoomLoop(session, toolName, toolInput)) {
              host.emit({ type: "doom_loop_detected", tool: toolName })
              const doomApproval = await host.showApprovalDialog({
                type: "doom_loop",
                tool: toolName,
                description: `Potential infinite loop detected: tool "${toolName}" called ${DOOM_LOOP_THRESHOLD} times with same arguments.`,
              })
              if (!doomApproval.approved) {
                signal.throwIfAborted()
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

            host.emit({ type: "done", messageId: newMessageId })
            break

          case "error":
            if (event.error) {
              await flushPendingReads()
              host.emit({ type: "error", error: event.error.message })
            }
            break
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

    // Check if done
    if (lastToolName === "attempt_completion") break
    if (finishReason === "stop" && !lastToolName) break
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
  }
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
    return { success: false, output: `Unknown tool: ${toolName}` }
  }

  // Check deny patterns
  if (toolInput["path"] && typeof toolInput["path"] === "string") {
    for (const pattern of config.permissions.denyPatterns) {
      if (matchesGlob(toolInput["path"], pattern)) {
        return { success: false, output: `Access denied: path matches deny pattern "${pattern}"` }
      }
    }
  }

  // Check if approval needed
  const needsApproval = toolNeedsApproval(toolName, toolInput, autoApproveActions, config)
  if (needsApproval) {
    const action = buildApprovalAction(toolName, toolInput)
    host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` })

    const approval = await host.showApprovalDialog(action)
    if (!approval.approved) {
      return { success: false, output: `User denied ${toolName}` }
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

function buildMessagesFromSession(session: ISession): LLMMessage[] {
  const messages: LLMMessage[] = []

  for (const msg of session.messages) {
    if (msg.summary) {
      // Compaction summaries go as user messages
      messages.push({ role: "user", content: `<conversation_summary>\n${msg.content}\n</conversation_summary>` })
      continue
    }

    if (msg.role === "system") continue

    if (typeof msg.content === "string") {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content })
      }
      continue
    }

    // Complex content with tool calls
    const parts = msg.content as Array<unknown>
    const contentParts: LLMMessage["content"] = []

    if (typeof contentParts !== "string") {
      for (const partUnknown of parts) {
        const part = partUnknown as Record<string, unknown>
        if (part["type"] === "text") {
          (contentParts as Array<{type: string; text: string}>).push({ type: "text", text: part["text"] as string })
        } else if (part["type"] === "tool") {
          const tp = part as {type: string; tool: string; id: string; input?: Record<string, unknown>; output?: string; status: string}
          if (tp.status === "completed" || tp.status === "error") {
            (contentParts as Array<{type: string; toolCallId: string; toolName?: string; result?: string; isError?: boolean; args?: Record<string, unknown>}>).push({
              type: "tool_result",
              toolCallId: tp.id,
              result: tp.output ?? "",
              isError: tp.status === "error",
            })
          }
        }
      }
    }

    if (Array.isArray(contentParts) && contentParts.length > 0) {
      messages.push({ role: msg.role as "user" | "assistant", content: contentParts as LLMMessage["content"] })
    }
  }

  return messages
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

function matchesGlob(filePath: string, pattern: string): boolean {
  // Simple glob matching
  try {
    const { minimatch } = require("minimatch")
    return minimatch(filePath, pattern, { dot: true })
  } catch {
    return filePath.includes(pattern.replace(/\*/g, ""))
  }
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
