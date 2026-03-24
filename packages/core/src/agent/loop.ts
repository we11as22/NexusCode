import type { LLMClient } from "../provider/index.js"
import type {
  IHost,
  ISession,
  ToolDef,
  ToolResult,
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
  ImagePart,
  SessionRole,
  MessagePart,
  DiagnosticItem,
} from "../types.js"
import type { LLMStreamEvent, LLMMessage, LLMToolDef } from "../provider/types.js"
import { buildSystemPrompt, type PromptContext } from "./prompts/components/index.js"
import { getInitialProjectContext } from "./prompts/initial-context.js"
import { READ_ONLY_TOOLS, getBuiltinToolsForMode, getAutoApproveActions, getBlockedToolsForMode, PLAN_MODE_BLOCKED_EXTENSIONS, PLAN_MODE_ALLOWED_WRITE_PATTERN, MANDATORY_END_TOOL } from "./modes.js"
import { classifyMcpServers, classifySkills } from "./classifier.js"
import {
  formatToolValidationError,
  normalizeToolInputForParse,
  formatToolAttemptForLanguageModel,
  detectDoomLoop,
  DOOM_LOOP_THRESHOLD,
  DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND,
} from "./tool-execution.js"
import {
  buildUserMessageForInvalidSdkToolArgs,
  isAiSdkInvalidToolArgumentsError,
} from "./tool-sdk-recovery.js"
import { getBackgroundBashJobsForPrompt } from "../tools/built-in/execute-command.js"
import { ftsTopSkills } from "../skills/fts.js"
import { parseMentions } from "../context/mentions.js"
import type { SessionCompaction } from "../session/compaction.js"
import { getMessagesForActiveContext } from "../session/active-context.js"
import {
  computeContextUsageMetrics,
  estimateToolsDefinitionsTokens,
  getContextWindowLimit,
} from "../context/context-usage.js"
import * as path from "node:path"
import * as fs from "node:fs"
import {
  buildReasoningProviderOptions,
  getDefaultTemperature,
  getDefaultTopK,
  getDefaultTopP,
} from "../provider/provider-options.js"

/** Generous tool budgets so multi-file tasks can complete. */
const BASE_TOOL_CALL_BUDGET_BY_MODE: Record<Mode, number> = {
  ask: 80,
  plan: 80,
  agent: 200,
  debug: 200,
  review: 120,
}

const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

/** When a mandatory end tool (e.g. PlanExit) completes, set its output as user_message on the last text part of the message (so UI and context see it). */
function setReportToUserMessage(session: ISession, messageId: string, userMessage: string): void {
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg || !userMessage.trim()) return
  let parts: MessagePart[] =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : [...(msg.content as MessagePart[])]
  const lastTextIdx = parts.map((p, i) => (p.type === "text" ? i : -1)).filter((i) => i >= 0).pop()
  if (lastTextIdx !== undefined) {
    const part = parts[lastTextIdx] as TextPart
    parts[lastTextIdx] = { ...part, user_message: (part.user_message ?? "").trim() ? `${part.user_message}\n${userMessage.trim()}` : userMessage.trim() }
  } else {
    parts.push({ type: "text", text: "", user_message: userMessage.trim() })
  }
  session.updateMessage(messageId, { content: parts })
}

/** Returns true if the given message contains a Write or Edit to .nexus/plans/ (for PlanExit gate). */
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

/** Returns true when at least one plan file exists on disk in .nexus/plans (*.md|*.txt). */
function hasPlanFileOnDisk(cwd: string): boolean {
  try {
    const plansDir = path.join(cwd, ".nexus", "plans")
    const entries = fs.readdirSync(plansDir, { withFileTypes: true })
    return entries.some(
      (entry) =>
        entry.isFile() &&
        (entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase().endsWith(".txt"))
    )
  } catch {
    return false
  }
}

/** Returns true if the message already contains a call to the mode's mandatory end tool. */
function messageHasMandatoryEndTool(session: ISession, messageId: string, mode: Mode): boolean {
  const mandatory = MANDATORY_END_TOOL[mode]
  if (!mandatory) return true
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg || !Array.isArray(msg.content)) return false
  const parts = msg.content as MessagePart[]
  return parts.some((p) => p.type === "tool" && (p as ToolPart).tool === mandatory)
}

/** User message from plan-followup "revise" (extension/CLI); must match controller copy. */
function lastUserMessageRequestsPlanRevision(session: ISession): boolean {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]!
    if (m.role !== "user") continue
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as MessagePart[])
              .filter((p): p is TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")
          : ""
    return (
      text.includes("Revise the current implementation plan based on this feedback.") &&
      text.includes("User feedback / requested changes:")
    )
  }
  return false
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
  /** When set, commit on completion of an agent turn and optionally double-check. */
  checkpoint?: { commit(description?: string): Promise<string> }
  /** When true, inject create-skill instructions; host must allow writes to .nexus/skills and .cursor/skills */
  createSkillMode?: boolean
}

