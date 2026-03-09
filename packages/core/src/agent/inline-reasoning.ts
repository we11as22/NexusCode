export interface InlineReasoningState {
  pendingFirstLine: boolean
  firstLineBuffer: string
  inThinkTag: boolean
}

const FIRST_LINE_BUFFER_LIMIT = 4096

export function createInlineReasoningState(): InlineReasoningState {
  return {
    pendingFirstLine: true,
    firstLineBuffer: "",
    inThinkTag: false,
  }
}

export function splitInlineReasoningFromTextDelta(
  state: InlineReasoningState,
  delta: string
): { textDelta: string; reasoningDeltas: string[] } {
  const reasoningDeltas: string[] = []
  let textDelta = delta

  if (state.pendingFirstLine) {
    state.firstLineBuffer += textDelta
    textDelta = ""

    const newlineIdx = state.firstLineBuffer.indexOf("\n")
    if (newlineIdx === -1 && state.firstLineBuffer.length < FIRST_LINE_BUFFER_LIMIT) {
      return { textDelta: "", reasoningDeltas }
    }

    const buffered = state.firstLineBuffer
    state.firstLineBuffer = ""
    state.pendingFirstLine = false

    if (newlineIdx === -1) {
      textDelta = buffered
    } else {
      const firstLine = buffered.slice(0, newlineIdx).trim()
      const rest = buffered.slice(newlineIdx + 1)
      const parsedReasoning = parseReasoningJsonLine(firstLine)
      if (parsedReasoning) {
        reasoningDeltas.push(parsedReasoning)
        textDelta = rest
      } else {
        textDelta = buffered
      }
    }
  }

  const { text, reasoning } = extractThinkTagReasoning(state, textDelta)
  if (reasoning.length > 0) reasoningDeltas.push(...reasoning)

  return { textDelta: text, reasoningDeltas }
}

export function flushInlineReasoningPendingText(state: InlineReasoningState): string {
  if (!state.pendingFirstLine || !state.firstLineBuffer) return ""
  const pending = state.firstLineBuffer
  state.firstLineBuffer = ""
  state.pendingFirstLine = false
  return pending
}

function parseReasoningJsonLine(line: string): string | null {
  if (!line.startsWith("{") || !line.endsWith("}")) return null
  try {
    const parsed = JSON.parse(line) as { reasoning?: unknown }
    if (typeof parsed.reasoning !== "string") return null
    const reasoning = parsed.reasoning.trim()
    return reasoning.length > 0 ? reasoning : null
  } catch {
    return null
  }
}

function extractThinkTagReasoning(
  state: InlineReasoningState,
  input: string
): { text: string; reasoning: string[] } {
  if (!input) return { text: "", reasoning: [] }

  const reasoning: string[] = []
  let visibleText = ""
  let remaining = input

  while (remaining.length > 0) {
    if (state.inThinkTag) {
      const endIdx = remaining.indexOf("</think>")
      if (endIdx === -1) {
        reasoning.push(remaining)
        remaining = ""
        break
      }
      const chunk = remaining.slice(0, endIdx)
      if (chunk) reasoning.push(chunk)
      remaining = remaining.slice(endIdx + "</think>".length)
      state.inThinkTag = false
      continue
    }

    const startIdx = remaining.indexOf("<think>")
    if (startIdx === -1) {
      visibleText += remaining
      remaining = ""
      break
    }
    visibleText += remaining.slice(0, startIdx)
    remaining = remaining.slice(startIdx + "<think>".length)
    state.inThinkTag = true
  }

  return { text: visibleText, reasoning }
}
