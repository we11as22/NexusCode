/**
 * Nexus agent query bridge: run runAgentLoop and stream REPL Message types.
 * Converts AgentEvent → UserMessage | AssistantMessage | ProgressMessage so the REPL can render.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  PermissionResult,
  SessionMessage,
  MessagePart,
  TextPart,
  ToolPart,
  UserQuestionRequest,
} from '@nexuscode/core'
import {
  runAgentLoop,
  DurableRunEventSink,
  createLLMClient,
  finalizeConfigCredentials,
  getConfigEnvironment,
  loadAgentInstructionBundle,
  loadSkills,
  getClaudeCompatibilityOptions,
  Session,
  isDelegatedAgentParentTool,
  getNexusServerTokenSecretKey,
  isLoopbackNexusServerDestination,
  NEXUS_SERVER_TOKEN_SECRET_KEY,
  SessionProtocolError,
  SessionTurnTerminalError,
  ChangeSetService,
  hashWorkspaceIdentity,
  type AgentEvent,
  type ToolDef,
} from '@nexuscode/core'
import {
  applyCliModelSelection,
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from './nexus-bootstrap.js'
import type { SubagentEvent } from './nexus-subagents.js'
import { CliHost } from './host.js'
import { NexusServerClient } from './server-client.js'
import {
  assertRemoteCliSelectionSupported,
  resumeRemoteCliTurn,
  runRemoteCliTurn,
} from './remote-turn.js'
import {
  createAssistantMessage,
  createAssistantAPIErrorMessage,
  createUserMessage,
  createProgressMessage,
} from './utils/messages.js'
import type {
  Message as MessageType,
  AssistantMessage,
} from './query.js'
import type { Tool } from './Tool.js'
import type { ApprovalAction } from '@nexuscode/core'
import type { AssistantAPIMessage as APIAssistantMessage } from './provider/message-schema.js'
import {
  nexusModeMessageFromAgentEvent,
  type NexusModeMessage,
} from './nexus-mode-transition.js'
import {
  compactTimelineAfterBoundary,
  decideAssistantDraftPublish,
  enqueueProjectedAgentEvent,
  isStreamingDraftEvent,
  nexusAssistantMessageUuid,
  projectAssistantDraft,
  projectVisibleAssistantDraft,
  reduceAssistantDraft,
  upsertTimelineMessage,
  type NexusAssistantDraft,
  type NexusAssistantDraftPreview,
} from './nexus-message-projection.js'
import { getGlobalConfig } from './utils/config.js'
import {
  waitForEventWake,
  waitForStreamFrame,
} from './event-waiter.js'

// Kimi Code uses the same 50 ms window: token deltas stay visually fluid while
// expensive full Ink frames are coalesced before reaching VS Code Terminal.
const STREAMING_UI_FLUSH_MS = 50

export type NexusApprovalMessage = { type: 'nexus_approval'; action: ApprovalAction; partId: string }
/** Shown above input (e.g. Compacting…). text empty clears. clearAfterMs auto-clears success lines. */
export type NexusBannerMessage = { type: 'nexus_banner'; text: string; clearAfterMs?: number }
/** Todo list update from agent (TodoWrite tool). Rendered above input, below progress. */
export type NexusTodoMessage = { type: 'nexus_todo'; todo: string }
export type NexusQuestionMessage = { type: 'nexus_question'; request: UserQuestionRequest }
export type NexusContextMessage = {
  type: 'nexus_context'
  usedTokens: number
  limitTokens: number
  percent: number
  source?: 'provider' | 'hybrid' | 'estimated'
  providerTokens?: number
  pendingTokens?: number
}
export type NexusSessionSyncMessage = {
  type: 'nexus_session_sync'
  messages: MessageType[]
}

type ContentBlockParam = APIAssistantMessage['content'][number]
type UsageWithCache = APIAssistantMessage['usage']

const TODO_TOOL_NAMES = new Set(['TodoWrite', 'update_todo_list'])

/**
 * Only hide *auxiliary* spawn tools from the timeline. The parent SpawnAgent / Parallel
 * call must emit progress + tool_result so REPL has a `part_*` row to attach
 * `subagentsByPartId` to (otherwise subagent events update state with nothing visible).
 */
