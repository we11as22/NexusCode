import React, { useState, useEffect, useRef, useMemo } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import "opentui-spinner/react"
import stringWidth from "string-width"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import type { AgentEvent, Mode, SessionMessage, MessagePart, IndexStatus, PermissionResult, ApprovalAction } from "@nexuscode/core"
import { getModelsCatalog, catalogSelectionToModel, deriveSessionTitle, type ModelsCatalog } from "@nexuscode/core"

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
  /** Pending action to approve (Cline/Opencode-style: show what is being approved) */
  pendingApprovalAction: ApprovalAction | null
  compacting: boolean
  currentStreaming: string
  /** OpenCode-style: toggle reasoning block visibility */
  showThinking: boolean
  /** OpenCode-style: toggle tool execution details in chat */
  showToolDetails: boolean
  /** Plan mode: plan_exit was called; show Approve / Revise / Abandon */
  planCompleted: boolean
  /** Accumulated parts of the current assistant reply (text, tools, reasoning) for chronological display */
  currentAssistantParts: MessagePart[]
}

interface AppProps {
  onExit?: () => void
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
      debug?: { customInstructions?: string }
    }
    profiles?: Record<string, Record<string, unknown>>
  }
  saveConfig?: (updates: Record<string, unknown>) => void
  onReindex?: () => void
  onIndexStop?: () => void
  onIndexDelete?: () => void | Promise<void>
  /** Resolve pending tool approval (y/n/a/s). Called when user submits during awaitingApproval. */
  onResolveApproval?: (result: PermissionResult) => void
  /** List sessions for switching (server or local). */
  getSessionList?: () => Promise<Array<{ id: string; ts?: number; title?: string; messageCount: number }>>
  onSwitchSession?: (sessionId: string) => Promise<void>
}

interface AgentPreset {
  name: string
  modelProvider?: string
  modelId?: string
  vector: boolean
  skills: string[]
  mcpServers: string[]
  rulesFiles: string[]
  createdAt: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** OpenCode-style: batch UI updates every 16ms to avoid re-render on every stream chunk */
const EVENT_BATCH_MS = 16

const MODE_ICONS: Record<Mode, string> = {
  agent: "⚡",
  plan: "📋",
  ask: "💬",
  debug: "🐞",
}

const MODE_COLORS: Record<Mode, string> = {
  agent: "#3ca0ff",
  plan: "#faf74f",
  ask: "#cccccc",
  debug: "#ff9e3d",
}

const THEME = {
  primary: "#faf74f",
  accent: "#3ca0ff",
  muted: "#858585",
  success: "#4CAF50",
  warning: "#cca700",
  danger: "#f48771",
  panel: "#252526",
  panel2: "#2d2d30",
  text: "#cccccc",
  textMuted: "#858585",
} as const

const CLI_VERSION = "0.1.0"

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  write_to_file: "✏️",
  replace_in_file: "🔧",
  execute_command: "⌨️",
  search_files: "🔍",
  list_files: "📂",
  list_code_definitions: "🏗️",
  codebase_search: "🔎",
  web_fetch: "🌐",
  web_search: "🔍",
  exa_web_search: "◈",
  exa_code_search: "◇",
  attempt_completion: "✅",
  ask_followup_question: "❓",
  update_todo_list: "📋",
  thinking_preamble: "💭",
  use_skill: "🎯",
  browser_action: "🌍",
  spawn_agent: "🤖",
}

/** Display name for tools (e.g. execute_command → bash) */
const TOOL_LABELS: Record<string, string> = {
  execute_command: "bash",
  exa_web_search: "Exa Web Search",
  exa_code_search: "Exa Code Search",
}
function toolDisplayName(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}

