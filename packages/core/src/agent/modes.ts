import type { Mode, PermissionAction, ModeConfig, ToolDef } from "../types.js"

export type ToolGroup =
  | "read"
  | "write"
  | "execute"
  | "search"
  | "mcp"
  | "skills"
  | "agents"
  | "always"
  | "context"
  | "git_inspect"
  | "plan_exit"
  /** Switch UI/session to plan mode (only where planning is not already the focus). */
  | "plan_enter"

/**
 * Core built-in tool groups per mode.
 * Access control is enforced in the backend (getBuiltinToolsForMode + getBlockedToolsForMode in loop);
 * prompts only describe behaviour — they do not grant or revoke tool access.
 */
export const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]> = {
  agent: ["always", "plan_enter", "read", "write", "execute", "search", "mcp", "skills", "agents", "context"],
  plan: ["always", "read", "write", "search", "mcp", "skills", "agents", "context", "plan_exit"],
  ask: ["always", "read", "search", "mcp", "skills", "agents", "context"],
  debug: ["always", "plan_enter", "read", "write", "execute", "search", "mcp", "skills", "agents", "context"],
  review: ["always", "read", "git_inspect", "search", "mcp", "skills", "agents", "context"],
}

/**
 * Tools that are explicitly BLOCKED per mode (even if passed as dynamic tools).
 * Enforced in the agent loop: blocked tools are never included in resolvedTools and never sent to the LLM.
 * Plan: only write to .nexus/plans/*.md|.txt; no execute; no heavy orchestration mutations.
 * Ask: read-only Q&A — no files/shell/plan handoff/memory writes/team or plugin mutations / remote control.
 * Review: audit-only — no edits, no spawning or mutating orchestration.
 */
export const MODE_BLOCKED_TOOLS: Record<Mode, string[]> = {
  agent: ["PlanExit", "ExitPlanMode"],
  plan: [
    "Bash",
    "PowerShell",
    "EnterPlanMode",
    "ExitPlanMode",
    "TeamCreate",
    "TeamDelete",
    "TeamAddMember",
    "TeamAssignTask",
    "TeamSetMemberStatus",
    "PluginTrust",
    "PluginEnable",
    "PluginConfigure",
    "PluginInstallLocal",
    "PluginRemove",
    "PluginReload",
    "UpdateRemoteSession",
    "SendRemoteMessage",
    "InterruptRemoteSession",
    "RunPluginHook",
  ],
  ask: [
    "Write",
    "Edit",
    "Bash",
    "PowerShell",
    "PlanExit",
    "ExitPlanMode",
    "EnterPlanMode",
    "MemoryCreate",
    "MemoryUpdate",
    "MemoryDelete",
    "TeamCreate",
    "TeamDelete",
    "TeamAddMember",
    "TeamAssignTask",
    "TeamSetMemberStatus",
    "SendMessage",
    "UpdateRemoteSession",
    "SendRemoteMessage",
    "InterruptRemoteSession",
    "PluginTrust",
    "PluginEnable",
    "PluginConfigure",
    "PluginInstallLocal",
    "PluginRemove",
    "PluginReload",
    "McpAuthenticate",
    "PlanStartWorkflow",
    "PlanAnswerWorkflow",
    "PlanCreateResearchTasks",
    "PlanDraftWorkflow",
    "PlanMaterializeTasks",
    "PlanVerifyExecution",
    "TaskUpdate",
    "RunPluginHook",
  ],
  debug: ["PlanExit", "ExitPlanMode"],
  review: [
    "Write",
    "Edit",
    "Bash",
    "PowerShell",
    "EnterWorktree",
    "ExitWorktree",
    "PlanExit",
    "ExitPlanMode",
    "EnterPlanMode",
    "TaskCreate",
    "TaskCreateBatch",
    "TaskResume",
    "TaskUpdate",
    "TaskStop",
    "TeamCreate",
    "TeamDelete",
    "TeamAddMember",
    "TeamAssignTask",
    "TeamSetMemberStatus",
    "SendMessage",
    "MemoryCreate",
    "MemoryUpdate",
    "MemoryDelete",
    "PluginTrust",
    "PluginEnable",
    "PluginConfigure",
    "PluginInstallLocal",
    "PluginRemove",
    "PluginReload",
    "McpAuthenticate",
    "UpdateRemoteSession",
    "SendRemoteMessage",
    "InterruptRemoteSession",
    "PlanStartWorkflow",
    "PlanAnswerWorkflow",
    "PlanCreateResearchTasks",
    "PlanDraftWorkflow",
    "PlanMaterializeTasks",
    "PlanVerifyExecution",
    "RunPluginHook",
  ],
}

