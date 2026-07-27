import { createHash } from "node:crypto"
import { z } from "zod"

import type { McpPromptRef } from "./types.js"

export const MAX_REMOTE_MCP_PROMPT_COMMANDS = 256
export const MAX_REMOTE_MCP_PROMPT_ARGUMENTS = 32
export const MAX_REMOTE_MCP_PROMPT_CATALOG_CHARS = 512 * 1024
export const MAX_REMOTE_MCP_PROMPT_ARGUMENT_VALUE_CHARS = 16 * 1024

const boundedName = z.string().min(1).max(256)
const boundedDescription = z.string().max(2_048)

export const RemoteMcpPromptArgumentSchema = z.object({
  name: boundedName,
  description: boundedDescription.optional(),
  required: z.boolean(),
}).strict()

export const RemoteMcpPromptCommandSchema = z.object({
  promptId: z.string().regex(/^mcp_prompt_[0-9a-f]{64}$/u),
  commandName: z.string().min(1).max(2_048),
  serverName: boundedName,
  name: boundedName,
  title: boundedDescription.optional(),
  description: boundedDescription.optional(),
  arguments: z.array(RemoteMcpPromptArgumentSchema)
    .max(MAX_REMOTE_MCP_PROMPT_ARGUMENTS),
}).strict()

export const RemoteMcpPromptCatalogSchema = z.object({
  revision: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  commands: z.array(RemoteMcpPromptCommandSchema)
    .max(MAX_REMOTE_MCP_PROMPT_COMMANDS),
}).strict()

export const RemoteMcpPromptResolveRequestSchema = z.object({
  revision: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  promptId: z.string().regex(/^mcp_prompt_[0-9a-f]{64}$/u),
  arguments: z.record(
    boundedName,
    z.string().max(MAX_REMOTE_MCP_PROMPT_ARGUMENT_VALUE_CHARS),
  ).refine(
    (value) => Object.keys(value).length <= MAX_REMOTE_MCP_PROMPT_ARGUMENTS,
    `At most ${MAX_REMOTE_MCP_PROMPT_ARGUMENTS} MCP prompt arguments are allowed`,
  ),
}).strict()

export const RemoteMcpPromptResolveResponseSchema = z.object({
  input: z.array(z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(512 * 1024),
  }).strict()).min(1).max(1),
}).strict()

export type RemoteMcpPromptArgument = z.infer<
  typeof RemoteMcpPromptArgumentSchema
>
export type RemoteMcpPromptCommand = z.infer<
  typeof RemoteMcpPromptCommandSchema
>
export type RemoteMcpPromptCatalog = z.infer<
  typeof RemoteMcpPromptCatalogSchema
>
export type RemoteMcpPromptResolveRequest = z.infer<
  typeof RemoteMcpPromptResolveRequestSchema
>
export type RemoteMcpPromptResolveResponse = z.infer<
  typeof RemoteMcpPromptResolveResponseSchema
>

export function mcpPromptCommandName(
  serverName: string,
  promptName: string,
): string {
  return `mcp:${encodeURIComponent(serverName)}:${encodeURIComponent(promptName)}`
}

export function mcpPromptOpaqueId(
  serverName: string,
  promptName: string,
): string {
  return (
    "mcp_prompt_" +
    createHash("sha256")
      .update(serverName)
      .update("\0")
      .update(promptName)
      .digest("hex")
  )
}

function transportCommand(prompt: McpPromptRef): RemoteMcpPromptCommand {
  return RemoteMcpPromptCommandSchema.parse({
    promptId: mcpPromptOpaqueId(prompt.serverName, prompt.name),
    commandName: mcpPromptCommandName(prompt.serverName, prompt.name),
    serverName: prompt.serverName,
    name: prompt.name,
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    arguments: prompt.arguments,
  })
}

/**
 * Create a deterministic bounded projection. Oversized catalogs fail closed
 * instead of being silently truncated, because a truncated catalog would make
 * its revision ambiguous across clients.
 */
export function buildRemoteMcpPromptCatalog(
  prompts: readonly McpPromptRef[],
): RemoteMcpPromptCatalog {
  if (prompts.length > MAX_REMOTE_MCP_PROMPT_COMMANDS) {
    throw new Error(
      `Remote MCP prompt catalog exceeds ${MAX_REMOTE_MCP_PROMPT_COMMANDS} commands`,
    )
  }
  const commands = prompts
    .map(transportCommand)
    .sort((left, right) =>
      left.serverName.localeCompare(right.serverName) ||
      left.name.localeCompare(right.name)
    )
  const canonical = JSON.stringify(commands)
  if (canonical.length > MAX_REMOTE_MCP_PROMPT_CATALOG_CHARS) {
    throw new Error(
      `Remote MCP prompt catalog exceeds ${MAX_REMOTE_MCP_PROMPT_CATALOG_CHARS} characters`,
    )
  }
  return RemoteMcpPromptCatalogSchema.parse({
    revision:
      `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    commands,
  })
}
