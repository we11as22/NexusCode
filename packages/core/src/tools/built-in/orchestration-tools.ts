import * as fs from "node:fs/promises"
import * as path from "node:path"
import { kill } from "node:process"
import * as yaml from "js-yaml"
import { z } from "zod"
import type { BackgroundTaskRecord, DeferredToolDef, ToolContext, ToolDef } from "../../types.js"
import { backgroundBashJobs } from "./execute-command.js"
import { getOrchestrationRuntime } from "../../orchestration/runtime.js"
import { loadAgentDefinitions } from "../../orchestration/agents.js"
import { getMcpClientInstance } from "../../mcp/client.js"
import { loadPluginRuntimeRecords, runPluginHooks } from "../../plugins/runtime.js"
import { getClaudeCompatibilityOptions } from "../../compat/claude.js"

function zodPreview(schema: z.ZodTypeAny): unknown {
  const def = (schema as z.ZodTypeAny & { _def?: { typeName?: string; shape?: () => Record<string, z.ZodTypeAny>; innerType?: z.ZodTypeAny; options?: z.ZodTypeAny[]; values?: readonly string[] } })._def
  switch (def?.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: "string" }
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: "number" }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" }
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "enum", values: def.values ?? [] }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return { optional: true, inner: zodPreview(def.innerType as z.ZodTypeAny) }
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: zodPreview(def.innerType as z.ZodTypeAny) }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape =
        typeof def.shape === "function"
          ? (def.shape() as Record<string, z.ZodTypeAny>)
          : {}
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape).map(([key, value]) => [key, zodPreview(value)])
        ),
      }
    }
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { oneOf: ((def.options ?? []) as z.ZodTypeAny[]).map((item: z.ZodTypeAny) => zodPreview(item)) }
    default:
      return { type: "unknown" }
  }
}

function toolSearchCandidates(tools: ToolDef[]): DeferredToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.searchHint ? { searchHint: tool.searchHint } : {}),
  }))
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function readProjectConfigDocument(cwd: string): Promise<Record<string, unknown>> {
  const configPath = path.join(cwd, ".nexus", "nexus.yaml")
  try {
    const raw = await fs.readFile(configPath, "utf8")
    return asObject(yaml.load(raw))
  } catch {
    return {}
  }
}

async function writeProjectConfigDocument(cwd: string, doc: Record<string, unknown>): Promise<void> {
  const configPath = path.join(cwd, ".nexus", "nexus.yaml")
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, yaml.dump(doc, { indent: 2, lineWidth: 120 }), "utf8")
}

