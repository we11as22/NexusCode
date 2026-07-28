import type { ExtensionMessage } from "../types/messages.js"
import type {
  AgentPresetFromCore,
  ModelsCatalogFromCore,
  SlashCommandCatalogItem,
} from "../types/messages.js"

type ChatStoreApi = {
  handleStateUpdate: (state: any) => void
  handleSubmissionResult: (
    clientMessageId: string,
    accepted: boolean,
  ) => void
  handleAgentEvent: (event: any) => void
  handleIndexStatus: (status: any) => void
  handleSessionList: (sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }>) => void
  handleSessionListLoading: (loading: boolean) => void
  handleConfigLoaded: (config: any) => void
  handleMcpServerStatus: (results: Array<{ name: string; status: "ok" | "error"; error?: string }>) => void
  handleSlashCommandCatalog: (commands: SlashCommandCatalogItem[]) => void
  handlePendingApproval: (partId: string, action: any) => void
  appendToInput: (content: string) => void
  handleModelsCatalog: (catalog: ModelsCatalogFromCore) => void
  handleAgentPresets: (presets: AgentPresetFromCore[]) => void
  handleAgentPresetOptions: (options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] }) => void
  handleSkillDefinitions: (definitions: Array<{ name: string; path: string; summary: string }>) => void
  setView: (
    view: "chat" | "sessions" | "settings",
    options?: {
      settingsTab?: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"
      settingsIntegTab?: "marketplace" | "rules-skills" | "mcp" | "rules-instructions"
    },
  ) => void
}

const MAX_DELIVERED_SEQUENCES = 4_096

function messageSeq(message: ExtensionMessage): number {
  const candidate = (message as { seq?: unknown }).seq
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : Number.MAX_SAFE_INTEGER
}

function coalescibleAgentDelta(
  left: ExtensionMessage,
  right: ExtensionMessage,
): boolean {
  if (left.type !== "agentEvent" || right.type !== "agentEvent") return false
  const leftEvent = left.event as {
    type?: string
    messageId?: string
    reasoningId?: string
  }
  const rightEvent = right.event as {
    type?: string
    messageId?: string
    reasoningId?: string
  }
  if (
    leftEvent.type !== rightEvent.type ||
    leftEvent.messageId !== rightEvent.messageId
  ) {
    return false
  }
  if (leftEvent.type === "text_delta") return true
  return (
    leftEvent.type === "reasoning_delta" &&
    (leftEvent.reasoningId ?? "") === (rightEvent.reasoningId ?? "")
  )
}

function mergeAgentDeltas(
  left: ExtensionMessage,
  right: ExtensionMessage,
): ExtensionMessage {
  if (left.type !== "agentEvent" || right.type !== "agentEvent") return right
  const leftEvent = left.event as {
    delta?: string
    user_message_delta?: string
  }
  const rightEvent = right.event as {
    delta?: string
    user_message_delta?: string
  }
  return {
    ...right,
    event: {
      ...left.event,
      ...right.event,
      delta: `${leftEvent.delta ?? ""}${rightEvent.delta ?? ""}`,
      ...(
        leftEvent.user_message_delta != null ||
        rightEvent.user_message_delta != null
          ? {
              user_message_delta:
                `${leftEvent.user_message_delta ?? ""}${rightEvent.user_message_delta ?? ""}`,
            }
          : {}
      ),
    },
  } as ExtensionMessage
}

