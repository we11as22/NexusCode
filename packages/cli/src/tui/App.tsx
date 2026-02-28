import React, { useState, useEffect, useCallback, useRef } from "react"
import { Box, Text, useInput, useApp, Static } from "ink"
import Spinner from "ink-spinner"
import type { AgentEvent, Mode, SessionMessage } from "@nexuscode/core"

interface AppState {
  messages: SessionMessage[]
  mode: Mode
  maxMode: boolean
  isRunning: boolean
  model: string
  provider: string
  todo: string
  indexReady: boolean
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

const MODE_ICONS: Record<Mode, string> = {
  agent: "⚡",
  plan: "📋",
  debug: "🔍",
  ask: "💬",
}

const MODES: Mode[] = ["agent", "plan", "debug", "ask"]

export function App({
  onMessage, onAbort, onCompact, onModeChange, onMaxModeChange,
  events, initialModel, initialProvider, initialMode, initialMaxMode,
}: AppProps) {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    messages: [],
    mode: initialMode,
    maxMode: initialMaxMode,
    isRunning: false,
    model: initialModel,
    provider: initialProvider,
    todo: "",
    indexReady: false,
  })
  const [input, setInput] = useState("")
  const [currentResponse, setCurrentResponse] = useState("")

  // Process events
  useEffect(() => {
    async function processEvents() {
      for await (const event of events) {
        switch (event.type) {
          case "text_delta":
            setCurrentResponse(prev => prev + (event.delta ?? ""))
            break

          case "done":
            setState(prev => {
              const userMsg = prev.messages[prev.messages.length - 1]
              const msgs = [
                ...prev.messages,
                { id: `r_${Date.now()}`, ts: Date.now(), role: "assistant" as const, content: currentResponse },
              ]
              setCurrentResponse("")
              return { ...prev, messages: msgs, isRunning: false }
            })
            break

          case "error":
            setState(prev => ({
              ...prev,
              isRunning: false,
              messages: [
                ...prev.messages,
                { id: `e_${Date.now()}`, ts: Date.now(), role: "system" as const, content: `Error: ${event.error}` },
              ],
            }))
            setCurrentResponse("")
            break

          case "tool_start":
            // Could show tool activity
            break

          case "compaction_end":
            // Refresh state after compaction
            break
        }
      }
    }
    processEvents().catch(console.error)
  }, [events])

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      if (state.isRunning) {
        onAbort()
        setState(prev => ({ ...prev, isRunning: false }))
      } else {
        exit()
      }
      return
    }

    if (key.ctrl && inputChar === "k") {
      setState(prev => ({ ...prev, messages: [], todo: "" }))
      return
    }

    if (key.ctrl && inputChar === "s") {
      onCompact()
      return
    }

    if (key.tab) {
      const currentIdx = MODES.indexOf(state.mode)
      const nextMode = MODES[(currentIdx + 1) % MODES.length]!
      setState(prev => ({ ...prev, mode: nextMode }))
      onModeChange(nextMode)
      return
    }

    if (key.return) {
      if (input.trim() && !state.isRunning) {
        const content = input.trim()
        setInput("")
        setState(prev => ({
          ...prev,
          isRunning: true,
          messages: [...prev.messages, { id: `u_${Date.now()}`, ts: Date.now(), role: "user", content }],
        }))
        onMessage(content, state.mode)
      }
      return
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1))
      return
    }

    if (inputChar && !key.ctrl && !key.meta) {
      setInput(prev => prev + inputChar)
    }
  })

  const cols = process.stdout.columns ?? 80

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>⚡ NexusCode</Text>
        <Text> </Text>
        <Text color="yellow">{MODE_ICONS[state.mode]} {state.mode.toUpperCase()}</Text>
        {state.maxMode && <Text color="yellow"> [MAX]</Text>}
        <Text color="gray"> | {state.provider}/{state.model}</Text>
        {state.indexReady && <Text color="gray"> | indexed</Text>}
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <Static items={state.messages}>
          {(msg, i) => <MessageItem key={i} msg={msg} cols={cols} />}
        </Static>

        {/* Streaming response */}
        {state.isRunning && currentResponse && (
          <Box paddingX={1}>
            <Text>{currentResponse.slice(-1000)}</Text>
          </Box>
        )}

        {/* Thinking indicator */}
        {state.isRunning && !currentResponse && (
          <Box paddingX={1}>
            <Text color="blue"><Spinner type="dots" /></Text>
            <Text color="blue"> thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Todo (if active) */}
      {state.todo && (
        <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={0}>
          <Text color="gray">Progress: </Text>
          <Text>{state.todo.split("\n")[0]}</Text>
        </Box>
      )}

      {/* Input */}
      <Box borderStyle="single" borderColor={state.isRunning ? "red" : "green"} paddingX={1}>
        <Text color={state.isRunning ? "red" : "green"}>
          {state.isRunning ? "[RUNNING]" : `[${state.mode}]`}
        </Text>
        <Text> › </Text>
        <Text>{input}</Text>
        <Text color="gray">█</Text>
      </Box>

      {/* Footer hints */}
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          Enter: send  •  Tab: mode  •  Ctrl+S: compact  •  Ctrl+K: clear  •  Ctrl+C: {state.isRunning ? "abort" : "quit"}
        </Text>
      </Box>
    </Box>
  )
}

function MessageItem({ msg, cols }: { msg: SessionMessage; cols: number }) {
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)

  if (msg.role === "user") {
    return (
      <Box paddingX={1} paddingY={0}>
        <Box>
          <Text bold color="cyan">You: </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      </Box>
    )
  }

  if (msg.role === "assistant") {
    return (
      <Box paddingX={1} paddingY={0} flexDirection="column">
        <Text bold color="green">Nexus:</Text>
        <Box paddingLeft={2}>
          <Text wrap="wrap">
            {content.length > 2000 ? content.slice(-2000) + "\n[...truncated]" : content}
          </Text>
        </Box>
      </Box>
    )
  }

  if (msg.role === "system") {
    return (
      <Box paddingX={1}>
        <Text color="red">{content}</Text>
      </Box>
    )
  }

  return null
}