const MODES: Mode[] = ["agent", "plan", "ask", "debug"]
const MODEL_PROVIDERS = ["anthropic", "openai", "google", "openai-compatible", "ollama", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity"] as const
const EMBEDDING_PROVIDERS = ["openai", "openai-compatible", "ollama", "local"] as const

/** Slash commands (OpenCode-style: /new, /sessions, /compact, /thinking, /details, etc.) */
type SlashAction =
  | "clear"
  | "compact"
  | "help"
  | "settings"
  | "connect"
  | "model"
  | "embeddings"
  | "index"
  | "advanced"
  | "thinking"
  | "details"
  | "sessions"
  | "agentConfigs"
  | "exit"
  | "review"
  | "localReview"
  | "localReviewUncommitted"
  | "init"
const SLASH_COMMANDS: Array<{ cmd: string; label: string; desc: string; mode?: Mode; action?: SlashAction }> = [
  { cmd: "agents", label: "/agents", desc: "Switch agent", action: "agentConfigs" },
  { cmd: "connect", label: "/connect", desc: "Connect provider", action: "connect" },
  { cmd: "editor", label: "/editor", desc: "Open editor", action: "advanced" },
  { cmd: "exit", label: "/exit", desc: "Exit the app", action: "exit" },
  { cmd: "help", label: "/help", desc: "Help", action: "help" },
  { cmd: "init", label: "/init", desc: "Create/update AGENTS.md", action: "init" },
  { cmd: "local-review", label: "/local-review", desc: "Local review (current branch)", action: "localReview" },
  {
    cmd: "local-review-uncommitted",
    label: "/local-review-uncommitted",
    desc: "Local review (uncommitted changes)",
    action: "localReviewUncommitted",
  },
  { cmd: "mcps", label: "/mcps", desc: "Toggle MCPs", action: "advanced" },
  { cmd: "models", label: "/models", desc: "Switch model", action: "model" },
  { cmd: "new", label: "/new", desc: "New session", action: "clear" },
  { cmd: "review", label: "/review", desc: "Review changes", action: "review" },
  { cmd: "index", label: "/index", desc: "Index status and controls", action: "index" },
  { cmd: "agent-config", label: "/agent-config", desc: "Agent configurations", action: "agentConfigs" },
  { cmd: "sessions", label: "/sessions", desc: "List sessions", action: "sessions" },
  { cmd: "agent", label: "/agent", desc: "Agent mode (tools & execution)", mode: "agent" },
  { cmd: "plan", label: "/plan", desc: "Plan mode", mode: "plan" },
  { cmd: "ask", label: "/ask", desc: "Ask mode (Q&A)", mode: "ask" },
  { cmd: "debug", label: "/debug", desc: "Debug mode (diagnose first)", mode: "debug" },
  { cmd: "compact", label: "/compact", desc: "Compact context", action: "compact" },
  { cmd: "model", label: "/model", desc: "Configure LLM provider & model", action: "model" },
  { cmd: "embeddings", label: "/embeddings", desc: "Configure embeddings model", action: "embeddings" },
  { cmd: "advanced", label: "/advanced", desc: "MCP / skills / rules / profiles", action: "advanced" },
  { cmd: "thinking", label: "/thinking", desc: "Toggle reasoning visibility", action: "thinking" },
  { cmd: "details", label: "/details", desc: "Toggle tool execution details", action: "details" },
  { cmd: "clear", label: "/clear", desc: "Clear chat", action: "clear" },
  { cmd: "settings", label: "/settings", desc: "Full agent settings", action: "settings" },
]

// ─── Logo ────────────────────────────────────────────────────────────────────

const NEXUS_LOGO = [
  "███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗",
  "████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝",
  "██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗",
  "██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║",
  "██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║",
  "╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
]
const NEXUS_SUB = "Nexus agent runtime"

function Logo({ cols }: { cols: number }) {
  if (cols < 60) {
    const text = "Nexus CLI"
    const padSmall = Math.max(0, Math.floor((cols - text.length) / 2))
    return (
      <box paddingLeft={padSmall}>
        <text fg={THEME.accent} bold>{text}</text>
      </box>
    )
  }
  const pad = Math.max(0, Math.floor((cols - NEXUS_LOGO[0]!.length) / 2))
  const padSub = Math.max(0, Math.floor((cols - NEXUS_SUB.length) / 2))
  return (
    <box flexDirection="column" flexShrink={0}>
      {NEXUS_LOGO.map((line, idx) => (
        <box key={`logo-${idx}`} paddingLeft={pad}>
          <text fg={THEME.accent}>{line}</text>
        </box>
      ))}
      <box paddingLeft={padSub}>
        <text fg={THEME.textMuted} bold>{NEXUS_SUB}</text>
      </box>
    </box>
  )
}

// ─── Header ──────────────────────────────────────────────────────────────────

function HeaderBar({
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
  const indexLabel = noIndex ? "Vector index: off" : indexReady ? "Vector index: ready" : "Vector index: building"
  const maxW = Math.max(40, cols - 4)
  const ctxStr = `Context: ${formatTokens(contextUsedTokens)}/${formatTokens(contextLimitTokens)} (${contextPercent}%)`
  const modelStr = `${provider}/${model}`
  const pathStr = projectDir ? fit(projectDir, 20) : ""
  const line = fit(`${modelStr} · ${indexLabel} · ${ctxStr}${pathStr ? ` · ${pathStr}` : ""}`, maxW)
  const indexColor = noIndex ? THEME.muted : indexReady ? THEME.success : THEME.warning
  return (
    <box flexShrink={0} flexDirection="column" paddingTop={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={0}>
      <text fg={indexColor as "green" | "yellow" | "gray"}>{line}</text>
    </box>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export function App({
  onExit,
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
  onIndexDelete,
  onResolveApproval,
  getSessionList,
  onSwitchSession,
}: AppProps) {
  const dims = useTerminalDimensions()
  const renderer = useRenderer()
  const cols = Math.max(40, Math.min(256, dims?.width ?? 80))
  const rows = Math.max(16, Math.min(120, dims?.height ?? 24))
  type View = "chat" | "model" | "embeddings" | "settings" | "index" | "advanced" | "help" | "sessions" | "agentConfigs"
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
    pendingApprovalAction: null,
    compacting: false,
    currentStreaming: "",
    showThinking: true,
    showToolDetails: true,
    planCompleted: false,
    currentAssistantParts: [],
  })
  const [input, setInput] = useState("")
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [slashSelected, setSlashSelected] = useState(0)
  const [modelForm, setModelForm] = useState({ provider: "", id: "", apiKey: "", baseUrl: "", temperature: "" })
  const [modelFocus, setModelFocus] = useState(0)
  const [modelCatalog, setModelCatalog] = useState<ModelsCatalog | null>(null)
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false)
  const [modelPickerIndex, setModelPickerIndex] = useState(0)
  const [modelPickerQuery, setModelPickerQuery] = useState("")
  const [modelViewMode, setModelViewMode] = useState<"picker" | "manual">("picker")
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
    debugInstructions: "",
    profilesJson: "{}",
  })
  const [advancedFocus, setAdvancedFocus] = useState(0)
  const [activeProfileIdx, setActiveProfileIdx] = useState(0)
  const [chatScrollLines, setChatScrollLines] = useState(0)
  const [sessionList, setSessionList] = useState<Array<{ id: string; ts?: number; title?: string; messageCount: number }>>([])
  const [sessionListSelected, setSessionListSelected] = useState(0)
  const [sessionListLoading, setSessionListLoading] = useState(false)
  const [agentPresets, setAgentPresets] = useState<AgentPreset[]>([])
  const [agentPresetSelected, setAgentPresetSelected] = useState(0)
  const [agentPresetLoading, setAgentPresetLoading] = useState(false)
  const [agentPresetCreateMode, setAgentPresetCreateMode] = useState(false)
  const [agentPresetName, setAgentPresetName] = useState("")
  const [agentPresetOptionIndex, setAgentPresetOptionIndex] = useState(0)
  const [availableSkills, setAvailableSkills] = useState<string[]>([])
  const [availableRules, setAvailableRules] = useState<string[]>([])
  const [selectedPresetSkills, setSelectedPresetSkills] = useState<string[]>([])
  const [selectedPresetMcp, setSelectedPresetMcp] = useState<string[]>([])
  const [selectedPresetRules, setSelectedPresetRules] = useState<string[]>([])
  const [selectedPresetVector, setSelectedPresetVector] = useState(Boolean(configSnapshot?.indexing?.vector))
  const [vectorIndexEnabled, setVectorIndexEnabled] = useState(Boolean(configSnapshot?.indexing?.vector))
  const [indexingEnabled, setIndexingEnabled] = useState(Boolean(configSnapshot?.indexing?.enabled ?? true))
  const inputHistory = useRef<string[]>([])
  const eventQueueRef = useRef<AgentEvent[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSubmitRef = useRef<number>(0)

  // Clamp scroll when terminal is resized so we don't show invalid offset
  useEffect(() => {
    setChatScrollLines((prev) => {
      const width = Math.max(20, cols - 4)
      const visibleHeight = Math.max(8, rows - (view === "chat" ? 20 : 14))
      const allLines = buildChatLines(state, width)
      const maxScroll = Math.max(0, allLines.length - visibleHeight)
      return Math.min(prev, maxScroll)
    })
  }, [cols, rows, view])
  // Enable mouse wheel (SGR) for scroll — disable on unmount
  useEffect(() => {
    if (!process.stdout.isTTY) return
    process.stdout.write("\x1b[?1006h")
    return () => {
      process.stdout.write("\x1b[?1006l")
    }
  }, [])
  useEffect(() => {
    if (!process.stdin.isTTY) return
    const onData = (chunk: Buffer | string) => {
      if (view !== "chat") return
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      if (!text.includes("\u001b[<")) return
      const matches = text.matchAll(/\u001b\[<(\d+);(\d+);(\d+)([mM])/g)
      for (const match of matches) {
        const code = Number(match[1] ?? "")
        if (code === 64) {
          setChatScrollLines((v) => v + 3)
        } else if (code === 65) {
          setChatScrollLines((v) => Math.max(0, v - 3))
        }
      }
    }
    process.stdin.on("data", onData)
    return () => {
      process.stdin.off("data", onData)
    }
  }, [view])
  const profileOptions = useMemo(() => ["default", ...profileNames], [profileNames])
  const sessionTitle = useMemo(() => deriveSessionTitle(state.messages), [state.messages])
  const mcpServersCount = configSnapshot?.mcp?.servers?.length ?? 0
  const namedMcpServers = useMemo(() => {
    return (configSnapshot?.mcp?.servers ?? []).map((server, idx) => {
      const raw = server?.name
      const cmd = server?.command
      const url = server?.url
      const name =
        (typeof raw === "string" && raw.trim()) ||
        (typeof cmd === "string" && cmd.trim()) ||
        (typeof url === "string" && url.trim()) ||
        `server-${idx + 1}`
      return { name, server }
    })
  }, [configSnapshot])
  const mcpServerNames = useMemo(() => namedMcpServers.map((item) => item.name), [namedMcpServers])
  const showSidebar = view === "chat" && cols >= 120

  useEffect(() => {
    setVectorIndexEnabled(Boolean(configSnapshot?.indexing?.vector))
    setIndexingEnabled(Boolean(configSnapshot?.indexing?.enabled ?? true))
    setSelectedPresetVector(Boolean(configSnapshot?.indexing?.vector))
  }, [configSnapshot])

  useEffect(() => {
    if (!projectDir) return
    let active = true
    setAgentPresetLoading(true)
    readAgentPresets(projectDir)
      .then((list) => {
        if (!active) return
        setAgentPresets(list)
      })
      .finally(() => {
        if (active) setAgentPresetLoading(false)
      })
    discoverSkillPaths(projectDir)
      .then((skills) => {
        if (!active) return
        const merged = dedupeList([...(configSnapshot?.skills ?? []), ...skills])
        setAvailableSkills(merged)
      })
      .catch(() => {
        if (!active) return
        setAvailableSkills(configSnapshot?.skills ?? [])
      })

    return () => {
      active = false
    }
  }, [projectDir, configSnapshot?.skills])

  useEffect(() => {
    if (!projectDir) {
      const rules = dedupeList(["AGENTS.md", "CLAUDE.md", ...(configSnapshot?.rules?.files ?? [])])
      setAvailableRules(rules)
      return
    }
    let active = true
    discoverRuleFiles(projectDir)
      .then((rules) => {
        if (!active) return
        const merged = dedupeList([...(configSnapshot?.rules?.files ?? []), ...rules, "AGENTS.md", "CLAUDE.md"])
        setAvailableRules(merged)
      })
      .catch(() => {
        if (!active) return
        setAvailableRules(dedupeList(["AGENTS.md", "CLAUDE.md", ...(configSnapshot?.rules?.files ?? [])]))
      })
    return () => {
      active = false
    }
  }, [projectDir, configSnapshot?.rules?.files])

  const slashOpen = input.startsWith("/")
  const slashQuery = slashOpen ? input.slice(1).toLowerCase().trim() : ""
  const filteredCommands = useMemo(() => {
    if (!slashQuery) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (c) => c.cmd.startsWith(slashQuery) || c.cmd.includes(slashQuery)
    )
  }, [slashQuery])
  const selectedCmd = filteredCommands[Math.min(slashSelected, filteredCommands.length - 1)]

  // Model picker: flat list (Recommended first, then OpenRouter), filtered by query
  const modelPickerOptions = useMemo(() => {
    if (!modelCatalog) return []
    const q = modelPickerQuery.trim().toLowerCase()
    const rec = modelCatalog.recommended.map((r) => ({
      ...r,
      category: r.free ? "Free (Recommended)" : "Recommended",
    }))
    const rest: Array<{ providerId: string; modelId: string; name: string; free: boolean; category: string }> = []
    for (const prov of modelCatalog.providers) {
      for (const m of prov.models) {
        if (rec.some((r) => r.providerId === prov.id && r.modelId === m.id)) continue
        rest.push({
          providerId: prov.id,
          modelId: m.id,
          name: m.name,
          free: m.free,
          category: prov.name,
        })
      }
    }
    const all = [...rec, ...rest]
    if (!q) return all
    return all.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.modelId.toLowerCase().includes(q)
    )
  }, [modelCatalog, modelPickerQuery])

  const modelPickerSelected = modelPickerOptions[Math.min(modelPickerIndex, Math.max(0, modelPickerOptions.length - 1))]

  // Sync slashSelected when filter changes
  useEffect(() => {
    setSlashSelected(0)
  }, [slashQuery])

  // Init form from config when opening a config view
  useEffect(() => {
    if (view === "model" && configSnapshot) {
      setModelViewMode("picker")
      setModelPickerQuery("")
      setModelPickerIndex(0)
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
        debugInstructions: configSnapshot.modes?.debug?.customInstructions ?? "",
        profilesJson: JSON.stringify(configSnapshot.profiles ?? {}, null, 2),
      })
      setAdvancedFocus(0)
    }
    if (view === "agentConfigs") {
      setAgentPresetCreateMode(false)
      setAgentPresetOptionIndex(0)
      setAgentPresetName("")
      setSelectedPresetVector(Boolean(configSnapshot?.indexing?.vector))
      setSelectedPresetSkills(dedupeList(configSnapshot?.skills ?? []))
      setSelectedPresetMcp(dedupeList(mcpServerNames))
      setSelectedPresetRules(dedupeList(configSnapshot?.rules?.files ?? ["AGENTS.md", "CLAUDE.md"]))
    }
  }, [view, configSnapshot, mcpServerNames])

  // Load session list when opening sessions view
  useEffect(() => {
    if (view !== "sessions" || !getSessionList) return
    setSessionListLoading(true)
    getSessionList()
      .then((list) => {
        setSessionList(list)
        setSessionListSelected(0)
      })
      .catch(() => setSessionList([]))
      .finally(() => setSessionListLoading(false))
  }, [view, getSessionList])

  useEffect(() => {
    if (view !== "agentConfigs" || !projectDir) return
    let cancelled = false
    setAgentPresetLoading(true)
    readAgentPresets(projectDir)
      .then((list) => {
        if (cancelled) return
        setAgentPresets(list)
        setAgentPresetSelected(0)
      })
      .finally(() => {
        if (!cancelled) setAgentPresetLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, projectDir])

  // Load models catalog once at TUI start (same as extension: not every time model picker is opened)
  useEffect(() => {
    let cancelled = false
    setModelCatalogLoading(true)
    getModelsCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setModelCatalog(catalog)
          setModelPickerIndex(0)
        }
      })
      .catch(() => {
        if (!cancelled) setModelCatalog(null)
      })
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false)
      })
    return () => { cancelled = true }
  }, [])

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
          case "reasoning_delta": {
            const delta = (event as { delta?: string }).delta ?? ""
            setState((s) => {
              const flushed = s.currentStreaming.trim() ? [...s.currentAssistantParts, { type: "text" as const, text: s.currentStreaming }] : s.currentAssistantParts
              const prev = flushed.filter((p) => p.type === "reasoning").pop() as { type: "reasoning"; text: string } | undefined
              const reasoningParts = flushed.filter((p) => p.type !== "reasoning")
              if (prev) reasoningParts.push({ type: "reasoning", text: prev.text + delta })
              else reasoningParts.push({ type: "reasoning", text: delta })
              return { ...s, currentAssistantParts: reasoningParts, currentStreaming: "", reasoning: s.reasoning + delta }
            })
            break
          }
          case "tool_start": {
            const ev = event as { partId: string; tool: string; input?: Record<string, unknown> }
            setState((s) => {
              const flushed = s.currentStreaming.trim()
                ? [...s.currentAssistantParts, { type: "text" as const, text: s.currentStreaming }]
                : s.currentAssistantParts
              const toolPart: MessagePart = {
                type: "tool",
                id: ev.partId,
                tool: ev.tool,
                status: "running",
                input: ev.input ?? {},
                timeStart: Date.now(),
              }
              return {
                ...s,
                currentAssistantParts: [...flushed, toolPart],
                currentStreaming: "",
                liveTools: [
                  ...s.liveTools,
                  { id: ev.partId, tool: ev.tool, status: "running" as const, timeStart: Date.now() },
                ].slice(-64),
              }
            })
            break
          }
          case "tool_end": {
            const ev = event as { partId: string; tool: string; success: boolean; output?: string; error?: string }
            setState((s) => ({
              ...s,
              currentAssistantParts: s.currentAssistantParts.map((p) =>
                p.type === "tool" && p.id === ev.partId
                  ? { ...p, status: ev.success ? "completed" : "error", output: ev.output, error: ev.error, timeEnd: Date.now() }
                  : p
              ),
              liveTools: s.liveTools.map((lt) =>
                lt.id === ev.partId
                  ? { ...lt, status: ev.success ? "completed" : "error", timeEnd: Date.now() }
                  : lt
              ),
              ...(ev.tool === "plan_exit" && ev.success ? { planCompleted: true } : {}),
            }))
            break
          }
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
          case "tool_approval_needed": {
            const ev = event as { type: "tool_approval_needed"; action: ApprovalAction }
            setState((s) => ({ ...s, awaitingApproval: true, pendingApprovalAction: ev.action ?? null }))
            break
          }
          case "done":
            setState((s) => {
              const text = stripToolCallMarkup(s.currentStreaming)
              const parts = [...s.currentAssistantParts]
              if (text.trim()) parts.push({ type: "text", text })
              const hasContent = parts.length > 0
              const lastMessage = s.messages[s.messages.length - 1]
              const duplicateAssistant =
                hasContent &&
                lastMessage?.role === "assistant" &&
                Array.isArray(lastMessage.content) &&
                JSON.stringify(lastMessage.content) === JSON.stringify(parts)
              const newMsg: SessionMessage | null = hasContent
                ? {
                    id: `r_${Date.now()}`,
                    ts: Date.now(),
                    role: "assistant",
                    content: parts,
                  }
                : null
              const noFinalTextMsg: SessionMessage | null = !hasContent && s.liveTools.length > 0
                ? {
                    id: `sys_${Date.now()}`,
                    ts: Date.now(),
                    role: "system",
                    content:
                      s.liveTools.every((t) => t.tool === "update_todo_list") && s.todo.trim()
                        ? "Todo list updated. No text reply — use agent mode to run the steps, or ask a follow-up."
                        : "No final text response was produced. Retry with a narrower prompt or switch to agent mode.",
                  }
                : null
              return {
                ...s,
                messages: newMsg && !duplicateAssistant
                  ? [...s.messages, newMsg]
                  : (noFinalTextMsg ? [...s.messages, noFinalTextMsg] : s.messages),
                currentAssistantParts: [],
                subAgents: s.subAgents.filter((a) => a.status === "running"),
                reasoning: "",
                currentStreaming: "",
                isRunning: false,
                awaitingApproval: false,
                pendingApprovalAction: null,
                lastError: null,
              }
            })
            break
          case "error":
            setState((s) => ({
              ...s,
                isRunning: s.awaitingApproval ? s.isRunning : false,
                lastError: event.error,
                awaitingApproval: false,
                pendingApprovalAction: null,
                currentAssistantParts: [],
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
          case "todo_updated":
            setState((s) => ({ ...s, todo: (event as { type: "todo_updated"; todo: string }).todo ?? "" }))
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

  const appendUserEcho = (content: string, makeRunning = false) => {
    const trimmed = content.trim()
    if (!trimmed) return
    setState((s) => {
      const last = s.messages[s.messages.length - 1]
      if (
        last &&
        last.role === "user" &&
        typeof last.content === "string" &&
        last.content.trim() === trimmed &&
        Date.now() - last.ts < 1000
      ) {
        return s
      }
      return {
        ...s,
        isRunning: makeRunning ? true : s.isRunning,
        lastError: makeRunning ? null : s.lastError,
        liveTools: makeRunning ? [] : s.liveTools,
        planCompleted: makeRunning ? false : s.planCompleted,
        messages: [
          ...s.messages,
          {
            id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            ts: Date.now(),
            role: "user",
            content: trimmed,
          },
        ],
      }
    })
    setChatScrollLines(0)
  }

  const submitChatInput = (submittedRaw?: string) => {
    if (view !== "chat") return
    const currentInput = typeof submittedRaw === "string" ? submittedRaw : input

    if (slashOpen) {
      const typed = currentInput.slice(1).trim().toLowerCase()
      const exact = typed
        ? SLASH_COMMANDS.find((cmd) => cmd.cmd.toLowerCase() === typed || cmd.label.slice(1).toLowerCase() === typed)
        : undefined
      if (exact) {
        applySlashCommand(exact)
        return
      }
      if (selectedCmd) {
        applySlashCommand(selectedCmd)
      }
      return
    }

    if (state.awaitingApproval && onResolveApproval) {
      const raw = currentInput.trim().toLowerCase()
      const isExecute = state.pendingApprovalAction?.type === "execute"
      const addToAllowed = isExecute && (raw === "e" || raw === "add")
      const allowedKeys = ["y", "yes", "n", "no", "a", "always", "s", "skip"]
      if (allowedKeys.includes(raw) || addToAllowed) {
        const approved = ["y", "yes", "a", "always", "s", "skip"].includes(raw) || addToAllowed
        const alwaysApprove = raw === "a" || raw === "always"
        const skipAll = raw === "s" || raw === "skip"
        const addToAllowedCommand = addToAllowed ? state.pendingApprovalAction?.content : undefined
        setInput("")
        setChatScrollLines(0)
        setState((s) => ({ ...s, awaitingApproval: false, pendingApprovalAction: null }))
        onResolveApproval({
          approved,
          alwaysApprove,
          skipAll,
          addToAllowedCommand: typeof addToAllowedCommand === "string" ? addToAllowedCommand : undefined,
        })
      }
      return
    }

    if (currentInput.trim() && !state.isRunning) {
      const now = Date.now()
      if (now - lastSubmitRef.current < 400) return
      lastSubmitRef.current = now
      const content = currentInput.trim()
      inputHistory.current.push(content)
      if (inputHistory.current.length > 50) inputHistory.current.shift()
      setHistoryIdx(-1)
      setInput("")
      appendUserEcho(content, true)
      onMessage(content, state.mode)
    }
  }

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
        if (!state.isRunning) {
          appendUserEcho("/compact")
          onCompact()
        }
        setView("chat")
        return
      case "connect":
        setModelViewMode("manual")
        setModelFocus(0)
        setView("model")
        return
      case "model":
        setModelViewMode("picker")
        setView("model")
        return
      case "embeddings":
        setView("embeddings")
        return
      case "index":
        setView("index")
        return
      case "sessions":
        setView("sessions")
        return
      case "agentConfigs":
        setView("agentConfigs")
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
      case "review":
        if (!state.isRunning) {
          appendUserEcho("/review", true)
          setState((s) => ({ ...s, mode: "agent", planCompleted: false }))
          onModeChange("agent")
          onMessage("Run a repository review for the current branch. Report findings ordered by severity with exact file:line references and concrete fixes.", "agent")
        }
        setView("chat")
        return
      case "localReview":
        if (!state.isRunning) {
          appendUserEcho("/local-review", true)
          setState((s) => ({ ...s, mode: "agent", planCompleted: false }))
          onModeChange("agent")
          onMessage("Run a local review for the current branch only (no remote PR). Report findings by severity with file:line references.", "agent")
        }
        setView("chat")
        return
      case "localReviewUncommitted":
        if (!state.isRunning) {
          appendUserEcho("/local-review-uncommitted", true)
          setState((s) => ({ ...s, mode: "agent", planCompleted: false }))
          onModeChange("agent")
          onMessage("Review uncommitted changes in the working tree and report findings by severity with file:line references.", "agent")
        }
        setView("chat")
        return
      case "init":
        if (!state.isRunning) {
          appendUserEcho("/init", true)
          setState((s) => ({ ...s, mode: "agent", planCompleted: false }))
          onModeChange("agent")
          onMessage("Create or update AGENTS.md for this repository using the current project structure and conventions. Keep it concise and practical.", "agent")
        }
        setView("chat")
        return
      case "exit":
        onExit?.()
        return
      default:
        return
    }
  }

  const agentPresetOptions = useMemo(() => {
    const options: Array<{ kind: "vector" | "skill" | "mcp" | "rule"; value: string; label: string }> = [
      { kind: "vector", value: "vector", label: "Enable vector index" },
    ]
    for (const skill of availableSkills) {
      options.push({ kind: "skill", value: skill, label: `Skill: ${skill}` })
    }
    for (const mcp of mcpServerNames) {
      options.push({ kind: "mcp", value: mcp, label: `MCP: ${mcp}` })
    }
    for (const rule of availableRules) {
      options.push({ kind: "rule", value: rule, label: `Rule file: ${rule}` })
    }
    return options
  }, [availableSkills, mcpServerNames, availableRules])

  const selectedPreset = agentPresets[Math.min(agentPresetSelected, Math.max(0, agentPresets.length - 1))]

  const startPresetCreate = () => {
    setAgentPresetCreateMode(true)
    setAgentPresetOptionIndex(0)
    setAgentPresetName(`preset-${new Date().toISOString().slice(0, 10)}`)
    setSelectedPresetVector(Boolean(configSnapshot?.indexing?.vector))
    setSelectedPresetSkills(dedupeList(configSnapshot?.skills ?? []))
    setSelectedPresetMcp(dedupeList(mcpServerNames))
    setSelectedPresetRules(dedupeList(configSnapshot?.rules?.files ?? ["AGENTS.md", "CLAUDE.md"]))
  }

  const togglePresetOption = (option: { kind: "vector" | "skill" | "mcp" | "rule"; value: string }) => {
    if (option.kind === "vector") {
      setSelectedPresetVector((v) => !v)
      return
    }
    if (option.kind === "skill") {
      setSelectedPresetSkills((prev) => toggleInList(prev, option.value))
      return
    }
    if (option.kind === "mcp") {
      setSelectedPresetMcp((prev) => toggleInList(prev, option.value))
      return
    }
    setSelectedPresetRules((prev) => toggleInList(prev, option.value))
  }

  const savePresetDraft = async () => {
    if (!projectDir) return
    const name = agentPresetName.trim()
    if (!name) return
    const draft: AgentPreset = {
      name,
      modelProvider: state.provider,
      modelId: state.model,
      vector: selectedPresetVector,
      skills: dedupeList(selectedPresetSkills),
      mcpServers: dedupeList(selectedPresetMcp),
      rulesFiles: dedupeList(selectedPresetRules),
      createdAt: Date.now(),
    }
    const filtered = agentPresets.filter((p) => p.name !== draft.name)
    const next = [draft, ...filtered]
    setAgentPresets(next)
    setAgentPresetCreateMode(false)
    setAgentPresetSelected(0)
    await writeAgentPresets(projectDir, next).catch(() => {})
  }

  const applyPreset = (preset: AgentPreset | undefined) => {
    if (!preset || !saveConfig) return
    const selectedServers = namedMcpServers
      .filter((item) => preset.mcpServers.includes(item.name))
      .map((item) => item.server)
    const updates: Record<string, unknown> = {
      indexing: {
        enabled: indexingEnabled,
        vector: preset.vector,
      },
      skills: preset.skills,
      mcp: { servers: selectedServers },
      rules: { files: preset.rulesFiles.length > 0 ? preset.rulesFiles : ["AGENTS.md", "CLAUDE.md"] },
    }
    if (preset.modelProvider && preset.modelId) {
      updates.model = { provider: preset.modelProvider, id: preset.modelId }
      setState((s) => ({ ...s, provider: preset.modelProvider!, model: preset.modelId! }))
    }
    saveConfig(updates)
    setVectorIndexEnabled(Boolean(preset.vector))
    setSelectedPresetVector(Boolean(preset.vector))
    setView("chat")
  }

  const deletePreset = async () => {
    if (!projectDir || agentPresets.length === 0) return
    const current = agentPresets[Math.min(agentPresetSelected, agentPresets.length - 1)]
    if (!current) return
    const next = agentPresets.filter((preset) => preset.name !== current.name)
    setAgentPresets(next)
    setAgentPresetSelected((idx) => Math.max(0, Math.min(idx, next.length - 1)))
    await writeAgentPresets(projectDir, next).catch(() => {})
  }

  function extractInputTextFromEvent(evt: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }): string {
    if (evt.ctrl || evt.meta) return ""
    let text = typeof evt.sequence === "string" ? evt.sequence : ""
    if (!text && typeof evt.name === "string") {
      const lowered = evt.name.toLowerCase()
      if (lowered === "space") text = " "
      else if (evt.name.length === 1) text = evt.name
    }
    if (!text) return ""
    text = text.replace(/\u001b\[200~|\u001b\[201~/g, "")
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    if (text.includes("\u001b")) return ""
    return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
  }

  const toSingleLineInput = (text: string): string =>
    text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+/g, " ").replace(/\t/g, " ")

  const appendTextToActiveField = (raw: string): boolean => {
    const typed = toSingleLineInput(raw)
    if (!typed) return false
    if (view === "chat") {
      setInput((s) => s + typed)
      return true
    }
    if (view === "model") {
      if (modelViewMode === "picker") {
        setModelPickerQuery((q) => q + typed)
        setModelPickerIndex(0)
        return true
      }
      if (modelFocus >= 0 && modelFocus < 5) {
        const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
        setModelForm((f) => ({ ...f, [k]: f[k] + typed }))
        return true
      }
    }
    if (view === "embeddings" && embeddingsFocus >= 0 && embeddingsFocus < 5) {
      const k = ["provider", "model", "apiKey", "baseUrl", "dimensions"][embeddingsFocus] as "provider" | "model" | "apiKey" | "baseUrl" | "dimensions"
      setEmbeddingsForm((f) => ({ ...f, [k]: (f[k] as string) + typed }))
      return true
    }
    if (view === "advanced" && advancedFocus >= 0 && advancedFocus < 9) {
      const keys = [
        "mcpServersJson",
        "skillsText",
        "claudeMdPath",
        "rulesFilesText",
        "agentInstructions",
        "planInstructions",
        "askInstructions",
        "debugInstructions",
        "profilesJson",
      ] as const
      const k = keys[advancedFocus]!
      setAdvancedForm((f) => ({ ...f, [k]: f[k] + typed }))
      return true
    }
    if (view === "agentConfigs" && agentPresetCreateMode) {
      setAgentPresetName((name) => name + typed)
      return true
    }
    return false
  }

  useEffect(() => {
    const keyInput = renderer.keyInput as { on?: (ev: string, cb: (evt: { text?: string }) => void) => void; off?: (ev: string, cb: (evt: { text?: string }) => void) => void }
    if (!keyInput?.on) return
    const onPaste = (evt: { text?: string }) => {
      // Chat input is handled by OpenTUI InputRenderable (prevents duplicate paste).
      if (view === "chat") return
      const text = typeof evt?.text === "string" ? evt.text : ""
      if (!text) return
      appendTextToActiveField(text)
    }
    keyInput.on("paste", onPaste)
    return () => {
      keyInput.off?.("paste", onPaste)
    }
  }, [renderer, view, modelViewMode, modelFocus, embeddingsFocus, advancedFocus, agentPresetCreateMode])

  useKeyboard((evt) => {
    const name = (evt.name ?? "").toLowerCase()
    const isEnter = name === "return" || name === "enter"
    const extracted = extractInputTextFromEvent(evt)
    const inputText = extracted || (name === "space" ? " " : "")
    const inputChar = inputText.length === 1 ? inputText : ""
    const key = {
      return: isEnter,
      escape: name === "escape",
      ctrl: !!evt.ctrl,
      meta: !!evt.meta,
      shift: !!evt.shift,
      upArrow: name === "up",
      downArrow: name === "down",
      backspace: name === "backspace",
      delete: name === "delete",
      tab: name === "tab",
      pageUp: name === "pageup",
      pageDown: name === "pagedown",
      end: name === "end",
    }
    handleKey(inputText, inputChar, key, name)
  })

  function handleKey(
    inputText: string,
    inputChar: string,
    key: { return: boolean; escape: boolean; ctrl: boolean; meta: boolean; shift: boolean; upArrow: boolean; downArrow: boolean; backspace: boolean; delete: boolean; tab: boolean; pageUp: boolean; pageDown: boolean; end: boolean },
    evtName: string
  ) {
    const ctrlKey = evtName.length === 1 ? evtName : (evtName.startsWith("ctrl+") ? evtName.slice(5) : "")
    const plainChar = inputChar || (evtName.length === 1 ? evtName : "")
    const lowerChar = plainChar.toLowerCase()
    const isEnter = key.return || inputChar === "\r" || inputChar === "\n"
    if (renderer.hasSelection) {
      if (key.ctrl && ctrlKey === "c") {
        const selectedText = renderer.getSelection()?.getSelectedText() ?? ""
        if (selectedText) renderer.copyToClipboardOSC52(selectedText)
        renderer.clearSelection()
        return
      }
      if (key.escape) {
        renderer.clearSelection()
        return
      }
    }
    // Ctrl+C: при raw mode inputChar пустой (evt.ctrl=true), ловим по evt.name === "c"
    if (key.ctrl && ctrlKey === "c") {
      if (state.isRunning) {
        onAbort()
        setState((s) => ({ ...s, isRunning: false, liveTools: [], subAgents: [], awaitingApproval: false, pendingApprovalAction: null }))
      } else {
        onExit?.()
      }
      return
    }

    // Plan mode: after plan_exit, [A]pprove / [R]evise / [D]abandon
    if (
      view === "chat" &&
      state.mode === "plan" &&
      state.planCompleted &&
      !state.isRunning &&
      (lowerChar === "a" || lowerChar === "r" || lowerChar === "d")
    ) {
      const action = lowerChar
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

    if (key.ctrl && ctrlKey === "k") {
      setState((s) => ({ ...s, messages: [], todo: "", lastError: null, liveTools: [], subAgents: [] }))
      setChatScrollLines(0)
      return
    }

    if (key.ctrl && ctrlKey === "s") {
      if (!state.isRunning) onCompact()
      return
    }

    if (key.ctrl && ctrlKey === "u" && view === "chat") {
      setChatScrollLines((v) => v + 12)
      return
    }
    if (key.ctrl && ctrlKey === "d" && view === "chat") {
      setChatScrollLines((v) => Math.max(0, v - 12))
      return
    }
    if (key.ctrl && ctrlKey === "b" && view === "chat") {
      setChatScrollLines((v) => v + 24)
      return
    }
    if (key.ctrl && ctrlKey === "f" && view === "chat") {
      setChatScrollLines((v) => Math.max(0, v - 24))
      return
    }
    if (view === "chat" && key.ctrl && ctrlKey === "g") {
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

    // Arrow keys scroll chat when input is empty (OpenCode-style)
    if (view === "chat" && !input.trim() && key.upArrow) {
      setChatScrollLines((v) => v + 4)
      return
    }
    if (view === "chat" && !input.trim() && key.downArrow) {
      setChatScrollLines((v) => Math.max(0, v - 4))
      return
    }

    if (key.ctrl && ctrlKey === "p" && view === "chat") {
      setInput("/")
      setSlashSelected(0)
      return
    }

    if (key.ctrl && ctrlKey === "o") {
      if (profileOptions.length <= 1) return
      const nextIdx = (activeProfileIdx + 1) % profileOptions.length
      setActiveProfileIdx(nextIdx)
      const next = profileOptions[nextIdx]
      onProfileSelect?.(next && next !== "default" ? next : undefined)
      return
    }

    // When in config views, handle Tab / Enter / Backspace / type here first (so they don't change mode or send message)
    if (view !== "chat") {
      if (key.escape && view !== "agentConfigs") {
        setView("chat")
        return
      }
      if (view === "model") {
        if (modelViewMode === "picker") {
          if (key.upArrow || key.downArrow) {
            const len = modelPickerOptions.length
            if (len === 0) return
            setModelPickerIndex((i) => {
              const next = key.downArrow ? i + 1 : i - 1
              return ((next % len) + len) % len
            })
            return
          }
          if (isEnter && modelPickerSelected && saveConfig && modelCatalog) {
            const resolved = catalogSelectionToModel(
              modelPickerSelected.providerId,
              modelPickerSelected.modelId,
              modelCatalog
            )
            const modelPatch: Record<string, unknown> = {
              provider: resolved.provider,
              id: resolved.id,
              baseUrl: resolved.baseUrl,
            }
            if (typeof configSnapshot?.model?.temperature === "number") {
              modelPatch.temperature = configSnapshot.model.temperature
            }
            saveConfig({
              model: modelPatch,
            })
            setView("chat")
            setState((s) => ({ ...s, provider: resolved.provider, model: resolved.id }))
            return
          }
          if (key.tab) {
            setModelViewMode("manual")
            return
          }
          if (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f" || inputChar === "\u0008") {
            setModelPickerQuery((q) => q.slice(0, -1))
            setModelPickerIndex(0)
            return
          }
          const typed = toSingleLineInput(inputText)
          if (typed) {
            setModelPickerQuery((q) => q + typed)
            setModelPickerIndex(0)
            return
          }
          return
        }
        if (modelFocus === 0 && (key.upArrow || key.downArrow)) {
          const currentIdx = Math.max(0, MODEL_PROVIDERS.findIndex((p) => p === modelForm.provider))
          const nextIdx = key.downArrow
            ? (currentIdx + 1) % MODEL_PROVIDERS.length
            : (currentIdx - 1 + MODEL_PROVIDERS.length) % MODEL_PROVIDERS.length
          setModelForm((f) => ({ ...f, provider: MODEL_PROVIDERS[nextIdx]! }))
          return
        }
        if ((key.upArrow || key.downArrow) && modelFocus > 0 && modelFocus < 5) {
          setModelFocus((f) =>
            key.downArrow ? Math.min(5, f + 1) : Math.max(0, f - 1)
          )
          return
        }
        if (key.tab) {
          if (key.shift && modelFocus > 0) {
            setModelFocus((f) => Math.max(0, f - 1))
            return
          }
          if (modelFocus === 0) {
            setModelViewMode("picker")
          } else {
            setModelFocus((f) => (f + 1) % 6)
          }
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
        if (modelFocus >= 0 && modelFocus < 5 && (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f" || inputChar === "\u0008")) {
          const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
          setModelForm((f) => ({ ...f, [k]: f[k].slice(0, -1) }))
          return
        }
        const typedModel = toSingleLineInput(inputText)
        if (modelFocus >= 0 && modelFocus < 5 && typedModel) {
          const k = ["provider", "id", "apiKey", "baseUrl", "temperature"][modelFocus] as "provider" | "id" | "apiKey" | "baseUrl" | "temperature"
          setModelForm((f) => ({ ...f, [k]: f[k] + typedModel }))
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
        if ((key.upArrow || key.downArrow) && embeddingsFocus > 0 && embeddingsFocus < 5) {
          setEmbeddingsFocus((f) =>
            key.downArrow ? Math.min(5, f + 1) : Math.max(0, f - 1)
          )
          return
        }
        if (key.tab) {
          if (key.shift && embeddingsFocus > 0) {
            setEmbeddingsFocus((f) => Math.max(0, f - 1))
            return
          }
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
        if (embeddingsFocus >= 0 && embeddingsFocus < 5 && (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f" || inputChar === "\u0008")) {
          const k = ["provider", "model", "apiKey", "baseUrl", "dimensions"][embeddingsFocus] as "provider" | "model" | "apiKey" | "baseUrl" | "dimensions"
          setEmbeddingsForm((f) => ({ ...f, [k]: (f[k] as string).slice(0, -1) }))
          return
        }
        const typedEmbeddings = toSingleLineInput(inputText)
        if (embeddingsFocus >= 0 && embeddingsFocus < 5 && typedEmbeddings) {
          const k = ["provider", "model", "apiKey", "baseUrl", "dimensions"][embeddingsFocus] as "provider" | "model" | "apiKey" | "baseUrl" | "dimensions"
          setEmbeddingsForm((f) => ({ ...f, [k]: (f[k] as string) + typedEmbeddings }))
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
          const nextVectorState = !vectorIndexEnabled
          setVectorIndexEnabled(nextVectorState)
          saveConfig?.({
            indexing: {
              enabled: indexingEnabled,
              vector: nextVectorState,
            },
          })
          return
        }
        if (inputChar === "4") {
          setView("index")
          return
        }
        if (inputChar === "5") {
          setView("advanced")
          return
        }
        if (inputChar === "6") {
          setView("help")
          return
        }
        if (inputChar === "7") {
          setView("agentConfigs")
          return
        }
        if (isEnter) {
          setView("model")
          return
        }
        return
      }
      if (view === "agentConfigs") {
        if (key.escape) {
          if (agentPresetCreateMode) {
            setAgentPresetCreateMode(false)
          } else {
            setView("chat")
          }
          return
        }
        if (agentPresetCreateMode) {
          if (key.upArrow) {
            setAgentPresetOptionIndex((i) => Math.max(0, i - 1))
            return
          }
          if (key.downArrow) {
            setAgentPresetOptionIndex((i) => Math.min(Math.max(0, agentPresetOptions.length - 1), i + 1))
            return
          }
          if (inputChar === " " || evtName === "space") {
            const option = agentPresetOptions[Math.min(agentPresetOptionIndex, Math.max(0, agentPresetOptions.length - 1))]
            if (option) togglePresetOption(option)
            return
          }
          if (isEnter) {
            savePresetDraft().catch(() => {})
            return
          }
          if (key.backspace || key.delete) {
            setAgentPresetName((name) => name.slice(0, -1))
            return
          }
          const typedPresetName = toSingleLineInput(inputText)
          if (typedPresetName) {
            setAgentPresetName((name) => name + typedPresetName)
            return
          }
          return
        }

        if (key.upArrow) {
          setAgentPresetSelected((i) => (i <= 0 ? Math.max(0, agentPresets.length - 1) : i - 1))
          return
        }
        if (key.downArrow) {
          setAgentPresetSelected((i) => (i >= agentPresets.length - 1 ? 0 : i + 1))
          return
        }
        if (isEnter || lowerChar === "a") {
          applyPreset(selectedPreset)
          return
        }
        if (lowerChar === "c") {
          startPresetCreate()
          return
        }
        if (lowerChar === "d") {
          deletePreset().catch(() => {})
          return
        }
        return
      }
      if (view === "sessions") {
        if (key.upArrow) {
          setSessionListSelected((i) => (i <= 0 ? Math.max(0, sessionList.length - 1) : i - 1))
          return
        }
        if (key.downArrow) {
          setSessionListSelected((i) => (i >= sessionList.length - 1 ? 0 : i + 1))
          return
        }
        if (isEnter && onSwitchSession && sessionList[sessionListSelected]) {
          const id = sessionList[sessionListSelected]!.id
          onSwitchSession(id).then(() => setView("chat")).catch(() => {})
          return
        }
        if (key.escape) {
          setView("chat")
          return
        }
        return
      }
      if (view === "index") {
        if (isEnter && state.indexStatus?.state !== "indexing" && onReindex) {
          onReindex()
        } else if (lowerChar === "s" && state.indexStatus?.state === "indexing" && onIndexStop) {
          onIndexStop()
        } else if (lowerChar === "d" && state.indexStatus?.state !== "indexing" && onIndexDelete) {
          Promise.resolve(onIndexDelete()).then(() => {}).catch(() => {})
        }
        return
      }
      if (view === "advanced") {
        if (key.upArrow && advancedFocus > 0) {
          setAdvancedFocus((f) => Math.max(0, f - 1))
          return
        }
        if (key.downArrow && advancedFocus < 9) {
          setAdvancedFocus((f) => Math.min(9, f + 1))
          return
        }
        if (key.tab) {
          if (key.shift && advancedFocus > 0) {
            setAdvancedFocus((f) => Math.max(0, f - 1))
            return
          }
          setAdvancedFocus((f) => (f + 1) % 10)
          return
        }
        if (advancedFocus === 9 && isEnter && saveConfig) {
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
              debug: { customInstructions: advancedForm.debugInstructions.trim() || undefined },
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
          "debugInstructions",
          "profilesJson",
        ] as const
        if (advancedFocus < 9 && (key.backspace || key.delete || inputChar === "\b" || inputChar === "\x7f")) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k].slice(0, -1) }))
          return
        }
        if (advancedFocus < 9 && isEnter) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k] + "\n" }))
          return
        }
        if (advancedFocus < 9 && inputText) {
          const k = keys[advancedFocus]!
          setAdvancedForm((f) => ({ ...f, [k]: f[k] + inputText }))
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

    // Slash popup: Up/Down to select, Esc to close (Enter via InputRenderable submit).
    if (slashOpen) {
      if (key.upArrow) {
        setSlashSelected((i) => (i <= 0 ? filteredCommands.length - 1 : i - 1))
        return
      }
      if (key.downArrow) {
        setSlashSelected((i) => (i >= filteredCommands.length - 1 ? 0 : i + 1))
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

    if (view === "chat") return
    appendTextToActiveField(inputText)
  }

  const modeColor = MODE_COLORS[state.mode]
  const isHomeView = view === "chat" && state.messages.length === 0
  const shellW = Math.max(48, Math.min(Math.max(48, cols - 2), Math.max(92, Math.floor(cols * 0.82))))
  const shellPad = Math.max(0, Math.floor((cols - shellW) / 2))
  const slashPopupRows = slashOpen ? Math.min(12, Math.max(5, Math.floor(rows * 0.24))) + 3 : 0
  const approvalRows = state.awaitingApproval && state.pendingApprovalAction ? 8 : 0
  const planRows = view === "chat" && state.mode === "plan" && state.planCompleted && !state.isRunning ? 3 : 0
  const reservedRows = 11 + slashPopupRows + approvalRows + planRows
  const chatViewportRows = Math.max(6, rows - reservedRows)
  const indexStatusLabel = (() => {
    if (noIndex) return "Vector index: off"
    const st = state.indexStatus
    if (st?.state === "indexing") {
      const done = typeof st.chunksProcessed === "number" ? st.chunksProcessed : 0
      const total = typeof st.chunksTotal === "number" ? st.chunksTotal : 0
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
      return total > 0
        ? `Vector index: ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)`
        : "Vector index: indexing"
    }
    return state.indexReady ? "Vector index: ready" : "Vector index: building"
  })()
  const topLine = fit(
    `${state.provider}/${state.model} · ${indexStatusLabel} · Context: ${formatTokens(state.contextUsedTokens)}/${formatTokens(state.contextLimitTokens)} (${state.contextPercent}%)${projectDir ? ` · ${projectDir}` : ""}`,
    Math.max(20, cols - 4),
  )

  return (
    <box flexDirection="column" style={{ height: rows, width: cols }}>
      {view === "chat" && !isHomeView && (
        <box flexShrink={0} paddingTop={1} paddingLeft={2} paddingRight={2}>
          <text fg={state.indexReady ? THEME.success : THEME.warning}>{topLine}</text>
        </box>
      )}

      {view !== "chat" ? (
        <box flexDirection="column" flexGrow={1} minHeight={0} flexShrink={1} style={{ overflowY: "hidden", paddingLeft: shellPad, paddingRight: shellPad }}>
          {view === "settings" && (
            <SettingsHubView
              indexingEnabled={!noIndex && indexingEnabled}
              vectorIndexEnabled={vectorIndexEnabled}
            />
          )}
          {view === "model" && (
            modelViewMode === "picker" ? (
              <ModelPickerView
                catalog={modelCatalog}
                loading={modelCatalogLoading}
                options={modelPickerOptions}
                selectedIndex={modelPickerIndex}
                query={modelPickerQuery}
                cols={shellW}
              />
            ) : (
              <ModelConfigView form={modelForm} focus={modelFocus} cols={shellW} />
            )
          )}
          {view === "embeddings" && (
            <EmbeddingsConfigView form={embeddingsForm} focus={embeddingsFocus} cols={shellW} />
          )}
          {view === "advanced" && (
            <AdvancedConfigView form={advancedForm} focus={advancedFocus} />
          )}
          {view === "index" && (
            <IndexManageView
              indexStatus={state.indexStatus}
              onReindex={onReindex}
              onIndexStop={onIndexStop}
              onIndexDelete={onIndexDelete}
              noIndex={noIndex ?? false}
              cols={shellW}
            />
          )}
          {view === "sessions" && (
            <SessionsListView
              sessionList={sessionList}
              sessionListLoading={sessionListLoading}
              sessionListSelected={sessionListSelected}
              currentSessionId={sessionId}
              cols={shellW}
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
              cols={shellW}
            />
          )}
          {view === "agentConfigs" && (
            <AgentConfigView
              presets={agentPresets}
              selectedIndex={agentPresetSelected}
              loading={agentPresetLoading}
              createMode={agentPresetCreateMode}
              presetName={agentPresetName}
              options={agentPresetOptions}
              optionIndex={agentPresetOptionIndex}
              selectedVector={selectedPresetVector}
              selectedSkills={selectedPresetSkills}
              selectedMcp={selectedPresetMcp}
              selectedRules={selectedPresetRules}
            />
          )}
        </box>
      ) : isHomeView ? (
        <HomeLanding
          cols={cols}
          rows={rows}
          shellW={shellW}
          shellPad={shellPad}
          input={input}
          mode={state.mode}
          modeColor={modeColor}
          provider={state.provider}
          model={state.model}
          slashOpen={slashOpen}
          filteredCommands={filteredCommands}
          slashSelected={slashSelected}
          isRunning={state.isRunning}
          awaitingApproval={state.awaitingApproval}
          pendingApprovalAction={state.pendingApprovalAction}
          indexReady={state.indexReady}
          onInputChange={(value) => setInput(value)}
          onSubmit={submitChatInput}
        />
      ) : (
        <box flexDirection="column" flexGrow={1} minHeight={0}>
          <MemoChatViewport
            state={state}
            cols={cols}
            viewportRows={chatViewportRows}
            scrollLines={chatScrollLines}
          />
          {view === "chat" && state.mode === "plan" && state.planCompleted && !state.isRunning && (
            <box flexShrink={0}>
              <PlanActionsBar cols={cols} />
            </box>
          )}
          <box flexShrink={0} paddingLeft={shellPad} paddingRight={shellPad}>
            {slashOpen && filteredCommands.length > 0 && (
            <SlashPopup
              commands={filteredCommands}
              selectedIndex={slashSelected}
              cols={shellW}
              rows={rows}
            />
            )}
            {state.awaitingApproval && state.pendingApprovalAction && (
              <ApprovalBanner action={state.pendingApprovalAction} cols={shellW} />
            )}
            <InputBar
              input={input}
              cols={shellW}
              mode={state.mode}
              modeColor={modeColor}
              isRunning={state.isRunning}
              awaitingApproval={state.awaitingApproval}
              pendingApprovalAction={state.pendingApprovalAction}
              indexReady={state.indexReady}
              provider={state.provider}
              model={state.model}
              onInputChange={(value) => setInput(value)}
              onSubmit={submitChatInput}
            />
          </box>
        </box>
      )}

      {view !== "chat" && (
        <box flexShrink={0} paddingLeft={shellPad} paddingRight={shellPad}>
          <text fg={THEME.primary}>{view === "settings" || view === "help" || view === "index" || view === "sessions" || view === "agentConfigs" ? "Use shortcuts shown above." : "Edit the form above."}</text>
          <text fg={THEME.textMuted}>
            {view === "model"
              ? (modelViewMode === "picker"
                ? "↑↓ select  Enter apply  Tab manual form  Esc back"
                : "Tab model list  ↑↓ provider  Enter save  Esc back")
              : view === "settings"
              ? "1:model 2:emb 3:vector 4:index 5:adv 6:help 7:agent-configs Esc-back"
              : view === "help"
                ? "Esc back"
                : view === "index"
                  ? "Enter Sync  D Delete  S Stop  Esc back"
                  : view === "sessions"
                  ? "↑↓ select  Enter switch  Esc back"
                  : view === "agentConfigs"
                  ? (agentPresetCreateMode
                    ? "Type name  ↑↓ option  Space toggle  Enter save  Esc cancel"
                    : "↑↓ select  Enter/A apply  C create  D delete  Esc back")
                  : "Tab next field, Enter newline/save, Esc back"}
          </text>
        </box>
      )}

      <box flexShrink={0}>
        <Footer
          isRunning={state.isRunning}
          provider={state.provider}
          model={state.model}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          mcpServersCount={mcpServersCount}
          activeProfile={profileOptions[activeProfileIdx] ?? "default"}
          cols={cols}
          contextUsedTokens={state.contextUsedTokens}
          contextLimitTokens={state.contextLimitTokens}
          noIndex={noIndex}
          vectorIndexEnabled={vectorIndexEnabled}
          projectDir={projectDir}
          compact={isHomeView}
        />
      </box>
    </box>
  )
}

// ─── Config views (Model, Embeddings, Settings, Index) ────────────────────────

function SettingsHubView({
  indexingEnabled,
  vectorIndexEnabled,
}: {
  indexingEnabled: boolean
  vectorIndexEnabled: boolean
}) {
  const vectorState = !indexingEnabled ? "disabled" : vectorIndexEnabled ? "enabled" : "disabled"
  const items = [
    "1) Model & LLM",
    "2) Embeddings",
    `3) Vector index: ${vectorState} (toggle)`,
    "4) Index sync & Vector DB",
    "5) Advanced (MCP, skills, rules, mode prompts, profiles)",
    "6) Help",
    "7) Agent configs (/agent-config): select/create presets",
  ]
  return (
    <box flexDirection="column" borderStyle="single" borderColor={THEME.primary} paddingLeft={1} paddingRight={1}>
      <text fg={THEME.primary} bold> Settings Hub</text>
      <text fg={THEME.muted}> Open section by number. Enter opens Model. Esc — back.</text>
      {items.map((item) => (
        <box key={item}>
          <text fg="white"> {item}</text>
        </box>
      ))}
    </box>
  )
}

function ModelPickerView({
  catalog,
  loading,
  options,
  selectedIndex,
  query,
  cols,
}: {
  catalog: ModelsCatalog | null
  loading: boolean
  options: Array<{ providerId: string; modelId: string; name: string; free: boolean; category: string }>
  selectedIndex: number
  query: string
  cols: number
}) {
  const maxName = Math.max(12, cols - 28)
  const rowWidth = Math.max(34, cols - 6)
  const catWidth = Math.min(18, Math.max(10, Math.floor(rowWidth * 0.28)))
  const nameWidth = Math.max(12, rowWidth - 5 - catWidth)
  const windowSize = 12
  const start = Math.max(0, Math.min(Math.max(0, options.length - windowSize), selectedIndex - Math.floor(windowSize / 2)))
  const visible = options.slice(start, start + windowSize)
  return (
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Select model</text>
      <text fg="gray"> From models.dev - free models at top. Tab - manual provider/model.</text>
      {loading && (
        <box><text fg="yellow">Loading catalog...</text></box>
      )}
      {!loading && !catalog && (
        <box><text fg="yellow">Could not load catalog. Use Tab for manual entry.</text></box>
      )}
      {!loading && catalog && (
        <>
          {query ? (
            <box paddingTop={1}><text fg="gray">Search: </text><text fg="white">{query}</text></box>
          ) : null}
          <box flexDirection="column" paddingTop={1}>
            {options.length === 0 ? (
              <text fg="gray">No models match. Clear search or use Tab for manual.</text>
            ) : (
              visible.map((opt, i) => {
                const absolute = start + i
                const selected = absolute === selectedIndex
                const normalized = opt.name.replace(/\s*\(\s*free\s*\)\s*/gi, "").trim()
                const displayName = opt.free ? `${normalized} (free)` : normalized
                const name = padToWidth(fit(displayName, Math.min(nameWidth, maxName)), nameWidth)
                const cat = padToWidth(fit(opt.category, catWidth), catWidth)
                const row = padToWidth(fit(`${selected ? "> " : "  "}${name} - ${cat}`, rowWidth), rowWidth)
                return (
                  <box key={`${opt.providerId}/${opt.modelId}`} width={rowWidth}>
                    <text fg={selected ? "white" : "gray"}>{row}</text>
                  </box>
                )
              })
            )}
          </box>
          {options.length > windowSize && (
            <box paddingTop={1}>
              <text fg="gray">
                {padToWidth(fit(
                  `Showing ${start + 1}-${Math.min(start + windowSize, options.length)} of ${options.length}. Use up/down to scroll.`,
                  rowWidth
                ), rowWidth)}
              </text>
            </box>
          )}
          {options.length > 30 && (
            <box paddingTop={1}>
              <text fg="gray">{padToWidth(fit(`... and ${options.length - 30} more. Type to filter.`, rowWidth), rowWidth)}</text>
            </box>
          )}
        </>
      )}
    </box>
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
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Model — LLM provider & model</text>
      <text fg="gray"> Tab — next field, Enter — save, Esc — back. Provider via ↑↓.</text>
      {labels.map((label, i) => (
        <box key={label}>
          <text fg={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </text>
          <text fg="white">
            {fit(
              keys[i] === "apiKey"
                ? maskSecret((form[keys[i]] as string) || "")
                : ((form[keys[i]] as string) || ""),
              valueWidth
            )}
          </text>
          {focus === i && <text fg="cyan">│</text>}
        </box>
      ))}
      {focus === 0 && (
        <box paddingLeft={2}>
          <text fg="gray"> Provider: {form.provider} (↑↓ to change)</text>
        </box>
      )}
      <box>
        <text fg={focus === 5 ? "cyan" : "gray"}>{focus === 5 ? "▸ " : "  "}</text>
        <text fg={focus === 5 ? "green" : "gray"}>[Save] — press Enter</text>
      </box>
    </box>
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
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Embeddings — model for vector search</text>
      <text fg="gray"> Tab — next field, Enter — save, Esc — back. Provider via ↑↓.</text>
      {labels.map((label, i) => (
        <box key={label}>
          <text fg={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </text>
          <text fg="white">
            {fit(
              keys[i] === "apiKey"
                ? maskSecret((form[keys[i]] as string) || "")
                : ((form[keys[i]] as string) || ""),
              valueWidth
            )}
          </text>
          {focus === i && <text fg="cyan">│</text>}
        </box>
      ))}
      {focus === 0 && (
        <box paddingLeft={2}>
          <text fg="gray"> Provider: {form.provider} (↑↓ to change)</text>
        </box>
      )}
      <box>
        <text fg={focus === 5 ? "cyan" : "gray"}>{focus === 5 ? "▸ " : "  "}</text>
        <text fg={focus === 5 ? "green" : "gray"}>[Save] — press Enter</text>
      </box>
    </box>
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
    debugInstructions: string
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
    "Debug instructions",
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
    "debugInstructions",
    "profilesJson",
  ] as const
  return (
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Advanced — MCP, skills, rules, mode prompts, profiles</text>
      <text fg="gray"> Tab — next field, Enter in field adds newline, Enter on [Save] persists.</text>
      {labels.map((label, i) => (
        <box key={label} flexDirection="column">
          <box>
            <text fg={focus === i ? "cyan" : "gray"}>{focus === i ? "▸ " : "  "}{label}: </text>
          </box>
          <box paddingLeft={2}>
            <text fg="white">{(form[keys[i]] as string).slice(0, 1600)}</text>
            {focus === i && <text fg="cyan">│</text>}
          </box>
        </box>
      ))}
      <box>
        <text fg={focus === 9 ? "cyan" : "gray"}>{focus === 9 ? "▸ " : "  "}</text>
        <text fg={focus === 9 ? "green" : "gray"}>[Save] — press Enter</text>
      </box>
    </box>
  )
}

function SessionsListView({
  sessionList,
  sessionListLoading,
  sessionListSelected,
  currentSessionId,
  cols,
}: {
  sessionList: Array<{ id: string; ts?: number; title?: string; messageCount: number }>
  sessionListLoading: boolean
  sessionListSelected: number
  currentSessionId?: string
  cols: number
}) {
  const width = Math.max(40, cols - 4)
  return (
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Sessions</text>
      <text fg="gray"> ↑↓ select  Enter — switch  Esc — back</text>
      {sessionListLoading ? (
        <box><text fg="yellow"> Loading…</text></box>
      ) : sessionList.length === 0 ? (
        <box><text fg="gray"> No sessions</text></box>
      ) : (
        <box flexDirection="column" marginTop={1}>
          {sessionList.map((s, i) => {
            const title = (s.title || s.id).slice(0, width - 12)
            const isCurrent = s.id === currentSessionId
            const isSelected = i === sessionListSelected
            return (
              <box key={s.id}>
                <text fg={isCurrent ? "green" : isSelected ? "cyan" : "white"}>
                  {isSelected ? "▸ " : "  "}{title}{isCurrent ? " (current)" : ""} — {s.messageCount} msgs
                </text>
              </box>
            )
          })}
        </box>
      )}
    </box>
  )
}

function IndexManageView({
  indexStatus,
  onReindex,
  onIndexStop,
  onIndexDelete,
  noIndex,
  cols,
}: {
  indexStatus: import("@nexuscode/core").IndexStatus | null
  onReindex?: () => void
  onIndexStop?: () => void
  onIndexDelete?: () => void | Promise<void>
  noIndex: boolean
  cols: number
}) {
  if (noIndex) {
    return (
      <box flexDirection="column" borderStyle="single" borderColor="yellow" paddingLeft={1} paddingRight={1}>
        <text fg="yellow" bold> Vector index — disabled</text>
        <text fg="gray"> Indexing is off (--no-index or indexing.enabled: false).</text>
      </box>
    )
  }
  const st = indexStatus ?? { state: "idle" as const }
  const isIndexing = st.state === "indexing"
  const total = typeof st.total === "number" && st.total > 0 ? st.total : 1
  const progress = typeof st.progress === "number" ? st.progress : 0
  const filePct = Math.min(100, Math.round((progress / total) * 100))
  const chunksTotal = typeof st.chunksTotal === "number" && st.chunksTotal > 0 ? st.chunksTotal : 1
  const chunksProcessed = typeof st.chunksProcessed === "number" ? st.chunksProcessed : 0
  const chunkPct = Math.min(100, Math.round((chunksProcessed / chunksTotal) * 100))
  const barWidth = Math.max(10, Math.min(40, cols - 20))
  const filled = Math.round((chunkPct / 100) * barWidth)
  const barFilled = "█".repeat(filled)
  const barEmpty = "░".repeat(barWidth - filled)
  return (
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Index & embeddings — status & control</text>
      <text fg="gray"> Enter — Sync (reindex)  D — Delete index  S — Stop  Esc — back</text>
      {st.state === "idle" && (
        <box><text fg="gray"> Status: </text><text fg="gray">idle</text></box>
      )}
      {isIndexing && (
        <box flexDirection="column" marginTop={1}>
          <text fg="yellow"> Status: indexing</text>
          <text fg="white"> Files: {progress} / {total} — Chunks: {chunksProcessed} / {chunksTotal}</text>
          <box flexDirection="row">
            <text fg="green">{barFilled}</text>
            <text fg="gray">{barEmpty}</text>
            <text fg="white"> {chunkPct}%</text>
          </box>
          <text fg="gray"> S — stop indexing</text>
        </box>
      )}
      {st.state === "ready" && (
        <box flexDirection="column">
          <text fg="green"> Status: ready</text>
          <text fg="gray"> Files: {st.files}, symbols: {st.symbols}{typeof st.chunks === "number" ? `, chunks: ${st.chunks}` : ""}</text>
        </box>
      )}
      {st.state === "error" && (
        <box><text fg="red"> Error: {st.error}</text></box>
      )}
      <box marginTop={1} flexDirection="row">
        <text fg="cyan"> [Sync] — Enter</text>
        <text fg="gray"> </text>
        <text fg="cyan"> [Delete] — D</text>
      </box>
    </box>
  )
}

function AgentConfigView({
  presets,
  selectedIndex,
  loading,
  createMode,
  presetName,
  options,
  optionIndex,
  selectedVector,
  selectedSkills,
  selectedMcp,
  selectedRules,
}: {
  presets: AgentPreset[]
  selectedIndex: number
  loading: boolean
  createMode: boolean
  presetName: string
  options: Array<{ kind: "vector" | "skill" | "mcp" | "rule"; value: string; label: string }>
  optionIndex: number
  selectedVector: boolean
  selectedSkills: string[]
  selectedMcp: string[]
  selectedRules: string[]
}) {
  if (createMode) {
    const safeOptionIndex = Math.min(optionIndex, Math.max(0, options.length - 1))
    return (
      <box flexDirection="column" borderStyle="single" borderColor={THEME.primary} paddingLeft={1} paddingRight={1}>
        <text fg={THEME.primary} bold> Agent config — create preset</text>
        <text fg="gray"> Build from skills, MCP and AGENTS.md/CLAUDE.md rules</text>
        <box marginTop={1}>
          <text fg="gray">Name: </text>
          <text fg="white">{presetName || "preset-name"}</text>
          <text fg={THEME.primary}>│</text>
        </box>
        <box marginTop={1} flexDirection="column">
          {options.map((option, idx) => {
            const active =
              option.kind === "vector"
                ? selectedVector
                : option.kind === "skill"
                ? selectedSkills.includes(option.value)
                : option.kind === "mcp"
                ? selectedMcp.includes(option.value)
                : selectedRules.includes(option.value)
            return (
              <box key={`${option.kind}:${option.value}`}>
                <text fg={idx === safeOptionIndex ? THEME.primary : "gray"}>
                  {idx === safeOptionIndex ? "▸ " : "  "}
                </text>
                <text fg={active ? "green" : "gray"}>{active ? "[x] " : "[ ] "}</text>
                <text fg={active ? "white" : "gray"}>{option.label}</text>
              </box>
            )
          })}
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="column" borderStyle="single" borderColor={THEME.primary} paddingLeft={1} paddingRight={1}>
      <text fg={THEME.primary} bold> Agent configs</text>
      <text fg="gray"> Presets compose model + vector + skills + MCP + AGENTS rules</text>
      {loading ? (
        <box marginTop={1}>
          <text fg={THEME.warning}>Loading…</text>
        </box>
      ) : presets.length === 0 ? (
        <box marginTop={1}>
          <text fg="gray">No presets yet. Press C to create one.</text>
        </box>
      ) : (
        <box marginTop={1} flexDirection="column">
          {presets.map((preset, idx) => {
            const selected = idx === selectedIndex
            const summary = [
              `${preset.modelProvider ?? "model?"}/${preset.modelId ?? "id?"}`,
              `vector:${preset.vector ? "on" : "off"}`,
              `skills:${preset.skills.length}`,
              `mcp:${preset.mcpServers.length}`,
              `rules:${preset.rulesFiles.length}`,
            ].join(" · ")
            return (
              <box key={preset.name} flexDirection="column">
                <box>
                  <text fg={selected ? THEME.primary : "gray"}>{selected ? "▸ " : "  "}</text>
                  <text fg={selected ? "white" : "gray"} bold={selected}>{preset.name}</text>
                </box>
                <box paddingLeft={2}>
                  <text fg="gray">{summary}</text>
                </box>
              </box>
            )
          })}
        </box>
      )}
    </box>
  )
}

// ─── Home + prompt shell ────────────────────────────────────────────────────

function HomeLanding({
  cols,
  rows,
  shellW,
  shellPad,
  input,
  mode,
  modeColor,
  provider,
  model,
  slashOpen,
  filteredCommands,
  slashSelected,
  isRunning,
  awaitingApproval,
  pendingApprovalAction,
  indexReady,
  onInputChange,
  onSubmit,
}: {
  cols: number
  rows: number
  shellW: number
  shellPad: number
  input: string
  mode: Mode
  modeColor: string
  provider: string
  model: string
  slashOpen: boolean
  filteredCommands: typeof SLASH_COMMANDS
  slashSelected: number
  isRunning: boolean
  awaitingApproval: boolean
  pendingApprovalAction: ApprovalAction | null
  indexReady: boolean
  onInputChange: (value: string) => void
  onSubmit: (value?: string) => void
}) {
  const tips = [
    "Press Tab to cycle between Agent, Plan, Ask and Debug modes.",
    "Use /index to control vector index sync, stop and delete.",
    "Use /agent-config to assemble presets from skills, MCP and AGENTS.md.",
  ]
  const tip = tips[(provider.length + model.length) % tips.length]!
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
      <box flexGrow={1} />
      <Logo cols={cols} />
      <box height={1} />
      <box paddingLeft={shellPad} paddingRight={shellPad} flexDirection="column">
        {slashOpen && filteredCommands.length > 0 && (
              <SlashPopup
                commands={filteredCommands}
                selectedIndex={slashSelected}
                cols={shellW}
                rows={rows}
              />
        )}
        {awaitingApproval && pendingApprovalAction && (
          <ApprovalBanner action={pendingApprovalAction} cols={shellW} />
        )}
        <InputBar
          input={input}
          cols={shellW}
          mode={mode}
          modeColor={modeColor}
          isRunning={isRunning}
          awaitingApproval={awaitingApproval}
          pendingApprovalAction={pendingApprovalAction}
          indexReady={indexReady}
          provider={provider}
          model={model}
          showPlaceholder
          onInputChange={onInputChange}
          onSubmit={onSubmit}
        />
      </box>
      <box height={2} />
      <box justifyContent="center">
        <text fg={THEME.warning}>● Tip </text>
        <text fg={THEME.textMuted}>{fit(tip, Math.max(24, cols - 20))}</text>
      </box>
      <box flexGrow={1} />
    </box>
  )
}

// ─── Slash command popup ────────────────────────────────────────────────────

function SlashPopup({
  commands,
  selectedIndex,
  cols,
  rows,
}: {
  commands: typeof SLASH_COMMANDS
  selectedIndex: number
  cols: number
  rows: number
}) {
  const lineWidth = Math.max(40, cols - 6)
  const labelWidth = Math.min(36, Math.max(14, Math.floor(lineWidth * 0.34)))
  const descWidth = Math.max(16, lineWidth - labelWidth - 5)
  const rowWidth = lineWidth
  // Keep command palette compact and fully visible above input.
  const maxVisibleByHeight = Math.max(5, Math.min(12, Math.floor(rows * 0.24)))
  const windowSize = Math.min(maxVisibleByHeight, Math.max(1, commands.length))
  const start = Math.max(0, Math.min(Math.max(0, commands.length - windowSize), selectedIndex - Math.floor(windowSize / 2)))
  const visible = commands.slice(start, start + windowSize)
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      borderStyle="single"
      borderColor={THEME.accent}
      paddingLeft={1}
      paddingRight={1}
      style={{ backgroundColor: THEME.panel }}
    >
      <text fg={THEME.textMuted}>Commands - ↑↓ choose, Enter select, Esc close</text>
      <box flexDirection="column" style={{ maxHeight: windowSize + 1, overflowY: "hidden" }}>
        {visible.map((cmd, i) => {
          const absolute = start + i
          const active = absolute === selectedIndex
          const label = padToWidth(fit(cmd.label, labelWidth), labelWidth)
          const desc = fit(cmd.desc, descWidth)
          return (
            <box key={cmd.cmd} width={rowWidth} flexDirection="row" style={{ backgroundColor: active ? "#e6b188" : undefined }}>
              <text fg={active ? "#000000" : THEME.textMuted} bold={active}>{active ? "> " : "  "}</text>
              <text fg={active ? "#000000" : "white"} bold={active}>{label}</text>
              <text fg={active ? "#000000" : THEME.textMuted}> </text>
              <text fg={active ? "#000000" : THEME.textMuted}>{desc}</text>
            </box>
          )
        })}
      </box>
      {commands.length > windowSize && (
        <text fg={THEME.textMuted}>
          Showing {start + 1}-{Math.min(start + windowSize, commands.length)} of {commands.length}
        </text>
      )}
    </box>
  )
}

// ─── Input bar ──────────────────────────────────────────────────────────────

function ApprovalBanner({ action, cols }: { action: ApprovalAction; cols: number }) {
  const width = Math.max(20, cols - 4)
  const lines: string[] = []
  if (action.type === "write") {
    lines.push("✏ File write")
    lines.push(`  ${action.description}`)
    if (action.content) {
      const preview = action.content.split("\n").slice(0, 12).join("\n")
      lines.push("  Content preview:")
      for (const line of preview.split("\n")) {
        lines.push("    " + (line.length > width - 6 ? line.slice(0, width - 7) + "…" : line))
      }
    }
    if (action.diff) {
      const diffPreview = action.diff.split("\n").slice(0, 8).join("\n")
      lines.push("  Diff preview:")
      for (const line of diffPreview.split("\n")) {
        lines.push("    " + (line.length > width - 6 ? line.slice(0, width - 7) + "…" : line))
      }
    }
  } else if (action.type === "execute") {
    const cmd = action.content || action.description.replace(/^Run:\s*/i, "")
    lines.push("⌨️  Bash")
    lines.push(`  ${cmd}`)
  } else if (action.type === "mcp") {
    lines.push("🔌 MCP tool call")
    lines.push(`  ${action.description}`)
  } else if (action.type === "doom_loop") {
    lines.push("⚠ Potential infinite loop")
    lines.push(`  ${action.description}`)
  } else {
    lines.push(`Allow: ${action.tool}`)
    lines.push(`  ${action.description}`)
  }
  return (
    <box borderStyle="single" borderColor="yellow" paddingLeft={1} paddingRight={1} marginBottom={0}>
      {lines.map((line, i) => (
        <text key={i} fg={i === 0 ? "yellow" : "white"} bold={i === 0}>
          {line}
        </text>
      ))}
    </box>
  )
}

function InputBar({
  input,
  cols,
  mode,
  modeColor,
  isRunning,
  awaitingApproval,
  pendingApprovalAction,
  indexReady,
  provider,
  model,
  showPlaceholder = false,
  onInputChange,
  onSubmit,
}: {
  input: string
  cols: number
  mode: Mode
  modeColor: string
  isRunning: boolean
  awaitingApproval: boolean
  pendingApprovalAction: ApprovalAction | null
  indexReady: boolean
  provider: string
  model: string
  showPlaceholder?: boolean
  onInputChange: (value: string) => void
  onSubmit: (value?: string) => void
}) {
  const borderColor = awaitingApproval ? THEME.warning : isRunning ? THEME.danger : THEME.accent
  const approvalPrompt =
    pendingApprovalAction?.type === "execute"
      ? "Allow? y/n a/s e(allow for folder)"
      : "Allow? y/n a/s"
  const prompt = awaitingApproval
    ? approvalPrompt
    : isRunning
      ? "[Abort: Ctrl+C]"
      : mode === "agent" ? "Agent" : mode === "plan" ? "Plan" : mode === "debug" ? "Debug" : "Ask"
  const promptColor = awaitingApproval ? THEME.warning : isRunning ? THEME.danger : modeColor
  const placeholder = showPlaceholder
    ? 'Ask anything... "Fix a TODO in the codebase"'
    : ""
  const metaWidth = Math.max(16, cols - prompt.length - 8)
  const providerWidth = Math.max(8, Math.min(16, Math.floor(metaWidth * 0.3)))
  const modelWidth = Math.max(8, metaWidth - providerWidth - 2)
  const modelLabel = fit(model, modelWidth)
  const providerLabel = fit(provider, providerWidth)

  return (
    <box flexDirection="column" marginBottom={0}>
      <box
        flexDirection="row"
        border={["left"]}
        borderColor={borderColor}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
        style={{ backgroundColor: THEME.panel2 }}
      >
        <input
          focused
          value={input}
          maxLength={6000}
          placeholder={placeholder}
          onInput={(value: string) => onInputChange(value)}
          onSubmit={(value: string) => onSubmit(value)}
          textColor={THEME.text}
          focusedTextColor={THEME.text}
          placeholderColor={THEME.textMuted}
          backgroundColor={THEME.panel2}
          focusedBackgroundColor={THEME.panel2}
          cursorColor={THEME.primary}
          style={{ flexGrow: 1, height: 1, minHeight: 1, maxHeight: 1 }}
        />
      </box>
      <box
        flexDirection="row"
        border={["left"]}
        borderColor={borderColor}
        paddingLeft={1}
        paddingRight={1}
        style={{ backgroundColor: THEME.panel2 }}
      >
        <text fg={promptColor} bold>{prompt}</text>
        <text fg={THEME.text}> </text>
        <text fg={THEME.text}>{modelLabel}</text>
        <text fg={THEME.textMuted}> {providerLabel}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={2} paddingTop={1}>
        <text fg={THEME.text}>
          tab <span style={{ fg: THEME.textMuted }}>agents</span>
        </text>
        <text fg={THEME.text}>
          ctrl+p <span style={{ fg: THEME.textMuted }}>commands</span>
        </text>
        <text fg={indexReady ? THEME.success : THEME.textMuted}>
          {indexReady ? "index ready" : "index building"}
        </text>
      </box>
    </box>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function MessageItem({ msg, cols }: { msg: SessionMessage; cols: number }) {
  const content = typeof msg.content === "string" ? msg.content : "[complex message]"

  if (msg.role === "user") {
    return (
      <box paddingLeft={1} paddingRight={1} paddingTop={1} flexDirection="column">
        <box>
          <text bold fg="cyan">
            ▶ You
          </text>
          <text fg="gray"> ─────────────────────────────────</text>
        </box>
        <box paddingLeft={2}>
          <text wrap="wrap" fg="white">
            {content}
          </text>
        </box>
      </box>
    )
  }

  if (msg.role === "assistant") {
    const trimmed =
      content.length > 3000
        ? content.slice(0, 1500) + "\n\n[...]\n\n" + content.slice(-800)
        : content
    return (
      <box paddingLeft={1} paddingRight={1} paddingTop={1} flexDirection="column">
        <box>
          <text bold fg="green">
            ◀ NexusCode
          </text>
          <text fg="gray"> ──────────────────────────────</text>
        </box>
        <box paddingLeft={2}>
          <text wrap="wrap">{trimmed}</text>
        </box>
      </box>
    )
  }

  if (msg.summary) {
    return (
      <box paddingLeft={1} paddingRight={1} marginBottom={0} borderStyle="round" borderColor="gray">
        <text fg="gray" bold>
          📝 Context summary
        </text>
        <text fg="gray"> (compacted)</text>
      </box>
    )
  }

  if (msg.role === "system") {
    return (
      <box paddingLeft={1} paddingRight={1}>
        <text fg="red">
          ⚠ {content}
        </text>
      </box>
    )
  }

  return null
}

function ReasoningBlock({ text, cols }: { text: string; cols: number }) {
  const lines = text.split("\n")
  const preview = lines.slice(-5).join("\n")
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0} flexDirection="column">
      <text fg="magenta">
        💭 Thinking...
      </text>
      <box paddingLeft={2} borderStyle="single" borderColor="magenta">
        <text fg="magenta" wrap="wrap">
          {preview.length > 400 ? "..." + preview.slice(-400) : preview}
        </text>
      </box>
    </box>
  )
}

function StreamingText({ text, cols }: { text: string; cols: number }) {
  const maxLen = (cols - 4) * 15
  const display = text.length > maxLen ? text.slice(-maxLen) : text
  return (
    <box paddingLeft={3} paddingRight={1} flexDirection="column">
      <text wrap="wrap" fg="white">
        {display}
      </text>
    </box>
  )
}

function LiveToolCard({ tool }: { tool: LiveTool }) {
  const icon = TOOL_ICONS[tool.tool] ?? "🔧"
  const displayName = toolDisplayName(tool.tool)
  const elapsed = tool.timeStart ? `${((Date.now() - tool.timeStart) / 1000).toFixed(1)}s` : ""
  let preview = ""
  if (tool.input) {
    const path = tool.input["path"] ?? tool.input["command"] ?? tool.input["query"] ?? tool.input["url"]
    if (path) preview = String(path).slice(0, 50)
  }

  return (
    <box paddingLeft={2} paddingRight={1}>
      <text fg="yellow">
        <spinner name="arc" />
      </text>
      <text fg="yellow">
        {" "}
        {icon} {displayName}
      </text>
      {preview && (
        <text fg="gray"> — {preview}</text>
      )}
      {elapsed && (
        <text fg="gray">
          {" "}
          ({elapsed})
        </text>
      )}
    </box>
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
    <box flexDirection="column" borderStyle="round" borderColor={statusColor} paddingLeft={1} paddingRight={1} marginBottom={1}>
      <box>
        <text fg={statusColor} bold>Sub-agent </text>
        <text fg="white">{title}</text>
        <text fg="gray"> · {elapsed}s</text>
      </box>
      <box>
        <text fg="gray">Task: </text>
        <text fg="white">{task}</text>
      </box>
      {agent.currentTool && (
        <box>
          <text fg="gray">Tool: </text>
          <text fg="yellow">{agent.currentTool}</text>
        </box>
      )}
      {agent.error && (
        <box>
          <text fg="red">Error: {agent.error.slice(0, 120)}</text>
        </box>
      )}
    </box>
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
    <box paddingLeft={1} paddingRight={1} borderStyle="single" borderColor="gray" flexDirection="row">
      <text fg="gray">Plan </text>
      <text fg="cyan">
        [{completed}/{total}]
      </text>
      <text fg="gray"> {pct}% </text>
      <text fg="gray">
        {summary.length > cols - 24 ? summary.slice(0, cols - 27) + "…" : summary}
      </text>
    </box>
  )
}

function PlanActionsBar({ cols }: { cols: number }) {
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0} borderStyle="single" borderColor="yellow" flexDirection="column">
      <text fg="yellow" bold>
        Plan ready. Choose:
      </text>
      <box>
        <text fg="cyan"> [A]</text>
        <text fg="gray"> Approve — run in agent mode and execute the plan</text>
      </box>
      <box>
        <text fg="cyan"> [R]</text>
        <text fg="gray"> Revise — type your message and press Enter to update the plan</text>
      </box>
      <box>
        <text fg="cyan"> [D]</text>
        <text fg="gray"> Abandon — switch to Ask mode</text>
      </box>
    </box>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0} borderStyle="single" borderColor="red">
      <text fg="red" bold>
        ✗ Error:{" "}
      </text>
      <text fg="red" wrap="wrap">
        {message.slice(0, 200)}
      </text>
    </box>
  )
}

