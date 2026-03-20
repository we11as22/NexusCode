import type { Mode, PermissionAction, ModeConfig } from "../types.js"

export type ToolGroup = "read" | "write" | "execute" | "search" | "mcp" | "skills" | "agents" | "always" | "context" | "plan_exit"

/**
 * Core built-in tool groups per mode.
 * Access control is enforced in the backend (getBuiltinToolsForMode + getBlockedToolsForMode in loop);
 * prompts only describe behaviour — they do not grant or revoke tool access.
 */
export const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]> = {
  agent: ["always", "read", "write", "execute", "search", "mcp", "skills", "agents", "context"],
  plan:  ["always", "read", "write", "search", "mcp", "skills", "agents", "context", "plan_exit"],
  ask:   ["always", "read", "search", "mcp", "skills", "agents", "context"],
  debug: ["always", "read", "write", "execute", "search", "mcp", "skills", "agents", "context"],
  review: ["always", "read", "execute", "search", "mcp", "skills", "agents", "context"],
}

/**
 * Tools that are explicitly BLOCKED per mode (even if passed as dynamic tools).
 * Enforced in the agent loop: blocked tools are never included in resolvedTools and never sent to the LLM.
 * Plan: only write to .nexus/plans/*.md|.txt; no execute.
 * Ask: read-only + no plan work — no write, no execute, no plan_exit (SpawnAgent allowed with ask permissions).
 */
export const MODE_BLOCKED_TOOLS: Record<Mode, string[]> = {
  agent: ["PlanExit"],
  plan:  ["Bash"],
  ask:   ["Write", "Edit", "Bash", "PlanExit"],
  debug: ["PlanExit"],
  review: ["Write", "Edit", "PlanExit"],
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
 * Tools in "always" group are available in every mode.
 */
export const TOOL_GROUP_MEMBERS: Record<ToolGroup, string[]> = {
  always:  ["AskFollowupQuestion", "TodoWrite", "Parallel"],
  read:    ["Read", "List", "ListCodeDefinitions", "ReadLints"],
  write:   ["Write", "Edit"],
  execute: ["Bash"],
  search:  ["Grep", "CodebaseSearch", "WebFetch", "WebSearch", "Glob"],
  mcp:     [],
  skills:  ["Skill"],
  agents:  ["SpawnAgent", "SpawnAgentsParallel"],
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
  "List",
  "ListCodeDefinitions",
  "ReadLints",
  "Grep",
  "CodebaseSearch",
  "WebFetch",
  "WebSearch",
  "Glob",
  "Skill",
  "Condense",
  "BashOutput",
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
    if (group === "mcp") continue // MCP tools are dynamic
    for (const tool of TOOL_GROUP_MEMBERS[group]) {
      tools.add(tool)
    }
  }
  return Array.from(tools)
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
  agent: "AGENT mode: full access — read/write files, run commands, search, browser, MCP, skills, spawn sub-agents (with full agent permissions). Execute tasks end-to-end. After plan approval, run with the approved plan and a detailed todo (fuller task descriptions).",
  plan:  "PLAN mode: (1) Study the task thoroughly — read codebase, search, browser, MCP, skills; write only the plan to .nexus/plans/*.md or .txt. (2) If the user's latest message is only a question (e.g. explain an error), answer that first; do not resume planning/PlanExit until they ask to continue the plan. (3) You may use SpawnAgent for focused research subtasks (sub-agents run in ask mode). For parallel sub-agents, call Parallel with multiple SpawnAgent entries. (4) Call PlanExit only after at least one plan file exists in .nexus/plans/; user may then approve (execution continues in agent mode), revise, or abandon.",
  ask:   "ASK mode: read-only. Answer questions, explain code, analyze — prioritize the latest user message; meta questions (what failed, why, explain the error) get a direct answer from context, not continuation of an old plan/agent flow. Use read, search, browser, MCP, skills when evidence is needed. SpawnAgent for focused read-only subtasks. Do NOT modify files, run commands, or use PlanExit.",
  debug: "DEBUG mode: diagnose first, then fix. Use read/search/execute/write with strict discipline: list likely root causes, validate with evidence (logs/tests/repro), then apply minimal targeted fixes and re-verify.",
  review: "REVIEW mode: audit-only review of changes. Use read/search/execute (git diff/log/blame) to produce findings and recommendations. Do NOT modify files or call PlanExit.",
}