/**
 * Source code file extensions that are blocked in plan mode.
 * Plan mode may only write markdown/text documentation files.
 */
export const PLAN_MODE_BLOCKED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".cs", ".swift", ".kt", ".lua",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql",
])

/**
 * Built-in tool names per group.
 * Tools in "always" are mode-agnostic utilities; mode-specific entries use plan_enter, plan_exit, etc.
 */
export const TOOL_GROUP_MEMBERS: Record<ToolGroup, string[]> = {
  always: ["AskFollowupQuestion", "TodoWrite", "Parallel", "SendUserMessage", "ToolSearch"],
  plan_enter: ["EnterPlanMode"],
  read:    ["Read", "ToolOutputRead", "List", "ListCodeDefinitions", "LSP", "ReadLints"],
  write:   ["Write", "Edit"],
  execute: ["Bash", "PowerShell", "EnterWorktree", "ExitWorktree"],
  git_inspect: ["GitInspect"],
  search:  ["Grep", "CodebaseSearch", "WebFetch", "WebSearch", "Glob"],
  mcp:     ["ListMcpResources", "ReadMcpResource", "McpAuthenticate"],
  skills:  ["Skill"],
  agents:  [
    "TaskCreate",
    "TaskCreateBatch",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TaskOutput",
    "TaskStop",
    "TaskResume",
    "TaskSnapshot",
    "TeamCreate",
    "TeamList",
    "TeamGet",
    "TeamInbox",
    "TeamAddMember",
    "TeamAssignTask",
    "TeamSetMemberStatus",
    "TeamDelete",
    "SendMessage",
    "ListRemoteSessions",
    "GetRemoteSession",
    "UpdateRemoteSession",
    "SendRemoteMessage",
    "InterruptRemoteSession",
    "ReconnectRemoteSession",
    "ListAgents",
    "ListPlugins",
    "GetPlugin",
    "RunPluginHook",
    "PluginTrust",
    "PluginEnable",
    "PluginConfigure",
    "PluginValidate",
    "PluginInstallLocal",
    "PluginRemove",
    "PluginReload",
    "PlanStartWorkflow",
    "PlanGetWorkflow",
    "PlanAnswerWorkflow",
    "PlanCreateResearchTasks",
    "PlanDraftWorkflow",
    "PlanMaterializeTasks",
    "PlanVerifyExecution",
    "MemoryCreate",
    "MemoryList",
    "MemoryGet",
    "MemoryUpdate",
    "MemoryDelete",
  ],
  context: ["Condense"],
  plan_exit: ["PlanExit"],
}

/**
 * In plan mode, write_to_file is allowed ONLY for .md plan files in .nexus/plans/.
 * This regex matches the allowed path patterns.
 */
export const PLAN_MODE_ALLOWED_WRITE_PATTERN = /^\.nexus[\\/]plans[\\/].+\.(md|txt)$/i

