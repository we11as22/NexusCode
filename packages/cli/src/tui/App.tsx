import React, { useState, useEffect, useRef, useMemo } from "react"
import { Box, Text, useInput, useApp } from "ink"
import Spinner from "ink-spinner"
import type { AgentEvent, Mode, SessionMessage, IndexStatus, PermissionResult } from "@nexuscode/core"

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

interface SubAgentState {
  id: string
  mode: Mode
  task: string
  status: "running" | "completed" | "error"
  currentTool?: string
  startedAt: number
  finishedAt?: number
  error?: string
}

interface AppState {
  messages: SessionMessage[]
  liveTools: LiveTool[]
  subAgents: SubAgentState[]
  reasoning: string
  mode: Mode
  isRunning: boolean
  model: string
  provider: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatus | null
  totalTokensIn: number
  totalTokensOut: number
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  lastError: string | null
  awaitingApproval: boolean
  compacting: boolean
  currentStreaming: string
  /** OpenCode-style: toggle reasoning block visibility */
  showThinking: boolean
  /** OpenCode-style: toggle tool execution details in chat */
  showToolDetails: boolean
  /** Plan mode: plan_exit was called; show Approve / Revise / Abandon */
  planCompleted: boolean
}

interface AppProps {
  onMessage: (content: string, mode: Mode) => void
  onAbort: () => void
  onCompact: () => void
  onModeChange: (mode: Mode) => void
  events: AsyncIterable<AgentEvent>
  /** Initial chat history (e.g. from resumed session) */
  initialMessages?: SessionMessage[]
  initialModel: string
  initialProvider: string
  initialMode: Mode
  sessionId?: string
  projectDir?: string
  profileNames?: string[]
  onProfileSelect?: (profileName?: string) => void
  noIndex?: boolean
  configSnapshot?: {
    model: { provider: string; id: string; temperature?: number }
    embeddings?: { provider: string; model: string; dimensions?: number }
    indexing: { enabled: boolean; vector: boolean }
    vectorDb?: { enabled: boolean; url: string }
    mcp?: { servers: Array<Record<string, unknown>> }
    skills?: string[]
    rules?: { files: string[] }
    modes?: {
      agent?: { customInstructions?: string }
      plan?: { customInstructions?: string }
      ask?: { customInstructions?: string }
    }
    profiles?: Record<string, Record<string, unknown>>
  }
  saveConfig?: (updates: Record<string, unknown>) => void
  onReindex?: () => void
  onIndexStop?: () => void
  /** Resolve pending tool approval (y/n/a/s). Called when user submits during awaitingApproval. */
  onResolveApproval?: (result: PermissionResult) => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** OpenCode-style: batch UI updates every 16ms to avoid re-render on every stream chunk */
const EVENT_BATCH_MS = 16

const MODE_ICONS: Record<Mode, string> = {
  agent: "⚡",
  plan: "📋",
  ask: "💬",
}

const MODE_COLORS: Record<Mode, string> = {
  agent: "cyan",
  plan: "blue",
  ask: "green",
}

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  write_to_file: "✏️",
  replace_in_file: "🔧",
  execute_command: "⚡",
  search_files: "🔍",
  list_files: "📂",
  list_code_definitions: "🏗️",
  codebase_search: "🔎",
  web_fetch: "🌐",
  web_search: "🔍",
  apply_patch: "📝",
  attempt_completion: "✅",
  ask_followup_question: "❓",
  update_todo_list: "📋",
  use_skill: "🎯",
  browser_action: "🌍",
  spawn_agent: "🤖",
}

