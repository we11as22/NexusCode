/**
 * Nexus agent query bridge: run runAgentLoop and stream REPL Message types.
 * Converts AgentEvent → UserMessage | AssistantMessage | ProgressMessage so the REPL can render.
 */
import { randomUUID } from 'node:crypto'
import type { SessionMessage, MessagePart, TextPart, ToolPart } from '@nexuscode/core'
import {
  runAgentLoop,
  createLLMClient,
  loadConfig,
  type AgentEvent,
  type ToolDef,
} from '@nexuscode/core'
import type { NexusBootstrapResult } from './nexus-bootstrap.js'
import type { SubagentEvent } from './nexus-subagents.js'
import { CliHost } from './host.js'
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
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ApprovalAction } from '@nexuscode/core'

export type NexusApprovalMessage = { type: 'nexus_approval'; action: ApprovalAction; partId: string }
/** Shown above input (e.g. "Compacting conversation..."). text empty clears. */
export type NexusBannerMessage = { type: 'nexus_banner'; text: string }
/** Todo list update from agent (TodoWrite tool). Rendered above input, below progress. */
export type NexusTodoMessage = { type: 'nexus_todo'; todo: string }

const TODO_TOOL_NAMES = new Set(['TodoWrite', 'update_todo_list'])
const SPAWN_AGENT_TOOL_NAMES = new Set(['SpawnAgent', 'SpawnAgents', 'SpawnAgentsParallel'])

function isSpawnAgentRecipientName(raw: string): boolean {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'spawnagent' || normalized === 'spawnagents'
}

function isPureSubagentParallelInput(input: unknown): boolean {
  if (input == null || typeof input !== 'object') return false
  const toolUses = (input as { tool_uses?: unknown }).tool_uses
  if (!Array.isArray(toolUses) || toolUses.length === 0) return false
  return toolUses.every((item) => {
    if (item == null || typeof item !== 'object') return false
    const recipientName = (item as { recipient_name?: unknown }).recipient_name
    return typeof recipientName === 'string' && isSpawnAgentRecipientName(recipientName)
  })
}