/**
 * Read-only tools that can be parallelized safely.
 */
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "ToolOutputRead",
  "List",
  "ListCodeDefinitions",
  "LSP",
  "ReadLints",
  "Grep",
  "CodebaseSearch",
  "WebFetch",
  "WebSearch",
  "Glob",
  "Skill",
  "Condense",
  "BashOutput",
  "ToolSearch",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskSnapshot",
  "TeamList",
  "TeamGet",
  "TeamInbox",
  "ListAgents",
  "ListRemoteSessions",
  "GetRemoteSession",
  "ListPlugins",
  "GetPlugin",
  "PluginValidate",
  "PlanGetWorkflow",
  "MemoryList",
  "MemoryGet",
  "ListMcpResources",
  "ReadMcpResource",
  "PlanVerifyExecution",
  "GitInspect",
])

/**
 * Read-only in scheduling terms, but capable of sending model/user-controlled
 * data to the public network. These use the separate browser permission and
 * must never inherit ordinary filesystem-read auto approval.
 */
export const BROWSER_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
])

/**
 * Mandatory tool that must be called at the end of a turn per mode.
 * If the model finishes (returns text, no more tool calls) without calling it, the loop will force-call it.
 * Empty string for agent/ask/debug means no mandatory tool — turn ends when model stops.
 */
export const MANDATORY_END_TOOL: Record<Mode, string> = {
  agent: "",
  plan:  "PlanExit",
  ask:   "",
  debug: "",
  review: "",
}

/**
 * Get all built-in tool names available for a given mode.
 */
export function getBuiltinToolsForMode(mode: Mode): string[] {
  const groups = MODE_TOOL_GROUPS[mode]
  const tools = new Set<string>()
  for (const group of groups) {
    for (const tool of TOOL_GROUP_MEMBERS[group]) {
      tools.add(tool)
    }
  }
  return Array.from(tools)
}

/**
 * One-line summary for Environment / UX: what built-in capabilities the active mode actually exposes.
 * Matches getBuiltinToolsForMode after MODE_BLOCKED_TOOLS (loop applies both).
 */
export function getModeToolPolicySummary(mode: Mode): string {
  switch (mode) {
    case "agent":
      return "Read/write/edit, shell & worktrees, search & web, MCP, skills, full task/team/remote/plugin/plan/memory orchestration, Condense, EnterPlanMode. PlanExit is disabled (use Plan mode for handoff)."
    case "plan":
      return "Read/search/web/MCP/skills; Write/Edit only for .nexus/plans/*.md|txt; PlanExit; tasks & plan workflows & memories; list/get plugins & remotes. No shell, EnterPlanMode, team mutations, plugin install/trust, remote interrupt/send, RunPluginHook."
    case "ask":
      return "Read/search/web/MCP resources/skills, Condense, Parallel, todos; TaskCreate/Batch/Output/Stop/Resume/Snapshot, TaskGet/List; list-only teams/remotes/plugins; PlanGetWorkflow; MemoryList/Get only. No MCP authentication, files, shell, plan exit, memory writes, orchestration mutations, RunPluginHook."
    case "debug":
      return "Same built-in surface as agent (incl. EnterPlanMode); use for diagnose-then-fix. PlanExit is disabled."
    case "review":
      return "Read/search and validated read-only Git inspection, MCP resources, skills, Condense; inspect tasks/teams/remotes/plugins/plans (list/get/output/snapshot). No MCP authentication, arbitrary shell, file edits, task create/resume/stop/update, memory writes, team mutations, plugin install, remote control, plan workflow mutations, RunPluginHook."
    default:
      return String(mode)
  }
}

/**
 * Get the set of tools that are hard-blocked in a mode.
 * These tools should never be sent to the LLM and should error if called.
 */
export function getBlockedToolsForMode(mode: Mode): Set<string> {
  return new Set(MODE_BLOCKED_TOOLS[mode])
}

/**
 * Check if a tool is allowed in a given mode.
 */
export function isToolAllowedInMode(toolName: string, mode: Mode): boolean {
  if (getBlockedToolsForMode(mode).has(toolName)) return false
  return getBuiltinToolsForMode(mode).includes(toolName)
}

