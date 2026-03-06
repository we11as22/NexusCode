/**
 * Controller — Cline-style single owner of task/session state and agent run.
 * Owns session, config, run state, and posts state/events to webview via postMessage.
 */

import * as vscode from "vscode"
import * as path from "path"
import * as fs from "node:fs"
import { promises as fsPromises } from "node:fs"
import * as os from "node:os"
import type { AgentEvent, NexusConfig, Mode, SessionMessage, IndexStatus } from "@nexuscode/core"
import type { ApprovalAction, PermissionResult, CheckpointEntry, McpServerConfig } from "@nexuscode/core"
import {
  loadConfig,
  writeConfig,
  writeGlobalProfiles,
  loadProjectSettings,
  persistSecretsFromConfig,
  Session,
  listSessions,
  deleteSession,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadRules,
  McpClient,
  setMcpClientInstance,
  resolveBundledMcpServers,
  testMcpServers,
  createCompaction,
  ParallelAgentManager,
  createSpawnAgentTool,
  runAgentLoop,
  CheckpointTracker,
  CodebaseIndexer,
  createCodebaseIndexer,
  NexusConfigSchema,
  getModelsCatalog,
  hadPlanExit,
  getPlanContentForFollowup,
} from "@nexuscode/core"
import { VsCodeHost, showDiffForPath } from "./host.js"

const MODE_REMINDER_REGEX = /^\[You are now in [^\]]+\.\]\s*\n?\n?/i

/** Number of messages to load when opening a server session (same as server RECENT_MESSAGES_FOR_RUN for agent context). */
const INITIAL_SERVER_MESSAGES = 200

function stripModeReminderFromMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg
    const content = msg.content
    if (typeof content !== "string") return msg
    const stripped = content.replace(MODE_REMINDER_REGEX, "").trimStart()
    if (stripped === content) return msg
    return { ...msg, content: stripped }
  })
}

export type WebviewMessage =
  | { type: "newMessage"; content: string; mode: Mode; mentions?: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "clearChat" }
  | { type: "setMode"; mode: Mode }
  | { type: "setProfile"; profile: string }
  | { type: "getState" }
  | { type: "webviewDidLaunch" }
  | { type: "openSettings" }
  | { type: "saveConfig"; config: Partial<NexusConfig> }
  | { type: "switchSession"; sessionId: string }
  | { type: "forkSession"; messageId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "reindex" }
  | { type: "clearIndex" }
  | { type: "openFileAtLocation"; path: string; line?: number; endLine?: number }
  | { type: "showDiff"; path: string }
  | { type: "setServerUrl"; url: string }
  | { type: "openNexusConfigFolder"; scope: "global" | "project" }
  | { type: "openCursorignore" }
  | { type: "openMcpConfig" }
  | { type: "testMcpServers" }
  | { type: "openSkillFolder"; path: string }
  | { type: "approvalResponse"; partId: string; approved: boolean; alwaysApprove?: boolean; addToAllowedCommand?: string; skipAll?: boolean; whatToDoInstead?: string }
  | { type: "openExternal"; url: string }
  | { type: "showConfirm"; id: string; message: string }
  | { type: "openNexusignore" }
  | { type: "getModelsCatalog" }
  | { type: "restoreCheckpoint"; hash: string; restoreType: "task" | "workspace" | "taskAndWorkspace" }
  | { type: "showCheckpointDiff"; fromHash: string; toHash?: string }
  | { type: "getAgentPresets" }
  | { type: "getAgentPresetOptions" }
  | { type: "createAgentPreset"; preset: { name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string } }
  | { type: "deleteAgentPreset"; presetName: string }
  | { type: "applyAgentPreset"; presetName: string }
  | { type: "planFollowupChoice"; choice: "new_session" | "continue" | "dismiss"; planText?: string }
  | { type: "loadOlderMessages" }

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatus }
  | { type: "configLoaded"; config: NexusConfig }
  | { type: "skillDefinitions"; definitions: Array<{ name: string; path: string; summary: string }> }
  | { type: "addToChatContent"; content: string }
  | { type: "action"; action: "switchView"; view: "chat" | "sessions" | "settings" }
  | { type: "mcpServerStatus"; results: Array<{ name: string; status: "ok" | "error"; error?: string }> }
  | { type: "pendingApproval"; partId: string; action: ApprovalAction }
  | { type: "confirmResult"; id: string; ok: boolean }
  | { type: "modelsCatalog"; catalog: import("@nexuscode/core").ModelsCatalog }
  | { type: "agentPresets"; presets: Array<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }> }
  | { type: "agentPresetOptions"; options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } }

export interface WebviewState {
  messages: SessionMessage[]
  mode: Mode
  isRunning: boolean
  model: string
  provider: string
  sessionId: string
  projectDir?: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatus
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  serverUrl?: string
  modelsCatalog?: import("@nexuscode/core").ModelsCatalog | null
  checkpointEnabled?: boolean
  checkpointEntries?: CheckpointEntry[]
  /** Plan mode: plan_exit was called; show New session / Continue / Dismiss. */
  planCompleted?: boolean
  /** Plan text for "New session" (optional; controller may set via async follow-up). */
  planFollowupText?: string | null
  /** Server session: there are older messages above; show "Load older" in chat. */
  hasOlderMessages?: boolean
  /** True while older messages are being fetched. */
  loadingOlderMessages?: boolean
}

function getContextLimit(modelId: string): number {
  const lower = modelId.toLowerCase()
  if (lower.includes("claude-3") || lower.includes("claude-4") || lower.includes("claude-sonnet") || lower.includes("claude-opus")) return 200000
  if (lower.includes("gpt-4o")) return 128000
  if (lower.includes("gpt-4")) return 128000
  if (lower.includes("gpt-3.5")) return 16000
  if (lower.includes("gemini-2")) return 1000000
  if (lower.includes("gemini")) return 200000
  return 128000
}