function SessionSidebar({
  provider,
  model,
  sessionTitle,
  contextUsedTokens,
  contextLimitTokens,
  contextPercent,
  mcpServersCount,
  noIndex,
  indexReady,
  vectorIndexEnabled,
  todo,
}: {
  provider: string
  model: string
  sessionTitle?: string
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  mcpServersCount?: number
  noIndex: boolean
  indexReady: boolean
  vectorIndexEnabled: boolean
  todo: string
}) {
  const indexState = noIndex ? "off" : indexReady ? "ready" : "building"
  const vectorState = noIndex ? "off" : vectorIndexEnabled ? "on" : "off"
  const todos = parseTodoItems(todo).slice(0, 6)
  const activeTodos = todos.filter((item) => !item.done).length
  const doneTodos = todos.filter((item) => item.done).length

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={THEME.primary}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      flexGrow={1}
      minHeight={0}
    >
      <text fg={THEME.primary} bold> Session</text>
      <text fg="white">{fit(sessionTitle || "Untitled session", 30)}</text>
      <box paddingTop={1} flexDirection="column">
        <text fg={THEME.accent}> Model</text>
        <text fg={THEME.muted}>{fit(`${provider}/${model}`, 30)}</text>
      </box>
      <box paddingTop={1} flexDirection="column">
        <text fg={THEME.accent}> Context</text>
        <text fg={THEME.muted}>
          {formatTokens(contextUsedTokens)} / {formatTokens(contextLimitTokens)} ({contextPercent}%)
        </text>
      </box>
      <box paddingTop={1} flexDirection="column">
        <text fg={THEME.accent}> Runtime</text>
        <text fg={THEME.muted}>MCP: {mcpServersCount ?? 0}</text>
        <text fg={indexState === "ready" ? THEME.success : indexState === "off" ? THEME.muted : THEME.warning}>
          Index: {indexState}
        </text>
        <text fg={vectorState === "on" ? THEME.success : THEME.muted}>Vector index: {vectorState}</text>
      </box>
      <box paddingTop={1} flexDirection="column">
        <text fg={THEME.accent}> Todo</text>
        {todos.length === 0 ? (
          <text fg={THEME.muted}>No tasks</text>
        ) : (
          <>
            <text fg={THEME.muted}>Active: {activeTodos} · Done: {doneTodos}</text>
            {todos.map((item, idx) => (
              <text key={`${idx}-${item.text}`} fg={item.done ? THEME.muted : "white"}>
                {item.done ? "✓" : "•"} {fit(item.text, 28)}
              </text>
            ))}
          </>
        )}
      </box>
    </box>
  )
}

