import React, { useState, useEffect, useCallback, useRef } from "react"
import { Box, Text, useInput, useApp, Static, Newline } from "ink"
import Spinner from "ink-spinner"
import type { AgentEvent, Mode, SessionMessage, ToolPart, ReasoningPart } from "@nexuscode/core"

// ─── Types ──────────────────────────────────────────────────────────────────

interface LiveTool {
  id: string
  tool: string
  status: "running" | "completed" | "error"
  input?: Record<string, unknown>
  output?: string
  timeStart: number
  timeEnd?: number
}

interface AppState {
  messages: SessionMessage[]
  liveTools: LiveTool[]
  reasoning: string
  mode: Mode
  maxMode: boolean
  isRunning: boolean
  model: string
  provider: string
  todo: string
  indexReady: boolean
  totalTokensIn: number
  totalTokensOut: number
  lastError: string | null
  awaitingApproval: boolean
  compacting: boolean
  currentStreaming: string
}

interface AppProps {
  onMessage: (content: string, mode: Mode) => void
  onAbort: () => void
  onCompact: () => void
  onModeChange: (mode: Mode) => void
  onMaxModeChange: (enabled: boolean) => void
  events: AsyncIterable<AgentEvent>
  initialModel: string
  initialProvider: string
  initialMode: Mode
  initialMaxMode: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MODE_ICONS: Record<Mode, string> = {
  agent: "⚡",
  plan: "📋",
  debug: "🔍",
  ask: "💬",
}

const MODE_COLORS: Record<Mode, string> = {
  agent: "cyan",
  plan: "blue",
  debug: "yellow",
  ask: "green",
}

const TOOL_ICONS: Record<string, string> = {
  read_file:            "📄",
  write_to_file:        "✏️",
  replace_in_file:      "🔧",
  execute_command:      "⚡",
  search_files:         "🔍",
  list_files:           "📂",
  list_code_definitions:"🏗️",
  codebase_search:      "🔎",
  web_fetch:            "🌐",
  web_search:           "🔍",
  apply_patch:          "📝",
  attempt_completion:   "✅",
  ask_followup_question:"❓",
  update_todo_list:     "📋",
  use_skill:            "🎯",
  browser_action:       "🌍",
  spawn_agent:          "🤖",
}

const MODES: Mode[] = ["agent", "plan", "debug", "ask"]

// ─── Main App ────────────────────────────────────────────────────────────────

export function App({
  onMessage, onAbort, onCompact, onModeChange, onMaxModeChange,
  events, initialModel, initialProvider, initialMode, initialMaxMode,
}: AppProps) {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    messages: [],
    liveTools: [],
    reasoning: "",
    mode: initialMode,
    maxMode: initialMaxMode,
    isRunning: false,
    model: initialModel,
    provider: initialProvider,
    todo: "",
    indexReady: false,
    totalTokensIn: 0,
    totalTokensOut: 0,
    lastError: null,
    awaitingApproval: false,
    compacting: false,
    currentStreaming: "",
  })
  const [input, setInput] = useState("")
  const [historyIdx, setHistoryIdx] = useState(-1)
  const inputHistory = useRef<string[]>([])
  const cols = process.stdout.columns ?? 100
  const rows = process.stdout.rows ?? 30

  // Process agent events
  useEffect(() => {
    let active = true
    async function processEvents() {
      for await (const event of events) {
        if (!active) break
        switch (event.type) {
          case "text_delta":
            setState(s => ({ ...s, currentStreaming: s.currentStreaming + (event.delta ?? "") }))
            break

          case "reasoning_delta":
            setState(s => ({ ...s, reasoning: s.reasoning + (event.delta ?? "") }))
            break

          case "tool_start":
            setState(s => ({
              ...s,
              liveTools: [...s.liveTools, {
                id: event.partId,
                tool: event.tool,
                status: "running",
                timeStart: Date.now(),
              }],
            }))
            break

          case "tool_end":
            setState(s => ({
              ...s,
              liveTools: s.liveTools.map(lt =>
                lt.id === event.partId
                  ? { ...lt, status: event.success ? "completed" : "error", timeEnd: Date.now() }
                  : lt
              ),
            }))
            break

          case "tool_approval_needed":
            setState(s => ({ ...s, awaitingApproval: true }))
            break

          case "done":
            setState(s => {
              const text = s.currentStreaming
              const newMsg: SessionMessage = {
                id: `r_${Date.now()}`,
                ts: Date.now(),
                role: "assistant",
                content: text,
              }
              return {
                ...s,
                messages: [...s.messages, newMsg],
                liveTools: [],
                reasoning: "",
                currentStreaming: "",
                isRunning: false,
                awaitingApproval: false,
                lastError: null,
              }
            })
            break

          case "error":
            setState(s => ({
              ...s,
              isRunning: s.awaitingApproval ? s.isRunning : false,
              lastError: event.error,
              liveTools: s.liveTools.map(lt =>
                lt.status === "running" ? { ...lt, status: "error", timeEnd: Date.now() } : lt
              ),
            }))
            break

          case "compaction_start":
            setState(s => ({ ...s, compacting: true }))
            break

          case "compaction_end":
            setState(s => ({ ...s, compacting: false }))
            break

          case "index_update":
            if (event.status.state === "ready") {
              setState(s => ({ ...s, indexReady: true }))
            }
            break

          case "doom_loop_detected":
            setState(s => ({
              ...s,
              lastError: `Doom loop detected: "${event.tool}" called repeatedly with same args`,
            }))
            break
        }
      }
    }
    processEvents().catch(() => {})
    return () => { active = false }
  }, [events])

  useInput((inputChar, key) => {
    // Ctrl+C
    if (key.ctrl && inputChar === "c") {
      if (state.isRunning) {
        onAbort()
        setState(s => ({ ...s, isRunning: false, liveTools: [], awaitingApproval: false }))
      } else {
        exit()
      }
      return
    }

    // Ctrl+K — clear chat
    if (key.ctrl && inputChar === "k") {
      setState(s => ({ ...s, messages: [], todo: "", lastError: null, liveTools: [] }))
      return
    }

    // Ctrl+S — compact
    if (key.ctrl && inputChar === "s") {
      if (!state.isRunning) onCompact()
      return
    }

    // Ctrl+M — toggle max mode
    if (key.ctrl && inputChar === "m") {
      const next = !state.maxMode
      setState(s => ({ ...s, maxMode: next }))
      onMaxModeChange(next)
      return
    }

    // Tab — cycle mode
    if (key.tab) {
      const idx = MODES.indexOf(state.mode)
      const next = MODES[(idx + 1) % MODES.length]!
      setState(s => ({ ...s, mode: next }))
      onModeChange(next)
      return
    }

    // Up arrow — history
    if (key.upArrow) {
      const hist = inputHistory.current
      if (hist.length > 0) {
        const next = Math.min(historyIdx + 1, hist.length - 1)
        setHistoryIdx(next)
        setInput(hist[hist.length - 1 - next]!)
      }
      return
    }

    // Down arrow — history
    if (key.downArrow) {
      if (historyIdx > 0) {
        const next = historyIdx - 1
        setHistoryIdx(next)
        setInput(inputHistory.current[inputHistory.current.length - 1 - next]!)
      } else {
        setHistoryIdx(-1)
        setInput("")
      }
      return
    }

    // Enter — send
    if (key.return) {
      if (input.trim() && !state.isRunning) {
        const content = input.trim()
        inputHistory.current.push(content)
        if (inputHistory.current.length > 50) inputHistory.current.shift()
        setHistoryIdx(-1)
        setInput("")
        setState(s => ({
          ...s,
          isRunning: true,
          lastError: null,
          messages: [...s.messages, {
            id: `u_${Date.now()}`,
            ts: Date.now(),
            role: "user",
            content,
          }],
        }))
        onMessage(content, state.mode)
      }
      return
    }

    // Backspace
    if (key.backspace || key.delete) {
      setInput(s => s.slice(0, -1))
      return
    }

    // Regular chars
    if (inputChar && !key.ctrl && !key.meta) {
      setInput(s => s + inputChar)
    }
  })

  const modeColor = MODE_COLORS[state.mode]

  return (
    <Box flexDirection="column" height={rows}>
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <Header
        mode={state.mode}
        maxMode={state.maxMode}
        provider={state.provider}
        model={state.model}
        indexReady={state.indexReady}
        isRunning={state.isRunning}
        compacting={state.compacting}
        tokensIn={state.totalTokensIn}
        tokensOut={state.totalTokensOut}
        cols={cols}
      />

      {/* ── Messages ──────────────────────────────────────────────────────── */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <Static items={state.messages}>
          {(msg, i) => <MessageItem key={i} msg={msg} cols={cols} />}
        </Static>

        {/* Live: reasoning */}
        {state.isRunning && state.reasoning && (
          <ReasoningBlock text={state.reasoning} cols={cols} />
        )}

        {/* Live: streaming text */}
        {state.isRunning && state.currentStreaming && (
          <StreamingText text={state.currentStreaming} cols={cols} />
        )}

        {/* Live: active tool calls */}
        {state.liveTools.filter(lt => lt.status === "running").map(lt => (
          <LiveToolCard key={lt.id} tool={lt} />
        ))}

        {/* Compaction */}
        {state.compacting && (
          <Box paddingX={1} paddingY={0}>
            <Text color="blue"><Spinner type="dots" /></Text>
            <Text color="blue"> Compacting context...</Text>
          </Box>
        )}

        {/* Waiting for input */}
        {state.isRunning && !state.currentStreaming && !state.reasoning && state.liveTools.length === 0 && (
          <Box paddingX={1}>
            <Text color="cyan"><Spinner type="dots3" /></Text>
            <Text color="cyan"> Thinking...</Text>
          </Box>
        )}

        {/* Error */}
        {state.lastError && (
          <ErrorBanner message={state.lastError} />
        )}
      </Box>

      {/* ── Todo ──────────────────────────────────────────────────────────── */}
      {state.todo && <TodoBar todo={state.todo} cols={cols} />}

      {/* ── Input Bar ─────────────────────────────────────────────────────── */}
      <InputBar
        input={input}
        mode={state.mode}
        modeColor={modeColor}
        isRunning={state.isRunning}
        awaitingApproval={state.awaitingApproval}
      />

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <Footer isRunning={state.isRunning} />
    </Box>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Header({
  mode, maxMode, provider, model, indexReady, isRunning, compacting, tokensIn, tokensOut, cols,
}: {
  mode: Mode, maxMode: boolean, provider: string, model: string,
  indexReady: boolean, isRunning: boolean, compacting: boolean,
  tokensIn: number, tokensOut: number, cols: number,
}) {
  const icon = MODE_ICONS[mode]
  const color = MODE_COLORS[mode]
  const shortModel = model.length > 25 ? "..." + model.slice(-22) : model
  return (
    <Box paddingX={1} paddingY={0}>
      <Text color="cyan" bold>⚡ NexusCode</Text>
      <Text color="gray"> │ </Text>
      <Text color={color as any} bold>{icon} {mode.toUpperCase()}</Text>
      {maxMode && <Text color="yellow" bold> ⚡MAX</Text>}
      <Text color="gray"> │ </Text>
      <Text color="gray">{provider}/</Text>
      <Text color="white">{shortModel}</Text>
      {indexReady && <><Text color="gray"> │ </Text><Text color="green">indexed</Text></>}
      {isRunning && !compacting && <><Text color="gray"> │ </Text><Text color="yellow"><Spinner type="dots" /></Text></>}
      {compacting && <><Text color="gray"> │ </Text><Text color="blue">compacting...</Text></>}
    </Box>
  )
}

function MessageItem({ msg, cols }: { msg: SessionMessage; cols: number }) {
  const content = typeof msg.content === "string" ? msg.content : "[complex message]"

  if (msg.role === "user") {
    return (
      <Box paddingX={1} paddingTop={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">▶ You</Text>
          <Text color="gray"> ─────────────────────────────────</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text wrap="wrap" color="white">{content}</Text>
        </Box>
      </Box>
    )
  }

  if (msg.role === "assistant") {
    const trimmed = content.length > 3000
      ? content.slice(0, 1500) + "\n\n[...]\n\n" + content.slice(-800)
      : content
    return (
      <Box paddingX={1} paddingTop={1} flexDirection="column">
        <Box>
          <Text bold color="green">◀ NexusCode</Text>
          <Text color="gray"> ──────────────────────────────</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text wrap="wrap">{trimmed}</Text>
        </Box>
      </Box>
    )
  }

  if (msg.summary) {
    return (
      <Box paddingX={1} marginY={0} borderStyle="round" borderColor="gray">
        <Text color="gray" bold>📝 Context summary</Text>
        <Text color="gray"> (compacted history)</Text>
      </Box>
    )
  }

  if (msg.role === "system") {
    return (
      <Box paddingX={1}>
        <Text color="red" dimColor>⚠ {content}</Text>
      </Box>
    )
  }

  return null
}

function ReasoningBlock({ text, cols }: { text: string; cols: number }) {
  const lines = text.split("\n")
  const preview = lines.slice(-5).join("\n")
  return (
    <Box paddingX={1} paddingY={0} flexDirection="column">
      <Text color="magenta" dimColor>💭 Thinking...</Text>
      <Box paddingLeft={2} borderStyle="single" borderColor="magenta">
        <Text color="magenta" dimColor wrap="wrap">
          {preview.length > 400 ? "..." + preview.slice(-400) : preview}
        </Text>
      </Box>
    </Box>
  )
}

function StreamingText({ text, cols }: { text: string; cols: number }) {
  const maxLen = (cols - 4) * 15
  const display = text.length > maxLen ? text.slice(-maxLen) : text
  return (
    <Box paddingX={1} paddingLeft={3} flexDirection="column">
      <Text wrap="wrap" color="white">{display}</Text>
    </Box>
  )
}

function LiveToolCard({ tool }: { tool: LiveTool }) {
  const icon = TOOL_ICONS[tool.tool] ?? "🔧"
  const elapsed = tool.timeStart ? `${((Date.now() - tool.timeStart) / 1000).toFixed(1)}s` : ""

  // Build preview of input args
  let preview = ""
  if (tool.input) {
    const path = tool.input["path"] ?? tool.input["command"] ?? tool.input["query"] ?? tool.input["url"]
    if (path) preview = String(path).slice(0, 50)
  }

  return (
    <Box paddingX={1} paddingLeft={2}>
      <Text color="yellow"><Spinner type="arc" /></Text>
      <Text color="yellow"> {icon} {tool.tool}</Text>
      {preview && <Text color="gray"> {preview}</Text>}
      {elapsed && <Text color="gray" dimColor> ({elapsed})</Text>}
    </Box>
  )
}

function TodoBar({ todo, cols }: { todo: string; cols: number }) {
  const lines = todo.split("\n").filter(l => l.trim())
  const completed = lines.filter(l => l.includes("[x]") || l.includes("✅")).length
  const total = lines.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  const firstLine = lines[0]?.slice(0, cols - 20) ?? ""

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray" flexDirection="row">
      <Text color="gray">Progress </Text>
      <Text color="cyan">[{completed}/{total}]</Text>
      <Text color="gray"> {pct}% </Text>
      <Text color="gray" dimColor>{firstLine}</Text>
    </Box>
  )
}

function InputBar({ input, mode, modeColor, isRunning, awaitingApproval }: {
  input: string, mode: Mode, modeColor: string, isRunning: boolean, awaitingApproval: boolean,
}) {
  const borderColor = awaitingApproval ? "yellow" : isRunning ? "red" : "cyan"
  const prompt = awaitingApproval ? "[AWAITING APPROVAL]" : isRunning ? "[ABORT: Ctrl+C]" : `[${mode}]`
  const promptColor = awaitingApproval ? "yellow" : isRunning ? "red" : (modeColor as any)

  return (
    <Box borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={promptColor} bold>{prompt}</Text>
      <Text color="gray"> › </Text>
      <Text color="white">{input}</Text>
      <Text color={isRunning ? "gray" : "cyan"}>█</Text>
    </Box>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <Box paddingX={1} paddingY={0} borderStyle="single" borderColor="red">
      <Text color="red" bold>✗ Error: </Text>
      <Text color="red" wrap="wrap">{message.slice(0, 200)}</Text>
    </Box>
  )
}

function Footer({ isRunning }: { isRunning: boolean }) {
  return (
    <Box paddingX={1}>
      <Text color="gray" dimColor>
        Tab:mode  Ctrl+M:maxMode  Ctrl+S:compact  Ctrl+K:clear  Ctrl+C:{isRunning ? "abort" : "quit"}  ↑↓:history
      </Text>
    </Box>
  )
}
