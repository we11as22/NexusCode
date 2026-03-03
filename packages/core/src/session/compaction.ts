import type { ISession, SessionMessage, ToolPart, MessagePart } from "../types.js"
import type { LLMClient } from "../provider/index.js"
import { estimateTokens } from "../context/condense.js"

// Minimum tokens to bother pruning
const PRUNE_MINIMUM = 10_000
// Keep at least this many tokens of recent tool output (don't prune)
const PRUNE_PROTECT = 30_000
// Tools whose output should never be pruned (Cline/OpenCode-style: keep completion, plan exit, key context).
// read_file is NOT protected so old file reads can be pruned when context is full (agent reads quickly fill context).
const PRUNE_PROTECTED_TOOLS = new Set([
  "use_skill",
  "codebase_search",
  "attempt_completion",
  "plan_exit",
  "ask_followup_question",
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
  const toPrune: ToolPart[] = []

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
        toPrune.push(tp)
      }
    }
  }

  if (pruned >= PRUNE_MINIMUM) {
    for (const part of toPrune) {
      session.updateToolPart(
        findMessageIdForPart(session, part.id) ?? "",
        part.id,
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
  const messages = session.messages.filter(m => !m.summary)
  if (messages.length < 4) return

  const conversationText = buildConversationText(messages)

  const compactPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the work, including what we did,
what we're doing, which files we're working on, and what we're going to do next.

Use this template:

---
## Goal
[What goal(s) is the user trying to accomplish?]

## Instructions
[Important instructions from the user relevant to the work. Include any plan or spec.]

## Discoveries
[Notable things learned about the codebase that would be useful to know when continuing]

## Accomplished
[What work has been completed, what's in progress, and what's left to do]

## Code Changes
[Files created/modified/deleted with brief description]
- \`path/to/file.ts\` — Added X, modified Y

## Relevant Files / Directories
[Structured list of files relevant to the current task]
---`

  let summaryText = ""
  try {
    for await (const event of client.stream({
      messages: [
        ...buildLLMMessages(messages),
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
    console.warn("[nexus] Compaction LLM call failed:", err)
    return
  }

  if (!summaryText.trim()) return

  // Add summary message
  session.addMessage({
    role: "assistant",
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
        if (p.type === "text") return p.text
        if (p.type === "tool") {
          const tp = p as ToolPart
          if (tp.compacted) return `[${tp.tool}: output pruned]`
          if (tp.tool === "thinking_preamble") {
            const reasoning = (tp.input?.reasoning_and_next_actions as string)?.trim()
            const msg = (tp.input?.user_message as string)?.trim()
            if (reasoning) return `[thinking_preamble: ${reasoning.slice(0, 200)}]`
            if (msg) return `[thinking_preamble (user): ${msg.slice(0, 100)}]`
            return `[${tp.tool}: ${(tp.output ?? "").slice(0, 100)}]`
          }
          return `[${tp.tool}: ${(tp.output ?? "").slice(0, 300)}]`
        }
        return ""
      }).join("\n")
    }
    if (text.trim()) result.push({ role: m.role as "user" | "assistant", content: text })
  }
  return result
}

function findMessageIdForPart(session: ISession, partId: string): string | undefined {
  for (const msg of session.messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as MessagePart[]) {
      if (part.type === "tool" && (part as ToolPart).id === partId) {
        return msg.id
      }
    }
  }
  return undefined
}
