import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { IHost, NexusConfig, PluginManifestRecord } from "../types.js"
import { loadPluginManifests, resolvePluginDeclaredPath } from "./index.js"
import { getClaudeCompatibilityOptions } from "../compat/claude.js"

export interface PluginHookExecution {
  pluginName: string
  hookEvent: string
  success: boolean
  output: string
  preventContinuation?: boolean
  stopReason?: string
  additionalContext?: string
}

export type PluginHookEvent =
  | "user_prompt_submit"
  | "before_tool"
  | "after_tool"
  | "turn_complete"
  | "task_completed"
  | "subagent_start"
  | "subagent_stop"
  | "teammate_idle"
  /** Fired once per agent run when the instruction bundle is active (observability; OpenClaude instructions_loaded parity). */
  | "instructions_loaded"

const OPENCLAUDE_EVENT_MAP: Record<string, PluginHookEvent> = {
  PreToolUse: "before_tool",
  PostToolUse: "after_tool",
  PostToolUseFailure: "after_tool",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "turn_complete",
  StopFailure: "turn_complete",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  TeammateIdle: "teammate_idle",
  TaskCompleted: "task_completed",
  InstructionsLoaded: "instructions_loaded",
}

const completedOneShotHooks = new Set<string>()
const MAX_COMPLETED_ONE_SHOT_HOOKS = 10_000

function oneShotSessionKey(payload: Record<string, unknown>): string {
  return typeof payload.sessionId === "string" && payload.sessionId.trim()
    ? payload.sessionId
    : "unscoped"
}

function rememberCompletedOneShotHook(key: string): void {
  completedOneShotHooks.add(key)
  while (completedOneShotHooks.size > MAX_COMPLETED_ONE_SHOT_HOOKS) {
    const oldest = completedOneShotHooks.values().next().value as string | undefined
    if (!oldest) break
    completedOneShotHooks.delete(oldest)
  }
}

export function applyPluginRuntimeSettings(
  plugin: PluginManifestRecord,
  config: NexusConfig,
): PluginManifestRecord {
  const pluginsConfig = config.plugins
  const blocked = new Set(pluginsConfig?.blocked ?? [])
  const trusted = new Set(pluginsConfig?.trusted ?? [])
  const runtimeEnabled = (pluginsConfig?.enabled ?? true) && !blocked.has(plugin.name) && plugin.enabled !== false
  return {
    ...plugin,
    runtimeEnabled,
    trusted: trusted.has(plugin.name),
    options: pluginsConfig?.options?.[plugin.name] ?? {},
  }
}

export async function loadPluginRuntimeRecords(
  cwd: string,
  config: NexusConfig,
): Promise<PluginManifestRecord[]> {
  const manifests = await loadPluginManifests(cwd, getClaudeCompatibilityOptions(config))
  return manifests.map((plugin) => applyPluginRuntimeSettings(plugin, config))
}