const MODES: Mode[] = ["agent", "plan", "ask"]
const MODEL_PROVIDERS = ["anthropic", "openai", "google", "openai-compatible", "ollama", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity"] as const
const EMBEDDING_PROVIDERS = ["openai", "openai-compatible", "ollama", "local"] as const

/** Slash commands (OpenCode-style: /new, /sessions, /compact, /thinking, /details, etc.) */
type SlashAction = "clear" | "compact" | "help" | "settings" | "model" | "embeddings" | "index" | "advanced" | "thinking" | "details"
const SLASH_COMMANDS: Array<{ cmd: string; label: string; desc: string; mode?: Mode; action?: SlashAction }> = [
  { cmd: "agent", label: "/agent", desc: "Agent mode (code & tools)", mode: "agent" },
  { cmd: "plan", label: "/plan", desc: "Plan mode", mode: "plan" },
  { cmd: "ask", label: "/ask", desc: "Ask mode (Q&A)", mode: "ask" },
  { cmd: "clear", label: "/clear", desc: "Clear chat", action: "clear" },
  { cmd: "new", label: "/new", desc: "New session (clear chat)", action: "clear" },
  { cmd: "compact", label: "/compact", desc: "Compact context", action: "compact" },
  { cmd: "thinking", label: "/thinking", desc: "Toggle reasoning visibility", action: "thinking" },
  { cmd: "details", label: "/details", desc: "Toggle tool execution details", action: "details" },
  { cmd: "model", label: "/model", desc: "Configure LLM provider & model", action: "model" },
  { cmd: "embeddings", label: "/embeddings", desc: "Configure embeddings model", action: "embeddings" },
  { cmd: "index", label: "/index", desc: "Index status & reindex", action: "index" },
  { cmd: "advanced", label: "/advanced", desc: "MCP / skills / rules / profiles", action: "advanced" },
  { cmd: "help", label: "/help", desc: "Show shortcuts", action: "help" },
  { cmd: "settings", label: "/settings", desc: "Full agent settings", action: "settings" },
]

// ─── Logo (в рамке, по центру) ───────────────────────────────────────────────

const LOGO_TEXT = "NexusCode CLI · Agent Hub"
const LOGO_WIDTH = LOGO_TEXT.length

function Logo({ cols }: { cols: number }) {
  const pad = Math.max(0, Math.floor((cols - LOGO_WIDTH) / 2))
  return (
    <Box paddingBottom={1} paddingLeft={pad}>
      <Text color="cyan" bold>{LOGO_TEXT}</Text>
    </Box>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export function App({
  onMessage,
  onAbort,
  onCompact,
  onModeChange,
  events,
  initialMessages,
  initialModel,
  initialProvider,
  initialMode,
  sessionId,
  projectDir,
  profileNames = [],
  onProfileSelect,
  noIndex = false,
  configSnapshot,
  saveConfig,
  onReindex,
  onIndexStop,
  onResolveApproval,
}: AppProps) {
  const { exit } = useApp()
  type View = "chat" | "model" | "embeddings" | "settings" | "index" | "advanced" | "help"
  const [view, setView] = useState<View>("chat")
  const [state, setState] = useState<AppState>({
    messages: initialMessages ?? [],
    liveTools: [],
    subAgents: [],
    reasoning: "",
    mode: initialMode,
    isRunning: false,
    model: initialModel,
    provider: initialProvider,
    todo: "",
    indexReady: false,
    indexStatus: null,
    totalTokensIn: 0,
    totalTokensOut: 0,
    contextUsedTokens: 0,
    contextLimitTokens: 128000,
    contextPercent: 0,
    lastError: null,
    awaitingApproval: false,
    compacting: false,
    currentStreaming: "",
    showThinking: true,
    showToolDetails: true,
    planCompleted: false,
  })
  const [input, setInput] = useState("")
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [slashSelected, setSlashSelected] = useState(0)
  const [modelForm, setModelForm] = useState({ provider: "", id: "", apiKey: "", baseUrl: "", temperature: "" })
  const [modelFocus, setModelFocus] = useState(0)
  const [embeddingsForm, setEmbeddingsForm] = useState({ provider: "openai", model: "", apiKey: "", baseUrl: "", dimensions: "" })
  const [embeddingsFocus, setEmbeddingsFocus] = useState(0)
  const [advancedForm, setAdvancedForm] = useState({
    mcpServersJson: "[]",
    skillsText: "",
    claudeMdPath: "CLAUDE.md",
    rulesFilesText: "",
    agentInstructions: "",
    planInstructions: "",
    askInstructions: "",
    profilesJson: "{}",
  })
  const [advancedFocus, setAdvancedFocus] = useState(0)
  const [activeProfileIdx, setActiveProfileIdx] = useState(0)
  const [chatScrollLines, setChatScrollLines] = useState(0)
  const inputHistory = useRef<string[]>([])
  const eventQueueRef = useRef<AgentEvent[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSubmitRef = useRef<number>(0)
  const cols = process.stdout.columns ?? 100
  const rows = process.stdout.rows ?? 30
  const profileOptions = useMemo(() => ["default", ...profileNames], [profileNames])

  const slashOpen = input.startsWith("/")
  const slashQuery = slashOpen ? input.slice(1).toLowerCase().trim() : ""
  const filteredCommands = useMemo(() => {
    if (!slashQuery) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (c) => c.cmd.startsWith(slashQuery) || c.cmd.includes(slashQuery)
    )
  }, [slashQuery])
  const selectedCmd = filteredCommands[Math.min(slashSelected, filteredCommands.length - 1)]

  // Sync slashSelected when filter changes
  useEffect(() => {
    setSlashSelected(0)
  }, [slashQuery])

  // Init form from config when opening a config view
  useEffect(() => {
    if (view === "model" && configSnapshot) {
      setModelForm({
        provider: configSnapshot.model?.provider ?? "anthropic",
        id: configSnapshot.model?.id ?? "",
        apiKey: "",
        baseUrl: "",
        temperature: configSnapshot.model?.temperature != null ? String(configSnapshot.model.temperature) : "",
      })
      setModelFocus(0)
    }
    if (view === "embeddings" && configSnapshot?.embeddings) {
      setEmbeddingsForm({
        provider: configSnapshot.embeddings.provider,
        model: configSnapshot.embeddings.model,
        apiKey: "",
        baseUrl: "",
        dimensions: configSnapshot.embeddings.dimensions != null ? String(configSnapshot.embeddings.dimensions) : "",
      })
      setEmbeddingsFocus(0)
    }
    if (view === "advanced" && configSnapshot) {
      const allRules = configSnapshot.rules?.files ?? []
      const claudeMdPath = allRules.find((f) => /CLAUDE\.md$/i.test(f)) ?? "CLAUDE.md"
      setAdvancedForm({
        mcpServersJson: JSON.stringify(configSnapshot.mcp?.servers ?? [], null, 2),
        skillsText: (configSnapshot.skills ?? []).join("\n"),
        claudeMdPath,
        rulesFilesText: allRules.filter((f) => !/CLAUDE\.md$/i.test(f)).join("\n"),
        agentInstructions: configSnapshot.modes?.agent?.customInstructions ?? "",
        planInstructions: configSnapshot.modes?.plan?.customInstructions ?? "",
        askInstructions: configSnapshot.modes?.ask?.customInstructions ?? "",
        profilesJson: JSON.stringify(configSnapshot.profiles ?? {}, null, 2),
      })
      setAdvancedFocus(0)
    }
  }, [view, configSnapshot])

  // Process agent events (OpenCode-style: batch every EVENT_BATCH_MS to reduce re-renders)
  useEffect(() => {
    let active = true

    function flush() {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      const batch = eventQueueRef.current.splice(0)
      if (batch.length === 0) return
      let resetScroll = false
      for (const event of batch) {
        if (event.type === "done") resetScroll = true
        switch (event.type) {
          case "text_delta":
            setState((s) => ({ ...s, currentStreaming: s.currentStreaming + (event.delta ?? "") }))
            break
          case "reasoning_delta":
            setState((s) => ({ ...s, reasoning: s.reasoning + (event.delta ?? "") }))
            break
          case "tool_start":
            setState((s) => ({
              ...s,
              liveTools: [
                ...s.liveTools,
                {
                  id: event.partId,
                  tool: event.tool,
                  status: "running" as const,
                  timeStart: Date.now(),
                },
              ].slice(-64),
            }))
            break
          case "tool_end":
            setState((s) => ({
              ...s,
              liveTools: s.liveTools.map((lt) =>
                lt.id === event.partId
                  ? { ...lt, status: event.success ? "completed" : "error", timeEnd: Date.now() }
                  : lt
              ),
              ...(event.tool === "plan_exit" && event.success ? { planCompleted: true } : {}),
            }))
            break
          case "subagent_start":
            setState((s) => {
              const next = s.subAgents.filter((a) => a.id !== event.subagentId)
              next.push({
                id: event.subagentId,
                mode: event.mode,
                task: event.task,
                status: "running",
                startedAt: Date.now(),
              })
              return { ...s, subAgents: next.slice(-8) }
            })
            break
          case "subagent_tool_start":
            setState((s) => ({
              ...s,
              subAgents: s.subAgents.map((a) =>
                a.id === event.subagentId
                  ? { ...a, status: "running", currentTool: event.tool }
                  : a
              ),
            }))
            break
          case "subagent_tool_end":
            setState((s) => ({
              ...s,
              subAgents: s.subAgents.map((a) =>
                a.id === event.subagentId
                  ? {
                      ...a,
                      status: event.success ? "running" : "error",
                      currentTool: event.success ? undefined : event.tool,
                    }
                  : a
              ),
            }))
            break
          case "subagent_done":
            setState((s) => ({
              ...s,
              subAgents: s.subAgents.map((a) =>
                a.id === event.subagentId
                  ? {
                      ...a,
                      status: event.success ? "completed" : "error",
                      currentTool: undefined,
                      finishedAt: Date.now(),
                      error: event.error,
                    }
                  : a
              ),
            }))
            break
          case "tool_approval_needed":
            setState((s) => ({ ...s, awaitingApproval: true }))
            break
          case "done":
            setState((s) => {
              const text = stripToolCallMarkup(s.currentStreaming)
              const hasText = text.trim().length > 0
              const newMsg: SessionMessage | null = hasText
                ? {
                    id: `r_${Date.now()}`,
                    ts: Date.now(),
                    role: "assistant",
                    content: text,
                  }
                : null
              const noFinalTextMsg: SessionMessage | null = !hasText && s.liveTools.length > 0
                ? {
                    id: `sys_${Date.now()}`,
                    ts: Date.now(),
                    role: "system",
                    content: "No final text response was produced. Retry with a narrower prompt or switch to agent mode.",
                  }
                : null
              return {
                ...s,
                messages: newMsg
                  ? [...s.messages, newMsg]
                  : (noFinalTextMsg ? [...s.messages, noFinalTextMsg] : s.messages),
                subAgents: s.subAgents.filter((a) => a.status === "running"),
                reasoning: "",
                currentStreaming: "",
                isRunning: false,
                awaitingApproval: false,
                lastError: null,
              }
            })
            break
          case "error":
            setState((s) => ({
              ...s,
              isRunning: s.awaitingApproval ? s.isRunning : false,
              lastError: event.error,
              liveTools: s.liveTools.map((lt) =>
                lt.status === "running" ? { ...lt, status: "error", timeEnd: Date.now() } : lt
              ),
              subAgents: s.subAgents.map((a) =>
                a.status === "running"
                  ? { ...a, status: "error", finishedAt: Date.now(), error: "Aborted with parent error" }
                  : a
              ),
            }))
            break
          case "compaction_start":
            setState((s) => ({ ...s, compacting: true }))
            break
          case "compaction_end":
            setState((s) => ({ ...s, compacting: false }))
            break
          case "index_update":
            if (event.status.state === "ready") {
              setState((s) => ({ ...s, indexReady: true, indexStatus: event.status }))
            } else {
              setState((s) => ({ ...s, indexStatus: event.status }))
            }
            break
          case "doom_loop_detected":
            setState((s) => ({
              ...s,
              lastError: `Doom loop: "${event.tool}" repeated`,
            }))
            break
        }
        if ((event as { type: string }).type === "context_usage") {
          const usage = event as { type: "context_usage"; usedTokens: number; limitTokens: number; percent: number }
          setState((s) => ({
            ...s,
            contextUsedTokens: usage.usedTokens,
            contextLimitTokens: usage.limitTokens,
            contextPercent: usage.percent,
          }))
        }
      }
      if (resetScroll) setChatScrollLines(0)
    }

    async function processEvents() {
      for await (const event of events) {
        if (!active) break
        eventQueueRef.current.push(event)
        const immediate = event.type === "done" || event.type === "error"
        if (immediate) {
          flush()
        } else if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null
            flush()
          }, EVENT_BATCH_MS)
        }
      }
    }
    processEvents().catch(() => {})
    return () => {
      active = false
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [events])

  const applySlashCommand = (cmd: (typeof SLASH_COMMANDS)[0]) => {
    setInput("")
    setSlashSelected(0)
    if (cmd.mode) {
      setState((s) => ({ ...s, mode: cmd.mode!, planCompleted: false }))
      onModeChange(cmd.mode)
      setView("chat")
      return
    }
    switch (cmd.action) {
      case "clear":
        setState((s) => ({ ...s, messages: [], todo: "", lastError: null, liveTools: [], subAgents: [] }))
        setView("chat")
        return
      case "compact":
        if (!state.isRunning) onCompact()
        setView("chat")
        return
      case "model":
        setView("model")
        return
      case "embeddings":
        setView("embeddings")
        return
      case "index":
        setView("index")
        return
      case "advanced":
        setView("advanced")
        return
      case "settings":
        setView("settings")
        return
      case "help":
        setView("help")
        return
      case "thinking":
        setState((s) => ({ ...s, showThinking: !s.showThinking }))
        setView("chat")
        return
      case "details":
        setState((s) => ({ ...s, showToolDetails: !s.showToolDetails }))
        setView("chat")
        return
      default:
        return
    }
  }

  useInput((inputChar, key) => {
    const isEnter = key.return || inputChar === "\r" || inputChar === "\n"
    if (key.ctrl && inputChar === "c") {
      if (state.isRunning) {
        onAbort()
        setState((s) => ({ ...s, isRunning: false, liveTools: [], subAgents: [], awaitingApproval: false }))
      } else {
        exit()
      }
      return
    }

    // Plan mode: after plan_exit, [A]pprove / [R]evise / [D]abandon
    if (
      view === "chat" &&
      state.mode === "plan" &&
      state.planCompleted &&
      !state.isRunning &&
      (inputChar === "a" || inputChar === "A" || inputChar === "r" || inputChar === "R" || inputChar === "d" || inputChar === "D")
    ) {
      const action = inputChar.toLowerCase()
      if (action === "a") {
        setState((s) => ({ ...s, mode: "agent", planCompleted: false }))
        onModeChange("agent")
        onMessage(
          "Execute the plan above. Follow the steps in .nexus/plans/ and the plan we agreed. Do not ask for confirmation — proceed with implementation.",
          "agent"
        )
        return
      }
      if (action === "r") {
        setState((s) => ({ ...s, planCompleted: false }))
        return
      }
      if (action === "d") {
        setState((s) => ({ ...s, mode: "ask", planCompleted: false }))
        onModeChange("ask")
        return
      }
    }

    if (key.ctrl && inputChar === "k") {
      setState((s) => ({ ...s, messages: [], todo: "", lastError: null, liveTools: [], subAgents: [] }))
      setChatScrollLines(0)
      return
    }

    if (key.ctrl && inputChar === "s") {
      if (!state.isRunning) onCompact()
      return
    }

    if (key.ctrl && inputChar === "u" && view === "chat") {
      setChatScrollLines((v) => v + 12)
      return
    }
    if (key.ctrl && inputChar === "d" && view === "chat") {
      setChatScrollLines((v) => Math.max(0, v - 12))
      return
    }
    if (key.ctrl && inputChar === "b" && view === "chat") {
      setChatScrollLines((v) => v + 24)
      return
    }
    if (key.ctrl && inputChar === "f" && view === "chat") {
      setChatScrollLines((v) => Math.max(0, v - 24))
      return
    }
    if (view === "chat" && key.ctrl && inputChar === "g") {
      setChatScrollLines(0)
      return
    }
    if (view === "chat" && key.end) {
      setChatScrollLines(0)
      return
    }

    if (view === "chat" && key.pageUp) {
      setChatScrollLines((v) => v + 24)
      return
    }
    if (view === "chat" && key.pageDown) {
      setChatScrollLines((v) => Math.max(0, v - 24))
      return
    }

    if (key.ctrl && inputChar === "p") {
      if (profileOptions.length <= 1) return
      const nextIdx = (activeProfileIdx + 1) % profileOptions.length
      setActiveProfileIdx(nextIdx)
      const next = profileOptions[nextIdx]
      onProfileSelect?.(next && next !== "default" ? next : undefined)
      return
    }

    // When in config views, handle Tab / Enter / Backspace / type here first (so they don't change mode or send message)
    if (view !== "chat") {
      if (key.escape) {
        setView("chat")
        return
      }
      if (view === "model") {
        if (modelFocus === 0 && (key.upArrow || key.downArrow)) {
          const currentIdx = Math.max(0, MODEL_PROVIDERS.findIndex((p) => p === modelForm.provider))
          const nextIdx = key.downArrow
            ? (currentIdx + 1) % MODEL_PROVIDERS.length
            : (currentIdx - 1 + MODEL_PROVIDERS.length) % MODEL_PROVIDERS.length
          setModelForm((f) => ({ ...f, provider: MODEL_PROVIDERS[nextIdx]! }))
          return
        }
        if (key.tab) {
          setModelFocus((f) => (f + 1) % 6)
          return
        }
        if (isEnter && modelFocus < 5) {
          setModelFocus((f) => (f + 1) % 6)
          return
        }
        if (isEnter && modelFocus === 5 && saveConfig) {
          const parsedTemp = Number(modelForm.temperature)
          saveConfig({
            model: {
              provider: modelForm.provider as any,
              id: modelForm.id,
              apiKey: modelForm.apiKey || undefined,
              baseUrl: modelForm.baseUrl || undefined,
              temperature: Number.isFinite(parsedTemp) ? Math.max(0, Math.min(2, parsedTemp)) : undefined,
            },
          })
          setView("chat")
          setState((s) => ({ ...s, provider: modelForm.provider, model: modelForm.id }))
          return
        }
        if (modelFocus > 0 && modelFocus < 5 && (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f" || inputChar === "\u0008")) {
          const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
          setModelForm((f) => ({ ...f, [k]: f[k].slice(0, -1) }))
          return
        }
        if (modelFocus > 0 && modelFocus < 5 && inputChar && !key.ctrl && !key.meta) {
          const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
          setModelForm((f) => ({ ...f, [k]: f[k] + inputChar }))
          return
        }
        return
      }
      if (view === "embeddings") {
        if (embeddingsFocus === 0 && (key.upArrow || key.downArrow)) {
          const currentIdx = Math.max(0, EMBEDDING_PROVIDERS.findIndex((p) => p === embeddingsForm.provider))
          const nextIdx = key.downArrow
            ? (currentIdx + 1) % EMBEDDING_PROVIDERS.length
            : (currentIdx - 1 + EMBEDDING_PROVIDERS.length) % EMBEDDING_PROVIDERS.length
          setEmbeddingsForm((f) => ({ ...f, provider: EMBEDDING_PROVIDERS[nextIdx]! }))
          return
        }
        if (key.tab) {
          setEmbeddingsFocus((f) => (f + 1) % 6)
          return
        }
        if (isEnter && embeddingsFocus < 5) {
          setEmbeddingsFocus((f) => (f + 1) % 6)
          return
        }
        if (isEnter && embeddingsFocus === 5 && saveConfig && embeddingsForm.model) {
          const parsedDims = Number(embeddingsForm.dimensions)
          saveConfig({
            embeddings: {
              provider: embeddingsForm.provider as any,
              model: embeddingsForm.model,
              apiKey: embeddingsForm.apiKey || undefined,
              baseUrl: embeddingsForm.baseUrl || undefined,
              dimensions: Number.isFinite(parsedDims) && parsedDims > 0 ? Math.floor(parsedDims) : undefined,
            },
          })
          setView("chat")
          return
        }
        if (embeddingsFocus > 0 && embeddingsFocus < 5 && (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f" || inputChar === "\u0008")) {
          const k = ["provider", "model", "apiKey", "baseUrl", "dimensions"][embeddingsFocus] as "provider" | "model" | "apiKey" | "baseUrl" | "dimensions"
          setEmbeddingsForm((f) => ({ ...f, [k]: (f[k] as string).slice(0, -1) }))
          return
        }
        if (embeddingsFocus > 0 && embeddingsFocus < 5 && inputChar && !key.ctrl && !key.meta) {
          const k = ["provider", "model", "apiKey", "baseUrl", "dimensions"][embeddingsFocus] as "provider" | "model" | "apiKey" | "baseUrl" | "dimensions"
          setEmbeddingsForm((f) => ({ ...f, [k]: (f[k] as string) + inputChar }))
          return
        }
        return
      }
      if (view === "settings") {
        if (inputChar === "1") {
          setView("model")
          return
        }
        if (inputChar === "2") {
          setView("embeddings")
          return
        }
        if (inputChar === "3") {
          setView("index")
          return
        }
        if (inputChar === "4") {
          setView("advanced")
          return
        }
        if (inputChar === "5") {
          setView("help")
          return
        }
        if (isEnter) {
          setView("model")
          return
        }
        return
      }
      if (view === "index") {
        if (isEnter && state.indexStatus?.state !== "indexing" && onReindex) {
          onReindex()
        } else if ((inputChar === "s" || inputChar === "S") && state.indexStatus?.state === "indexing" && onIndexStop) {
          onIndexStop()
        }
        return
      }
      if (view === "advanced") {
        if (key.tab) {
          setAdvancedFocus((f) => (f + 1) % 9)
          return
        }
        if (advancedFocus === 8 && isEnter && saveConfig) {
          let mcpServers: Array<Record<string, unknown>> = []
          let profiles: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(advancedForm.mcpServersJson || "[]")
            if (Array.isArray(parsed)) mcpServers = parsed.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>
          } catch {}
          try {
            const parsed = JSON.parse(advancedForm.profilesJson || "{}")
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) profiles = parsed as Record<string, unknown>
          } catch {}
          const skills = advancedForm.skillsText.split("\n").map((s) => s.trim()).filter(Boolean)
          const rules = advancedForm.rulesFilesText.split("\n").map((s) => s.trim()).filter(Boolean)
          const claudeMdPath = advancedForm.claudeMdPath.trim()
          saveConfig({
            mcp: { servers: mcpServers },
            skills,
            rules: { files: [...(claudeMdPath ? [claudeMdPath] : []), ...rules] },
            modes: {
              agent: { customInstructions: advancedForm.agentInstructions.trim() || undefined },
              plan: { customInstructions: advancedForm.planInstructions.trim() || undefined },
              ask: { customInstructions: advancedForm.askInstructions.trim() || undefined },
            },
            profiles,
          })
          setView("chat")
          return
        }
        const keys = [
          "mcpServersJson",
          "skillsText",
          "claudeMdPath",
          "rulesFilesText",
          "agentInstructions",
          "planInstructions",
          "askInstructions",
          "profilesJson",
        ] as const
        if (advancedFocus < 8 && (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f")) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k].slice(0, -1) }))
          return
        }
        if (advancedFocus < 8 && isEnter) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k] + "\n" }))
          return
        }
        if (advancedFocus < 8 && inputChar && !key.ctrl && !key.meta) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k] + inputChar }))
          return
        }
        return
      }
    }

    if (key.tab) {
      const idx = MODES.indexOf(state.mode)
      const next = MODES[(idx + 1) % MODES.length]!
      setState((s) => ({ ...s, mode: next }))
      onModeChange(next)
      return
    }

    // Slash popup: Up/Down to select, Enter to apply, Escape to close
    if (slashOpen) {
      if (key.upArrow) {
        setSlashSelected((i) => (i <= 0 ? filteredCommands.length - 1 : i - 1))
        return
      }
      if (key.downArrow) {
        setSlashSelected((i) => (i >= filteredCommands.length - 1 ? 0 : i + 1))
        return
      }
      if (isEnter && selectedCmd) {
        applySlashCommand(selectedCmd)
        return
      }
      if (key.escape) {
        setInput("")
        setSlashSelected(0)
        return
      }
    }

    if (key.upArrow && !slashOpen) {
      if (view === "chat" && input.length === 0) {
        setChatScrollLines((v) => v + 1)
        return
      }
      const hist = inputHistory.current
      if (hist.length > 0) {
        const next = Math.min(historyIdx + 1, hist.length - 1)
        setHistoryIdx(next)
        setInput(hist[hist.length - 1 - next]!)
      }
      return
    }

    if (key.downArrow && !slashOpen) {
      if (view === "chat" && input.length === 0) {
        setChatScrollLines((v) => Math.max(0, v - 1))
        return
      }
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

    if (isEnter && !slashOpen) {
      if (state.awaitingApproval && onResolveApproval) {
        const raw = input.trim().toLowerCase()
        if (["y", "yes", "n", "no", "a", "always", "s", "skip"].includes(raw)) {
          const approved = ["y", "yes", "a", "always", "s", "skip"].includes(raw)
          const alwaysApprove = raw === "a" || raw === "always"
          const skipAll = raw === "s" || raw === "skip"
          setInput("")
          setChatScrollLines(0)
          setState((s) => ({ ...s, awaitingApproval: false }))
          onResolveApproval({ approved, alwaysApprove, skipAll })
          return
        }
      }
      if (input.trim() && !state.isRunning) {
        const now = Date.now()
        if (now - lastSubmitRef.current < 400) return
        lastSubmitRef.current = now
        const content = input.trim()
        // Dedupe: avoid adding the same user message twice (e.g. double Enter or echo)
        const lastMsg = state.messages[state.messages.length - 1]
        if (lastMsg?.role === "user" && typeof lastMsg.content === "string" && lastMsg.content.trim() === content) {
          setInput("")
          return
        }
        inputHistory.current.push(content)
        if (inputHistory.current.length > 50) inputHistory.current.shift()
        setHistoryIdx(-1)
        setInput("")
        setState((s) => ({
          ...s,
          isRunning: true,
          lastError: null,
          liveTools: [],
          planCompleted: false,
          messages: [
            ...s.messages,
            {
              id: `u_${Date.now()}`,
              ts: Date.now(),
              role: "user",
              content,
            },
          ],
        }))
        setChatScrollLines(0)
        onMessage(content, state.mode)
      }
      return
    }

    if (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f" || inputChar === "\u0008") {
      setInput((s) => s.slice(0, -1))
      return
    }

    if (inputChar && !key.ctrl && !key.meta) {
      setInput((s) => s + inputChar)
    }
  })

  const modeColor = MODE_COLORS[state.mode]

  return (
    <Box flexDirection="column" height={rows}>
      {/* ── Logo ─────────────────────────────────────────────────────────────── */}
      <Logo cols={cols} />

      {/* ── Status bar (model, index, project, hint) ─────────────────────────── */}
      <WelcomeBar
        provider={state.provider}
        model={state.model}
        projectDir={projectDir}
        noIndex={noIndex}
        indexReady={state.indexReady}
        cols={cols}
        contextUsedTokens={state.contextUsedTokens}
        contextLimitTokens={state.contextLimitTokens}
        contextPercent={state.contextPercent}
      />

      {/* ── Chat area or Config view ───────────────────────────────────────── */}
      {view !== "chat" ? (
        <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1}>
          {view === "settings" && (
            <SettingsHubView />
          )}
          {view === "model" && (
            <ModelConfigView form={modelForm} focus={modelFocus} cols={cols} />
          )}
          {view === "embeddings" && (
            <EmbeddingsConfigView form={embeddingsForm} focus={embeddingsFocus} cols={cols} />
          )}
          {view === "advanced" && (
            <AdvancedConfigView form={advancedForm} focus={advancedFocus} />
          )}
          {view === "index" && (
            <IndexManageView
              indexStatus={state.indexStatus}
              onReindex={onReindex}
              onIndexStop={onIndexStop}
              noIndex={noIndex ?? false}
            />
          )}
          {view === "help" && (
            <HelpBox
              provider={state.provider}
              model={state.model}
              sessionId={sessionId}
              projectDir={projectDir}
              profileNames={profileNames}
              noIndex={noIndex}
              indexReady={state.indexReady}
              configSnapshot={configSnapshot}
              cols={cols}
            />
          )}
        </Box>
      ) : (
      <ChatViewport state={state} cols={cols} rows={rows} scrollLines={chatScrollLines} />
      )}


      {state.todo && <TodoBar todo={state.todo} cols={cols} />}

      {view === "chat" && state.mode === "plan" && state.planCompleted && !state.isRunning && (
        <PlanActionsBar cols={cols} />
      )}

      {/* ── Slash command popup (above input) ────────────────────────────────── */}
      {slashOpen && filteredCommands.length > 0 && (
        <SlashPopup
          commands={filteredCommands}
          selectedIndex={slashSelected}
          cols={cols}
        />
      )}

      {/* ── Input bar (hidden when editing /model, /embeddings, etc.) ───────── */}
      {view === "chat" ? (
        <InputBar
          input={input}
          cols={cols}
          mode={state.mode}
          modeColor={modeColor}
          isRunning={state.isRunning}
          awaitingApproval={state.awaitingApproval}
          indexReady={state.indexReady}
        />
      ) : (
        <Box paddingX={1} paddingY={0}>
          <Text color="cyan">{view === "settings" || view === "help" || view === "index" ? "Use shortcuts shown above." : "Edit the form above."}</Text>
          <Text color="gray">
            {view === "settings"
              ? "1:model 2:emb 3:index 4:adv 5:help Esc-back"
              : view === "help"
                ? "Esc — back"
                : view === "index"
                  ? "Enter — reindex, S — stop indexing, Esc — back"
                  : "Tab — next field, Enter — newline/save, Esc — back"}
          </Text>
        </Box>
      )}

      {/* ── Footer / Help ───────────────────────────────────────────────────── */}
      <Footer
        isRunning={state.isRunning}
        provider={state.provider}
        model={state.model}
        sessionId={sessionId}
        activeProfile={profileOptions[activeProfileIdx] ?? "default"}
        cols={cols}
        contextUsedTokens={state.contextUsedTokens}
        contextLimitTokens={state.contextLimitTokens}
      />
    </Box>
  )
}