function shouldHideSubagentToolDisplay(toolName: string, _input?: unknown): boolean {
  return toolName === 'SpawnAgentOutput' || toolName === 'SpawnAgentStop'
}

export type AutoApprovePermissions = {
  read: boolean
  write: boolean
  execute: boolean
  mcp: boolean
  browser: boolean
}

function sessionMessageToAssistantContent(msg: SessionMessage): ContentBlockParam[] {
  const content = msg.content
  const blocks: ContentBlockParam[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ type: 'text', text: content })
    return blocks
  }
  const parts = content as MessagePart[]
  for (const p of parts) {
    if (p.type === 'text') {
      const tp = p as TextPart & { user_message?: string }
      const userMessage = tp.user_message?.trim()
      if (userMessage) {
        blocks.push({ type: 'text', text: userMessage })
      }
      const t = tp.text
      if (t?.trim()) blocks.push({ type: 'text', text: t })
    } else if (p.type === 'reasoning') {
      const r = (p as { text: string }).text
      if (r?.trim()) {
        blocks.push({
          type: 'thinking',
          thinking: r,
          signature: '',
        } as ContentBlockParam)
      }
    } else if (p.type === 'tool') {
      const tp = p as ToolPart
      if (tp.mergedFromSubagent) continue
      if (TODO_TOOL_NAMES.has(tp.tool)) continue
      if (shouldHideSubagentToolDisplay(tp.tool, tp.input)) continue
      blocks.push({
        type: 'tool_use',
        id: tp.id,
        name: tp.tool,
        input: (tp.input ?? {}) as Record<string, string>,
      })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

function buildAssistantMessageFromSession(msg: SessionMessage): AssistantMessage {
  const content = sessionMessageToAssistantContent(msg)
  return {
    type: 'assistant',
    costUSD: 0,
    durationMs: msg.durationMs ?? 0,
    uuid: nexusAssistantMessageUuid(msg.id),
    message: {
      id: msg.id,
      model: '',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: '',
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as UsageWithCache,
      content,
    },
  }
}

function sessionUserPlainText(msg: SessionMessage): string {
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content as MessagePart[]
  const lines: string[] = []
  for (const p of parts) {
    if (p.type === 'text') lines.push((p as TextPart).text ?? '')
  }
  return lines.join('\n').trimEnd()
}

type CliToolResultProjectionInput = {
  tool: string
  output: string
  path?: string
  diffStats?: { added: number; removed: number }
  diffHunks?: Array<{ type: string; lineNum: number; line: string }>
  appliedReplacements?: Array<{ oldSnippet: string; newSnippet: string }>
  compacted?: boolean
  metadata?: Record<string, unknown>
  success: boolean
}

function projectCliToolResultData(input: CliToolResultProjectionInput): Record<string, unknown> {
  const mergedMetadata = { ...(input.metadata ?? {}) }
  if (input.appliedReplacements?.length) {
    mergedMetadata.appliedReplacements = input.appliedReplacements
  }

  return {
    tool: input.tool,
    output: input.output,
    path: input.path,
    diffStats: input.diffStats,
    diffHunks: input.diffHunks,
    compacted: input.compacted,
    metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
    success: input.success,
  }
}

function restoredToolResultMessage(part: ToolPart): MessageType | null {
  if (part.mergedFromSubagent) return null
  if (TODO_TOOL_NAMES.has(part.tool)) return null
  if (shouldHideSubagentToolDisplay(part.tool, part.input)) return null
  if (part.status !== 'completed' && part.status !== 'error') return null

  const success = part.status === 'completed'
  const output = part.output ?? part.error ?? ''
  return createUserMessage(
    [
      {
        type: 'tool_result',
        tool_use_id: part.id,
        content: output,
        is_error: !success,
      },
    ],
    {
      data: projectCliToolResultData({
        tool: part.tool,
        output,
        path: part.path,
        diffStats: part.diffStats,
        diffHunks: part.diffHunks,
        appliedReplacements: part.appliedReplacements,
        compacted: part.compacted,
        success,
      }),
      resultForAssistant: output,
    },
  )
}

/**
 * Rebuild REPL timeline messages from persisted session (after checkpoint restore / rewind).
 */
export function replMessagesFromSession(messages: SessionMessage[]): MessageType[] {
  const out: MessageType[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = sessionUserPlainText(msg)
      if (text.trim().length > 0) {
        out.push(createUserMessage(text))
      }
    } else if (msg.role === 'assistant') {
      out.push(buildAssistantMessageFromSession(msg))
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type !== 'tool') continue
          const result = restoredToolResultMessage(part as ToolPart)
          if (result) out.push(result)
        }
      }
    }
  }
  return out
}

