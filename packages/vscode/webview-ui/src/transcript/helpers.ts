import type { Mode, MessagePart, ReasoningPart, SessionMessage, SubAgentState, TextPart, ToolPart } from "../stores/chat.js"

export const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

const RECENT_EVENT_FINGERPRINTS_MAX = 800
const recentEventFingerprints = new Set<string>()
const recentEventFingerprintQueue: string[] = []

export function seenRecently(fingerprint: string): boolean {
  if (recentEventFingerprints.has(fingerprint)) return true
  recentEventFingerprints.add(fingerprint)
  recentEventFingerprintQueue.push(fingerprint)
  if (recentEventFingerprintQueue.length > RECENT_EVENT_FINGERPRINTS_MAX) {
    const oldest = recentEventFingerprintQueue.shift()
    if (oldest) recentEventFingerprints.delete(oldest)
  }
  return false
}

export function shortenSubagentValue(value: unknown, max = 52): string {
  if (typeof value !== "string") return ""
  const one = value.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

export function getSubagentToolLabel(tool: string, input?: Record<string, unknown>): string {
  const path = shortenSubagentValue(input?.path ?? input?.file_path)
  const pattern = shortenSubagentValue(input?.pattern ?? input?.query)
  const command = shortenSubagentValue(input?.command, 44)
  const normalized = tool.trim()
  if (normalized === "Read" || normalized === "read_file") return path ? `Read(${path})` : "Read(file)"
  if (normalized === "List" || normalized === "list_dir") return path ? `List(${path})` : "List(.)"
  if (normalized === "Grep" || normalized === "grep") return pattern ? `Grep(${pattern})` : "Grep"
  if (normalized === "Glob" || normalized === "glob") return pattern ? `Glob(${pattern})` : "Glob"
  if (normalized === "Bash" || normalized === "execute_command") return command ? `Bash(${command})` : "Bash"
  return normalized
}

export function reduceSubagentState(
  list: SubAgentState[],
  event:
    | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
    | { type: "subagent_tool_start"; subagentId: string; tool: string; input?: Record<string, unknown> }
    | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
    | { type: "subagent_done"; subagentId: string; success: boolean; error?: string },
): SubAgentState[] {
  switch (event.type) {
    case "subagent_start": {
      const next = list.filter((item) => item.id !== event.subagentId)
      next.push({
        id: event.subagentId,
        mode: event.mode,
        task: event.task,
        status: "running",
        currentTool: undefined,
        toolHistory: [],
        toolUsesCount: 0,
        startedAt: Date.now(),
      })
      return next
    }
    case "subagent_tool_start": {
      const label = getSubagentToolLabel(event.tool, event.input)
      return list.map((item) =>
        item.id === event.subagentId
          ? {
              ...item,
              status: "running" as const,
              currentTool: label,
              toolUsesCount: item.toolUsesCount + 1,
              toolHistory: [...item.toolHistory, label].slice(-16),
            }
          : item,
      )
    }
    case "subagent_tool_end":
      return list.map((item) =>
        item.id === event.subagentId
          ? {
              ...item,
              status: (event.success ? "running" : "error") as "running" | "error",
              currentTool: event.success ? undefined : event.tool,
            }
          : item,
      )
    case "subagent_done":
      return list.map((item) =>
        item.id === event.subagentId
          ? {
              ...item,
              status: (event.success ? "completed" : "error") as "completed" | "error",
              currentTool: undefined,
              finishedAt: Date.now(),
              error: event.error,
            }
          : item,
      )
  }
}

export function findToolPartIndexForSubagent(parts: MessagePart[], subagentId: string, parentPartId?: string | null): number {
  const byExistingSubagent = parts.findIndex(
    (part) => part.type === "tool" && (part as ToolPart).subagents?.some((subagent) => subagent.id === subagentId),
  )
  if (byExistingSubagent >= 0) return byExistingSubagent
  if (parentPartId && parentPartId.trim().length > 0) {
    return parts.findIndex((part) => part.type === "tool" && (part as ToolPart).id === parentPartId)
  }
  return -1
}

export function findOpenReasoningReverseIndex(parts: MessagePart[], reasoningId: string): number {
  return [...parts].reverse().findIndex(
    (p) =>
      p.type === "reasoning" &&
      (p as ReasoningPart).durationMs == null &&
      ((p as ReasoningPart).reasoningId ?? "reasoning-0") === reasoningId,
  )
}

export function ensureAssistantMessage(messages: SessionMessage[], messageId?: string): { list: SessionMessage[]; index: number } {
  const id = messageId || `msg_${Date.now()}`
  const idx = messages.findIndex((m) => m.id === id && m.role === "assistant")
  if (idx >= 0) {
    return { list: [...messages], index: idx }
  }

  const lastIdx = messages.length - 1
  if (lastIdx >= 0 && messages[lastIdx]?.role === "assistant") {
    const existing = messages[lastIdx]!
    if (existing.id !== id) {
      return {
        list: [...messages.slice(0, lastIdx), { ...existing, id }],
        index: lastIdx,
      }
    }
    return { list: [...messages], index: lastIdx }
  }

  const list: SessionMessage[] = [
    ...messages,
    {
      id,
      ts: Date.now(),
      role: "assistant",
      content: "",
    },
  ]
  return { list, index: list.length - 1 }
}

function hasAssistantContent(content: string | MessagePart[]): boolean {
  if (typeof content === "string") return content.trim().length > 0
  const parts = content as MessagePart[]
  return parts.some(
    (p) =>
      (p.type === "text" && (((p as TextPart).text?.trim().length ?? 0) > 0 || ((p as TextPart).user_message?.trim().length ?? 0) > 0)) ||
      (p.type === "reasoning" &&
        ((p as ReasoningPart).text?.trim().length ?? 0) > 0 &&
        (p as ReasoningPart).text !== THOUGHT_PLACEHOLDER) ||
      p.type === "tool",
  )
}

function messageTextContent(message: SessionMessage): string {
  if (typeof message.content === "string") return message.content.trim()
  return (
    (message.content as MessagePart[])
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => `${part.text ?? ""}\n${part.user_message ?? ""}`)
      .join("\n")
      .trim()
  )
}

