import React, { useState, useEffect, useRef, useMemo } from "react"
import { Box, Text, useInput, useApp, Static } from "ink"
import Spinner from "ink-spinner"
import type { AgentEvent, Mode, SessionMessage, IndexStatus } from "@nexuscode/core"

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
  maxMode: boolean
  isRunning: boolean
  model: string
  provider: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatus | null
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
  sessionId?: string
  projectDir?: string
  profileNames?: string[]
  onProfileSelect?: (profileName?: string) => void
  noIndex?: boolean
  configSnapshot?: {
    model: { provider: string; id: string; temperature?: number }
    maxMode: { enabled: boolean; tokenBudgetMultiplier: number }
    embeddings?: { provider: string; model: string; dimensions?: number }
    indexing: { enabled: boolean; vector: boolean }
    vectorDb?: { enabled: boolean; url: string }
    mcp?: { servers: Array<Record<string, unknown>> }
    skills?: string[]
    rules?: { files: string[] }
    modes?: {
      agent?: { customInstructions?: string }
      plan?: { customInstructions?: string }
      debug?: { customInstructions?: string }
      ask?: { customInstructions?: string }
    }
    profiles?: Record<string, Record<string, unknown>>
  }
  saveConfig?: (updates: Record<string, unknown>) => void
  onReindex?: () => void
  onIndexStop?: () => void
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

const MODES: Mode[] = ["agent", "plan", "debug", "ask"]