async function updateProjectPluginConfig(
  cwd: string,
  updater: (plugins: Record<string, unknown>) => void,
): Promise<void> {
  const doc = await readProjectConfigDocument(cwd)
  const plugins = asObject(doc.plugins)
  updater(plugins)
  const options = asObject(plugins.options)
  if (Object.keys(options).length > 0) plugins.options = options
  else delete plugins.options
  if (Array.isArray(plugins.trusted) && plugins.trusted.length === 0) delete plugins.trusted
  if (Array.isArray(plugins.blocked) && plugins.blocked.length === 0) delete plugins.blocked
  if (Object.keys(plugins).length > 0) doc.plugins = plugins
  else delete doc.plugins
  await writeProjectConfigDocument(cwd, doc)
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sendUserMessageSchema = z.object({
  message: z.string().min(1).describe("Message to present to the user."),
  status: z.enum(["normal", "proactive"]).optional().describe("Intent label for the outgoing message."),
  task_progress: z.string().optional(),
})

export const sendUserMessageTool: ToolDef<z.infer<typeof sendUserMessageSchema>> = {
  name: "SendUserMessage",
  description: "Send a structured reply to the user. The message is also returned as the tool output so hosts can surface it.",
  parameters: sendUserMessageSchema,
  async execute({ message, status }, _ctx) {
    return {
      success: true,
      output: message,
      metadata: { userVisibleMessage: true, status: status ?? "normal" },
    }
  },
}

const toolSearchSchema = z.object({
  query: z.string().min(1).describe("Tool name(s) or keywords to search for."),
  max_results: z.number().int().positive().max(20).optional().describe("Max tool matches to return."),
})

export const toolSearchTool: ToolDef<z.infer<typeof toolSearchSchema>> = {
  name: "ToolSearch",
  description: "Search available tools and return compact schema previews for the best matches.",
  parameters: toolSearchSchema,
  readOnly: true,
  async execute({ query, max_results }, ctx) {
    const limit = max_results ?? 8
    const q = query.trim().toLowerCase()
    const tools = ctx.resolvedTools ?? []
    const ranked = toolSearchCandidates(tools)
      .map((tool, index) => {
        const haystack = `${tool.name}\n${tool.description}\n${tool.searchHint ?? ""}`.toLowerCase()
        const score =
          (haystack.includes(q) ? 10 : 0) +
          (tool.name.toLowerCase().includes(q) ? 10 : 0) +
          q.split(/\s+/).filter(Boolean).reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0) -
          index * 0.0001
        return { tool, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    const rows = ranked.map(({ tool }) => {
      const def = tools.find((item) => item.name === tool.name)
      return [
        `## ${tool.name}`,
        tool.description,
        `Schema preview: ${JSON.stringify(def ? zodPreview(def.parameters as z.ZodTypeAny) : {}, null, 2)}`,
      ].join("\n")
    })
    return {
      success: true,
      output: rows.length > 0 ? rows.join("\n\n") : `No tools matched query: ${query}`,
    }
  },
}

const taskCreateSchema = z.object({
  subject: z.string().min(1).describe("A brief imperative title for the task."),
  description: z.string().min(1).describe("Detailed task description."),
  activeForm: z.string().optional().describe("Present continuous form shown while in progress."),
  owner: z.string().optional().describe("Optional task owner."),
  teamName: z.string().optional().describe("Optional team name this task belongs to."),
  metadata: z.record(z.unknown()).optional().describe("Optional arbitrary metadata."),
  addBlocks: z.array(z.string()).optional().describe("Task ids blocked by this task."),
  addBlockedBy: z.array(z.string()).optional().describe("Task ids this task depends on."),
})

export const taskCreateTool: ToolDef<z.infer<typeof taskCreateSchema>> = {
  name: "TaskCreate",
  description: "Create a structured task in the shared orchestration runtime.",
  parameters: taskCreateSchema,
  async execute(args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const task = await runtime.createTask({
      subject: args.subject,
      description: args.description,
      ...(args.activeForm ? { activeForm: args.activeForm } : {}),
      ...(args.owner ? { owner: args.owner } : {}),
      ...(args.teamName ? { teamName: args.teamName } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
      ...(args.addBlocks ? { blocks: args.addBlocks } : {}),
      ...(args.addBlockedBy ? { blockedBy: args.addBlockedBy } : {}),
      ...(ctx.partId ? { toolUseId: ctx.partId } : {}),
    })
    ctx.host.emit({ type: "task_updated", task })
    return {
      success: true,
      output: `Created task ${task.id}: ${task.subject}`,
      metadata: { task },
    }
  },
}

const taskGetSchema = z.object({
  taskId: z.string().min(1).describe("Task id to retrieve."),
})

export const taskGetTool: ToolDef<z.infer<typeof taskGetSchema>> = {
  name: "TaskGet",
  description: "Retrieve one task by id.",
  parameters: taskGetSchema,
  readOnly: true,
  async execute({ taskId }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const task = await runtime.getTask(taskId)
    if (!task) return { success: false, output: `Task not found: ${taskId}` }
    return { success: true, output: JSON.stringify(task, null, 2), metadata: { task } }
  },
}

const taskListSchema = z.object({
  teamName: z.string().optional().describe("Optional team name filter."),
  owner: z.string().optional().describe("Optional owner filter."),
  status: z.array(z.enum(["pending", "in_progress", "completed", "failed", "killed", "cancelled", "deleted"])).optional().describe("Optional status filter."),
  includeDeleted: z.boolean().optional().describe("Include deleted tasks."),
})

export const taskListTool: ToolDef<z.infer<typeof taskListSchema>> = {
  name: "TaskList",
  description: "List tasks from the shared orchestration runtime.",
  parameters: taskListSchema,
  readOnly: true,
  async execute(args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const tasks = await runtime.listTasks(args)
    if (tasks.length === 0) return { success: true, output: "No tasks found." }
    return {
      success: true,
      output: tasks
        .map((task) => `- ${task.id} | ${task.status} | ${task.subject}${task.owner ? ` | owner=${task.owner}` : ""}${task.teamName ? ` | team=${task.teamName}` : ""}`)
        .join("\n"),
      metadata: { tasks },
    }
  },
}

const taskUpdateSchema = z.object({
  taskId: z.string().min(1).describe("Task id to update."),
  status: z.enum(["pending", "in_progress", "completed", "failed", "killed", "cancelled", "deleted"]).optional(),
  subject: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  metadata: z.record(z.union([z.unknown(), z.null()])).optional().describe("Metadata merge patch; null removes a key."),
  addBlocks: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
})

export const taskUpdateTool: ToolDef<z.infer<typeof taskUpdateSchema>> = {
  name: "TaskUpdate",
  description: "Update an existing task.",
  parameters: taskUpdateSchema,
  async execute(args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const task = await runtime.updateTask(args.taskId, args)
    if (!task) return { success: false, output: `Task not found: ${args.taskId}` }
    ctx.host.emit({ type: "task_updated", task })
    return {
      success: true,
      output: `Updated task ${task.id}: ${task.status}`,
      metadata: { task },
    }
  },
}

const taskOutputSchema = z.object({
  taskId: z.string().min(1).describe("Task id or background task id."),
})

async function taskOutputFromBackground(task: BackgroundTaskRecord): Promise<string> {
  if (task.logPath) {
    try {
      return await fs.readFile(task.logPath, "utf8")
    } catch {
      return task.output ?? "(no output yet)"
    }
  }
  return task.output ?? "(no output yet)"
}

export const taskOutputTool: ToolDef<z.infer<typeof taskOutputSchema>> = {
  name: "TaskOutput",
  description: "Read task or background-task output.",
  parameters: taskOutputSchema,
  readOnly: true,
  async execute({ taskId }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const background = await runtime.getBackgroundTask(taskId)
    if (background) {
      const output = await taskOutputFromBackground(background)
      return {
        success: true,
        output: `[Task status: ${background.status}]\n${output}`,
        metadata: { task: background },
      }
    }
    const task = await runtime.getTask(taskId)
    if (!task) return { success: false, output: `Task not found: ${taskId}` }
    if (!task.outputFile) return { success: true, output: JSON.stringify(task, null, 2), metadata: { task } }
    try {
      const content = await fs.readFile(task.outputFile, "utf8")
      return { success: true, output: content, metadata: { task } }
    } catch (error) {
      return { success: false, output: `Could not read output for task ${taskId}: ${(error as Error).message}` }
    }
  },
}

const taskStopSchema = z.object({
  taskId: z.string().min(1).describe("Background task id to stop."),
})

export const taskStopTool: ToolDef<z.infer<typeof taskStopSchema>> = {
  name: "TaskStop",
  description: "Stop a running background task when supported.",
  parameters: taskStopSchema,
  async execute({ taskId }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const background = await runtime.getBackgroundTask(taskId)
    if (!background) return { success: false, output: `Background task not found: ${taskId}` }
    if (background.kind === "bash" && backgroundBashJobs.has(taskId)) {
      const job = backgroundBashJobs.get(taskId)!
      kill(job.pid, "SIGTERM")
      const next = await runtime.setBackgroundTaskStatus(taskId, "killed", { processId: job.pid })
      if (next) ctx.host.emit({ type: "background_task_updated", task: next })
      return { success: true, output: `Stopped bash task ${taskId}.` }
    }
    if (background.processId && isProcessRunning(background.processId)) {
      kill(background.processId, "SIGTERM")
      const next = await runtime.setBackgroundTaskStatus(taskId, "killed")
      if (next) ctx.host.emit({ type: "background_task_updated", task: next })
      return { success: true, output: `Stopped task ${taskId}.` }
    }
    return { success: false, output: `Task ${taskId} cannot be stopped by TaskStop in this runtime.` }
  },
}

const teamCreateSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
  description: z.string().min(1).describe("Team description."),
})

export const teamCreateTool: ToolDef<z.infer<typeof teamCreateSchema>> = {
  name: "TeamCreate",
  description: "Create a shared team/swarm container for tasks and messages.",
  parameters: teamCreateSchema,
  async execute({ team_name, description }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const team = await runtime.createTeam({ teamName: team_name, description })
    ctx.host.emit({ type: "team_updated", team })
    return { success: true, output: `Created team ${team.name}.`, metadata: { team } }
  },
}

const teamDeleteSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
})