function mergeOptimisticUserMessages(previous: SessionMessage[], incoming: SessionMessage[]): SessionMessage[] {
  const merged = [...incoming]
  return merged.map((message) => {
    if (message.role !== "user") return message
    const text = messageTextContent(message)
    const optimistic = previous.find(
      (candidate) =>
        candidate.role === "user" &&
        candidate.id.startsWith("local_user_") &&
        messageTextContent(candidate) === text,
    )
    if (!optimistic) return message
    return {
      ...message,
      id: optimistic.id,
      ts: optimistic.ts,
      content: optimistic.content,
    }
  })
}

function assistantPartSignature(part: MessagePart): string {
  if (part.type === "text") {
    const textPart = part as TextPart
    return JSON.stringify({
      type: "text",
      text: textPart.text ?? "",
      user_message: textPart.user_message ?? "",
    })
  }
  if (part.type === "reasoning") {
    const reasoning = part as ReasoningPart
    return JSON.stringify({
      type: "reasoning",
      text: reasoning.text ?? "",
      reasoningId: reasoning.reasoningId ?? "",
    })
  }
  const tool = part as ToolPart
  return JSON.stringify({
    type: "tool",
    id: tool.id,
    tool: tool.tool,
    status: tool.status,
    path: tool.path ?? "",
    input: tool.input ?? null,
    output: tool.output ?? "",
    error: tool.error ?? "",
    diffStats: tool.diffStats ?? null,
  })
}

function dedupeGlobalDuplicateReasoningText(parts: MessagePart[]): MessagePart[] {
  const seen = new Set<string>()
  const out: MessagePart[] = []
  for (const part of parts) {
    if (part.type !== "reasoning") {
      out.push(part)
      continue
    }
    const r = part as ReasoningPart
    const t = (r.text ?? "").trim()
    if (t === "" || t === THOUGHT_PLACEHOLDER) {
      out.push(part)
      continue
    }
    if (seen.has(t)) continue
    seen.add(t)
    out.push(part)
  }
  return out
}

