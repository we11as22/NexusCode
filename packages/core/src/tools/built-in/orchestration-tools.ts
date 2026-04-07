import * as fs from "node:fs/promises"
import * as path from "node:path"
import { kill } from "node:process"
import * as yaml from "js-yaml"
import { z } from "zod"
import type { BackgroundTaskRecord, DeferredToolDef, ToolContext, ToolDef, TaskKind } from "../../types.js"
import { backgroundBashJobs, startBackgroundShellTask } from "./execute-command.js"
import { getOrchestrationRuntime } from "../../orchestration/runtime.js"
import { loadAgentDefinitions } from "../../orchestration/agents.js"
import { getMcpClientInstance } from "../../mcp/client.js"
import { loadPluginRuntimeRecords, runPluginHooks } from "../../plugins/runtime.js"
import { getClaudeCompatibilityOptions } from "../../compat/claude.js"
import { getParallelAgentManager } from "../../agent/parallel.js"
import { ensureTeamMemberForTask, handleCompletedTaskSideEffects } from "../../orchestration/task-lifecycle.js"
import {
  createPlanWorkflow,
  getPlanWorkflow,
  listPlanWorkflows,
  summarizePlanWorkflow,
  updatePlanWorkflow,
} from "../../orchestration/plan-workflow.js"
import {
  detectBlockedSleepPattern,
  detectDangerousShellPattern,
  detectPreferDedicatedToolMessage,
  isLikelyLongRunningShellCommand,
} from "./shell-safety.js"
import { interpretShellCommandResult } from "./shell-command-semantics.js"
import { validatePluginManifestFile } from "../../plugins/index.js"

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

function slugifyName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `plugin-${Date.now()}`
}

async function copyDirectoryRecursive(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true })
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath)
      continue
    }
    if (entry.isSymbolicLink()) continue
    await fs.copyFile(sourcePath, targetPath)
  }
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
  description: "Send a structured user-facing reply when the host supports explicit message surfacing. Use it for concise, final user communication, not for internal coordination.",
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
  description: "Search available tools and return compact schema previews for the best matches. Use this when a capability is missing from the initial manifest or when you need the exact canonical task/tool name instead of guessing.",
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
  kind: z.enum(["agent", "shell", "tracking", "workflow", "external"]).optional().describe("Task kind. Defaults to tracking."),
  subject: z.string().min(1).describe("A brief imperative title for the task."),
  description: z.string().min(1).describe("Detailed task description."),
  activeForm: z.string().optional().describe("Present continuous form shown while in progress."),
  owner: z.string().optional().describe("Optional task owner."),
  teamName: z.string().optional().describe("Optional team name this task belongs to."),
  name: z.string().optional().describe("Optional display name for an agent task."),
  mode: z.enum(["agent", "plan", "ask", "debug", "review", "search", "explore"]).optional().describe("Delegated agent mode when kind=agent."),
  agent_type: z.string().optional().describe("Named agent definition when kind=agent."),
  model: z.string().optional().describe("Optional model override id when kind=agent."),
  cwd: z.string().optional().describe("Optional absolute working directory override for agent or shell tasks."),
  isolation: z.enum(["worktree"]).optional().describe("Optional isolation mode for delegated agent tasks."),
  context_summary: z.string().optional().describe("Optional extra context when kind=agent."),
  command: z.string().optional().describe("Shell command when kind=shell."),
  shell_runner: z.enum(["bash", "powershell"]).optional().describe("Shell runner when kind=shell."),
  block: z.boolean().optional().describe("When true, wait for execution to finish before returning. Defaults to true for kind=agent and false for kind=shell."),
  metadata: z.record(z.unknown()).optional().describe("Optional arbitrary metadata."),
  addBlocks: z.array(z.string()).optional().describe("Task ids blocked by this task."),
  addBlockedBy: z.array(z.string()).optional().describe("Task ids this task depends on."),
})

