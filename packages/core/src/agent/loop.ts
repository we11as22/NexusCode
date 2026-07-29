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
  TextPart,
  ReasoningPart,
  ToolPart,
  ImagePart,
  SessionRole,
  MessagePart,
  DiagnosticItem,
  AgentInputMailbox,
  AgentMailboxMessage,
  AgentExecutionIdentity,
} from "../types.js"
import type { LLMStreamEvent, LLMMessage, LLMToolDef } from "../provider/types.js"
import { buildSystemPrompt, type PromptContext } from "./prompts/components/index.js"
import { getInitialProjectContext } from "./prompts/initial-context.js"
import {
  READ_ONLY_TOOLS,
  getBuiltinToolsForMode,
  getAutoApproveActions,
  getBlockedToolsForMode,
  isDynamicToolAllowedInMode,
  isKnownBuiltinToolName,
  PLAN_MODE_BLOCKED_EXTENSIONS,
  PLAN_MODE_ALLOWED_WRITE_PATTERN,
  MANDATORY_END_TOOL,
} from "./modes.js"
import { filterToolsForHostCapabilities } from "./host-tool-capabilities.js"
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
import { buildSkillToolDescriptionMerged, useSkillTool } from "../tools/built-in/use-skill.js"
import { parseMentions } from "../context/mentions.js"
import type {
  CompactionResult,
  SessionCompaction,
} from "../session/compaction.js"
import { planExitWriteGateSatisfied } from "../session/plan-write-gate.js"
import {
  formatConversationSummaryForModel,
  getMessagesForActiveContext,
} from "../session/active-context.js"
import {
  computeContextUsageMetrics,
  estimateToolsDefinitionsTokens,
  getContextWindowLimit,
} from "../context/context-usage.js"
import { findLastOpenReasoningPartIndex } from "./reasoning-segment-utils.js"
import * as path from "node:path"
import { projectFileChangeToolResult } from "./file-change-projection.js"
import {
  buildReasoningProviderOptions,
  getDefaultTemperature,
  getDefaultTopK,
  getDefaultTopP,
} from "../provider/provider-options.js"
import type { OrchestrationRuntime } from "../orchestration/runtime.js"
import {
  filterPromptMemoryCandidates,
  selectRelevantMemories,
} from "../orchestration/memory-selection.js"
import { runPluginHooks } from "../plugins/runtime.js"
import { readSessionMemoryFile } from "../session/session-memory.js"
import {
  artifactCapabilityFromToolMetadata,
} from "./tool-spill.js"
import { getToolOutputSpill } from "../context/tool-output-registry.js"
import { scheduleAutoMemoryDream } from "../context/auto-dream-scheduler.js"
import { scheduleSessionMemoryRefresh } from "../context/session-memory-scheduler.js"
import { projectPersistedCompactionSummary } from "../context/compaction-projection.js"
import { importLegacyMemoryFiles } from "../context/legacy-memory-import.js"
import type { NexusRunServices } from "./run-services.js"
import {
  executeToolPipeline,
  type ToolExecutionOrigin,
} from "./tool-pipeline.js"
import { requestHostApproval } from "./approval-coordinator.js"
import { assertAgentExecutionIdentity } from "./execution-identity.js"
import { ChangeSetService } from "../changes/service.js"

/** Generous tool budgets so multi-file tasks can complete. */
const BASE_TOOL_CALL_BUDGET_BY_MODE: Record<Mode, number> = {
  ask: 80,
  plan: 80,
  agent: 200,
  debug: 200,
  review: 120,
}

const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

