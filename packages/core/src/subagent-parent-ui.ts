/**
 * Shared rules for which tool starts count as “subagent parents” in hosts (CLI timeline, VS Code shadow, webview).
 * Keep webview `transcript/helpers.ts` in sync — webview cannot bundle @nexuscode/core.
 */

/** Strip functions./tools. prefix, then lowercase alnum-only (for Parallel inner recipient_name). */
export function canonParallelInnerRecipient(raw: string): string {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const prefix = prefixes.find((p) => lower.startsWith(p))
  const base = prefix ? trimmed.slice(prefix.length) : trimmed
  return base.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function parallelInnerUseIsDelegatedAgent(use: {
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

/** True when Parallel’s tool_uses are only delegated-agent spawns (legacy Spawn* or TaskCreate kind=agent). */
export function isPureSubagentParallelInput(input: unknown): boolean {
  if (input == null || typeof input !== "object") return false
  const toolUses = (input as { tool_uses?: unknown }).tool_uses
  if (!Array.isArray(toolUses) || toolUses.length === 0) return false
  return toolUses.every((item) => {
    if (item == null || typeof item !== "object") return false
    return parallelInnerUseIsDelegatedAgent(item as { recipient_name?: unknown; parameters?: unknown })
  })
}

export function delegatedAgentDescriptionFromParallelInnerParams(parameters: unknown): string | null {
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

/** Tool start that should receive subagent_* events when parentPartId is missing. */
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

/**
 * Whether finishing this tool should clear the “last subagent parent part id” fallback.
 * Parallel is excluded: subagent_* may arrive after Parallel tool_end; keep the parent id until a later tool overwrites it.
 */
export function isDelegatedAgentParentToolEndClear(tool: string, input?: Record<string, unknown>): boolean {
  if (tool === "Parallel" || tool === "parallel") return false
  return isDelegatedAgentParentTool(tool, input)
}
