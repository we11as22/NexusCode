import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { glob } from "glob"
import yaml from "js-yaml"
import type { AgentDefinition, NexusConfig } from "../types.js"
import { resolvePluginDeclaredPath } from "../plugins/index.js"
import { loadTrustedPluginRuntimeRecords } from "../plugins/runtime.js"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    agentType: "Explore",
    whenToUse: "Use for read-only codebase exploration, search, and architectural mapping.",
    builtin: true,
    preferredMode: "ask",
    tools: ["Read", "List", "ListCodeDefinitions", "ReadLints", "Grep", "CodebaseSearch", "Glob", "WebFetch", "WebSearch", "Skill", "ToolSearch"],
  },
  {
    agentType: "Plan",
    whenToUse: "Use for planning, breaking down implementation, and producing execution-ready plans.",
    builtin: true,
    preferredMode: "ask",
    tools: ["Read", "List", "ListCodeDefinitions", "ReadLints", "Grep", "CodebaseSearch", "Glob", "WebFetch", "WebSearch", "Skill", "ToolSearch", "TaskCreate", "TaskList"],
  },
  {
    agentType: "Verification",
    whenToUse: "Use after implementation to validate changes, inspect diffs, and run checks.",
    builtin: true,
  },
  {
    agentType: "GeneralPurpose",
    whenToUse: "Use for implementation work that needs the same broad capabilities as the main agent.",
    builtin: true,
  },
]
const BUILTIN_AGENT_TYPES = new Set(
  BUILTIN_AGENTS.map((agent) => agent.agentType.toLowerCase()),
)
const MAX_AGENT_DEFINITION_BYTES = 80_000

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/^\uFEFF/, "")
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: text }
  try {
    const parsed = yaml.load(match[1])
    return {
      frontmatter:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      body: match[2],
    }
  } catch {
    return { frontmatter: {}, body: text }
  }
}

async function loadOne(filePath: string): Promise<AgentDefinition | null> {
  try {
    const before = await fs.lstat(filePath)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_AGENT_DEFINITION_BYTES
    ) {
      return null
    }
    const raw = await fs.readFile(filePath, "utf8")
    const after = await fs.lstat(filePath)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      Buffer.byteLength(raw, "utf8") !== after.size
    ) {
      return null
    }
    const { frontmatter, body } = splitFrontmatter(raw)
    const agentType = String(
      frontmatter.agent_type ?? frontmatter.name ?? path.basename(filePath, path.extname(filePath)),
    ).trim()
    const whenToUse = String(frontmatter.when_to_use ?? frontmatter.whenToUse ?? "").trim()
    if (!agentType || !whenToUse) return null
    const tools = Array.isArray(frontmatter.tools)
      ? frontmatter.tools.filter((item): item is string => typeof item === "string")
      : undefined
    const disallowedTools = Array.isArray(frontmatter.disallowed_tools)
      ? frontmatter.disallowed_tools.filter((item): item is string => typeof item === "string")
      : Array.isArray(frontmatter.disallowedTools)
        ? frontmatter.disallowedTools.filter((item): item is string => typeof item === "string")
        : undefined
    const hooks = Array.isArray(frontmatter.hooks)
      ? frontmatter.hooks.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined
    const preferredModeRaw =
      typeof frontmatter.preferred_mode === "string"
        ? frontmatter.preferred_mode
        : typeof frontmatter.preferredMode === "string"
          ? frontmatter.preferredMode
          : ""
    const preferredMode =
      preferredModeRaw === "agent" ||
      preferredModeRaw === "plan" ||
      preferredModeRaw === "ask" ||
      preferredModeRaw === "debug" ||
      preferredModeRaw === "review"
        ? preferredModeRaw
        : undefined
    return {
      agentType,
      whenToUse,
      systemPrompt: body.trim() || undefined,
      ...(preferredMode ? { preferredMode } : {}),
      tools,
      disallowedTools,
      ...(hooks?.length ? { hooks } : {}),
      sourcePath: filePath,
      builtin: false,
    }
  } catch {
    return null
  }
}

export async function loadAgentDefinitions(
  cwd: string,
  compatibility?: ClaudeCompatibilityOptions,
  config?: NexusConfig,
): Promise<AgentDefinition[]> {
  const homeDir = path.join(os.homedir(), ".nexus", "agents", "**", "*.md")
  const projectDir = path.join(path.resolve(cwd), ".nexus", "agents", "**", "*.md")
  const pluginAgentPaths = (
    config
      ? await loadTrustedPluginRuntimeRecords(cwd, config)
      : []
  )
    .flatMap((plugin) => plugin.agents.map((agentPath) => resolvePluginDeclaredPath(plugin, agentPath)))
  const pluginAgents = (
    await Promise.all(pluginAgentPaths.map(async (agentPath) => {
      const stats = await fs.stat(agentPath).catch(() => null)
      if (stats?.isDirectory()) {
        return glob(path.join(agentPath, "**", "*.md"), { absolute: true })
      }
      return stats?.isFile() && agentPath.toLowerCase().endsWith(".md") ? [agentPath] : []
    }))
  ).flat()
  const files = [
    ...(compatibility?.includeGlobalDir && compatibility?.includeAgents
      ? (await glob(path.join(os.homedir(), ".claude", "agents", "**", "*.md"), { absolute: true }).catch(() => [] as string[])).map((file) => ({ file, priority: 1 }))
      : []),
    ...(await glob(homeDir, { absolute: true }).catch(() => [] as string[])).map((file) => ({ file, priority: 2 })),
    ...pluginAgents.map((file) => ({ file, priority: 3 })),
    ...(compatibility?.includeProjectDir && compatibility?.includeAgents
      ? (await glob(path.join(path.resolve(cwd), ".claude", "agents", "**", "*.md"), { absolute: true }).catch(() => [] as string[])).map((file) => ({ file, priority: 4 }))
      : []),
    ...(await glob(projectDir, { absolute: true }).catch(() => [] as string[])).map((file) => ({ file, priority: 5 })),
  ]
  const loaded = (await Promise.all(files.map(async ({ file, priority }) => {
    const item = await loadOne(file)
    return item ? { item, priority } : null
  }))).filter(
    (entry): entry is { item: AgentDefinition; priority: number } => Boolean(entry),
  )
  const byType = new Map<string, AgentDefinition>()
  for (const builtin of BUILTIN_AGENTS) {
    byType.set(builtin.agentType.toLowerCase(), builtin)
  }
  const priorities = new Map<string, number>()
  for (const { item, priority } of loaded) {
    const key = item.agentType.toLowerCase()
    // Built-in roles carry security-sensitive capability ceilings (Explore in
    // particular is intentionally read-only). Repository and plugin files may
    // add new roles, but cannot replace those reserved definitions by name or
    // casing.
    if (BUILTIN_AGENT_TYPES.has(key)) continue
    if ((priorities.get(key) ?? -1) <= priority) {
      byType.set(key, item)
      priorities.set(key, priority)
    }
  }
  return Array.from(byType.values())
}
