import { SessionProtocolError } from "@nexuscode/core"
import type { McpClient } from "@nexuscode/core"

const MAX_ARGUMENT_INPUT_CHARS = 128 * 1_024
const MAX_ARGUMENT_TOKENS = 128
const MAX_ARGUMENT_TOKEN_CHARS = 16 * 1_024
const MAX_RENDERED_PROMPT_CHARS = 512 * 1_024

type McpPromptClient = Pick<
  McpClient,
  "getPromptCatalog" | "getPrompt"
>
type PromptRef = ReturnType<McpClient["getPromptCatalog"]>[number]
type PromptResult = Awaited<ReturnType<McpClient["getPrompt"]>>
type PromptArgument = {
  name: string
  required: boolean
}
type PromptDefinition = {
  serverName: string
  name: string
  title?: string
  description?: string
  arguments: readonly PromptArgument[]
}
type RemoteMcpPromptCommand = PromptDefinition & {
  promptId: string
  commandName: string
}
type RemoteMcpPromptCatalog = {
  revision: string
  commands: readonly RemoteMcpPromptCommand[]
}
type RemoteMcpPromptClient = {
  getMcpPromptCatalog(sessionId: string): Promise<RemoteMcpPromptCatalog>
  resolveMcpPrompt(
    sessionId: string,
    request: {
      revision: string
      promptId: string
      arguments: Record<string, string>
    },
    signal?: AbortSignal,
  ): Promise<{
    input: ReadonlyArray<{ type: "text"; text: string }>
  }>
}

export interface McpPromptCommandCatalogItem {
  name: string
  description: string
  argumentHint?: string
}

export type McpPromptResolution =
  | { status: "resolved"; prompt: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not-found" }

function encoded(value: string): string {
  return encodeURIComponent(value)
}

export function mcpPromptCommandName(prompt: PromptDefinition): string {
  return `mcp:${encoded(prompt.serverName)}:${encoded(prompt.name)}`
}

function compatibilityName(prompt: PromptDefinition): string {
  const normalize = (value: string) =>
    value.replace(/[^A-Za-z0-9_-]/gu, "_")
  return `mcp__${normalize(prompt.serverName)}__${normalize(prompt.name)}`
}

export function isMcpPromptCommandName(name: string): boolean {
  const normalized = name.replace(/^\//u, "")
  return normalized.startsWith("mcp:") || normalized.startsWith("mcp__")
}

export function getMcpPromptCommandCatalog(
  client: Pick<McpClient, "getPromptCatalog">,
): McpPromptCommandCatalogItem[] {
  return client.getPromptCatalog().map((prompt) =>
    promptCatalogItem(prompt, mcpPromptCommandName(prompt)),
  )
}

function promptCatalogItem(
  prompt: PromptDefinition,
  name: string,
): McpPromptCommandCatalogItem {
  const argumentHint = prompt.arguments
    .map((argument) =>
      argument.required ? `<${argument.name}>` : `[${argument.name}]`,
    )
    .join(" ")
  return {
    name,
    description:
      prompt.description?.trim() ||
      prompt.title?.trim() ||
      `${prompt.serverName}/${prompt.name} MCP prompt`,
    ...(argumentHint ? { argumentHint } : {}),
  }
}

export function getRemoteMcpPromptCommandCatalog(
  catalog: RemoteMcpPromptCatalog,
): McpPromptCommandCatalogItem[] {
  return catalog.commands.map((prompt) =>
    promptCatalogItem(prompt, prompt.commandName),
  )
}

function tokenize(input: string): string[] {
  if (input.length > MAX_ARGUMENT_INPUT_CHARS) {
    throw new Error("MCP prompt arguments are too large")
  }
  const values: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  let started = false
  const pushCurrent = (): void => {
    if (!started) return
    if (current.length > MAX_ARGUMENT_TOKEN_CHARS) {
      throw new Error("An MCP prompt argument is too large")
    }
    values.push(current)
    if (values.length > MAX_ARGUMENT_TOKENS) {
      throw new Error("MCP prompt has too many argument tokens")
    }
    current = ""
    started = false
  }

  for (const char of input.trim()) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      pushCurrent()
      continue
    }
    current += char
    started = true
  }
  if (escaped) current += "\\"
  if (quote) throw new Error("Unclosed quote in MCP prompt arguments")
  pushCurrent()
  return values
}

function promptArguments(
  prompt: PromptDefinition,
  rawArguments: string,
): Record<string, string> {
  const named = new Map<string, string>()
  const positional: string[] = []
  for (const token of tokenize(rawArguments)) {
    const equals = token.indexOf("=")
    if (equals > 0) {
      const name = token.slice(0, equals)
      if (named.has(name)) {
        throw new Error(`Duplicate MCP prompt argument "${name}"`)
      }
      named.set(name, token.slice(equals + 1))
    } else {
      positional.push(token)
    }
  }
  const available = prompt.arguments
    .map((argument) => argument.name)
    .filter((name) => !named.has(name))
  if (positional.length > available.length) {
    throw new Error(
      `Too many positional arguments for MCP prompt "${prompt.serverName}/${prompt.name}"`,
    )
  }
  positional.forEach((value, index) => {
    named.set(available[index]!, value)
  })
  return Object.fromEntries(named)
}

