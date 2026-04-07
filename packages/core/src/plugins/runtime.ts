import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { IHost, NexusConfig, PluginManifestRecord } from "../types.js"
import { getRuntimeDir } from "../orchestration/runtime.js"
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

function getHookRunnerCommand(hookPath: string, payloadPath: string): string {
  const quotedHook = `"${hookPath.replace(/"/g, '\\"')}"`
  const quotedPayload = `"${payloadPath.replace(/"/g, '\\"')}"`
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
          ...(typeof parsed.preventContinuation === "boolean" ? { preventContinuation: parsed.preventContinuation } : {}),
          ...(typeof parsed.stopReason === "string" && parsed.stopReason.trim() ? { stopReason: parsed.stopReason.trim() } : {}),
          ...(typeof parsed.additionalContext === "string" && parsed.additionalContext.trim()
            ? { additionalContext: parsed.additionalContext.trim() }
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

async function runHookDeclarations(
  cwd: string,
  host: IHost,
  timeoutMs: number,
  hookEvent: PluginHookEvent,
  payload: Record<string, unknown>,
  items: Array<{ name: string; hooks: string[] }>,
  resolveHookPath: (item: { name: string; hooks: string[] }, relativePath: string) => string,
): Promise<PluginHookExecution[]> {
  if (items.length === 0) return []
  const payloadDir = path.join(getRuntimeDir(cwd), "hooks")
  await fs.mkdir(payloadDir, { recursive: true })
  const payloadPath = path.join(payloadDir, `hook-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  await fs.writeFile(payloadPath, JSON.stringify({ hookEvent, cwd, payload }, null, 2), "utf8")

  const executions: PluginHookExecution[] = []
  try {
    for (const item of items) {
      for (const declared of item.hooks) {
        const parsed = splitHookDeclaration(declared)
        if (parsed.hookEvent !== hookEvent || !parsed.relativePath) continue
        const hookPath = resolveHookPath(item, parsed.relativePath)
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
    await fs.rm(payloadPath, { force: true }).catch(() => undefined)
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
  return runHookDeclarations(
    cwd,
    host,
    config.plugins?.hookTimeoutMs ?? 15_000,
    hookEvent,
    payload,
    trusted.map((plugin) => ({ name: plugin.name, hooks: plugin.hooks })),
    (item, relativePath) => {
      const plugin = trusted.find((candidate) => candidate.name === item.name)!
      return resolvePluginDeclaredPath(plugin, relativePath)
    },
  )
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
    (item, relativePath) => {
      const source = items.find((candidate) => candidate.name === item.name)!
      return path.resolve(source.rootDir, relativePath)
    },
  )
}
