/**
 * Controller — Cline-style single owner of task/session state and agent run.
 * Owns session, config, run state, and posts state/events to webview via postMessage.
 */

import * as vscode from "vscode"
import * as path from "path"
import type { AgentEvent, NexusConfig, Mode, SessionMessage, IndexStatus } from "@nexuscode/core"
import type { ApprovalAction, PermissionResult, CheckpointEntry } from "@nexuscode/core"
import {
  loadConfig,
  writeConfig,
  writeGlobalProfiles,
  loadProjectSettings,
  Session,
  listSessions,
  deleteSession,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadRules,
  McpClient,
  setMcpClientInstance,
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
} from "@nexuscode/core"
import { VsCodeHost, showDiffForPath } from "./host.js"

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
  | { type: "approvalResponse"; partId: string; approved: boolean; alwaysApprove?: boolean; addToAllowedCommand?: string }
  | { type: "openExternal"; url: string }
  | { type: "showConfirm"; id: string; message: string }
  | { type: "openNexusignore" }
  | { type: "getModelsCatalog" }
  | { type: "restoreCheckpoint"; hash: string }

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatus }
  | { type: "configLoaded"; config: NexusConfig }
  | { type: "addToChatContent"; content: string }
  | { type: "action"; action: "switchView"; view: "chat" | "sessions" | "settings" }
  | { type: "mcpServerStatus"; results: Array<{ name: string; status: "ok" | "error"; error?: string }> }
  | { type: "pendingApproval"; partId: string; action: ApprovalAction }
  | { type: "confirmResult"; id: string; ok: boolean }
  | { type: "modelsCatalog"; catalog: import("@nexuscode/core").ModelsCatalog }

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
  checkpointEntries?: CheckpointEntry[]
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
  private mode: Mode = "agent"
  private isRunning = false
  private abortController?: AbortController
  private checkpoint?: CheckpointTracker
  private indexer?: CodebaseIndexer
  private mcpClient?: McpClient
  private serverSessionId?: string
  private initialized = false
  private initPromise?: Promise<void>
  private modelsCatalogCache: import("@nexuscode/core").ModelsCatalog | null = null
  private indexStatusUnsubscribe?: () => void
  private disposables: vscode.Disposable[] = []
  private approvalResolveRef: { current: ((r: PermissionResult) => void) | null } = { current: null }

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
    return {
      messages: this.session.messages,
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
      checkpointEntries: this.checkpoint?.getEntries() ?? [],
    }
  }

  /** Push current state to webview (Cline-style postStateToWebview). */
  postStateToWebview(): void {
    const state = this.getStateToPostToWebview()
    this.postMessageToWebview({ type: "stateUpdate", state })
  }

  /** Clear current task/session and reset run state. */
  async clearTask(): Promise<void> {
    this.abortController?.abort()
    this.session = undefined
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
        this.config = await loadConfig(cwd)
      } catch {
        this.config = undefined
      }
      if (!this.config) {
        try {
          this.config = await loadConfig(process.cwd())
        } catch {}
      }
      if (!this.config) {
        this.config = NexusConfigSchema.parse({}) as NexusConfig
      }
      // Merge project allowlist from .nexus/allowed-commands.json
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
      // Merge .nexus/settings.json + settings.local.json (like .claude)
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
      // Send config to webview immediately so Settings open fast; session/MCP/indexer continue in background
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
      try {
        this.session = Session.create(cwd)
        this.postStateToWebview()
        this.sendIndexStatus()
        void this.reconnectMcpServers().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
        })
        void this.initializeIndexer(cwd).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
        })
        // Load models catalog in background so Settings open immediately
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
      } catch (err) {
        console.warn("[nexus] Init error:", err)
        this.postStateToWebview()
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
            this.postStateToWebview()
            break
          }
          const profile = this.config.profiles[msg.profile]
          if (!profile) break
          this.config.model = { ...this.config.model, ...profile }
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
          this.postStateToWebview()
        }
        break
      case "getState":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) this.postMessageToWebview({ type: "configLoaded", config: this.config })
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
        if (this.config) this.postMessageToWebview({ type: "configLoaded", config: this.config })
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
      case "deleteSession":
        await this.deleteSession(msg.sessionId)
        break
      case "forkSession":
        if (this.session && msg.messageId) {
          this.session = this.session.fork(msg.messageId) as Session
          if (this.getServerUrl()) this.serverSessionId = undefined
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
        const uri = vscode.Uri.file(absPath)
        const line = Math.max(0, (msg.line ?? 1) - 1)
        const endLine = msg.endLine != null ? Math.max(0, msg.endLine - 1) : line
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(line, 0, endLine, 0),
            preview: false,
          })
          // If the file was already open with unsaved (e.g. stale) content, revert to disk
          // so the user sees what the agent wrote and isn't prompted to save on close.
          if (doc.isDirty) {
            await vscode.commands.executeCommand("workbench.action.files.revert")
          }
          editor.revealRange(new vscode.Range(line, 0, endLine, 0), vscode.TextEditorRevealType.InCenter)
        } catch {
          vscode.window.showErrorMessage(`NexusCode: Could not open ${msg.path}`)
        }
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
            await vscode.window.showTextDocument(doc, { preview: false })
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
          await vscode.window.showTextDocument(doc, { preview: false })
        } else {
          const wsEdit = new vscode.WorkspaceEdit()
          wsEdit.createFile(uri, { ignoreIfExists: true })
          await vscode.workspace.applyEdit(wsEdit)
          const newDoc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(newDoc, { preview: false })
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
        await vscode.window.showTextDocument(doc, { preview: false })
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
          const results = await testMcpServers(this.config.mcp.servers)
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
          await vscode.window.showTextDocument(doc, { preview: false })
        } else {
          const wsEdit = new vscode.WorkspaceEdit()
          wsEdit.createFile(uri, { ignoreIfExists: true })
          await vscode.workspace.applyEdit(wsEdit)
          const newDoc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(newDoc, { preview: false })
        }
        break
      }
      case "restoreCheckpoint":
        if (msg.hash?.trim()) {
          await this.restoreCheckpointToHash(msg.hash.trim())
        }
        break
    }
  }

  /**
   * Restore workspace to a checkpoint (shadow git). After restoring files to disk,
   * reverts any open editor tabs under cwd so their content matches disk (Cline-style).
   */
  private async restoreCheckpointToHash(hash: string): Promise<void> {
    if (!this.checkpoint) {
      vscode.window.showWarningMessage("NexusCode: Checkpoints are not enabled or no checkpoint is available.", { modal: false })
      return
    }
    const cwd = this.getCwd()
    try {
      await this.checkpoint.resetHead(hash)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to restore checkpoint — ${message}`)
      return
    }
    // Sync editor "memory" with disk: revert all open docs under cwd so they show restored content
    const cwdResolved = path.resolve(cwd)
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== "file") continue
      const rel = path.relative(cwdResolved, doc.uri.fsPath)
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue
      if (!doc.isDirty) continue
      try {
        await vscode.window.showTextDocument(doc, { preserveFocus: false })
        await vscode.commands.executeCommand("workbench.action.files.revert")
      } catch {
        // Ignore per-doc revert errors
      }
    }
    vscode.window.showInformationMessage("NexusCode: Workspace restored to checkpoint.", { modal: false })
    this.postStateToWebview()
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
      this.postStateToWebview()
      return
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
    this.postStateToWebview()
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
    this.isRunning = true
    this.abortController = new AbortController()
    this.session.addMessage({ role: "user", content })
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
                this.postMessageToWebview({ type: "agentEvent", event: JSON.parse(t) as AgentEvent })
              } catch {}
            }
          }
          for (const line of buffer.split("\n")) {
            const t = line.trim()
            if (!t) continue
            try {
              this.postMessageToWebview({ type: "agentEvent", event: JSON.parse(t) as AgentEvent })
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
            const offset = Math.max(0, meta.messageCount - 100)
            const msgRes = await fetch(
              `${serverUrl.replace(/\/$/, "")}/session/${sid}/message?directory=${encodeURIComponent(cwd)}&limit=100&offset=${offset}`,
              { headers: { "x-nexus-directory": cwd } }
            )
            if (msgRes.ok) {
              const messages = (await msgRes.json()) as SessionMessage[]
              this.session = new Session(sid!, cwd, messages)
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
            void vscode.window.showTextDocument(doc, { preserveFocus: true }).then(() =>
              vscode.commands.executeCommand("workbench.action.files.revert")
            )
          }
        }
      }
    }, { useWebviewApproval: true, approvalResolveRef: this.approvalResolveRef })

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
      const client = createLLMClient(this.config.model)
      const toolRegistry = new ToolRegistry()
      if (this.mcpClient) {
        for (const tool of this.mcpClient.getTools()) {
          toolRegistry.register(tool)
        }
      }
      const parallelManager = new ParallelAgentManager()
      toolRegistry.register(createSpawnAgentTool(parallelManager, this.config))
      const { builtin: tools, dynamic } = toolRegistry.getForMode(this.mode)
      const allTools = [...tools, ...dynamic]
      const rulesContent = await loadRules(cwd, this.config.rules.files).catch(() => "")
      const skills = await loadSkills(this.config.skills, cwd).catch(() => [])
      const compaction = createCompaction()
      if (this.config.checkpoint.enabled && !this.checkpoint) {
        this.checkpoint = new CheckpointTracker(this.session.id, cwd)
        await this.checkpoint.init(this.config.checkpoint.timeoutMs).catch(console.warn)
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
        config: this.config,
        mode: this.mode,
        tools: allTools,
        skills,
        rulesContent,
        indexer: this.indexer,
        compaction,
        signal: this.abortController!.signal,
        checkpoint: this.checkpoint,
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
    }
  }

  private async reconnectMcpServers(): Promise<void> {
    if (!this.config) return
    if (!this.mcpClient) {
      this.mcpClient = new McpClient()
      setMcpClientInstance(this.mcpClient)
    }
    await this.mcpClient.disconnectAll().catch(() => {})
    if (this.config.mcp.servers.length === 0) return
    await this.mcpClient.connectAll(this.config.mcp.servers).catch((err: unknown) => {
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

  private async switchSession(sessionId: string): Promise<void> {
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
        const offset = Math.max(0, meta.messageCount - 100)
        const msgRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}/message?directory=${encodeURIComponent(cwd)}&limit=100&offset=${offset}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!msgRes.ok) return
        const messages = (await msgRes.json()) as SessionMessage[]
        this.session = new Session(sessionId, cwd, messages)
        this.serverSessionId = sessionId
        this.checkpoint = undefined
        this.postStateToWebview()
      } catch {}
      return
    }
    const loaded = await Session.resume(sessionId, cwd)
    if (loaded) {
      this.session = loaded
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
    this.indexer?.close()
    this.indexer = undefined
    if (!this.config?.indexing.enabled) {
      this.sendIndexStatus({ state: "idle" })
      return
    }
    this.indexer = await createCodebaseIndexer(cwd, this.config, { onWarning: (message: string) => console.warn(message) })
    this.indexStatusUnsubscribe = this.indexer.onStatusChange((status: IndexStatus) => {
      this.sendIndexStatus(status)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "index_update", status } })
    })
    this.indexer.startIndexing().catch((err: unknown) => console.warn("[nexus] Indexer start error:", err))
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