async function createWorktreeForTask(
  ctx: ToolContext,
  runtime: Awaited<ReturnType<typeof getOrchestrationRuntime>>,
  requestedName?: string,
): Promise<{ worktreePath: string; worktreeId: string; branch: string }> {
  const top = await ctx.host.runCommand("git rev-parse --show-toplevel", ctx.cwd, ctx.signal)
  if (top.exitCode !== 0) {
    throw new Error("Worktree isolation requires a git repository.")
  }
  const repoRoot = top.stdout.trim()
  const worktreeName = (requestedName?.trim() || `task-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "-")
  const branch = `nexus/${worktreeName}`
  const worktreePath = path.join(repoRoot, ".nexus", "worktrees", worktreeName)
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  const create = await ctx.host.runCommand(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, ctx.cwd, ctx.signal)
  if (create.exitCode !== 0) {
    throw new Error(create.stderr || create.stdout || "Failed to create worktree.")
  }
  const session = await runtime.createWorktreeSession({
    originalCwd: ctx.cwd,
    worktreePath,
    branch,
    metadata: {
      createdForTask: true,
    },
  })
  return { worktreePath, worktreeId: session.id, branch }
}

export const taskCreateTool: ToolDef<z.infer<typeof taskCreateSchema>> = {
  name: "TaskCreate",
  description:
    "Create a unified task in the orchestration runtime. kind=agent: delegated agent work; kind=shell: background shell jobs; kind=tracking (default): durable coordination items. Prefer TaskCreate over ad hoc coordination in prose. OpenClaude-class habits: use TaskList first to avoid duplicate subjects; for tracking work, move status forward with TaskUpdate (e.g. in_progress before you start, completed when done); give a clear imperative subject and a detailed description others can act on.",
  parameters: taskCreateSchema,
  async execute(args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const kind = (args.kind ?? "tracking") as TaskKind
    if (kind === "agent") {
      const manager = getParallelAgentManager()
      if (!manager) {
        return { success: false, output: "Agent task runtime is not available in this host." }
      }
      const agentCwd =
        typeof args.cwd === "string" && path.isAbsolute(args.cwd)
          ? args.cwd
          : ctx.cwd
      let effectiveCwd = agentCwd
      let createdWorktree:
        | { worktreePath: string; worktreeId: string; branch: string }
        | undefined
      if (args.isolation === "worktree") {
        createdWorktree = await createWorktreeForTask(ctx, runtime, args.name ?? args.subject).catch((error) => {
          throw new Error(`Failed to create isolated worktree: ${(error as Error).message}`)
        })
        effectiveCwd = createdWorktree.worktreePath
      }
      const parentMode = ctx.mode ?? "agent"
      const requestedAgentType = args.agent_type?.trim()
      const agentDefinition = requestedAgentType
        ? (await loadAgentDefinitions(ctx.cwd, getClaudeCompatibilityOptions(ctx.config)).catch(() => []))
            .find((agent) => agent.agentType.toLowerCase() === requestedAgentType.toLowerCase())
        : undefined
      const normalizedMode =
        parentMode === "plan" || parentMode === "ask" || parentMode === "review"
          ? "ask"
          : args.mode === "search" || args.mode === "explore"
            ? "ask"
            : ((agentDefinition?.preferredMode ?? args.mode ?? "agent") as "agent" | "plan" | "ask" | "debug" | "review")
      const shouldBlock = args.block ?? true
      const agentMetadata: Record<string, unknown> = {
        ...(args.metadata ?? {}),
        ...(args.name ? { name: args.name } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(effectiveCwd !== ctx.cwd ? { cwd: effectiveCwd } : {}),
        ...(createdWorktree
          ? {
              worktreeId: createdWorktree.worktreeId,
              worktreePath: createdWorktree.worktreePath,
              worktreeBranch: createdWorktree.branch,
            }
          : {}),
      }
      if (!shouldBlock) {
        const started = await manager.spawnInBackground(
          args.description,
          normalizedMode,
          ctx.config,
          effectiveCwd,
          ctx.signal,
          ctx.config.parallelAgents.maxParallel,
          (event) => ctx.host.emit(event),
          args.context_summary,
          ctx.partId,
          agentDefinition?.agentType,
          {
            modelOverride: args.model,
            taskName: args.name,
            skipDuplicateCheck: ctx.skipSubagentDuplicateCheck === true,
          },
        )
        const task = await runtime.updateTask(started.subagentId, {
          subject: args.subject,
          owner: args.owner,
          ...(args.teamName ? { teamName: args.teamName } : {}),
          metadata: agentMetadata,
          ...(args.activeForm ? { activeForm: args.activeForm } : {}),
          ...(args.addBlocks ? { addBlocks: args.addBlocks } : {}),
          ...(args.addBlockedBy ? { addBlockedBy: args.addBlockedBy } : {}),
        })
        const resolved = task ?? await runtime.getTask(started.subagentId)
        if (resolved) {
          await ensureTeamMemberForTask({
            cwd: ctx.cwd,
            host: ctx.host,
            task: resolved,
            agentId: started.subagentId,
            agentType: agentDefinition?.agentType,
          })
          ctx.host.emit({ type: "task_created", task: resolved })
          ctx.host.emit({ type: "task_updated", task: resolved })
        }
        return {
          success: true,
          output: `Created agent task ${started.subagentId}: ${args.subject}. Use TaskOutput with taskId=${started.subagentId} to monitor or wait.${createdWorktree ? ` Worktree: ${createdWorktree.worktreePath}` : ""}`,
          metadata: { task: resolved, task_id: started.subagentId },
        }
      }
      const result = await manager.spawn(
        args.description,
        normalizedMode,
        ctx.config,
        effectiveCwd,
        ctx.signal,
        ctx.config.parallelAgents.maxParallel,
        (event) => ctx.host.emit(event),
        args.context_summary,
        ctx.partId,
        agentDefinition?.agentType,
        {
          modelOverride: args.model,
          taskName: args.name,
          skipDuplicateCheck: ctx.skipSubagentDuplicateCheck === true,
        },
      )
      const task = await runtime.updateTask(result.subagentId, {
        subject: args.subject,
        owner: args.owner,
        ...(args.teamName ? { teamName: args.teamName } : {}),
        metadata: agentMetadata,
        ...(args.activeForm ? { activeForm: args.activeForm } : {}),
        ...(args.addBlocks ? { addBlocks: args.addBlocks } : {}),
        ...(args.addBlockedBy ? { addBlockedBy: args.addBlockedBy } : {}),
      })
      const resolved = task ?? await runtime.getTask(result.subagentId)
      if (resolved) {
        await ensureTeamMemberForTask({
          cwd: ctx.cwd,
          host: ctx.host,
          task: resolved,
          agentId: result.subagentId,
          agentType: agentDefinition?.agentType,
        })
        ctx.host.emit({ type: "task_created", task: resolved })
        ctx.host.emit({ type: "task_completed", task: resolved, outputPreview: result.output.slice(0, 500) })
        await handleCompletedTaskSideEffects({
          cwd: ctx.cwd,
          host: ctx.host,
          config: ctx.config,
          task: resolved,
          outputPreview: result.output.slice(0, 500),
        })
      }
      return {
        success: !result.error,
        output: result.error
          ? `Agent task ${result.subagentId} failed: ${result.error}\nPartial output: ${result.output}`
          : result.output,
        metadata: { task: resolved, task_id: result.subagentId },
      }
    }

    if (kind === "shell") {
      if (!args.command?.trim()) {
        return { success: false, output: "command is required when kind=shell." }
      }
      const shellRunner = args.shell_runner ?? "bash"
      const dedicatedToolMessage = detectPreferDedicatedToolMessage(args.command)
      if (dedicatedToolMessage) return { success: false, output: dedicatedToolMessage }
      const sleepWarning = detectBlockedSleepPattern(args.command, shellRunner)
      if ((args.block ?? false) === false && sleepWarning) {
        return { success: false, output: `${sleepWarning} Run it in the foreground if you really need it, but do not background it.` }
      }
      const dangerousMessage = detectDangerousShellPattern(args.command)
      const autoBackgrounded = args.block == null && isLikelyLongRunningShellCommand(args.command)
      const shouldBlock = args.block ?? false
      const shellMetadata: Record<string, unknown> = {
        ...(args.metadata ?? {}),
        ...(typeof args.cwd === "string" && path.isAbsolute(args.cwd) ? { cwd: args.cwd } : {}),
        ...(dangerousMessage ? { dangerousWarning: dangerousMessage } : {}),
        ...(autoBackgrounded ? { assistantAutoBackgrounded: true } : {}),
      }
      const command =
        shellRunner === "powershell"
          ? `powershell -NoProfile -NonInteractive -Command ${JSON.stringify(args.command)}`
          : args.command
      const { taskId } = await startBackgroundShellTask({
        command,
        cwd: typeof args.cwd === "string" && path.isAbsolute(args.cwd) ? args.cwd : ctx.cwd,
        shellRunner,
        host: ctx.host,
        config: ctx.config,
        metadata: {
          assistantAutoBackgrounded: autoBackgrounded,
          ...(dangerousMessage ? { dangerousWarning: dangerousMessage } : {}),
        },
      })
      const task = await runtime.updateTask(taskId, {
        subject: args.subject,
        owner: args.owner,
        ...(args.teamName ? { teamName: args.teamName } : {}),
        shellRunner,
        metadata: shellMetadata,
        ...(args.activeForm ? { activeForm: args.activeForm } : {}),
        ...(args.addBlocks ? { addBlocks: args.addBlocks } : {}),
        ...(args.addBlockedBy ? { addBlockedBy: args.addBlockedBy } : {}),
      })
      const resolved = task ?? await runtime.getTask(taskId)
      if (resolved) {
        await ensureTeamMemberForTask({
          cwd: ctx.cwd,
          host: ctx.host,
          task: resolved,
        })
        ctx.host.emit({ type: "task_created", task: resolved })
      }
      if (!shouldBlock) {
        return {
          success: true,
          output: `Created shell task ${taskId}: ${args.subject}. Use TaskOutput with taskId=${taskId} to wait or inspect logs.${dangerousMessage ? ` Warning: ${dangerousMessage}` : ""}${autoBackgrounded ? " The task was auto-backgrounded because it looks long-running." : ""}`,
          metadata: { task: resolved, task_id: taskId },
        }
      }
      const background = await runtime.getBackgroundTask(taskId)
      const output = background ? await taskOutputFromBackground(background, true, runtime, taskId) : "(no output yet)"
      const latestTask = await runtime.getTask(taskId)
      if (latestTask) {
        await handleCompletedTaskSideEffects({
          cwd: ctx.cwd,
          host: ctx.host,
          config: ctx.config,
          task: latestTask,
          outputPreview: output.slice(0, 500),
        })
      }
      return {
        success: latestTask?.status !== "failed" && latestTask?.status !== "killed",
        output,
        metadata: { task: latestTask ?? resolved, task_id: taskId },
      }
    }

    const task = await runtime.createTask({
      kind,
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
    ctx.host.emit({ type: "task_created", task })
    ctx.host.emit({ type: "task_updated", task })
    return {
      success: true,
      output: `Created ${kind} task ${task.id}: ${task.subject}`,
      metadata: { task },
    }
  },
}

const taskGetSchema = z.object({
  taskId: z.string().min(1).describe("Task id to retrieve."),
})

export const taskGetTool: ToolDef<z.infer<typeof taskGetSchema>> = {
  name: "TaskGet",
  description: "Retrieve one task by id when you need its full structured state, metadata, dependencies, or last recorded output fields.",
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
  kind: z.array(z.enum(["agent", "shell", "tracking", "workflow", "external"])).optional().describe("Optional task kind filter."),
  teamName: z.string().optional().describe("Optional team name filter."),
  owner: z.string().optional().describe("Optional owner filter."),
  status: z.array(z.enum(["pending", "in_progress", "completed", "failed", "killed", "cancelled", "deleted"])).optional().describe("Optional status filter."),
  includeDeleted: z.boolean().optional().describe("Include deleted tasks."),
})

export const taskListTool: ToolDef<z.infer<typeof taskListSchema>> = {
  name: "TaskList",
  description: "List tasks from the shared orchestration runtime. Use filters to inspect agent tasks, shell tasks, ownership, team state, or incomplete work before creating duplicate tasks.",
  parameters: taskListSchema,
  readOnly: true,
  async execute(args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const tasks = await runtime.listTasks(args)
    if (tasks.length === 0) return { success: true, output: "No tasks found." }
    return {
      success: true,
      output: tasks
        .map((task) => `- ${task.id} | kind=${task.kind} | ${task.status} | ${task.subject}${task.owner ? ` | owner=${task.owner}` : ""}${task.teamName ? ` | team=${task.teamName}` : ""}`)
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
  description: "Update an existing task. Use this to record status, ownership, blocking relationships, and task metadata as work progresses.",
  parameters: taskUpdateSchema,
  async execute(args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const task = await runtime.updateTask(args.taskId, args)
    if (!task) return { success: false, output: `Task not found: ${args.taskId}` }
    ctx.host.emit({ type: "task_updated", task })
    await ensureTeamMemberForTask({ cwd: ctx.cwd, host: ctx.host, task })
    await handleCompletedTaskSideEffects({ cwd: ctx.cwd, host: ctx.host, config: ctx.config, task })
    return {
      success: true,
      output: `Updated task ${task.id}: ${task.status}`,
      metadata: { task },
    }
  },
}

const taskOutputSchema = z.object({
  taskId: z.string().min(1).describe("Task id or background task id."),
  block: z.boolean().optional().describe("When true, wait for running delegated or shell tasks to finish before returning. Defaults to true."),
})

async function waitForBackgroundTaskToFinish(runtime: Awaited<ReturnType<typeof getOrchestrationRuntime>>, taskId: string): Promise<BackgroundTaskRecord | null> {
  for (;;) {
    const task = await runtime.getBackgroundTask(taskId)
    if (!task) return null
    if (task.status !== "running" && task.status !== "pending") return task
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function taskOutputFromBackground(
  task: BackgroundTaskRecord,
  block = true,
  runtime?: Awaited<ReturnType<typeof getOrchestrationRuntime>>,
  taskId?: string,
): Promise<string> {
  const resolved = block && runtime && taskId
    ? (await waitForBackgroundTaskToFinish(runtime, taskId)) ?? task
    : task
  if (resolved.logPath) {
    try {
      return await fs.readFile(resolved.logPath, "utf8")
    } catch {
      return resolved.output ?? "(no output yet)"
    }
  }
  return resolved.output ?? "(no output yet)"
}

export const taskOutputTool: ToolDef<z.infer<typeof taskOutputSchema>> = {
  name: "TaskOutput",
  description: "Read task output. For running agent or shell tasks, block=true waits for completion before returning. Prefer one blocking wait over manual polling loops when you do not have other work to do.",
  parameters: taskOutputSchema,
  readOnly: true,
  async execute({ taskId, block }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const task = await runtime.getTask(taskId)
    if (!task) return { success: false, output: `Task not found: ${taskId}` }
    const shouldBlock = block ?? true
    if (task.kind === "agent") {
      const manager = getParallelAgentManager()
      const snapshot = shouldBlock ? await manager?.waitFor(taskId) : manager?.getSnapshot(taskId)
      const latest = await runtime.getTask(taskId)
      const status = snapshot?.status ?? latest?.status ?? task.status
      const body = snapshot?.output?.trim() || latest?.output?.trim() || task.output?.trim() || "(no output yet)"
      const error = snapshot?.error ?? latest?.error ?? task.error
      return {
        success: status !== "error" && status !== "failed",
        output: `[Task status: ${status}]\n${body}${error ? `\nError: ${error}` : ""}`,
        metadata: { task: latest ?? task, task_id: taskId },
      }
    }
    const background = await runtime.getBackgroundTask(taskId)
    if (background) {
      const output = await taskOutputFromBackground(background, shouldBlock, runtime, taskId)
      const latest = await runtime.getTask(taskId)
      const interpretation =
        typeof latest?.exitCode === "number" && latest.command
          ? interpretShellCommandResult(latest.command, latest.exitCode, output, "")
          : null
      return {
        success: interpretation ? !interpretation.isError : (latest?.status ?? task.status) !== "failed" && (latest?.status ?? task.status) !== "killed",
        output: `[Task status: ${latest?.status ?? task.status}]${interpretation?.message ? `\n[status] ${interpretation.message}` : ""}\n${output}`,
        metadata: { task: latest ?? task, task_id: taskId },
      }
    }
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
  description: "Stop a running task when supported. Agent tasks stop delegated runs; shell tasks stop the background process. Use this when the task is clearly no longer useful, stuck, or superseded.",
  parameters: taskStopSchema,
  async execute({ taskId }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const task = await runtime.getTask(taskId)
    if (task?.kind === "agent") {
      const manager = getParallelAgentManager()
      const stopped = manager?.stop(taskId) ?? false
      if (!stopped) return { success: false, output: `Task ${taskId} is not an active delegated task.` }
      const updated = await runtime.updateTask(taskId, { status: "killed" })
      if (updated) {
        ctx.host.emit({ type: "task_updated", task: updated })
        ctx.host.emit({ type: "task_completed", task: updated, outputPreview: updated.output?.slice(0, 500) })
        await handleCompletedTaskSideEffects({
          cwd: ctx.cwd,
          host: ctx.host,
          config: ctx.config,
          task: updated,
          outputPreview: updated.output?.slice(0, 500),
        })
      }
      return { success: true, output: `Stopped agent task ${taskId}.` }
    }
    const background = await runtime.getBackgroundTask(taskId)
    if (!background) return { success: false, output: `Background task not found: ${taskId}` }
    if (background.kind === "bash" && backgroundBashJobs.has(taskId)) {
      const job = backgroundBashJobs.get(taskId)!
      kill(job.pid, "SIGTERM")
      const next = await runtime.setBackgroundTaskStatus(taskId, "killed", { processId: job.pid })
      if (next) {
        ctx.host.emit({ type: "background_task_updated", task: next })
        const unified = await runtime.getTask(taskId)
        if (unified) {
          ctx.host.emit({ type: "task_updated", task: unified })
          ctx.host.emit({ type: "task_completed", task: unified, outputPreview: unified.output?.slice(0, 500) })
          await handleCompletedTaskSideEffects({
            cwd: ctx.cwd,
            host: ctx.host,
            config: ctx.config,
            task: unified,
            outputPreview: unified.output?.slice(0, 500),
          })
        }
      }
      return { success: true, output: `Stopped bash task ${taskId}.` }
    }
    if (background.processId && isProcessRunning(background.processId)) {
      kill(background.processId, "SIGTERM")
      const next = await runtime.setBackgroundTaskStatus(taskId, "killed")
      if (next) {
        ctx.host.emit({ type: "background_task_updated", task: next })
        const unified = await runtime.getTask(taskId)
        if (unified) {
          ctx.host.emit({ type: "task_updated", task: unified })
          ctx.host.emit({ type: "task_completed", task: unified, outputPreview: unified.output?.slice(0, 500) })
          await handleCompletedTaskSideEffects({
            cwd: ctx.cwd,
            host: ctx.host,
            config: ctx.config,
            task: unified,
            outputPreview: unified.output?.slice(0, 500),
          })
        }
      }
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

const teamListSchema = z.object({})

export const teamListTool: ToolDef<z.infer<typeof teamListSchema>> = {
  name: "TeamList",
  description: "List orchestration teams and their current member counts.",
  parameters: teamListSchema,
  readOnly: true,
  async execute(_args, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const teams = await runtime.listTeams()
    if (teams.length === 0) return { success: true, output: "No teams found." }
    return {
      success: true,
      output: teams
        .map((team) => `- ${team.name} | members=${team.members.length} | messages=${team.messages.length} | ${team.description}`)
        .join("\n"),
      metadata: { teams },
    }
  },
}

const teamGetSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
})

export const teamGetTool: ToolDef<z.infer<typeof teamGetSchema>> = {
  name: "TeamGet",
  description: "Read one orchestration team with members and recent messages.",
  parameters: teamGetSchema,
  readOnly: true,
  async execute({ team_name }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const team = await runtime.getTeam(team_name)
    if (!team) return { success: false, output: `Team not found: ${team_name}` }
    return {
      success: true,
      output: JSON.stringify(team, null, 2),
      metadata: { team },
    }
  },
}

const teamInboxSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
  include_completed: z.boolean().optional().describe("Include completed terminal tasks in the task list."),
})

export const teamInboxTool: ToolDef<z.infer<typeof teamInboxSchema>> = {
  name: "TeamInbox",
  description: "Show a coordinator-style team inbox with members, assigned tasks, and recent team messages.",
  parameters: teamInboxSchema,
  readOnly: true,
  async execute({ team_name, include_completed }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const team = await runtime.getTeam(team_name)
    if (!team) return { success: false, output: `Team not found: ${team_name}` }
    const tasks = await runtime.listTasks({ teamName: team_name, includeDeleted: false })
    const filteredTasks = include_completed
      ? tasks
      : tasks.filter((task) => !["completed", "failed", "killed", "cancelled", "deleted"].includes(task.status))
    const recentMessages = [...team.messages].sort((a, b) => b.ts - a.ts).slice(0, 8)
    const memberLines = [...team.members]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((member) => {
        const owned = filteredTasks.filter((task) => task.owner === member.name)
        return `- ${member.name} | status=${member.status ?? "unknown"} | owned_tasks=${owned.length}${member.note ? ` | note=${member.note}` : ""}`
      })
    const taskLines = filteredTasks
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((task) => `- ${task.id} | ${task.status} | ${task.subject}${task.owner ? ` | owner=${task.owner}` : ""}`)
    const messageLines = recentMessages.map((message) => `- ${message.from} -> ${message.to}: ${message.message}`)
    return {
      success: true,
      output: [
        `# Team ${team.name}`,
        team.description,
        "",
        "## Members",
        ...(memberLines.length ? memberLines : ["- none"]),
        "",
        "## Active Tasks",
        ...(taskLines.length ? taskLines : ["- none"]),
        "",
        "## Recent Messages",
        ...(messageLines.length ? messageLines : ["- none"]),
      ].join("\n"),
      metadata: { team, tasks: filteredTasks, messages: recentMessages },
    }
  },
}

const teamAssignTaskSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
  task_id: z.string().min(1).describe("Task id."),
  member_name: z.string().min(1).describe("Member to own the task."),
  note: z.string().optional().describe("Optional assignment note."),
})

export const teamAssignTaskTool: ToolDef<z.infer<typeof teamAssignTaskSchema>> = {
  name: "TeamAssignTask",
  description: "Assign a task to a teammate, tighten owner/team linkage, and mark the teammate active.",
  parameters: teamAssignTaskSchema,
  async execute({ team_name, task_id, member_name, note }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const team = await runtime.getTeam(team_name)
    if (!team) return { success: false, output: `Team not found: ${team_name}` }
    const task = await runtime.updateTask(task_id, {
      owner: member_name,
      teamName: team_name,
      metadata: typeof note === "string" ? { assignmentNote: note } : undefined,
    })
    if (!task) return { success: false, output: `Task not found: ${task_id}` }
    const updatedTeam = await runtime.addTeamMember(team_name, {
      name: member_name,
      joinedAt: Date.now(),
      ...(task.id ? { agentId: task.id } : {}),
      ...(task.agentType ? { agentType: task.agentType } : {}),
      status: "active",
      lastActiveAt: Date.now(),
      ...(typeof note === "string" ? { note } : {}),
    })
    if (updatedTeam) ctx.host.emit({ type: "team_updated", team: updatedTeam })
    ctx.host.emit({ type: "task_updated", task })
    const message = await runtime.sendMessage({
      from: "coordinator",
      to: member_name,
      teamName: team_name,
      message: note?.trim()
        ? `Assigned task ${task.subject} (${task.id}). ${note.trim()}`
        : `Assigned task ${task.subject} (${task.id}).`,
    })
    ctx.host.emit({ type: "team_message", message })
    return {
      success: true,
      output: `Assigned task ${task.id} to ${member_name} in team ${team_name}.`,
      metadata: { task, team: updatedTeam ?? team, message },
    }
  },
}

const teamAddMemberSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
  member_name: z.string().min(1).describe("Member display name."),
  agent_id: z.string().optional().describe("Optional agent task id."),
  agent_type: z.string().optional().describe("Optional agent definition type."),
  status: z.enum(["active", "idle", "offline"]).optional().describe("Optional initial member status."),
})

export const teamAddMemberTool: ToolDef<z.infer<typeof teamAddMemberSchema>> = {
  name: "TeamAddMember",
  description: "Add or update a team member for team/swarm coordination.",
  parameters: teamAddMemberSchema,
  async execute({ team_name, member_name, agent_id, agent_type, status }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const team = await runtime.addTeamMember(team_name, {
      name: member_name,
      joinedAt: Date.now(),
      ...(agent_id ? { agentId: agent_id } : {}),
      ...(agent_type ? { agentType: agent_type } : {}),
      ...(status ? { status } : {}),
      ...(status === "active" ? { lastActiveAt: Date.now() } : {}),
      ...(status === "idle" ? { lastIdleAt: Date.now() } : {}),
    })
    if (!team) return { success: false, output: `Team not found: ${team_name}` }
    ctx.host.emit({ type: "team_updated", team })
    return { success: true, output: `Upserted member ${member_name} in team ${team_name}.`, metadata: { team } }
  },
}