// ─── Config views (Model, Embeddings, Settings, Index) ────────────────────────

function SettingsHubView() {
  const items = [
    "1) Model & LLM",
    "2) Embeddings",
    "3) Index & Vector DB",
    "4) Advanced (MCP, skills, rules, mode prompts, profiles)",
    "5) Help",
  ]
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Settings Hub</Text>
      <Text color="gray"> Open section by number. Enter opens Model. Esc — back.</Text>
      {items.map((item) => (
        <Box key={item}>
          <Text color="white"> {item}</Text>
        </Box>
      ))}
    </Box>
  )
}

function ModelConfigView({
  form,
  focus,
  cols,
}: {
  form: { provider: string; id: string; apiKey: string; baseUrl: string; temperature: string }
  focus: number
  cols: number
}) {
  const labels = ["Provider", "Model ID", "API Key", "Base URL", "Temperature (0-2)"]
  const keys = ["provider", "id", "apiKey", "baseUrl", "temperature"] as const
  const valueWidth = Math.max(18, cols - 34)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Model — LLM provider & model</Text>
      <Text color="gray"> Tab — next field, Enter — save, Esc — back. Provider via ↑↓.</Text>
      {labels.map((label, i) => (
        <Box key={label}>
          <Text color={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </Text>
          <Text color="white">
            {fit(
              keys[i] === "apiKey"
                ? maskSecret((form[keys[i]] as string) || "")
                : ((form[keys[i]] as string) || ""),
              valueWidth
            )}
          </Text>
          {focus === i && <Text color="cyan">│</Text>}
        </Box>
      ))}
      {focus === 0 && (
        <Box paddingLeft={2}>
          <Text color="gray"> Provider: {form.provider} (↑↓ to change)</Text>
        </Box>
      )}
      <Box>
        <Text color={focus === 5 ? "cyan" : "gray"}>{focus === 5 ? "▸ " : "  "}</Text>
        <Text color={focus === 5 ? "green" : "gray"}>[Save] — press Enter</Text>
      </Box>
    </Box>
  )
}