function Footer({
  isRunning,
  provider,
  model,
  sessionId,
  sessionTitle,
  mcpServersCount,
  activeProfile,
  cols,
  contextUsedTokens,
  contextLimitTokens,
  noIndex,
  vectorIndexEnabled,
  projectDir,
  compact,
}: {
  isRunning: boolean
  provider: string
  model: string
  sessionId?: string
  sessionTitle?: string
  mcpServersCount?: number
  activeProfile: string
  cols: number
  contextUsedTokens: number
  contextLimitTokens: number
  noIndex: boolean
  vectorIndexEnabled: boolean
  projectDir?: string
  compact?: boolean
}) {
  const shortSession = sessionId ? fit(sessionId, compact ? 10 : 14) : fit(sessionTitle ?? "untitled", compact ? 10 : 14)
  const vector = noIndex ? "off" : vectorIndexEnabled ? "on" : "off"
  const mcpPart = (mcpServersCount ?? 0) > 0 ? ` MCP:${mcpServersCount}` : " MCP:0"
  const lineCols = Math.max(20, cols - 4)
  const left = fit(projectDir ? shortenPath(projectDir, Math.max(18, Math.floor((compact ? 0.55 : 0.38) * lineCols))) : "~", Math.max(12, Math.floor((compact ? 0.55 : 0.38) * lineCols)))
  const maxW = Math.max(20, lineCols)
  const leftWidth = stringWidth(left)
  const rightBudget = Math.max(12, maxW - leftWidth - 3)
  const right = compact
    ? fit(`${CLI_VERSION}`, rightBudget)
    : fit(
        `profile:${activeProfile} · session:${shortSession}${mcpPart} · vector:${vector} · Ctrl+C:${isRunning ? "abort" : "quit"}`,
        rightBudget,
      )
  const rightWidth = stringWidth(right)
  const fill = Math.max(1, lineCols - leftWidth - rightWidth)
  return (
    <box
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={compact ? 0 : 1}
      paddingBottom={compact ? 0 : 1}
      style={{ backgroundColor: compact ? undefined : THEME.panel }}
      flexDirection="row"
    >
      <text fg={THEME.textMuted}>{left}</text>
      <text fg={THEME.textMuted}>{" ".repeat(fill)}</text>
      <text fg={THEME.textMuted}>{right}</text>
    </box>
  )
}

