import type { AgentEvent, SessionMessage, ToolPart } from "@nexuscode/core"

const PRIVATE_OUTPUT_METADATA_KEYS = new Set([
  "outputspillpath",
  "outputpath",
  "absolutepath",
  "absolutefilepath",
  "artifactpath",
  "spillpath",
  "outputdirectory",
  "artifactdirectory",
  "outputartifactownersessionid",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function projectPrivateOutputMetadata(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value)
    if (existing) return existing
    const projected: unknown[] = []
    seen.set(value, projected)
    for (const item of value) {
      projected.push(projectPrivateOutputMetadata(item, seen))
    }
    return projected
  }
  if (!isRecord(value)) return value
  const existing = seen.get(value)
  if (existing) return existing
  const projected: Record<string, unknown> = {}
  seen.set(value, projected)
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_OUTPUT_METADATA_KEYS.has(key.toLowerCase())) continue
    projected[key] = projectPrivateOutputMetadata(item, seen)
  }
  return projected
}

function projectToolPartForWebview(part: ToolPart): ToolPart {
  const {
    outputSpillPath: _outputSpillPath,
    outputArtifactOwnerSessionId: _outputArtifactOwnerSessionId,
    ...safePart
  } = part
  return safePart
}

export function projectSessionMessagesForWebview(
  messages: readonly SessionMessage[],
): SessionMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== "tool") return part
      if (
        part.outputSpillPath === undefined &&
        part.outputArtifactOwnerSessionId === undefined
      ) {
        return part
      }
      changed = true
      return projectToolPartForWebview(part)
    })
    return changed ? { ...message, content } : message
  })
}

export function projectAgentEventForWebview(event: AgentEvent): AgentEvent {
  if (event.type !== "tool_end") return event
  const raw = event as AgentEvent & Record<string, unknown>
  const {
    outputSpillPath: _outputSpillPath,
    outputPath: _outputPath,
    absolutePath: _absolutePath,
    absoluteFilePath: _absoluteFilePath,
    artifactPath: _artifactPath,
    spillPath: _spillPath,
    outputArtifactOwnerSessionId: _outputArtifactOwnerSessionId,
    ...safeEvent
  } = raw
  if (isRecord(event.metadata)) {
    safeEvent.metadata = projectPrivateOutputMetadata(
      event.metadata,
    ) as Record<string, unknown>
  }
  return safeEvent as AgentEvent
}

/**
 * Last host-side projection before any extension message crosses into the
 * webview. It intentionally handles both replayed session state and live tool
 * events so old JSONL records cannot bypass current output capabilities.
 */
export function projectExtensionMessageForWebview<
  T extends { type: string },
>(message: T): T {
  if (message.type === "stateUpdate") {
    const envelope = message as T & {
      state?: { messages?: SessionMessage[] }
    }
    if (!envelope.state || !Array.isArray(envelope.state.messages)) {
      return message
    }
    return {
      ...message,
      state: {
        ...envelope.state,
        messages: projectSessionMessagesForWebview(envelope.state.messages),
      },
    }
  }
  if (message.type === "agentEvent") {
    const envelope = message as T & { event?: AgentEvent }
    if (!envelope.event || typeof envelope.event.type !== "string") {
      return message
    }
    return {
      ...message,
      event: projectAgentEventForWebview(envelope.event),
    }
  }
  return message
}