export const teamDeleteTool: ToolDef<z.infer<typeof teamDeleteSchema>> = {
  name: "TeamDelete",
  description: "Delete a team from the orchestration runtime.",
  parameters: teamDeleteSchema,
  async execute({ team_name }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const deleted = await runtime.deleteTeam(team_name)
    if (!deleted) return { success: false, output: `Team not found: ${team_name}` }
    return { success: true, output: `Deleted team ${team_name}.` }
  },
}

const sendMessageSchema = z.object({
  to: z.string().min(1).describe("Message target (agent or teammate name)."),
  from: z.string().optional().describe("Sender label."),
  message: z.string().min(1).describe("Message body."),
  team_name: z.string().optional().describe("Optional team namespace."),
})

export const sendMessageTool: ToolDef<z.infer<typeof sendMessageSchema>> = {
  name: "SendMessage",
  description: "Persist a teammate/team message in the orchestration runtime.",
  parameters: sendMessageSchema,
  async execute({ to, from, message, team_name }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const record = await runtime.sendMessage({
      from: from?.trim() || "main",
      to,
      message,
      ...(team_name ? { teamName: team_name } : {}),
    })
    ctx.host.emit({ type: "team_message", message: record })
    return {
      success: true,
      output: `Queued message to ${to}.`,
      metadata: { message: record },
    }
  },
}

const remoteSessionListSchema = z.object({
  session_id: z.string().optional().describe("Optional session id filter."),
  run_id: z.string().optional().describe("Optional run id filter."),
  status: z.array(z.enum(["connecting", "connected", "reconnecting", "disconnected", "completed", "error"])).optional().describe("Optional status filter."),
})

export const listRemoteSessionsTool: ToolDef<z.infer<typeof remoteSessionListSchema>> = {
  name: "ListRemoteSessions",
  description: "List tracked remote/reconnectable session streams for this workspace.",
  parameters: remoteSessionListSchema,
  readOnly: true,
  shouldDefer: true,
  async execute({ session_id, run_id, status }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const sessions = await runtime.listRemoteSessions({
      ...(session_id ? { sessionId: session_id } : {}),
      ...(run_id ? { runId: run_id } : {}),
      ...(status?.length ? { status } : {}),
    })
    if (sessions.length === 0) return { success: true, output: "No remote sessions found." }
    return {
      success: true,
      output: sessions
        .map((session) =>
          `- ${session.id} | ${session.status} | ${session.url}${session.sessionId ? ` | session=${session.sessionId}` : ""}${session.runId ? ` | run=${session.runId}` : ""}${typeof session.lastEventSeq === "number" ? ` | seq=${session.lastEventSeq}` : ""}${typeof session.reconnectAttempts === "number" ? ` | reconnects=${session.reconnectAttempts}` : ""}`,
        )
        .join("\n"),
      metadata: { remoteSessions: sessions },
    }
  },
}