function EmbeddingsConfigView({
  form,
  focus,
  cols,
}: {
  form: { provider: string; model: string; apiKey: string; baseUrl: string; dimensions: string }
  focus: number
  cols: number
}) {
  const labels = ["Provider (openai|openai-compatible|ollama|local)", "Model name", "API Key", "Base URL", "Dimensions"]
  const keys = ["provider", "model", "apiKey", "baseUrl", "dimensions"] as const
  const valueWidth = Math.max(18, cols - 40)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Embeddings — model for vector search</Text>
      <Text color="gray"> Tab — next field, Enter — save, Esc — back. Provider via ↑↓.</Text>
      {labels.map((label, i) => (
        <Box key={label}>
          <Text color={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </Text>
          <Text color="white">
            {fit(
              keys[i] === "apiKey"
                ? maskSecret((form[keys[i]] as string) || "")
                : ((form[keys[i]] as string) || ""),
              valueWidth
            )}
          </Text>
          {focus === i && <Text color="cyan">│</Text>}
        </Box>
      ))}
      {focus === 0 && (
        <Box paddingLeft={2}>
          <Text color="gray"> Provider: {form.provider} (↑↓ to change)</Text>
        </Box>
      )}
      <Box>
        <Text color={focus === 5 ? "cyan" : "gray"}>{focus === 5 ? "▸ " : "  "}</Text>
        <Text color={focus === 5 ? "green" : "gray"}>[Save] — press Enter</Text>
      </Box>
    </Box>
  )
}