function renderPrompt(result: PromptResult): string {
  const rendered = result.messages
    .map((message) => {
      const content = message.content
      let body: string
      switch (content.type) {
        case "text":
          body = content.text
          break
        case "image":
        case "audio":
          body = `[MCP ${content.type}: ${content.mimeType}]`
          break
        case "resource":
          body =
            content.text ??
            `[MCP resource: ${content.uri}${
              content.mimeType ? ` (${content.mimeType})` : ""
            }]`
          break
        case "resource_link":
          body =
            `[MCP resource link: ${content.name ?? content.uri} — ${content.uri}]`
          break
        case "unsupported":
          body =
            `[Unsupported MCP prompt content: ${content.originalType}]`
          break
      }
      return `${message.role === "assistant" ? "Assistant" : "User"}:\n${body}`
    })
    .join("\n\n")
  if (rendered.length > MAX_RENDERED_PROMPT_CHARS) {
    throw new Error("Rendered MCP prompt is too large")
  }
  return rendered
}

export async function resolveMcpPromptCommand(
  client: McpPromptClient,
  requestedName: string,
  rawArguments: string,
  signal?: AbortSignal,
): Promise<McpPromptResolution> {
  const catalog = client.getPromptCatalog()
  const canonical = catalog.filter(
    (prompt) => mcpPromptCommandName(prompt) === requestedName,
  )
  const matches =
    canonical.length > 0
      ? canonical
      : catalog.filter(
          (prompt) => compatibilityName(prompt) === requestedName,
        )
  if (matches.length === 0) return { status: "not-found" }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: [...new Set(matches.map(mcpPromptCommandName))].sort(),
    }
  }
  const prompt = matches[0]!
  const result = await client.getPrompt(
    prompt.serverName,
    prompt.name,
    promptArguments(prompt, rawArguments),
    signal,
  )
  return { status: "resolved", prompt: renderPrompt(result) }
}

function selectRemotePrompt(
  catalog: RemoteMcpPromptCatalog,
  requestedName: string,
):
  | { status: "resolved"; command: RemoteMcpPromptCommand }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not-found" } {
  const canonical = catalog.commands.filter(
    (prompt) => prompt.commandName === requestedName,
  )
  const matches =
    canonical.length > 0
      ? canonical
      : catalog.commands.filter(
          (prompt) => compatibilityName(prompt) === requestedName,
        )
  if (matches.length === 0) return { status: "not-found" }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: [...new Set(matches.map((prompt) => prompt.commandName))]
        .sort(),
    }
  }
  return { status: "resolved", command: matches[0]! }
}

function isSelectionConflict(error: unknown): boolean {
  return (
    error instanceof SessionProtocolError &&
    error.protocolError.code === "selection_conflict"
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error("MCP prompt resolution was aborted")
}

async function resolveRemoteSelection(
  client: RemoteMcpPromptClient,
  sessionId: string,
  catalog: RemoteMcpPromptCatalog,
  command: RemoteMcpPromptCommand,
  rawArguments: string,
  signal?: AbortSignal,
): Promise<McpPromptResolution> {
  throwIfAborted(signal)
  const response = await client.resolveMcpPrompt(
    sessionId,
    {
      revision: catalog.revision,
      promptId: command.promptId,
      arguments: promptArguments(command, rawArguments),
    },
    signal,
  )
  return {
    status: "resolved",
    prompt: response.input.map((part) => part.text).join("\n\n"),
  }
}

/**
 * Resolve a server-owned MCP prompt using only opaque, revision-bound server
 * capabilities. A stale selection is retried once after a fresh catalog, and
 * only when the exact canonical command still has one unambiguous owner.
 */
export async function resolveRemoteMcpPromptCommand(
  client: RemoteMcpPromptClient,
  sessionId: string,
  requestedName: string,
  rawArguments: string,
  signal?: AbortSignal,
): Promise<McpPromptResolution> {
  throwIfAborted(signal)
  const catalog = await client.getMcpPromptCatalog(sessionId)
  throwIfAborted(signal)
  const selected = selectRemotePrompt(catalog, requestedName)
  if (selected.status !== "resolved") return selected

  try {
    return await resolveRemoteSelection(
      client,
      sessionId,
      catalog,
      selected.command,
      rawArguments,
      signal,
    )
  } catch (error) {
    if (!isSelectionConflict(error)) throw error
  }

  throwIfAborted(signal)
  const refreshed = await client.getMcpPromptCatalog(sessionId)
  throwIfAborted(signal)
  const matches = refreshed.commands.filter(
    (command) => command.commandName === selected.command.commandName,
  )
  if (matches.length !== 1) {
    throw new Error(
      `MCP prompt /${selected.command.commandName} changed and no longer exists uniquely. Refresh the slash-command catalog and choose it again.`,
    )
  }
  return resolveRemoteSelection(
    client,
    sessionId,
    refreshed,
    matches[0]!,
    rawArguments,
    signal,
  )
}