export class Controller {
  private session?: Session
  private config?: NexusConfig
  private defaultModelProfile?: NexusConfig["model"]
  /** Snapshot of skills/mcp/rules/indexing at first config load; used for "Default" preset. */
  private initialFullConfigSnapshot?: {
    skills: string[]
    mcp: { servers: NexusConfig["mcp"]["servers"] }
    rules: { files: string[] }
    indexing: NexusConfig["indexing"]
  }
  private mode: Mode = "agent"
  /** Mode of the previous run; used to prepend a reminder when user switches mode in the same session. */
  private lastRunMode: Mode | null = null
  private isRunning = false
  private abortController?: AbortController
  private checkpoint?: CheckpointTracker
  private indexer?: CodebaseIndexer
  private mcpClient?: McpClient
  private serverSessionId?: string
  /** For server sessions: offset of the oldest loaded message (0 = all loaded). Used for "Load older" pagination. */
  private serverSessionOldestLoadedOffset: number | undefined = undefined
  private loadingOlderMessages = false
  private initialized = false
  private initPromise?: Promise<void>
  /** Started in ensureInitialized (not awaited there); runAgent awaits it so MCP is ready before first run. */
  private mcpReconnectPromise: Promise<void> | null = null
  private modelsCatalogCache: import("@nexuscode/core").ModelsCatalog | null = null
  private indexStatusUnsubscribe?: () => void
  private indexerFileWatcher?: vscode.Disposable
  private disposables: vscode.Disposable[] = []
  private approvalResolveRef: { current: ((r: PermissionResult) => void) | null } = { current: null }
  /** VS Code Secret Storage for API keys (Roo-Code best practice — keys never in YAML). */
  private readonly secretsStore = {
    getSecret: (key: string) => this.context.secrets.get(key),
    setSecret: (key: string, value: string) => this.context.secrets.store(key, value),
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postMessageToWebview: (msg: ExtensionMessage) => void
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("nexuscode")) return
        if (this.config) {
          this.applyVscodeOverrides(this.config)
          this.postStateToWebview()
        }
      })
    )
  }

  getCwd(): string {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return folders[0]!.uri.fsPath
    }
    return process.cwd()
  }

  getServerUrl(): string {
    return vscode.workspace.getConfiguration("nexuscode").get<string>("serverUrl")?.trim() ?? ""
  }

  getSession(): Session | undefined {
    return this.session
  }

  getConfig(): NexusConfig | undefined {
    return this.config
  }

  getIsRunning(): boolean {
    return this.isRunning
  }

  /** Build full state for webview (Cline-style getStateToPostToWebview). */
  getStateToPostToWebview(): WebviewState {
    const status = this.indexer?.status() ?? { state: "idle" as const }
    if (!this.session || !this.config) {
      return {
        messages: [],
        mode: this.mode,
        isRunning: false,
        model: "—",
        provider: "—",
        sessionId: "",
        projectDir: this.getCwd(),
        todo: "",
        indexReady: status.state === "ready",
        indexStatus: status,
        contextUsedTokens: 0,
        contextLimitTokens: 128000,
        contextPercent: 0,
        serverUrl: this.getServerUrl(),
        modelsCatalog: this.modelsCatalogCache ?? null,
      }
    }
    const contextUsedTokens = this.session.getTokenEstimate()
    const contextLimitTokens = getContextLimit(this.config.model.id)
    const contextPercent =
      contextLimitTokens > 0
        ? Math.min(100, Math.round((contextUsedTokens / contextLimitTokens) * 100))
        : 0
    const messages = stripModeReminderFromMessages(this.session.messages)
    return {
      messages,
      mode: this.mode,
      isRunning: this.isRunning,
      model: this.config.model.id,
      provider: this.config.model.provider,
      sessionId: this.session.id,
      projectDir: this.getCwd(),
      todo: this.session.getTodo(),
      indexReady: status.state === "ready",
      indexStatus: status,
      contextUsedTokens,
      contextLimitTokens,
      contextPercent,
      serverUrl: this.getServerUrl(),
      modelsCatalog: this.modelsCatalogCache ?? null,
      checkpointEnabled: this.config?.checkpoint?.enabled === true || this.checkpoint != null,
      checkpointEntries: this.checkpoint?.getEntries() ?? [],
      planCompleted:
        this.session && this.mode === "plan" && !this.isRunning && hadPlanExit(this.session),
      planFollowupText: null,
      hasOlderMessages: this.serverSessionOldestLoadedOffset != null && this.serverSessionOldestLoadedOffset > 0,
      loadingOlderMessages: this.loadingOlderMessages,
    }
  }

  /** Push current state to webview (Cline-style postStateToWebview). */
  postStateToWebview(): void {
    const state = this.getStateToPostToWebview()
    this.postMessageToWebview({ type: "stateUpdate", state })
    if (state.planCompleted && this.session) {
      void getPlanContentForFollowup(this.session, this.getCwd()).then((planFollowupText) => {
        this.postMessageToWebview({
          type: "stateUpdate",
          state: { ...this.getStateToPostToWebview(), planFollowupText },
        })
      })
    }
  }

  /** Load skills from config paths and standard dirs (~/.nexus/skills, .nexus/skills) and send to webview for Skills list UI. */
  private loadAndSendSkillDefinitions(): void {
    const cwd = this.getCwd()
    const paths = this.config?.skills ?? []
    loadSkills(paths, cwd)
      .then((skills) => {
        this.postMessageToWebview({
          type: "skillDefinitions",
          definitions: skills.map((s) => ({ name: s.name, path: s.path, summary: s.summary })),
        })
      })
      .catch(() => {
        this.postMessageToWebview({ type: "skillDefinitions", definitions: [] })
      })
  }

  /** Clear current task/session and reset run state. */
  async clearTask(): Promise<void> {
    this.abortController?.abort()
    this.session = undefined
    this.serverSessionOldestLoadedOffset = undefined
    this.checkpoint = undefined
    this.serverSessionId = undefined
    this.postStateToWebview()
  }

  /** Cancel running agent (abort + keep session, then post state). */
  async cancelTask(): Promise<void> {
    this.abortController?.abort()
    this.isRunning = false
    this.postStateToWebview()
  }

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
      this.postStateToWebview()
      this.sendIndexStatus()
      return
    }
    this.initPromise = (async () => {
      this.initialized = true
      const cwd = this.getCwd()
      try {
        this.config = await loadConfig(cwd, { secrets: this.secretsStore })
      } catch {
        this.config = undefined
      }
      if (!this.config) {
        try {
          this.config = await loadConfig(process.cwd(), { secrets: this.secretsStore })
        } catch {}
      }
      if (!this.config) {
        this.config = NexusConfigSchema.parse({}) as NexusConfig
      }
      if (!this.initialFullConfigSnapshot && this.config) {
        this.initialFullConfigSnapshot = {
          skills: [...(this.config.skills ?? [])],
          mcp: { servers: [...(this.config.mcp?.servers ?? [])] },
          rules: { files: [...(this.config.rules?.files ?? [])] },
          indexing: { ...this.config.indexing },
        }
      }
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
      void this.loadAndSendSkillDefinitions()
      try {
        const allowPath = path.join(cwd, ".nexus", "allowed-commands.json")
        const uri = vscode.Uri.file(allowPath)
        const data = await vscode.workspace.fs.readFile(uri)
        const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as { commands?: string[] }
        if (Array.isArray(parsed?.commands)) {
          this.config.permissions.allowedCommands = parsed.commands
        }
      } catch {
        // No file or invalid — keep default
      }
      try {
        const settings = loadProjectSettings(cwd)
        const perms = settings.permissions
        if (perms) {
          if (!this.config.permissions.allowCommandPatterns) this.config.permissions.allowCommandPatterns = []
          if (!this.config.permissions.denyCommandPatterns) this.config.permissions.denyCommandPatterns = []
          if (!this.config.permissions.askCommandPatterns) this.config.permissions.askCommandPatterns = []
          if (Array.isArray(perms.allow)) this.config.permissions.allowCommandPatterns = perms.allow
          if (Array.isArray(perms.deny)) this.config.permissions.denyCommandPatterns = perms.deny
          if (Array.isArray(perms.ask)) this.config.permissions.askCommandPatterns = perms.ask
        }
      } catch {
        // ignore
      }
      this.applyVscodeOverrides(this.config)
      this.defaultModelProfile = { ...this.config.model }
      this.session = Session.create(cwd)
      this.postStateToWebview()
      this.sendIndexStatus()
      // Resolve init here so first message is not blocked. MCP/indexer/catalog/skills run in background.
      this.mcpReconnectPromise = this.reconnectMcpServers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
      })
      void this.initializeIndexer(cwd).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
      })
      if (!this.modelsCatalogCache) {
        void getModelsCatalog()
          .then((cat) => {
            this.modelsCatalogCache = cat
            this.postStateToWebview()
          })
          .catch(() => {
            this.modelsCatalogCache = { providers: [], recommended: [] }
            this.postStateToWebview()
          })
      }
    })()
    await this.initPromise
    this.initPromise = Promise.resolve()
  }

  async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "newMessage":
        await this.ensureInitialized()
        await this.runAgent(msg.content, msg.mode)
        break
      case "abort":
        this.abortController?.abort()
        this.isRunning = false
        this.postStateToWebview()
        break
      case "compact":
        await this.compactHistory()
        break
      case "clearChat":
        this.session = Session.create(this.getCwd())
        this.lastRunMode = null
        this.checkpoint = undefined
        this.serverSessionId = undefined
        this.postStateToWebview()
        break
      case "setMode":
        this.mode = msg.mode
        this.postStateToWebview()
        break
      case "setProfile":
        if (this.config) {
          if (!msg.profile) {
            if (this.defaultModelProfile) {
              this.config.model = { ...this.defaultModelProfile }
            }
            this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
            this.postStateToWebview()
            break
          }
          const profile = this.config.profiles[msg.profile]
          if (!profile) break
          this.config.model = { ...this.config.model, ...profile }
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
          this.postStateToWebview()
        }
        break
      case "getState":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) {
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
          void this.loadAndSendSkillDefinitions()
        }
        void this.ensureInitialized().then(() => {
          this.postStateToWebview()
          this.sendIndexStatus()
        })
        await this.sendSessionList()
        break
      case "getModelsCatalog": {
        if (this.modelsCatalogCache) {
          this.postMessageToWebview({ type: "modelsCatalog", catalog: this.modelsCatalogCache })
          break
        }
        void getModelsCatalog()
          .then((catalog) => {
            this.modelsCatalogCache = catalog
            this.postMessageToWebview({ type: "modelsCatalog", catalog })
          })
          .catch(() => {
            this.modelsCatalogCache = { providers: [], recommended: [] }
            this.postMessageToWebview({ type: "modelsCatalog", catalog: this.modelsCatalogCache })
          })
        break
      }
      case "webviewDidLaunch":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) {
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
          void this.loadAndSendSkillDefinitions()
        }
        void this.ensureInitialized().then(() => {
          this.postStateToWebview()
          this.sendIndexStatus()
        })
        await this.sendSessionList()
        break
      case "openSettings":
        try {
          await vscode.commands.executeCommand("workbench.action.openSettings", "nexuscode")
        } catch {
          try {
            await vscode.commands.executeCommand("workbench.action.openSettings")
          } catch {}
        }
        break
      case "saveConfig":
        await this.handleSaveConfig(msg.config)
        break
      case "switchSession":
        await this.switchSession(msg.sessionId)
        break
      case "loadOlderMessages":
        await this.loadOlderMessages()
        break
      case "deleteSession":
        await this.deleteSession(msg.sessionId)
        break
      case "forkSession":
        if (this.session && msg.messageId) {
          this.session = this.session.fork(msg.messageId) as Session
          if (this.getServerUrl()) {
            this.serverSessionId = undefined
            this.serverSessionOldestLoadedOffset = undefined
          }
          this.postStateToWebview()
        }
        break
      case "reindex":
        await this.reindex()
        break
      case "clearIndex":
        await this.clearIndex()
        break
      case "openFileAtLocation": {
        const cwd = this.getCwd()
        const absPath = path.isAbsolute(msg.path) ? msg.path : path.join(cwd, msg.path)
        const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
        const wf = vscode.workspace.workspaceFolders?.[0]
        const uri = wf ? vscode.Uri.joinPath(wf.uri, relPath) : vscode.Uri.file(absPath)
        const line = Math.max(0, (msg.line ?? 1) - 1)
        const endLine = msg.endLine != null ? Math.max(0, msg.endLine - 1) : line
        const isPlanFile = absPath.replace(/\\/g, "/").includes(".nexus/plans")
        void (async () => {
          try {
            const doc = await vscode.workspace.openTextDocument(uri)
            const editor = await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Active,
              selection: new vscode.Range(line, 0, endLine, 0),
              preview: false,
            })
            if (doc.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert")
            editor.revealRange(new vscode.Range(line, 0, endLine, 0), vscode.TextEditorRevealType.InCenter)
            if (isPlanFile && doc.getText().trim() === "") {
              await new Promise((r) => setTimeout(r, 200))
              await vscode.commands.executeCommand("workbench.action.files.revert")
            }
          } catch {
            vscode.window.showErrorMessage(`NexusCode: Could not open ${msg.path}`)
          }
        })()
        break
      }
      case "showDiff": {
        const cwd = this.getCwd()
        const raw = msg.path?.trim() ?? ""
        // Avoid using multi-line or huge strings as path (e.g. accidental content paste).
        if (raw.length > 0 && raw.length < 2048 && !raw.includes("\n")) {
          await showDiffForPath(cwd, raw)
        }
        break
      }
      case "setServerUrl": {
        const url = typeof msg.url === "string" ? msg.url.trim() : ""
        await vscode.workspace.getConfiguration("nexuscode").update("serverUrl", url || undefined, vscode.ConfigurationTarget.Global)
        this.postStateToWebview()
        break
      }
      case "openNexusConfigFolder": {
        const os = await import("os")
        const scope = msg.scope === "project" ? "project" : "global"
        if (scope === "global") {
          const dir = path.join(os.homedir(), ".nexus")
          const uri = vscode.Uri.file(dir)
          try { await vscode.workspace.fs.createDirectory(uri).catch(() => {}) } catch { /* noop */ }
          await vscode.commands.executeCommand("revealInExplorer", uri)
        } else {
          const cwd = this.getCwd()
          const dir = path.join(cwd, ".nexus")
          const dirUri = vscode.Uri.file(dir)
          try { await vscode.workspace.fs.createDirectory(dirUri).catch(() => {}) } catch { /* noop */ }
          const configPath = path.join(cwd, ".nexus", "nexus.yaml")
          const uri = vscode.Uri.file(configPath)
          const doc = await vscode.workspace.openTextDocument(uri).catch(() => null)
          if (doc) {
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          } else {
            await vscode.commands.executeCommand("revealInExplorer", dirUri)
          }
        }
        break
      }
      case "openCursorignore": {
        const cwd = this.getCwd()
        const filePath = path.join(cwd, ".cursorignore")
        const uri = vscode.Uri.file(filePath)
        const doc = await vscode.workspace.openTextDocument(uri).catch(() => null)
        if (doc) {
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        } else {
          const wsEdit = new vscode.WorkspaceEdit()
          wsEdit.createFile(uri, { ignoreIfExists: true })
          await vscode.workspace.applyEdit(wsEdit)
          const newDoc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        }
        break
      }
      case "openMcpConfig": {
        const cwd = this.getCwd()
        const mcpPath = path.join(cwd, ".nexus", "mcp-servers.json")
        const uri = vscode.Uri.file(mcpPath)
        const doc = await vscode.workspace.openTextDocument(uri).catch(async () => {
          const dir = path.join(cwd, ".nexus")
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
          } catch {}
          const defaultContent = JSON.stringify([], null, 2)
          await vscode.workspace.fs.writeFile(uri, Buffer.from(defaultContent, "utf8"))
          return vscode.workspace.openTextDocument(uri)
        })
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        break
      }
      case "testMcpServers": {
        if (!this.config?.mcp.servers.length) {
          this.postMessageToWebview({
            type: "mcpServerStatus",
            results: [],
          })
          break
        }
        try {
          const resolved = this.getResolvedMcpServers()
          const results = await testMcpServers(resolved)
          this.postMessageToWebview({ type: "mcpServerStatus", results })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({
            type: "mcpServerStatus",
            results: this.config.mcp.servers.map((s) => ({ name: s.name, status: "error" as const, error: message })),
          })
        }
        break
      }
      case "openSkillFolder": {
        const cwd = this.getCwd()
        const absPath = path.isAbsolute(msg.path) ? msg.path : path.resolve(cwd, msg.path)
        const uri = vscode.Uri.file(absPath)
        const stat = await vscode.workspace.fs.stat(uri).catch(() => null)
        if (stat?.type === vscode.FileType.File) {
          const dirUri = vscode.Uri.file(path.dirname(absPath))
          await vscode.commands.executeCommand("revealInExplorer", dirUri)
        } else {
          await vscode.commands.executeCommand("revealInExplorer", uri)
        }
        break
      }
      case "approvalResponse": {
        const resolve = this.approvalResolveRef.current
        if (resolve) {
          resolve({
            approved: msg.approved,
            alwaysApprove: msg.alwaysApprove,
            addToAllowedCommand: msg.addToAllowedCommand,
            skipAll: msg.skipAll,
            whatToDoInstead: msg.whatToDoInstead,
          })
        }
        break
      }
      case "openExternal": {
        if (typeof msg.url === "string" && msg.url.startsWith("http")) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url))
        }
        break
      }
      case "showConfirm": {
        const choice = await vscode.window.showWarningMessage(msg.message, { modal: true }, "Yes", "No")
        this.postMessageToWebview({ type: "confirmResult", id: msg.id, ok: choice === "Yes" })
        break
      }
      case "openNexusignore": {
        const cwd = this.getCwd()
        const filePath = path.join(cwd, ".nexusignore")
        const uri = vscode.Uri.file(filePath)
        const doc = await vscode.workspace.openTextDocument(uri).catch(() => null)
        if (doc) {
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        } else {
          const wsEdit = new vscode.WorkspaceEdit()
          wsEdit.createFile(uri, { ignoreIfExists: true })
          await vscode.workspace.applyEdit(wsEdit)
          const newDoc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        }
        break
      }
      case "restoreCheckpoint":
        if (msg.hash?.trim() && msg.restoreType) {
          await this.restoreCheckpointToHash(msg.hash.trim(), msg.restoreType)
        }
        break
      case "showCheckpointDiff":
        if (msg.fromHash?.trim()) {
          await this.showCheckpointDiff(msg.fromHash.trim(), msg.toHash?.trim())
        }
        break
      case "getAgentPresets": {
        const presets = await this.readAgentPresets()
        this.postMessageToWebview({ type: "agentPresets", presets })
        break
      }
      case "getAgentPresetOptions": {
        const options = await this.getAgentPresetOptions()
        this.postMessageToWebview({ type: "agentPresetOptions", options })
        break
      }
      case "createAgentPreset":
        if (msg.preset?.name?.trim()) {
          await this.createAgentPreset(msg.preset)
          const presets = await this.readAgentPresets()
          this.postMessageToWebview({ type: "agentPresets", presets })
        }
        break
      case "deleteAgentPreset":
        if (msg.presetName?.trim()) {
          await this.deleteAgentPreset(msg.presetName.trim())
          const presets = await this.readAgentPresets()
          this.postMessageToWebview({ type: "agentPresets", presets })
        }
        break
      case "applyAgentPreset":
        if (msg.presetName != null) {
          await this.applyAgentPreset(typeof msg.presetName === "string" ? msg.presetName : "Default")
        }
        break
      case "planFollowupChoice": {
        if (msg.choice === "dismiss") break
        const cwd = this.getCwd()
        if (msg.choice === "continue") {
          this.mode = "agent"
          const planText =
            msg.planText?.trim() ||
            (this.session ? await getPlanContentForFollowup(this.session, cwd) : "")
          const continueContent = planText
            ? `Implement the following plan:\n\n${planText}`
            : "Implement the plan above."
          await this.runAgent(continueContent, "agent")
          break
        }
        if (msg.choice === "new_session" && this.session) {
          const planText =
            msg.planText?.trim() ||
            (await getPlanContentForFollowup(this.session, cwd))
          this.session = Session.create(cwd)
          this.lastRunMode = null
          this.checkpoint = undefined
          this.serverSessionId = undefined
          this.postStateToWebview()
          await this.runAgent(
            `Implement the following plan:\n\n${planText}`,
            "agent"
          )
        }
        break
      }
    }
  }

  /**
   * Restore workspace/chat to a checkpoint (Cline/Roo-Code style).
   * restoreType: task = rewind chat only; workspace = files only; taskAndWorkspace = both.
   */
  private async restoreCheckpointToHash(hash: string, restoreType: "task" | "workspace" | "taskAndWorkspace"): Promise<void> {
    if (!this.checkpoint) {
      vscode.window.showWarningMessage("NexusCode: Checkpoints are not enabled or no checkpoint is available.", { modal: false })
      return
    }
    const cwd = this.getCwd()
    const entry = this.checkpoint.getEntries().find((e) => e.hash === hash)
    const checkpointTs = entry?.ts

    if (restoreType === "taskAndWorkspace" || restoreType === "workspace") {
      this.abortController?.abort()
      this.isRunning = false
    }

    if (restoreType === "workspace" || restoreType === "taskAndWorkspace") {
      try {
        await this.checkpoint.resetHead(hash)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`NexusCode: Failed to restore checkpoint — ${message}`)
        return
      }
    }

    if ((restoreType === "task" || restoreType === "taskAndWorkspace") && this.session && checkpointTs != null) {
      this.session.rewindToTimestamp(checkpointTs)
    }

    if (restoreType === "workspace" || restoreType === "taskAndWorkspace") {
      const cwdResolved = path.resolve(cwd)
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== "file") continue
        const rel = path.relative(cwdResolved, doc.uri.fsPath)
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue
        if (!doc.isDirty) continue
        try {
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false })
          await vscode.commands.executeCommand("workbench.action.files.revert")
        } catch {
          // Ignore per-doc revert errors
        }
      }
    }

    const msg =
      restoreType === "task"
        ? "Chat restored to checkpoint."
        : restoreType === "workspace"
          ? "Workspace files restored to checkpoint."
          : "Workspace and chat restored to checkpoint."
    vscode.window.showInformationMessage(`NexusCode: ${msg}`, { modal: false })
    this.postStateToWebview()
  }

  /** Show diff between two checkpoints (or checkpoint and current). */
  private async showCheckpointDiff(fromHash: string, toHash?: string): Promise<void> {
    if (!this.checkpoint) {
      vscode.window.showWarningMessage("NexusCode: Checkpoints are not enabled.", { modal: false })
      return
    }
    try {
      const files = await this.checkpoint.getDiff(fromHash, toHash)
      if (files.length === 0) {
        vscode.window.showInformationMessage("NexusCode: No changes between these checkpoints.", { modal: false })
        return
      }
      if (files.length === 1) {
        const f = files[0]!
        const beforeDoc = await vscode.workspace.openTextDocument({ content: f.before, language: "plaintext" })
        const afterDoc = await vscode.workspace.openTextDocument({ content: f.after, language: "plaintext" })
        await vscode.commands.executeCommand("vscode.diff", beforeDoc.uri, afterDoc.uri, `${path.basename(f.path)}: Checkpoint diff`, { viewColumn: vscode.ViewColumn.Active })
        return
      }
      const chosen = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f.path, file: f })),
        { title: "Select file to view diff", placeHolder: `${files.length} files changed` }
      )
      if (chosen) {
        const beforeDoc = await vscode.workspace.openTextDocument({ content: chosen.file.before, language: "plaintext" })
        const afterDoc = await vscode.workspace.openTextDocument({ content: chosen.file.after, language: "plaintext" })
        await vscode.commands.executeCommand("vscode.diff", beforeDoc.uri, afterDoc.uri, `${path.basename(chosen.file.path)}: Checkpoint diff`, { viewColumn: vscode.ViewColumn.Active })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to get checkpoint diff — ${message}`)
    }
  }

  /** Read agent presets from .nexus/agent-configs.json (same format as CLI). */
  private async readAgentPresets(): Promise<
    Array<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }>
  > {
    const cwd = this.getCwd()
    const filePath = path.join(cwd, ".nexus", "agent-configs.json")
    try {
      const uri = vscode.Uri.file(filePath)
      const raw = await vscode.workspace.fs.readFile(uri)
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as { presets?: unknown[]; configs?: unknown[] } | unknown[]
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { presets?: unknown[] }).presets)
          ? (parsed as { presets: unknown[] }).presets
          : Array.isArray((parsed as { configs?: unknown[] }).configs)
            ? (parsed as { configs: unknown[] }).configs
            : []
      return list.map(normalizeAgentPresetForExtension).filter(Boolean) as Array<{
        name: string
        vector: boolean
        skills: string[]
        mcpServers: string[]
        rulesFiles: string[]
        modelProvider?: string
        modelId?: string
      }>
    } catch {
      return []
    }
  }

  /** Discover available skills, MCP server names, and rules files for preset builder. Uses same source as Skills tab (loadSkills) so ~/.nexus and all .md are included. */
  private async getAgentPresetOptions(): Promise<{ skills: string[]; mcpServers: string[]; rulesFiles: string[] }> {
    const cwd = this.getCwd()
    const skillDefs = await loadSkills(this.config?.skills ?? [], cwd).catch(() => [])
    const skills = dedupeStringList(skillDefs.map((s) => s.path))
    const fromConfig = (this.config?.mcp?.servers ?? []).map((s) => (s as McpServerConfig).name).filter((n): n is string => Boolean(n?.trim()))
    const discoveredMcp = await discoverMcpServerNamesForExtension(cwd)
    const mcpServers = dedupeStringList([...fromConfig, ...discoveredMcp])
    const rulesFiles = await discoverRuleFilesForExtension(cwd)
    const fromRulesConfig = this.config?.rules?.files ?? []
    const rulesMerged = dedupeStringList([...fromRulesConfig, ...rulesFiles, "AGENTS.md", "CLAUDE.md"])
    return { skills, mcpServers, rulesFiles: rulesMerged }
  }

  private async createAgentPreset(preset: {
    name: string
    vector: boolean
    skills: string[]
    mcpServers: string[]
    rulesFiles: string[]
    modelProvider?: string
    modelId?: string
  }): Promise<void> {
    const cwd = this.getCwd()
    const normalized = normalizeAgentPresetForExtension({
      ...preset,
      createdAt: Date.now(),
    })
    if (!normalized) return
    const presets = await this.readAgentPresets()
    const filtered = presets.filter((p) => p.name !== normalized.name)
    await writeAgentPresetsForExtension(cwd, [normalized, ...filtered])
    vscode.window.showInformationMessage(`NexusCode: Preset "${normalized.name}" created.`, { modal: false })
  }

  private async deleteAgentPreset(presetName: string): Promise<void> {
    const cwd = this.getCwd()
    const presets = await this.readAgentPresets()
    const next = presets.filter((p) => p.name !== presetName)
    if (next.length === presets.length) {
      vscode.window.showWarningMessage(`NexusCode: Preset "${presetName}" not found.`, { modal: false })
      return
    }
    await writeAgentPresetsForExtension(cwd, next)
    vscode.window.showInformationMessage(`NexusCode: Preset "${presetName}" deleted.`, { modal: false })
  }

  /** Apply an agent preset by name: merge vector, skills, MCP, rules (and optional model) into config and save. "Default" = restore initial full config. */
  private async applyAgentPreset(presetName: string): Promise<void> {
    const trimmed = presetName.trim()
    if (!this.config) {
      vscode.window.showWarningMessage("NexusCode: No config loaded.", { modal: false })
      return
    }
    if (trimmed === "Default" || trimmed === "") {
      const snap = this.initialFullConfigSnapshot
      if (!snap) {
        vscode.window.showWarningMessage("NexusCode: Default preset not available (no initial config snapshot).", { modal: false })
        return
      }
      const updates: Partial<NexusConfig> = {
        indexing: { ...this.config.indexing, ...snap.indexing },
        skills: snap.skills,
        mcp: { servers: [...snap.mcp.servers] },
        rules: { files: snap.rules.files.length > 0 ? [...snap.rules.files] : ["AGENTS.md", "CLAUDE.md"] },
      }
      await this.handleSaveConfig(updates)
      vscode.window.showInformationMessage("NexusCode: Applied preset \"Default\" (all skills, MCP, rules).", { modal: false })
      return
    }
    const presets = await this.readAgentPresets()
    const preset = presets.find((p) => p.name === trimmed)
    if (!preset) {
      vscode.window.showWarningMessage(`NexusCode: Preset "${trimmed}" not found.`, { modal: false })
      return
    }
    const current = this.config
    const namedServers = (current.mcp?.servers ?? []).map((s) => ({ name: (s as McpServerConfig).name ?? "", server: s }))
    const selectedServers = namedServers
      .filter((item) => item.name && preset.mcpServers.includes(item.name))
      .map((item) => item.server)
    const updates: Partial<NexusConfig> = {
      indexing: {
        ...current.indexing,
        vector: preset.vector,
      },
      skills: preset.skills,
      mcp: { servers: selectedServers.length > 0 ? selectedServers : current.mcp?.servers ?? [] },
      rules: { files: preset.rulesFiles.length > 0 ? preset.rulesFiles : ["AGENTS.md", "CLAUDE.md"] },
    }
    if (preset.modelProvider && preset.modelId) {
      updates.model = { ...current.model, provider: preset.modelProvider, id: preset.modelId }
    }
    await this.handleSaveConfig(updates)
    vscode.window.showInformationMessage(`NexusCode: Applied preset "${trimmed}".`, { modal: false })
  }

  private async handleSaveConfig(patch: Partial<NexusConfig>): Promise<void> {
    if (!this.config || !patch) return
    const modelPatch = (patch as Record<string, unknown>).model as Record<string, unknown> | undefined
    if (modelPatch && (modelPatch.apiKey === "" || modelPatch.apiKey === undefined)) {
      const existing = (this.config as Record<string, unknown>).model as Record<string, unknown> | undefined
      if (existing?.apiKey) modelPatch.apiKey = existing.apiKey
    }
    if (modelPatch && (modelPatch.baseUrl === "" || modelPatch.baseUrl === undefined)) {
      const existing = (this.config as Record<string, unknown>).model as Record<string, unknown> | undefined
      if (existing?.baseUrl) modelPatch.baseUrl = existing.baseUrl
    }
    const indexBefore = JSON.stringify({
      indexing: this.config.indexing,
      vectorDb: this.config.vectorDb,
      embeddings: this.config.embeddings,
    })
    const mcpBefore = JSON.stringify({ mcp: this.config.mcp })
    deepMergeInto(this.config as Record<string, unknown>, patch as Record<string, unknown>)
    this.defaultModelProfile = { ...this.config.model }
    if (patch.profiles && typeof patch.profiles === "object") {
      writeGlobalProfiles(patch.profiles as Record<string, unknown>)
    }
    const cwd = this.getCwd()
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage(
        "NexusCode: Open a workspace folder first so settings can be saved to .nexus/nexus.yaml in the project.",
        { modal: false }
      )
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
      this.postStateToWebview()
      return
    }
    try {
      await persistSecretsFromConfig(this.config as Record<string, unknown>, this.secretsStore)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to save API keys — ${message}`)
    }
    const toWrite = { ...this.config } as Record<string, unknown>
    if (toWrite.skillsConfig && Array.isArray(toWrite.skillsConfig)) {
      toWrite.skills = (toWrite.skillsConfig as Array<{ path: string; enabled: boolean }>).map((s) =>
        s.enabled ? s.path : { path: s.path, enabled: false }
      )
      delete toWrite.skillsConfig
    }
    try {
      writeConfig(toWrite as NexusConfig, cwd)
      vscode.window.showInformationMessage("NexusCode: Settings saved.", { modal: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to save settings — ${message}`)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `Save failed: ${message}` } })
    }
    const mcpAfter = JSON.stringify({ mcp: this.config.mcp })
    if (mcpBefore !== mcpAfter) {
      void this.reconnectMcpServers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
      })
    }
    const indexAfter = JSON.stringify({
      indexing: this.config.indexing,
      vectorDb: this.config.vectorDb,
      embeddings: this.config.embeddings,
    })
    if (indexBefore !== indexAfter) {
      void this.initializeIndexer(cwd).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
      })
    }
    this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
    this.postStateToWebview()
  }

  private getModeReminder(_mode: Mode): string {
    // Not shown in UI; mode is enforced via system prompt and API mode parameter only.
    return ""
  }

  private async runAgent(content: string, mode?: Mode): Promise<void> {
    if (this.isRunning) return
    if (!this.session || !this.config) {
      this.isRunning = false
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: "NexusCode is still initializing. Please retry in a moment." },
      })
      this.postStateToWebview()
      return
    }
    this.mode = mode ?? this.mode
    this.lastRunMode = this.mode
    this.abortController = new AbortController()
    this.isRunning = true

    let actualContent = content
    let createSkillMode = false
    let configForRun = this.config
    if (content.trim().toLowerCase().startsWith("/create-skill")) {
      createSkillMode = true
      actualContent = content.replace(/^\/create-skill\s*/i, "").trim() || "Describe what you want the skill to do."
      configForRun = {
        ...this.config,
        permissions: {
          ...this.config.permissions,
          rules: [
            ...this.config.permissions.rules,
            { tool: "write_to_file", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "replace_in_file", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "write_to_file", pathPattern: ".cursor/skills/**", action: "allow" as const },
            { tool: "replace_in_file", pathPattern: ".cursor/skills/**", action: "allow" as const },
          ],
        },
      }
    }

    // Do NOT prepend mode reminder to user message — mode is in system prompt and API; keeps UI clean.
    this.session.addMessage({ role: "user", content: actualContent })
    this.postStateToWebview()

    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()

    if (serverUrl) {
      try {
        let sid = this.serverSessionId
        if (!sid) {
          const createRes = await fetch(`${serverUrl.replace(/\/$/, "")}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
            body: "{}",
          })
          if (!createRes.ok) throw new Error(`Server create session: ${createRes.status}`)
          const created = (await createRes.json()) as { id: string }
          sid = created.id
          this.serverSessionId = sid
        }
        const res = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sid}/message?directory=${encodeURIComponent(cwd)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
            body: JSON.stringify({ content, mode: this.mode }),
            signal: this.abortController!.signal,
          }
        )
        if (!res.ok) {
          this.postMessageToWebview({
            type: "agentEvent",
            event: { type: "error", error: `Server: ${res.status} ${await res.text()}` },
          })
          this.isRunning = false
          this.postStateToWebview()
          return
        }
        const reader = res.body?.getReader()
        if (!reader) {
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: "No response body" } })
          this.isRunning = false
          this.postStateToWebview()
          return
        }
        const decoder = new TextDecoder()
        let buffer = ""
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              const t = line.trim()
              if (!t) continue
              try {
                const event = JSON.parse(t) as AgentEvent
                if (
                  event.type === "tool_end" &&
                  event.success &&
                  (event.tool === "write_to_file" || event.tool === "replace_in_file") &&
                  event.path &&
                  typeof (event as AgentEvent & { writtenContent?: string }).writtenContent === "string"
                ) {
                  const absPath = path.isAbsolute(event.path) ? event.path : path.join(cwd, event.path)
                  let dir = path.dirname(absPath)
                  const toCreate: string[] = []
                  while (dir !== cwd && dir.length > cwd.length) {
                    toCreate.push(dir)
                    dir = path.dirname(dir)
                  }
                  toCreate.reverse()
                  for (const p of toCreate) {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(p)).catch(() => {})
                  }
                  const uri = vscode.Uri.file(absPath)
                  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode((event as AgentEvent & { writtenContent: string }).writtenContent)).catch(() => {})
                }
                this.postMessageToWebview({ type: "agentEvent", event })
              } catch {}
            }
          }
          for (const line of buffer.split("\n")) {
            const t = line.trim()
            if (!t) continue
            try {
              const event = JSON.parse(t) as AgentEvent
              if (
                event.type === "tool_end" &&
                event.success &&
                (event.tool === "write_to_file" || event.tool === "replace_in_file") &&
                event.path &&
                typeof (event as AgentEvent & { writtenContent?: string }).writtenContent === "string"
              ) {
                const absPath = path.isAbsolute(event.path) ? event.path : path.join(cwd, event.path)
                let dir = path.dirname(absPath)
                const toCreate: string[] = []
                while (dir !== cwd && dir.length > cwd.length) {
                  toCreate.push(dir)
                  dir = path.dirname(dir)
                }
                toCreate.reverse()
                for (const p of toCreate) {
                  await vscode.workspace.fs.createDirectory(vscode.Uri.file(p)).catch(() => {})
                }
                const uri = vscode.Uri.file(absPath)
                await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode((event as AgentEvent & { writtenContent: string }).writtenContent)).catch(() => {})
              }
              this.postMessageToWebview({ type: "agentEvent", event })
            } catch {}
          }
        } finally {
          reader.releaseLock()
        }
        try {
          const metaRes = await fetch(
            `${serverUrl.replace(/\/$/, "")}/session/${sid}?directory=${encodeURIComponent(cwd)}`,
            { headers: { "x-nexus-directory": cwd } }
          )
          if (metaRes.ok) {
            const meta = (await metaRes.json()) as { messageCount: number }
            const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
            const msgRes = await fetch(
              `${serverUrl.replace(/\/$/, "")}/session/${sid}/message?directory=${encodeURIComponent(cwd)}&limit=${INITIAL_SERVER_MESSAGES}&offset=${offset}`,
              { headers: { "x-nexus-directory": cwd } }
            )
            if (msgRes.ok) {
              const messages = (await msgRes.json()) as SessionMessage[]
              this.session = new Session(sid!, cwd, messages)
              this.serverSessionOldestLoadedOffset = offset
            }
          }
        } catch {}
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes("abort")) {
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: msg } })
        }
      } finally {
        this.isRunning = false
        this.postStateToWebview()
      }
      return
    }

    const host = new VsCodeHost(cwd, (event: AgentEvent) => {
      this.postMessageToWebview({ type: "agentEvent", event })
      if (event.type === "tool_approval_needed") {
        this.postMessageToWebview({
          type: "pendingApproval",
          partId: event.partId,
          action: event.action,
        })
      }
      if (event.type === "error") {
        this.isRunning = false
        this.postStateToWebview()
      }
      // Sync full state after tool_end so webview gets latest todo (update_todo_list) and messages
      if (event.type === "tool_end") {
        this.postStateToWebview()
        // Keep editor "memory" in sync with disk: after a successful file write, reload the doc if open so it's not dirty
        if (
          event.success &&
          "path" in event &&
          typeof (event as { path?: string }).path === "string" &&
          ((event as { path?: string }).path as string).length > 0 &&
          (event.tool === "write_to_file" || event.tool === "replace_in_file")
        ) {
          const filePath = (event as { path: string }).path
          const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
          const uri = vscode.Uri.file(absPath)
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath)
          if (doc?.isDirty) {
            void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }).then(() =>
              vscode.commands.executeCommand("workbench.action.files.revert")
            )
          }
        }
      }
    }, { useWebviewApproval: true, approvalResolveRef: this.approvalResolveRef, onCheckpointEntriesUpdated: () => this.postStateToWebview() })

    const timeoutMs = 10 * 60_000
    const timeout = setTimeout(() => {
      if (!this.isRunning) return
      this.abortController?.abort()
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: `LLM request timed out after ${Math.round(timeoutMs / 60000)} minutes.` },
      })
    }, timeoutMs)

    try {
      // MCP (started in ensureInitialized), rules, skills in parallel so first message is faster.
      // Cap MCP wait so first message is not blocked when vector is off or MCP servers are slow.
      const MCP_FIRST_MESSAGE_TIMEOUT_MS = 2500
      const mcpP = this.mcpReconnectPromise
        ? Promise.race([
            this.mcpReconnectPromise,
            new Promise<void>((r) => setTimeout(r, MCP_FIRST_MESSAGE_TIMEOUT_MS)),
          ])
        : Promise.resolve()
      const rulesP = loadRules(cwd, configForRun.rules.files).catch(() => "")
      const skillsP = loadSkills(configForRun.skills, cwd).catch(() => [])
      const RULES_SKILLS_TIMEOUT_MS = 2000
      const rulesAndSkillsP = Promise.race([
        Promise.all([rulesP, skillsP]).then(([rulesContent, skills]) => ({ type: "ok" as const, rulesContent, skills })),
        new Promise<{ type: "timeout" }>((r) => setTimeout(() => r({ type: "timeout" }), RULES_SKILLS_TIMEOUT_MS)),
      ])
      const [, rulesAndSkillsResult] = await Promise.all([mcpP, rulesAndSkillsP])
      const rulesContent = rulesAndSkillsResult.type === "ok" ? rulesAndSkillsResult.rulesContent : ""
      const skills = rulesAndSkillsResult.type === "ok" ? rulesAndSkillsResult.skills : []

      const client = createLLMClient(configForRun.model)
      const toolRegistry = new ToolRegistry()
      if (this.mcpClient) {
        for (const tool of this.mcpClient.getTools()) {
          toolRegistry.register(tool)
        }
      }
      const parallelManager = new ParallelAgentManager()
      toolRegistry.register(createSpawnAgentTool(parallelManager, configForRun))
      const { builtin: tools, dynamic } = toolRegistry.getForMode(this.mode)
      const allTools = [...tools, ...dynamic]
      const compaction = createCompaction()
      if (configForRun.checkpoint.enabled && !this.checkpoint) {
        this.checkpoint = new CheckpointTracker(this.session.id, cwd)
        void this.checkpoint.init(configForRun.checkpoint.timeoutMs).catch(console.warn)
      }
      if (this.checkpoint) {
        host.setCheckpoint(this.checkpoint)
      }
      try {
        void this.refreshIndexerFromGit(cwd)
      } catch {
        // Git not available or not a repo — skip incremental refresh
      }
      await runAgentLoop({
        session: this.session,
        client,
        host,
        config: configForRun,
        mode: this.mode,
        tools: allTools,
        skills,
        rulesContent,
        indexer: this.indexer,
        compaction,
        signal: this.abortController!.signal,
        checkpoint: this.checkpoint,
        createSkillMode,
      })
    } catch (err) {
      const errMsg = (err as Error).message
      if (errMsg !== "AbortError" && !errMsg.includes("aborted")) {
        console.error("[nexus] Agent loop error:", err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: errMsg } })
      }
    } finally {
      clearTimeout(timeout)
      this.isRunning = false
      await this.session!.save().catch(() => {})
      this.postStateToWebview()
      if (this.session && hadPlanExit(this.session)) {
        void this.showPlanFollowup(cwd).catch(() => {})
      }
    }
  }

  private async showPlanFollowup(cwd: string): Promise<void> {
    if (!this.session) return
    const planText = await getPlanContentForFollowup(this.session, cwd)
    const choice = await vscode.window.showQuickPick(
      [
        { label: "New session", description: "Implement in a fresh session with a clean context" },
        { label: "Continue here", description: "Implement the plan in this session" },
        { label: "Dismiss", description: "Do nothing" },
      ],
      { title: "Ready to implement?", placeHolder: "Plan is ready. Implement now?" }
    )
    if (!choice || choice.label === "Dismiss") return
    if (choice.label === "New session") {
      this.session = Session.create(cwd)
      this.serverSessionId = undefined
      this.mode = "agent"
      this.postStateToWebview()
      await this.runAgent(`Implement the following plan:\n\n${planText}`, "agent")
    } else {
      this.mode = "agent"
      this.postStateToWebview()
      await this.runAgent("Implement the plan above.", "agent")
    }
  }

  private getNexusRoot(): string | null {
    try {
      const root = path.resolve(this.context.extensionPath, "..", "..")
      const startPath = path.join(root, "sources", "claude-context-mode", "start.mjs")
      return fs.existsSync(startPath) ? root : null
    } catch {
      return null
    }
  }

  private getResolvedMcpServers(): McpServerConfig[] {
    if (!this.config?.mcp.servers.length) return []
    const cwd = this.getCwd()
    const nexusRoot = this.getNexusRoot()
    return resolveBundledMcpServers(this.config.mcp.servers, { cwd, nexusRoot })
  }

  private async reconnectMcpServers(): Promise<void> {
    if (!this.config) return
    if (!this.mcpClient) {
      this.mcpClient = new McpClient()
      setMcpClientInstance(this.mcpClient)
    }
    await this.mcpClient.disconnectAll().catch(() => {})
    if (this.config.mcp.servers.length === 0) return
    const resolved = this.getResolvedMcpServers()
    process.env.CLAUDE_PROJECT_DIR = this.getCwd()
    await this.mcpClient.connectAll(resolved).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
    })
    const status = this.mcpClient.getStatus()
    this.postMessageToWebview({
      type: "mcpServerStatus",
      results: this.config.mcp.servers.map((s) => ({
        name: s.name,
        status: status[s.name] === "connected" ? ("ok" as const) : ("error" as const),
        error: status[s.name] === "connected" ? undefined : "Not connected",
      })),
    })
  }

  private async compactHistory(): Promise<void> {
    if (!this.session || !this.config) return
    if (this.getServerUrl()) {
      vscode.window.showInformationMessage("NexusCode: Compaction is not supported when using NexusCode Server.")
      return
    }
    const client = createLLMClient(this.config.model)
    const compaction = createCompaction()
    this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_start" } })
    try {
      await compaction.compact(this.session, client)
    } finally {
      this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_end" } })
      this.postStateToWebview()
    }
  }

  async reindex(): Promise<void> {
    if (!this.indexer || !this.config) return
    try {
      await this.indexer.reindex()
    } catch (err) {
      console.warn("[nexus] Reindex error:", err)
    }
  }

  async clearIndex(): Promise<void> {
    if (!this.config || !this.config.indexing.enabled) return
    const cwd = this.getCwd()
    await this.initializeIndexer(cwd)
    await this.indexer?.reindex()
    this.sendIndexStatus()
    this.postStateToWebview()
  }

  addToChat(text: string): void {
    this.postMessageToWebview({ type: "addToChatContent", content: text })
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
  }

  async runAgentWithPrompt(content: string, mode?: Mode): Promise<void> {
    await this.ensureInitialized()
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
    await this.runAgent(content, mode)
  }

  private sendIndexStatus(status?: IndexStatus): void {
    const s = status ?? this.indexer?.status() ?? { state: "idle" as const }
    this.postMessageToWebview({ type: "indexStatus", status: s })
  }

  private async sendSessionList(): Promise<void> {
    const serverUrl = this.getServerUrl()
    const cwd = this.getCwd()
    this.postMessageToWebview({ type: "sessionListLoading", loading: true })
    try {
      if (serverUrl) {
        try {
          const res = await fetch(
            `${serverUrl.replace(/\/$/, "")}/session?directory=${encodeURIComponent(cwd)}`,
            { headers: { "x-nexus-directory": cwd } }
          )
          if (res.ok) {
            const sessions = (await res.json()) as Array<{ id: string; ts: number; title?: string; messageCount: number }>
            this.postMessageToWebview({ type: "sessionList", sessions })
            return
          }
        } catch {}
      }
      const sessions = await listSessions(cwd).catch(() => [])
      this.postMessageToWebview({ type: "sessionList", sessions })
    } finally {
      this.postMessageToWebview({ type: "sessionListLoading", loading: false })
    }
  }

  private async loadOlderMessages(): Promise<void> {
    const serverUrl = this.getServerUrl()
    const cwd = this.getCwd()
    if (
      !serverUrl ||
      !this.session ||
      this.session.id !== this.serverSessionId ||
      this.serverSessionOldestLoadedOffset == null ||
      this.serverSessionOldestLoadedOffset <= 0
    ) {
      return
    }
    const limit = Math.min(INITIAL_SERVER_MESSAGES, this.serverSessionOldestLoadedOffset)
    if (limit <= 0) return
    this.loadingOlderMessages = true
    this.postStateToWebview()
    try {
      const msgRes = await fetch(
        `${serverUrl.replace(/\/$/, "")}/session/${this.session.id}/message?directory=${encodeURIComponent(cwd)}&limit=${limit}&offset=0`,
        { headers: { "x-nexus-directory": cwd } }
      )
      if (!msgRes.ok) return
      const olderMessages = (await msgRes.json()) as SessionMessage[]
      if (olderMessages.length === 0) return
      this.session = new Session(this.session.id, cwd, [...olderMessages, ...this.session.messages])
      this.serverSessionOldestLoadedOffset -= olderMessages.length
    } finally {
      this.loadingOlderMessages = false
      this.postStateToWebview()
    }
  }

  private async switchSession(sessionId: string): Promise<void> {
    this.lastRunMode = null
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const metaRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}?directory=${encodeURIComponent(cwd)}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!metaRes.ok) return
        const meta = (await metaRes.json()) as { messageCount: number }
        const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
        const msgRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}/message?directory=${encodeURIComponent(cwd)}&limit=${INITIAL_SERVER_MESSAGES}&offset=${offset}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!msgRes.ok) return
        const messages = (await msgRes.json()) as SessionMessage[]
        this.session = new Session(sessionId, cwd, messages)
        this.serverSessionId = sessionId
        this.serverSessionOldestLoadedOffset = offset
        this.checkpoint = undefined
        this.postStateToWebview()
      } catch {}
      return
    }
    const loaded = await Session.resume(sessionId, cwd)
    if (loaded) {
      this.session = loaded
      this.serverSessionId = undefined
      this.serverSessionOldestLoadedOffset = undefined
      this.checkpoint = undefined
      this.postStateToWebview()
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    let deleted = false
    if (serverUrl) {
      try {
        const res = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}?directory=${encodeURIComponent(cwd)}`,
          { method: "DELETE", headers: { "x-nexus-directory": cwd } }
        )
        deleted = res.ok
      } catch {
        // fall through to sendSessionList
      }
    } else {
      deleted = await deleteSession(sessionId, cwd)
    }
    if (deleted && this.session?.id === sessionId) {
      if (serverUrl) {
        try {
          const createRes = await fetch(`${serverUrl.replace(/\/$/, "")}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
            body: "{}",
          })
          if (createRes.ok) {
            const created = (await createRes.json()) as { id: string }
            this.session = new Session(created.id, cwd, [])
            this.serverSessionId = created.id
            this.serverSessionOldestLoadedOffset = undefined
          }
        } catch {
          // keep current session ref; list will refresh
        }
      } else {
        this.session = Session.create(cwd)
        this.serverSessionId = undefined
      }
      this.checkpoint = undefined
      this.postStateToWebview()
    }
    await this.sendSessionList()
  }

  private applyVscodeOverrides(config: NexusConfig): void {
    const cfg = vscode.workspace.getConfiguration("nexuscode")
    const provider = cfg.get<string>("provider")
    if (provider != null && provider !== "") {
      if (provider === "openrouter") {
        config.model.provider = "openai-compatible"
        if (!config.model.baseUrl) config.model.baseUrl = "https://openrouter.ai/api/v1"
      } else {
        config.model.provider = provider as NexusConfig["model"]["provider"]
      }
    }
    const model = cfg.get<string>("model")
    if (model != null && model !== "") config.model.id = model
    const apiKey = cfg.get<string>("apiKey")
    if (apiKey != null && apiKey !== "") config.model.apiKey = apiKey
    const baseUrl = cfg.get<string>("baseUrl")
    if (baseUrl != null && baseUrl !== "") config.model.baseUrl = baseUrl
    const temperature = cfg.get<number>("temperature")
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      config.model.temperature = Math.max(0, Math.min(2, temperature))
    }
    const enableCheckpoints = cfg.get<boolean>("enableCheckpoints")
    if (typeof enableCheckpoints === "boolean") config.checkpoint.enabled = enableCheckpoints
    const autoApproveRead = cfg.get<boolean>("autoApproveRead")
    if (typeof autoApproveRead === "boolean") config.permissions.autoApproveRead = autoApproveRead
    const autoApproveWrite = cfg.get<boolean>("autoApproveWrite")
    if (typeof autoApproveWrite === "boolean") config.permissions.autoApproveWrite = autoApproveWrite
    const autoApproveCommand = cfg.get<boolean>("autoApproveCommand")
    if (typeof autoApproveCommand === "boolean") config.permissions.autoApproveCommand = autoApproveCommand
  }

  private async initializeIndexer(cwd: string): Promise<void> {
    this.indexStatusUnsubscribe?.()
    this.indexStatusUnsubscribe = undefined
    this.indexerFileWatcher?.dispose()
    this.indexerFileWatcher = undefined
    this.indexer?.close()
    this.indexer = undefined
    if (!this.config?.indexing.enabled) {
      this.sendIndexStatus({ state: "idle" })
      return
    }
    // Same as server run-session: short timeout so first message is not delayed (Qdrant default is 20s).
    const INDEXER_CREATE_TIMEOUT_MS = 2500
    this.indexer = await Promise.race([
      createCodebaseIndexer(cwd, this.config, {
        onWarning: (message: string) => console.warn(message),
        maxQdrantWaitMs: INDEXER_CREATE_TIMEOUT_MS,
      }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), INDEXER_CREATE_TIMEOUT_MS)),
    ])
    if (!this.indexer) {
      console.warn("[nexus] Indexer creation timed out; running without vector search.")
      this.sendIndexStatus({ state: "idle" })
      return
    }
    this.indexStatusUnsubscribe = this.indexer.onStatusChange((status: IndexStatus) => {
      this.sendIndexStatus(status)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "index_update", status } })
    })
    this.indexer.startIndexing().catch((err: unknown) => console.warn("[nexus] Indexer start error:", err))

    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(cwd),
      "**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,c,cpp,h,hpp,cs,rb,php,swift,kt,scala,md,mdx}"
    )
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    watcher.onDidChange((uri) => this.indexer?.refreshFile(uri.fsPath))
    watcher.onDidCreate((uri) => this.indexer?.refreshFile(uri.fsPath))
    watcher.onDidDelete((uri) => this.indexer?.refreshFileNow(uri.fsPath))
    this.indexerFileWatcher = watcher
  }

  private async refreshIndexerFromGit(cwd: string): Promise<void> {
    if (!this.indexer?.refreshFileNow) return
    const { execa } = await import("execa")
    const runGit = async (args: string[]): Promise<string> => {
      const res = await execa("git", ["-C", cwd, ...args], { reject: false, timeout: 4000 })
      if (res.exitCode !== 0) return ""
      return (res.stdout ?? "").trim()
    }
    const [changedTracked, changedStaged, untracked, deletedTracked, deletedStaged] = await Promise.all([
      runGit(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]),
      runGit(["diff", "--name-only", "--cached", "--diff-filter=ACMRTUXB"]),
      runGit(["ls-files", "--others", "--exclude-standard"]),
      runGit(["diff", "--name-only", "--diff-filter=D", "HEAD"]),
      runGit(["diff", "--name-only", "--cached", "--diff-filter=D"]),
    ])
    const changed = new Set<string>()
    const deleted = new Set<string>()
    for (const line of [changedTracked, changedStaged, untracked].join("\n").split(/\r?\n/)) {
      const p = line.trim()
      if (p) changed.add(p)
    }
    for (const line of [deletedTracked, deletedStaged].join("\n").split(/\r?\n/)) {
      const p = line.trim()
      if (p) deleted.add(p)
    }
    const all = [...changed, ...deleted].slice(0, 512)
    for (let i = 0; i < all.length; i += 16) {
      const chunk = all.slice(i, i + 16)
      await Promise.allSettled(
        chunk.map((relPath) => this.indexer!.refreshFileNow!(path.resolve(cwd, relPath)))
      )
    }
  }

  dispose(): void {
    this.abortController?.abort()
    this.indexStatusUnsubscribe?.()
    this.indexerFileWatcher?.dispose()
    this.indexerFileWatcher = undefined
    this.indexer?.close()
    this.indexer = undefined
    this.mcpClient?.disconnectAll().catch(() => {})
    this.mcpClient = undefined
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
    this.initialized = false
    this.initPromise = undefined
  }
}

