import { MODES, type ToolDef, Mode, NexusConfig } from "../types.js"
import { getBuiltinToolsForMode } from "../agent/modes.js"
import { getAllBuiltinTools } from "./built-in/index.js"

/**
 * Tool registry — manages built-in, MCP, and custom tools.
 * Built-in tools are never overwritten by MCP/custom registration (same name = keep built-in).
 */
export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map()
  private static readonly BUILTIN_NAMES = new Set([
    ...getAllBuiltinTools().map((t) => t.name),
    ...MODES.flatMap((mode) => getBuiltinToolsForMode(mode)),
  ])

  constructor() {
    for (const tool of getAllBuiltinTools()) {
      this.tools.set(tool.name, tool)
    }
  }

  register(tool: ToolDef): void {
    if (ToolRegistry.BUILTIN_NAMES.has(tool.name)) return
    this.tools.set(tool.name, tool)
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
    const builtin: ToolDef[] = []
    const dynamic: ToolDef[] = []

    for (const tool of this.tools.values()) {
      if (tool.hiddenFromAgent) continue
      if (builtinNames.has(tool.name)) {
        builtin.push(tool)
      } else {
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
              if (isToolDef(tool)) this.register(tool)
            }
          } else if (isToolDef(exported)) {
            this.register(exported)
          }
        } catch (err) {
          console.warn(`[nexus] Failed to load custom tool ${file}:`, err)
        }
      }
    } catch {}
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