type ChatLine = { text: string; color?: "white" | "gray" | "cyan" | "green" | "yellow" | "red" | "magenta" | "blue"; bold?: boolean }

function ChatViewport({
  state,
  cols,
  viewportRows,
  scrollLines,
}: {
  state: AppState
  cols: number
  viewportRows: number
  scrollLines: number
}) {
  const width = Math.max(20, cols - 4)
  const allLines = useMemo(() => buildChatLines(state, width), [state, width])
  const visibleHeight = Math.max(8, viewportRows)
  const maxScroll = Math.max(0, allLines.length - visibleHeight)
  const safeScroll = Math.max(0, Math.min(scrollLines, maxScroll))
  const start = Math.max(0, allLines.length - visibleHeight - safeScroll)
  const lines = allLines.slice(start, start + visibleHeight)

  return (
    <box flexDirection="column" flexGrow={1} minHeight={visibleHeight} overflowY="hidden" paddingLeft={1} paddingRight={1}>
      {safeScroll > 0 && (
        <text fg="gray">↑ Scroll: wheel / ↑↓ / PgUp/Dn · Ctrl+G or End = latest</text>
      )}
      {safeScroll > 0 && state.isRunning && (
        <text fg="cyan">↓ New content — Ctrl+G or End to jump to latest</text>
      )}
      {lines.map((line, idx) => (
        <text key={`${idx}_${line.text.slice(0, 20)}`} fg={line.color ?? "white"} bold={line.bold}>
          {line.text}
        </text>
      ))}
      {lines.length === 0 && <text fg="gray">No messages yet.</text>}
    </box>
  )
}