const remoteSessionGetSchema = z.object({
  remote_session_id: z.string().min(1).describe("Remote session id."),
})

export const getRemoteSessionTool: ToolDef<z.infer<typeof remoteSessionGetSchema>> = {
  name: "GetRemoteSession",
  description: "Read one tracked remote session record.",
  parameters: remoteSessionGetSchema,
  readOnly: true,
  shouldDefer: true,
  async execute({ remote_session_id }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const remoteSession = await runtime.getRemoteSession(remote_session_id)
    if (!remoteSession) return { success: false, output: `Remote session not found: ${remote_session_id}` }
    return {
      success: true,
      output: JSON.stringify(remoteSession, null, 2),
      metadata: { remoteSession },
    }
  },
}

const remoteSessionUpdateSchema = z.object({
  remote_session_id: z.string().min(1).describe("Remote session id."),
  status: z.enum(["connecting", "connected", "reconnecting", "disconnected", "completed", "error"]).optional(),
  last_event_seq: z.number().int().nonnegative().optional(),
  reconnect_attempts: z.number().int().nonnegative().optional(),
  reconnectable: z.boolean().optional(),
  viewer_only: z.boolean().optional(),
  error: z.string().optional(),
  metadata: z.record(z.union([z.unknown(), z.null()])).optional().describe("Metadata merge patch; null removes a key."),
})

export const updateRemoteSessionTool: ToolDef<z.infer<typeof remoteSessionUpdateSchema>> = {
  name: "UpdateRemoteSession",
  description: "Update a tracked remote session record and emit a runtime event.",
  parameters: remoteSessionUpdateSchema,
  shouldDefer: true,
  async execute({ remote_session_id, status, last_event_seq, reconnect_attempts, reconnectable, viewer_only, error, metadata }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const remoteSession = await runtime.updateRemoteSession(remote_session_id, {
      ...(status ? { status } : {}),
      ...(typeof last_event_seq === "number" ? { lastEventSeq: last_event_seq } : {}),
      ...(typeof reconnect_attempts === "number" ? { reconnectAttempts: reconnect_attempts } : {}),
      ...(typeof reconnectable === "boolean" ? { reconnectable } : {}),
      ...(typeof viewer_only === "boolean" ? { viewerOnly: viewer_only } : {}),
      ...(typeof error === "string" ? { error } : {}),
      ...(metadata ? { metadata } : {}),
    })
    if (!remoteSession) return { success: false, output: `Remote session not found: ${remote_session_id}` }
    ctx.host.emit({ type: "remote_session_updated", remoteSession })
    return {
      success: true,
      output: `Updated remote session ${remote_session_id}: ${remoteSession.status}`,
      metadata: { remoteSession },
    }
  },
}

const enterPlanModeSchema = z.object({
  reason: z.string().optional().describe("Why planning is needed."),
})

export const enterPlanModeTool: ToolDef<z.infer<typeof enterPlanModeSchema>> = {
  name: "EnterPlanMode",
  description: "Request a transition into plan mode for subsequent turns. Hosts that support mode switching will update immediately.",
  parameters: enterPlanModeSchema,
  async execute({ reason }, ctx) {
    const switched = await ctx.host.requestModeChange?.("plan", reason)
    return {
      success: true,
      output: switched?.success
        ? switched.message || `Entered plan mode.${reason ? ` Reason: ${reason}` : ""}`
        : `Planning handoff requested.${reason ? ` Reason: ${reason}` : ""} Ask the user or host to continue in plan mode.`,
      metadata: switched ? { modeChange: switched } : undefined,
    }
  },
}

const exitPlanModeSchema = z.object({
  summary: z.string().optional().describe("Optional brief summary of the plan."),
})

export const exitPlanModeTool: ToolDef<z.infer<typeof exitPlanModeSchema>> = {
  name: "ExitPlanMode",
  description: "Alias for plan handoff completion. Use when the plan is ready for review.",
  parameters: exitPlanModeSchema,
  modes: ["plan"],
  async execute({ summary }) {
    return {
      success: true,
      output: `Plan complete.\n\n${summary?.trim() || "Plan is ready."}`,
    }
  },
}

const enterWorktreeSchema = z.object({
  name: z.string().optional().describe("Optional worktree name."),
})

