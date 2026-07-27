import { MODES, type ToolDef, Mode, NexusConfig } from "../types.js"
import {
  getBuiltinToolsForMode,
  getBlockedToolsForMode,
  getRetiredBuiltinToolNames,
  isDynamicToolAllowedInMode,
} from "../agent/modes.js"
import { getAllBuiltinTools } from "./built-in/index.js"
import { canonicalizeToolName, resolveToolNameAlias } from "./aliases.js"

export type RegistrationResult =
  | { ok: true; replaced: false }
  | { ok: false; reason: "reserved-name" | "duplicate" }

/**
 * Tool registry — manages built-in, MCP, and custom tools.
 * Static, manager-bound, and dynamic tools use separate registration paths so
 * a reserved name cannot be silently discarded or replaced.
 */
export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map()
  private static staticBuiltinNames: Set<string> | undefined
  private static reservedBuiltinNames: Set<string> | undefined
  private static canonicalReservedBuiltinNames: Set<string> | undefined

  private static getStaticBuiltinNames(): Set<string> {
    if (!this.staticBuiltinNames) {
      this.staticBuiltinNames = new Set(
        getAllBuiltinTools().map((tool) => tool.name),
      )
    }
    return this.staticBuiltinNames
  }

  private static getReservedBuiltinNames(): Set<string> {
    if (!this.reservedBuiltinNames) {
      this.reservedBuiltinNames = new Set([
        ...this.getStaticBuiltinNames(),
        ...MODES.flatMap((mode) => getBuiltinToolsForMode(mode)),
        ...getRetiredBuiltinToolNames(),
      ])
    }
    return this.reservedBuiltinNames
  }

  private static isReservedBuiltinName(name: string): boolean {
    const reserved = this.getReservedBuiltinNames()
    const resolved = resolveToolNameAlias(name)
    if (reserved.has(name) || reserved.has(resolved)) return true
    if (!this.canonicalReservedBuiltinNames) {
      this.canonicalReservedBuiltinNames = new Set(
        Array.from(reserved, canonicalizeToolName),
      )
    }
    return this.canonicalReservedBuiltinNames.has(canonicalizeToolName(name))
  }

  constructor() {
    for (const tool of getAllBuiltinTools()) {
      this.tools.set(tool.name, tool)
    }
  }

  registerDynamic(tool: ToolDef): RegistrationResult {
    if (ToolRegistry.isReservedBuiltinName(tool.name)) {
      return { ok: false, reason: "reserved-name" }
    }
    if (this.tools.has(tool.name)) {
      return { ok: false, reason: "duplicate" }
    }
    this.tools.set(tool.name, tool)
    return { ok: true, replaced: false }
  }

  registerBoundBuiltin(tool: ToolDef): RegistrationResult {
    if (
      !ToolRegistry.getReservedBuiltinNames().has(tool.name) ||
      ToolRegistry.getStaticBuiltinNames().has(tool.name)
    ) {
      return {
        ok: false,
        reason: this.tools.has(tool.name) ? "duplicate" : "reserved-name",
      }
    }
    if (this.tools.has(tool.name)) {
      return { ok: false, reason: "duplicate" }
    }
    this.tools.set(tool.name, tool)
    return { ok: true, replaced: false }
  }

  registerDynamicOrThrow(tool: ToolDef, source = "dynamic"): void {
    this.throwOnRegistrationFailure(
      tool,
      source,
      this.registerDynamic(tool),
    )
  }

  registerBoundBuiltinOrThrow(tool: ToolDef, source = "bound built-in"): void {
    this.throwOnRegistrationFailure(
      tool,
      source,
      this.registerBoundBuiltin(tool),
    )
  }

  /** @deprecated Use registerDynamic or registerBoundBuiltin explicitly. */
  register(tool: ToolDef): RegistrationResult {
    return this.registerDynamic(tool)
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values())
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  getByNames(names: string[]): ToolDef[] {
    return names.flatMap(n => {
      const t = this.tools.get(n)
      return t ? [t] : []
    })
  }

  /**
   * Get tools for a given mode.
   * Built-in tools for the mode are always included.
   * Additional MCP/custom tools are returned separately for optional classification.
   */
  getForMode(mode: Mode): { builtin: ToolDef[]; dynamic: ToolDef[] } {
    const builtinNames = new Set(getBuiltinToolsForMode(mode))
    const blockedNames = getBlockedToolsForMode(mode)
    const reservedBuiltinNames = ToolRegistry.getReservedBuiltinNames()
    const builtin: ToolDef[] = []
    const dynamic: ToolDef[] = []

    for (const tool of this.tools.values()) {
      if (tool.hiddenFromAgent) continue
      if (reservedBuiltinNames.has(tool.name)) {
        if (!builtinNames.has(tool.name) || blockedNames.has(tool.name)) continue
        builtin.push(tool)
      } else {
        if (
          blockedNames.has(tool.name) ||
          !isDynamicToolAllowedInMode(tool, mode)
        ) continue
        dynamic.push(tool)
      }
    }

    return { builtin, dynamic }
  }

  /**
   * Append tools with `hiddenFromAgent` (e.g. legacy Spawn*, BashOutput) so old transcript tool
   * names still execute, while {@link getForMode} keeps them out of the LLM manifest.
   */
  mergeWithHiddenExecutionTools(visibleTools: ToolDef[]): ToolDef[] {
    const seen = new Set(visibleTools.map((t) => t.name))
    const out = [...visibleTools]
    for (const tool of this.tools.values()) {
      if (!tool.hiddenFromAgent || seen.has(tool.name)) continue
      out.push(tool)
      seen.add(tool.name)
    }
    return out
  }

  /**
   * Load custom tools from JS/TS files.
   * Custom tools export a default ToolDef or array of ToolDef.
   */
  async loadFromDirectory(dir: string): Promise<void> {
    try {
      const { readdir } = await import("node:fs/promises")
      const { join } = await import("node:path")
      const files = await readdir(dir).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith(".js") && !file.endsWith(".ts")) continue
        try {
          const mod = await import(join(dir, file))
          const exported = mod.default ?? mod
          if (Array.isArray(exported)) {
            for (const tool of exported) {
              if (isToolDef(tool)) this.warnOnRegistrationFailure(tool, this.registerDynamic(tool))
            }
          } else if (isToolDef(exported)) {
            this.warnOnRegistrationFailure(exported, this.registerDynamic(exported))
          }
        } catch (err) {
          console.warn(`[nexus] Failed to load custom tool ${file}:`, err)
        }
      }
    } catch {}
  }

  private warnOnRegistrationFailure(tool: ToolDef, result: RegistrationResult): void {
    if (result.ok) return
    console.warn(
      `[nexus] Custom tool "${tool.name}" was not registered (${result.reason}).`,
    )
  }

  private throwOnRegistrationFailure(
    tool: ToolDef,
    source: string,
    result: RegistrationResult,
  ): void {
    if (result.ok) return
    throw new Error(
      `[nexus] Failed to register ${source} tool "${tool.name}": ${result.reason}`,
    )
  }
}

function isToolDef(obj: unknown): obj is ToolDef {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as ToolDef).name === "string" &&
    typeof (obj as ToolDef).description === "string" &&
    typeof (obj as ToolDef).execute === "function"
  )
}