const MemoChatViewport = React.memo(
  ChatViewport,
  (prev, next) =>
    prev.state === next.state &&
    prev.cols === next.cols &&
    prev.viewportRows === next.viewportRows &&
    prev.scrollLines === next.scrollLines,
)

function formatToolPreview(tool: LiveTool): string {
  const pathVal = tool.input?.["path"]
  const pathStr = pathVal != null ? String(pathVal) : ""
  let startLine = tool.input?.["start_line"]
  let endLine = tool.input?.["end_line"]
  const pattern = tool.input?.["pattern"]
  const patterns = tool.input?.["patterns"]
  const pathsArr = tool.input?.["paths"]
  const command = tool.input?.["command"]
  const query = tool.input?.["query"]
  const url = tool.input?.["url"]
  const parts: string[] = []

  if (tool.tool === "read_file" && pathStr) {
    const base = pathStr.split("/").pop() ?? pathStr
    const short = base.length > 36 ? base.slice(0, 33) + "…" : base
    parts.push(short)
    const out = tool.output ?? ""
    const fileContentMatch = out.match(/<file_content\s+path="[^"]+"\s+lines="([^"]+)"\s+total="([^"]+)">/)
    if (fileContentMatch) {
      const [, linesAttr, total] = fileContentMatch
      if (linesAttr && total) {
        const totalNum = parseInt(total, 10)
        const isFull = linesAttr === `1-${totalNum}` || linesAttr === `1-${total}`
        if (!isFull) parts.push(`L${linesAttr}`)
      }
    }
    if (parts.length === 1 && typeof startLine === "number" && typeof endLine === "number") parts.push(`L${startLine}-${endLine}`)
    else if (parts.length === 1 && typeof startLine === "number") parts.push(`L${startLine}`)
  } else if (tool.tool === "list_files") {
    const dir = pathStr || "."
    const short = dir.length > 36 ? dir.slice(0, 33) + "…" : dir
    parts.push(`folder ${short}`)
  } else if (tool.tool === "execute_command" && command && typeof command === "string") {
    parts.push((command.length > 48 ? command.slice(0, 45) + "…" : command).replace(/\s+/g, " "))
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
  } else if (tool.tool === "exa_web_search" || tool.tool === "exa_code_search") {
    const q = tool.input?.["query"]
    if (q && typeof q === "string") parts.push((q.length > 40 ? q.slice(0, 37) + "…" : q).replace(/\s+/g, " "))
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
  if (tool.tool !== "execute_command" && command && typeof command === "string") parts.push((command.length > 32 ? command.slice(0, 29) + "…" : command).replace(/\s+/g, " "))
  if (query && typeof query === "string" && !["exa_web_search", "exa_code_search"].includes(tool.tool)) parts.push((query.length > 28 ? query.slice(0, 25) + "…" : query).replace(/\s+/g, " "))
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
  const messages = state.messages
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIdx = i
      break
    }
  }

  function pushRunProgress() {
    if (state.isRunning && state.currentAssistantParts.length > 0) {
      out.push({ text: "NexusCode", color: "green", bold: true })
      const wrapW = Math.max(10, width - 2)
      const parts = state.currentAssistantParts
      let i = 0
      while (i < parts.length) {
        const part = parts[i]!
        if (part.type === "text") {
          const t = cleanAssistantText(sanitizeText((part as { text: string }).text))
          if (t.trim()) for (const line of wrapToWidth(t, wrapW)) out.push({ text: `  ${line}`, color: "white" })
          i++
        } else if (part.type === "tool") {
          const tp = part as { tool: string; status: string; input?: Record<string, unknown> }
          if (tp.tool === "thinking_preamble") {
            const userMsg = (tp.input?.user_message as string)?.trim()
            const reasoning = (tp.input?.reasoning_and_next_actions as string)?.trim()
            const show = userMsg || reasoning
            if (show) for (const line of wrapToWidth(sanitizeText(userMsg || reasoning.slice(0, 200)), wrapW)) out.push({ text: `  — ${line}`, color: "gray" })
            else out.push({ text: `  [${tp.status}] ${toolDisplayName(tp.tool)}`, color: "gray" })
            i++
          } else {
            const toolGroups: { tool: string; status: string; count: number; preview: string }[] = []
            while (i < parts.length && (parts[i] as { type: string }).type === "tool") {
              const t = parts[i] as { tool: string; status: string; input?: Record<string, unknown> }
              if (t.tool === "thinking_preamble") break
              const last = toolGroups[toolGroups.length - 1]
              const preview = formatToolPreview({ id: "", tool: t.tool, status: t.status as "running" | "completed" | "error", input: t.input, timeStart: 0 })
              if (last && last.tool === t.tool && last.status === t.status) {
                last.count += 1
                if (preview && !last.preview) last.preview = preview
              } else {
                toolGroups.push({ tool: t.tool, status: t.status, count: 1, preview })
              }
              i++
            }
            for (const g of toolGroups) {
              const icon = TOOL_ICONS[g.tool] ?? "🔧"
              const status = g.status === "completed" ? "ok" : g.status === "error" ? "err" : "…"
              const label = g.count > 1 ? `${g.count}× ${toolDisplayName(g.tool)}` : toolDisplayName(g.tool)
              const line = g.preview ? `  [${status}] ${icon} ${label} — ${g.preview}` : `  [${status}] ${icon} ${label}`
              for (const l of wrapToWidth(line, width)) out.push({ text: l, color: "gray" })
            }
          }
        } else if (part.type === "reasoning" && state.showThinking) {
          const r = sanitizeText((part as { text: string }).text)
          if (r.trim()) {
            out.push({ text: "  Thinking…", color: "magenta" })
            for (const line of wrapToWidth(r.slice(-400), wrapW)) out.push({ text: `  ${line}`, color: "magenta" })
          }
          i++
        } else {
          i++
        }
      }
      out.push({ text: "", color: "gray" })
    }
    // Omit standalone "Tools" block — tools are already shown above from currentAssistantParts (with icons). Avoids duplication.
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
    if (state.todo.trim()) {
      out.push({ text: "Plan", color: "yellow", bold: true })
      const runningTool = state.liveTools.find((t) => t.status === "running")
      if (state.isRunning && runningTool) {
        const preview = formatToolPreview(runningTool)
        const line = preview
          ? `  ▶ Working on: ${toolDisplayName(runningTool.tool)} — ${preview}`
          : `  ▶ Working on: ${toolDisplayName(runningTool.tool)}`
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
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const raw = sanitizeText(typeof msg.content === "string" ? msg.content : "[complex message]")
    const content = msg.role === "assistant" ? cleanAssistantText(raw) : raw
    if (msg.role === "user") {
      out.push({ text: "You", color: "cyan", bold: true })
      for (const line of wrapToWidth(content, Math.max(10, width - 2))) out.push({ text: `  ${line}`, color: "white" })
      out.push({ text: "", color: "gray" })
      if (i === lastUserIdx) pushRunProgress()
      continue
    }
    if (msg.role === "assistant") {
      out.push({ text: "NexusCode", color: "green", bold: true })
      const wrapW = Math.max(10, width - 2)
      const isLastMessageAndRunning = i === messages.length - 1 && state.isRunning
      if (Array.isArray(msg.content)) {
        const contentParts = msg.content as MessagePart[]
        let idx = 0
        while (idx < contentParts.length) {
          const part = contentParts[idx]!
          if (part.type === "text") {
            const t = cleanAssistantText(sanitizeText((part as { text: string }).text))
            if (t.trim()) for (const line of wrapToWidth(t, wrapW)) out.push({ text: `  ${line}`, color: "white" })
            idx++
          } else if (part.type === "tool") {
            const tp = part as { tool: string; status: string; input?: Record<string, unknown>; output?: string }
            if (tp.tool === "thinking_preamble") {
              const userMsg = (tp.input?.user_message as string)?.trim()
              const reasoning = (tp.input?.reasoning_and_next_actions as string)?.trim()
              const show = userMsg || reasoning
              if (show) {
                for (const line of wrapToWidth(sanitizeText(userMsg || reasoning.slice(0, 200)), wrapW)) out.push({ text: `  — ${line}`, color: "gray" })
              } else {
                out.push({ text: `  [${tp.status}] ${toolDisplayName(tp.tool)}`, color: "gray" })
              }
              idx++
            } else {
              const toolGroups: { tool: string; status: string; count: number; preview: string; output?: string }[] = []
              while (idx < contentParts.length && (contentParts[idx] as { type: string }).type === "tool") {
                const t = contentParts[idx] as { tool: string; status: string; input?: Record<string, unknown>; output?: string }
                if (t.tool === "thinking_preamble") break
                const preview = formatToolPreview({
                  id: "",
                  tool: t.tool,
                  status: t.status as "running" | "completed" | "error",
                  input: t.input,
                  output: t.output,
                  timeStart: 0,
                })
                const last = toolGroups[toolGroups.length - 1]
                if (last && last.tool === t.tool && last.status === t.status) {
                  last.count += 1
                  if (preview && !last.preview) last.preview = preview
                  if (t.output && !last.output) last.output = t.output
                } else {
                  toolGroups.push({ tool: t.tool, status: t.status, count: 1, preview, output: t.output })
                }
                idx++
              }
              if (!isLastMessageAndRunning) {
                for (const g of toolGroups) {
                  const icon = TOOL_ICONS[g.tool] ?? "🔧"
                  const status = g.status === "completed" ? "ok" : g.status === "error" ? "err" : "…"
                  const label = g.count > 1 ? `${g.count}× ${toolDisplayName(g.tool)}` : toolDisplayName(g.tool)
                  const line = g.preview ? `  [${status}] ${icon} ${label} — ${g.preview}` : `  [${status}] ${icon} ${label}`
                  for (const l of wrapToWidth(line, width)) out.push({ text: l, color: g.status === "error" ? "red" : "gray" })
                }
                const lastTool = toolGroups[toolGroups.length - 1]
                if (lastTool?.tool === "attempt_completion" && lastTool.status === "completed" && lastTool.output?.trim()) {
                  const answer = sanitizeText(lastTool.output).trim()
                  if (answer.length > 0) {
                    out.push({ text: "  —", color: "gray" })
                    for (const line of wrapToWidth(answer, wrapW)) out.push({ text: `  ${line}`, color: "white" })
                  }
                }
              }
            }
          } else if (part.type === "reasoning") {
            const r = sanitizeText((part as { text: string }).text)
            if (r.trim() && state.showThinking) {
              out.push({ text: "  Thinking", color: "magenta" })
              for (const line of wrapToWidth(r.slice(-600), wrapW)) out.push({ text: `  ${line}`, color: "magenta" })
            }
            idx++
          } else {
            idx++
          }
        }
      } else {
        const content = cleanAssistantText(sanitizeText(typeof msg.content === "string" ? msg.content : ""))
        const segments = splitMessageBlocks(content)
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

  // If no user message yet but we have progress/error, show it at end (e.g. initial load)
  if (lastUserIdx === -1 && (state.liveTools.length > 0 || state.subAgents.length > 0 || state.todo.trim() || state.reasoning || state.currentStreaming || state.compacting || state.lastError)) {
    pushRunProgress()
  }

  return out
}

function wrapToWidth(text: string, width: number): string[] {
  const safe = sanitizeText(text)
  if (width <= 1) return [safe]
  const lines: string[] = []
  for (const raw of safe.split("\n")) {
    const line = raw || ""
    if (stringWidth(line) <= width) {
      lines.push(line)
      continue
    }
    let rest = line
    while (rest.length > 0) {
      let w = 0
      let cut = 0
      for (let i = 0; i < rest.length; i++) {
        const cw = stringWidth(rest[i]!)
        if (w + cw > width && cut > 0) break
        w += cw
        cut = i + 1
      }
      if (cut >= rest.length) {
        lines.push(rest)
        break
      }
      const segment = rest.slice(0, cut)
      const lastSpace = Math.max(segment.lastIndexOf(" "), segment.lastIndexOf("\t"))
      const breakAt = lastSpace >= 0 ? lastSpace : cut
      const chunk = rest.slice(0, breakAt).trimEnd()
      if (chunk) lines.push(chunk)
      rest = (breakAt < rest.length ? rest.slice(breakAt) : "").trimStart()
      if (rest.length > 0 && stringWidth(rest) <= width) {
        lines.push(rest)
        break
      }
    }
  }
  return lines
}

function fit(value: string, max: number): string {
  if (max <= 0) return ""
  if (stringWidth(value) <= max) return value
  if (max <= 1) return "…"
  let out = ""
  let width = 0
  for (const ch of value) {
    const chWidth = stringWidth(ch)
    if (width + chWidth > max - 1) break
    out += ch
    width += chWidth
  }
  return `${out}…`
}

function padToWidth(value: string, width: number): string {
  const trimmed = fit(value, width)
  const pad = Math.max(0, width - stringWidth(trimmed))
  return `${trimmed}${" ".repeat(pad)}`
}

function trimLeftToWidth(value: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(value) <= width) return value
  if (width === 1) return "…"
  let out = ""
  let w = 0
  for (let i = value.length - 1; i >= 0; i--) {
    const ch = value[i]!
    const cw = stringWidth(ch)
    if (w + cw > width - 1) break
    out = ch + out
    w += cw
  }
  return `…${out}`
}

function shortenPath(value: string, max: number): string {
  if (!value) return "~"
  const normalized = value.replace(os.homedir(), "~")
  if (normalized.length <= max) return normalized
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length <= 2) return fit(normalized, max)
  const tail = parts.slice(-2).join("/")
  const prefix = normalized.startsWith("~") ? "~/" : "/"
  return fit(`${prefix}…/${tail}`, max)
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

const AGENT_PRESETS_FILE = "agent-configs.json"

async function readAgentPresets(projectDir: string): Promise<AgentPreset[]> {
  const filePath = path.join(projectDir, ".nexus", AGENT_PRESETS_FILE)
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as { presets?: unknown[]; configs?: unknown[] } | unknown[]
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { presets?: unknown[] }).presets)
      ? (parsed as { presets: unknown[] }).presets
      : Array.isArray((parsed as { configs?: unknown[] }).configs)
      ? (parsed as { configs: unknown[] }).configs
      : []
    const normalized = list
      .map(normalizeAgentPreset)
      .filter((preset): preset is AgentPreset => Boolean(preset))
    return normalized
  } catch {
    return []
  }
}