const teamSetMemberStatusSchema = z.object({
  team_name: z.string().min(1).describe("Team name."),
  member_name: z.string().min(1).describe("Member display name."),
  status: z.enum(["active", "idle", "offline"]).describe("New member status."),
  note: z.string().optional().describe("Optional status note."),
})

export const teamSetMemberStatusTool: ToolDef<z.infer<typeof teamSetMemberStatusSchema>> = {
  name: "TeamSetMemberStatus",
  description: "Update a team member status and emit a team update.",
  parameters: teamSetMemberStatusSchema,
  async execute({ team_name, member_name, status, note }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const team = await runtime.updateTeamMember(team_name, member_name, {
      status,
      ...(status === "active" ? { lastActiveAt: Date.now() } : {}),
      ...(status === "idle" ? { lastIdleAt: Date.now() } : {}),
      ...(typeof note === "string" ? { note } : {}),
    })
    if (!team) return { success: false, output: `Team/member not found: ${team_name}/${member_name}` }
    ctx.host.emit({ type: "team_updated", team })
    if (status === "idle") {
      const hookResults = await runPluginHooks(ctx.cwd, ctx.host, ctx.config, "teammate_idle", {
        teammate: member_name,
        teamName: team_name,
        note: note ?? "",
      }).catch(() => [])
      for (const hookResult of hookResults) {
        ctx.host.emit({
          type: "plugin_hook",
          pluginName: hookResult.pluginName,
          hookEvent: hookResult.hookEvent,
          output: hookResult.output,
          success: hookResult.success,
        })
      }
    }
    return { success: true, output: `Updated ${member_name} to ${status}.`, metadata: { team } }
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
    if (team_name) {
      const sender = from?.trim() || "main"
      await runtime.addTeamMember(team_name, { name: sender, joinedAt: Date.now(), status: "active", lastActiveAt: Date.now() }).catch(() => null)
      await runtime.addTeamMember(team_name, { name: to, joinedAt: Date.now() }).catch(() => null)
    }
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

const remoteSessionMessageSchema = z.object({
  remote_session_id: z.string().min(1).describe("Tracked remote session id."),
  content: z.string().min(1).describe("Message to send into the remote session."),
  mode: z.enum(["agent", "plan", "ask", "debug", "review"]).optional().describe("Mode for the remote message. Defaults to agent."),
  preset_name: z.string().optional().describe("Optional preset name for the remote run."),
})

export const sendRemoteMessageTool: ToolDef<z.infer<typeof remoteSessionMessageSchema>> = {
  name: "SendRemoteMessage",
  description: "Send a new user message into a tracked remote Nexus session using the server HTTP API when available.",
  parameters: remoteSessionMessageSchema,
  shouldDefer: true,
  async execute({ remote_session_id, content, mode, preset_name }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const remoteSession = await runtime.getRemoteSession(remote_session_id)
    if (!remoteSession?.sessionId) {
      return { success: false, output: `Remote session ${remote_session_id} is missing sessionId metadata.` }
    }
    if (remoteSession.viewerOnly) {
      return { success: false, output: `Remote session ${remote_session_id} is viewer-only and cannot accept outbound messages from this client.` }
    }
    const url = new URL(remoteSession.url)
    const endpoint = `${url.protocol}//${url.host}/session/${remoteSession.sessionId}/message`
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-directory": ctx.cwd,
      },
      body: JSON.stringify({
        content,
        mode: mode ?? "agent",
        ...(preset_name ? { presetName: preset_name } : {}),
      }),
    }).catch((error: Error) => ({
      ok: false,
      status: 0,
      text: async () => error.message,
    }))
    if (!response.ok) {
      return {
        success: false,
        output: `Failed to send remote message: ${response.status} ${await response.text()}`,
      }
    }
    const nextRemote = await runtime.updateRemoteSession(remote_session_id, {
      status: "connected",
      metadata: {
        lastRemoteMessageAt: Date.now(),
        lastRemoteMessageMode: mode ?? "agent",
      },
    })
    if (nextRemote) ctx.host.emit({ type: "remote_session_updated", remoteSession: nextRemote })
    return {
      success: true,
      output: `Queued a remote message for session ${remoteSession.sessionId}.`,
      metadata: { remoteSession: nextRemote ?? remoteSession },
    }
  },
}

const remoteSessionInterruptSchema = z.object({
  remote_session_id: z.string().min(1).describe("Tracked remote session id."),
})

export const interruptRemoteSessionTool: ToolDef<z.infer<typeof remoteSessionInterruptSchema>> = {
  name: "InterruptRemoteSession",
  description: "Interrupt the currently active run for a tracked remote Nexus session using the server abort endpoint when available.",
  parameters: remoteSessionInterruptSchema,
  shouldDefer: true,
  async execute({ remote_session_id }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const remoteSession = await runtime.getRemoteSession(remote_session_id)
    if (!remoteSession?.sessionId) {
      return { success: false, output: `Remote session ${remote_session_id} is missing sessionId metadata.` }
    }
    if (remoteSession.viewerOnly) {
      return { success: false, output: `Remote session ${remote_session_id} is viewer-only and cannot be interrupted from this client.` }
    }
    const url = new URL(remoteSession.url)
    const endpoint = `${url.protocol}//${url.host}/session/${remoteSession.sessionId}/abort`
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-directory": ctx.cwd,
      },
    }).catch((error: Error) => ({
      ok: false,
      status: 0,
      text: async () => error.message,
    }))
    if (!response.ok) {
      return {
        success: false,
        output: `Failed to interrupt remote session: ${response.status} ${await response.text()}`,
      }
    }
    const nextRemote = await runtime.updateRemoteSession(remote_session_id, {
      status: "disconnected",
      metadata: {
        interruptedAt: Date.now(),
      },
    })
    if (nextRemote) ctx.host.emit({ type: "remote_session_updated", remoteSession: nextRemote })
    return {
      success: true,
      output: `Interrupt signal sent for remote session ${remoteSession.sessionId}.`,
      metadata: { remoteSession: nextRemote ?? remoteSession },
    }
  },
}

const remoteSessionReconnectSchema = z.object({
  remote_session_id: z.string().min(1).describe("Tracked remote session id."),
})

