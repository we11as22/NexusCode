/**
 * Subagent state for SpawnAgents tool display (single and multiple).
 * Updated from AgentEvent subagent_* in nexus-query and rendered under the tool in AssistantToolUseMessage.
 */
import type { Mode } from '@nexuscode/core'

export interface SubAgentState {
  id: string
  mode: Mode
  task: string
  status: 'running' | 'completed' | 'error'
  currentTool?: string
  startedAt: number
  finishedAt?: number
  error?: string
}

export type SubagentEvent =
  | { type: 'subagent_start'; subagentId: string; mode: Mode; task: string }
  | { type: 'subagent_tool_start'; subagentId: string; tool: string }
  | { type: 'subagent_tool_end'; subagentId: string; tool: string; success: boolean }
  | { type: 'subagent_done'; subagentId: string; success: boolean; outputPreview?: string; error?: string }

export function reduceSubagentEvent(
  list: SubAgentState[],
  event: SubagentEvent,
): SubAgentState[] {
  switch (event.type) {
    case 'subagent_start': {
      const next = list.filter((a) => a.id !== event.subagentId)
      next.push({
        id: event.subagentId,
        mode: event.mode,
        task: event.task,
        status: 'running',
        startedAt: Date.now(),
      })
      return next
    }
    case 'subagent_tool_start': {
      return list.map((a) =>
        a.id === event.subagentId
          ? { ...a, status: 'running' as const, currentTool: event.tool }
          : a,
      )
    }
    case 'subagent_tool_end': {
      return list.map((a) =>
        a.id === event.subagentId
          ? {
              ...a,
              status: (event.success ? 'running' : 'error') as 'running' | 'error',
              currentTool: event.success ? undefined : event.tool,
              ...(event.success ? {} : { error: undefined }),
            }
          : a,
      )
    }
    case 'subagent_done': {
      return list.map((a) =>
        a.id === event.subagentId
          ? {
              ...a,
              status: (event.success ? 'completed' : 'error') as 'completed' | 'error',
              finishedAt: Date.now(),
              currentTool: undefined,
              error: event.error,
            }
          : a,
      )
    }
    default:
      return list
  }
}

export function subagentStatusLine(sa: SubAgentState): string {
  if (sa.status === 'completed') return 'Completed'
  if (sa.status === 'error') return sa.error ? `Failed: ${sa.error.slice(0, 60)}` : 'Failed'
  if (sa.currentTool) return `Running: ${sa.currentTool}`
  return 'Starting…'
}

export function truncateTask(s: string, max = 56): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}