export const enterWorktreeTool: ToolDef<z.infer<typeof enterWorktreeSchema>> = {
  name: "EnterWorktree",
  description: "Create an isolated git worktree for the current repository and register it in the orchestration runtime.",
  parameters: enterWorktreeSchema,
  async execute({ name }, ctx) {
    const run = (command: string) => ctx.host.runCommand(command, ctx.cwd, ctx.signal)
    const top = await run("git rev-parse --show-toplevel")
    if (top.exitCode !== 0) {
      return { success: false, output: "EnterWorktree requires a git repository." }
    }
    const repoRoot = top.stdout.trim()
    const worktreeName = (name?.trim() || `nexus-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "-")
    const branch = `nexus/${worktreeName}`
    const worktreePath = path.join(repoRoot, ".nexus", "worktrees", worktreeName)
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
    const create = await run(`git worktree add -b "${branch}" "${worktreePath}" HEAD`)
    if (create.exitCode !== 0) {
      return { success: false, output: `Failed to create worktree: ${create.stderr || create.stdout}` }
    }
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const session = await runtime.createWorktreeSession({
      originalCwd: ctx.cwd,
      worktreePath,
      branch,
      metadata: { hostSwitchRequired: !ctx.host.setWorkingDirectory },
    })
    const switched = await ctx.host.setWorkingDirectory?.(worktreePath, `Switched into worktree ${worktreeName}`)
    return {
      success: true,
      output: switched?.success
        ? switched.message || `Created worktree at ${worktreePath} on branch ${branch} and switched host cwd.`
        : `Created worktree at ${worktreePath} on branch ${branch}. Current hosts do not auto-switch cwd yet; use this path explicitly or switch host context.`,
      metadata: { worktree: session, ...(switched ? { cwdChange: switched } : {}) },
    }
  },
}

const exitWorktreeSchema = z.object({
  worktree_id: z.string().optional().describe("Worktree session id."),
  action: z.enum(["keep", "remove"]).optional().describe("Whether to keep or remove the worktree."),
})

export const exitWorktreeTool: ToolDef<z.infer<typeof exitWorktreeSchema>> = {
  name: "ExitWorktree",
  description: "Mark a worktree as kept or remove it from disk.",
  parameters: exitWorktreeSchema,
  async execute({ worktree_id, action }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const session = worktree_id
      ? await runtime.updateWorktreeSession(worktree_id, {})
      : await runtime.findActiveWorktree()
    if (!session) return { success: false, output: "No active worktree session found." }
    if ((action ?? "keep") === "keep") {
      const kept = await runtime.updateWorktreeSession(session.id, { status: "kept" })
      const switched = await ctx.host.setWorkingDirectory?.(session.originalCwd, "Returned to the original workspace after keeping the worktree.")
      return {
        success: true,
        output: switched?.success
          ? switched.message || `Kept worktree ${session.worktreePath} and returned to ${session.originalCwd}.`
          : `Kept worktree ${session.worktreePath}.`,
        metadata: { worktree: kept, ...(switched ? { cwdChange: switched } : {}) },
      }
    }
    const result = await ctx.host.runCommand(`git worktree remove "${session.worktreePath}" --force`, ctx.cwd, ctx.signal)
    if (result.exitCode !== 0) {
      return { success: false, output: `Failed to remove worktree: ${result.stderr || result.stdout}` }
    }
    const removed = await runtime.updateWorktreeSession(session.id, { status: "removed" })
    const switched = await ctx.host.setWorkingDirectory?.(session.originalCwd, "Returned to the original workspace after removing the worktree.")
    return {
      success: true,
      output: switched?.success
        ? switched.message || `Removed worktree ${session.worktreePath} and returned to ${session.originalCwd}.`
        : `Removed worktree ${session.worktreePath}.`,
      metadata: { worktree: removed, ...(switched ? { cwdChange: switched } : {}) },
    }
  },
}

const powershellSchema = z.object({
  command: z.string().min(1).describe("PowerShell command to execute."),
  timeout: z.number().int().positive().max(600000).optional().describe("Optional timeout in milliseconds."),
})

function quoteSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export const powerShellTool: ToolDef<z.infer<typeof powershellSchema>> = {
  name: "PowerShell",
  description: "Execute a PowerShell command through pwsh/powershell with non-interactive flags.",
  parameters: powershellSchema,
  async execute({ command, timeout }, ctx) {
    const candidates = [
      `pwsh -NoLogo -NonInteractive -Command ${quoteSingle(command)}`,
      `powershell -NoLogo -NonInteractive -Command ${quoteSingle(command)}`,
    ]
    let lastError = "PowerShell executable not found."
    for (const shellCommand of candidates) {
      const result = await ctx.host.runCommand(shellCommand, ctx.cwd, ctx.signal).catch((error: Error) => ({
        stdout: "",
        stderr: error.message,
        exitCode: 1,
      }))
      if (result.exitCode === 127 || /not found/i.test(result.stderr)) {
        lastError = result.stderr || lastError
        continue
      }
      const output = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""].filter(Boolean).join("\n")
      return {
        success: result.exitCode === 0,
        output: `$ ${shellCommand}\n[exit: ${result.exitCode}]\n${output}`.trim(),
        metadata: { timeout: timeout ?? null },
      }
    }
    return { success: false, output: lastError }
  },
}

const listMcpResourcesSchema = z.object({
  server: z.string().optional().describe("Optional MCP server name."),
})

export const listMcpResourcesTool: ToolDef<z.infer<typeof listMcpResourcesSchema>> = {
  name: "ListMcpResources",
  description: "List resources exposed by connected MCP servers.",
  parameters: listMcpResourcesSchema,
  readOnly: true,
  async execute({ server }, _ctx) {
    const client = getMcpClientInstance()
    if (!client) return { success: false, output: "MCP client is not initialized." }
    const resources = await client.listResources(server)
    if (resources.length === 0) return { success: true, output: "No MCP resources available." }
    return {
      success: true,
      output: resources
        .map((resource) => `- [${resource.serverName}] ${resource.name ?? resource.uri} (${resource.uri})`)
        .join("\n"),
      metadata: { resources },
    }
  },
}

const readMcpResourceSchema = z.object({
  server: z.string().min(1).describe("MCP server name."),
  uri: z.string().min(1).describe("Resource URI."),
})

export const readMcpResourceTool: ToolDef<z.infer<typeof readMcpResourceSchema>> = {
  name: "ReadMcpResource",
  description: "Read a specific MCP resource by server and URI.",
  parameters: readMcpResourceSchema,
  readOnly: true,
  async execute({ server, uri }, _ctx) {
    const client = getMcpClientInstance()
    if (!client) return { success: false, output: "MCP client is not initialized." }
    const result = await client.readResource(server, uri)
    if (!result.length) return { success: false, output: `Resource not found: ${server} ${uri}` }
    return {
      success: true,
      output: result
        .map((item) => ("text" in item && item.text ? item.text : `[binary resource: ${item.mimeType ?? "unknown"}]`))
        .join("\n\n"),
      metadata: { resource: result },
    }
  },
}

const mcpAuthenticateSchema = z.object({
  server: z.string().min(1).describe("MCP server name."),
})

export const mcpAuthenticateTool: ToolDef<z.infer<typeof mcpAuthenticateSchema>> = {
  name: "McpAuthenticate",
  description: "Attempt to start or describe MCP authentication requirements for a server.",
  parameters: mcpAuthenticateSchema,
  async execute({ server }, _ctx) {
    const client = getMcpClientInstance()
    if (!client) return { success: false, output: "MCP client is not initialized." }
    const result = await client.authenticate(server, _ctx.host)
    return {
      success: result.success,
      output: result.message,
      metadata: { server },
    }
  },
}

const listAgentsSchema = z.object({})

export const listAgentsTool: ToolDef<z.infer<typeof listAgentsSchema>> = {
  name: "ListAgents",
  description: "List built-in and configured agent definitions available to the runtime.",
  parameters: listAgentsSchema,
  readOnly: true,
  async execute(_args, ctx) {
    const agents = await loadAgentDefinitions(ctx.cwd, getClaudeCompatibilityOptions(ctx.config))
    return {
      success: true,
      output: agents.map((agent) => `- ${agent.agentType}: ${agent.whenToUse}`).join("\n"),
      metadata: { agents },
    }
  },
}

const listPluginsSchema = z.object({})

export const listPluginsTool: ToolDef<z.infer<typeof listPluginsSchema>> = {
  name: "ListPlugins",
  description: "List installed local Nexus plugins and the surfaces they contribute (skills, agents, commands, hooks, MCP servers).",
  parameters: listPluginsSchema,
  readOnly: true,
  shouldDefer: true,
  async execute(_args, ctx) {
    const plugins = await loadPluginRuntimeRecords(ctx.cwd, ctx.config)
    if (plugins.length === 0) return { success: true, output: "No local plugins found." }
    return {
      success: true,
      output: plugins
        .map((plugin) =>
          `- ${plugin.name}${plugin.version ? `@${plugin.version}` : ""} [${plugin.scope}] enabled=${plugin.runtimeEnabled !== false} trusted=${plugin.trusted === true} skills=${plugin.skills.length} agents=${plugin.agents.length} commands=${plugin.commands.length} hooks=${plugin.hooks.length} mcp=${plugin.mcpServers.length}`,
        )
        .join("\n"),
      metadata: { plugins },
    }
  },
}

const getPluginSchema = z.object({
  name: z.string().min(1).describe("Plugin name."),
})

export const getPluginTool: ToolDef<z.infer<typeof getPluginSchema>> = {
  name: "GetPlugin",
  description: "Read one installed plugin manifest with resolved paths and warnings.",
  parameters: getPluginSchema,
  readOnly: true,
  shouldDefer: true,
  async execute({ name }, ctx) {
    const plugins = await loadPluginRuntimeRecords(ctx.cwd, ctx.config)
    const plugin = plugins.find((item) => item.name === name)
    if (!plugin) return { success: false, output: `Plugin not found: ${name}` }
    return {
      success: true,
      output: JSON.stringify(plugin, null, 2),
      metadata: { plugin },
    }
  },
}

const runPluginHookSchema = z.object({
  hook_event: z.enum(["user_prompt_submit", "before_tool", "after_tool"]).describe("Hook event to execute."),
  payload: z.record(z.unknown()).optional().describe("Optional payload object passed to the hook runner."),
})

export const runPluginHookTool: ToolDef<z.infer<typeof runPluginHookSchema>> = {
  name: "RunPluginHook",
  description: "Run trusted plugin hooks for a specific event and return their output.",
  parameters: runPluginHookSchema,
  shouldDefer: true,
  async execute({ hook_event, payload }, ctx) {
    const results = await runPluginHooks(ctx.cwd, ctx.host, ctx.config, hook_event, payload ?? {})
    if (results.length === 0) return { success: true, output: `No trusted plugin hooks handled ${hook_event}.` }
    for (const result of results) {
      ctx.host.emit({
        type: "plugin_hook",
        pluginName: result.pluginName,
        hookEvent: result.hookEvent,
        output: result.output,
        success: result.success,
      })
    }
    return {
      success: results.every((result) => result.success),
      output: results
        .map((result) => `## ${result.pluginName} (${result.success ? "ok" : "failed"})\n${result.output || "(no output)"}`)
        .join("\n\n"),
      metadata: { results },
    }
  },
}