function dispatchExtensionMessage(store: ChatStoreApi, msg: ExtensionMessage): void {
  switch (msg.type) {
    case "stateUpdate":
      store.handleStateUpdate(msg.state)
      break
    case "messageSubmissionResult":
      store.handleSubmissionResult(
        msg.clientMessageId,
        msg.accepted,
      )
      break
    case "agentEvent":
      store.handleAgentEvent(msg.event as any)
      break
    case "indexStatus":
      store.handleIndexStatus(msg.status as any)
      break
    case "sessionList":
      store.handleSessionList(msg.sessions)
      break
    case "sessionListLoading":
      store.handleSessionListLoading(msg.loading)
      break
    case "configLoaded":
      store.handleConfigLoaded(msg.config)
      break
    case "mcpServerStatus":
      store.handleMcpServerStatus(msg.results)
      break
    case "slashCommandCatalog":
      store.handleSlashCommandCatalog(msg.commands)
      break
    case "pendingApproval":
      store.handlePendingApproval(msg.partId, msg.action)
      break
    case "confirmResult":
      break
    case "addToChatContent":
      store.appendToInput(msg.content)
      break
    case "modelsCatalog":
      store.handleModelsCatalog(msg.catalog)
      break
    case "agentPresets":
      store.handleAgentPresets(msg.presets)
      break
    case "agentPresetOptions":
      store.handleAgentPresetOptions(msg.options)
      break
    case "skillDefinitions":
      store.handleSkillDefinitions(msg.definitions)
      break
    case "action":
      if (msg.action === "switchView" && msg.view) {
        store.setView(msg.view, {
          ...(msg.settingsTab && { settingsTab: msg.settingsTab }),
          ...(msg.settingsIntegTab && { settingsIntegTab: msg.settingsIntegTab }),
        })
      }
      break
    default:
      break
  }
}

export function createExtensionMessageBuffer(store: ChatStoreApi) {
  const pending: ExtensionMessage[] = []
  const deliveredSequences = new Set<number>()
  const deliveredSequenceOrder: number[] = []
  let frame: number | null = null

  const rememberDelivered = (message: ExtensionMessage) => {
    const sequence = (message as { seq?: unknown }).seq
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      return
    }
    deliveredSequences.add(sequence)
    deliveredSequenceOrder.push(sequence)
    if (deliveredSequenceOrder.length > MAX_DELIVERED_SEQUENCES) {
      const oldest = deliveredSequenceOrder.shift()
      if (oldest !== undefined) deliveredSequences.delete(oldest)
    }
  }

  const wasDelivered = (message: ExtensionMessage): boolean => {
    const sequence = (message as { seq?: unknown }).seq
    return (
      typeof sequence === "number" &&
      Number.isSafeInteger(sequence) &&
      sequence >= 0 &&
      deliveredSequences.has(sequence)
    )
  }

  const flush = () => {
    frame = null
    if (pending.length === 0) return
    const queued = pending.splice(0, pending.length)
    queued.sort((a, b) => messageSeq(a) - messageSeq(b))
    const seenSequences = new Set<number>()
    const deliverable = queued.filter((message) => {
      if (wasDelivered(message)) return false
      const sequence = (message as { seq?: unknown }).seq
      if (
        typeof sequence === "number" &&
        Number.isSafeInteger(sequence) &&
        sequence >= 0
      ) {
        if (seenSequences.has(sequence)) return false
        seenSequences.add(sequence)
      }
      return true
    })
    for (let index = 0; index < deliverable.length; index += 1) {
      let merged = deliverable[index]!
      const originals = [merged]
      while (
        index + 1 < deliverable.length &&
        coalescibleAgentDelta(merged, deliverable[index + 1]!)
      ) {
        index += 1
        const next = deliverable[index]!
        originals.push(next)
        merged = mergeAgentDeltas(merged, next)
      }
      dispatchExtensionMessage(store, merged)
      for (const original of originals) rememberDelivered(original)
    }
  }

  const schedule = () => {
    if (frame != null) return
    frame = window.requestAnimationFrame(flush)
  }

  return {
    enqueue(msg: ExtensionMessage) {
      pending.push(msg)
      if (msg.type === "stateUpdate") {
        flush()
        return
      }
      if (msg.type === "indexStatus") {
        flush()
        return
      }
      schedule()
    },
    dispose() {
      if (frame != null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      pending.length = 0
      deliveredSequences.clear()
      deliveredSequenceOrder.length = 0
    },
  }
}
