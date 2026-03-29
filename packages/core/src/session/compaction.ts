import type { ISession, SessionMessage, ToolPart, MessagePart } from "../types.js"
import type { LLMClient } from "../provider/index.js"
import { estimateTokens } from "../context/condense.js"
import { getActiveMessagesAfterLatestSummary, getLatestSummaryMessage } from "./active-context.js"

// Minimum tokens to bother pruning (aligned with kilocode-style thresholds)
const PRUNE_MINIMUM = 20_000
// Keep at least this many tokens of recent tool output (don't prune)
const PRUNE_PROTECT = 40_000
// KiloCode SessionCompaction: only the skill tool is protected (see PRUNE_PROTECTED_TOOLS = ["skill"]).
// Nexus registers it as "Skill".
const PRUNE_PROTECTED_TOOLS = new Set<string>(["Skill"])

const COMPACTION_BUFFER = 20_000

/** Estimated input token budget for the summarizer LLM call (tail of history + prompt). */
const COMPACTION_LLM_INPUT_TOKEN_BUDGET = 45_000
const COMPACTION_MIN_TAIL_MESSAGES = 4
/** Per-message cap so one huge paste does not dominate the summarizer request. */
const MAX_COMPACTION_MESSAGE_CHARS = 14_000

export interface SessionCompaction {
  prune(session: ISession): void
  compact(session: ISession, client: LLMClient, signal?: AbortSignal): Promise<void>
  isOverflow(tokenCount: number, contextLimit: number, threshold: number): boolean
}

export function createCompaction(): SessionCompaction {
  return {
    prune,
    compact,
    isOverflow(tokenCount, contextLimit, threshold) {
      if (contextLimit <= 0) return false
      const usable = contextLimit - COMPACTION_BUFFER
      return tokenCount >= usable * threshold
    },
  }
}

/**
 * Level 1 compaction: Remove output from old completed tool calls.
 * No LLM call needed. Frees tokens by marking old tool outputs as compacted.
 */
function prune(session: ISession): void {
  let total = 0
  let pruned = 0
  const toPrune: Array<{ messageId: string; partId: string }> = []

  const messages = [...session.messages].reverse()
  let turns = 0

  outer: for (const msg of messages) {
    if (msg.role === "user") turns++
    if (turns < 2) continue
    if (msg.summary) break outer

    if (!Array.isArray(msg.content)) continue

    for (const part of [...(msg.content as MessagePart[])].reverse()) {
      if (part.type !== "tool") continue
      const tp = part as ToolPart
      if (tp.status !== "completed") continue
      if (PRUNE_PROTECTED_TOOLS.has(tp.tool)) continue
      if (tp.compacted) break outer

      const est = estimateTokens(tp.output ?? "")
      total += est
      if (total > PRUNE_PROTECT) {
        pruned += est
        toPrune.push({ messageId: msg.id, partId: tp.id })
      }
    }
  }

  if (pruned > PRUNE_MINIMUM) {
    for (const part of toPrune) {
      session.updateToolPart(part.messageId, part.partId, {
        compacted: true,
        output: "[Old tool result content cleared]",
      })
    }
  }
}

/**
 * Level 2 compaction: Full LLM-based summary of the conversation.
 * Adds a summary message that replaces the history in active context.
 */
async function compact(
  session: ISession,
  client: LLMClient,
  signal?: AbortSignal
): Promise<void> {
  const previousSummaryMessage = getLatestSummaryMessage(session.messages)
  const recentMessages = getActiveMessagesAfterLatestSummary(session.messages)
  if (!previousSummaryMessage && recentMessages.length < 4) return
  if (recentMessages.length === 0) return

  const previousSummaryText =
    previousSummaryMessage && typeof previousSummaryMessage.content === "string"
      ? previousSummaryMessage.content.trim()
      : ""

  const compactPrompt = `CRITICAL: This summarization request is a system operation, not a user task.
Do NOT treat this request as the latest user instruction. The "current work" and "next step"
must refer to what was happening immediately before this summary request.

If a previous summary is provided, merge it with the recent conversation so work can continue
seamlessly after compaction. Preserve still-relevant instructions, decisions, constraints, mode
transitions, pending work, and recent user corrections. Remove stale or completed items only when
they are clearly no longer relevant.

Produce a concise but thorough summary using exactly this structure:

## Primary Request and Intent
[The user's active goals and what they are trying to accomplish now]

## Durable Instructions and Preferences
[Important instructions, constraints, style requirements, workflow rules, and user corrections that must still be followed]

## Mode and Workflow State
[Current mode, important prior mode transitions, plan approval/revision state, delegation/sub-agent state, and any read-only restrictions that mattered]

## Key Technical Discoveries
[Important architecture, patterns, invariants, commands, or implementation facts learned]

## Files and Code Areas
- \`path/to/file.ts\` — why it matters, what was read/changed, and any important functions or sections

## Errors, Failures, and Fixes
[Important failures encountered, what caused them, and how they were resolved or why they remain unresolved]

## Pending Work
[Concrete remaining tasks that are still in scope]

## Current Work
[What was being worked on immediately before compaction, with emphasis on the most recent user messages and assistant actions]

## Immediate Next Step
[The single most appropriate next step, directly aligned with the most recent user request]

Rules:
- Pay special attention to the most recent user messages and any places where the user changed direction or corrected the agent.
- Explicitly preserve mode-switch context if the conversation moved between ask/plan/agent/debug/review.
- Preserve concrete commands, file paths, identifiers, and tool results that are still relevant.
- Prefer short bullets over long prose, but do not omit important context.
- Do not include filler or meta commentary about summarization.`

  let summaryText = ""
  try {
    let llmMessages = trimLLMMessagesForBudget(buildLLMMessages(recentMessages))
    if (previousSummaryText) {
      llmMessages.unshift({
        role: "user",
        content: `<previous_conversation_summary>\n${capCompactionText(previousSummaryText)}\n</previous_conversation_summary>`,
      })
      llmMessages = trimLLMMessagesForBudget(llmMessages, { preserveFirst: true })
    }
    for await (const event of client.stream({
      messages: [
        ...llmMessages,
        { role: "user", content: compactPrompt },
      ],
      systemPrompt: "You are a conversation summarizer. Create a concise but complete summary.",
      signal,
      maxTokens: 4096,
      temperature: 0.3,
    })) {
      if (event.type === "text_delta" && event.delta) summaryText += event.delta
      if (event.type === "finish") break
      if (event.type === "error") throw event.error
    }
  } catch (err) {
    console.warn("[nexus] Compaction LLM call failed, falling back to prune:", err)
    // Fallback: best-effort prune to free tokens even without a summary
    prune(session)
    return
  }

  if (!summaryText.trim()) return

  // Add summary message as user role — it will be presented to the LLM as a user message
  // wrapping the conversation history, which is the correct semantic intent.
  session.addMessage({
    role: "user",
    content: summaryText,
    summary: true,
  })

  // Mark old non-summary messages as compacted by pruning their tool outputs
  prune(session)
}