export interface QueryNexusOptions {
  nexus: NexusBootstrapResult
  userPrompt: string
  repoTools: Tool[]
  signal: AbortSignal
  tuiApprovalRef?: { current: ((r: PermissionResult) => void) | null }
  autoApprovePermissions?: Partial<AutoApprovePermissions>
  autoApprove?: boolean
  /** Override mode for this run (agent/plan/ask/debug/review). Defaults to nexus.mode. */
  modeOverride?: string
  /** When set, called for each subagent_* event; partId is the SpawnAgent tool_use id. */
  onSubagentEvent?: (partId: string, event: SubagentEvent) => void
  /** When set, called when a run completes with the host (for revert last turn /undo). */
  onRunComplete?: (host: import('./host.js').CliHost) => void
  /** Attach to an already-active server turn instead of submitting input. */
  remoteResume?: boolean
  onRemoteResume?: (attached: boolean) => void
}

/**
 * Run the Nexus agent loop and yield REPL Message types.
 * Yields NexusApprovalMessage when tool_approval_needed so REPL can show the approval panel and resolve tuiApprovalRef.
 * Loads config from disk at start so that model/LLM settings saved in the CLI are applied.
 */
export async function* queryNexus(opts: QueryNexusOptions): AsyncGenerator<MessageType | NexusApprovalMessage | NexusBannerMessage | NexusTodoMessage | NexusQuestionMessage | NexusContextMessage | NexusSessionSyncMessage | NexusModeMessage, void> {
  const {
    nexus,
    userPrompt,
    repoTools,
    signal,
    tuiApprovalRef,
    autoApprovePermissions,
    autoApprove = false,
    modeOverride,
    onSubagentEvent,
    onRunComplete,
    remoteResume = false,
    onRemoteResume,
  } = opts
  const {
    session: bootstrapSession,
    mode: bootstrapMode,
    compaction,
    indexer,
    serverUrl,
  } = nexus
  if (remoteResume && !serverUrl) {
    throw new Error('Remote turn resume requires NexusCode Server')
  }
  const mode = (modeOverride ?? bootstrapMode) as 'agent' | 'plan' | 'ask' | 'debug' | 'review'

  let session = bootstrapSession
  // Local loop mutates this Session; server persists via HTTP and adds the user turn in runSession.
  if (!serverUrl) {
    session.addMessage({ role: 'user', content: userPrompt })
  }

  let config = await loadCliWorkspaceConfig(nexus.cwd, {
    loadEnv: !serverUrl,
    hostAuthority: !serverUrl,
  })
  const configEnvironment = getConfigEnvironment(config)
  if (serverUrl) {
    assertRemoteCliSelectionSupported(nexus.cliModelSelection)
  }
  applyCliModelSelection(config, nexus.cliModelSelection)
  if (autoApprovePermissions) {
    config = {
      ...config,
      permissions: {
        ...config.permissions,
        ...(typeof autoApprovePermissions.read === 'boolean'
          ? { autoApproveRead: autoApprovePermissions.read }
          : {}),
        ...(typeof autoApprovePermissions.write === 'boolean'
          ? { autoApproveWrite: autoApprovePermissions.write }
          : {}),
        ...(typeof autoApprovePermissions.execute === 'boolean'
          ? { autoApproveCommand: autoApprovePermissions.execute }
          : {}),
        ...(typeof autoApprovePermissions.mcp === 'boolean'
          ? { autoApproveMcp: autoApprovePermissions.mcp }
          : {}),
        ...(typeof autoApprovePermissions.browser === 'boolean'
          ? { autoApproveBrowser: autoApprovePermissions.browser }
          : {}),
      },
    }
  }
  if (autoApprove) {
    config = {
      ...config,
      permissions: {
        ...config.permissions,
        autoApproveRead: true,
        autoApproveWrite: true,
        autoApproveCommand: true,
        autoApproveMcp: true,
        autoApproveBrowser: true,
      },
    }
  }

  let rulesContent = nexus.rulesContent
  let skills = nexus.skills
  if (!serverUrl) {
    const compatibility = getClaudeCompatibilityOptions(config)
    ;[rulesContent, skills] = await Promise.all([
      loadAgentInstructionBundle(nexus.cwd, config.rules.files, config, compatibility),
      loadSkills(
        config.skills,
        nexus.cwd,
        config.skillsUrls,
        compatibility,
        config,
      ).catch(() => []),
    ])
    await nexus.reconcileMcpServers(config)
    nexus.rulesContent = rulesContent
    nexus.skills = skills
    nexus.config = config
    nexus.configSnapshot = {
      ...nexus.configSnapshot,
      skills: config.skills,
      skillsConfig: config.skillsConfig,
      rules: { files: config.rules.files },
      mcp: { servers: config.mcp.servers },
    }
  }
  const runtimeConfig = serverUrl
    ? config
    : await finalizeConfigCredentials(
        config as unknown as Record<string, unknown>,
        nexus.secretsStore,
        {
          profileName: nexus.cliModelSelection.profileOverride,
          environment: configEnvironment,
        },
      ) as unknown as typeof config
  const runContext = await nexus.createRunContext(config, runtimeConfig)
  for (const diagnostic of runContext.toolContributionDiagnostics) {
    console.warn(`[nexus] ${diagnostic.sourceId}: ${diagnostic.message}`)
  }
  const runToolRegistry = runContext.toolRegistry

  const eventQueue: AgentEvent[] = []
  let resolveNext: (() => void) | null = null
  let runError: Error | null = null
  function wakeWaitingConsumer(): void {
    const fn = resolveNext
    if (!fn) return
    resolveNext = null
    fn()
  }
  /** partId of the last tool_start(SpawnAgent); subagent_* events attach to this part. */
  let lastSpawnAgentPartId: string | null = null

  const allApprovalsEnabled =
    !!autoApprovePermissions &&
    autoApprovePermissions.read === true &&
    autoApprovePermissions.write === true &&
    autoApprovePermissions.execute === true &&
    autoApprovePermissions.mcp === true &&
    autoApprovePermissions.browser === true

  const deliverEvent = (event: AgentEvent) => {
    enqueueProjectedAgentEvent(eventQueue, event)
    wakeWaitingConsumer()
  }
  const durableEventSink = !serverUrl
    ? await DurableRunEventSink.create({
        cwd: nexus.cwd,
        sessionId: session.id,
        mode,
        deliver: deliverEvent,
      })
    : null
  const host = new CliHost(nexus.cwd, (event: AgentEvent) => {
    if (durableEventSink) durableEventSink.emit(event)
    else deliverEvent(event)
  }, autoApprove || allApprovalsEnabled, tuiApprovalRef, {
    read: autoApprovePermissions?.read === true,
  })

  const localExecutionIdentity = durableEventSink
    ? {
        workspaceId: hashWorkspaceIdentity(
          await realpath(nexus.cwd).catch(() => path.resolve(nexus.cwd)),
        ),
        sessionId: session.id,
        turnId: `turn_${durableEventSink.runId}`,
        runId: durableEventSink.runId,
      }
    : undefined
  if (localExecutionIdentity && runContext.services.changeSets) {
    const binding = runContext.services.changeSets
    if (binding.workspaceId !== localExecutionIdentity.workspaceId) {
      throw new Error(
        "CLI durable change storage does not match the active workspace",
      )
    }
    host.bindDurableChangeReview(
      new ChangeSetService({
        workspaceId: binding.workspaceId,
        store: binding.store,
        files: {
          readFileState: (filePath) => host.readFileState(filePath),
          applyFileMutation: (mutation) =>
            host.applyFileMutation(mutation),
        },
      }),
      session.id,
      localExecutionIdentity.turnId,
    )
  }

  const { builtin, dynamic } = runToolRegistry.getForMode(mode)
  const tools: ToolDef[] = runToolRegistry.mergeWithHiddenExecutionTools([
    ...builtin,
    ...dynamic,
  ])

  let runPromise: Promise<void>
  let runSettled = false
  if (serverUrl) {
    const serverToken =
      process.env.NEXUS_SERVER_TOKEN?.trim() ||
      await nexus.secretsStore.getSecret(
        getNexusServerTokenSecretKey(serverUrl),
      ) ||
      (isLoopbackNexusServerDestination(serverUrl)
        ? await nexus.secretsStore.getSecret(NEXUS_SERVER_TOKEN_SECRET_KEY)
        : null)
    if (!serverToken) {
      throw new Error(
        "NexusCode server token is required. Set NEXUS_SERVER_TOKEN or store a token bound to this server endpoint.",
      )
    }
    const serverClient = new NexusServerClient({
      baseUrl: serverUrl,
      directory: nexus.cwd,
      token: serverToken,
    })
    const sid = bootstrapSession.id
    runPromise = (async () => {
      try {
        const cursorStore = nexus.remoteTurnCursorStore
        if (!cursorStore) {
          throw new Error('Remote turn cursor store is not configured')
        }
        const deliverRemoteEvent = async (event: AgentEvent) => {
          if (
            event.type === 'assistant_content_complete' ||
            event.type === 'compaction_end'
          ) {
            try {
              const msgs = await serverClient.getRecentMessages(sid)
              session = new Session(sid, nexus.cwd, msgs, undefined, true)
            } catch {
              // Keep the last known session shadow.
            }
          }
          deliverEvent(event)
        }
        if (remoteResume) {
          const attached = await resumeRemoteCliTurn({
            client: serverClient,
            sessionId: sid,
            signal,
            approvalRef: tuiApprovalRef,
            cursorStore,
            onActiveExecution: (execution) => {
              nexus.mode = execution.mode
            },
            deliver: deliverRemoteEvent,
          })
          onRemoteResume?.(attached)
        } else {
          let liveIdentity:
            | { turnId: string; runId: string }
            | undefined
          let acknowledgedSequence = 0
          let admissionCursorWrite: Promise<void> = Promise.resolve()
          try {
            await runRemoteCliTurn({
              client: serverClient,
              sessionId: sid,
              input: [{ type: 'text', text: userPrompt }],
              mode,
              signal,
              approvalRef: tuiApprovalRef,
              deliver: deliverRemoteEvent,
              onCommandPrepared: (prepared) => {
                acknowledgedSequence = Math.max(
                  acknowledgedSequence,
                  prepared.afterSequence,
                )
                return cursorStore.savePrepared(sid, {
                  version: 1,
                  phase: 'prepared',
                  ...prepared,
                  input: [{ type: 'text', text: userPrompt }],
                  mode,
                })
              },
              onTurn: (identity) => {
                liveIdentity = identity
                admissionCursorWrite = cursorStore.save(sid, {
                  ...identity,
                  afterSequence: acknowledgedSequence,
                })
              },
              onSequence: async (sequence) => {
                await admissionCursorWrite
                if (!liveIdentity) {
                  throw new Error(
                    'Remote sequence arrived before turn admission',
                  )
                }
                acknowledgedSequence = Math.max(
                  acknowledgedSequence,
                  sequence,
                )
                await cursorStore.save(sid, {
                  ...liveIdentity,
                  afterSequence: acknowledgedSequence,
                })
              },
            })
          } catch (error) {
            await admissionCursorWrite
            if (error instanceof SessionTurnTerminalError) {
              await cursorStore.clear(sid)
            } else if (
              !liveIdentity &&
              error instanceof SessionProtocolError &&
              !error.protocolError.retryable
            ) {
              await cursorStore.clear(sid)
            }
            throw error
          }
          await admissionCursorWrite
          if (!signal.aborted) await cursorStore.clear(sid)
        }
        try {
          const msgs = await serverClient.getRecentMessages(sid)
          session = new Session(sid, nexus.cwd, msgs, undefined, true)
        } catch {
          // Keep the session from the latest assistant_content_complete.
        }
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err))
        wakeWaitingConsumer()
      } finally {
        runSettled = true
        wakeWaitingConsumer()
      }
    })()
  } else {
    const client = createLLMClient(runtimeConfig.model)
    runPromise = (async () => {
      let status: "completed" | "failed" | "aborted" = "completed"
      try {
        await runAgentLoop({
          session,
          executionIdentity: localExecutionIdentity!,
          client,
          host,
          config,
          services: runContext.services,
          mode,
          tools,
          skills,
          rulesContent,
          indexer: indexer ?? undefined,
          compaction,
          signal,
        })
        if (signal.aborted) status = "aborted"
      } catch (err) {
        status = signal.aborted ? "aborted" : "failed"
        runError = err instanceof Error ? err : new Error(String(err))
        wakeWaitingConsumer()
      } finally {
        await durableEventSink!.finish(status).catch((error) => {
          runError ??= error instanceof Error ? error : new Error(String(error))
          wakeWaitingConsumer()
        })
        runSettled = true
        wakeWaitingConsumer()
      }
    })()
  }

  const consumed: MessageType[] = []
  const assistantDrafts = new Map<string, NexusAssistantDraft>()
  const assistantDraftPreviews = new Map<
    string,
    NexusAssistantDraftPreview
  >()
  const showReasoning = getGlobalConfig().showReasoning ?? false

  function* drainQueue(): Generator<MessageType | NexusApprovalMessage | NexusBannerMessage | NexusTodoMessage | NexusQuestionMessage | NexusContextMessage | NexusSessionSyncMessage | NexusModeMessage, boolean, unknown> {
    while (eventQueue.length > 0) {
      const event = eventQueue.shift()!
      if (
        event.type === 'assistant_message_started' ||
        event.type === 'text_delta' ||
        event.type === 'reasoning_start' ||
        event.type === 'reasoning_delta' ||
        event.type === 'reasoning_end'
      ) {
        const draft = reduceAssistantDraft(
          assistantDrafts.get(event.messageId),
          event,
        )
        if (draft) assistantDrafts.set(event.messageId, draft)
        if (
          draft &&
          (event.type === 'text_delta' ||
            event.type === 'reasoning_delta' ||
            event.type === 'reasoning_end')
        ) {
          const decision = decideAssistantDraftPublish(
            draft,
            showReasoning,
            assistantDraftPreviews.get(event.messageId) ?? null,
            event.type === 'reasoning_end',
          )
          if (decision.publish && decision.nextVisible) {
            assistantDraftPreviews.set(
              event.messageId,
              decision.nextVisible,
            )
            yield projectVisibleAssistantDraft(
              draft,
              decision.nextVisible,
            )
          }
        }
        continue
      }
      for (const draft of assistantDrafts.values()) {
        const decision = decideAssistantDraftPublish(
          draft,
          showReasoning,
          assistantDraftPreviews.get(draft.messageId) ?? null,
          true,
        )
        if (decision.publish && decision.nextVisible) {
          assistantDraftPreviews.set(draft.messageId, decision.nextVisible)
          yield projectVisibleAssistantDraft(draft, decision.nextVisible)
        }
      }
      if (event.type === 'todo_updated') {
        yield { type: 'nexus_todo', todo: event.todo ?? '' }
        continue
      }
      if (event.type === 'compaction_start') {
        yield { type: 'nexus_banner', text: 'Compacting…' }
        continue
      }
      if (event.type === 'compaction_end') {
        yield {
          type: 'nexus_banner',
          text: '● Conversation compaction finished.',
          clearAfterMs: 4500,
        }
        const compactedMessages = compactTimelineAfterBoundary(consumed)
        consumed.splice(0, consumed.length, ...compactedMessages)
        yield {
          type: 'nexus_session_sync',
          messages: compactedMessages,
        }
        continue
      }
      if (event.type === 'doom_loop_detected') {
        yield { type: 'nexus_banner', text: `Loop detected (tool: ${event.tool}). Approve or deny in the dialog below.` }
        continue
      }
      if (event.type === 'tool_approval_needed') {
        yield { type: 'nexus_approval', action: event.action, partId: event.partId }
        continue
      }
      if (event.type === 'question_request') {
        yield { type: 'nexus_question', request: event.request }
        continue
      }
      if (event.type === 'context_usage') {
        yield {
          type: 'nexus_context',
          usedTokens: event.usedTokens,
          limitTokens: event.limitTokens,
          percent: event.percent,
          source: event.source,
          providerTokens: event.providerTokens,
          pendingTokens: event.pendingTokens,
        }
        continue
      }
      if (event.type === 'task_created' || event.type === 'task_updated') {
        yield {
          type: 'nexus_banner',
          text: `Task ${event.task.id}: ${event.task.status} — ${event.task.subject}`,
          clearAfterMs: 3500,
        }
        continue
      }
      if (event.type === 'task_progress') {
        yield {
          type: 'nexus_banner',
          text: `Task ${event.task.id}: ${event.task.status} — ${event.task.subject}`,
          clearAfterMs: 2500,
        }
        continue
      }
      if (event.type === 'task_completed') {
        yield {
          type: 'nexus_banner',
          text: `Task ${event.task.id}: ${event.task.status} — ${event.task.subject}`,
          clearAfterMs: 3500,
        }
        continue
      }
      if (event.type === 'task_tool_start') {
        yield {
          type: 'nexus_banner',
          text: `Task ${event.taskId}: running ${event.tool}`,
          clearAfterMs: 2500,
        }
        continue
      }
      if (event.type === 'task_tool_end') {
        yield {
          type: 'nexus_banner',
          text: `Task ${event.taskId}: ${event.tool} ${event.success ? 'completed' : 'failed'}`,
          clearAfterMs: 2500,
        }
        continue
      }
      if (event.type === 'team_updated') {
        yield {
          type: 'nexus_banner',
          text: `Team updated: ${event.team.name}`,
          clearAfterMs: 3000,
        }
        continue
      }
      if (event.type === 'team_message') {
        yield {
          type: 'nexus_banner',
          text: `Message ${event.message.from} → ${event.message.to}`,
          clearAfterMs: 3000,
        }
        continue
      }
      if (event.type === 'remote_session_updated') {
        yield {
          type: 'nexus_banner',
          text: `Remote ${event.remoteSession.id}: ${event.remoteSession.status}`,
          clearAfterMs: 3000,
        }
        continue
      }
      if (event.type === 'plugin_hook') {
        yield {
          type: 'nexus_banner',
          text: `Plugin hook ${event.pluginName}: ${event.success ? 'ok' : 'failed'}`,
          clearAfterMs: 3000,
        }
        continue
      }
      if (event.type === 'background_task_updated') {
        yield {
          type: 'nexus_banner',
          text: `Background task ${event.task.id}: ${event.task.status}`,
          clearAfterMs: 3000,
        }
        continue
      }
      if (event.type === 'assistant_content_complete') {
        const completed = session.messages.find(
          (message) =>
            message.id === event.messageId &&
            message.role === 'assistant',
        )
        assistantDrafts.delete(event.messageId)
        assistantDraftPreviews.delete(event.messageId)
        if (completed) {
          const am = buildAssistantMessageFromSession(completed)
          consumed.push(am)
          yield am
        }
      } else if (event.type === 'tool_start') {
        if (TODO_TOOL_NAMES.has(event.tool)) continue
        const startInput =
          event.input != null && typeof event.input === 'object'
            ? (event.input as Record<string, unknown>)
            : undefined
        if (isDelegatedAgentParentTool(event.tool, startInput)) {
          lastSpawnAgentPartId = event.partId
        }
        if (shouldHideSubagentToolDisplay(event.tool, event.input)) continue
        // Match reference: ProgressMessage content must have content[0] = tool_use so REPL shows ToolUseLoader
        const toolUseBlock: ContentBlockParam = {
          type: 'tool_use',
          id: event.partId,
          name: event.tool,
          input: (event.input ?? {}) as Record<string, string>,
        }
        const progressAssistantMessage: AssistantMessage = {
          type: 'assistant',
          costUSD: 0,
          durationMs: 0,
          uuid: randomUUID(),
          message: {
            id: `progress-${event.partId}`,
            model: '',
            role: 'assistant',
            stop_reason: 'end_turn',
            stop_sequence: '',
            type: 'message',
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as UsageWithCache,
            content: [toolUseBlock],
          },
        }
        const pm = createProgressMessage(
          event.partId,
          new Set(),
          progressAssistantMessage,
          consumed.slice() as import('./utils/messages.js').NormalizedMessage[],
          repoTools,
        )
        consumed.push(pm)
        yield pm
      } else if (event.type === 'tool_end') {
        if (TODO_TOOL_NAMES.has(event.tool)) continue
        const modeMessage = nexusModeMessageFromAgentEvent(event)
        if (modeMessage) nexus.mode = modeMessage.mode
        // Do not clear lastSpawnAgentPartId here: subagent_* events may arrive after the
        // parent spawn tool_end; they fall back to lastSpawnAgentPartId when parentPartId is absent.
        if (shouldHideSubagentToolDisplay(event.tool)) continue
        const toolResultText = event.output ?? (event.error ?? '')
        const toolResultData = projectCliToolResultData({
          tool: event.tool,
          output: toolResultText,
          path: event.path,
          diffStats: event.diffStats,
          diffHunks: event.diffHunks,
          appliedReplacements: event.appliedReplacements,
          compacted: event.compacted,
          metadata: event.metadata,
          success: event.success,
        })
        const userMsg = createUserMessage([
          {
            type: 'tool_result',
            tool_use_id: event.partId,
            content: toolResultText,
            is_error: !event.success,
          } as { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean },
        ], {
          data: toolResultData,
          resultForAssistant: toolResultText,
        })
        consumed.push(userMsg)
        yield userMsg
        if (modeMessage) yield modeMessage
      } else if (event.type === 'error') {
        const am = createAssistantAPIErrorMessage(event.error)
        consumed.push(am)
        yield am
        if (event.fatal) return true
      } else if (event.type === 'done') {
        const completed = session.messages.find(
          (message) =>
            message.id === event.messageId &&
            message.role === 'assistant',
        )
        if (completed) {
          const am = buildAssistantMessageFromSession(completed)
          const nextConsumed = upsertTimelineMessage(consumed, am)
          consumed.splice(0, consumed.length, ...nextConsumed)
          yield am
        }
        onRunComplete?.(host)
        return true
      } else if (
        onSubagentEvent &&
        (event.type === 'subagent_start' ||
          event.type === 'subagent_tool_start' ||
          event.type === 'subagent_tool_end' ||
          event.type === 'subagent_done')
      ) {
        const parentPartId = (event as { parentPartId?: string }).parentPartId ?? lastSpawnAgentPartId
        if (parentPartId) {
          onSubagentEvent(parentPartId, event as SubagentEvent)
        }
      }
    }
    return false
  }

  while (!signal.aborted) {
    if (eventQueue[0] && isStreamingDraftEvent(eventQueue[0])) {
      await waitForStreamFrame(signal, STREAMING_UI_FLUSH_MS)
      if (signal.aborted) break
    }
    const gen = drainQueue()
    let result = gen.next()
    while (!result.done) {
      yield result.value as MessageType
      result = gen.next()
    }
    if (result.value === true) break

    if (runError) {
      yield createAssistantAPIErrorMessage((runError as Error).message)
      break
    }
    if (runSettled) break

    await waitForEventWake({
      signal,
      setWake: (wake) => {
        resolveNext = wake
      },
      hasQueuedEvent: () => eventQueue.length > 0,
    })
  }

  await runPromise
  if (serverUrl) {
    nexus.session = session
  }
}