const RETIRED_BUILTIN_TOOL_NAMES = ["ExitPlanMode"] as const
const KNOWN_BUILTIN_TOOL_NAMES = new Set([
  ...Object.values(TOOL_GROUP_MEMBERS).flat(),
  ...RETIRED_BUILTIN_TOOL_NAMES,
])

/** Names that remain reserved so an integration cannot replace an old core capability. */
export function getRetiredBuiltinToolNames(): readonly string[] {
  return RETIRED_BUILTIN_TOOL_NAMES
}

/** True for the public built-in surface, independent of the current mode. */
export function isKnownBuiltinToolName(toolName: string): boolean {
  return KNOWN_BUILTIN_TOOL_NAMES.has(toolName)
}

/**
 * External tools are untrusted capabilities. In modes that promise a
 * constrained/read-only execution surface, an absent readOnly declaration is
 * treated as mutating and therefore denied.
 */
export function isDynamicToolAllowedInMode(
  tool: ToolDef,
  mode: Mode,
): boolean {
  if (tool.modes && !tool.modes.includes(mode)) return false
  if (mode === "agent" || mode === "debug") return true
  return tool.readOnly === true
}

/**
 * Authoritative mode check used at execution time as well as manifest
 * construction. This prevents callers, stale transcripts, nested tools, or
 * integrations from bypassing the advertised mode boundary.
 */
export function isToolDefinitionAllowedInMode(
  tool: ToolDef,
  mode: Mode,
): boolean {
  if (getBlockedToolsForMode(mode).has(tool.name)) return false
  if (tool.modes && !tool.modes.includes(mode)) return false
  if (isKnownBuiltinToolName(tool.name)) {
    return getBuiltinToolsForMode(mode).includes(tool.name)
  }
  return isDynamicToolAllowedInMode(tool, mode)
}

/**
 * Get auto-approve permissions for a mode based on config.
 */
export function getAutoApproveActions(mode: Mode, modeConfig?: ModeConfig): Set<PermissionAction> {
  const defaults: Record<Mode, PermissionAction[]> = {
    agent: ["read"],
    plan:  ["read"],
    ask:   ["read"],
    debug: ["read"],
    review: ["read"],
  }
  const configured = modeConfig?.autoApprove ?? defaults[mode]
  return new Set(configured)
}

/**
 * Mode descriptions for system prompt.
 */
export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  agent:
    "AGENT mode: full access — read/write files, run commands, search, web, MCP, skills, tasks, teams, remotes, plugins, plan-memory tools, EnterPlanMode. Execute end-to-end. PlanExit is not available here (switch to Plan mode to hand off a plan).",
  plan:
    "PLAN mode: study the repo (read/search/web/MCP/skills), write only plan files under .nexus/plans/*.md|.txt, use PlanExit when ready. Tasks and plan workflows allowed; shell, plugin install/trust, team mutations, remote control, and EnterPlanMode are disabled.",
  ask:
    "ASK mode: read-only answers — read/search/web/MCP resources/skills, delegated TaskCreate (read-only subagents), TaskOutput/TaskStop/TaskResume, list/get state for tasks/teams/remotes/plugins and PlanGetWorkflow, MemoryList/MemoryGet. No MCP authentication, file edits, shell, PlanExit/EnterPlanMode, memory writes, team/plugin/remote mutations, or mutating plan workflow tools.",
  debug:
    "DEBUG mode: same tool palette as agent; diagnose first with evidence, then minimal fixes and re-verify. PlanExit is disabled.",
  review:
    "REVIEW mode: audit only — read/search and validated GitInspect, MCP resources, skills; inspect existing tasks/teams/remotes/plugins/plans without creating or mutating orchestration. No MCP authentication, arbitrary shell, Write/Edit, new tasks, or PlanExit/EnterPlanMode.",
}