function dedupeAssistantParts(parts: MessagePart[]): MessagePart[] {
  const deduped: MessagePart[] = []
  for (const part of parts) {
    const previous = deduped[deduped.length - 1]
    if (part.type === "reasoning" && previous?.type === "reasoning") {
      const a = previous as ReasoningPart
      const b = part as ReasoningPart
      const at = (a.text ?? "").trim()
      const bt = (b.text ?? "").trim()
      if (at !== "" && at !== THOUGHT_PLACEHOLDER && at === bt) {
        deduped[deduped.length - 1] = {
          ...a,
          ...b,
          text: bt || at,
          reasoningId: a.reasoningId || b.reasoningId,
          durationMs: b.durationMs ?? a.durationMs,
          providerMetadata: b.providerMetadata ?? a.providerMetadata,
        } as ReasoningPart
        continue
      }
    }
    if (previous && assistantPartSignature(previous) === assistantPartSignature(part)) {
      deduped[deduped.length - 1] = part
      continue
    }
    deduped.push(part)
  }
  return dedupeGlobalDuplicateReasoningText(deduped)
}

function mergeAssistantContent(previous: string | MessagePart[], incoming: string | MessagePart[]): string | MessagePart[] {
  if (!hasAssistantContent(incoming) && hasAssistantContent(previous)) {
    return previous
  }
  if (!Array.isArray(previous) || !Array.isArray(incoming)) {
    return incoming
  }

  const previousParts = previous as MessagePart[]
  const incomingParts = incoming as MessagePart[]
  const previousReasoning = previousParts.filter((p): p is ReasoningPart => p.type === "reasoning")
  const incomingReasoning = incomingParts.filter((p): p is ReasoningPart => p.type === "reasoning")

  if (previousReasoning.length === 0) return incoming
  if (incomingReasoning.length === 0) {
    return dedupeAssistantParts([...previousReasoning, ...incomingParts])
  }

  const prevText = previousReasoning.map((r) => r.text ?? "").join("").trim()
  const inText = incomingReasoning.map((r) => r.text ?? "").join("").trim()
  const incomingHasOnlyPlaceholder =
    inText.length > 0 &&
    inText === THOUGHT_PLACEHOLDER &&
    prevText.length > 0 &&
    prevText !== THOUGHT_PLACEHOLDER

  if (incomingHasOnlyPlaceholder) {
    const withoutIncomingReasoning = incomingParts.filter((p) => p.type !== "reasoning")
    const incomingHasVisibleText = withoutIncomingReasoning.some(
      (p) =>
        p.type === "text" &&
        ((((p as TextPart).text ?? "").trim().length > 0 && (p as TextPart).text !== THOUGHT_PLACEHOLDER) ||
          (((p as TextPart).user_message ?? "").trim().length > 0)),
    )
    if (incomingHasVisibleText) {
      return dedupeAssistantParts([...previousReasoning, ...withoutIncomingReasoning])
    }
    const previousVisibleTextParts = previousParts.filter(
      (p) =>
        p.type === "text" &&
        ((((p as TextPart).text ?? "").trim().length > 0 && (p as TextPart).text !== THOUGHT_PLACEHOLDER) ||
          (((p as TextPart).user_message ?? "").trim().length > 0)),
    )
    const incomingNonText = withoutIncomingReasoning.filter((p) => p.type !== "text")
    return dedupeAssistantParts([...previousReasoning, ...previousVisibleTextParts, ...incomingNonText])
  }

  return dedupeAssistantParts(incoming)
}