async function recordPluginHookOutputs(
  session: ISession,
  host: IHost,
  tagName: string,
  hookResults: Array<{
    pluginName: string
    hookEvent: string
    output: string
    success: boolean
    preventContinuation?: boolean
    stopReason?: string
    additionalContext?: string
  }>,
  attributes: Record<string, string> = {},
): Promise<void> {
  if (hookResults.length === 0) return
  const attrText = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${value.replace(/"/g, "&quot;")}"`)
    .join("")
  const messageBody = hookResults
    .map((result) => {
      const bodyParts = [
        result.output,
        result.additionalContext ? `<additional-context>\n${result.additionalContext}` : "",
        result.preventContinuation
          ? `<stop-continuation>\n${result.stopReason?.trim() || "Hook requested that the agent stop the current continuation."}`
          : "",
      ].filter(Boolean)
      return `<${tagName} plugin="${result.pluginName}"${attrText}>\n${bodyParts.join("\n\n")}`
    })
    .join("\n\n")
  session.addMessage({
    role: "user",
    content: messageBody,
  })
  for (const hookResult of hookResults) {
    host.emit({
      type: "plugin_hook",
      pluginName: hookResult.pluginName,
      hookEvent: hookResult.hookEvent,
      output: hookResult.output,
      success: hookResult.success,
    })
  }
}

function getPreventContinuationReason(
  hookResults: Array<{ preventContinuation?: boolean; stopReason?: string; pluginName: string }>,
): string | null {
  const blocked = hookResults.find((result) => result.preventContinuation)
  if (!blocked) return null
  return blocked.stopReason?.trim() || `${blocked.pluginName} requested that the agent stop the current continuation.`
}

async function stopForBlockingHook(
  session: ISession,
  host: IHost,
  hookResults: Array<{
    preventContinuation?: boolean
    stopReason?: string
    pluginName: string
  }>,
): Promise<boolean> {
  const reason = getPreventContinuationReason(hookResults)
  if (!reason) return false
  host.emit({
    type: "error",
    error: reason.slice(0, 2_000),
    fatal: false,
  })
  await session.save()
  host.emit({ type: "session_saved", sessionId: session.id })
  return true
}

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

/** Returns true if the message already contains a call to the mode's mandatory end tool. */
function messageHasMandatoryEndTool(session: ISession, messageId: string, mode: Mode): boolean {
  const mandatory = MANDATORY_END_TOOL[mode]
  if (!mandatory) return true
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg || !Array.isArray(msg.content)) return false
  const parts = msg.content as MessagePart[]
  return parts.some((p) => p.type === "tool" && (p as ToolPart).tool === mandatory)
}

function activatedToolNamesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string[] | undefined {
  const names = metadata?.activatedTools
  if (!Array.isArray(names)) return undefined
  const normalized = [
    ...new Set(
      names
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20)
  return normalized.length > 0 ? normalized : undefined
}

function activatedSkillNameFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const name = metadata?.name
  return typeof name === "string" && name.trim()
    ? name.trim()
    : undefined
}

function backgroundTaskIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const candidate =
    typeof metadata?.task_id === "string"
      ? metadata.task_id
      : typeof metadata?.bash_id === "string"
        ? metadata.bash_id
        : undefined
  const normalized = candidate?.trim()
  return normalized ? normalized : undefined
}

function normalizedChangeFileDiffHunks(
  value: unknown,
  maxLines: number,
): NonNullable<NonNullable<ToolPart["changeFiles"]>[number]["diffHunks"]> {
  if (!Array.isArray(value) || maxLines <= 0) return []
  const lines: NonNullable<
    NonNullable<ToolPart["changeFiles"]>[number]["diffHunks"]
  > = []
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue
    }
    const line = candidate as Record<string, unknown>
    if (
      (line.type !== "add" && line.type !== "remove") ||
      typeof line.lineNum !== "number" ||
      !Number.isSafeInteger(line.lineNum) ||
      line.lineNum < 0 ||
      typeof line.line !== "string"
    ) {
      continue
    }
    lines.push({
      type: line.type,
      lineNum: line.lineNum,
      line: line.line,
    })
    if (lines.length >= maxLines) break
  }
  return lines
}

function changeSetCapabilityFromToolMetadata(
  metadata: Record<string, unknown> | undefined,
): Pick<
  ToolPart,
  "changeSetId" | "proposalHash" | "changeSetState" | "changeFiles"
> | undefined {
  const changeSetId = metadata?.changeSetId
  const proposalHash = metadata?.proposalHash
  const changeSetState = metadata?.changeSetState
  if (
    typeof changeSetId !== "string" ||
    !changeSetId.trim() ||
    typeof proposalHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proposalHash) ||
    ![
      "proposed",
      "approved",
      "applying",
      "applied",
      "rejected",
      "accepted",
      "reverting",
      "reverted",
      "conflicted",
    ].includes(String(changeSetState))
  ) {
    return undefined
  }
  const changeFiles: NonNullable<ToolPart["changeFiles"]> = []
  let remainingDiffLines = 256
  if (Array.isArray(metadata?.changeFiles)) {
    for (const value of metadata.changeFiles.slice(0, 256)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue
      }
      const file = value as Record<string, unknown>
      const stats =
        file.diffStats &&
        typeof file.diffStats === "object" &&
        !Array.isArray(file.diffStats)
          ? file.diffStats as Record<string, unknown>
          : undefined
      const operation = String(file.operation)
      if (
        typeof file.path !== "string" ||
        !file.path.trim() ||
        !["create", "modify", "delete", "rename"].includes(operation) ||
        typeof stats?.added !== "number" ||
        !Number.isFinite(stats.added) ||
        stats.added < 0 ||
        typeof stats.removed !== "number" ||
        !Number.isFinite(stats.removed) ||
        stats.removed < 0 ||
        typeof file.binary !== "boolean"
      ) {
        continue
      }
      const diffHunks = normalizedChangeFileDiffHunks(
        file.diffHunks,
        Math.min(32, remainingDiffLines),
      )
      remainingDiffLines -= diffHunks.length
      changeFiles.push({
        path: file.path,
        ...(typeof file.oldPath === "string" && file.oldPath.trim()
          ? { oldPath: file.oldPath }
          : {}),
        operation: operation as
          | "create"
          | "modify"
          | "delete"
          | "rename",
        diffStats: {
          added: Math.floor(stats.added),
          removed: Math.floor(stats.removed),
        },
        binary: file.binary,
        ...(diffHunks.length > 0 ? { diffHunks } : {}),
      })
    }
  }
  return {
    changeSetId,
    proposalHash,
    changeSetState: changeSetState as NonNullable<
      ToolPart["changeSetState"]
    >,
    ...(changeFiles.length > 0 ? { changeFiles } : {}),
  }
}

function persistedToolActivationNames(session: ISession): Set<string> {
  const names = new Set<string>()
  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as MessagePart[]) {
      if (
        part.type !== "tool" ||
        part.tool !== "ToolSearch" ||
        part.status !== "completed"
      ) continue
      for (const name of part.activatedToolNames ?? []) {
        if (typeof name === "string" && name.trim()) names.add(name.trim())
      }
    }
  }
  return names
}

function activatedSkillsForPrompt(
  session: ISession,
  discoveredSkills: readonly SkillDef[],
): SkillDef[] {
  const byName = new Map(
    discoveredSkills.map((skill) => [skill.name.toLowerCase(), skill]),
  )
  const selected: SkillDef[] = []
  const seen = new Set<string>()
  for (let messageIndex = session.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = session.messages[messageIndex]
    if (!message || !Array.isArray(message.content)) continue
    const parts = message.content as MessagePart[]
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (
        part?.type !== "tool" ||
        part.tool !== "Skill" ||
        part.status !== "completed"
      ) continue
      const requestedName =
        part.activatedSkillName ??
        (typeof part.input?.["name"] === "string"
          ? part.input["name"]
          : undefined)
      if (!requestedName) continue
      const skill = byName.get(requestedName.trim().toLowerCase())
      if (!skill || seen.has(skill.name.toLowerCase())) continue
      selected.push(skill)
      seen.add(skill.name.toLowerCase())
      if (selected.length >= 4) return selected.reverse()
    }
  }
  return selected.reverse()
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

const MAILBOX_BATCH_LIMIT = 32

function formatAgentMailboxMessage(message: AgentMailboxMessage): string {
  return (
    `[Message from ${message.from} | id: ${message.id}]\n` +
    message.message
  )
}

/**
 * Accept pending mail into the transcript exactly once. The mailbox adapter is
 * responsible for durably checkpointing this transcript before it acks the
 * queue records; existing markers handle crash-after-checkpoint/before-ack.
 */
async function acceptAgentMailboxMessages(
  mailbox: AgentInputMailbox | undefined,
  session: ISession,
): Promise<number> {
  if (!mailbox) return 0
  const pending = await mailbox.readPending(MAILBOX_BATCH_LIMIT)
  if (pending.length === 0) return 0
  const acceptedIds = new Set(
    session.messages
      .map((message) => message.mailboxMessageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )
  for (const message of pending) {
    if (acceptedIds.has(message.id)) continue
    session.addMessage({
      role: "user",
      content: formatAgentMailboxMessage(message),
      mailboxMessageId: message.id,
      mailboxOwnerSessionId: message.ownerSessionId,
      mailboxTargetAgentId: message.targetAgentId,
      mailboxSender: message.from,
    })
    acceptedIds.add(message.id)
  }
  await mailbox.checkpointAndAcknowledge(pending, session)
  return pending.length
}

function linkedProviderSignal(
  rootSignal: AbortSignal,
  localSignal: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const relayRoot = () => controller.abort(rootSignal.reason)
  const relayLocal = () => controller.abort(localSignal.reason)
  rootSignal.addEventListener("abort", relayRoot, { once: true })
  localSignal.addEventListener("abort", relayLocal, { once: true })
  if (rootSignal.aborted) relayRoot()
  else if (localSignal.aborted) relayLocal()
  return {
    signal: controller.signal,
    dispose() {
      rootSignal.removeEventListener("abort", relayRoot)
      localSignal.removeEventListener("abort", relayLocal)
    },
  }
}

export interface AgentLoopOptions {
  session: ISession
  client: LLMClient
  host: IHost
  config: NexusConfig
  services: NexusRunServices
  /** Durable immutable ownership allocated before this loop begins. */
  executionIdentity: AgentExecutionIdentity
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
  /** When true, inject create-skill instructions; host must allow writes to .nexus/skills (and ~/.nexus/skills if applicable). */
  createSkillMode?: boolean
  /** Durable delegated-agent input accepted only at provider boundaries. */
  mailbox?: AgentInputMailbox
}

/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const turnStartedAt = Date.now()
  const {
    session, client, host, config, services, mode,
    tools, skills, rulesContent, indexer, compaction,
    signal, gitBranch, checkpoint, createSkillMode, mailbox,
    executionIdentity,
  } = opts

  assertAgentExecutionIdentity(executionIdentity)
  if (executionIdentity.sessionId !== session.id) {
    throw new Error(
      `Agent execution session ${executionIdentity.sessionId} does not match ${session.id}`,
    )
  }
  let changeSetService: ChangeSetService | undefined
  if (services.changeSets) {
    if (services.changeSets.workspaceId !== executionIdentity.workspaceId) {
      throw new Error(
        `Agent execution workspace ${executionIdentity.workspaceId} does not match durable change store ${services.changeSets.workspaceId}`,
      )
    }
    if (
      typeof host.readFileState !== "function" ||
      typeof host.applyFileMutation !== "function"
    ) {
      throw new Error(
        "This workspace has durable change storage but its host lacks the CAS file-mutation port",
      )
    }
    changeSetService = new ChangeSetService({
      workspaceId: services.changeSets.workspaceId,
      store: services.changeSets.store,
      files: {
        readFileState: (filePath) => host.readFileState!(filePath),
        applyFileMutation: (mutation) => host.applyFileMutation!(mutation),
      },
    })
    const recovered = await changeSetService.recoverInterrupted({
      sessionId: executionIdentity.sessionId,
    })
    const ambiguous = recovered.filter(
      (record) => record.state === "conflicted",
    )
    if (ambiguous.length > 0) {
      throw new Error(
        "Durable file-change recovery found ambiguous workspace state: " +
        ambiguous.map((record) => record.id).join(", "),
      )
    }
  }

  const activeClient = client
  const orchestrationRuntime = services.orchestrationRuntime
  await acceptAgentMailboxMessages(mailbox, session)

  // 1. Resolve tools: built-ins by mode + dynamic (MCP/custom); blocked tools NEVER included in allowed set.
  //    System prompt (buildSystemPrompt) and tool set both use the same `mode` — promptCtx.mode and
  //    getBlockedToolsForMode(mode) / getBuiltinToolsForMode(mode) are derived from this single value on every run.
  const blockedTools = getBlockedToolsForMode(mode)
  const builtinToolNames = new Set(getBuiltinToolsForMode(mode))
  // Vector search is opt-in: when disabled, CodebaseSearch is not available (tool name is PascalCase).
  if (!config.indexing?.vector || !config.vectorDb?.enabled) {
    builtinToolNames.delete("CodebaseSearch")
  }
  const builtinTools = filterToolsForHostCapabilities(
    tools.filter((tool) =>
      builtinToolNames.has(tool.name) && !blockedTools.has(tool.name),
    ),
    host.capabilities,
  )
  const dynamicTools = tools.filter(
    (tool) =>
      !isKnownBuiltinToolName(tool.name) &&
      !blockedTools.has(tool.name) &&
      isDynamicToolAllowedInMode(tool, mode),
  )

  const lastMessage = session.messages[session.messages.length - 1]
  const taskDesc = typeof lastMessage?.content === "string"
    ? lastMessage.content
    : (lastMessage?.content as Array<{ type: string; text?: string }>)?.find(p => p.type === "text")?.text ?? ""

  const promptSubmitHookResults = await runPluginHooks(
    host.cwd,
    host,
    config,
    "user_prompt_submit",
    {
      mode,
      sessionId: session.id,
      latestUserText: taskDesc,
    },
  ).catch(() => [])
  await recordPluginHookOutputs(session, host, "user-prompt-submit-hook", promptSubmitHookResults)
  if (await stopForBlockingHook(session, host, promptSubmitHookResults)) return

  const instructionsLoadedHookResults = await runPluginHooks(
    host.cwd,
    host,
    config,
    "instructions_loaded",
    {
      sessionId: session.id,
      mode,
      rulesCharCount: rulesContent.length,
      cwd: host.cwd,
    },
  ).catch(() => [])
  await recordPluginHookOutputs(
    session,
    host,
    "instructions-loaded-hook",
    instructionsLoadedHookResults,
  )
  if (await stopForBlockingHook(
    session,
    host,
    instructionsLoadedHookResults,
  )) return

  // Capability discovery must be deterministic. Older Nexus versions made a
  // separate LLM call here to guess which MCP servers/skills the turn might
  // need. A false negative silently removed capabilities and added latency.
  // Keep every mode-authorized capability in the local catalog; ToolSearch is
  // the sole run-local deferred-loading boundary.
  const resolvedDynamicTools = dynamicTools
  const blockedFallbackTools: ToolDef[] = []
  for (const blockedName of blockedTools) {
    if (builtinTools.some((t) => t.name === blockedName) || resolvedDynamicTools.some((t) => t.name === blockedName)) continue
    const original = tools.find((t) => t.name === blockedName)
    if (!original) continue
    blockedFallbackTools.push({
      ...original,
      description: `${original.description} (disabled in ${mode} mode)`,
      // Preserve a clear execution-time error for stale/textual calls without
      // advertising the forbidden capability in either manifest or search.
      hiddenFromAgent: true,
      execute: async () => ({
        success: false,
        output: `ERROR: Tool "${blockedName}" is disabled in ${mode} mode. Use only tools allowed in this mode.`,
      }),
    })
  }

  const authorizedTools = [...builtinTools, ...resolvedDynamicTools]
  const toolSearchAvailable = builtinTools.some(
    (tool) => tool.name === "ToolSearch",
  )
  const deferredCandidates = authorizedTools.filter(
    (tool) => tool.shouldDefer && !tool.alwaysLoad && !tool.hiddenFromAgent,
  )
  const deferredLoadingEnabled =
    toolSearchAvailable &&
    shouldUseDeferredToolLoading(
      deferredCandidates,
      activeClient.modelId,
      config,
    )
  const previouslyActivatedToolNames = persistedToolActivationNames(session)
  const inactiveToolNames = new Set(
    deferredLoadingEnabled
      ? deferredCandidates
          .map((tool) => tool.name)
          .filter((name) => !previouslyActivatedToolNames.has(name))
      : [],
  )
  const resolvedTools = [
    ...authorizedTools.filter((tool) => !inactiveToolNames.has(tool.name)),
    ...blockedFallbackTools,
  ]
  const searchableTools = authorizedTools.filter(
    (tool) => !tool.hiddenFromAgent,
  )
  const searchableToolByName = new Map(
    searchableTools.map((tool) => [tool.name, tool]),
  )
  const activeToolNames = new Set(
    resolvedTools.map((tool) => tool.name),
  )
  const pendingToolActivations = new Map<string, ToolDef>()
  const mcpToolNames = new Set(
    dynamicTools
      .filter((tool) => tool.integration?.kind === "mcp")
      .map((tool) => tool.name),
  )

  const skillToolDescription = await buildSkillToolDescriptionMerged(host.cwd, config).catch(() => useSkillTool.description)
  const getResolvedToolsForLlm = (): ToolDef[] =>
    resolvedTools
      .filter((tool) => !tool.hiddenFromAgent)
      .map((tool) =>
        tool.name === "Skill"
          ? { ...tool, description: skillToolDescription }
          : tool.name === "ToolSearch" && inactiveToolNames.size > 0
            ? {
                ...tool,
                description: `${tool.description}\nUse this to discover deferred tools not listed in the current manifest. ${inactiveToolNames.size} tools remain deferred.`,
              }
            : tool,
      )
  let toolsDefinitionTokens = estimateToolsDefinitionsTokens(
    getResolvedToolsForLlm(),
  )

  const activateDeferredTools: NonNullable<
    ToolContext["activateDeferredTools"]
  > = (requestedNames) => {
    const uniqueNames = [...new Set(requestedNames)]
    const rejected = uniqueNames.filter(
      (name) => !searchableToolByName.has(name),
    )
    // Validate the whole request before mutating the run-local capability set.
    if (rejected.length > 0) {
      return { activated: [], alreadyActive: [], rejected }
    }

    const activated: ToolDef[] = []
    const alreadyActive: ToolDef[] = []
    for (const name of uniqueNames) {
      const tool = searchableToolByName.get(name)!
      if (activeToolNames.has(name) || pendingToolActivations.has(name)) {
        alreadyActive.push(tool)
        continue
      }
      // Do not make a schema guessed in the same provider response executable.
      // It becomes active only at the next request boundary.
      pendingToolActivations.set(name, tool)
      activated.push(tool)
    }
    return { activated, alreadyActive, rejected: [] }
  }
  const commitPendingToolActivations = (): void => {
    if (pendingToolActivations.size === 0) return
    for (const [name, tool] of pendingToolActivations) {
      if (activeToolNames.has(name)) continue
      resolvedTools.push(tool)
      activeToolNames.add(name)
      inactiveToolNames.delete(name)
    }
    pendingToolActivations.clear()
    toolsDefinitionTokens = estimateToolsDefinitionsTokens(
      getResolvedToolsForLlm(),
    )
  }

  /** After compaction, inject OpenClaude-style sparse plan reminder on the next system prompt (plan mode only). */
  let planSparseReminderAfterCompaction = false
  let durableRunContext = {
    mode,
    memoryCitations: [] as string[],
    taskIds: [] as string[],
  }
  let compactionSuccessCount = 0
  let compactedSinceLastProviderSuccess = false

  // Tool context
  const toolCtx: ToolContext = {
    cwd: host.cwd,
    host,
    session,
    config,
    services,
    executionIdentityBase: executionIdentity,
    ...(changeSetService ? { changeSetService } : {}),
    mode,
    indexer,
    signal,
    resolvedTools,
    searchableTools,
    activateDeferredTools,
    compactSession: async () => {
      const result = await runCompactionLifecycle(
        session,
        activeClient,
        config,
        host,
        compaction,
        signal,
        {
          trigger: "manual",
          forceSummary: true,
          fatalOnFailure: false,
          systemPromptText: lastBuiltSystemPrompt,
          toolsDefinitionTokens,
          durableContext: durableRunContext,
          orchestrationRuntime,
        },
      )
      if (result.status === "failed") throw result.error
      if (result.status !== "compacted") {
        throw new Error(
          `Manual compaction did not produce a summary (${result.reason}).`,
        )
      }
      compactionSuccessCount += 1
      compactedSinceLastProviderSuccess = true
      if (mode === "plan") planSparseReminderAfterCompaction = true
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
  let sessionMemoryToolCallDebt = 0
  let sessionMemoryReadWarned = false
  let forceFinalAnswerNext = false
  let forceEmptyResponseRecoveryPromptNext = false
  let consecutiveEmptyFinalResponses = 0
  const maxEmptyFinalResponseRetries = 2
  let lastAssistantMessageId = ""
  const doubleCheckCompletion = config.checkpoint?.doubleCheckCompletion === true
  const completionState = {
    doubleCheckEnabled: doubleCheckCompletion,
    pending: { current: false },
    checkpoint: opts.checkpoint,
  }
  const runToolPipeline = async (
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    messageId: string,
    origin: ToolExecutionOrigin,
  ) => {
    const result = await executeToolPipeline(
      {
        callId: toolCallId,
        messageId,
        partId: `part_${toolCallId}`,
        toolName,
        input: toolInput,
        origin,
      },
      {
        tools: resolvedTools,
        context: toolCtx,
        autoApproveActions,
        mode,
        mcpToolNames,
        completionState,
      },
    )
    await recordPluginHookOutputs(
      session,
      host,
      "before-tool-hook",
      result.beforeHookResults ?? [],
      { tool: result.toolName },
    )
    await recordPluginHookOutputs(
      session,
      host,
      "after-tool-hook",
      result.afterHookResults ?? [],
      { tool: result.toolName },
    )
    return result
  }
  /** Full system prompt from the last completed loop iteration (for context bar + next iteration's pre-build estimate). */
  let lastBuiltSystemPrompt = ""
  const initialProviderAnchor = session.getProviderContextAnchor()
  if (
    initialProviderAnchor?.modelId &&
    initialProviderAnchor.modelId !== activeClient.modelId
  ) {
    session.clearProviderContextAnchor()
  }
  const emitContextUsage = (systemPromptText?: string) => {
    const text = systemPromptText ?? lastBuiltSystemPrompt
    const metrics = computeContextUsageMetrics({
      sessionMessages: session.messages,
      systemPromptText: text || undefined,
      toolsDefinitionTokens,
      modelId: activeClient.modelId,
      configuredContextWindow: config.model.contextWindow,
      providerAnchor: session.getProviderContextAnchor(),
    })
    session.recordContextUsage({
      usedTokens: metrics.usedTokens,
      limitTokens: metrics.limitTokens,
      percent: metrics.percent,
      source: metrics.source,
      providerTokens: metrics.providerTokens,
      pendingTokens: metrics.pendingTokens,
      modelId: metrics.modelId,
    })
    host.emit({
      type: "context_usage",
      usedTokens: metrics.usedTokens,
      limitTokens: metrics.limitTokens,
      percent: metrics.percent,
      source: metrics.source,
      providerTokens: metrics.providerTokens,
      pendingTokens: metrics.pendingTokens,
      modelId: metrics.modelId,
    })
  }
  const continueForMailboxBeforeCompletion = async (): Promise<boolean> => {
    if (!mailbox) return false
    // Closing the accepting gate is synchronous. A concurrent enqueue either
    // completed before this point and is observed by the read below, or it
    // reports that an explicit resume is required.
    mailbox.sealForCompletion()
    const accepted = await acceptAgentMailboxMessages(mailbox, session)
    if (accepted === 0) return false
    await session.save()
    emitContextUsage()
    mailbox.reopenAfterCompletionCheck()
    return true
  }

  let lastToolName = ""
  let attemptedCompletionThisIteration = false
  let doneEmitted = false
  let terminalError: Error | undefined
  let requestedNextMode: Mode | undefined
  const recoverFromContextOverflow = async (
    value: unknown,
  ): Promise<boolean> => {
    if (signal.aborted) return false
    const providerError = normalizeCompactionError(
      value,
      "Provider context window exceeded",
    )
    host.emit({
      type: "error",
      error: providerError.message,
      fatal: false,
    })

    if (config.summarization?.auto === false) {
      terminalError = new Error(
        "The provider reported a context overflow, but automatic compaction is disabled. " +
        "Run Condense manually, reduce the input, or start a new session.",
        { cause: providerError },
      )
      host.emit({
        type: "error",
        error: terminalError.message,
        fatal: true,
      })
      return false
    }
    if (compactedSinceLastProviderSuccess) {
      terminalError = new Error(
        "The provider still reports a context overflow after compaction. " +
        "Nexus stopped before repeating the paid compaction call.",
        { cause: providerError },
      )
      host.emit({
        type: "error",
        error: terminalError.message,
        fatal: true,
      })
      return false
    }

    const result = await runCompactionLifecycle(
      session,
      activeClient,
      config,
      host,
      compaction,
      signal,
      {
        trigger: "context_overflow",
        forceSummary: true,
        fatalOnFailure: true,
        systemPromptText: lastBuiltSystemPrompt,
        toolsDefinitionTokens,
        durableContext: durableRunContext,
        orchestrationRuntime,
      },
    )
    if (result.status === "failed") {
      if (result.reason !== "aborted" || !signal.aborted) {
        terminalError = result.error
      }
      return false
    }
    if (result.status !== "compacted") {
      terminalError = new Error(
        `Context-overflow compaction could not produce a summary (${result.reason}).`,
        { cause: providerError },
      )
      host.emit({
        type: "error",
        error: terminalError.message,
        fatal: true,
      })
      return false
    }
    compactionSuccessCount += 1
    compactedSinceLastProviderSuccess = true
    if (mode === "plan") planSparseReminderAfterCompaction = true
    return true
  }
  let lastRunContextFingerprint = ""
  const accessedMemoryIds = new Set<string>()
  await importLegacyMemoryFiles({
    cwd: host.cwd,
    config,
    runtime: orchestrationRuntime,
  }).catch((error) => {
      console.warn("[nexus] Legacy memory import failed:", error)
  })
  while (!signal.aborted) {
    loopIterations++
    await acceptAgentMailboxMessages(mailbox, session)
    commitPendingToolActivations()
    const toolCallsAtStartOfIteration = executedToolCallsTotal

    if (loopIterations > maxIterations) {
      if (!forceFinalAnswerNext) {
        terminalError = new Error(
          `Agent loop stopped after ${maxIterations} iterations in ${mode} mode (safety limit).`,
        )
        host.emit({
          type: "error",
          error: terminalError.message,
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
      providerAnchor: session.getProviderContextAnchor(),
    })
    const limitTokens = rollingCtx.limitTokens
    const usedTokens = rollingCtx.usedTokens
    const contextPercent = rollingCtx.percent
    const runtime = orchestrationRuntime
    const latestUserTaskText = getLatestUserTextForPrompt(session)
    const memoryQuery = [taskDesc, latestUserTaskText, mentionsContext ?? ""]
      .filter((item) => item.trim().length > 0)
      .join("\n")
    const memoryCandidates = await runtime.listMemories().catch(() => [])
    const accessibleTeamNames = config.memory?.teamMemoryEnabled === false
      ? []
      : await runtime.listTeamNamesForSession(session.id).catch(() => [])
    const memories = selectRelevantMemories(
      filterPromptMemoryCandidates(memoryCandidates, {
        sessionId: session.id,
        includeTeam: config.memory?.teamMemoryEnabled !== false,
        teamNames: accessibleTeamNames,
      }),
      memoryQuery,
      8,
    )
    const newlyAccessedMemoryIds = memories
      .map((item) => item.memory.id)
      .filter((memoryId) => !accessedMemoryIds.has(memoryId))
    if (newlyAccessedMemoryIds.length > 0) {
      for (const memoryId of newlyAccessedMemoryIds) accessedMemoryIds.add(memoryId)
      await runtime.recordMemoryAccess(newlyAccessedMemoryIds).catch(() => [])
    }
    const activeBackgroundTasks = await runtime.listBackgroundTasks()
      .then((tasks) => tasks.filter(
        (task) =>
          task.sessionId === session.id &&
          (task.status === "running" || task.status === "pending"),
      ))
      .catch(() => [])
    const backgroundTaskSummary = activeBackgroundTasks
          .filter((task) => task.status === "running" || task.status === "pending")
          .map((task) => {
            const parts = [
              `- ${task.id}`,
              `kind=${task.kind}`,
              `status=${task.status}`,
            ]
            if (task.processId) parts.push(`pid=${task.processId}`)
            if (task.sessionId) parts.push(`session=${task.sessionId}`)
            if (task.logPath) parts.push(`log=${task.logPath}`)
            if (task.description) parts.push(`desc=${task.description}`)
            return parts.join(" | ")
          })
          .join("\n")
    const runContext = {
      type: "run_context" as const,
      mode,
      memoryCitations: memories.map((item) => item.citation),
      taskIds: activeBackgroundTasks.map((task) => task.id),
    }
    const runContextFingerprint = JSON.stringify(runContext)
    durableRunContext = {
      mode: runContext.mode,
      memoryCitations: [...runContext.memoryCitations],
      taskIds: [...runContext.taskIds],
    }
    if (runContextFingerprint !== lastRunContextFingerprint) {
      host.emit(runContext)
      lastRunContextFingerprint = runContextFingerprint
    }
    const mergedBackgroundSummary = backgroundTaskSummary
    const sessionMemoryText =
      config.memory?.sessionMemoryEnabled !== false
        ? await readSessionMemoryFile(session.id, host.cwd).catch((error) => {
            if (!sessionMemoryReadWarned) {
              console.warn("[nexus] Session memory read failed; continuing without it:", error)
              sessionMemoryReadWarned = true
            }
            return ""
          })
        : ""
    const resolvedSkills = activatedSkillsForPrompt(session, skills)
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
      memories,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      contextUsedTokens: usedTokens,
      contextLimitTokens: limitTokens > 0 ? limitTokens : undefined,
      contextPercent: limitTokens > 0 ? contextPercent : undefined,
      backgroundJobsSummary: mergedBackgroundSummary || undefined,
      createSkillMode: createSkillMode === true,
      supportsStructuredOutput: activeClient.supportsStructuredOutput(),
      // The prompt must describe the exact provider-visible manifest. Hidden
      // compatibility fallbacks remain executable for old transcripts, but
      // advertising them here creates a false capability after mode switches.
      enabledToolNames: getResolvedToolsForLlm().map((tool) => tool.name),
      sessionMemoryContent: sessionMemoryText || undefined,
      planModeSparseReminder: mode === "plan" && planSparseReminderAfterCompaction ? true : undefined,
    }

    const { blocks, cacheableCount } = buildSystemPrompt(promptCtx)
    if (planSparseReminderAfterCompaction) planSparseReminderAfterCompaction = false
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

    // Compact before streaming when the *full* next request (messages + system + tools) exceeds the
    // same threshold as the UI — session-only estimates were too low and caused API 400s.
    const sumTh = config.summarization?.threshold ?? 0.8
    const limitCtx = getContextWindowLimit(activeClient.modelId, config.model.contextWindow)
    if (config.summarization?.auto !== false && limitCtx > 0) {
      const roll = computeContextUsageMetrics({
        sessionMessages: session.messages,
        systemPromptText: systemPrompt,
        toolsDefinitionTokens,
        modelId: activeClient.modelId,
        configuredContextWindow: config.model.contextWindow,
        providerAnchor: session.getProviderContextAnchor(),
      })
      if (compaction.isOverflow(roll.usedTokens, limitCtx, sumTh)) {
        compaction.prune(session)
        const roll2 = computeContextUsageMetrics({
          sessionMessages: session.messages,
          systemPromptText: systemPrompt,
          toolsDefinitionTokens,
          modelId: activeClient.modelId,
          configuredContextWindow: config.model.contextWindow,
          providerAnchor: session.getProviderContextAnchor(),
        })
        if (compaction.isOverflow(roll2.usedTokens, limitCtx, sumTh)) {
          if (compactedSinceLastProviderSuccess) {
            terminalError = new Error(
              "Context remains above the automatic compaction threshold after a successful compaction. " +
              "Nexus stopped before repeating the summarizer call.",
            )
            host.emit({
              type: "error",
              error: terminalError.message,
              fatal: true,
            })
            break
          }
          const result = await runCompactionLifecycle(
            session,
            activeClient,
            config,
            host,
            compaction,
            signal,
            {
              trigger: "automatic",
              forceSummary: true,
              fatalOnFailure: true,
              systemPromptText: systemPrompt,
              toolsDefinitionTokens,
              durableContext: durableRunContext,
              orchestrationRuntime,
            },
          )
          if (result.status === "failed") {
            terminalError = result.error
            break
          }
          if (result.status !== "compacted") {
            terminalError = new Error(
              `Automatic compaction could not reduce the overflowing context (${result.reason}).`,
            )
            host.emit({
              type: "error",
              error: terminalError.message,
              fatal: true,
            })
            break
          }
          compactionSuccessCount += 1
          compactedSinceLastProviderSuccess = true
          if (mode === "plan") planSparseReminderAfterCompaction = true
          continue
        }
      }
    }

    // 4. Build LLM tool definitions
    const llmTools: LLMToolDef[] = (isFinalIteration ? [] : getResolvedToolsForLlm()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    // 5. Build messages from session
    const messages = buildMessagesFromSession(session, {
      sessionId: session.id,
      emphasizeToolSpillPaths: config.memory?.emphasizeToolSpillPaths !== false,
    })

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
    const compactionSuccessCountAtProviderStart = compactionSuccessCount
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
    let streamedContextOverflowError: Error | undefined
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
      if (currentReasoning || currentReasoningDurationMs != null) {
        const openIdx = findLastOpenReasoningPartIndex(parts, currentReasoningId)
        const reasoningText =
          currentReasoning ||
          (openIdx >= 0 ? ((parts[openIdx] as ReasoningPart).text ?? "") : "") ||
          ""
        if (openIdx >= 0) {
          parts[openIdx] = {
            ...(parts[openIdx] as ReasoningPart),
            text: reasoningText,
            ...(currentReasoningId ? { reasoningId: currentReasoningId } : {}),
            ...(currentReasoningDurationMs != null ? { durationMs: currentReasoningDurationMs } : {}),
            ...(currentReasoningMetadata ? { providerMetadata: currentReasoningMetadata } : {}),
          } as ReasoningPart
        } else if (currentReasoning) {
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
        runToolPipeline(tc.toolCallId, tc.toolName, tc.toolInput, newMessageId, "parallel")
          .catch(err => ({
            success: false,
            output: `Error: ${err.message}`,
            attachments: undefined,
            metadata: undefined,
          }))
      )

      const results = await Promise.all(tasks)
      for (let i = 0; i < pendingReads.length; i++) {
        const tc = pendingReads[i]!
        const result = results[i]!
        const partId = `part_${tc.toolCallId}`

        // CRITICAL: update the tool part in the session with the result
        // This is what buildMessagesFromSession reads to include in the next LLM call
        const artifactFlush = artifactCapabilityFromToolMetadata(result.metadata)
        const backgroundTaskIdFlush =
          backgroundTaskIdFromMetadata(result.metadata)
        session.updateToolPart(newMessageId, partId, {
          status: result.success ? "completed" : "error",
          output: result.output,
          attachments: result.attachments,
          timeEnd: Date.now(),
          ...(result.success && tc.toolName === "ToolSearch"
            ? {
                activatedToolNames:
                  activatedToolNamesFromMetadata(result.metadata),
              }
            : {}),
          ...(result.success && tc.toolName === "Skill"
            ? {
                activatedSkillName:
                  activatedSkillNameFromMetadata(result.metadata),
              }
            : {}),
          ...(artifactFlush
            ? {
                outputArtifactId: artifactFlush.artifactId,
                outputArtifactOwnerSessionId: artifactFlush.ownerSessionId,
              }
            : {}),
          ...(backgroundTaskIdFlush
            ? { backgroundTaskId: backgroundTaskIdFlush }
            : {}),
        })

        host.emit({
          type: "tool_end",
          tool: tc.toolName,
          partId,
          messageId: newMessageId,
          success: result.success,
          output: result.output,
          error: result.success ? undefined : result.output,
          attachments: result.attachments,
          metadata: result.metadata,
        })
        if (tc.toolName === "TodoWrite") {
          host.emit({ type: "todo_updated", todo: session.getTodo() })
        }
        executedToolThisIteration = true
        executedToolCallsTotal++
        if ("stoppedByHook" in result && result.stoppedByHook) {
          attemptedCompletionThisIteration = true
        }
      }

      pendingReads.length = 0
    }

    let mailboxInterrupted = false
    let mailboxWatcherError: unknown
    const providerMailboxAbort = new AbortController()
    const providerSignal = linkedProviderSignal(
      signal,
      providerMailboxAbort.signal,
    )
    const mailboxWatcherAbort = new AbortController()
    const mailboxWatcher = mailbox
      ? Promise.resolve()
          .then(() => mailbox.waitForInput(mailboxWatcherAbort.signal))
          .then(() => {
            if (
              mailboxWatcherAbort.signal.aborted ||
              signal.aborted
            ) {
              return
            }
            mailboxInterrupted = true
            providerMailboxAbort.abort(
              new DOMException(
                "Provider sampling interrupted by delegated-agent input",
                "AbortError",
              ),
            )
          })
          .catch((error) => {
            if (mailboxWatcherAbort.signal.aborted) return
            mailboxWatcherError = error
            providerMailboxAbort.abort(error)
          })
      : undefined

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
        signal: providerSignal.signal,
        cacheableSystemBlocks: cacheableCount,
        promptCacheKey: session.id,
        maxTokens,
        temperature: config.model.temperature ?? getDefaultTemperature(config.model),
        topP: getDefaultTopP(config.model),
        topK: getDefaultTopK(config.model),
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
            // Next reasoning segment must not append into this buffer (provider often reuses reasoning-0).
            currentReasoning = ""
            currentReasoningDurationMs = undefined
            break

          case "tool_call": {
            // Some gateways omit reasoning_end before tool-call; close the open segment so the next stream does not append to the same Thought.
            if (currentReasoning.trim().length > 0 || currentReasoningStartedAt != null) {
              if (currentReasoningStartedAt != null) {
                currentReasoningDurationMs = Math.max(1, Date.now() - currentReasoningStartedAt)
              }
              flushAssistantContent()
              host.emit({
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
              const doomAction: ApprovalAction = {
                type: "doom_loop",
                tool: toolName,
                description: `Potential infinite loop: "${toolName}" called ${threshold} times with same args. Continue anyway?`,
              }
              const proceed = await requestHostApproval(
                host,
                doomAction,
                partId,
                { signal },
              ).then(
                (approval) => approval.approved,
                () => false,
              )
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
              if (attemptedCompletionThisIteration) break streamLoop

              // Plan mode: OpenClaude-style — plan must come from completed Write/Edit in this session (or same-turn write part).
              if (toolName === "PlanExit" && mode === "plan") {
                if (!planExitWriteGateSatisfied(session, newMessageId, toolCtx.cwd)) {
                  const errMsg =
                    "PlanExit requires at least one completed Write or Edit to `.nexus/plans/*.md` or `.txt` in this session (you may Write then PlanExit in the same turn). Pre-existing files on disk alone are not enough."
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

              const result = await runToolPipeline(
                toolCallId,
                toolName,
                toolInput,
                newMessageId,
                "native",
              )

              const artifactLoop = artifactCapabilityFromToolMetadata(result.metadata)
              const backgroundTaskIdLoop =
                backgroundTaskIdFromMetadata(result.metadata)
              const changeSetLoop =
                changeSetCapabilityFromToolMetadata(result.metadata)
              const fileChangeProjectionLoop = result.success
                ? projectFileChangeToolResult(
                    toolName,
                    toolInput,
                    result.metadata,
                  )
                : {}
              session.updateToolPart(newMessageId, partId, {
                status: result.success ? "completed" : "error",
                output: result.output,
                attachments: result.attachments,
                timeEnd: Date.now(),
                ...(result.success && toolName === "ToolSearch"
                  ? {
                      activatedToolNames:
                        activatedToolNamesFromMetadata(result.metadata),
                    }
                  : {}),
                ...(result.success && toolName === "Skill"
                  ? {
                      activatedSkillName:
                        activatedSkillNameFromMetadata(result.metadata),
                    }
                  : {}),
                ...(artifactLoop
                  ? {
                      outputArtifactId: artifactLoop.artifactId,
                      outputArtifactOwnerSessionId: artifactLoop.ownerSessionId,
                    }
                  : {}),
                ...(backgroundTaskIdLoop
                  ? { backgroundTaskId: backgroundTaskIdLoop }
                  : {}),
                ...(changeSetLoop ?? {}),
                ...fileChangeProjectionLoop,
              })

              host.emit({
                type: "tool_end",
                tool: toolName,
                partId,
                messageId: newMessageId,
                success: result.success,
                output: result.output,
                error: result.success ? undefined : result.output,
                attachments: result.attachments,
                compacted: (result as { compacted?: boolean }).compacted,
                metadata: result.metadata,
                ...(result.success && (toolName === "Write" || toolName === "Edit")
                  ? {
                      ...fileChangeProjectionLoop,
                      writtenContent: typeof (result as { metadata?: { writtenContent?: string } }).metadata?.writtenContent === "string"
                        ? (result.metadata as { writtenContent: string }).writtenContent
                        : undefined,
                    }
                  : {}),
              })

              if (toolName === "TodoWrite") {
                host.emit({ type: "todo_updated", todo: session.getTodo() })
              }

              lastToolName = toolName
              executedToolThisIteration = true
              executedToolCallsTotal++
              if (toolName === "EnterPlanMode" && result.success) {
                session.setMode("plan")
                requestedNextMode = "plan"
                await flushPendingReads()
                break streamLoop
              }
              if (result.stoppedByHook) {
                attemptedCompletionThisIteration = true
                await flushPendingReads()
                break streamLoop
              }
              if ((result.metadata as { questionRequest?: boolean } | undefined)?.questionRequest) {
                attemptedCompletionThisIteration = true
                await flushPendingReads()
                break streamLoop
              }
              if (
                result.success &&
                toolName === MANDATORY_END_TOOL[mode]
              ) {
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
              if (event.usage.totalTokens > 0) {
                const requestMetrics = computeContextUsageMetrics({
                  sessionMessages: session.messages,
                  systemPromptText: lastBuiltSystemPrompt || undefined,
                  toolsDefinitionTokens,
                  modelId: activeClient.modelId,
                  configuredContextWindow: config.model.contextWindow,
                })
                session.recordProviderContextAnchor({
                  messageId: newMessageId,
                  usedTokens: event.usage.totalTokens,
                  manifestTokens:
                    requestMetrics.systemTokens + requestMetrics.toolsTokens,
                  modelId: activeClient.modelId,
                  recordedAt: Date.now(),
                })
              }
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
              if (!isRetrying && isContextOverflowError(message)) {
                streamedContextOverflowError = err
                break
              }
              host.emit({ type: "error", error: message, fatal: !isRetrying })
              if (!isRetrying) {
                fatalStreamError = true
                terminalError = err
              }
            }
            break
        }
        if (streamedContextOverflowError) {
          await flushPendingReads()
          break streamLoop
        }
        if (budgetExceededThisIteration) {
          await flushPendingReads()
          break streamLoop
        }
        if (attemptedCompletionThisIteration) {
          await flushPendingReads()
          break streamLoop
        }
        if (mailboxInterrupted) {
          // Tool executions receive the root signal, not the provider-only
          // signal. Therefore a long tool reaches this boundary before mail is
          // accepted, while sampling itself stops immediately.
          await flushPendingReads()
          break streamLoop
        }
      }
    } catch (err) {
      if (signal.aborted) break
      if (mailboxInterrupted) {
        // The provider may throw its AbortError or simply close the stream.
        // Either is an expected local sampling interruption.
      } else {
        const errMsg = err instanceof Error ? err.message : String(err)

        // Check for context overflow error
        if (isContextOverflowError(errMsg)) {
          if (await recoverFromContextOverflow(err)) continue
          break
        }
        terminalError =
          err instanceof Error ? err : new Error(errMsg, { cause: err })
        host.emit({ type: "error", error: errMsg, fatal: true })
        break
      }
    } finally {
      // Let a notification queued by the provider's final event win before
      // closing the watcher; this seals the common final-response race.
      await Promise.resolve()
      mailboxWatcherAbort.abort()
      await mailboxWatcher
      providerSignal.dispose()
    }

    if (mailboxWatcherError) {
      terminalError =
        mailboxWatcherError instanceof Error
          ? mailboxWatcherError
          : new Error(String(mailboxWatcherError))
      host.emit({
        type: "error",
        error: `Delegated-agent mailbox failed: ${terminalError.message}`,
        fatal: true,
      })
      break
    }

    if (mailbox) {
      // Parallel read calls and partial assistant content must be part of the
      // checkpoint that precedes mailbox acknowledgement.
      await flushPendingReads()
      flushAssistantContent()
      const acceptedMailboxMessages =
        await acceptAgentMailboxMessages(mailbox, session)
      if (mailboxInterrupted || acceptedMailboxMessages > 0) {
        await session.save()
        emitContextUsage()
        continue
      }
    }

    if (streamedContextOverflowError) {
      if (await recoverFromContextOverflow(streamedContextOverflowError)) {
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

          const result = await runToolPipeline(
            syntheticCallId,
            call.toolName,
            call.toolInput,
            newMessageId,
            "textual",
          )

          const artifactTextual = artifactCapabilityFromToolMetadata(result.metadata)
          const backgroundTaskIdTextual =
            backgroundTaskIdFromMetadata(result.metadata)
          const changeSetTextual =
            changeSetCapabilityFromToolMetadata(result.metadata)
          const fileChangeProjectionTextual = result.success
            ? projectFileChangeToolResult(
                call.toolName,
                call.toolInput,
                result.metadata,
              )
            : {}
          session.updateToolPart(newMessageId, partId, {
            status: result.success ? "completed" : "error",
            output: result.output,
            attachments: result.attachments,
            timeEnd: Date.now(),
            ...(result.success && call.toolName === "ToolSearch"
              ? {
                  activatedToolNames:
                    activatedToolNamesFromMetadata(result.metadata),
                }
              : {}),
            ...(result.success && call.toolName === "Skill"
              ? {
                  activatedSkillName:
                    activatedSkillNameFromMetadata(result.metadata),
                }
              : {}),
            ...(artifactTextual
              ? {
                  outputArtifactId: artifactTextual.artifactId,
                  outputArtifactOwnerSessionId: artifactTextual.ownerSessionId,
                }
              : {}),
            ...(backgroundTaskIdTextual
              ? { backgroundTaskId: backgroundTaskIdTextual }
              : {}),
            ...(changeSetTextual ?? {}),
            ...fileChangeProjectionTextual,
          })

          host.emit({
            type: "tool_end",
            tool: call.toolName,
            partId,
            messageId: newMessageId,
            success: result.success,
            output: result.output,
            error: result.success ? undefined : result.output,
            attachments: result.attachments,
            compacted: (result as { compacted?: boolean }).compacted,
            metadata: result.metadata,
            ...(result.success && (call.toolName === "Write" || call.toolName === "Edit")
              ? {
                  ...fileChangeProjectionTextual,
                  writtenContent: typeof (result as { metadata?: { writtenContent?: string } }).metadata?.writtenContent === "string"
                    ? (result.metadata as { writtenContent: string }).writtenContent
                    : undefined,
                }
              : {}),
          })

          if (call.toolName === "TodoWrite") {
            host.emit({ type: "todo_updated", todo: session.getTodo() })
          }

          lastToolName = call.toolName
          executedToolThisIteration = true
          executedToolCallsTotal++
          if (call.toolName === "EnterPlanMode" && result.success) {
            session.setMode("plan")
            requestedNextMode = "plan"
            break
          }
          if (result.stoppedByHook) {
            attemptedCompletionThisIteration = true
            break
          }
          if ((result.metadata as { questionRequest?: boolean } | undefined)?.questionRequest) {
            attemptedCompletionThisIteration = true
            break
          }
          if (
            result.success &&
            call.toolName === MANDATORY_END_TOOL[mode]
          ) {
            attemptedCompletionThisIteration = true
          }
        }

        finishReason = "tool_calls"
      }
    }

    if (!fatalStreamError) {
      // A completed provider turn proves the current post-compaction context
      // was accepted. Preserve the guard only when a manual Condense happened
      // inside this very provider turn.
      compactedSinceLastProviderSuccess =
        compactionSuccessCount !== compactionSuccessCountAtProviderStart
    }

    // Stop on fatal stream errors; without this the outer loop can repeat forever.
    if (fatalStreamError) {
      break
    }
    if (requestedNextMode) {
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
    if (attemptedCompletionThisIteration) {
      if (await continueForMailboxBeforeCompletion()) continue
      break
    }
    if (finishReason === "stop" && !executedToolThisIteration) {
      if (sdkInvalidToolArgsRecovery) {
        flushAssistantContent()
        await session.save()
        emitContextUsage()
        continue
      }
      let mandatoryTool = MANDATORY_END_TOOL[mode]
      if (!mandatoryTool) {
        if (await continueForMailboxBeforeCompletion()) continue
        break
      }
      // Revision pass: user asked to change the plan — never inject PlanExit on a text-only stop; run another outer iteration so the model can edit .nexus/plans first.
      if (mode === "plan" && mandatoryTool === "PlanExit" && lastUserMessageRequestsPlanRevision(session)) {
        flushAssistantContent()
        await session.save()
        emitContextUsage()
        continue
      }
      const alreadyCalled = messageHasMandatoryEndTool(session, newMessageId, mode)
      if (mandatoryTool && !alreadyCalled && resolvedTools.some((t) => t.name === mandatoryTool)) {
        flushAssistantContent()
        const syntheticId = `forced_end_${loopIterations}_${Date.now()}`
        const partId = `part_${syntheticId}`
        const summary = (currentText || "").trim().slice(0, 2000) || "Work completed."
        let toolInput: Record<string, unknown>
        if (mandatoryTool === "PlanExit") {
          const gateOk = planExitWriteGateSatisfied(session, newMessageId, toolCtx.cwd)
          const trimmed = (currentText || "").trim().slice(0, 500)
          toolInput = {
            summary: gateOk
              ? (trimmed || "Plan ready.")
              : (trimmed ||
                "Planning stopped without a plan file write in this session. Write to .nexus/plans/*.md or .txt, then call PlanExit."),
          }
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
        const forcedResult = await runToolPipeline(
          syntheticId,
          mandatoryTool,
          toolInput,
          newMessageId,
          "native",
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
        if (
          forcedResult.success &&
          mandatoryTool === MANDATORY_END_TOOL[mode]
        ) {
          attemptedCompletionThisIteration = true
        }
      }
      if (await continueForMailboxBeforeCompletion()) continue
      break
    }
    if (signal.aborted) break

    const sumThEnd = config.summarization?.threshold ?? 0.8
    const metricsEnd = computeContextUsageMetrics({
      sessionMessages: session.messages,
      systemPromptText: lastBuiltSystemPrompt,
      toolsDefinitionTokens,
      modelId: activeClient.modelId,
      configuredContextWindow: config.model.contextWindow,
      providerAnchor: session.getProviderContextAnchor(),
    })
    const limitEnd = getContextWindowLimit(activeClient.modelId, config.model.contextWindow)
    if (
      config.summarization?.auto !== false &&
      limitEnd > 0 &&
      compaction.isOverflow(metricsEnd.usedTokens, limitEnd, sumThEnd)
    ) {
      if (compactedSinceLastProviderSuccess) {
        terminalError = new Error(
          "Context is still above the automatic compaction threshold after compaction. " +
          "Nexus stopped before repeating the summarizer call.",
        )
        host.emit({
          type: "error",
          error: terminalError.message,
          fatal: true,
        })
        break
      }
      const result = await runCompactionLifecycle(
        session,
        activeClient,
        config,
        host,
        compaction,
        signal,
        {
          trigger: "automatic",
          forceSummary: true,
          fatalOnFailure: true,
          systemPromptText: lastBuiltSystemPrompt,
          toolsDefinitionTokens,
          durableContext: durableRunContext,
          orchestrationRuntime,
        },
      )
      if (result.status === "failed") {
        terminalError = result.error
        break
      }
      if (result.status !== "compacted") {
        terminalError = new Error(
          `Automatic compaction could not reduce the overflowing context (${result.reason}).`,
        )
        host.emit({
          type: "error",
          error: terminalError.message,
          fatal: true,
        })
        break
      }
      compactionSuccessCount += 1
      compactedSinceLastProviderSuccess = true
      if (mode === "plan") planSparseReminderAfterCompaction = true
    }

    await session.save()
    emitContextUsage()

    const toolDeltaThisIteration = executedToolCallsTotal - toolCallsAtStartOfIteration
    sessionMemoryToolCallDebt += toolDeltaThisIteration
    const memMin = config.memory?.sessionMemoryMinToolCallsBetweenUpdates ?? 8
    if (
      config.memory?.sessionMemoryEnabled !== false &&
      sessionMemoryToolCallDebt >= memMin &&
      toolDeltaThisIteration > 0
    ) {
      const refresh = scheduleSessionMemoryRefresh({
        session,
        client: activeClient,
        cwd: host.cwd,
        config,
        services,
      })
      if (refresh?.started) {
        sessionMemoryToolCallDebt = 0
        void refresh.promise.catch((error) => {
          if (!signal.aborted) console.warn("[nexus] Session memory refresh failed:", error)
        })
      }
    }
  }

  // Error, abort, or mode-transition exits do not consume new input, but they
  // must stop being advertised as live before the final save/hooks begin.
  mailbox?.sealForCompletion()

  if (terminalError) {
    try {
      await session.save()
      host.emit({ type: "session_saved", sessionId: session.id })
      emitContextUsage()
    } catch (saveError) {
      throw new AggregateError(
        [terminalError, saveError],
        "Agent run failed and its partial session could not be saved",
      )
    }
    throw terminalError
  }

  if (signal.aborted) {
    await session.save()
    host.emit({ type: "session_saved", sessionId: session.id })
    emitContextUsage()
    return
  }

  if (!signal.aborted && lastAssistantMessageId && !doneEmitted) {
    const turnCompleteHookResults = await runPluginHooks(
      host.cwd,
      host,
      config,
      "turn_complete",
      {
        mode,
        sessionId: session.id,
        messageId: lastAssistantMessageId,
        completed: true,
        lastToolName,
      },
    ).catch(() => [])
    await recordPluginHookOutputs(session, host, "turn-complete-hook", turnCompleteHookResults, {
      mode,
    })
    // When mandatory end tool was executed, clear todo so it's removed from session.
    if (attemptedCompletionThisIteration) {
      session.updateTodo("")
      host.emit({ type: "todo_updated", todo: "" })
    }
    const durationMs = Math.max(0, Date.now() - turnStartedAt)
    session.updateMessage(lastAssistantMessageId, { durationMs })
    await session.save()
    host.emit({ type: "session_saved", sessionId: session.id })
    const autoDream = scheduleAutoMemoryDream({
      cwd: host.cwd,
      config,
      client: activeClient,
      services,
    })
    void autoDream?.promise.catch((error) => {
      console.warn("[nexus] Auto-memory consolidation failed:", error)
    })
    doneEmitted = true
    emitContextUsage()
    host.emit({
      type: "done",
      messageId: lastAssistantMessageId,
      durationMs,
    })
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


type HandleCompactionOpts = {
  trigger: "manual" | "automatic" | "context_overflow"
  /** Manual and overflow recovery must summarize even below the proactive threshold. */
  forceSummary: boolean
  /** Whether a failed lifecycle should be surfaced as a fatal run error. */
  fatalOnFailure: boolean
  /** Full next-request size (session + system + tools); required for accurate overflow vs UI/API limits. */
  systemPromptText?: string
  toolsDefinitionTokens?: number
  durableContext?: {
    mode: string
    memoryCitations: string[]
    taskIds: string[]
  }
  orchestrationRuntime: OrchestrationRuntime
}

type CompactionExecutionResult =
  | CompactionResult
  | {
      status: "skipped"
      reason: "auto_disabled" | "below_threshold"
    }
  | {
      status: "failed"
      reason:
        | "persistence_error"
        | "internal_error"
        | "no_summary_candidate"
      error: Error
    }

async function runCompactionLifecycle(
  session: ISession,
  client: LLMClient,
  config: NexusConfig,
  host: IHost,
  compaction: SessionCompaction,
  signal: AbortSignal,
  opts: HandleCompactionOpts,
): Promise<CompactionExecutionResult> {
  if (
    opts.trigger !== "manual" &&
    config.summarization?.auto === false
  ) {
    return { status: "skipped", reason: "auto_disabled" }
  }

  host.emit({ type: "compaction_start" })
  try {
    let result: CompactionExecutionResult
    try {
      result = await handleCompaction(
        session,
        client,
        config,
        host,
        compaction,
        signal,
        opts,
      )
    } catch (error) {
      result = {
        status: "failed",
        reason: "internal_error",
        error: normalizeCompactionError(
          error,
          "Compaction failed unexpectedly",
        ),
      }
    }
    if (
      opts.forceSummary &&
      result.status === "skipped" &&
      result.reason !== "auto_disabled" &&
      result.reason !== "below_threshold"
    ) {
      result = {
        status: "failed",
        reason: "no_summary_candidate",
        error: new Error(
          `Compaction could not produce a summary (${result.reason}).`,
        ),
      }
    }

    if (result.status === "failed") {
      const label =
        opts.trigger === "manual"
          ? "Manual compaction"
          : opts.trigger === "context_overflow"
            ? "Context-overflow compaction"
            : "Automatic compaction"
      host.emit({
        type: "error",
        error: `${label} failed: ${result.error.message}`.slice(0, 2_000),
        fatal:
          result.reason === "aborted"
            ? false
            : opts.fatalOnFailure,
      })
    }
    return result
  } finally {
    // `compaction_end` closes UI/runtime busy state even on failure. The
    // paired error event above carries the actual outcome.
    host.emit({ type: "compaction_end" })
  }
}

async function handleCompaction(
  session: ISession,
  client: LLMClient,
  config: NexusConfig,
  host: IHost,
  compaction: SessionCompaction,
  signal: AbortSignal,
  opts: HandleCompactionOpts,
): Promise<CompactionExecutionResult> {
  // First try prune (no LLM call needed).
  compaction.prune(session)
  compaction.microcompact(
    session,
    config.summarization?.keepRecentMessages ?? 8,
  )

  const contextLimit = getContextWindowLimit(
    client.modelId,
    config.model.contextWindow,
  )
  const threshold = config.summarization?.threshold ?? 0.8
  const metrics = computeContextUsageMetrics({
    sessionMessages: session.messages,
    systemPromptText: opts.systemPromptText,
    toolsDefinitionTokens: opts.toolsDefinitionTokens,
    modelId: client.modelId,
    configuredContextWindow: config.model.contextWindow,
    providerAnchor: session.getProviderContextAnchor(),
  })
  const shouldSummarize =
    opts.forceSummary ||
    (contextLimit > 0 &&
      compaction.isOverflow(metrics.usedTokens, contextLimit, threshold))
  if (!shouldSummarize) {
    return { status: "skipped", reason: "below_threshold" }
  }

  const result = await compaction.compact(session, client, signal, {
    keepRecentMessages: config.summarization?.keepRecentMessages ?? 8,
    // Use the configured/provider model window, not a generic summarizer cap.
    // Keep the same 20k response/safety reserve as the overflow policy.
    inputTokenBudget: Math.max(8_000, contextLimit - 20_000),
    // Once the caller has established pressure (or the user explicitly ran
    // Condense), summarize even a short/one-message active window.
    force: true,
    durableContext: opts.durableContext,
  })
  if (result.status !== "compacted") return result
  session.clearProviderContextAnchor()

  // The next provider attempt must never rely on a summary that exists only
  // in RAM. Codex persists replacement history before resuming; Nexus keeps
  // the evidence-preserving JSONL transcript and durably appends the summary.
  try {
    await session.save()
  } catch (error) {
    return {
      status: "failed",
      reason: "persistence_error",
      error: normalizeCompactionError(
        error,
        "Compaction summary could not be persisted",
      ),
    }
  }

  const projected = await projectPersistedCompactionSummary({
    session,
    summaryMessageId: result.summaryMessageId,
    cwd: host.cwd,
    config,
    orchestrationRuntime: opts.orchestrationRuntime,
  })
  for (const diagnostic of projected.diagnostics) {
    console.warn(`[nexus] ${diagnostic}`)
  }
  return result
}

function normalizeCompactionError(
  value: unknown,
  fallbackMessage: string,
): Error {
  if (value instanceof Error) return value
  if (typeof value === "string" && value.trim()) return new Error(value)
  return new Error(fallbackMessage)
}

/**
 * Build messages for the LLM from session history.
 *
 * Vercel AI SDK expects interleaved format:
 *   [user] question
 *   [assistant] text / tool-call blocks
 *   [tool]      { type: "tool-result", ... }
 *   [assistant] further text / tool-call blocks (repeated per tool round)
 *
 * Assistant `parts` are walked in **array order** (reasoning → text → tools),
 * matching UI chronology. Reasoning is sent as `{ type: "reasoning", text }` (KiloCode
 * UIMessage shape); `BaseLLMClient` may hoist to `reasoning_content` for interleaved APIs.
 * Pending/running tools get a synthetic error result (APIs require a result per call).
 * Tool output size is bounded at execution time (KiloCode `Truncate.output` parity in `truncate.ts`);
 * we do not apply a second hard cap when building the next LLM request (KiloCode `toModelMessages`
 * sends stored output as-is).
 */
function reasoningPartRawForLlm(part: ReasoningPart): string | null {
  const t = part.text?.trim() ?? ""
  if (!t || t === THOUGHT_PLACEHOLDER) return null
  return part.text
}

function getLatestUserTextForPrompt(session: ISession): string {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]
    if (!message || message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (!Array.isArray(message.content)) continue
    const text = (message.content as MessagePart[])
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

export function shouldUseDeferredToolLoading(
  deferredTools: ToolDef[],
  modelId: string,
  config: NexusConfig,
): boolean {
  if (deferredTools.length === 0) return false
  const mode = config.tools.deferredLoadingMode ?? "auto"
  if (mode === "always") return true
  if (mode === "never") return false

  const minimumTools = Math.max(1, config.tools.deferredLoadingMinimumTools ?? 8)
  if (deferredTools.length >= minimumTools) return true

  const contextLimit = getContextWindowLimit(modelId, config.model.contextWindow)
  if (contextLimit <= 0) return deferredTools.length >= minimumTools

  const thresholdPercent = Math.min(
    1,
    Math.max(0.01, config.tools.deferredLoadingThresholdPercent ?? 0.10),
  )
  const deferredTokens = estimateToolsDefinitionsTokens(
    deferredTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  )
  return deferredTokens >= Math.floor(contextLimit * thresholdPercent)
}

function formatAssistantTextPartForLlm(p: TextPart): string {
  return p.user_message?.trim() ? p.user_message.trim() + "\n" + p.text : p.text
}

type AssistantLlmBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }

/** Options for mapping session tool parts to LLM tool-result strings (spill path emphasis). */
type BuildSessionLlmOptions = {
  sessionId: string
  emphasizeToolSpillPaths?: boolean
}

function assistantBlocksToLlmContent(blocks: AssistantLlmBlock[]): LLMMessage["content"] | null {
  if (blocks.length === 0) return null
  const hasReasoning = blocks.some(b => b.type === "reasoning")
  const hasTool = blocks.some(b => b.type === "tool-call")
  if (!hasReasoning && !hasTool) {
    const merged = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim()
    return merged || null
  }
  const content: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  > = []
  let textBuf = ""
  const flushText = () => {
    if (textBuf.trim()) {
      content.push({ type: "text", text: textBuf })
      textBuf = ""
    }
  }
  for (const b of blocks) {
    if (b.type === "text") {
      textBuf += b.text
    } else if (b.type === "reasoning") {
      flushText()
      content.push({ type: "reasoning", text: b.text })
    } else {
      flushText()
      content.push({
        type: "tool-call",
        toolCallId: b.toolCallId,
        toolName: b.toolName,
        args: b.args,
      })
    }
  }
  flushText()
  return content.length > 0 ? (content as LLMMessage["content"]) : null
}

function toolPartToLlmResult(
  tp: ToolPart,
  opts?: BuildSessionLlmOptions,
): {
  type: "tool-result"
  toolCallId: string
  toolName: string
  result: string
  isError?: boolean
} {
  let result: string
  if (tp.compacted) {
    const artifactId =
      tp.outputArtifactId ||
      (opts?.sessionId
        ? getToolOutputSpill(opts.sessionId, tp.id)?.artifactId
        : undefined)
    result = artifactId
      ? `[Old tool result content cleared from active context. Use ToolOutputRead with artifact_id "${artifactId}".]`
      : "[Old tool result content cleared from active context]"
  } else {
    result = tp.output ?? ""
  }
  if (tp.status === "error") {
    result = formatToolAttemptForLanguageModel(tp.tool, tp.input, result)
  } else if (
    opts?.emphasizeToolSpillPaths !== false &&
    tp.status === "completed" &&
    !tp.compacted
  ) {
    const artifactId =
      tp.outputArtifactId ||
      (opts?.sessionId
        ? getToolOutputSpill(opts.sessionId, tp.id)?.artifactId
        : undefined)
    if (artifactId && !result.includes(artifactId)) {
      result =
        `${result}\n\n` +
        `[Full tool output is available through ToolOutputRead with artifact_id "${artifactId}".]`
    }
  }
  return {
    type: "tool-result",
    toolCallId: tp.id,
    toolName: tp.tool,
    result,
    isError: tp.status === "error",
  }
}

/**
 * Walk assistant `parts` in array order (same chronology as the UI) and emit
 * interleaved [assistant] / [tool] LLM messages with native `reasoning` parts (KiloCode-style).
 */
function buildAssistantLlmMessagesFromParts(parts: MessagePart[], llmOpts?: BuildSessionLlmOptions): LLMMessage[] {
  const out: LLMMessage[] = []
  let i = 0

  while (i < parts.length) {
    const blocks: AssistantLlmBlock[] = []

    while (i < parts.length && parts[i].type !== "tool") {
      const p = parts[i]
      if (p.type === "reasoning") {
        const rt = reasoningPartRawForLlm(p)
        if (rt) blocks.push({ type: "reasoning", text: rt })
      } else if (p.type === "text") {
        const chunk = formatAssistantTextPartForLlm(p)
        if (chunk) {
          const last = blocks[blocks.length - 1]
          if (last?.type === "text") last.text += chunk
          else blocks.push({ type: "text", text: chunk })
        }
      }
      // image / unknown: skip but advance (session order preserved for handled parts)
      i++
    }

    if (i < parts.length && parts[i].type === "tool") {
      const tools: ToolPart[] = []
      while (i < parts.length && parts[i].type === "tool") {
        tools.push(parts[i] as ToolPart)
        i++
      }
      for (const tp of tools) {
        if (tp.input != null) {
          blocks.push({
            type: "tool-call",
            toolCallId: tp.id,
            toolName: tp.tool,
            args: tp.input ?? {},
          })
        }
      }
      const assistantContent = assistantBlocksToLlmContent(blocks)
      if (assistantContent) {
        out.push({ role: "assistant", content: assistantContent })
      }

      const toolResultParts: Array<{
        type: "tool-result"
        toolCallId: string
        toolName: string
        result: string
        isError?: boolean
      }> = []
      for (const tp of tools) {
        if (tp.input == null) continue
        if (tp.status === "completed" || tp.status === "error") {
          toolResultParts.push(toolPartToLlmResult(tp, llmOpts))
        } else {
          toolResultParts.push({
            type: "tool-result",
            toolCallId: tp.id,
            toolName: tp.tool,
            result: "[Tool execution was interrupted]",
            isError: true,
          })
        }
      }
      if (toolResultParts.length > 0) {
        out.push({ role: "tool" as SessionRole, content: toolResultParts as LLMMessage["content"] })
      }
      continue
    }

    const trailing = assistantBlocksToLlmContent(blocks)
    if (trailing) out.push({ role: "assistant", content: trailing })
    break
  }

  return out
}

function buildMessagesFromSession(session: ISession, llmOpts?: BuildSessionLlmOptions): LLMMessage[] {
  const messages: LLMMessage[] = []

  for (const msg of getMessagesForActiveContext(session.messages)) {
    if (msg.summary) {
      messages.push({
        role: "user",
        content: formatConversationSummaryForModel(msg.content),
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

    messages.push(...buildAssistantLlmMessagesFromParts(parts, llmOpts))
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
function isContextOverflowError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("prompt too long") ||
    lower.includes("request too large") ||
    lower.includes("too many tokens") ||
    lower.includes("max tokens") ||
    lower.includes("413") ||
    lower.includes("too long") ||
    lower.includes("token limit")
  )
}