function deepMergeInto<T extends Record<string, unknown>>(target: T, patch: Partial<T>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = target[key as keyof T]
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      deepMergeInto(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      (target as Record<string, unknown>)[key] = value as unknown
    }
  }
  return target
}

type AgentPresetForExtension = {
  name: string
  vector: boolean
  skills: string[]
  mcpServers: string[]
  rulesFiles: string[]
  modelProvider?: string
  modelId?: string
}

function normalizeAgentPresetForExtension(value: unknown): AgentPresetForExtension | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null
  return {
    name,
    modelProvider: typeof raw.modelProvider === "string" ? raw.modelProvider : undefined,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined,
    vector: Boolean(raw.vector),
    skills: asStringList(raw.skills),
    mcpServers: asStringList(raw.mcpServers),
    rulesFiles: asStringList(raw.rulesFiles),
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of value) {
    if (typeof v !== "string") continue
    const s = v.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function dedupeStringList(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of items) {
    const t = s.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

async function walkSkillFilesForExtension(rootDir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return []
  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkSkillFilesForExtension(fullPath, maxDepth - 1)
      out.push(...nested)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.toLowerCase() === "skill.md") out.push(fullPath)
  }
  return out
}

function toDisplayPathForExtension(filePath: string, projectDir: string): string {
  if (path.isAbsolute(filePath) && filePath.startsWith(projectDir)) {
    return path.relative(projectDir, filePath) || filePath
  }
  return filePath
}

