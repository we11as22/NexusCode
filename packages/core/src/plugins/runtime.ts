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

export async function runPluginHooks(
  cwd: string,
  host: IHost,
  config: NexusConfig,
  hookEvent: "user_prompt_submit" | "before_tool" | "after_tool",
  payload: Record<string, unknown>,
): Promise<PluginHookExecution[]> {
  if (config.plugins?.enableHooks === false) return []
  const plugins = await loadPluginRuntimeRecords(cwd, config)
  const trusted = plugins.filter((plugin) => plugin.runtimeEnabled !== false && plugin.trusted === true)
  if (trusted.length === 0) return []

  const payloadDir = path.join(getRuntimeDir(cwd), "hooks")
  await fs.mkdir(payloadDir, { recursive: true })
  const payloadPath = path.join(payloadDir, `hook-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  await fs.writeFile(payloadPath, JSON.stringify({ hookEvent, cwd, payload }, null, 2), "utf8")

  const executions: PluginHookExecution[] = []
  try {
    for (const plugin of trusted) {
      for (const declared of plugin.hooks) {
        const parsed = splitHookDeclaration(declared)
        if (parsed.hookEvent !== hookEvent || !parsed.relativePath) continue
        const hookPath = resolvePluginDeclaredPath(plugin, parsed.relativePath)
        const command = getHookRunnerCommand(hookPath, payloadPath)
        const result = await host.runCommand(command, cwd)
        executions.push({
          pluginName: plugin.name,
          hookEvent,
          success: result.exitCode === 0,
          output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        })
      }
    }
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => undefined)
  }
  return executions.filter((execution) => execution.output.trim().length > 0 || execution.success === false)
}