const pluginTrustSchema = z.object({
  name: z.string().min(1).describe("Plugin name."),
  trusted: z.boolean().describe("Whether to trust the plugin for hook execution."),
})

export const pluginTrustTool: ToolDef<z.infer<typeof pluginTrustSchema>> = {
  name: "PluginTrust",
  description: "Update the runtime trust setting for a plugin in .nexus/nexus.yaml.",
  parameters: pluginTrustSchema,
  shouldDefer: true,
  async execute({ name, trusted }, ctx) {
    await updateProjectPluginConfig(ctx.cwd, (plugins) => {
      const trustedList = new Set(
        Array.isArray(plugins.trusted)
          ? plugins.trusted.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : (ctx.config.plugins?.trusted ?? []),
      )
      if (trusted) trustedList.add(name)
      else trustedList.delete(name)
      plugins.trusted = Array.from(trustedList).sort()
    })
    return {
      success: true,
      output: trusted ? `Plugin ${name} marked as trusted.` : `Plugin ${name} removed from trusted plugin list.`,
    }
  },
}

const pluginConfigureSchema = z.object({
  name: z.string().min(1).describe("Plugin name."),
  key: z.string().min(1).describe("Option key within plugins.options.<plugin>."),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.unknown()), z.null()]).optional().describe("Option value to persist."),
  unset: z.boolean().optional().describe("Remove this option key instead of setting a value."),
})