function assistantMessageSignature(message: SessionMessage): string {
  if (typeof message.content === "string") return `assistant:string:${message.content.trim()}`
  return JSON.stringify(
    (message.content as MessagePart[]).map((part) => {
      if (part.type === "text") {
        const textPart = part as TextPart
        return {
          type: "text",
          text: textPart.text ?? "",
          user_message: textPart.user_message ?? "",
        }
      }
      if (part.type === "reasoning") {
        const reasoning = part as ReasoningPart
        return {
          type: "reasoning",
          text: reasoning.text ?? "",
          durationMs: reasoning.durationMs ?? 0,
          reasoningId: reasoning.reasoningId ?? "",
        }
      }
      const tool = part as ToolPart
      return {
        type: "tool",
        id: tool.id,
        tool: tool.tool,
        status: tool.status,
        input: tool.input ?? null,
        output: tool.output ?? "",
        error: tool.error ?? "",
        subagents:
          tool.subagents?.map((subagent) => ({
            id: subagent.id,
            task: subagent.task,
            status: subagent.status,
            currentTool: subagent.currentTool ?? "",
            toolUsesCount: subagent.toolUsesCount,
          })) ?? [],
      }
    }),
  )
}

function collapseAdjacentDuplicateMessages(messages: SessionMessage[]): SessionMessage[] {
  const collapsed: SessionMessage[] = []
  for (const message of messages) {
    const previous = collapsed[collapsed.length - 1]
    if (
      previous &&
      previous.role === "assistant" &&
      message.role === "assistant" &&
      assistantMessageSignature(previous) === assistantMessageSignature(message)
    ) {
      collapsed[collapsed.length - 1] = {
        ...message,
        id: message.id,
        ts: Math.max(previous.ts, message.ts),
      }
      continue
    }
    collapsed.push(message)
  }
  return collapsed
}

export function mergeStateMessagesForStream(previous: SessionMessage[], incoming: SessionMessage[]): SessionMessage[] {
  if (incoming.length === 0) return previous
  if (previous.length === 0) return incoming

  const merged = mergeOptimisticUserMessages(previous, incoming)
  const lastIncoming = merged[merged.length - 1]
  const lastPrevious = previous[previous.length - 1]

  if (lastIncoming?.role === "assistant" && lastPrevious?.role === "assistant" && lastIncoming.id === lastPrevious.id) {
    const mergedContent = mergeAssistantContent(lastPrevious.content, lastIncoming.content)
    if (mergedContent !== lastIncoming.content) {
      merged[merged.length - 1] = { ...lastIncoming, content: mergedContent }
    }
  } else if (
    lastIncoming?.role === "assistant" &&
    lastPrevious?.role === "assistant" &&
    !hasAssistantContent(lastIncoming.content) &&
    hasAssistantContent(lastPrevious.content)
  ) {
    merged[merged.length - 1] = { ...lastIncoming, content: lastPrevious.content }
  }

  if (incoming.length < previous.length) {
    const isIncomingPrefix = incoming.every((message, index) => previous[index]?.id === message.id)
    if (isIncomingPrefix) {
      const trailingPrevious = previous.slice(incoming.length)
      const hasVisibleTail = trailingPrevious.some((message) => {
        if (message.role === "assistant") return hasAssistantContent(message.content)
        if (message.role === "user") return message.id.startsWith("local_user_")
        return true
      })
      if (hasVisibleTail) {
        return [...merged, ...trailingPrevious]
      }
    }
  }

  const optimisticUsersToKeep = previous.filter(
    (message) =>
      message.role === "user" &&
      message.id.startsWith("local_user_") &&
      !merged.some(
        (incomingMessage) => incomingMessage.role === "user" && messageTextContent(incomingMessage) === messageTextContent(message),
      ),
  )
  if (optimisticUsersToKeep.length > 0) {
    return collapseAdjacentDuplicateMessages([...merged, ...optimisticUsersToKeep])
  }

  return collapseAdjacentDuplicateMessages(merged)
}

function stripToolCallMarkup(value: string): string {
  if (!value) return value
  return value
    .replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[^>]+>/gi, "")
    .replace(/<\/function>/gi, "")
    .replace(/<parameter=[^>]+>/gi, "")
    .replace(/<\/parameter>/gi, "")
    .trim()
}