function AdvancedConfigView({
  form,
  focus,
}: {
  form: {
    mcpServersJson: string
    skillsText: string
    claudeMdPath: string
    rulesFilesText: string
    agentInstructions: string
    planInstructions: string
    askInstructions: string
    profilesJson: string
  }
  focus: number
}) {
  const labels = [
    "MCP servers JSON",
    "Skills (one per line)",
    "CLAUDE.md path",
    "Rules files (one per line)",
    "Agent instructions",
    "Plan instructions",
    "Ask instructions",
    "Profiles JSON",
  ]
  const keys = [
    "mcpServersJson",
    "skillsText",
    "claudeMdPath",
    "rulesFilesText",
    "agentInstructions",
    "planInstructions",
    "askInstructions",
    "profilesJson",
  ] as const
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Advanced — MCP, skills, rules, mode prompts, profiles</Text>
      <Text color="gray"> Tab — next field, Enter in field adds newline, Enter on [Save] persists.</Text>
      {labels.map((label, i) => (
        <Box key={label} flexDirection="column">
          <Box>
            <Text color={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color="white">{(form[keys[i]] as string).slice(0, 1600)}</Text>
            {focus === i && <Text color="cyan">│</Text>}
          </Box>
        </Box>
      ))}
      <Box>
        <Text color={focus === 8 ? "cyan" : "gray"}>{focus === 8 ? "▸ " : "  "}</Text>
        <Text color={focus === 8 ? "green" : "gray"}>[Save] — press Enter</Text>
      </Box>
    </Box>
  )
}

function IndexManageView({
  indexStatus,
  onReindex,
  onIndexStop,
  noIndex,
}: {
  indexStatus: import("@nexuscode/core").IndexStatus | null
  onReindex?: () => void
  onIndexStop?: () => void
  noIndex: boolean
}) {
  if (noIndex) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold> Index — disabled</Text>
        <Text color="gray"> Indexing is off (--no-index or indexing.enabled: false).</Text>
      </Box>
    )
  }
  const st = indexStatus ?? { state: "idle" as const }
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Index — status & control</Text>
      <Text color="gray"> Enter — reindex, Esc — back</Text>
      {st.state === "idle" && (
        <Box><Text color="gray"> Status: </Text><Text color="gray">idle</Text></Box>
      )}
      {st.state === "indexing" && (
        <Box flexDirection="column">
          <Text color="yellow"> Status: indexing</Text>
          <Text color="white"> Progress: {st.progress} / {st.total} files</Text>
          {typeof st.chunksProcessed === "number" && typeof st.chunksTotal === "number" && (
            <Text color="gray"> Chunks: {st.chunksProcessed} / {st.chunksTotal}</Text>
          )}
          <Text color="gray"> S — stop indexing</Text>
        </Box>
      )}
      {st.state === "ready" && (
        <Box flexDirection="column">
          <Text color="green"> Status: ready</Text>
          <Text color="gray"> Files: {st.files}, symbols: {st.symbols}{typeof st.chunks === "number" ? `, chunks: ${st.chunks}` : ""}</Text>
        </Box>
      )}
      {st.state === "error" && (
        <Box><Text color="red"> Error: {st.error}</Text></Box>
      )}
      <Box marginTop={1}>
        <Text color="cyan"> [Reindex] — Enter</Text>
      </Box>
    </Box>
  )
}

// ─── Welcome / Status bar (under logo) ────────────────────────────────────────

function WelcomeBar({
  provider,
  model,
  projectDir,
  noIndex,
  indexReady,
  cols,
  contextUsedTokens,
  contextLimitTokens,
  contextPercent,
}: {
  provider: string
  model: string
  projectDir?: string
  noIndex: boolean
  indexReady: boolean
  cols: number
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
}) {
  const indexLabel = noIndex ? "Index: off" : indexReady ? "Index: ● ready" : "Index: … building"
  const shortPath = projectDir ? fit(projectDir, Math.max(20, Math.floor(cols * 0.45))) : ""
  const modelLabel = fit(`${provider}/${model}`, Math.max(20, Math.floor(cols * 0.65)))
  const line1 = fit(`Model ${modelLabel}`, Math.max(20, cols - 4))
  const line2 = fitPad(shortPath ? `${indexLabel} · Project: ${shortPath}` : indexLabel, Math.max(20, cols - 4))
  const line3 = fitPad("Type / for commands  /settings for all agent settings", Math.max(20, cols - 4))
  const line4 = fitPad(
    `Context: ${formatTokens(contextUsedTokens)} / ${formatTokens(contextLimitTokens)} (${contextPercent}%) · sys on`,
    Math.max(20, cols - 4),
  )
  const indexColor = noIndex ? "gray" : indexReady ? "green" : "yellow"
  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={1} borderStyle="single" borderColor="gray">
      <Text color="white">{fitPad(line1, Math.max(20, cols - 4))}</Text>
      <Text color={indexColor as "green" | "yellow" | "gray"}>{line2}</Text>
      <Text color="gray">{line3}</Text>
      <Text color={contextPercent >= 90 ? "red" : contextPercent >= 75 ? "yellow" : "green"}>{line4}</Text>
    </Box>
  )
}

// ─── Slash command popup (over chat: one line per command to avoid overlap) ─