export const reconnectRemoteSessionTool: ToolDef<z.infer<typeof remoteSessionReconnectSchema>> = {
  name: "ReconnectRemoteSession",
  description: "Probe a tracked remote session endpoint and mark it connected again when the server is reachable.",
  parameters: remoteSessionReconnectSchema,
  shouldDefer: true,
  async execute({ remote_session_id }, ctx) {
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const remoteSession = await runtime.getRemoteSession(remote_session_id)
    if (!remoteSession?.sessionId) {
      return { success: false, output: `Remote session ${remote_session_id} is missing sessionId metadata.` }
    }
    const url = new URL(remoteSession.url)
    const endpoint = `${url.protocol}//${url.host}/session/${remoteSession.sessionId}`
    const response = await fetch(endpoint, {
      headers: { "x-nexus-directory": ctx.cwd },
    }).catch((error: Error) => ({
      ok: false,
      status: 0,
      text: async () => error.message,
    }))
    if (!response.ok) {
      const failed = await runtime.updateRemoteSession(remote_session_id, {
        status: "error",
        reconnectAttempts: (remoteSession.reconnectAttempts ?? 0) + 1,
        error: `Reconnect probe failed: ${response.status} ${await response.text()}`,
      })
      if (failed) ctx.host.emit({ type: "remote_session_updated", remoteSession: failed })
      return {
        success: false,
        output: `Failed to reconnect remote session: ${response.status} ${await response.text()}`,
      }
    }
    const updated = await runtime.updateRemoteSession(remote_session_id, {
      status: "connected",
      reconnectAttempts: (remoteSession.reconnectAttempts ?? 0) + 1,
      error: undefined,
      metadata: {
        lastReconnectAt: Date.now(),
      },
    })
    if (updated) ctx.host.emit({ type: "remote_session_updated", remoteSession: updated })
    return {
      success: true,
      output: `Remote session ${remoteSession.sessionId} is reachable again.`,
      metadata: { remoteSession: updated ?? remoteSession },
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
  run_in_background: z.boolean().optional().describe("Run the PowerShell command in the background and monitor it later with TaskOutput."),
})

function quoteSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export const powerShellTool: ToolDef<z.infer<typeof powershellSchema>> = {
  name: "PowerShell",
  description: "Execute a PowerShell command through pwsh/powershell with non-interactive flags.",
  parameters: powershellSchema,
  async execute({ command, timeout, run_in_background }, ctx) {
    const dedicatedToolMessage = detectPreferDedicatedToolMessage(command)
    if (dedicatedToolMessage) return { success: false, output: dedicatedToolMessage }
    const sleepWarning = detectBlockedSleepPattern(command, "powershell")
    if (run_in_background && sleepWarning) {
      return {
        success: false,
        output: `${sleepWarning} Run it in the foreground if you really need it, but do not background it.`,
      }
    }
    const dangerousMessage = detectDangerousShellPattern(command)
    const autoBackgrounded = !run_in_background && isLikelyLongRunningShellCommand(command)
    const backgrounded = run_in_background || autoBackgrounded
    if (backgrounded) {
      const shellCommand = `powershell -NoLogo -NoProfile -NonInteractive -Command ${quoteSingle(command)}`
      const { taskId, pid, logPath } = await startBackgroundShellTask({
        command: shellCommand,
        cwd: ctx.cwd,
        shellRunner: "powershell",
        host: ctx.host,
        config: ctx.config,
        metadata: {
          assistantAutoBackgrounded: autoBackgrounded,
          ...(dangerousMessage ? { dangerousWarning: dangerousMessage } : {}),
        },
      })
      return {
        success: true,
        output: `${autoBackgrounded ? "[auto-backgrounded]" : "[background]"} task_id: ${taskId}\nPID: ${pid}\nLog: ${logPath}${dangerousMessage ? `\nWarning: ${dangerousMessage}` : ""}\n\nUse TaskOutput(taskId: "${taskId}") to read progress or wait; use TaskStop(taskId: "${taskId}") to stop the process.`,
        metadata: { task_id: taskId, pid, logPath, assistantAutoBackgrounded: autoBackgrounded },
      }
    }
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
        output: `$ ${shellCommand}\n[exit: ${result.exitCode}]\n${dangerousMessage ? `[warning] ${dangerousMessage}\n` : ""}${output}`.trim(),
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
      output: agents
        .map((agent) =>
          `- ${agent.agentType}: ${agent.whenToUse}${agent.preferredMode ? ` | preferredMode=${agent.preferredMode}` : ""}${agent.hooks?.length ? ` | hooks=${agent.hooks.length}` : ""}`,
        )
        .join("\n"),
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
  hook_event: z.enum([
    "user_prompt_submit",
    "before_tool",
    "after_tool",
    "turn_complete",
    "task_completed",
    "subagent_start",
    "subagent_stop",
    "teammate_idle",
    "instructions_loaded",
  ]).describe("Hook event to execute."),
  payload: z.record(z.unknown()).optional().describe("Optional payload object passed to the hook runner."),
})

export const runPluginHookTool: ToolDef<z.infer<typeof runPluginHookSchema>> = {
  name: "RunPluginHook",
  description: "Run trusted plugin hooks for a lifecycle event such as prompt submit, before/after tool, turn completion, or task completion.",
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

const pluginEnableSchema = z.object({
  name: z.string().min(1).describe("Plugin name."),
  enabled: z.boolean().describe("Whether the plugin should be enabled at runtime."),
})

export const pluginEnableTool: ToolDef<z.infer<typeof pluginEnableSchema>> = {
  name: "PluginEnable",
  description: "Enable or disable a plugin in .nexus/nexus.yaml without removing it from disk.",
  parameters: pluginEnableSchema,
  shouldDefer: true,
  async execute({ name, enabled }, ctx) {
    await updateProjectPluginConfig(ctx.cwd, (plugins) => {
      const blocked = new Set(
        Array.isArray(plugins.blocked)
          ? plugins.blocked.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : (ctx.config.plugins?.blocked ?? []),
      )
      if (enabled) blocked.delete(name)
      else blocked.add(name)
      plugins.blocked = Array.from(blocked).sort()
    })
    return {
      success: true,
      output: enabled ? `Plugin ${name} enabled.` : `Plugin ${name} disabled.`,
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

const pluginReloadSchema = z.object({})

export const pluginReloadTool: ToolDef<z.infer<typeof pluginReloadSchema>> = {
  name: "PluginReload",
  description: "Reload plugin manifests from disk and return the active runtime view.",
  parameters: pluginReloadSchema,
  shouldDefer: true,
  async execute(_args, ctx) {
    const plugins = await loadPluginRuntimeRecords(ctx.cwd, ctx.config)
    return {
      success: true,
      output: plugins.length === 0
        ? "No plugins loaded."
        : plugins.map((plugin) => `- ${plugin.name} enabled=${plugin.runtimeEnabled !== false} trusted=${plugin.trusted === true} hooks=${plugin.hooks.length}`).join("\n"),
      metadata: { plugins },
    }
  },
}

const pluginValidateSchema = z.object({
  manifest_path: z.string().optional().describe("Optional plugin manifest path. When omitted, validate all discovered plugins."),
})

export const pluginValidateTool: ToolDef<z.infer<typeof pluginValidateSchema>> = {
  name: "PluginValidate",
  description: "Validate plugin manifests strictly, including declared file existence and hook declarations.",
  parameters: pluginValidateSchema,
  readOnly: true,
  shouldDefer: true,
  async execute({ manifest_path }, ctx) {
    const files = manifest_path
      ? [path.isAbsolute(manifest_path) ? manifest_path : path.join(ctx.cwd, manifest_path)]
      : (await loadPluginRuntimeRecords(ctx.cwd, ctx.config)).map((plugin) => plugin.sourcePath)
    if (files.length === 0) return { success: true, output: "No plugin manifests found." }
    const results = await Promise.all(files.map((file) => validatePluginManifestFile(file)))
    const success = results.every((result) => result.success)
    return {
      success,
      output: results.map((result, index) => {
        const file = files[index]
        const lines = [`## ${file}`, result.success ? "valid" : "invalid"]
        if (result.errors.length) lines.push(...result.errors.map((error) => `error: ${error}`))
        if (result.warnings.length) lines.push(...result.warnings.map((warning) => `warning: ${warning}`))
        return lines.join("\n")
      }).join("\n\n"),
      metadata: { results, files },
    }
  },
}

const pluginInstallLocalSchema = z.object({
  source_dir: z.string().min(1).describe("Existing local plugin directory to install into .nexus/plugins."),
  name: z.string().optional().describe("Optional target directory name. Defaults to the source directory name."),
  overwrite: z.boolean().optional().describe("Overwrite an existing plugin directory with the same target name."),
})

export const pluginInstallLocalTool: ToolDef<z.infer<typeof pluginInstallLocalSchema>> = {
  name: "PluginInstallLocal",
  description: "Install a local plugin directory into the project-scoped .nexus/plugins runtime.",
  parameters: pluginInstallLocalSchema,
  shouldDefer: true,
  async execute({ source_dir, name, overwrite }, ctx) {
    const sourceDir = path.isAbsolute(source_dir) ? source_dir : path.join(ctx.cwd, source_dir)
    const targetName = slugifyName(name ?? path.basename(sourceDir))
    const targetDir = path.join(ctx.cwd, ".nexus", "plugins", targetName)
    const exists = await fs.stat(targetDir).then(() => true).catch(() => false)
    if (exists && !overwrite) {
      return { success: false, output: `Target plugin directory already exists: ${targetDir}` }
    }
    const manifestCandidates = [
      path.join(sourceDir, "plugin.json"),
      path.join(sourceDir, ".nexus-plugin", "plugin.json"),
      path.join(sourceDir, ".codex-plugin", "plugin.json"),
    ]
    const sourceManifest = (
      await Promise.all(manifestCandidates.map(async (candidate) => ((await fs.stat(candidate).then(() => true).catch(() => false)) ? candidate : null)))
    ).find(Boolean)
    if (!sourceManifest) {
      return { success: false, output: `No plugin.json found in ${sourceDir}.` }
    }
    if (exists) await fs.rm(targetDir, { recursive: true, force: true })
    await copyDirectoryRecursive(sourceDir, targetDir)
    const targetManifest = path.join(targetDir, path.relative(sourceDir, sourceManifest))
    const validation = await validatePluginManifestFile(targetManifest)
    if (!validation.success) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined)
      return { success: false, output: `Installed plugin failed validation:\n${validation.errors.join("\n")}` }
    }
    return {
      success: true,
      output: `Installed plugin ${validation.plugin?.name ?? targetName} into ${targetDir}.`,
      metadata: { plugin: validation.plugin, targetDir },
    }
  },
}

const pluginRemoveSchema = z.object({
  name: z.string().min(1).describe("Plugin name."),
})

export const pluginRemoveTool: ToolDef<z.infer<typeof pluginRemoveSchema>> = {
  name: "PluginRemove",
  description: "Remove a project-scoped installed plugin directory and clear its runtime config entry.",
  parameters: pluginRemoveSchema,
  shouldDefer: true,
  async execute({ name }, ctx) {
    const plugins = await loadPluginRuntimeRecords(ctx.cwd, ctx.config)
    const plugin = plugins.find((item) => item.name === name)
    if (!plugin) return { success: false, output: `Plugin not found: ${name}` }
    if (plugin.scope !== "project") {
      return { success: false, output: `Only project-scoped plugins can be removed automatically. ${name} is ${plugin.scope}-scoped.` }
    }
    await fs.rm(plugin.rootDir, { recursive: true, force: true })
    await updateProjectPluginConfig(ctx.cwd, (pluginsConfig) => {
      const blocked = Array.isArray(pluginsConfig.blocked) ? pluginsConfig.blocked.filter((item) => item !== name) : []
      const trusted = Array.isArray(pluginsConfig.trusted) ? pluginsConfig.trusted.filter((item) => item !== name) : []
      const options = asObject(pluginsConfig.options)
      delete options[name]
      pluginsConfig.blocked = blocked
      pluginsConfig.trusted = trusted
      if (Object.keys(options).length > 0) pluginsConfig.options = options
      else delete pluginsConfig.options
    })
    return {
      success: true,
      output: `Removed plugin ${name} from ${plugin.rootDir}.`,
    }
  },
}

const planStartWorkflowSchema = z.object({
  goal: z.string().min(1).describe("Planning goal or user objective."),
  questions: z.array(z.string().min(1)).optional().describe("Optional interview questions. Defaults to a standard set."),
})

export const planStartWorkflowTool: ToolDef<z.infer<typeof planStartWorkflowSchema>> = {
  name: "PlanStartWorkflow",
  description: "Start a stateful plan workflow with interview questions before drafting the final plan.",
  parameters: planStartWorkflowSchema,
  async execute({ goal, questions }, ctx) {
    const workflow = await createPlanWorkflow(ctx.cwd, {
      goal,
      questions,
      metadata: { sessionId: ctx.session.id },
    })
    return {
      success: true,
      output: `${summarizePlanWorkflow(workflow)}\n\nInterview questions:\n${workflow.questions.map((question) => `- ${question.id}: ${question.question}`).join("\n")}`,
      metadata: { workflow },
    }
  },
}

const planGetWorkflowSchema = z.object({
  workflow_id: z.string().optional().describe("Workflow id. Defaults to the most recently updated workflow."),
})

export const planGetWorkflowTool: ToolDef<z.infer<typeof planGetWorkflowSchema>> = {
  name: "PlanGetWorkflow",
  description: "Read a plan workflow, including interview questions, research task ids, and plan file linkage.",
  parameters: planGetWorkflowSchema,
  readOnly: true,
  async execute({ workflow_id }, ctx) {
    const workflow = workflow_id
      ? await getPlanWorkflow(ctx.cwd, workflow_id)
      : (await listPlanWorkflows(ctx.cwd))[0] ?? null
    if (!workflow) return { success: false, output: "Plan workflow not found." }
    return {
      success: true,
      output: JSON.stringify(workflow, null, 2),
      metadata: { workflow },
    }
  },
}

const planAnswerWorkflowSchema = z.object({
  workflow_id: z.string().min(1).describe("Workflow id."),
  question_id: z.string().min(1).describe("Question id."),
  answer: z.string().min(1).describe("Answer text."),
})

export const planAnswerWorkflowTool: ToolDef<z.infer<typeof planAnswerWorkflowSchema>> = {
  name: "PlanAnswerWorkflow",
  description: "Record an interview answer in the active plan workflow.",
  parameters: planAnswerWorkflowSchema,
  async execute({ workflow_id, question_id, answer }, ctx) {
    const workflow = await updatePlanWorkflow(ctx.cwd, workflow_id, (current) => ({
      ...current,
      status: current.status === "interview" ? "research" : current.status,
      questions: current.questions.map((question) =>
        question.id === question_id ? { ...question, answer } : question,
      ),
    }))
    if (!workflow) return { success: false, output: `Plan workflow not found: ${workflow_id}` }
    return {
      success: true,
      output: summarizePlanWorkflow(workflow),
      metadata: { workflow },
    }
  },
}

const planCreateResearchTasksSchema = z.object({
  workflow_id: z.string().min(1).describe("Workflow id."),
  owner: z.string().optional().describe("Optional owner for generated research tasks."),
  team_name: z.string().optional().describe("Optional team name for generated research tasks."),
})

export const planCreateResearchTasksTool: ToolDef<z.infer<typeof planCreateResearchTasksSchema>> = {
  name: "PlanCreateResearchTasks",
  description: "Turn unanswered or partially answered plan workflow questions into durable tracking tasks for research waves.",
  parameters: planCreateResearchTasksSchema,
  async execute({ workflow_id, owner, team_name }, ctx) {
    const workflow = await getPlanWorkflow(ctx.cwd, workflow_id)
    if (!workflow) return { success: false, output: `Plan workflow not found: ${workflow_id}` }
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const unanswered = workflow.questions.filter((question) => !question.answer?.trim())
    if (unanswered.length === 0) {
      return { success: true, output: `Workflow ${workflow_id} has no unanswered interview questions.` }
    }
    const created: string[] = []
    for (const question of unanswered) {
      const task = await runtime.createTask({
        kind: "tracking",
        subject: `Research: ${question.question}`,
        description: question.question,
        status: "pending",
        ...(owner ? { owner } : {}),
        ...(team_name ? { teamName: team_name } : {}),
        metadata: {
          planWorkflowId: workflow_id,
          planQuestionId: question.id,
          generatedBy: "PlanCreateResearchTasks",
        },
      })
      created.push(task.id)
      ctx.host.emit({ type: "task_created", task })
    }
    const updated = await updatePlanWorkflow(ctx.cwd, workflow_id, (current) => ({
      ...current,
      status: "research",
      researchTaskIds: Array.from(new Set([...current.researchTaskIds, ...created])),
    }))
    return {
      success: true,
      output: `Created ${created.length} research task(s) for workflow ${workflow_id}.\n${created.map((id) => `- ${id}`).join("\n")}`,
      metadata: { workflow: updated ?? workflow, taskIds: created },
    }
  },
}

const planDraftWorkflowSchema = z.object({
  workflow_id: z.string().min(1).describe("Workflow id."),
  file_name: z.string().optional().describe("Optional plan file name under .nexus/plans/."),
})

export const planDraftWorkflowTool: ToolDef<z.infer<typeof planDraftWorkflowSchema>> = {
  name: "PlanDraftWorkflow",
  description: "Draft a plan markdown file from a plan workflow interview and linked research tasks.",
  parameters: planDraftWorkflowSchema,
  async execute({ workflow_id, file_name }, ctx) {
    const workflow = await getPlanWorkflow(ctx.cwd, workflow_id)
    if (!workflow) return { success: false, output: `Plan workflow not found: ${workflow_id}` }
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const researchTasks = await Promise.all(workflow.researchTaskIds.map((taskId) => runtime.getTask(taskId)))
    const planDir = path.join(ctx.cwd, ".nexus", "plans")
    await fs.mkdir(planDir, { recursive: true })
    const filePath = path.join(planDir, file_name?.trim() || `${workflow.id}.md`)
    const content = [
      `# Plan: ${workflow.goal}`,
      "",
      "## Interview",
      ...workflow.questions.map((question) => `- ${question.question}\n  - Answer: ${question.answer?.trim() || "(pending)"}`),
      "",
      "## Research Tasks",
      ...(researchTasks.filter(Boolean).length
        ? researchTasks.filter(Boolean).map((task) => `- [${task?.status}] ${task?.subject}${task?.id ? ` (${task.id})` : ""}`)
        : ["- none"]),
      "",
      "## Milestones",
      ...workflow.questions.map((question, index) => `${index + 1}. ${question.answer?.trim() || question.question}`),
      "",
      "## Validation",
      "- Run targeted tests/typechecks for the changed areas.",
      "- Verify the user-visible objective is satisfied end-to-end.",
      "",
      "## Risks",
      "- Review cross-cutting impacts in the affected code areas before merging.",
    ].join("\n")
    await fs.writeFile(filePath, content, "utf8")
    const updated = await updatePlanWorkflow(ctx.cwd, workflow_id, (current) => ({
      ...current,
      status: "ready",
      planFile: filePath,
    }))
    return {
      success: true,
      output: `Drafted plan file ${filePath} from workflow ${workflow_id}.`,
      metadata: { workflow: updated ?? workflow, filePath },
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

const planVerifyExecutionSchema = z.object({
  file_path: z.string().optional().describe("Optional path to a plan markdown file. Defaults to the newest file under .nexus/plans/."),
  owner: z.string().optional().describe("Optional owner filter for matching tasks."),
  team_name: z.string().optional().describe("Optional team filter for matching tasks."),
})

export const planVerifyExecutionTool: ToolDef<z.infer<typeof planVerifyExecutionSchema>> = {
  name: "PlanVerifyExecution",
  description: "Compare a written plan against orchestration tasks and report which plan items are still missing or incomplete.",
  parameters: planVerifyExecutionSchema,
  readOnly: true,
  async execute({ file_path, owner, team_name }, ctx) {
    const planFile = await resolvePlanFile(ctx.cwd, file_path)
    if (!planFile) return { success: false, output: "No plan file found to verify." }
    const planText = await fs.readFile(planFile, "utf8")
    const planItems = parsePlanTasks(planText)
    if (planItems.length === 0) return { success: false, output: `No checklist or section items found in ${planFile}.` }
    const runtime = await getOrchestrationRuntime(ctx.cwd)
    const tasks = await runtime.listTasks({
      ...(owner ? { owner } : {}),
      ...(team_name ? { teamName: team_name } : {}),
      includeDeleted: false,
    })
    const rows = planItems.map((item) => {
      const match = tasks.find((task) => task.subject === item || task.description === item)
      if (!match) return `- missing | ${item}`
      return `- ${match.status.padEnd(11, " ")} | ${item} | ${match.id}`
    })
    const incomplete = rows.filter((row) => !row.startsWith("- completed"))
    return {
      success: incomplete.length === 0,
      output: `Plan file: ${planFile}\n\n${rows.join("\n")}\n\n${incomplete.length === 0 ? "All plan items have matching completed tasks." : `${incomplete.length} item(s) still need attention.`}`,
      metadata: { planFile, items: planItems, tasks },
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
