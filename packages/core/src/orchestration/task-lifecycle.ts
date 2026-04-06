import type { IHost, NexusConfig, TaskRecord, TeamMemberRecord } from "../types.js"
import { getOrchestrationRuntime } from "./runtime.js"
import { runPluginHooks } from "../plugins/runtime.js"

function isTerminalTaskStatus(status: TaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "cancelled"
}

export async function ensureTeamMemberForTask(args: {
  cwd: string
  host: IHost
  task: TaskRecord
  agentId?: string
  agentType?: string
}): Promise<void> {
  const { cwd, host, task, agentId, agentType } = args
  if (!task.teamName || !task.owner) return
  const runtime = await getOrchestrationRuntime(cwd)
  const member: TeamMemberRecord = {
    name: task.owner,
    ...(agentId ? { agentId } : {}),
    ...(agentType ?? task.agentType ? { agentType: agentType ?? task.agentType } : {}),
    joinedAt: Date.now(),
    status: "active",
    lastActiveAt: Date.now(),
  }
  const team = await runtime.addTeamMember(task.teamName, member)
  if (team) host.emit({ type: "team_updated", team })
}

export async function handleCompletedTaskSideEffects(args: {
  cwd: string
  host: IHost
  config: NexusConfig
  task: TaskRecord
  outputPreview?: string
}): Promise<void> {
  const { cwd, host, config, task, outputPreview } = args
  if (!isTerminalTaskStatus(task.status)) return
  const runtime = await getOrchestrationRuntime(cwd)

  const hookResults = await runPluginHooks(
    cwd,
    host,
    config,
    "task_completed",
    {
      taskId: task.id,
      kind: task.kind,
      status: task.status,
      subject: task.subject,
      owner: task.owner,
      teamName: task.teamName,
      outputPreview: outputPreview ?? task.output?.slice(0, 500) ?? "",
    },
  ).catch(() => [])
  for (const hookResult of hookResults) {
    host.emit({
      type: "plugin_hook",
      pluginName: hookResult.pluginName,
      hookEvent: hookResult.hookEvent,
      output: hookResult.output,
      success: hookResult.success,
    })
  }

  if (!task.teamName || !task.owner) return
  const nextStatus: TeamMemberRecord["status"] =
    task.status === "completed" ? "idle" : "offline"
  const team = await runtime.updateTeamMember(task.teamName, task.owner, {
    status: nextStatus,
    lastActiveAt: Date.now(),
    ...(nextStatus === "idle" ? { lastIdleAt: Date.now() } : {}),
    ...(task.status === "failed" || task.status === "killed" || task.status === "cancelled"
      ? { note: `Latest task ${task.id} ended with status ${task.status}.` }
      : { note: null }),
    ...(task.agentType ? { agentType: task.agentType } : {}),
  })
  if (team) {
    host.emit({ type: "team_updated", team })
    const idleHookResults = await runPluginHooks(
      cwd,
      host,
      config,
      "teammate_idle",
      {
        taskId: task.id,
        teammate: task.owner,
        teamName: task.teamName,
        status: nextStatus,
        subject: task.subject,
      },
    ).catch(() => [])
    for (const hookResult of idleHookResults) {
      host.emit({
        type: "plugin_hook",
        pluginName: hookResult.pluginName,
        hookEvent: hookResult.hookEvent,
        output: hookResult.output,
        success: hookResult.success,
      })
    }
  }
}
