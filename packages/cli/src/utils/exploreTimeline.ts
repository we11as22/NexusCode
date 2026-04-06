/**
 * Split reordered messages into chronological pieces: plain rows vs one "code explore" wave.
 * Waves include Read/Grep/Glob/List/CodebaseSearch, pure-explore Parallel, and optional
 * glue rows (TodoWrite) + their tool_results so a list→todo→grep chain stays one block.
 */
import type { ProgressMessage } from '../query.js'
import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '../provider/message-schema.js'
import type { NormalizedMessage } from './messages.js'
import { getUnresolvedToolUseIDs, SYNTHETIC_ASSISTANT_MESSAGES } from './messages.js'
import {
  canonToolName,
  isExploreGlueToolName,
  isExploreToolName,
  parallelInputIsPureExplore,
} from './exploreTools.js'

export type ExploreSegmentState = {
  exploreIds: Set<string>
  glueIds: Set<string>
}

export type ChatTimelinePiece =
  | { kind: 'message'; message: NormalizedMessage }
  | {
      kind: 'explore'
      messages: NormalizedMessage[]
      /** A non-explore message follows this segment */
      closed: boolean
      /** Explore tool_use ids only (Parallel = one id) — used for loaders / Static policy */
      toolUseIds: Set<string>
      /**
       * When false, keep ● Exploring even if every tool in this segment already has a result:
       * the host may still be thinking or running a non-explore tool that has not finished yet.
       * Todo glue does not finalize the wave.
       */
      waveFinalized: boolean
      /**
       * True when this wave is the sub-agent’s Read/Grep/… sequence right after a SpawnAgent /
       * subagent-only Parallel row (skipping tool_result-only user rows). Render as sub-agent
       * UI, not generic host “Explored / N reads”.
       */
      subagentChild: boolean
      /** Spawn / subagent-Parallel `part_*` id when `subagentChild` */
      parentSpawnPartId?: string
    }

function registerExploreIdsFromToolUseBlock(block: ToolUseBlockParam): string[] {
  const input =
    typeof block.input === 'object' && block.input != null
      ? (block.input as Record<string, unknown>)
      : {}
  if (canonToolName(block.name) === 'parallel') {
    if (!parallelInputIsPureExplore(input)) return []
    return [block.id]
  }
  if (!isExploreToolName(block.name ?? '')) return []
  return [block.id]
}

/**
 * Append-only: extends `state` if `m` belongs to the current explore wave.
 * Explore user results must reference exploreIds ∪ glueIds.
 */
export function tryAppendToExploreSegment(
  m: NormalizedMessage,
  state: ExploreSegmentState,
): boolean {
  if (m.type === 'progress') {
    const blocks = m.content?.message?.content
    if (!Array.isArray(blocks)) return false
    let foundAny = false
    for (const block of blocks) {
      const t = (block as { type?: string }).type
      if (t === 'thinking' || t === 'redacted_thinking') continue
      if (t === 'text') continue
      if (t !== 'tool_use') return false
      const b = block as ToolUseBlockParam
      const exp = registerExploreIdsFromToolUseBlock(b)
      if (exp.length > 0) {
        for (const id of exp) state.exploreIds.add(id)
        foundAny = true
        continue
      }
      if (isExploreGlueToolName(b.name ?? '')) {
        state.glueIds.add(b.id)
        foundAny = true
        continue
      }
      return false
    }
    return foundAny
  }

  if (m.type === 'user') {
    const content = m.message.content
    if (typeof content === 'string') return false
    if (!Array.isArray(content)) return false
    for (const b of content) {
      if (b?.type === 'text') {
        const t = String((b as { text?: string }).text ?? '').trim()
        if (t.length > 0) return false
      }
    }
    const results = content.filter(
      (b): b is ToolResultBlockParam => b?.type === 'tool_result',
    )
    if (results.length === 0) return false
    for (const b of results) {
      if (
        !state.exploreIds.has(b.tool_use_id) &&
        !state.glueIds.has(b.tool_use_id)
      ) {
        return false
      }
    }
    return true
  }

  if (m.type === 'assistant') {
    const blocks = m.message.content
    if (!Array.isArray(blocks)) return false
    let foundAny = false
    for (const block of blocks) {
      const t = (block as { type?: string }).type
      if (t === 'thinking' || t === 'redacted_thinking') continue
      if (t === 'text') {
        const text = String((block as { text?: string }).text ?? '').trim()
        if (text.length > 0 && !SYNTHETIC_ASSISTANT_MESSAGES.has(text)) {
          return false
        }
        continue
      }
      if (t !== 'tool_use') return false
      const b = block as ToolUseBlockParam
      const exp = registerExploreIdsFromToolUseBlock(b)
      if (exp.length > 0) {
        for (const id of exp) state.exploreIds.add(id)
        foundAny = true
        continue
      }
      if (isExploreGlueToolName(b.name ?? '')) {
        state.glueIds.add(b.id)
        foundAny = true
        continue
      }
      return false
    }
    return foundAny
  }

  return false
}

