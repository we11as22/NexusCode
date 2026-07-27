import {
  SessionProtocolError,
  type McpClient,
  type NexusServerClient,
  type RemoteMcpPromptCatalog,
  type RemoteMcpPromptCommand,
} from "@nexuscode/core"

export type McpPromptResolution =
  | { status: "resolved"; prompt: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not-found" }

type PromptRef = ReturnType<McpClient["getPromptCatalog"]>[number]
type PromptResult = Awaited<ReturnType<McpClient["getPrompt"]>>
type PromptDescriptor = Pick<
  PromptRef,
  "serverName" | "name" | "arguments"
>

function encoded(value: string): string {
  return encodeURIComponent(value)
}

export function mcpPromptCommandName(prompt: PromptDescriptor): string {
  return `mcp:${encoded(prompt.serverName)}:${encoded(prompt.name)}`
}

function compatibilityName(prompt: PromptDescriptor): string {
  const normalize = (value: string) =>
    value.replace(/[^A-Za-z0-9_-]/g, "_")
  return `mcp__${normalize(prompt.serverName)}__${normalize(prompt.name)}`
}

function isMcpPromptCommand(requestedName: string): boolean {
  return requestedName.startsWith("mcp:") ||
    requestedName.startsWith("mcp__")
}

function tokenize(input: string): string[] {
  const values: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  let started = false
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
    if (/\s/.test(char)) {
      if (started) {
        values.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (escaped) current += "\\"
  if (quote) throw new Error("Unclosed quote in MCP prompt arguments")
  if (started) values.push(current)
  return values
}

function promptArguments(
  prompt: PromptDescriptor,
  rawArguments: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  const positional: string[] = []
  for (const token of tokenize(rawArguments)) {
    const equals = token.indexOf("=")
    if (equals > 0) {
      const name = token.slice(0, equals)
      if (Object.hasOwn(result, name)) {
        throw new Error(`Duplicate MCP prompt argument "${name}"`)
      }
      result[name] = token.slice(equals + 1)
    } else {
      positional.push(token)
    }
  }
  const available = prompt.arguments
    .map((argument) => argument.name)
    .filter((name) => !Object.hasOwn(result, name))
  if (positional.length > available.length) {
    throw new Error(
      `Too many positional arguments for MCP prompt "${prompt.serverName}/${prompt.name}"`,
    )
  }
  positional.forEach((value, index) => {
    result[available[index]!] = value
  })
  return result
}

function remoteMatches(
  catalog: RemoteMcpPromptCatalog,
  requestedName: string,
): RemoteMcpPromptCommand[] {
  const canonical = catalog.commands.filter(
    (prompt) => prompt.commandName === requestedName,
  )
  return canonical.length > 0
    ? canonical
    : catalog.commands.filter(
        (prompt) => compatibilityName(prompt) === requestedName,
      )
}

function renderPrompt(result: PromptResult): string {
  return result.messages
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
      return message.role === "assistant"
        ? `Assistant:\n${body}`
        : body
    })
    .join("\n\n")
}

export async function resolveMcpPromptCommand(
  client: Pick<McpClient, "getPromptCatalog" | "getPrompt">,
  requestedName: string,
  rawArguments: string,
): Promise<McpPromptResolution> {
  if (!isMcpPromptCommand(requestedName)) return { status: "not-found" }
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
      candidates: matches.map(mcpPromptCommandName).sort(),
    }
  }
  const prompt = matches[0]!
  const result = await client.getPrompt(
    prompt.serverName,
    prompt.name,
    promptArguments(prompt, rawArguments),
  )
  return { status: "resolved", prompt: renderPrompt(result) }
}

export async function resolveRemoteMcpPromptCommand(
  client: Pick<
    NexusServerClient,
    "getMcpPromptCatalog" | "resolveMcpPrompt"
  >,
  sessionId: string,
  requestedName: string,
  rawArguments: string,
): Promise<McpPromptResolution> {
  if (!isMcpPromptCommand(requestedName)) return { status: "not-found" }
  let catalog = await client.getMcpPromptCatalog(sessionId)
  let matches = remoteMatches(catalog, requestedName)
  if (matches.length === 0) return { status: "not-found" }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: matches.map((prompt) => prompt.commandName).sort(),
    }
  }

  let argumentsForPrompt = promptArguments(matches[0]!, rawArguments)
  const resolve = () =>
    client.resolveMcpPrompt(sessionId, {
      revision: catalog.revision,
      promptId: matches[0]!.promptId,
      arguments: argumentsForPrompt,
    })
  try {
    const response = await resolve()
    return {
      status: "resolved",
      prompt: response.input.map((part) => part.text).join("\n\n"),
    }
  } catch (error) {
    if (
      !(error instanceof SessionProtocolError) ||
      error.protocolError.code !== "selection_conflict"
    ) {
      throw error
    }
  }

  // One bounded refresh handles a catalog race. Never resolve the stale
  // opaque id against a changed catalog or fall back to a local MCP runtime.
  catalog = await client.getMcpPromptCatalog(sessionId)
  matches = remoteMatches(catalog, requestedName)
  if (matches.length !== 1) {
    throw new Error(
      `MCP prompt "${requestedName}" changed while it was being resolved; refresh the command palette and retry.`,
    )
  }
  argumentsForPrompt = promptArguments(matches[0]!, rawArguments)
  const response = await resolve()
  return {
    status: "resolved",
    prompt: response.input.map((part) => part.text).join("\n\n"),
  }
}