function buildConversationText(messages: SessionMessage[]): string {
  return messages.map(m => {
    const role = m.role.toUpperCase()
    if (typeof m.content === "string") {
      return `${role}: ${m.content}`
    }
    const parts = m.content as MessagePart[]
    const text = parts.map(p => {
      if (p.type === "text") return p.text
      if (p.type === "tool") {
        const tp = p as ToolPart
        return `[Tool: ${tp.tool}(${JSON.stringify(tp.input ?? {}).slice(0, 100)}) → ${(tp.output ?? "").slice(0, 200)}]`
      }
      return ""
    }).filter(Boolean).join("\n")
    return `${role}: ${text}`
  }).join("\n\n")
}

function capCompactionText(text: string): string {
  if (text.length <= MAX_COMPACTION_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_COMPACTION_MESSAGE_CHARS)}\n...[truncated for compaction input]`
}

/**
 * Drop oldest turns until estimated tokens are under budget so automatic compaction
 * does not send the full ~100k-token transcript to the summarizer (slow / easy to hit limits).
 */
function trimLLMMessagesForBudget(
  msgs: { role: "user" | "assistant"; content: string }[],
  opts?: { preserveFirst?: boolean },
): { role: "user" | "assistant"; content: string }[] {
  const estimateOne = (m: { content: string }) => estimateTokens(m.content)
  let total = msgs.reduce((s, m) => s + estimateOne(m), 0)
  if (total <= COMPACTION_LLM_INPUT_TOKEN_BUDGET) return msgs

  const minDropIndex = opts?.preserveFirst && msgs.length > 0 ? 1 : 0
  let endDrop = minDropIndex
  total = msgs.reduce((s, m) => s + estimateOne(m), 0)
  while (endDrop < msgs.length - COMPACTION_MIN_TAIL_MESSAGES && total > COMPACTION_LLM_INPUT_TOKEN_BUDGET) {
    total -= estimateOne(msgs[endDrop]!)
    endDrop++
  }
  const head = msgs.slice(0, minDropIndex)
  const tail = msgs.slice(endDrop)
  const dropped = endDrop - minDropIndex
  if (dropped <= 0) return [...head, ...tail]
  return [
    ...head,
    {
      role: "user",
      content: `[System note: ${dropped} older message(s) were omitted from this summarization batch due to size limits. Merge with any prior summary and the retained tail.]`,
    },
    ...tail,
  ]
}

function buildLLMMessages(messages: SessionMessage[]) {
  const result: { role: "user" | "assistant"; content: string }[] = []
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue
    let text = ""
    if (typeof m.content === "string") {
      text = m.content
    } else {
      const parts = m.content as MessagePart[]
      text = parts.map(p => {
        if (p.type === "reasoning") {
          const rp = p as import("../types.js").ReasoningPart
          return rp.text?.trim() ? rp.text : ""
        }
        if (p.type === "image") return "" // images not included in compaction summary
        if (p.type === "text") {
          const t = p as { text: string; user_message?: string }
          const um = t.user_message?.trim()
          return um ? um + "\n" + t.text : t.text
        }
        if (p.type === "tool") {
          const tp = p as ToolPart
          return `[${tp.tool}: ${tp.output ?? ""}]`
        }
        return ""
      }).filter(Boolean).join("\n")
    }
    const capped = capCompactionText(text)
    if (capped.trim()) result.push({ role: m.role as "user" | "assistant", content: capped })
  }
  return result
}