function toolUseBlockIsPureExploreParallel(b: ToolUseBlockParam): boolean {
  if (canonToolName(b.name ?? '') !== 'parallel') return false
  const input =
    typeof b.input === 'object' && b.input != null
      ? (b.input as Record<string, unknown>)
      : {}
  return parallelInputIsPureExplore(input)
}

/** Progress / assistant row is part of an explore *wave* (not glue-only). */
function toolUseStartsExploreWave(b: ToolUseBlockParam): boolean {
  return (
    registerExploreIdsFromToolUseBlock(b).length > 0 ||
    toolUseBlockIsPureExploreParallel(b)
  )
}

function userMessageIsToolResultsOnly(m: NormalizedMessage): boolean {
  if (m.type !== 'user') return false
  const c = m.message.content
  if (typeof c === 'string') return false
  if (!Array.isArray(c)) return false
  const parts = c as { type?: string }[]
  if (parts.length === 0) return false
  return parts.every(b => b.type === 'tool_result')
}

type AssistantScan = 'neutral' | 'pending_non_explore' | 'finalized'

function scanAssistantAfterExploreWave(
  m: NormalizedMessage,
  unresolved: Set<string>,
): AssistantScan {
  if (m.type !== 'assistant') return 'neutral'
  const blocks = m.message.content
  if (!Array.isArray(blocks)) return 'neutral'
  let hasNonSyntheticText = false
  for (const block of blocks) {
    const t = (block as { type?: string }).type
    if (t === 'thinking' || t === 'redacted_thinking') continue
    if (t === 'text') {
      const text = String((block as { text?: string }).text ?? '').trim()
      if (text.length > 0 && !SYNTHETIC_ASSISTANT_MESSAGES.has(text)) {
        hasNonSyntheticText = true
      }
      continue
    }
    if (t !== 'tool_use') continue
    const b = block as ToolUseBlockParam
    if (isExploreGlueToolName(b.name ?? '')) continue
    if (isExploreToolName(b.name ?? '') || toolUseBlockIsPureExploreParallel(b)) {
      // Belongs to a later explore wave (this message ended the previous wave).
      return 'finalized'
    }
    if (unresolved.has(b.id)) return 'pending_non_explore'
    return 'finalized'
  }
  if (hasNonSyntheticText) return 'finalized'
  return 'neutral'
}

/**
 * True once something *outside* this explore wave has clearly finished or replaced it:
 * user text, tool_result for a non-wave tool, visible assistant text, a completed non-explore
 * tool_use, or the start of another explore wave. False while the transcript tail is still
 * only this wave or an in-flight non-explore tool (Spawn, Bash, …).
 */
export function exploreWaveVisuallyFinalized(
  ordered: NormalizedMessage[],
  segmentEndExclusive: number,
  unresolvedToolUseIDs: Set<string>,
): boolean {
  if (segmentEndExclusive >= ordered.length) return false

  for (let j = segmentEndExclusive; j < ordered.length; j++) {
    const m = ordered[j]!

    if (m.type === 'user') {
      if (userMessageIsToolResultsOnly(m)) return true
      return true
    }

    if (m.type === 'assistant') {
      const s = scanAssistantAfterExploreWave(m, unresolvedToolUseIDs)
      if (s === 'pending_non_explore') return false
      if (s === 'finalized') return true
      continue
    }

    if (m.type === 'progress') {
      const tu = firstToolUseFromProgress(m)
      if (!tu) continue
      const nm = tu.name ?? ''
      if (isExploreGlueToolName(nm)) continue
      if (toolUseStartsExploreWave(tu)) return true
      if (unresolvedToolUseIDs.has(m.toolUseID)) return false
      continue
    }
  }

  return false
}

