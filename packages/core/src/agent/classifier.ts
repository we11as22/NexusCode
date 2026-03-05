import { z } from "zod"
import type { LLMClient } from "../provider/index.js"
import type { ToolDef, SkillDef } from "../types.js"

const TOOL_SELECTION_SCHEMA = z.object({
  selected: z.array(z.string()),
  reasoning: z.string().optional(),
})

const SKILL_SELECTION_SCHEMA = z.object({
  selected: z.array(z.string()),
  reasoning: z.string().optional(),
})

const MCP_SERVER_SELECTION_SCHEMA = z.object({
  selected: z.array(z.string()),
  reasoning: z.string().optional(),
})

// Tools that are ALWAYS included regardless of classification
const ALWAYS_INCLUDE_TOOLS = new Set([
  "final_report_to_user",
  "ask_followup_question",
  "update_todo_list",
])

/**
 * Classify which MCP servers are relevant for the given task.
 * Returns the selected server names. Only tools from these servers will be included.
 * Server names are the prefix before "__" in tool names (e.g. "context7" from "context7__search").
 */
export async function classifyMcpServers(
  serverInfos: Array<{ name: string; toolCount: number; toolNames: string[] }>,
  taskDescription: string,
  client: LLMClient
): Promise<string[]> {
  if (serverInfos.length === 0) return []

  const serverList = serverInfos
    .map(s => `- ${s.name}: ${s.toolCount} tools (${s.toolNames.slice(0, 8).join(", ")}${s.toolNames.length > 8 ? ", ..." : ""})`)
    .join("\n")

  const systemPrompt = `You are an MCP server selector. Given a task description and a list of available MCP servers (each exposes many tools), select the servers most likely needed to complete the task.

Rules:
- Select between 3 and 12 servers (fewer is better — don't include servers that are clearly irrelevant)
- When unsure, include the server (false negative is worse than false positive)
- Include servers for: code/IDE, search, docs, file system, git, build/test if the task might need them
- Do NOT include servers for unrelated domains the task clearly doesn't need
- Return the exact server names as listed

Respond with JSON: { "selected": ["server_name_1", "server_name_2", ...] }`

  const userMessage = `Task: ${taskDescription.slice(0, 500)}

Available MCP servers:
${serverList}

Select the most relevant MCP servers.`

  try {
    const result = await client.generateStructured({
      messages: [{ role: "user", content: userMessage }],
      schema: MCP_SERVER_SELECTION_SCHEMA,
      systemPrompt,
      maxRetries: 2,
    })

    const validNames = new Set(serverInfos.map(s => s.name))
    return result.selected.filter(name => validNames.has(name))
  } catch {
    return serverInfos.map(s => s.name)
  }
}

/**
 * Classify which MCP/custom tools are relevant for the given task (legacy; prefer classifyMcpServers).
 * Returns the selected tool names. Built-in mode tools are NOT filtered here.
 */
export async function classifyTools(
  tools: ToolDef[],
  taskDescription: string,
  client: LLMClient
): Promise<string[]> {
  // Always include essential tools
  const alwaysIncluded = tools.filter(t => ALWAYS_INCLUDE_TOOLS.has(t.name))
  const toClassify = tools.filter(t => !ALWAYS_INCLUDE_TOOLS.has(t.name))

  if (toClassify.length === 0) return tools.map(t => t.name)

  const toolList = toClassify
    .map(t => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 100)}`)
    .join("\n")

  const systemPrompt = `You are a tool selector. Given a task description and a list of available tools, select the tools most likely needed to complete the task.

Rules:
- Select between 5 and 15 tools (fewer is better — don't include tools that are clearly irrelevant)
- When unsure, include the tool (false negative is worse than false positive)
- Include tools for: reading/writing code relevant to the task, testing, building, deploying if mentioned
- Do NOT include tools for: unrelated languages/frameworks, tools the task clearly doesn't need
- Always select tools that are clearly relevant to the task domain

Respond with JSON: { "selected": ["tool_name_1", "tool_name_2", ...] }`

  const userMessage = `Task: ${taskDescription.slice(0, 500)}

Available tools:
${toolList}

Select the most relevant tools.`

  try {
    const result = await client.generateStructured({
      messages: [{ role: "user", content: userMessage }],
      schema: TOOL_SELECTION_SCHEMA,
      systemPrompt,
      maxRetries: 2,
    })

    const selectedNames = new Set([
      ...alwaysIncluded.map(t => t.name),
      ...result.selected.filter(name => toClassify.some(t => t.name === name)),
    ])

    return tools.filter(t => selectedNames.has(t.name)).map(t => t.name)
  } catch {
    // Fallback: return all tools
    return tools.map(t => t.name)
  }
}

/**
 * Classify which skills are relevant for the given task.
 * Returns selected skill names.
 */
export async function classifySkills(
  skills: SkillDef[],
  taskDescription: string,
  client: LLMClient
): Promise<SkillDef[]> {
  if (skills.length === 0) return []

  const skillList = skills
    .map(s => `- ${s.name}: ${s.summary}`)
    .join("\n")

  const systemPrompt = `You are a skill relevance classifier. Select the skills most relevant to completing the given task.

Rules:
- Select at most 5 skills (+ 1 buffer for edge cases = max 6)
- Always include skills about the main technology stack mentioned in the task
- Include skills that provide useful context or guidelines for the task domain
- When in doubt, include (false negative is worse than false positive)
- Return the exact skill names as listed

Respond with JSON: { "selected": ["skill_name_1", ...] }`

  const userMessage = `Task: ${taskDescription.slice(0, 500)}

Available skills:
${skillList}

Select the most relevant skills.`

  try {
    const result = await client.generateStructured({
      messages: [{ role: "user", content: userMessage }],
      schema: SKILL_SELECTION_SCHEMA,
      systemPrompt,
      maxRetries: 2,
    })

    const selectedNames = new Set(result.selected)
    return skills.filter(s => selectedNames.has(s.name))
  } catch {
    // Fallback: return all skills (up to threshold + buffer)
    return skills.slice(0, 6)
  }
}