function shouldHideSubagentToolDisplay(toolName: string, input?: unknown): boolean {
  return (
    SPAWN_AGENT_TOOL_NAMES.has(toolName) ||
    toolName === 'SpawnAgentOutput' ||
    toolName === 'SpawnAgentStop' ||
    ((toolName === 'Parallel' || toolName === 'parallel') && isPureSubagentParallelInput(input))
  )
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
    if (content.trim()) blocks.push({ type: 'text', text: content, citations: [] })
    return blocks
  }
  const parts = content as MessagePart[]
  for (const p of parts) {
    if (p.type === 'text') {
      const tp = p as TextPart & { user_message?: string }
      const userMessage = tp.user_message?.trim()
      if (userMessage) {
        blocks.push({ type: 'text', text: userMessage, citations: [] })
      }
      const t = tp.text
      if (t?.trim()) blocks.push({ type: 'text', text: t, citations: [] })
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
  if (blocks.length === 0) blocks.push({ type: 'text', text: '', citations: [] })
  return blocks
}

function buildAssistantMessageFromSession(msg: SessionMessage): AssistantMessage {
  const content = sessionMessageToAssistantContent(msg)
  return {
    type: 'assistant',
    costUSD: 0,
    durationMs: 0,
    uuid: randomUUID(),
    message: {
      id: msg.id,
      model: '',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: '',
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content,
    },
  }
}

export interface QueryNexusOptions {
  nexus: NexusBootstrapResult
  userPrompt: string
  repoTools: Tool[]
  signal: AbortSignal
  tuiApprovalRef?: { current: ((r: { approved: boolean; alwaysApprove?: boolean; skipAll?: boolean; whatToDoInstead?: string; addToAllowedCommand?: string }) => void) | null }
  autoApprovePermissions?: Partial<AutoApprovePermissions>
  autoApprove?: boolean
  /** Override mode for this run (agent/plan/ask/debug/review). Defaults to nexus.mode. */
  modeOverride?: string
  /** When set, called for each subagent_* event; partId is the SpawnAgent tool_use id. */
  onSubagentEvent?: (partId: string, event: SubagentEvent) => void
  /** When set, called when a run completes with the host (for revert last turn /undo). */
  onRunComplete?: (host: import('./host.js').CliHost) => void
}

/**
 * Run the Nexus agent loop and yield REPL Message types.
 * Yields NexusApprovalMessage when tool_approval_needed so REPL can show the approval panel and resolve tuiApprovalRef.
 * Loads config from disk at start so that model/LLM settings saved in the CLI are applied.
 */
export async function* queryNexus(opts: QueryNexusOptions): AsyncGenerator<MessageType | NexusApprovalMessage | NexusBannerMessage | NexusTodoMessage, void> {
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
  } = opts
  const { session, mode: bootstrapMode, toolRegistry, rulesContent, skills, compaction, indexer } = nexus
  const mode = (modeOverride ?? bootstrapMode) as 'agent' | 'plan' | 'ask' | 'debug' | 'review'

  let config = await loadConfig(nexus.cwd, { secrets: nexus.secretsStore })
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

  const eventQueue: AgentEvent[] = []
  let resolveNext: (() => void) | null = null
  let runError: Error | null = null
  /** partId of the last tool_start(SpawnAgent); subagent_* events attach to this part. */
  let lastSpawnAgentPartId: string | null = null

  const allApprovalsEnabled =
    !!autoApprovePermissions &&
    autoApprovePermissions.read === true &&
    autoApprovePermissions.write === true &&
    autoApprovePermissions.execute === true &&
    autoApprovePermissions.mcp === true &&
    autoApprovePermissions.browser === true

  const host = new CliHost(nexus.cwd, (event: AgentEvent) => {
    eventQueue.push(event)
    if (resolveNext) {
      const fn = resolveNext
      resolveNext = null
      fn()
    }
  }, autoApprove || allApprovalsEnabled, tuiApprovalRef)

  /** Start of this run: previous turn’s edits become revertable for /undo. */
  host.startNewTurn()

  session.addMessage({ role: 'user', content: userPrompt })

  const client = createLLMClient(config.model)
  const { builtin, dynamic } = toolRegistry.getForMode(mode)
  const tools: ToolDef[] = [...builtin, ...dynamic]

  const runPromise = runAgentLoop({
    session,
    client,
    host,
    config,
    mode,
    tools,
    skills,
    rulesContent,
    indexer: indexer ?? undefined,
    compaction,
    signal,
  }).catch((err) => {
    runError = err instanceof Error ? err : new Error(String(err))
  })

  const consumed: MessageType[] = []

  function* drainQueue(): Generator<MessageType | NexusApprovalMessage | NexusBannerMessage | NexusTodoMessage, boolean, unknown> {
    while (eventQueue.length > 0) {
      const event = eventQueue.shift()!
      if (event.type === 'todo_updated') {
        yield { type: 'nexus_todo', todo: event.todo ?? '' }
        continue
      }
      if (event.type === 'compaction_start') {
        yield { type: 'nexus_banner', text: 'Compacting conversation…' }
        continue
      }
      if (event.type === 'compaction_end') {
        yield { type: 'nexus_banner', text: '' }
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
      if (event.type === 'assistant_content_complete') {
        const last = session.messages[session.messages.length - 1]
        if (last && last.role === 'assistant') {
          const am = buildAssistantMessageFromSession(last)
          consumed.push(am)
          yield am
        }
      } else if (event.type === 'tool_start') {
        if (TODO_TOOL_NAMES.has(event.tool)) continue
        if (SPAWN_AGENT_TOOL_NAMES.has(event.tool)) {
          lastSpawnAgentPartId = event.partId
        } else if ((event.tool === 'Parallel' || event.tool === 'parallel') && isPureSubagentParallelInput(event.input)) {
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
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [toolUseBlock],
          },
        }
        const pm = createProgressMessage(
          event.partId,
          new Set(),
          progressAssistantMessage,
          consumed.slice(),
          repoTools,
        )
        consumed.push(pm)
        yield pm
      } else if (event.type === 'tool_end') {
        if (TODO_TOOL_NAMES.has(event.tool)) continue
        if (SPAWN_AGENT_TOOL_NAMES.has(event.tool)) lastSpawnAgentPartId = null
        if (shouldHideSubagentToolDisplay(event.tool)) continue
        const toolResultText = event.output ?? (event.error ?? '')
        const toolResultData = {
          tool: event.tool,
          output: toolResultText,
          path: event.path,
          diffStats: event.diffStats,
          diffHunks: event.diffHunks,
          compacted: event.compacted,
          writtenContent: event.writtenContent,
          metadata: event.metadata,
          success: event.success,
        }
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
      } else if (event.type === 'error') {
        const am = createAssistantAPIErrorMessage(event.error)
        consumed.push(am)
        yield am
        if (event.fatal) return true
      } else if (event.type === 'done') {
        host.startNewTurn()
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
    const gen = drainQueue()
    let result = gen.next()
    while (!result.done) {
      yield result.value as MessageType
      result = gen.next()
    }
    if (result.value === true) break

    if (runError) {
      yield createAssistantAPIErrorMessage(runError.message)
      break
    }

    await new Promise<void>((resolve) => {
      resolveNext = resolve
      if (eventQueue.length > 0) {
        resolveNext = null
        resolve()
      }
      signal.addEventListener('abort', () => {
        if (resolveNext) {
          resolveNext = null
          resolve()
        }
      }, { once: true })
    })
  }

  await runPromise
}