export const pluginConfigureTool: ToolDef<z.infer<typeof pluginConfigureSchema>> = {
  name: "PluginConfigure",
  description: "Persist plugin-specific runtime options in .nexus/nexus.yaml.",
  parameters: pluginConfigureSchema,
  shouldDefer: true,
  async execute({ name, key, value, unset }, ctx) {
    await updateProjectPluginConfig(ctx.cwd, (plugins) => {
      const options = asObject(plugins.options)
      const pluginOptions = asObject(options[name])
      if (unset) delete pluginOptions[key]
      else pluginOptions[key] = value ?? null
      if (Object.keys(pluginOptions).length > 0) options[name] = pluginOptions
      else delete options[name]
      if (Object.keys(options).length > 0) plugins.options = options
      else delete plugins.options
    })
    return {
      success: true,
      output: unset
        ? `Removed option ${key} from plugin ${name}.`
        : `Saved option ${key} for plugin ${name}.`,
    }
  },
}

const planMaterializeTasksSchema = z.object({
  file_path: z.string().optional().describe("Optional path to a plan markdown file. Defaults to the newest file under .nexus/plans/."),
  owner: z.string().optional().describe("Optional owner for the created tasks."),
  team_name: z.string().optional().describe("Optional team name for the created tasks."),
  dependency_ordered: z.boolean().optional().describe("When true, create tasks in dependency order so each later task depends on the previous one."),
})

function parsePlanTasks(planText: string): string[] {
  const checklist = planText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[\s?\]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+\[\s?\]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean)
  if (checklist.length > 0) return checklist
  return planText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, "").trim())
    .filter(Boolean)
}

async function resolvePlanFile(cwd: string, filePath?: string): Promise<string | null> {
  if (filePath) return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const plansDir = path.join(cwd, ".nexus", "plans")
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true })
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
      .map(async (entry) => {
        const absPath = path.join(plansDir, entry.name)
        const stat = await fs.stat(absPath)
        return { absPath, mtimeMs: stat.mtimeMs }
      }))
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.absPath ?? null
  } catch {
    return null
  }
}

export const planMaterializeTasksTool: ToolDef<z.infer<typeof planMaterializeTasksSchema>> = {
  name: "PlanMaterializeTasks",
  description: "Read a written plan and create orchestration tasks from its checklist items or section headings.",
  parameters: planMaterializeTasksSchema,
  async execute({ file_path, owner, team_name, dependency_ordered }, ctx) {
    const planFile = await resolvePlanFile(ctx.cwd, file_path)
    if (!planFile) return { success: false, output: "No plan file found. Write a plan under .nexus/plans/ first." }
    const planText = await fs.readFile(planFile, "utf8")
    const taskLines = parsePlanTasks(planText)
    if (taskLines.length === 0) return { success: false, output: `No task candidates found in ${planFile}.` }
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const created: Array<{ id: string; subject: string }> = []
    let previousTaskId: string | undefined
    for (const subject of taskLines) {
      const task = await runtime.createTask({
        subject,
        description: subject,
        ...(owner ? { owner } : {}),
        ...(team_name ? { teamName: team_name } : {}),
        ...(dependency_ordered !== false && previousTaskId ? { blockedBy: [previousTaskId] } : {}),
        metadata: {
          planFile,
          planSessionId: ctx.session.id,
        },
      })
      previousTaskId = task.id
      created.push({ id: task.id, subject: task.subject })
      ctx.host.emit({ type: "task_updated", task })
    }
    return {
      success: true,
      output: `Created ${created.length} tasks from ${planFile}.\n` + created.map((task) => `- ${task.id} | ${task.subject}`).join("\n"),
      metadata: { planFile, tasks: created },
    }
  },
}