/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const {
    session, client, host, config, mode,
    tools, skills, rulesContent, indexer, compaction,
    signal, gitBranch, checkpoint, createSkillMode,
  } = opts

  const activeClient = client

  // 1. Resolve tools: built-ins by mode + dynamic (MCP/custom); blocked tools NEVER included in allowed set.
  //    System prompt (buildSystemPrompt) and tool set both use the same `mode` — promptCtx.mode and
  //    getBlockedToolsForMode(mode) / getBuiltinToolsForMode(mode) are derived from this single value on every run.
  const blockedTools = getBlockedToolsForMode(mode)
  const builtinToolNames = new Set(getBuiltinToolsForMode(mode))
  // Vector search is opt-in: when disabled, codebase_search is not available.
  if (!config.indexing?.vector || !config.vectorDb?.enabled) {
    builtinToolNames.delete("codebase_search")
  }
  const builtinTools = tools.filter(t => builtinToolNames.has(t.name) && !blockedTools.has(t.name))
  const dynamicTools = tools.filter(t => !builtinToolNames.has(t.name) && !blockedTools.has(t.name))

  const lastMessage = session.messages[session.messages.length - 1]
  const taskDesc = typeof lastMessage?.content === "string"
    ? lastMessage.content
    : (lastMessage?.content as Array<{ type: string; text?: string }>)?.find(p => p.type === "text")?.text ?? ""

  // Build MCP server list from dynamic tools (name format: "serverName__toolName"). Custom tools have no "__".
  const serverToTools = new Map<string, ToolDef[]>()
  const customDynamicTools: ToolDef[] = []
  for (const t of dynamicTools) {
    const sep = t.name.indexOf("__")
    if (sep === -1) {
      customDynamicTools.push(t)
    } else {
      const server = t.name.slice(0, sep)
      if (!serverToTools.has(server)) serverToTools.set(server, [])
      serverToTools.get(server)!.push(t)
    }
  }
  const mcpServerCount = serverToTools.size
  const needClassifyMcpServers = config.tools.classifyToolsEnabled && mcpServerCount > config.tools.classifyThreshold
  const needClassifySkills = config.skillClassifyEnabled && skills.length > config.skillClassifyThreshold

  let resolvedDynamicTools: ToolDef[]
  let resolvedSkills: SkillDef[]
  if (needClassifyMcpServers && needClassifySkills) {
    const serverInfos = [...serverToTools.entries()].map(([name, tools]) => ({
      name,
      toolCount: tools.length,
      toolNames: tools.map(t => t.name),
    }))
    const [selectedServerNames, skillResults] = await Promise.all([
      classifyMcpServers(serverInfos, taskDesc, activeClient),
      (() => {
        const candidates = ftsTopSkills(skills, taskDesc, 20)
        return classifySkills(candidates, taskDesc, activeClient)
      })(),
    ])
    const selectedServers = new Set(selectedServerNames)
    resolvedDynamicTools = [
      ...customDynamicTools,
      ...([...serverToTools.entries()]
        .filter(([server]) => selectedServers.has(server))
        .flatMap(([, tools]) => tools)),
    ]
    resolvedSkills = skillResults
  } else if (needClassifyMcpServers) {
    const serverInfos = [...serverToTools.entries()].map(([name, tools]) => ({
      name,
      toolCount: tools.length,
      toolNames: tools.map(t => t.name),
    }))
    const selectedServerNames = await classifyMcpServers(serverInfos, taskDesc, activeClient)
    const selectedServers = new Set(selectedServerNames)
    resolvedDynamicTools = [
      ...customDynamicTools,
      ...([...serverToTools.entries()]
        .filter(([server]) => selectedServers.has(server))
        .flatMap(([, tools]) => tools)),
    ]
    resolvedSkills = skills
  } else if (needClassifySkills) {
    resolvedDynamicTools = dynamicTools
    const candidates = ftsTopSkills(skills, taskDesc, 20)
    resolvedSkills = await classifySkills(candidates, taskDesc, activeClient)
  } else {
    resolvedDynamicTools = dynamicTools
    resolvedSkills = skills
  }

  const blockedFallbackTools: ToolDef[] = []
  for (const blockedName of blockedTools) {
    if (builtinTools.some((t) => t.name === blockedName) || resolvedDynamicTools.some((t) => t.name === blockedName)) continue
    const original = tools.find((t) => t.name === blockedName)
    if (!original) continue
    blockedFallbackTools.push({
      ...original,
      description: `${original.description} (disabled in ${mode} mode)`,
      execute: async () => ({
        success: false,
        output: `ERROR: Tool "${blockedName}" is disabled in ${mode} mode. Use only tools allowed in this mode.`,
      }),
    })
  }

  const resolvedTools = [...builtinTools, ...resolvedDynamicTools, ...blockedFallbackTools]
  const mcpToolNames = new Set(resolvedDynamicTools.filter(t => t.name.includes("__")).map(t => t.name))

  // Tool context
  const toolCtx: ToolContext = {
    cwd: host.cwd,
    host,
    session,
    config,
    mode,
    indexer,
    signal,
    resolvedTools,
    compactSession: async () => {
      host.emit({ type: "compaction_start" })
      await handleCompaction(session, activeClient, config, host, compaction, signal)
      host.emit({ type: "compaction_end" })
    },
  }

  const autoApproveActions = getAutoApproveActions(mode, config.modes?.[mode])
  const mentionsContext = await resolveMentionsContext(session, host)
  const initialProjectContext = await getInitialProjectContext(host.cwd)
  let loopIterations = 0
  const baseMaxIterationsByMode: Record<Mode, number> = {
    ask: 24,
    plan: 24,
    agent: 48,
    debug: 48,
    review: 36,
  }
  const toolBudgetFromConfig = config.agentLoop?.toolCallBudget
  const iterFromConfig = config.agentLoop?.maxIterations
  const effectiveToolBudget: Record<Mode, number> = {
    ask: toolBudgetFromConfig?.ask ?? BASE_TOOL_CALL_BUDGET_BY_MODE.ask,
    plan: toolBudgetFromConfig?.plan ?? BASE_TOOL_CALL_BUDGET_BY_MODE.plan,
    agent: toolBudgetFromConfig?.agent ?? BASE_TOOL_CALL_BUDGET_BY_MODE.agent,
    debug: toolBudgetFromConfig?.debug ?? BASE_TOOL_CALL_BUDGET_BY_MODE.debug,
    review: toolBudgetFromConfig?.review ?? BASE_TOOL_CALL_BUDGET_BY_MODE.review,
  }
  const effectiveMaxIterations: Record<Mode, number> = {
    ask: iterFromConfig?.ask ?? baseMaxIterationsByMode.ask,
    plan: iterFromConfig?.plan ?? baseMaxIterationsByMode.plan,
    agent: iterFromConfig?.agent ?? baseMaxIterationsByMode.agent,
    debug: iterFromConfig?.debug ?? baseMaxIterationsByMode.debug,
    review: iterFromConfig?.review ?? baseMaxIterationsByMode.review,
  }
  const maxIterations = effectiveMaxIterations[mode] ?? baseMaxIterationsByMode[mode]
  const toolCallBudget = Math.max(8, effectiveToolBudget[mode] ?? BASE_TOOL_CALL_BUDGET_BY_MODE[mode])
  let executedToolCallsTotal = 0
  let forceFinalAnswerNext = false
  let forceEmptyResponseRecoveryPromptNext = false
  let consecutiveEmptyFinalResponses = 0
  const maxEmptyFinalResponseRetries = 2
  let contextOverflowRetries = 0
  const MAX_CONTEXT_OVERFLOW_RETRIES = 3
  let lastAssistantMessageId = ""
  const doubleCheckCompletion = config.checkpoint?.doubleCheckCompletion === true
  const completionState = {
    doubleCheckEnabled: doubleCheckCompletion,
    pending: { current: false },
    checkpoint: opts.checkpoint,
  }
  /** Full system prompt from the last completed loop iteration (for context bar + next iteration's pre-build estimate). */
  let lastBuiltSystemPrompt = ""
  const toolsDefinitionTokens = estimateToolsDefinitionsTokens(resolvedTools)
  const emitContextUsage = (systemPromptText?: string) => {
    const text = systemPromptText ?? lastBuiltSystemPrompt
    const metrics = computeContextUsageMetrics({
      sessionMessages: session.messages,
      systemPromptText: text || undefined,
      toolsDefinitionTokens,
      modelId: activeClient.modelId,
      configuredContextWindow: config.model.contextWindow,
    })
    session.recordContextUsage({
      usedTokens: metrics.usedTokens,
      limitTokens: metrics.limitTokens,
      percent: metrics.percent,
    })
    host.emit({
      type: "context_usage",
      usedTokens: metrics.usedTokens,
      limitTokens: metrics.limitTokens,
      percent: metrics.percent,
    })
  }

  let lastToolName = ""
  let attemptedCompletionThisIteration = false
  let doneEmitted = false
  while (!signal.aborted) {
    loopIterations++

    // Proactive context management: prune/compact before building prompt when near limit
    const limitForCompaction = getContextWindowLimit(activeClient.modelId, config.model.contextWindow)
    if (limitForCompaction > 0 && loopIterations > 1) {
      let sessionTokens = session.getTokenEstimate()
      const threshold = config.summarization?.threshold ?? 0.75
      if (compaction.isOverflow(sessionTokens, limitForCompaction, threshold)) {
        compaction.prune(session)
        sessionTokens = session.getTokenEstimate()
        if (compaction.isOverflow(sessionTokens, limitForCompaction, threshold)) {
          host.emit({ type: "compaction_start" })
          await handleCompaction(session, activeClient, config, host, compaction, signal)
          host.emit({ type: "compaction_end" })
        }
      }
    }

    if (loopIterations > maxIterations) {
      if (!forceFinalAnswerNext) {
        host.emit({
          type: "error",
          error: `Agent loop stopped after ${maxIterations} iterations in ${mode} mode (safety limit).`,
          fatal: true,
        })
        break
      }
    }
    const isFinalIteration = forceFinalAnswerNext || loopIterations >= maxIterations

    // 3. Build system prompt (cache-aware). Cap getProblems() so first message is not delayed (e.g. VSCode getDiagnostics can be slow).
    const PROBLEMS_TIMEOUT_MS = 800
    const diagnostics = host.getProblems
      ? await Promise.race([
          host.getProblems(),
          new Promise<DiagnosticItem[]>((r) => setTimeout(() => r([]), PROBLEMS_TIMEOUT_MS)),
        ])
      : []
    const rollingCtx = computeContextUsageMetrics({
      sessionMessages: session.messages,
      systemPromptText: lastBuiltSystemPrompt || undefined,
      toolsDefinitionTokens,
      modelId: activeClient.modelId,
      configuredContextWindow: config.model.contextWindow,
    })
    const limitTokens = rollingCtx.limitTokens
    const usedTokens = rollingCtx.usedTokens
    const contextPercent = rollingCtx.percent
    const promptCtx: PromptContext = {
      mode, // same mode used for tool resolution above; system prompt block and Environment "Current mode" come from this
      config,
      cwd: host.cwd,
      modelId: activeClient.modelId,
      providerName: activeClient.providerName,
      skills: resolvedSkills,
      rulesContent,
      indexStatus: indexer?.status(),
      gitBranch,
      todoList: session.getTodo(),
      compactionSummary: undefined,
      mentionsContext,
      initialProjectContext,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      contextUsedTokens: usedTokens,
      contextLimitTokens: limitTokens > 0 ? limitTokens : undefined,
      contextPercent: limitTokens > 0 ? contextPercent : undefined,
      backgroundJobsSummary: getBackgroundBashJobsForPrompt(host.cwd),
      createSkillMode: createSkillMode === true,
      supportsStructuredOutput: activeClient.supportsStructuredOutput(),
    }

    const { blocks, cacheableCount } = buildSystemPrompt(promptCtx)
    if (isFinalIteration) {
      blocks.push(
        "CRITICAL — MAXIMUM STEPS REACHED\n\n" +
        "The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.\n\n" +
        "STRICT REQUIREMENTS:\n" +
        "1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools).\n" +
        "2. MUST provide a text response summarizing work done so far.\n" +
        "3. Include: what was accomplished, any remaining tasks, and what should be done next.\n" +
        "Any attempt to use tools is a critical violation. Respond with text ONLY."
      )
    } else if (loopIterations >= Math.floor(maxIterations * 0.8)) {
      blocks.push(
        `NOTICE — APPROACHING STEP LIMIT\n\n` +
        `You have used ${loopIterations} of ${maxIterations} allowed steps in ${mode} mode. ` +
        `Begin wrapping up. Prioritize completing the most important remaining work and delivering ` +
        `a clear summary response. Avoid starting new sub-tasks or broad explorations.`
      )
    }
    const systemPrompt = blocks.join("\n\n---\n\n")
    lastBuiltSystemPrompt = systemPrompt

    // Emit context usage including system prompt so UI shows real request size
    emitContextUsage(systemPrompt)

    // 4. Build LLM tool definitions
    const llmTools: LLMToolDef[] = (isFinalIteration ? [] : resolvedTools).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    // 5. Build messages from session
    const messages = buildMessagesFromSession(session)

    // On the very first iteration of a new agent invocation that has prior history, inject a brief
    // context annotation (Codex-style: environment context as a message event, not just system prompt).
    // This is ephemeral — not stored in session — so it doesn't affect compaction or token estimates.
    if (loopIterations === 1) {
      const priorTurns = session.messages.filter(m => m.role === "user" || m.role === "assistant")
      if (priorTurns.length > 1) {
        const today = new Date().toISOString().split("T")[0]
        messages.push({
          role: "user",
          content: `[Context: New agent turn — mode: ${mode}, cwd: ${host.cwd}, date: ${today}]`,
        })
      }
    }

    // No separate "reflection" or "thinking" step between tool runs: we do not call the LLM again
    // just to reflect between tools. One iteration = one stream(); reasoning comes only from the model's own stream (reasoning_delta) if supported.
    if (isFinalIteration) {
      messages.push({
        role: "user",
        content: "Provide the final answer now in plain text only. Do not emit tool-call markup, XML, or JSON function calls.",
      })
      if (forceEmptyResponseRecoveryPromptNext) {
        messages.push({
          role: "user",
          content: "Your previous response was empty. Return a concise plain-text answer now (no tool calls, no XML/JSON markup).",
        })
        forceEmptyResponseRecoveryPromptNext = false
      }
    } else if (forceEmptyResponseRecoveryPromptNext) {
      messages.push({
        role: "user",
        content: "Your previous response was empty. Return a concise plain-text answer now (or call tools only if strictly necessary).",
      })
      forceEmptyResponseRecoveryPromptNext = false
    }
    // 6. Start streaming
    const newMessageId = session.addMessage({
      role: "assistant",
      content: "",
    }).id
    lastAssistantMessageId = newMessageId
    host.emit({ type: "assistant_message_started", messageId: newMessageId })

    let currentText = ""
    let currentReasoning = ""
    let currentReasoningId: string | undefined
    let currentReasoningMetadata: Record<string, unknown> | undefined
    let currentReasoningDurationMs: number | undefined
    let currentReasoningStartedAt: number | undefined
    let sawReasoningSignal = false
    const pendingReads: Array<{ toolCallId: string; toolName: string; toolInput: Record<string, unknown> }> = []
    lastToolName = ""
    let sawNativeToolCall = false
    let executedToolThisIteration = false
    attemptedCompletionThisIteration = false
    let finishReason: string | undefined
    let fatalStreamError = false
    /** When the AI SDK rejects tool-call args before execution, we inject a user hint and must not treat the turn as a normal text-only stop. */
    let sdkInvalidToolArgsRecovery = false
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

    /** Persist reasoning + text + tool parts to session. Reasoning only from provider reasoning_delta (Thought block); text_delta is plain text. */
    const flushAssistantContent = () => {
      const msg = session.messages.find((m) => m.id === newMessageId)
      const existingParts = msg && Array.isArray(msg.content) ? (msg.content as MessagePart[]) : []
      const parts: MessagePart[] = [...existingParts]
      const reasoningIdx = parts.findIndex((p) => p.type === "reasoning")
      if (currentReasoning) {
        const reasoningText = currentReasoning
        if (reasoningIdx >= 0) {
          parts[reasoningIdx] = {
            ...(parts[reasoningIdx] as ReasoningPart),
            text: reasoningText,
            ...(currentReasoningId ? { reasoningId: currentReasoningId } : {}),
            ...(currentReasoningDurationMs != null ? { durationMs: currentReasoningDurationMs } : {}),
            ...(currentReasoningMetadata ? { providerMetadata: currentReasoningMetadata } : {}),
          } as ReasoningPart
        } else {
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
        executeToolCall(tc.toolCallId, tc.toolName, tc.toolInput, resolvedTools, toolCtx, autoApproveActions, config, host, session, newMessageId, completionState, mode, mcpToolNames)
          .catch(err => ({ success: false, output: `Error: ${err.message}`, metadata: undefined }))
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
          output: result.output,
          error: result.success ? undefined : result.output,
          metadata: result.metadata,
        })
        if (tc.toolName === "TodoWrite") {
          host.emit({ type: "todo_updated", todo: session.getTodo() })
        }
        executedToolThisIteration = true
        executedToolCallsTotal++
      }

      pendingReads.length = 0
    }

    try {
      const maxTokens = 8192
      const providerOptions = buildReasoningProviderOptions(config.model, activeClient.providerName)
      const retryMaxAttempts = config.retry?.enabled === false
        ? 1
        : Math.max(1, config.retry?.maxAttempts ?? 3)

      // So UI shows current todo (e.g. after load or from previous turn)
      const currentTodo = session.getTodo()
      if (currentTodo.trim()) host.emit({ type: "todo_updated", todo: currentTodo })

      streamLoop: for await (const event of activeClient.stream({
        messages,
        tools: llmTools,
        systemPrompt,
        signal,
        cacheableSystemBlocks: cacheableCount,
        promptCacheKey: session.id,
        maxTokens,
        temperature: config.model.temperature ?? getDefaultTemperature(config.model),
        topP: getDefaultTopP(config.model),
        topK: getDefaultTopK(config.model),
        providerOptions,
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
            // Keep Thought block visible immediately even before first visible reasoning delta.
            flushAssistantContent()
            host.emit({
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
              host.emit({ type: "text_delta", delta: event.delta, messageId: newMessageId })
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
              // Keep Thought block in persisted message even when provider sends empty reasoning chunks.
              flushAssistantContent()
            }
            host.emit({
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
            host.emit({
              type: "reasoning_end",
              messageId: newMessageId,
              reasoningId: currentReasoningId ?? event.reasoningId,
              providerMetadata: event.providerMetadata,
            })
            break

          case "tool_call": {
            let { toolCallId, toolName, toolInput } = event
            if (!toolCallId || !toolName || !toolInput) break
            // CLI/gateway may send list_dir or ListDirectory (Kilo); resolve to builtin name and normalize args
            if (
              toolName === "list_dir" ||
              toolName === "ListDirectory" ||
              toolName === "list_directory"
            )
              toolName = "List"
  // Normalize List: some providers send "paths" (array); we only accept "path". Default path to ".".
  if (toolName === "List" && typeof toolInput === "object") {
    const raw = toolInput as Record<string, unknown>
    const pathVal =
      typeof raw.path === "string" && raw.path.length > 0
        ? raw.path
        : Array.isArray(raw.paths) && raw.paths.length > 0 && typeof (raw.paths as unknown[])[0] === "string"
          ? (raw.paths as string[])[0]
          : "."
    toolInput = {
      path: pathVal,
      ignore: raw.ignore,
      recursive: raw.recursive,
      include: raw.include,
      max_entries: raw.max_entries,
      task_progress: raw.task_progress,
    }
  }
            sawNativeToolCall = true

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

            host.emit({ type: "tool_start", tool: toolName, partId, messageId: newMessageId, input: toolInput })

            // Inform host of available tools list so UI/user knows context
            // TodoWrite updates session in its execute(); no task_progress here.

            // DOOM LOOP DETECTION — surface as a failed tool result so the model can recover (no hard abort).
            if (await detectDoomLoop(session, toolName, toolInput)) {
              host.emit({ type: "doom_loop_detected", tool: toolName })
              const threshold = toolName === "Bash" ? DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND : DOOM_LOOP_THRESHOLD
              const tty = typeof process !== "undefined" && process.stdin && process.stdin.isTTY
              let proceed = false
              if (tty) {
                const doomAction: ApprovalAction = {
                  type: "doom_loop",
                  tool: toolName,
                  description: `Potential infinite loop: "${toolName}" called ${threshold} times with same args. Continue anyway? [y]es [n]o (abort).`,
                }
                host.emit({ type: "tool_approval_needed", action: doomAction, partId })
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
                host.emit({
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
                executedToolCallsTotal++
                break
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

              // Plan mode: force writing the plan to .nexus/plans/ before PlanExit
              if (toolName === "PlanExit" && mode === "plan") {
                const hasPlanFile =
                  messageHasPlanFileWrite(session, newMessageId, toolCtx.cwd) ||
                  hasPlanFileOnDisk(toolCtx.cwd)
                if (!hasPlanFile) {
                  const errMsg =
                    "You must write the plan to a file in .nexus/plans/ (e.g. .nexus/plans/plan.md) before calling PlanExit. Create or update the plan file now, then call PlanExit again."
                  session.updateToolPart(newMessageId, partId, {
                    status: "error",
                    output: errMsg,
                    timeEnd: Date.now(),
                  })
                  host.emit({
                    type: "tool_end",
                    tool: toolName,
                    partId,
                    messageId: newMessageId,
                    success: false,
                    output: errMsg,
                  })
                  lastToolName = toolName
                  executedToolThisIteration = true
                  executedToolCallsTotal++
                  break
                }
              }

              const result = await executeToolCall(
                toolCallId, toolName, toolInput,
                resolvedTools, toolCtx, autoApproveActions, config, host, session, newMessageId, completionState, mode, mcpToolNames
              )

              session.updateToolPart(newMessageId, partId, {
                status: result.success ? "completed" : "error",
                output: result.output,
                timeEnd: Date.now(),
                ...(result.success && (toolName === "Write" || toolName === "Edit")
                  ? {
                      path: extractWriteTargetPath(toolName, toolInput),
                      ...(typeof (result.metadata as { addedLines?: number; removedLines?: number })?.addedLines === "number" &&
                      typeof (result.metadata as { addedLines?: number; removedLines?: number })?.removedLines === "number"
                        ? { diffStats: { added: (result.metadata as { addedLines: number; removedLines: number }).addedLines, removed: (result.metadata as { addedLines: number; removedLines: number }).removedLines } }
                        : {}),
                    }
                  : {}),
              })

              host.emit({
                type: "tool_end",
                tool: toolName,
                partId,
                messageId: newMessageId,
                success: result.success,
                output: result.output,
                error: result.success ? undefined : result.output,
                compacted: (result as { compacted?: boolean }).compacted,
                metadata: result.metadata,
                ...(result.success && (toolName === "Write" || toolName === "Edit")
                  ? {
                      path: extractWriteTargetPath(toolName, toolInput),
                      writtenContent: typeof (result as { metadata?: { writtenContent?: string } }).metadata?.writtenContent === "string"
                        ? (result.metadata as { writtenContent: string }).writtenContent
                        : undefined,
                      ...(typeof (result as { metadata?: { addedLines?: number; removedLines?: number } }).metadata?.addedLines === "number" &&
                      typeof (result as { metadata?: { addedLines?: number; removedLines?: number } }).metadata?.removedLines === "number"
                        ? { diffStats: { added: (result.metadata as { addedLines: number; removedLines: number }).addedLines, removed: (result.metadata as { addedLines: number; removedLines: number }).removedLines } }
                        : {}),
                      ...(Array.isArray((result.metadata as { diffHunks?: unknown[] })?.diffHunks)
                        ? { diffHunks: (result.metadata as { diffHunks: Array<{ type: string; lineNum: number; line: string }> }).diffHunks }
                        : {}),
                    }
                  : {}),
              })

              if (toolName === "TodoWrite") {
                host.emit({ type: "todo_updated", todo: session.getTodo() })
              }

              lastToolName = toolName
              executedToolThisIteration = true
              executedToolCallsTotal++
              if ((result.metadata as { questionRequest?: boolean } | undefined)?.questionRequest) {
                attemptedCompletionThisIteration = true
                await flushPendingReads()
                break streamLoop
              }
              if (toolName === MANDATORY_END_TOOL[mode]) {
                attemptedCompletionThisIteration = true
                await flushPendingReads()
                break streamLoop
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

            // CLI/UI can show assistant message (text + tool_use blocks) before tool execution
            host.emit({ type: "assistant_content_complete", messageId: newMessageId })

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
                host.emit({ type: "error", error: message, fatal: false })
                break
              }
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
        contextOverflowRetries++
        if (contextOverflowRetries > MAX_CONTEXT_OVERFLOW_RETRIES) {
          host.emit({ type: "error", error: "Context overflow could not be resolved after compaction. Stopping.", fatal: true })
          break
        }
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
          flushAssistantContent()
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
          host.emit({ type: "tool_start", tool: call.toolName, partId, messageId: newMessageId, input: call.toolInput })

          if (await detectDoomLoop(session, call.toolName, call.toolInput)) {
            host.emit({ type: "doom_loop_detected", tool: call.toolName })
            const threshold =
              call.toolName === "Bash" ? DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND : DOOM_LOOP_THRESHOLD
            const errMsg =
              call.toolName === "Bash"
                ? `Same Bash command was run ${threshold} times with identical arguments (textual tool call). Stop repeating: read prior errors and change the command.`
                : `Same tool "${call.toolName}" was called ${threshold} times with identical arguments (textual tool call). Stop the loop and fix inputs.`
            session.updateToolPart(newMessageId, partId, {
              status: "error",
              output: errMsg,
              timeEnd: Date.now(),
            })
            host.emit({
              type: "tool_end",
              tool: call.toolName,
              partId,
              messageId: newMessageId,
              success: false,
              output: errMsg,
              error: errMsg,
            })
            lastToolName = call.toolName
            executedToolThisIteration = true
            executedToolCallsTotal++
            continue
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
            newMessageId,
            completionState,
            mode,
            mcpToolNames
          )

          session.updateToolPart(newMessageId, partId, {
            status: result.success ? "completed" : "error",
            output: result.output,
            timeEnd: Date.now(),
            ...(result.success && (call.toolName === "Write" || call.toolName === "Edit")
              ? {
                  path: extractWriteTargetPath(call.toolName, call.toolInput),
                  ...(typeof (result.metadata as { addedLines?: number; removedLines?: number })?.addedLines === "number" &&
                  typeof (result.metadata as { addedLines?: number; removedLines?: number })?.removedLines === "number"
                    ? { diffStats: { added: (result.metadata as { addedLines: number; removedLines: number }).addedLines, removed: (result.metadata as { addedLines: number; removedLines: number }).removedLines } }
                    : {}),
                }
              : {}),
          })

          host.emit({
            type: "tool_end",
            tool: call.toolName,
            partId,
            messageId: newMessageId,
            success: result.success,
            output: result.output,
            error: result.success ? undefined : result.output,
            compacted: (result as { compacted?: boolean }).compacted,
            metadata: result.metadata,
            ...(result.success && (call.toolName === "Write" || call.toolName === "Edit")
              ? {
                  path: extractWriteTargetPath(call.toolName, call.toolInput),
                  writtenContent: typeof (result as { metadata?: { writtenContent?: string } }).metadata?.writtenContent === "string"
                    ? (result.metadata as { writtenContent: string }).writtenContent
                    : undefined,
                  ...(typeof (result as { metadata?: { addedLines?: number; removedLines?: number } }).metadata?.addedLines === "number" &&
                  typeof (result as { metadata?: { addedLines?: number; removedLines?: number } }).metadata?.removedLines === "number"
                    ? { diffStats: { added: (result.metadata as { addedLines: number; removedLines: number }).addedLines, removed: (result.metadata as { addedLines: number; removedLines: number }).removedLines } }
                    : {}),
                  ...(Array.isArray((result.metadata as { diffHunks?: unknown[] })?.diffHunks)
                    ? { diffHunks: (result.metadata as { diffHunks: Array<{ type: string; lineNum: number; line: string }> }).diffHunks }
                    : {}),
                }
              : {}),
          })

          if (call.toolName === "TodoWrite") {
            host.emit({ type: "todo_updated", todo: session.getTodo() })
          }

          lastToolName = call.toolName
          executedToolThisIteration = true
          executedToolCallsTotal++
          if ((result.metadata as { questionRequest?: boolean } | undefined)?.questionRequest) {
            attemptedCompletionThisIteration = true
            break
          }
          if (call.toolName === MANDATORY_END_TOOL[mode]) {
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
    // Provider/gateway may close stream without explicit finish event.
    if (!finishReason && !fatalStreamError) {
      finishReason = "stop"
    }
    const noVisibleAssistantOutputThisIteration =
      finishReason === "stop" &&
      !executedToolThisIteration &&
      currentText.trim().length === 0 &&
      currentReasoning.trim().length === 0
    if (noVisibleAssistantOutputThisIteration) {
      if (consecutiveEmptyFinalResponses < maxEmptyFinalResponseRetries) {
        consecutiveEmptyFinalResponses++
        forceEmptyResponseRecoveryPromptNext = true
        host.emit({
          type: "error",
          error: `Model returned an empty response. Retrying (${consecutiveEmptyFinalResponses}/${maxEmptyFinalResponseRetries}) with a stricter prompt.`,
          fatal: false,
        })
        await session.save()
        emitContextUsage()
        continue
      }
      currentText =
        "I could not produce a final text response after retries. Please try again or rephrase your request."
      flushAssistantContent()
      attemptedCompletionThisIteration = true
    } else if (currentText.trim().length > 0 || currentReasoning.trim().length > 0) {
      consecutiveEmptyFinalResponses = 0
    }

    // Check if done — mandatory end tool (per mode) ends the turn: plan_exit (plan only). Agent/ask/debug have no mandatory tool.
    const mandatoryEnd = MANDATORY_END_TOOL[mode]
    if (
      attemptedCompletionThisIteration ||
      (mandatoryEnd && lastToolName === mandatoryEnd)
    )
      break
    if (finishReason === "stop" && !executedToolThisIteration) {
      if (sdkInvalidToolArgsRecovery) {
        flushAssistantContent()
        await session.save()
        emitContextUsage()
        continue
      }
      let mandatoryTool = MANDATORY_END_TOOL[mode]
      if (!mandatoryTool) break
      // Revision pass: user asked to change the plan — never inject PlanExit on a text-only stop; run another outer iteration so the model can edit .nexus/plans first.
      if (mode === "plan" && mandatoryTool === "PlanExit" && lastUserMessageRequestsPlanRevision(session)) {
        flushAssistantContent()
        await session.save()
        emitContextUsage()
        continue
      }
      const alreadyCalled = messageHasMandatoryEndTool(session, newMessageId, mode)
      if (mandatoryTool && !alreadyCalled && resolvedTools.some((t) => t.name === mandatoryTool)) {
        // Plan mode: if no plan file was written, still force plan_exit so user gets a message
        if (mode === "plan" && mandatoryTool === "PlanExit" && !messageHasPlanFileWrite(session, newMessageId, toolCtx.cwd)) {
          // Keep plan_exit; pass summary that plan file is missing
        }
        if (!resolvedTools.some((t) => t.name === mandatoryTool)) {
          break
        }
        flushAssistantContent()
        const syntheticId = `forced_end_${loopIterations}_${Date.now()}`
        const partId = `part_${syntheticId}`
        const summary = (currentText || "").trim().slice(0, 2000) || "Work completed."
        let toolInput: Record<string, unknown>
        if (mandatoryTool === "PlanExit") {
          toolInput = { summary: (currentText || "").trim().slice(0, 500) || "Plan ready." }
        } else {
          toolInput = { message: summary }
        }
        session.addToolPart(newMessageId, {
          type: "tool",
          id: partId,
          tool: mandatoryTool,
          status: "pending",
          input: toolInput,
          timeStart: Date.now(),
        })
        host.emit({ type: "tool_start", tool: mandatoryTool, partId, messageId: newMessageId, input: toolInput })
        const forcedResult = await executeToolCall(
          syntheticId,
          mandatoryTool,
          toolInput,
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
          status: forcedResult.success ? "completed" : "error",
          output: forcedResult.output,
          timeEnd: Date.now(),
        })
        host.emit({
          type: "tool_end",
          tool: mandatoryTool,
          partId,
          messageId: newMessageId,
          success: forcedResult.success,
          output: forcedResult.output,
          metadata: forcedResult.metadata,
        })
        if (forcedResult.success && forcedResult.output?.trim()) {
          setReportToUserMessage(session, newMessageId, forcedResult.output)
        }
        lastToolName = mandatoryTool
        if (mandatoryTool === MANDATORY_END_TOOL[mode]) {
          attemptedCompletionThisIteration = true
        }
      }
      break
    }
    if (signal.aborted) break

    // Check for context overflow proactively
    const tokenCount = session.getTokenEstimate()
    const contextLimit = getContextWindowLimit(activeClient.modelId, config.model.contextWindow)
    if (contextLimit > 0 && tokenCount / contextLimit > config.summarization.threshold) {
      host.emit({ type: "compaction_start" })
      await handleCompaction(session, activeClient, config, host, compaction, signal)
      host.emit({ type: "compaction_end" })
    }

    contextOverflowRetries = 0
    await session.save()
    emitContextUsage()
  }

  if (!signal.aborted && lastAssistantMessageId && !doneEmitted) {
    doneEmitted = true
    // When mandatory end tool was executed, clear todo so it's removed from session.
    if (attemptedCompletionThisIteration || lastToolName === MANDATORY_END_TOOL[mode]) {
      session.updateTodo("")
      host.emit({ type: "todo_updated", todo: "" })
    }
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
  messageId: string,
  completionState: { doubleCheckEnabled: boolean; pending: { current: boolean }; checkpoint?: { commit(description?: string): Promise<string> } } | undefined,
  mode: Mode,
  mcpToolNames: Set<string>
): Promise<ToolResult> {
  // Resolve gateway name to builtin name so we always use our List (path-only schema)
  const resolvedToolName =
    toolName === "list_dir" || toolName === "ListDirectory" || toolName === "list_directory"
      ? "List"
      : toolName === "ask_followup_question"
        ? "AskFollowupQuestion"
        : toolName
  const tool = tools.find(t => t.name === resolvedToolName)
  if (!tool) {
    const availableList = tools.map(t => t.name).join(", ")
    return {
      success: false,
      output: `ERROR: Tool "${toolName}" does not exist. IMPORTANT: Use ONLY these available tools: ${availableList}. To run shell commands, use Bash.`,
    }
  }

  const ctxWithPartId = ctx as ToolContext & { partId?: string }
  ctxWithPartId.partId = `part_${toolCallId}`

  // Plan mode: allow writes only to .nexus/plans/*.md|*.txt (no source code edits)
  if (mode === "plan" && ["Write", "Edit"].includes(resolvedToolName)) {
    const targetPath = extractWriteTargetPath(resolvedToolName, toolInput)
    if (!targetPath) {
      return {
        success: false,
        output: "In plan mode, write operations require an explicit target path under .nexus/plans/*.md or .txt.",
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
          output: `In plan mode you cannot modify source code files (${ext}). Write only the plan to .nexus/plans/*.md or .txt, then call PlanExit.`,
        }
      }
      return {
        success: false,
        output: "In plan mode you may only write plan documentation under .nexus/plans/ (*.md or *.txt). Do not modify source files.",
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
  const writePath = (toolInput["file_path"] ?? toolInput["path"]) as string | undefined
  if (ruleResult === null && writePath) {
    for (const pattern of config.permissions.denyPatterns) {
      if (matchesGlob(writePath, pattern)) {
        return { success: false, output: `Access denied: path matches deny pattern "${pattern}"` }
      }
    }
  }

  // --- Standard approval flow (only when no explicit rule matched) ---
  // For Write/Edit with host file-edit API: tool does open → approve → save/revert; skip here.
  const useFileEditFlow =
    (toolName === "Write" || toolName === "Edit") &&
    typeof host.openFileEdit === "function" &&
    typeof host.saveFileEdit === "function" &&
    typeof host.revertFileEdit === "function"

  if (ruleResult === null && !useFileEditFlow) {
    const needsApproval = toolNeedsApproval(toolName, toolInput, autoApproveActions, config, mcpToolNames)
    if (needsApproval) {
      const action = buildApprovalAction(toolName, toolInput)
      host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` })

      const approval = await host.showApprovalDialog(action)
      if (!approval.approved) {
        if (approval.whatToDoInstead?.trim()) {
          session.addMessage({
            role: "user",
            content: `[Regarding the declined action: ${action.description}]\n\nDo this instead: ${approval.whatToDoInstead.trim()}`,
          })
          return {
            success: false,
            output: `User declined this action and asked to do the following instead:\n\n${approval.whatToDoInstead.trim()}\n\nContinue your work following this instruction; do not repeat the declined action.`,
          }
        }
        return { success: false, output: `User denied ${toolName}` }
      }
      if (approval.addToAllowedCommand != null && toolName === "Bash") {
        const toAdd = normalizeCommand(approval.addToAllowedCommand)
        if (toAdd) {
          await host.addAllowedCommand?.(ctx.cwd, toAdd)
          if (!config.permissions.allowedCommands) config.permissions.allowedCommands = []
          if (!config.permissions.allowedCommands.includes(toAdd)) {
            config.permissions.allowedCommands.push(toAdd)
          }
        }
      }
      if (approval.addToAllowedPattern != null && toolName === "Bash") {
        const pattern = approval.addToAllowedPattern.trim()
        if (pattern) {
          await host.addAllowedPattern?.(ctx.cwd, pattern)
          if (!config.permissions.allowCommandPatterns) config.permissions.allowCommandPatterns = []
          if (!config.permissions.allowCommandPatterns.includes(pattern)) {
            config.permissions.allowCommandPatterns.push(pattern)
          }
        }
      }
      if (approval.addToAllowedMcpTool != null && mcpToolNames.has(toolName)) {
        const tool = approval.addToAllowedMcpTool.trim()
        if (tool) {
          await host.addAllowedMcpTool?.(ctx.cwd, tool)
          if (!config.permissions.allowedMcpTools) config.permissions.allowedMcpTools = []
          if (!config.permissions.allowedMcpTools.includes(tool)) {
            config.permissions.allowedMcpTools.push(tool)
          }
        }
      }
    }
  }

  // Validate args — normalize all tools so gateway/API quirks (paths vs path, [undefined] in arrays) don't cause parse errors.
  let validatedArgs: unknown
  let inputToParse: Record<string, unknown> =
    toolInput && typeof toolInput === "object" ? { ...toolInput } : {}
  inputToParse = normalizeToolInputForParse(resolvedToolName, inputToParse) as Record<string, unknown>
  try {
    validatedArgs = tool.parameters.parse(inputToParse)
  } catch (err) {
    return { success: false, output: formatToolValidationError(resolvedToolName, err, inputToParse) }
  }

  // Execute
  try {
    const result = await tool.execute(validatedArgs as Record<string, unknown>, ctx)

    // Keep code index fresh after successful file edits in both CLI and VSCode hosts.
    if (result.success && ctx.indexer && ["Write", "Edit"].includes(toolName)) {
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

    return { success: result.success, output: result.output, metadata: result.metadata }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: `Tool ${toolName} error: ${msg}` }
  }
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
    const contextLimit = getContextWindowLimit(client.modelId, config.model.contextWindow)
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
 * Tool outputs are capped per result to avoid one read_file filling context.
 */
const MAX_TOOL_OUTPUT_CHARS = 16_000 // ~4k tokens per tool result

function buildMessagesFromSession(session: ISession): LLMMessage[] {
  const messages: LLMMessage[] = []

  for (const msg of getMessagesForActiveContext(session.messages)) {
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
      // User messages with parts (text, images)
      const textParts = parts.filter((p): p is TextPart => p.type === "text")
      const imageParts = parts.filter((p): p is ImagePart => p.type === "image")
      const textContent = textParts
        .map(p => p.text)
        .join("")
        .trim()
      if (imageParts.length > 0) {
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []
        if (textContent) content.push({ type: "text", text: textContent })
        for (const ip of imageParts) {
          content.push({ type: "image", data: ip.data, mimeType: ip.mimeType })
        }
        messages.push({ role: "user", content })
      } else if (textContent) {
        messages.push({ role: "user", content: textContent })
      }
      continue
    }

    if (msg.role !== "assistant") continue

    // ── Assistant message ────────────────────────────────────────────────────
    const textParts = parts.filter((p): p is TextPart => p.type === "text")
    const toolParts = parts.filter((p): p is ToolPart => p.type === "tool")

    const textContent = textParts
      .map(p => (p.user_message?.trim() ? p.user_message.trim() + "\n" + p.text : p.text))
      .join("")
      .trim()
    const toolCallParts = toolParts.filter(tp => tp.input != null)
    const completedToolParts = toolParts.filter(tp => tp.status === "completed" || tp.status === "error")

    if (toolCallParts.length > 0) {
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
        const toolResultContent = completedToolParts.map(tp => {
          let result: string
          if (tp.compacted) {
            result = "[output pruned for context efficiency]"
          } else {
            const raw = tp.output ?? ""
            result = raw.length <= MAX_TOOL_OUTPUT_CHARS
              ? raw
              : raw.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n\n[... output truncated for context ...]"
          }
          if (tp.status === "error") {
            result = formatToolAttemptForLanguageModel(tp.tool, tp.input, result)
          }
          return {
            type: "tool-result",
            toolCallId: tp.id,
            toolName: tp.tool,
            result,
            isError: tp.status === "error",
          }
        })
        messages.push({ role: "tool" as SessionRole, content: toolResultContent as LLMMessage["content"] })
      }
    } else {
      // Pure text response (no tool calls)
      if (textContent) {
        messages.push({ role: "assistant", content: textContent })
      }
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


function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

/** Match normalized command against a pattern. Supports "prefix*" and exact; also "Bash(cmd:*)" for .claude compatibility. */
function commandMatchesPattern(normalizedCommand: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  // .claude style: Bash(npm run build:*)
  const bashMatch = p.match(/^Bash\((.+):\*\)$/)
  if (bashMatch) {
    const prefix = normalizeCommand(bashMatch[1]!)
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1).trim()
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  return normalizedCommand === p
}

function toolNeedsApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  autoApproveActions: Set<string>,
  config: NexusConfig,
  mcpToolNames: Set<string>
): boolean {
  if (mcpToolNames.has(toolName)) {
    const allowedMcp = config.permissions.allowedMcpTools ?? []
    if (allowedMcp.includes(toolName)) return false
    return !(config.permissions.autoApproveMcp ?? false)
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    if (autoApproveActions.has("read")) return false
    // Check auto-approve patterns
    if (toolInput["path"] && typeof toolInput["path"] === "string") {
      for (const pattern of config.permissions.autoApproveReadPatterns) {
        if (matchesGlob(toolInput["path"], pattern)) return false
      }
    }
    if (toolInput["file_path"] && typeof toolInput["file_path"] === "string") {
      for (const pattern of config.permissions.autoApproveReadPatterns) {
        if (matchesGlob(toolInput["file_path"], pattern)) return false
      }
    }
    return !config.permissions.autoApproveRead
  }
  if (["Write", "Edit"].includes(toolName)) {
    return !config.permissions.autoApproveWrite && !autoApproveActions.has("write")
  }
  if (toolName === "Bash") {
    const cmd = typeof toolInput["command"] === "string" ? toolInput["command"] : ""
    const normalized = normalizeCommand(cmd)
    const denyPatterns = config.permissions.denyCommandPatterns ?? []
    const allowPatterns = config.permissions.allowCommandPatterns ?? []
    const askPatterns = config.permissions.askCommandPatterns ?? []
    const allowed = config.permissions.allowedCommands ?? []
    if (normalized && denyPatterns.some((p) => commandMatchesPattern(normalized, p))) return true
    if (normalized && allowPatterns.some((p) => commandMatchesPattern(normalized, p))) return false
    if (normalized && allowed.some((c) => normalizeCommand(c) === normalized)) return false
    if (normalized && askPatterns.some((p) => commandMatchesPattern(normalized, p))) return true
    return !config.permissions.autoApproveCommand && !autoApproveActions.has("execute")
  }
  return false
}

function buildApprovalAction(toolName: string, toolInput: Record<string, unknown>): ApprovalAction {
  if (["Write", "Edit"].includes(toolName)) {
    return {
      type: "write",
      tool: toolName,
      description: `Write to ${(toolInput["file_path"] ?? toolInput["path"]) ?? "file"}`,
      content: toolInput["content"] as string | undefined,
    }
  }
  if (toolName === "Bash") {
    return {
      type: "execute",
      tool: toolName,
      description: `Run: ${toolInput["command"]}`,
      content: typeof toolInput["command"] === "string" ? toolInput["command"] : undefined,
    }
  }
  if (toolName.includes("__")) {
    return {
      type: "mcp",
      tool: toolName,
      description: `MCP: ${toolName}`,
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
  const filePath = (toolInput["file_path"] ?? toolInput["path"]) as string | undefined
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
  const pathVal = toolInput["file_path"] ?? toolInput["path"]
  if (typeof pathVal === "string" && pathVal) return pathVal
  return undefined
}