/** Capabilities from project-controlled plugins are active only after explicit trust. */
export async function loadTrustedPluginRuntimeRecords(
  cwd: string,
  config: NexusConfig,
): Promise<PluginManifestRecord[]> {
  return (await loadPluginRuntimeRecords(cwd, config)).filter(
    (plugin) => plugin.runtimeEnabled !== false && plugin.trusted === true,
  )
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function getHookRunnerCommand(hookPath: string, payloadPath: string): string {
  const quotedHook = quoteShellArgument(hookPath)
  const quotedPayload = quoteShellArgument(payloadPath)
  const ext = path.extname(hookPath).toLowerCase()
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return `node ${quotedHook} ${quotedPayload}`
  if (ext === ".py") return `python ${quotedHook} ${quotedPayload}`
  if (ext === ".sh" || ext === ".bash") return `bash ${quotedHook} ${quotedPayload}`
  return `${quotedHook} ${quotedPayload}`
}

function splitHookDeclaration(value: string): { hookEvent: string; relativePath: string } {
  const trimmed = value.trim()
  const idx = trimmed.indexOf(":")
  if (idx === -1) return { hookEvent: "after_tool", relativePath: trimmed }
  return {
    hookEvent: trimmed.slice(0, idx).trim() || "after_tool",
    relativePath: trimmed.slice(idx + 1).trim(),
  }
}

function parseHookResponse(stdout: string, stderr: string): {
  output: string
  preventContinuation?: boolean
  stopReason?: string
  additionalContext?: string
} {
  const trimmedStdout = stdout.trim()
  const trimmedStderr = stderr.trim()
  if (trimmedStdout) {
    try {
      const parsed = JSON.parse(trimmedStdout) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const output =
          typeof parsed.output === "string" ? parsed.output :
          typeof parsed.message === "string" ? parsed.message :
          typeof parsed.text === "string" ? parsed.text :
          trimmedStderr
        return {
          output: output.trim(),
          ...(typeof parsed.preventContinuation === "boolean"
            ? { preventContinuation: parsed.preventContinuation }
            : parsed.continue === false || parsed.decision === "block"
              ? { preventContinuation: true }
              : {}),
          ...(typeof parsed.stopReason === "string" && parsed.stopReason.trim()
            ? { stopReason: parsed.stopReason.trim() }
            : typeof parsed.reason === "string" && parsed.reason.trim()
              ? { stopReason: parsed.reason.trim() }
              : {}),
          ...(typeof parsed.additionalContext === "string" && parsed.additionalContext.trim()
            ? { additionalContext: parsed.additionalContext.trim() }
            : asRecord(parsed.hookSpecificOutput)?.additionalContext &&
                typeof asRecord(parsed.hookSpecificOutput)?.additionalContext === "string"
              ? { additionalContext: String(asRecord(parsed.hookSpecificOutput)?.additionalContext).trim() }
            : {}),
        }
      }
    } catch {
      // Plain-text hook output.
    }
  }
  return {
    output: [trimmedStdout, trimmedStderr].filter(Boolean).join("\n").trim(),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function matcherApplies(matcher: unknown, payload: Record<string, unknown>): boolean {
  if (typeof matcher !== "string" || matcher.trim() === "") return true
  const toolName = typeof payload.toolName === "string"
    ? payload.toolName
    : typeof payload.tool_name === "string"
      ? payload.tool_name
      : ""
  if (!toolName) return false
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return matcher === toolName
  }
}

type OpenClaudeHookDeclaration = {
  plugin: PluginManifestRecord
  sourcePath: string
  sourceEvent: string
  matcherIndex: number
  hookIndex: number
  hook: Record<string, unknown>
}

async function loadOpenClaudeHookDeclarations(
  plugins: PluginManifestRecord[],
  hookEvent: PluginHookEvent,
  payload: Record<string, unknown>,
): Promise<OpenClaudeHookDeclaration[]> {
  const declarations: OpenClaudeHookDeclaration[] = []
  for (const plugin of plugins) {
    const configs: Array<{ sourcePath: string; parsed: unknown }> = []
    for (const declared of plugin.hooks.filter((item) => item.toLowerCase().endsWith(".json"))) {
      const sourcePath = resolvePluginDeclaredPath(plugin, declared)
      try {
        configs.push({
          sourcePath,
          parsed: JSON.parse(await fs.readFile(sourcePath, "utf8")),
        })
      } catch {
        continue
      }
    }
    for (const [index, parsed] of (plugin.inlineHookConfigs ?? []).entries()) {
      configs.push({ sourcePath: `${plugin.sourcePath}#hooks.${index}`, parsed })
    }
    for (const { sourcePath, parsed } of configs) {
      const root = asRecord(parsed)
      const hookConfig = asRecord(root?.hooks) ?? root
      if (!hookConfig) continue
      for (const [sourceEvent, rawMatchers] of Object.entries(hookConfig)) {
        if (OPENCLAUDE_EVENT_MAP[sourceEvent] !== hookEvent || !Array.isArray(rawMatchers)) continue
        for (let matcherIndex = 0; matcherIndex < rawMatchers.length; matcherIndex += 1) {
          const matcher = asRecord(rawMatchers[matcherIndex])
          if (!matcher || !matcherApplies(matcher.matcher, payload) || !Array.isArray(matcher.hooks)) continue
          for (let hookIndex = 0; hookIndex < matcher.hooks.length; hookIndex += 1) {
            const hook = asRecord(matcher.hooks[hookIndex])
            if (hook) {
              declarations.push({
                plugin,
                sourcePath,
                sourceEvent,
                matcherIndex,
                hookIndex,
                hook,
              })
            }
          }
        }
      }
    }
  }
  return declarations
}

function openClaudePayload(
  hookEvent: PluginHookEvent,
  sourceEvent: string,
  cwd: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hook_event_name: sourceEvent,
    cwd,
    ...payload,
    ...(typeof payload.toolName === "string" ? { tool_name: payload.toolName } : {}),
    ...(payload.toolInput !== undefined ? { tool_input: payload.toolInput } : {}),
    nexus: { hookEvent, payload },
  }
}