/** Nexus: chronological list — plain messages interleaved with explore waves. */
export function buildChatTimeline(ordered: NormalizedMessage[]): ChatTimelinePiece[] {
  const out: ChatTimelinePiece[] = []
  let i = 0
  const unresolved = getUnresolvedToolUseIDs(ordered)

  while (i < ordered.length) {
    const state: ExploreSegmentState = {
      exploreIds: new Set<string>(),
      glueIds: new Set<string>(),
    }
    if (!tryAppendToExploreSegment(ordered[i]!, state)) {
      out.push({ kind: 'message', message: ordered[i]! })
      i++
      continue
    }
    if (state.exploreIds.size === 0) {
      out.push({ kind: 'message', message: ordered[i]! })
      i++
      continue
    }

    const segmentStart = i
    const segment: NormalizedMessage[] = [ordered[i]!]
    i++
    while (i < ordered.length) {
      if (!tryAppendToExploreSegment(ordered[i]!, state)) break
      segment.push(ordered[i]!)
      i++
    }

    const closed = i < ordered.length
    const waveFinalized = exploreWaveVisuallyFinalized(ordered, i, unresolved)
    const parentSpawnPartId = findSubagentParentPartIdForSegment(ordered, segmentStart)
    const subagentChild = parentSpawnPartId !== undefined
    out.push({
      kind: 'explore',
      messages: segment,
      closed,
      toolUseIds: new Set(state.exploreIds),
      waveFinalized,
      subagentChild,
      parentSpawnPartId,
    })
  }

  return out
}

export function exploreSegmentTouchesUnresolved(
  toolUseIds: Set<string>,
  unresolvedToolUseIDs: Set<string>,
): boolean {
  for (const id of toolUseIds) {
    if (unresolvedToolUseIDs.has(id)) return true
  }
  return false
}

/**
 * Explore rows must never land in Ink `<Static>`: any live update (tools, ctrl+o, model
 * still streaming) would freeze the subtree. Cost: these lines stay in the transient
 * region (acceptable for a small block count).
 */
export function exploreSegmentShouldBeTransient(
  _piece: Extract<ChatTimelinePiece, { kind: 'explore' }>,
  _unresolvedToolUseIDs: Set<string>,
  _inProgressToolUseIDs: Set<string>,
): boolean {
  return true
}

function isSpawnAgentRecipientName(raw: string): boolean {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'spawnagent' || normalized === 'spawnagents'
}

/** Parallel whose inner calls are only SpawnAgent-style (matches nexus-query). */
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

function isSubagentParentToolUse(block: ToolUseBlockParam): boolean {
  const c = canonToolName(block.name ?? '')
  if (c === 'spawnagent' || c === 'spawnagents' || c === 'spawnagentsparallel') {
    return true
  }
  if (c === 'parallel') {
    const input =
      typeof block.input === 'object' && block.input != null
        ? (block.input as Record<string, unknown>)
        : {}
    return isPureSubagentParallelInput(input)
  }
  return false
}

function firstToolUseFromProgress(m: NormalizedMessage): ToolUseBlockParam | undefined {
  if (m.type !== 'progress') return undefined
  const blocks = (m as ProgressMessage).content?.message?.content
  if (!Array.isArray(blocks)) return undefined
  const b = blocks.find(x => (x as { type?: string }).type === 'tool_use') as
    | ToolUseBlockParam
    | undefined
  return b
}

/** Nearest progress row before this segment: SpawnAgent / subagent-only Parallel (skipping tool_result-only users). */
export function findSubagentParentPartIdForSegment(
  ordered: NormalizedMessage[],
  segmentStartIndex: number,
): string | undefined {
  for (let j = segmentStartIndex - 1; j >= 0; j--) {
    const m = ordered[j]!
    if (m.type === 'user' && userMessageIsToolResultsOnly(m)) continue
    if (m.type !== 'progress') return undefined
    const tu = firstToolUseFromProgress(m)
    if (!tu) continue
    if (isSubagentParentToolUse(tu)) return tu.id
    return undefined
  }
  return undefined
}