export function sanitizeAssistantText(value: string): string {
  return stripToolCallMarkup(value)
    .replace(/<tool_call[^>]*>/gi, "")
    .replace(/<\/tool_call>/gi, "")
    .replace(/<function=[^>]*>/gi, "")
    .replace(/<\/function>/gi, "")
    .replace(/<parameter=[^>]*>/gi, "")
    .replace(/<\/parameter>/gi, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (t === "<" || t === ">" || t === "</" || t === "/>") return false
      if (t.startsWith("<") && /(tool_call|function|parameter)/i.test(t)) return false
      return true
    })
    .join("\n")
    .trim()
}

export function isDelegatedAgentTool(tool: string, input?: Record<string, unknown>): boolean {
  if (tool === "TaskCreateBatch" || tool === "SpawnAgent" || tool === "SpawnAgents" || tool === "SpawnAgentsParallel") return true
  if (tool === "TaskCreate") {
    const kind = typeof input?.kind === "string" ? input.kind : "tracking"
    return kind === "agent"
  }
  return false
}

// ── Subagent parent detection (keep in sync with @nexuscode/core subagent-parent-ui.ts) ──

function canonParallelInnerRecipient(raw: string): string {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const prefix = prefixes.find((p) => lower.startsWith(p))
  const base = prefix ? trimmed.slice(prefix.length) : trimmed
  return base.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function parallelInnerUseIsDelegatedAgent(use: {
  recipient_name?: unknown
  parameters?: unknown
}): boolean {
  if (typeof use.recipient_name !== "string") return false
  const n = canonParallelInnerRecipient(use.recipient_name)
  if (n === "spawnagent" || n === "spawnagents") return true
  if (n !== "taskcreate") return false
  if (use.parameters == null || typeof use.parameters !== "object") return false
  const kind = (use.parameters as Record<string, unknown>).kind
  return typeof kind === "string" && kind === "agent"
}

export function isPureSubagentParallelInput(input: unknown): boolean {
  if (input == null || typeof input !== "object") return false
  const toolUses = (input as { tool_uses?: unknown }).tool_uses
  if (!Array.isArray(toolUses) || toolUses.length === 0) return false
  return toolUses.every((item) => {
    if (item == null || typeof item !== "object") return false
    return parallelInnerUseIsDelegatedAgent(item as { recipient_name?: unknown; parameters?: unknown })
  })
}

function delegatedAgentDescriptionFromParallelInnerParams(parameters: unknown): string | null {
  if (parameters == null || typeof parameters !== "object") return null
  const p = parameters as Record<string, unknown>
  const description = typeof p.description === "string" ? p.description.trim() : ""
  const subject = typeof p.subject === "string" ? p.subject.trim() : ""
  const text = description || subject
  return text.length > 0 ? text : null
}

export function getParallelDelegatedAgentTaskDescriptions(input?: Record<string, unknown>): string[] {
  const uses = input?.tool_uses
  if (!Array.isArray(uses)) return []
  return uses
    .map((item) => {
      if (item == null || typeof item !== "object") return null
      const use = item as { recipient_name?: unknown; parameters?: unknown }
      if (!parallelInnerUseIsDelegatedAgent(use)) return null
      return delegatedAgentDescriptionFromParallelInnerParams(use.parameters)
    })
    .filter((value): value is string => value != null)
}

export function isDelegatedAgentParentTool(tool: string, input?: Record<string, unknown>): boolean {
  if (tool === "TaskCreateBatch" || tool === "SpawnAgent" || tool === "SpawnAgents" || tool === "SpawnAgentsParallel") {
    return true
  }
  if (tool === "TaskCreate") {
    const kind = typeof input?.kind === "string" ? input.kind : "tracking"
    return kind === "agent"
  }
  if (tool === "Parallel" || tool === "parallel") {
    return isPureSubagentParallelInput(input ?? {})
  }
  return false
}

export function isDelegatedAgentParentToolEndClear(tool: string, input?: Record<string, unknown>): boolean {
  if (tool === "Parallel" || tool === "parallel") return false
  return isDelegatedAgentParentTool(tool, input)
}