const memoryScopeSchema = z.enum(["session", "project", "team"])

const memoryCreateSchema = z.object({
  scope: memoryScopeSchema.describe("Memory scope."),
  title: z.string().min(1).describe("Short memory title."),
  content: z.string().min(1).describe("Memory content."),
  team_name: z.string().optional().describe("Required when scope=team."),
  replace_existing: z.boolean().optional().describe("Replace an existing memory with the same scope/title/owner metadata."),
})

function buildMemoryMetadata(
  scope: "session" | "project" | "team",
  ctx: ToolContext,
  teamName?: string,
): Record<string, unknown> {
  return {
    ...(scope === "session" ? { sessionId: ctx.session.id } : {}),
    ...(scope === "team" && teamName ? { teamName } : {}),
  }
}

export const memoryCreateTool: ToolDef<z.infer<typeof memoryCreateSchema>> = {
  name: "MemoryCreate",
  description: "Create or replace a persistent memory record for this project/session/team.",
  parameters: memoryCreateSchema,
  async execute({ scope, title, content, team_name, replace_existing }, ctx) {
    if (scope === "team" && !team_name) {
      return { success: false, output: "team_name is required when scope=team." }
    }
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const metadata = buildMemoryMetadata(scope, ctx, team_name)
    const memory = replace_existing
      ? await runtime.upsertMemoryByTitle({ scope, title, content, metadata })
      : await runtime.createMemory({ scope, title, content, metadata })
    return {
      success: true,
      output: `Saved memory ${memory.id}: ${memory.title}`,
      metadata: { memory },
    }
  },
}

const memoryListSchema = z.object({
  scope: z.array(memoryScopeSchema).optional().describe("Optional scope filter."),
  include_content: z.boolean().optional().describe("Include full content in the output."),
  limit: z.number().int().positive().max(50).optional().describe("Maximum number of memories to return."),
  team_name: z.string().optional().describe("Filter team memories by team name."),
})

export const memoryListTool: ToolDef<z.infer<typeof memoryListSchema>> = {
  name: "MemoryList",
  description: "List persistent memories relevant to this run.",
  parameters: memoryListSchema,
  readOnly: true,
  async execute({ scope, include_content, limit, team_name }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const effectiveScope: Array<"project" | "session" | "team"> = scope?.length ? scope : ["project", "session", "team"]
    const memories = await runtime.listMemories({
      scope: effectiveScope,
      limit: limit ?? 20,
    })
    const filtered = memories.filter((memory) => {
      const metadata = memory.metadata ?? {}
      if (memory.scope === "session") return metadata.sessionId === ctx.session.id
      if (memory.scope === "team" && team_name) return metadata.teamName === team_name
      if (memory.scope === "team" && !team_name) return true
      return true
    })
    if (filtered.length === 0) return { success: true, output: "No memories found." }
    return {
      success: true,
      output: filtered
        .map((memory) =>
          include_content
            ? `- ${memory.id} | ${memory.scope} | ${memory.title}\n${memory.content}`
            : `- ${memory.id} | ${memory.scope} | ${memory.title}`,
        )
        .join("\n\n"),
      metadata: { memories: filtered },
    }
  },
}

const memoryGetSchema = z.object({
  memory_id: z.string().min(1).describe("Memory id."),
})

export const memoryGetTool: ToolDef<z.infer<typeof memoryGetSchema>> = {
  name: "MemoryGet",
  description: "Read one persistent memory record by id.",
  parameters: memoryGetSchema,
  readOnly: true,
  async execute({ memory_id }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const memory = await runtime.getMemory(memory_id)
    if (!memory) return { success: false, output: `Memory not found: ${memory_id}` }
    return {
      success: true,
      output: `# ${memory.title}\n\nScope: ${memory.scope}\n\n${memory.content}`,
      metadata: { memory },
    }
  },
}

const memoryUpdateSchema = z.object({
  memory_id: z.string().min(1).describe("Memory id."),
  title: z.string().optional().describe("New title."),
  content: z.string().optional().describe("New content."),
})

export const memoryUpdateTool: ToolDef<z.infer<typeof memoryUpdateSchema>> = {
  name: "MemoryUpdate",
  description: "Update an existing persistent memory record.",
  parameters: memoryUpdateSchema,
  async execute({ memory_id, title, content }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const memory = await runtime.updateMemory(memory_id, { title, content })
    if (!memory) return { success: false, output: `Memory not found: ${memory_id}` }
    return {
      success: true,
      output: `Updated memory ${memory.id}: ${memory.title}`,
      metadata: { memory },
    }
  },
}

const memoryDeleteSchema = z.object({
  memory_id: z.string().min(1).describe("Memory id."),
})

export const memoryDeleteTool: ToolDef<z.infer<typeof memoryDeleteSchema>> = {
  name: "MemoryDelete",
  description: "Delete a persistent memory record.",
  parameters: memoryDeleteSchema,
  async execute({ memory_id }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const deleted = await runtime.deleteMemory(memory_id)
    if (!deleted) return { success: false, output: `Memory not found: ${memory_id}` }
    return { success: true, output: `Deleted memory ${memory_id}.` }
  },
}