async function discoverSkillPathsForExtension(projectDir: string): Promise<string[]> {
  const roots = [
    path.join(projectDir, ".nexus", "skills"),
    path.join(projectDir, ".agents", "skills"),
    path.join(path.resolve(process.env.HOME || os.homedir()), ".nexus", "skills"),
    path.join(path.resolve(process.env.HOME || os.homedir()), ".agents", "skills"),
  ]
  const files: string[] = []
  for (const root of roots) {
    const fromRoot = await walkSkillFilesForExtension(root, 5)
    files.push(...fromRoot)
  }
  const normalized = dedupeStringList(files.map((f) => toDisplayPathForExtension(f, projectDir)))
  return normalized
}

async function discoverRuleFilesForExtension(projectDir: string): Promise<string[]> {
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
      try {
        const stat = await fsPromises.stat(file)
        if (stat.isFile()) out.push(file)
      } catch {
        // skip
      }
    }
    if (current === path.dirname(current) || current === home) break
    current = path.dirname(current)
  }
  for (const name of names) {
    const file = path.join(home, name)
    try {
      const stat = await fsPromises.stat(file)
      if (stat.isFile()) out.push(file)
    } catch {
      // skip
    }
  }
  return dedupeStringList(out)
}

/** Discover MCP server names from project .nexus/mcp-servers.json and ~/.nexus/mcp-servers.json (same sources as config merge). */
async function discoverMcpServerNamesForExtension(projectDir: string): Promise<string[]> {
  const names: string[] = []
  const readJson = async (filePath: string): Promise<string[]> => {
    try {
      const content = await fsPromises.readFile(filePath, "utf8")
      const data = JSON.parse(content)
      const servers = Array.isArray(data) ? data : (data?.servers ?? data?.mcp?.servers)
      if (!Array.isArray(servers)) return []
      return servers
        .map((s: unknown) => (s && typeof s === "object" && "name" in s && typeof (s as { name: unknown }).name === "string" ? (s as { name: string }).name.trim() : ""))
        .filter((n: string) => n.length > 0)
    } catch {
      return []
    }
  }
  const projectPath = path.join(projectDir, ".nexus", "mcp-servers.json")
  const globalPath = path.join(os.homedir(), ".nexus", "mcp-servers.json")
  const [fromProject, fromGlobal] = await Promise.all([readJson(projectPath), readJson(globalPath)])
  names.push(...fromProject, ...fromGlobal)
  return dedupeStringList(names)
}

async function writeAgentPresetsForExtension(
  projectDir: string,
  presets: Array<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }>
): Promise<void> {
  const dir = path.join(projectDir, ".nexus")
  const filePath = path.join(dir, "agent-configs.json")
  await fsPromises.mkdir(dir, { recursive: true })
  await fsPromises.writeFile(filePath, JSON.stringify({ presets }, null, 2), "utf8")
}