async function writeAgentPresets(projectDir: string, presets: AgentPreset[]): Promise<void> {
  const dir = path.join(projectDir, ".nexus")
  const filePath = path.join(dir, AGENT_PRESETS_FILE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify({ presets }, null, 2), "utf8")
}

function normalizeAgentPreset(value: unknown): AgentPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null
  return {
    name,
    modelProvider: typeof raw.modelProvider === "string" ? raw.modelProvider : undefined,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined,
    vector: Boolean(raw.vector),
    skills: dedupeList(asStringList(raw.skills)),
    mcpServers: dedupeList(asStringList(raw.mcpServers)),
    rulesFiles: dedupeList(asStringList(raw.rulesFiles)),
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}

function dedupeList(items: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const value = item.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function toggleInList(items: string[], value: string): string[] {
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value]
}

async function discoverSkillPaths(projectDir: string): Promise<string[]> {
  const roots = [
    path.join(projectDir, ".nexus", "skills"),
    path.join(projectDir, ".agents", "skills"),
    path.join(os.homedir(), ".nexus", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ]
  const files: string[] = []
  for (const root of roots) {
    const fromRoot = await walkSkillFiles(root, 5).catch(() => [])
    files.push(...fromRoot)
  }
  const fromAgents = await discoverSkillsFromAgentsMd(projectDir).catch(() => [])
  const normalized = dedupeList([...files, ...fromAgents]).map((file) => toDisplayPath(file, projectDir))
  return dedupeList(normalized)
}

async function walkSkillFiles(rootDir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return []
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkSkillFiles(fullPath, maxDepth - 1).catch(() => [])
      out.push(...nested)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (lower === "skill.md") {
      out.push(fullPath)
    }
  }
  return out
}