function interpolateAllowedHeaderValue(
  value: string,
  allowedEnvVars: Set<string>,
): string {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, plain) => {
    const name = String(braced ?? plain)
    return allowedEnvVars.has(name) ? (process.env[name] ?? "") : ""
  })
}

async function runOpenClaudeHookDeclarations(
  cwd: string,
  host: IHost,
  timeoutMs: number,
  hookEvent: PluginHookEvent,
  payload: Record<string, unknown>,
  plugins: PluginManifestRecord[],
): Promise<PluginHookExecution[]> {
  const declarations = await loadOpenClaudeHookDeclarations(plugins, hookEvent, payload)
  if (declarations.length === 0) return []
  const payloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-openclaude-hooks-"))
  const executions: PluginHookExecution[] = []
  try {
    for (const declaration of declarations) {
      const oneShotKey = [
        oneShotSessionKey(payload),
        declaration.plugin.sourcePath,
        declaration.sourcePath,
        declaration.sourceEvent,
        declaration.matcherIndex,
        declaration.hookIndex,
      ].join(":")
      if (declaration.hook.once === true && completedOneShotHooks.has(oneShotKey)) continue
      const payloadPath = path.join(payloadDir, `payload-${executions.length}.json`)
      await fs.writeFile(
        payloadPath,
        JSON.stringify(
          openClaudePayload(hookEvent, declaration.sourceEvent, cwd, payload),
          null,
          2,
        ),
        "utf8",
      )
      const type = declaration.hook.type
      if (type === "http") {
        const url = typeof declaration.hook.url === "string" ? declaration.hook.url : ""
        if (!/^https?:\/\//i.test(url)) {
          executions.push({
            pluginName: declaration.plugin.name,
            hookEvent,
            success: false,
            output: "OpenClaude HTTP hook requires an http(s) URL.",
          })
          continue
        }
        const hookTimeoutMs =
          typeof declaration.hook.timeout === "number" && Number.isFinite(declaration.hook.timeout)
            ? Math.max(1, Math.min(300, declaration.hook.timeout)) * 1000
            : timeoutMs
        const allowedEnvVars = new Set(
          Array.isArray(declaration.hook.allowedEnvVars)
            ? declaration.hook.allowedEnvVars.filter((item): item is string => typeof item === "string")
            : [],
        )
        const declaredHeaders = asRecord(declaration.hook.headers) ?? {}
        const headers = Object.fromEntries(
          Object.entries(declaredHeaders)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(([name, value]) => [
              name,
              interpolateAllowedHeaderValue(value, allowedEnvVars),
            ]),
        )
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), hookTimeoutMs)
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: await fs.readFile(payloadPath, "utf8"),
            signal: controller.signal,
          })
          const responseText = (await response.text()).slice(0, 1_000_000)
          const parsed = parseHookResponse(responseText, response.ok ? "" : `HTTP ${response.status}`)
          const blocked = parsed.preventContinuation === true
          executions.push({
            pluginName: declaration.plugin.name,
            hookEvent,
            success: response.ok,
            output: parsed.output,
            ...(blocked ? { preventContinuation: true } : {}),
            ...(parsed.stopReason ? { stopReason: parsed.stopReason } : {}),
            ...(parsed.additionalContext ? { additionalContext: parsed.additionalContext } : {}),
          })
          if (declaration.hook.once === true && response.ok) {
            rememberCompletedOneShotHook(oneShotKey)
          }
        } catch (error) {
          executions.push({
            pluginName: declaration.plugin.name,
            hookEvent,
            success: false,
            output: error instanceof Error && error.name === "AbortError"
              ? `Hook timed out after ${hookTimeoutMs}ms.`
              : error instanceof Error
                ? error.message
                : String(error),
          })
        } finally {
          clearTimeout(timeout)
        }
        continue
      }
      if (type !== "command") {
        executions.push({
          pluginName: declaration.plugin.name,
          hookEvent,
          success: false,
          output: `Unsupported OpenClaude hook type: ${String(type ?? "unknown")}. Nexus currently executes command and HTTP hooks.`,
        })
        continue
      }
      const declaredCommand = typeof declaration.hook.command === "string"
        ? declaration.hook.command.trim()
        : ""
      if (!declaredCommand) {
        executions.push({
          pluginName: declaration.plugin.name,
          hookEvent,
          success: false,
          output: "OpenClaude command hook is missing command.",
        })
        continue
      }
      const root = await fs.realpath(declaration.plugin.rootDir)
      const rootArg = quoteShellArgument(root)
      const command = [
        `export CLAUDE_PLUGIN_ROOT=${rootArg}`,
        `export CODEX_PLUGIN_ROOT=${rootArg}`,
        `export NEXUS_PLUGIN_ROOT=${rootArg}`,
        `${declaredCommand} < ${quoteShellArgument(payloadPath)}`,
      ].join("; ")
      const hookTimeoutMs =
        typeof declaration.hook.timeout === "number" && Number.isFinite(declaration.hook.timeout)
          ? Math.max(1, Math.min(300, declaration.hook.timeout)) * 1000
          : timeoutMs
      const abortController = new AbortController()
      const timeout = setTimeout(() => abortController.abort(), hookTimeoutMs)
      const result = await host.runCommand(command, root, abortController.signal).catch((error: Error) => ({
        stdout: "",
        stderr: error.name === "AbortError"
          ? `Hook timed out after ${hookTimeoutMs}ms.`
          : error.message,
        exitCode: 1,
      }))
      clearTimeout(timeout)
      const parsed = parseHookResponse(result.stdout, result.stderr)
      const blocked = result.exitCode === 2 || parsed.preventContinuation === true
      const output = parsed.output || (blocked ? "Plugin hook blocked continuation." : "")
      executions.push({
        pluginName: declaration.plugin.name,
        hookEvent,
        success: result.exitCode === 0,
        output,
        ...(blocked ? { preventContinuation: true } : {}),
        ...(parsed.stopReason
          ? { stopReason: parsed.stopReason }
          : blocked && output
            ? { stopReason: output }
            : {}),
        ...(parsed.additionalContext ? { additionalContext: parsed.additionalContext } : {}),
      })
      if (declaration.hook.once === true && result.exitCode === 0) {
        rememberCompletedOneShotHook(oneShotKey)
      }
    }
  } finally {
    await fs.rm(payloadDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return executions
}

async function runHookDeclarations(
  cwd: string,
  host: IHost,
  timeoutMs: number,
  hookEvent: PluginHookEvent,
  payload: Record<string, unknown>,
  items: Array<{ name: string; hooks: string[] }>,
  resolveHookPath: (
    item: { name: string; hooks: string[] },
    relativePath: string,
  ) => string | Promise<string>,
  options: { requireApproval?: boolean } = {},
): Promise<PluginHookExecution[]> {
  if (items.length === 0) return []
  const payloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-hooks-"))
  const payloadPath = path.join(payloadDir, "payload.json")
  await fs.writeFile(payloadPath, JSON.stringify({ hookEvent, cwd, payload }, null, 2), "utf8")

  const executions: PluginHookExecution[] = []
  try {
    for (const item of items) {
      for (const declared of item.hooks) {
        const parsed = splitHookDeclaration(declared)
        if (parsed.hookEvent !== hookEvent || !parsed.relativePath) continue
        let hookPath: string
        try {
          hookPath = await resolveHookPath(item, parsed.relativePath)
        } catch (error) {
          executions.push({
            pluginName: item.name,
            hookEvent,
            success: false,
            output: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (options.requireApproval) {
          const action = {
            type: "plugin" as const,
            tool: `AgentHook:${item.name}`,
            description: `Run ${hookEvent} hook for agent ${item.name}: ${parsed.relativePath}`,
            content: hookPath,
            warning: "Agent-definition hooks execute local code with the host process permissions.",
          }
          const approval = await host.showApprovalDialog(action)
          if (!approval.approved) {
            executions.push({
              pluginName: item.name,
              hookEvent,
              success: false,
              output: `User denied agent hook execution: ${parsed.relativePath}`,
            })
            continue
          }
        }
        const command = getHookRunnerCommand(hookPath, payloadPath)
        const abortController = new AbortController()
        const timeout = setTimeout(() => abortController.abort(), timeoutMs)
        const result = await host.runCommand(command, cwd, abortController.signal).catch((error: Error) => ({
          stdout: "",
          stderr: error.name === "AbortError"
            ? `Hook timed out after ${timeoutMs}ms.`
            : error.message,
          exitCode: 1,
        }))
        clearTimeout(timeout)
        const parsedResult = parseHookResponse(result.stdout, result.stderr)
        executions.push({
          pluginName: item.name,
          hookEvent,
          success: result.exitCode === 0,
          output: parsedResult.output,
          ...(typeof parsedResult.preventContinuation === "boolean"
            ? { preventContinuation: parsedResult.preventContinuation }
            : {}),
          ...(parsedResult.stopReason ? { stopReason: parsedResult.stopReason } : {}),
          ...(parsedResult.additionalContext ? { additionalContext: parsedResult.additionalContext } : {}),
        })
      }
    }
  } finally {
    await fs.rm(payloadDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return executions.filter(
    (execution) =>
      execution.output.trim().length > 0 ||
      execution.success === false ||
      execution.preventContinuation === true ||
      Boolean(execution.additionalContext),
  )
}

export async function runPluginHooks(
  cwd: string,
  host: IHost,
  config: NexusConfig,
  hookEvent: PluginHookEvent,
  payload: Record<string, unknown>,
): Promise<PluginHookExecution[]> {
  if (config.plugins?.enableHooks === false) return []
  const plugins = await loadPluginRuntimeRecords(cwd, config)
  const trusted = plugins.filter((plugin) => plugin.runtimeEnabled !== false && plugin.trusted === true)
  const timeoutMs = config.plugins?.hookTimeoutMs ?? 15_000
  const [legacy, openClaude] = await Promise.all([
    runHookDeclarations(
      cwd,
      host,
      timeoutMs,
      hookEvent,
      payload,
      trusted.map((plugin) => ({
        name: plugin.name,
        hooks: plugin.hooks.filter((item) => !item.toLowerCase().endsWith(".json")),
      })),
      (item, relativePath) => {
        const plugin = trusted.find((candidate) => candidate.name === item.name)!
        return resolvePluginDeclaredPath(plugin, relativePath)
      },
    ),
    runOpenClaudeHookDeclarations(cwd, host, timeoutMs, hookEvent, payload, trusted),
  ])
  return [...legacy, ...openClaude]
}

export async function runScopedHooks(
  cwd: string,
  host: IHost,
  hookEvent: PluginHookEvent,
  payload: Record<string, unknown>,
  items: Array<{ name: string; rootDir: string; hooks: string[] }>,
): Promise<PluginHookExecution[]> {
  return runHookDeclarations(
    cwd,
    host,
    15_000,
    hookEvent,
    payload,
    items.map((item) => ({ name: item.name, hooks: item.hooks })),
    async (item, relativePath) => {
      const source = items.find((candidate) => candidate.name === item.name)!
      const declaredRoot = path.resolve(source.rootDir)
      const declaredTarget = path.resolve(declaredRoot, relativePath)
      const relative = path.relative(declaredRoot, declaredTarget)
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Scoped hook path escapes agent root: ${relativePath}`)
      }
      const canonicalRoot = await fs.realpath(declaredRoot)
      const canonicalTarget = await fs.realpath(declaredTarget).catch(() => {
        throw new Error(`Scoped hook path does not exist: ${relativePath}`)
      })
      const canonicalRelative = path.relative(canonicalRoot, canonicalTarget)
      if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
        throw new Error(`Scoped hook symlink escapes agent root: ${relativePath}`)
      }
      return canonicalTarget
    },
    { requireApproval: true },
  )
}
