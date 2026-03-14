/**
 * Subagent state for SpawnAgent tool display.
 * Updated from AgentEvent subagent_* in nexus-query and rendered under the tool in AssistantToolUseMessage.
 */
import type { Mode } from '@nexuscode/core'

export interface SubAgentState {
  id: string
  mode: Mode
  task: string
  status: 'running' | 'completed' | 'error'
  currentTool?: string
  toolHistory: string[]
  toolUsesCount: number
  startedAt: number
  finishedAt?: number
  error?: string
}

export type SubagentEvent =
  | { type: 'subagent_start'; subagentId: string; mode: Mode; task: string; parentPartId?: string }
  | { type: 'subagent_tool_start'; subagentId: string; tool: string; input?: Record<string, unknown>; parentPartId?: string }
  | { type: 'subagent_tool_end'; subagentId: string; tool: string; success: boolean; parentPartId?: string }
  | { type: 'subagent_done'; subagentId: string; success: boolean; outputPreview?: string; error?: string; parentPartId?: string }

function short(value: unknown, max = 52): string {
  if (typeof value !== 'string') return ''
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

function toolLabel(tool: string, input?: Record<string, unknown>): string {
  const path = short(input?.path ?? input?.file_path)
  const pattern = short(input?.pattern ?? input?.query)
  const command = short(input?.command, 44)
  const normalized = tool.trim()
  if (normalized === 'Read' || normalized === 'read_file') {
    return path ? `Read(${path})` : 'Read(file)'
  }
  if (normalized === 'List' || normalized === 'list_dir') {
    return path ? `List(${path})` : 'List(.)'
  }
  if (normalized === 'Grep' || normalized === 'grep') {
    return pattern ? `Grep(${pattern})` : 'Grep'
  }
  if (normalized === 'Glob' || normalized === 'glob') {
    return pattern ? `Glob(${pattern})` : 'Glob'
  }
  if (normalized === 'Bash' || normalized === 'execute_command') {
    return command ? `Bash(${command})` : 'Bash'
  }
  return normalized
}

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
        toolHistory: [],
        toolUsesCount: 0,
        startedAt: Date.now(),
      })
      return next
    }
    case 'subagent_tool_start': {
      const label = toolLabel(event.tool, event.input)
      return list.map((a) =>
        a.id === event.subagentId
          ? {
              ...a,
              status: 'running' as const,
              currentTool: label,
              toolUsesCount: a.toolUsesCount + 1,
              toolHistory: [...a.toolHistory, label].slice(-16),
            }
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