async function discoverSkillsFromAgentsMd(projectDir: string): Promise<string[]> {
  const rules = await discoverRuleFiles(projectDir)
  const agentFiles = rules.filter((rule) => path.basename(rule).toLowerCase() === "agents.md")
  const out: string[] = []
  for (const file of agentFiles) {
    const content = await fs.readFile(file, "utf8").catch(() => "")
    if (!content) continue
    const lines = content.split("\n")
    for (const line of lines) {
      const fileMatch = line.match(/\(file:\s*([^)]+)\)/i)
      if (!fileMatch) continue
      const candidate = fileMatch[1]!.trim()
      if (!candidate) continue
      out.push(candidate)
    }
  }
  return dedupeList(out)
}

async function discoverRuleFiles(projectDir: string): Promise<string[]> {
  const names = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]
  const out: string[] = []
  const visited = new Set<string>()
  let current = path.resolve(projectDir)
  const home = path.resolve(os.homedir())
  while (true) {
    if (visited.has(current)) break
    visited.add(current)
    for (const name of names) {
      const file = path.join(current, name)
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile()) out.push(file)
    }
    if (current === path.dirname(current) || current === home) break
    current = path.dirname(current)
  }
  for (const name of names) {
    const file = path.join(home, name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat?.isFile()) out.push(file)
  }
  return dedupeList(out)
}

function toDisplayPath(file: string, projectDir: string): string {
  if (path.isAbsolute(file) && file.startsWith(projectDir)) {
    return path.relative(projectDir, file) || file
  }
  return file
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
    <box flexDirection="column" borderStyle="single" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <text fg="cyan" bold> Help</text>
      <text fg="gray"> Esc — close</text>
      <box flexDirection="column" paddingLeft={1}>
        <box>
          <text fg="gray">Model: </text>
          <text fg="white">{modelLine}</text>
          {typeof snap?.model?.temperature === "number" && (
            <text fg="gray"> · temp {snap.model.temperature}</text>
          )}
        </box>
        <box>
          <text fg="gray">Embeddings: </text>
          {snap?.embeddings ? (
            <text fg="white"> {snap.embeddings.provider} / {snap.embeddings.model}</text>
          ) : (
            <text fg="gray"> not set (vector search off)</text>
          )}
          {snap?.embeddings?.dimensions && (
            <text fg="gray"> · dim {snap.embeddings.dimensions}</text>
          )}
        </box>
        <box>
          <text fg="gray">Index: </text>
          <text fg={indexStatus === "ready" ? "green" : indexStatus === "off" ? "gray" : "yellow"}>{indexStatus}</text>
          {snap?.indexing?.vector && <text fg="gray"> · vector on</text>}
        </box>
        {snap?.vectorDb?.enabled && (
          <box>
            <text fg="gray">Vector DB: </text>
            <text fg="white">{snap.vectorDb.url}</text>
          </box>
        )}
        {sessionId && <box><text fg="gray">Session: </text><text fg="white">{sessionLine}</text></box>}
        {projectDir && <box><text fg="gray">Project: </text><text fg="white">{projectLine}</text></box>}
        <box><text fg="gray">Profiles: </text><text fg="white">{profilesLine}</text></box>
      </box>

      <text fg="white" bold>{"\n"} Commands</text>
      <text fg="gray"> /settings  /model  /embeddings  /index  /advanced  /sessions  /agent-config  /help</text>
      <text fg="white" bold>{"\n"} Shortcuts</text>
      <text fg="gray"> Tab mode · Ctrl+P profile · Ctrl+S compact · Ctrl+K clear · Ctrl+C abort/quit</text>
      <text fg="white" bold>{"\n"} Config files</text>
      <text fg="gray"> .nexus/nexus.yaml (project) · ~/.nexus/nexus.yaml (global)</text>
      <text fg="gray"> Free models: provider `openai-compatible` via Nexus Gateway (configure in /model)</text>
    </box>
  )
}