function SlashPopup({
  commands,
  selectedIndex,
  cols,
}: {
  commands: typeof SLASH_COMMANDS
  selectedIndex: number
  cols: number
}) {
  const maxLen = Math.max(40, cols - 4)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text color="gray">Commands — ↑↓ choose, Enter select, Esc close</Text>
      {commands.map((cmd, i) => {
        const line = `${i === selectedIndex ? "▸ " : "  "}${cmd.label} — ${cmd.desc}`
        const show = line.length > maxLen ? line.slice(0, maxLen - 1) + "…" : line
        return (
          <Box key={cmd.cmd}>
            <Text color={i === selectedIndex ? "cyan" : "gray"} bold={i === selectedIndex}>
              {show}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// ─── Input bar ──────────────────────────────────────────────────────────────

function InputBar({
  input,
  cols,
  mode,
  modeColor,
  isRunning,
  awaitingApproval,
  indexReady,
}: {
  input: string
  cols: number
  mode: Mode
  modeColor: string
  isRunning: boolean
  awaitingApproval: boolean
  indexReady: boolean
}) {
  const borderColor = awaitingApproval ? "yellow" : isRunning ? "red" : "cyan"
  const prompt = awaitingApproval
    ? "Allow? [y] Yes [n] No [a] Always [s] Skip — type below"
    : isRunning
      ? "[ABORT: Ctrl+C]"
      : `[${mode}]`
  const promptColor = awaitingApproval ? "yellow" : isRunning ? "red" : (modeColor as "cyan" | "blue" | "yellow" | "green")
  const maxInputLen = Math.max(8, cols - 32)
  const displayInput = input.length > maxInputLen ? `…${input.slice(-Math.max(1, maxInputLen - 1))}` : input

  return (
    <Box borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={promptColor} bold>
        {prompt}
      </Text>
      {indexReady && (
        <Text color="green" dimColor>
          {" "}
          ●
        </Text>
      )}
      <Text color="gray">
        {" "}
        ›{" "}
      </Text>
      <Text color="white">{displayInput}</Text>
      <Text color={isRunning ? "gray" : "cyan"}>█</Text>
    </Box>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function MessageItem({ msg, cols }: { msg: SessionMessage; cols: number }) {
  const content = typeof msg.content === "string" ? msg.content : "[complex message]"

  if (msg.role === "user") {
    return (
      <Box paddingX={1} paddingTop={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">
            ▶ You
          </Text>
          <Text color="gray"> ─────────────────────────────────</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text wrap="wrap" color="white">
            {content}
          </Text>
        </Box>
      </Box>
    )
  }

  if (msg.role === "assistant") {
    const trimmed =
      content.length > 3000
        ? content.slice(0, 1500) + "\n\n[...]\n\n" + content.slice(-800)
        : content
    return (
      <Box paddingX={1} paddingTop={1} flexDirection="column">
        <Box>
          <Text bold color="green">
            ◀ NexusCode
          </Text>
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
        <Text color="gray" bold>
          📝 Context summary
        </Text>
        <Text color="gray"> (compacted)</Text>
      </Box>
    )
  }

  if (msg.role === "system") {
    return (
      <Box paddingX={1}>
        <Text color="red" dimColor>
          ⚠ {content}
        </Text>
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
      <Text color="magenta" dimColor>
        💭 Thinking...
      </Text>
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
      <Text wrap="wrap" color="white">
        {display}
      </Text>
    </Box>
  )
}

function LiveToolCard({ tool }: { tool: LiveTool }) {
  const icon = TOOL_ICONS[tool.tool] ?? "🔧"
  const elapsed = tool.timeStart ? `${((Date.now() - tool.timeStart) / 1000).toFixed(1)}s` : ""
  let preview = ""
  if (tool.input) {
    const path = tool.input["path"] ?? tool.input["command"] ?? tool.input["query"] ?? tool.input["url"]
    if (path) preview = String(path).slice(0, 50)
  }

  return (
    <Box paddingX={1} paddingLeft={2}>
      <Text color="yellow">
        <Spinner type="arc" />
      </Text>
      <Text color="yellow">
        {" "}
        {icon} {tool.tool}
      </Text>
      {preview && (
        <Text color="gray"> {preview}</Text>
      )}
      {elapsed && (
        <Text color="gray" dimColor>
          {" "}
          ({elapsed})
        </Text>
      )}
    </Box>
  )
}

function SubAgentCard({ agent }: { agent: SubAgentState }) {
  const statusColor =
    agent.status === "completed"
      ? "green"
      : agent.status === "error"
        ? "red"
        : "cyan"
  const elapsed = ((Date.now() - agent.startedAt) / 1000).toFixed(1)
  const title = `${agent.id.slice(0, 12)} · ${agent.mode}`
  const task = agent.task.length > 100 ? `${agent.task.slice(0, 100)}…` : agent.task

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={statusColor} paddingX={1} marginBottom={1}>
      <Box>
        <Text color={statusColor} bold>Sub-agent </Text>
        <Text color="white">{title}</Text>
        <Text color="gray"> · {elapsed}s</Text>
      </Box>
      <Box>
        <Text color="gray">Task: </Text>
        <Text color="white">{task}</Text>
      </Box>
      {agent.currentTool && (
        <Box>
          <Text color="gray">Tool: </Text>
          <Text color="yellow">{agent.currentTool}</Text>
        </Box>
      )}
      {agent.error && (
        <Box>
          <Text color="red">Error: {agent.error.slice(0, 120)}</Text>
        </Box>
      )}
    </Box>
  )
}

function TodoBar({ todo, cols }: { todo: string; cols: number }) {
  const items = parseTodoItems(todo)
  const total = items.length
  const completed = items.filter((i) => i.done).length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  const summary =
    items.length > 0
      ? items
          .slice(0, 3)
          .map((i) => (i.done ? "●" : "○") + " " + i.text.slice(0, 20))
          .join("  ·  ")
      : todo.slice(0, cols - 24).trim()

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray" flexDirection="row">
      <Text color="gray">Plan </Text>
      <Text color="cyan">
        [{completed}/{total}]
      </Text>
      <Text color="gray"> {pct}% </Text>
      <Text color="gray" dimColor>
        {summary.length > cols - 24 ? summary.slice(0, cols - 27) + "…" : summary}
      </Text>
    </Box>
  )
}

function PlanActionsBar({ cols }: { cols: number }) {
  return (
    <Box paddingX={1} paddingY={0} borderStyle="single" borderColor="yellow" flexDirection="column">
      <Text color="yellow" bold>
        Plan ready. Choose:
      </Text>
      <Box>
        <Text color="cyan"> [A]</Text>
        <Text color="gray"> Approve — run in agent mode and execute the plan</Text>
      </Box>
      <Box>
        <Text color="cyan"> [R]</Text>
        <Text color="gray"> Revise — type your message and press Enter to update the plan</Text>
      </Box>
      <Box>
        <Text color="cyan"> [D]</Text>
        <Text color="gray"> Abandon — switch to Ask mode</Text>
      </Box>
    </Box>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <Box paddingX={1} paddingY={0} borderStyle="single" borderColor="red">
      <Text color="red" bold>
        ✗ Error:{" "}
      </Text>
      <Text color="red" wrap="wrap">
        {message.slice(0, 200)}
      </Text>
    </Box>
  )
}

function Footer({
  isRunning,
  provider,
  model,
  sessionId,
  activeProfile,
  cols,
  contextUsedTokens,
  contextLimitTokens,
}: {
  isRunning: boolean
  provider: string
  model: string
  sessionId?: string
  activeProfile: string
  cols: number
  contextUsedTokens: number
  contextLimitTokens: number
}) {
  const shortModel = fit(model, 18)
  const shortSession = sessionId ? (sessionId.slice(0, 8) + "…") : ""
  const line1 = fitPad(
    `profile: ${activeProfile} · ${provider}/${shortModel}${shortSession ? ` · session: ${shortSession}` : ""} · ctx: ${formatTokens(contextUsedTokens)}/${formatTokens(contextLimitTokens)}`,
    Math.max(20, cols - 2)
  )
  const line2 = fitPad(
    `/  /model  /embeddings  /advanced  /index  Tab  Ctrl+M  Ctrl+P(profile)  Ctrl+S  Ctrl+G/End(latest)  Ctrl+U/D  PgUp/PgDn  Ctrl+K  Ctrl+C:${isRunning ? "abort" : "quit"}  ↑↓`,
    Math.max(20, cols - 2)
  )
  return (
    <Box paddingX={1} flexDirection="column">
      <Box>
        <Text color="gray">{line1}</Text>
      </Box>
      <Box>
        <Text color="gray">{line2}</Text>
      </Box>
    </Box>
  )
}

type ChatLine = { text: string; color?: "white" | "gray" | "cyan" | "green" | "yellow" | "red" | "magenta" | "blue"; bold?: boolean }

function ChatViewport({
  state,
  cols,
  rows,
  scrollLines,
}: {
  state: AppState
  cols: number
  rows: number
  scrollLines: number
}) {
  const width = Math.max(20, cols - 4)
  const allLines = buildChatLines(state, width)
  const visibleHeight = Math.max(12, rows - 14)
  const maxScroll = Math.max(0, allLines.length - visibleHeight)
  const safeScroll = Math.max(0, Math.min(scrollLines, maxScroll))
  const start = Math.max(0, allLines.length - visibleHeight - safeScroll)
  const lines = allLines.slice(start, start + visibleHeight)

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={visibleHeight} overflowY="hidden" paddingX={1}>
      {safeScroll > 0 && (
        <Text color="gray">↑ Scroll up (PgUp / Ctrl+D) — {safeScroll} lines above · Ctrl+G or End = latest</Text>
      )}
      {safeScroll > 0 && state.isRunning && (
        <Text color="cyan">↓ New content — Ctrl+G or End to jump to latest</Text>
      )}
      {lines.map((line, idx) => (
        <Text key={`${idx}_${line.text.slice(0, 20)}`} color={line.color ?? "white"} bold={line.bold}>
          {line.text}
        </Text>
      ))}
      {lines.length === 0 && <Text color="gray">No messages yet.</Text>}
    </Box>
  )
}

function formatToolPreview(tool: LiveTool): string {
  const pathVal = tool.input?.["path"]
  const pathStr = pathVal != null ? String(pathVal) : ""
  const startLine = tool.input?.["start_line"]
  const endLine = tool.input?.["end_line"]
  const pattern = tool.input?.["pattern"]
  const patterns = tool.input?.["patterns"]
  const pathsArr = tool.input?.["paths"]
  const command = tool.input?.["command"]
  const query = tool.input?.["query"]
  const url = tool.input?.["url"]
  const parts: string[] = []

  if (tool.tool === "list_files") {
    const dir = pathStr || "."
    const short = dir.length > 36 ? dir.slice(0, 33) + "…" : dir
    parts.push(`folder ${short}`)
  } else if (tool.tool === "batch") {
    const reads = (tool.input?.["reads"] as unknown[])?.length ?? 0
    const searches = (tool.input?.["searches"] as unknown[])?.length ?? 0
    const replaces = (tool.input?.["replaces"] as unknown[])?.length ?? 0
    if (reads) parts.push(`${reads} read(s)`)
    if (searches) parts.push(`${searches} search(es)`)
    if (replaces) parts.push(`${replaces} replace(s)`)
  } else if (tool.tool === "spawn_agent") {
    const desc = tool.input?.["description"]
    if (desc && typeof desc === "string") parts.push((desc.length > 40 ? desc.slice(0, 37) + "…" : desc).replace(/\s+/g, " "))
  } else if (pathStr) {
    const base = pathStr.split("/").pop() ?? pathStr
    const short = base.length > 36 ? base.slice(0, 33) + "…" : base
    parts.push(short)
    if (typeof startLine === "number" && typeof endLine === "number") parts.push(`L${startLine}-${endLine}`)
    else if (typeof startLine === "number") parts.push(`L${startLine}`)
  }

  if (Array.isArray(pathsArr) && pathsArr.length > 0) parts.push(pathsArr.slice(0, 2).join(", "))
  if (pattern && typeof pattern === "string") parts.push((pattern.length > 24 ? pattern.slice(0, 21) + "…" : pattern).replace(/\s+/g, " "))
  if (Array.isArray(patterns) && patterns.length > 0) parts.push(`pat:${patterns.length}`)
  if (command && typeof command === "string") parts.push((command.length > 32 ? command.slice(0, 29) + "…" : command).replace(/\s+/g, " "))
  if (query && typeof query === "string") parts.push((query.length > 28 ? query.slice(0, 25) + "…" : query).replace(/\s+/g, " "))
  if (url && typeof url === "string") parts.push((url.length > 36 ? url.slice(0, 33) + "…" : url))
  return parts.length > 0 ? parts.join(" · ") : ""
}

function parseTodoItems(todo: string): { done: boolean; text: string }[] {
  const items: { done: boolean; text: string }[] = []
  for (const raw of todo.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const checkboxDone = /^[-*]\s*\[[xX]\]\s*(.*)$/.exec(line) || /^[-*]\s*✅\s*(.*)$/.exec(line)
    const checkboxPending = /^[-*]\s*\[\s?\]\s*(.*)$/.exec(line)
    const plainBullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (checkboxDone) {
      items.push({ done: true, text: checkboxDone[1]!.trim() })
    } else if (checkboxPending) {
      items.push({ done: false, text: checkboxPending[1]!.trim() })
    } else if (plainBullet) {
      items.push({ done: false, text: plainBullet[1]!.trim() })
    } else if (numbered) {
      items.push({ done: false, text: numbered[1]!.trim() })
    } else {
      items.push({ done: false, text: line })
    }
  }
  return items
}

type MessageSegment = { type: "text" | "code"; content: string }

function splitMessageBlocks(content: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  const re = /```(\w*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIndex) {
      const text = content.slice(lastIndex, m.index).trimEnd()
      if (text) segments.push({ type: "text", content: text })
    }
    const lang = m[1] ? m[1].trim() : ""
    const code = m[2]?.replace(/\n$/, "") ?? ""
    segments.push({ type: "code", content: lang ? `(${lang})\n${code}` : code })
    lastIndex = re.lastIndex
  }
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trimEnd()
    if (text) segments.push({ type: "text", content: text })
  }
  return segments.length > 0 ? segments : [{ type: "text", content }]
}

function buildChatLines(state: AppState, width: number): ChatLine[] {
  const out: ChatLine[] = []

  // ─── Chat messages first (chronological) ───────────────────────────────────
  let prevUserContent: string | undefined
  for (const msg of state.messages) {
    const raw = sanitizeText(typeof msg.content === "string" ? msg.content : "[complex message]")
    const content = msg.role === "assistant" ? cleanAssistantText(raw) : raw
    if (msg.role === "user") {
      if (prevUserContent === content) continue
      prevUserContent = content
      out.push({ text: "You", color: "cyan", bold: true })
      for (const line of wrapToWidth(content, Math.max(10, width - 2))) out.push({ text: `  ${line}`, color: "white" })
      out.push({ text: "", color: "gray" })
      continue
    }
    prevUserContent = undefined
    if (msg.role === "assistant") {
      out.push({ text: "NexusCode", color: "green", bold: true })
      const segments = splitMessageBlocks(content)
      const wrapW = Math.max(10, width - 2)
      for (const seg of segments) {
        if (seg.type === "text") {
          for (const line of wrapToWidth(seg.content, wrapW)) out.push({ text: `  ${line}`, color: "white" })
        } else {
          const codeLines = seg.content.split("\n")
          const borderW = Math.max(12, Math.min(width - 4, 58))
          out.push({ text: "  ┌" + "─".repeat(Math.max(0, borderW - 2)) + "┐", color: "gray" })
          for (const codeLine of codeLines) {
            for (const l of wrapToWidth(codeLine, borderW - 4)) out.push({ text: `  │ ${l}`, color: "gray" })
          }
          out.push({ text: "  └" + "─".repeat(Math.max(0, borderW - 2)) + "┘", color: "gray" })
        }
      }
      out.push({ text: "", color: "gray" })
      continue
    }
    if (msg.role === "system") {
      for (const line of wrapToWidth(`WARN ${content}`, width)) out.push({ text: line, color: "red" })
      out.push({ text: "", color: "gray" })
      continue
    }
  }

  // ─── Tools (chronological: right after messages, with file/line detail) ──────
  const recentTools = state.liveTools.slice(-80)
  if (recentTools.length > 0) {
    out.push({ text: "Tools", color: "yellow", bold: true })
    const groups: { tool: string; status: string; count: number; preview?: string }[] = []
    for (const tool of recentTools) {
      const status =
        tool.status === "running" ? "…" : tool.status === "completed" ? "ok" : "err"
      const preview = formatToolPreview(tool)
      const last = groups[groups.length - 1]
      if (last && last.tool === tool.tool && last.status === status) {
        last.count += 1
        if (preview && !last.preview) last.preview = preview
      } else {
        groups.push({ tool: tool.tool, status, count: 1, preview: preview || undefined })
      }
    }
    for (const g of groups) {
      const label = g.count > 1 ? `${g.count}× ${sanitizeText(g.tool)}` : sanitizeText(g.tool)
      const showPreview = state.showToolDetails && g.preview
      const line = showPreview ? `  [${g.status}] ${label} — ${g.preview}` : `  [${g.status}] ${label}`
      for (const l of wrapToWidth(line, width)) {
        out.push({
          text: l,
          color: g.status === "err" ? "red" : g.status === "ok" ? "gray" : "yellow",
        })
      }
    }
    out.push({ text: "", color: "gray" })
  }

  for (const sa of state.subAgents) {
    const id = sanitizeText(sa?.id ?? "unknown")
    const mode = sanitizeText(String(sa?.mode ?? "agent"))
    const status = sa?.status === "running" ? "RUN" : sa?.status === "completed" ? "OK" : "ERR"
    const rawTask = sanitizeText(sa?.task ?? "")
    const task = rawTask.length > 120 ? `${rawTask.slice(0, 120)}...` : rawTask
    for (const l of wrapToWidth(`[subagent ${id.slice(0, 8)} ${mode} ${status}] ${task}`, width)) out.push({ text: l, color: "cyan" })
    if (sa?.currentTool) out.push({ text: `  tool: ${sanitizeText(sa.currentTool)}`, color: "gray" })
    if (sa?.error) out.push({ text: `  error: ${sanitizeText(sa.error)}`, color: "red" })
  }
  if (state.subAgents.length > 0) out.push({ text: "", color: "gray" })

  // ─── Todo / plan items (at bottom, above input) ─────────────────────────────
  if (state.todo.trim()) {
    out.push({ text: "Plan", color: "yellow", bold: true })
    const runningTool = state.liveTools.find((t) => t.status === "running")
    if (state.isRunning && runningTool) {
      const preview = formatToolPreview(runningTool)
      const line = preview
        ? `  ▶ Working on: ${sanitizeText(runningTool.tool)} — ${preview}`
        : `  ▶ Working on: ${sanitizeText(runningTool.tool)}`
      for (const l of wrapToWidth(line, Math.max(10, width - 2))) out.push({ text: l, color: "cyan" })
    }
    const items = parseTodoItems(state.todo)
    for (const item of items) {
      const bullet = item.done ? "  ● " : "  ○ "
      const text = sanitizeText(item.text)
      const wrapped = wrapToWidth(text, Math.max(10, width - 4))
      wrapped.forEach((line, i) => {
        out.push({
          text: (i === 0 ? bullet : "    ") + line,
          color: item.done ? "gray" : "white",
        })
      })
    }
    if (items.length === 0) {
      for (const line of wrapToWidth(sanitizeText(state.todo), Math.max(10, width - 2)))
        out.push({ text: `  ${line}`, color: "white" })
    }
    out.push({ text: "", color: "gray" })
  }

  if (state.isRunning && state.reasoning && state.showThinking) {
    out.push({ text: "Thinking...", color: "magenta" })
    const preview = sanitizeText(state.reasoning).slice(-800)
    for (const line of wrapToWidth(preview, Math.max(10, width - 2))) out.push({ text: `  ${line}`, color: "magenta" })
    out.push({ text: "", color: "gray" })
  }
  if (state.isRunning && state.currentStreaming) {
    const streamed = cleanAssistantText(sanitizeText(state.currentStreaming))
    if (streamed.trim().length > 0) {
      out.push({ text: "NexusCode (streaming)", color: "green", bold: true })
      for (const line of wrapToWidth(streamed, Math.max(10, width - 2))) out.push({ text: `  ${line}`, color: "white" })
      out.push({ text: "", color: "gray" })
    }
  }

  if (state.compacting) out.push({ text: "Compacting context...", color: "blue" })
  if (state.lastError) for (const l of wrapToWidth(`Error: ${sanitizeText(state.lastError)}`, width)) out.push({ text: l, color: "red" })

  return out
}

function wrapToWidth(text: string, width: number): string[] {
  const safe = sanitizeText(text)
  if (width <= 1) return [safe]
  const lines: string[] = []
  for (const raw of safe.split("\n")) {
    const line = raw || ""
    if (line.length <= width) {
      lines.push(line)
      continue
    }
    let rest = line
    while (rest.length > width) {
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    lines.push(rest)
  }
  return lines
}

function fit(value: string, max: number): string {
  if (max <= 0) return ""
  if (value.length <= max) return value
  if (max <= 1) return "…"
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function fitPad(value: string, max: number): string {
  const clipped = fit(value, max)
  if (max <= 0) return clipped
  return clipped.padEnd(max, " ")
}

function maskSecret(value: string): string {
  if (!value) return ""
  if (value.length <= 4) return "*".repeat(value.length)
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`
}

function formatTokens(value: number): string {
  const n = Math.max(0, Math.floor(value))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function sanitizeText(value: string): string {
  if (!value) return ""
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
}

function stripToolCallMarkup(value: string): string {
  if (!value) return value
  return value
    .replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[^>]+>/gi, "")
    .replace(/<\/function>/gi, "")
    .replace(/<parameter=[^>]+>/gi, "")
    .replace(/<\/parameter>/gi, "")
    .trim()
}

function cleanAssistantText(value: string): string {
  const noBlocks = stripToolCallMarkup(value)
  return noBlocks
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (t === "<" || t === ">" || t === "</" || t === "/>") return false
      if (t.startsWith("<tool_call") || t.startsWith("</tool_call")) return false
      if (t.startsWith("<function=") || t.startsWith("</function")) return false
      if (t.startsWith("<parameter=") || t.startsWith("</parameter")) return false
      if (t.startsWith("<") && /(tool_call|function|parameter)/i.test(t)) return false
      return true
    })
    .join("\n")
    .trim()
}

function HelpBox({
  provider,
  model,
  sessionId,
  projectDir,
  profileNames,
  noIndex,
  indexReady,
  configSnapshot,
  cols,
}: {
  provider: string
  model: string
  sessionId?: string
  projectDir?: string
  profileNames: string[]
  noIndex: boolean
  indexReady: boolean
  cols: number
  configSnapshot?: {
    model: { provider: string; id: string; temperature?: number }
    embeddings?: { provider: string; model: string; dimensions?: number }
    indexing: { enabled: boolean; vector: boolean }
    vectorDb?: { enabled: boolean; url: string }
  }
}) {
  const snap = configSnapshot
  const indexStatus = noIndex ? "off" : indexReady ? "ready" : "building"
  const modelLine = fit(`${snap?.model?.provider ?? provider}/${snap?.model?.id ?? model}`, Math.max(24, cols - 20))
  const projectLine = fit(projectDir ?? "", Math.max(20, cols - 16))
  const sessionLine = fit(sessionId ?? "", Math.max(20, cols - 16))
  const profilesLine = fit((profileNames.length > 0 ? profileNames.join(", ") : "none"), Math.max(20, cols - 16))
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Help</Text>
      <Text color="gray" dimColor> Esc — close</Text>
      <Box flexDirection="column" paddingLeft={1}>
        <Box>
          <Text color="gray">Model: </Text>
          <Text color="white">{modelLine}</Text>
          {typeof snap?.model?.temperature === "number" && (
            <Text color="gray"> · temp {snap.model.temperature}</Text>
          )}
        </Box>
        <Box>
          <Text color="gray">Embeddings: </Text>
          {snap?.embeddings ? (
            <Text color="white"> {snap.embeddings.provider} / {snap.embeddings.model}</Text>
          ) : (
            <Text color="gray" dimColor> not set (vector search off)</Text>
          )}
          {snap?.embeddings?.dimensions && (
            <Text color="gray"> · dim {snap.embeddings.dimensions}</Text>
          )}
        </Box>
        <Box>
          <Text color="gray">Index: </Text>
          <Text color={indexStatus === "ready" ? "green" : indexStatus === "off" ? "gray" : "yellow"}>{indexStatus}</Text>
          {snap?.indexing?.vector && <Text color="gray"> · vector on</Text>}
        </Box>
        {snap?.vectorDb?.enabled && (
          <Box>
            <Text color="gray">Vector DB: </Text>
            <Text color="white">{snap.vectorDb.url}</Text>
          </Box>
        )}
        {sessionId && <Box><Text color="gray">Session: </Text><Text color="white">{sessionLine}</Text></Box>}
        {projectDir && <Box><Text color="gray">Project: </Text><Text color="white">{projectLine}</Text></Box>}
        <Box><Text color="gray">Profiles: </Text><Text color="white">{profilesLine}</Text></Box>
      </Box>

      <Text color="white" bold>{"\n"} Commands</Text>
      <Text color="gray"> /settings  /model  /embeddings  /index  /advanced  /help</Text>
      <Text color="white" bold>{"\n"} Shortcuts</Text>
      <Text color="gray"> Tab mode · Ctrl+P profile · Ctrl+S compact · Ctrl+K clear · Ctrl+C abort/quit</Text>
      <Text color="white" bold>{"\n"} Config files</Text>
      <Text color="gray"> .nexus/nexus.yaml (project) · ~/.nexus/nexus.yaml (global)</Text>
      <Text color="gray"> OpenRouter: provider `openai-compatible` + baseUrl `https://openrouter.ai/api/v1`</Text>
    </Box>
  )
}