/** Slash commands */
type SlashAction = "clear" | "compact" | "max" | "help" | "settings" | "model" | "embeddings" | "index" | "advanced"
const SLASH_COMMANDS: Array<{ cmd: string; label: string; desc: string; mode?: Mode; action?: SlashAction }> = [
  { cmd: "agent", label: "/agent", desc: "Agent mode (code & tools)", mode: "agent" },
  { cmd: "plan", label: "/plan", desc: "Plan mode", mode: "plan" },
  { cmd: "debug", label: "/debug", desc: "Debug mode", mode: "debug" },
  { cmd: "ask", label: "/ask", desc: "Ask mode (Q&A)", mode: "ask" },
  { cmd: "clear", label: "/clear", desc: "Clear chat", action: "clear" },
  { cmd: "compact", label: "/compact", desc: "Compact context", action: "compact" },
  { cmd: "max", label: "/max", desc: "Toggle max mode", action: "max" },
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
  onMaxModeChange,
  events,
  initialModel,
  initialProvider,
  initialMode,
  initialMaxMode,
  sessionId,
  projectDir,
  profileNames = [],
  onProfileSelect,
  noIndex = false,
  configSnapshot,
  saveConfig,
  onReindex,
  onIndexStop,
}: AppProps) {
  const { exit } = useApp()
  type View = "chat" | "model" | "embeddings" | "settings" | "index" | "advanced" | "help"
  const [view, setView] = useState<View>("chat")
  const [state, setState] = useState<AppState>({
    messages: [],
    liveTools: [],
    subAgents: [],
    reasoning: "",
    mode: initialMode,
    maxMode: initialMaxMode,
    isRunning: false,
    model: initialModel,
    provider: initialProvider,
    todo: "",
    indexReady: false,
    indexStatus: null,
    totalTokensIn: 0,
    totalTokensOut: 0,
    lastError: null,
    awaitingApproval: false,
    compacting: false,
    currentStreaming: "",
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
    debugInstructions: "",
    askInstructions: "",
    profilesJson: "{}",
  })
  const [advancedFocus, setAdvancedFocus] = useState(0)
  const [activeProfileIdx, setActiveProfileIdx] = useState(0)
  const inputHistory = useRef<string[]>([])
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
        debugInstructions: configSnapshot.modes?.debug?.customInstructions ?? "",
        askInstructions: configSnapshot.modes?.ask?.customInstructions ?? "",
        profilesJson: JSON.stringify(configSnapshot.profiles ?? {}, null, 2),
      })
      setAdvancedFocus(0)
    }
  }, [view, configSnapshot])

  // Process agent events
  useEffect(() => {
    let active = true
    async function processEvents() {
      for await (const event of events) {
        if (!active) break
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
                  status: "running",
                  timeStart: Date.now(),
                },
              ],
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
      }
    }
    processEvents().catch(() => {})
    return () => {
      active = false
    }
  }, [events])

  const applySlashCommand = (cmd: (typeof SLASH_COMMANDS)[0]) => {
    setInput("")
    setSlashSelected(0)
    if (cmd.mode) {
      setState((s) => ({ ...s, mode: cmd.mode! }))
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
      case "max": {
        const next = !state.maxMode
        setState((s) => ({ ...s, maxMode: next }))
        onMaxModeChange(next)
        setView("chat")
        return
      }
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
      default:
        return
    }
  }

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      if (state.isRunning) {
        onAbort()
        setState((s) => ({ ...s, isRunning: false, liveTools: [], subAgents: [], awaitingApproval: false }))
      } else {
        exit()
      }
      return
    }

    if (key.ctrl && inputChar === "k") {
      setState((s) => ({ ...s, messages: [], todo: "", lastError: null, liveTools: [], subAgents: [] }))
      return
    }

    if (key.ctrl && inputChar === "s") {
      if (!state.isRunning) onCompact()
      return
    }

    if (key.ctrl && inputChar === "m") {
      const next = !state.maxMode
      setState((s) => ({ ...s, maxMode: next }))
      onMaxModeChange(next)
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
        if (key.tab) {
          setModelFocus((f) => (f + 1) % 6)
          return
        }
        if (key.return && modelFocus < 5) {
          setModelFocus((f) => (f + 1) % 6)
          return
        }
        if (key.return && modelFocus === 5 && saveConfig) {
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
        if (modelFocus < 5 && key.backspace) {
          const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
          setModelForm((f) => ({ ...f, [k]: f[k].slice(0, -1) }))
          return
        }
        if (modelFocus < 5 && inputChar && !key.ctrl && !key.meta) {
          const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
          setModelForm((f) => ({ ...f, [k]: f[k] + inputChar }))
          return
        }
        return
      }
      if (view === "embeddings") {
        if (key.tab) {
          setEmbeddingsFocus((f) => (f + 1) % 6)
          return
        }
        if (key.return && embeddingsFocus < 5) {
          setEmbeddingsFocus((f) => (f + 1) % 6)
          return
        }
        if (key.return && embeddingsFocus === 5 && saveConfig && embeddingsForm.model) {
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
        if (embeddingsFocus < 5 && key.backspace) {
          const k = ["provider", "model", "apiKey", "baseUrl", "dimensions"][embeddingsFocus] as "provider" | "model" | "apiKey" | "baseUrl" | "dimensions"
          setEmbeddingsForm((f) => ({ ...f, [k]: (f[k] as string).slice(0, -1) }))
          return
        }
        if (embeddingsFocus < 5 && inputChar && !key.ctrl && !key.meta) {
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
        if (key.return) {
          setView("model")
          return
        }
        return
      }
      if (view === "index") {
        if (key.return && state.indexStatus?.state !== "indexing" && onReindex) {
          onReindex()
        } else if ((inputChar === "s" || inputChar === "S") && state.indexStatus?.state === "indexing" && onIndexStop) {
          onIndexStop()
        }
        return
      }
      if (view === "advanced") {
        if (key.tab) {
          setAdvancedFocus((f) => (f + 1) % 10)
          return
        }
        if (advancedFocus === 9 && key.return && saveConfig) {
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
              debug: { customInstructions: advancedForm.debugInstructions.trim() || undefined },
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
          "debugInstructions",
          "askInstructions",
          "profilesJson",
        ] as const
        if (advancedFocus < 9 && key.backspace) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k].slice(0, -1) }))
          return
        }
        if (advancedFocus < 9 && key.return) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k] + "\n" }))
          return
        }
        if (advancedFocus < 9 && inputChar && !key.ctrl && !key.meta) {
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
      if (key.return && selectedCmd) {
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
      const hist = inputHistory.current
      if (hist.length > 0) {
        const next = Math.min(historyIdx + 1, hist.length - 1)
        setHistoryIdx(next)
        setInput(hist[hist.length - 1 - next]!)
      }
      return
    }

    if (key.downArrow && !slashOpen) {
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

    if (key.return && !slashOpen) {
      if (input.trim() && !state.isRunning) {
        const content = input.trim()
        inputHistory.current.push(content)
        if (inputHistory.current.length > 50) inputHistory.current.shift()
        setHistoryIdx(-1)
        setInput("")
        setState((s) => ({
          ...s,
          isRunning: true,
          lastError: null,
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
        onMessage(content, state.mode)
      }
      return
    }

    if (key.backspace || key.delete) {
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
      />

      {/* ── Chat area or Config view ───────────────────────────────────────── */}
      {view !== "chat" ? (
        <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1}>
          {view === "settings" && (
            <SettingsHubView />
          )}
          {view === "model" && (
            <ModelConfigView form={modelForm} focus={modelFocus} />
          )}
          {view === "embeddings" && (
            <EmbeddingsConfigView form={embeddingsForm} focus={embeddingsFocus} />
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
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <Static items={state.messages}>
          {(msg, i) => <MessageItem key={i} msg={msg} cols={cols} />}
        </Static>

        {state.isRunning && state.reasoning && (
          <ReasoningBlock text={state.reasoning} cols={cols} />
        )}

        {state.isRunning && state.currentStreaming && (
          <StreamingText text={state.currentStreaming} cols={cols} />
        )}

        {state.liveTools
          .filter((lt) => lt.status === "running")
          .map((lt) => (
            <LiveToolCard key={lt.id} tool={lt} />
          ))}

        {state.subAgents.length > 0 && (
          <Box flexDirection="column" paddingX={1} paddingTop={1}>
            {state.subAgents.map((sa) => (
              <SubAgentCard key={sa.id} agent={sa} />
            ))}
          </Box>
        )}

        {state.compacting && (
          <Box paddingX={1} paddingY={0}>
            <Text color="blue">
              <Spinner type="dots" />
            </Text>
            <Text color="blue"> Compacting context...</Text>
          </Box>
        )}

        {state.isRunning &&
          !state.currentStreaming &&
          !state.reasoning &&
          state.liveTools.length === 0 && (
            <Box paddingX={1}>
              <Text color="cyan">
                <Spinner type="dots3" />
              </Text>
              <Text color="cyan"> Thinking...</Text>
            </Box>
          )}

        {state.lastError && <ErrorBanner message={state.lastError} />}
      </Box>
      )}


      {state.todo && <TodoBar todo={state.todo} cols={cols} />}

      {/* ── Slash command popup (above input) ────────────────────────────────── */}
      {slashOpen && filteredCommands.length > 0 && (
        <SlashPopup
          commands={filteredCommands}
          selectedIndex={slashSelected}
        />
      )}

      {/* ── Input bar (hidden when editing /model, /embeddings, etc.) ───────── */}
      {view === "chat" ? (
        <InputBar
          input={input}
          mode={state.mode}
          modeColor={modeColor}
          isRunning={state.isRunning}
          awaitingApproval={state.awaitingApproval}
          indexReady={state.indexReady}
          maxMode={state.maxMode}
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
}: {
  form: { provider: string; id: string; apiKey: string; baseUrl: string; temperature: string }
  focus: number
}) {
  const labels = ["Provider", "Model ID", "API Key", "Base URL", "Temperature (0-2)"]
  const keys = ["provider", "id", "apiKey", "baseUrl", "temperature"] as const
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Model — LLM provider & model</Text>
      <Text color="gray"> Tab — next field, Enter — save, Esc — back. Type here:</Text>
      {labels.map((label, i) => (
        <Box key={label}>
          <Text color={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </Text>
          <Text color="white">{(form[keys[i]] as string) || ""}</Text>
          {focus === i && <Text color="cyan">│</Text>}
        </Box>
      ))}
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
}: {
  form: { provider: string; model: string; apiKey: string; baseUrl: string; dimensions: string }
  focus: number
}) {
  const labels = ["Provider (openai|openai-compatible|ollama|local)", "Model name", "API Key", "Base URL", "Dimensions"]
  const keys = ["provider", "model", "apiKey", "baseUrl", "dimensions"] as const
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold> Embeddings — model for vector search</Text>
      <Text color="gray"> Tab — next field, Enter — save, Esc — back. Type here:</Text>
      {labels.map((label, i) => (
        <Box key={label}>
          <Text color={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </Text>
          <Text color="white">{(form[keys[i]] as string) || ""}</Text>
          {focus === i && <Text color="cyan">│</Text>}
        </Box>
      ))}
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
    debugInstructions: string
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
    "Debug instructions",
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
    "debugInstructions",
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
        <Text color={focus === 9 ? "cyan" : "gray"}>{focus === 9 ? "▸ " : "  "}</Text>
        <Text color={focus === 9 ? "green" : "gray"}>[Save] — press Enter</Text>
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
          <Text color="gray"> S — stop indexing</Text>
        </Box>
      )}
      {st.state === "ready" && (
        <Box flexDirection="column">
          <Text color="green"> Status: ready</Text>
          <Text color="gray"> Files: {st.files}, symbols: {st.symbols}</Text>
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
}: {
  provider: string
  model: string
  projectDir?: string
  noIndex: boolean
  indexReady: boolean
  cols: number
}) {
  const indexLabel = noIndex ? "Index: off" : indexReady ? "Index: ● ready" : "Index: … building"
  const indexColor = noIndex ? "gray" : indexReady ? "green" : "yellow"
  const shortPath = projectDir ? fit(projectDir, Math.max(20, Math.floor(cols * 0.45))) : ""
  const modelLabel = fit(`${provider}/${model}`, Math.max(20, Math.floor(cols * 0.65)))
  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={1} borderStyle="single" borderColor="gray">
      <Box>
        <Text color="cyan" bold>Model </Text>
        <Text color="white">{modelLabel}</Text>
      </Box>
      <Box>
        <Text color={indexColor as "green" | "yellow" | "gray"}> {indexLabel}</Text>
        {shortPath && (
          <>
            <Text color="gray">  ·  </Text>
            <Text color="gray">Project: {shortPath}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color="gray"> Type </Text>
        <Text color="cyan">/</Text>
        <Text color="gray"> for commands  </Text>
        <Text color="cyan">/settings</Text>
        <Text color="gray"> for all agent settings</Text>
      </Box>
    </Box>
  )
}

// ─── Slash command popup ─────────────────────────────────────────────────────

function SlashPopup({
  commands,
  selectedIndex,
}: {
  commands: typeof SLASH_COMMANDS
  selectedIndex: number
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={0}>
      <Text color="gray">
        Commands — ↑↓ choose, Enter select, Esc close
      </Text>
      {commands.map((cmd, i) => (
        <Box key={cmd.cmd}>
          <Text color={i === selectedIndex ? "cyan" : "gray"} bold={i === selectedIndex}>
            {i === selectedIndex ? "▸ " : "  "}
            {cmd.label}
          </Text>
          <Text color="gray">
            {" "}
            — {cmd.desc}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// ─── Input bar ──────────────────────────────────────────────────────────────

function InputBar({
  input,
  mode,
  modeColor,
  isRunning,
  awaitingApproval,
  indexReady,
  maxMode,
}: {
  input: string
  mode: Mode
  modeColor: string
  isRunning: boolean
  awaitingApproval: boolean
  indexReady: boolean
  maxMode: boolean
}) {
  const borderColor = awaitingApproval ? "yellow" : isRunning ? "red" : "cyan"
  const prompt = awaitingApproval
    ? "[AWAITING APPROVAL]"
    : isRunning
      ? "[ABORT: Ctrl+C]"
      : `[${mode}]`
  const promptColor = awaitingApproval ? "yellow" : isRunning ? "red" : (modeColor as "cyan" | "blue" | "yellow" | "green")

  return (
    <Box borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={promptColor} bold>
        {prompt}
      </Text>
      {maxMode && (
        <Text color="yellow" bold>
          {" "}
          MAX
        </Text>
      )}
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
      <Text color="white">{input}</Text>
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
  const lines = todo.split("\n").filter((l) => l.trim())
  const completed = lines.filter((l) => l.includes("[x]") || l.includes("✅")).length
  const total = lines.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  const firstLine = lines[0]?.slice(0, cols - 20) ?? ""

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray" flexDirection="row">
      <Text color="gray">Progress </Text>
      <Text color="cyan">
        [{completed}/{total}]
      </Text>
      <Text color="gray"> {pct}% </Text>
      <Text color="gray" dimColor>
        {firstLine}
      </Text>
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
}: {
  isRunning: boolean
  provider: string
  model: string
  sessionId?: string
  activeProfile: string
  cols: number
}) {
  const shortModel = fit(model, 18)
  const shortSession = sessionId ? (sessionId.slice(0, 8) + "…") : ""
  const line2 = fit(
    `/  /model  /embeddings  /advanced  /index  Tab  Ctrl+M  Ctrl+P(profile)  Ctrl+S  Ctrl+K  Ctrl+C:${isRunning ? "abort" : "quit"}  ↑↓`,
    Math.max(20, cols - 2)
  )
  return (
    <Box paddingX={1} flexDirection="column">
      <Box>
        <Text color="gray"> profile: </Text>
        <Text color="white">{activeProfile}</Text>
        <Text color="gray">  · </Text>
        <Text color="gray">
          {provider}/
        </Text>
        <Text color="white">
          {shortModel}
        </Text>
        {shortSession && (
          <>
            <Text color="gray">  ·  session: </Text>
            <Text color="gray">{shortSession}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color="gray">{line2}</Text>
      </Box>
    </Box>
  )
}

function fit(value: string, max: number): string {
  if (max <= 0) return ""
  if (value.length <= max) return value
  if (max <= 1) return "…"
  return `${value.slice(0, Math.max(0, max - 1))}…`
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
    maxMode: { enabled: boolean; tokenBudgetMultiplier: number }
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
          <Text color="gray">Max mode: </Text>
          <Text color={snap?.maxMode?.enabled ? "yellow" : "gray"}>{snap?.maxMode?.enabled ? "on" : "off"}</Text>
          {snap?.maxMode?.enabled && (
            <Text color="gray"> · token x{snap.maxMode.tokenBudgetMultiplier}</Text>
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
      <Text color="gray"> Tab mode · Ctrl+M max · Ctrl+P profile · Ctrl+S compact · Ctrl+K clear · Ctrl+C abort/quit</Text>
      <Text color="white" bold>{"\n"} Config files</Text>
      <Text color="gray"> .nexus/nexus.yaml (project) · ~/.nexus/nexus.yaml (global)</Text>
      <Text color="gray"> OpenRouter: provider `openai-compatible` + baseUrl `https://openrouter.ai/api/v1`</Text>
    </Box>
  )
}
