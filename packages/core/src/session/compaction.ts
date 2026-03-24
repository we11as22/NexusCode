import type { ISession, SessionMessage, ToolPart, MessagePart } from "../types.js"
import type { LLMClient } from "../provider/index.js"
import { estimateTokens } from "../context/condense.js"
import { getActiveMessagesAfterLatestSummary, getLatestSummaryMessage } from "./active-context.js"

// Minimum tokens to bother pruning
const PRUNE_MINIMUM = 10_000
// Keep at least this many tokens of recent tool output (don't prune)
const PRUNE_PROTECT = 30_000
// Tools whose output should never be pruned (keep completion, plan exit, key context).
// read_file is NOT protected so old file reads can be pruned when context is full (agent reads quickly fill context).
const PRUNE_PROTECTED_TOOLS = new Set([
  "use_skill",
  "codebase_search",
  "PlanExit",
  "AskFollowupQuestion",
  "TodoWrite",
])

const COMPACTION_BUFFER = 20_000

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

  if (pruned >= PRUNE_MINIMUM) {
    for (const part of toPrune) {
      session.updateToolPart(
        part.messageId,
        part.partId,
        { compacted: true, output: "[output pruned for context efficiency]" }
      )
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
    const llmMessages = buildLLMMessages(recentMessages)
    if (previousSummaryText) {
      llmMessages.unshift({
        role: "user",
        content: `<previous_conversation_summary>\n${previousSummaryText}\n</previous_conversation_summary>`,
      })
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
          return rp.text?.trim() ? `[Thinking: ${rp.text.slice(0, 500)}]` : ""
        }
        if (p.type === "image") return "" // images not included in compaction summary
        if (p.type === "text") {
          const t = p as { text: string; user_message?: string }
          const um = t.user_message?.trim()
          return um ? um + "\n" + t.text : t.text
        }
        if (p.type === "tool") {
          const tp = p as ToolPart
          if (tp.compacted) return `[${tp.tool}: output pruned]`
          return `[${tp.tool}: ${(tp.output ?? "").slice(0, 300)}]`
        }
        return ""
      }).filter(Boolean).join("\n")
    }
    if (text.trim()) result.push({ role: m.role as "user" | "assistant", content: text })
  }
  return result
}

