import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const extensionSource = readFileSync(
  path.join(process.cwd(), "src", "extension.ts"),
  "utf8",
)
const controllerSource = readFileSync(
  path.join(process.cwd(), "src", "controller.ts"),
  "utf8",
)
const workspaceAuthorityConfigSource = readFileSync(
  path.join(process.cwd(), "src", "workspace-authority-config.ts"),
  "utf8",
)
const esbuildSource = readFileSync(
  path.join(process.cwd(), "esbuild.mjs"),
  "utf8",
)
const vscodeIgnore = readFileSync(
  path.join(process.cwd(), ".vscodeignore"),
  "utf8",
)
const inputContextPanelSource = readFileSync(
  path.join(process.cwd(), "webview-ui", "src", "components", "InputContextPanel.tsx"),
  "utf8",
)
const webviewAppSource = readFileSync(
  path.join(process.cwd(), "webview-ui", "src", "App.tsx"),
  "utf8",
)
const messageListSource = readFileSync(
  path.join(process.cwd(), "webview-ui", "src", "components", "MessageList.tsx"),
  "utf8",
)

describe("VS Code command wiring", () => {
  it("does not classify agent diagnostics as server transport failures", () => {
    const start = controllerSource.indexOf(
      "private forwardServerEvent(event: AgentEvent)",
    )
    const end = controllerSource.indexOf(
      "private async restoreSelectedRemoteSession(",
      start,
    )
    const body = controllerSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(body).not.toContain('setServerConnectionState("error"')
    expect(body).toContain("Network/attach errors")
  })

  it("does not present non-file approvals as editable files", () => {
    const genericStart = inputContextPanelSource.indexOf(
      'if (action.type !== "write")',
    )
    const fileApprovalStart = inputContextPanelSource.indexOf(
      "// Pending file approval",
      genericStart,
    )
    expect(genericStart).toBeGreaterThanOrEqual(0)
    expect(fileApprovalStart).toBeGreaterThan(genericStart)
    const genericBranch = inputContextPanelSource.slice(
      genericStart,
      fileApprovalStart,
    )
    expect(genericBranch).toContain("Allow")
    expect(genericBranch).toContain("Deny")
    expect(genericBranch).not.toContain("1 File")
    expect(genericBranch).not.toContain("Undo")
    expect(genericBranch).not.toContain("Keep")
    expect(genericBranch).not.toContain("Review")
  })

  it("does not run the coding agent in an untrusted VS Code workspace", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { capabilities?: { untrustedWorkspaces?: { supported?: boolean } } }

    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(false)
  })

  it("does not ship production extension source maps or packaging scripts", () => {
    expect(esbuildSource).toContain("sourcemap: watch")
    expect(vscodeIgnore).toContain("**/*.map")
    expect(vscodeIgnore).toMatch(/^scripts$/m)
    expect(vscodeIgnore).toContain("vitest.config.*")
  })

  it("ships the cross-platform custom-tool bundler beside the extension", () => {
    expect(esbuildSource).toContain(
      'require.resolve("esbuild-wasm/package.json")',
    )
    expect(esbuildSource).toContain('"runtime",')
    expect(esbuildSource).toContain('"esbuild-wasm",')
    expect(esbuildSource).toContain("filter: /^esbuild-wasm$/")
    expect(esbuildSource).toContain(
      'path: "./runtime/esbuild-wasm/lib/main.js"',
    )
    expect(esbuildSource).toContain("external: true")
  })

  it.each([
    ["nexuscode.newTask", "provider?.createNewSession()"],
    ["nexuscode.compact", "provider?.compact()"],
    ["nexuscode.clearChat", "provider?.clearChat()"],
  ])("%s executes its controller action", (command, action) => {
    const start = extensionSource.indexOf(`registerCommand("${command}"`)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(extensionSource.slice(start, start + 260)).toContain(action)
  })

  it("does not write an activation log unless debug logging is enabled", () => {
    const activationBody = extensionSource.slice(
      extensionSource.indexOf("export function activate"),
      extensionSource.indexOf("// Register sidebar view provider"),
    )
    expect(activationBody).not.toContain("appendFileSync")
  })

  it("does not contribute plaintext API-key settings", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { contributes?: { configuration?: { properties?: Record<string, unknown> } } }
    const properties = manifest.contributes?.configuration?.properties ?? {}

    expect(properties).not.toHaveProperty("nexuscode.apiKey")
    expect(properties).not.toHaveProperty("nexuscode.embeddingsApiKey")
    expect(properties).not.toHaveProperty("nexuscode.autocomplete.apiKey")
  })

  it("keeps host authority settings out of workspace scope", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { scope?: string }>
        }
      }
    }
    const properties = manifest.contributes?.configuration?.properties ?? {}

    for (const key of [
      "nexuscode.serverUrl",
      "nexuscode.autoApproveRead",
      "nexuscode.autoApproveWrite",
      "nexuscode.autoApproveCommand",
      "nexuscode.autoApproveMcp",
      "nexuscode.autoApproveBrowser",
      "nexuscode.autocomplete.enableAutoTrigger",
      "nexuscode.autocomplete.useSeparateModel",
      "nexuscode.autocomplete.provider",
      "nexuscode.autocomplete.model",
      "nexuscode.autocomplete.baseUrl",
    ]) {
      expect(properties[key]?.scope, key).toBe("machine")
    }
  })

  it("reads the server destination globally and binds its stored token", () => {
    const getterStart = controllerSource.indexOf("getServerUrl(): string")
    const clientStart = controllerSource.indexOf(
      "private async createServerClient(",
      getterStart,
    )
    const abortStart = controllerSource.indexOf(
      "private async abortServerTask(",
      clientStart,
    )

    expect(controllerSource.slice(getterStart, clientStart))
      .toContain("?.globalValue?.trim()")
    expect(controllerSource.slice(clientStart, abortStart))
      .toContain("getNexusServerTokenSecretKey(baseUrl)")
  })

  it("invalidates remote session identity before changing server authority", () => {
    const start = controllerSource.indexOf(
      "private handleServerDestinationChange(",
    )
    const end = controllerSource.indexOf(
      "private async synchronizeRuntimeMode(",
      start,
    )
    const body = controllerSource.slice(start, end)
    const resetSession = body.indexOf("this.serverSessionId = undefined")
    const reloadConfig = body.indexOf(
      "await this.reloadHostConfiguration(false)",
    )
    const setUrlStart = controllerSource.indexOf('case "setServerUrl":')
    const setUrlEnd = controllerSource.indexOf(
      'case "setServerToken":',
      setUrlStart,
    )
    const setUrlBody = controllerSource.slice(setUrlStart, setUrlEnd)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(resetSession).toBeGreaterThanOrEqual(0)
    expect(reloadConfig).toBeGreaterThan(resetSession)
    expect(body).toContain("this.remoteWorkspaceStateCache = undefined")
    expect(setUrlBody).toContain("if (this.isRunning)")
    expect(setUrlBody).toContain("await this.handleServerDestinationChange()")
  })

  it("does not reconstruct host grants from repository permission files", () => {
    expect(controllerSource).not.toContain(
      "this.config.permissions.allowedCommands = parsed.commands",
    )
    expect(controllerSource).not.toContain(
      "this.config.permissions.allowCommandPatterns = perms.allow",
    )
    expect(controllerSource).not.toContain(
      "this.config.permissions.allowedMcpTools = perms.allowedMcpTools",
    )
    expect(workspaceAuthorityConfigSource).toContain(
      "config.permissions.denyCommandPatterns = permissions.deny",
    )
    expect(controllerSource).toContain("loadVsCodeWorkspaceConfig(")
  })

  it("redacts API keys before sending configuration to the webview", () => {
    expect(controllerSource).toContain("stripSecretsFromConfig(")
    expect(controllerSource).not.toContain(
      'type: "configLoaded", config: this.config',
    )
  })

  it("fails closed when the exact workspace configuration cannot load", () => {
    const start = controllerSource.indexOf(
      "async ensureInitialized(): Promise<void>",
    )
    const end = controllerSource.indexOf(
      "async handleWebviewMessage(",
      start,
    )
    const body = controllerSource.slice(start, end)
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).not.toContain("this.loadHostConfig(process.cwd())")
    expect(body).not.toContain("NexusConfigSchema.parse({})")
    expect(body).toContain("this.setConfigurationLoadError(")
    expect(runBody).toContain("this.configurationError")
    expect(runBody).not.toContain(
      "this.loadHostConfig()\n      .catch(() => undefined)",
    )
  })

  it("binds MCP networking and immutable integration snapshots to the VS Code host", () => {
    const reconnectStart = controllerSource.indexOf(
      "private async reconnectMcpServers(",
    )
    const reconnectEnd = controllerSource.indexOf(
      "private async compactHistory(",
      reconnectStart,
    )
    const reconnectBody = controllerSource.slice(
      reconnectStart,
      reconnectEnd,
    )
    const testStart = controllerSource.indexOf('case "testMcpServers":')
    const testEnd = controllerSource.indexOf(
      'case "approvePendingMcp":',
      testStart,
    )
    const testBody = controllerSource.slice(testStart, testEnd)
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)

    expect(reconnectBody).toContain("createVsCodeMcpClient(")
    expect(reconnectBody).toContain("new VsCodeHost(")
    expect(testBody).toContain("testVsCodeMcpServers(")
    expect(testBody).toContain("new VsCodeHost(")
    expect(runBody).toContain("prepareVsCodeRunIntegrations({")
    expect(runBody.indexOf("prepareVsCodeRunIntegrations({")).toBeLessThan(
      runBody.indexOf("finalizeConfigCredentials("),
    )
    expect(runBody).not.toContain('tool.name.split("__"')
    expect(runBody).toContain(
      "services: preparedIntegrations.services",
    )
  })

  it("does not duplicate a fatal event already emitted by the core loop", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)

    expect(runBody).toContain("fatalRunErrorEmitted")
    expect(runBody).toContain("event.type === \"error\" && event.fatal")
    expect(runBody).toContain("!fatalRunErrorEmitted")
  })

  it("commits only trusted remote EnterPlanMode results for the next turn", () => {
    const forwardStart = controllerSource.indexOf(
      "private forwardServerEvent(",
    )
    const forwardEnd = controllerSource.indexOf(
      "private async restoreSelectedRemoteSession(",
      forwardStart,
    )
    const forwardBody = controllerSource.slice(
      forwardStart,
      forwardEnd,
    )
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)

    expect(forwardBody).toContain(
      "remoteModeTransitionFromAgentEvent(event)",
    )
    expect(forwardBody).toContain("this.mode = nextMode")
    expect(forwardBody).toContain(
      "this.forcedRemoteModeForNextRun = nextMode",
    )
    expect(runBody).toContain(
      "const forcedRemoteModeForRun",
    )
    expect(runBody).toContain(
      "forcedRemoteModeForRun ?? mode ?? this.mode",
    )
    expect(runBody).toContain("mode: runMode")
    expect(runBody).toMatch(
      /this\.forcedRemoteModeForNextRun\s*===\s*forcedRemoteModeForRun/u,
    )
  })

  it("restores the server-owned active execution before replaying events", () => {
    const resumeStart = controllerSource.indexOf(
      "private async resumeRemoteTurnIfActiveImpl()",
    )
    const resumeEnd = controllerSource.indexOf(
      "private async abortServerTask()",
      resumeStart,
    )
    const resumeBody = controllerSource.slice(resumeStart, resumeEnd)

    expect(resumeBody).toContain("onActiveExecution:")
    expect(resumeBody).toContain("this.mode = execution.mode")
    expect(resumeBody).toContain("this.lastRunMode = execution.mode")
    expect(resumeBody.indexOf("onActiveExecution:")).toBeLessThan(
      resumeBody.indexOf("deliver: (event)"),
    )
  })

  it("persists profile credentials before publishing the sanitized host patch", () => {
    const saveStart = controllerSource.indexOf(
      "private async handleSaveConfig(",
    )
    const saveEnd = controllerSource.indexOf(
      "private async handleRemoveCredential(",
      saveStart,
    )
    const saveBody = controllerSource.slice(saveStart, saveEnd)

    expect(saveBody.indexOf("persistSecretsFromConfig(")).toBeGreaterThan(0)
    expect(saveBody.indexOf("persistSecretsFromConfig(")).toBeLessThan(
      saveBody.indexOf("patchGlobalConfig("),
    )
    expect(saveBody).not.toContain("writeGlobalProfiles(")
  })

  it("persists only explicit layer patches and keeps host authority global", () => {
    const saveStart = controllerSource.indexOf(
      "private async handleSaveConfig(",
    )
    const saveEnd = controllerSource.indexOf(
      "private async handleRemoveCredential(",
      saveStart,
    )
    const saveBody = controllerSource.slice(saveStart, saveEnd)

    expect(saveBody).toContain("partitionConfigPatchForPersistence(")
    expect(saveBody).toContain("patchProjectConfig(")
    expect(saveBody).toContain("patchGlobalConfig(")
    expect(saveBody).not.toMatch(/\bwriteConfig\s*\(/)
    expect(saveBody).not.toContain("const toWrite = { ...next }")
  })

  it("keeps project MCP inactive until an explicit exact-request promotion", () => {
    expect(webviewAppSource).toContain("Project MCP requests (inactive)")
    expect(webviewAppSource).toContain("Approve exact request")
    expect(webviewAppSource).toContain('type: "approvePendingMcp"')
    expect(webviewAppSource).toContain("confirmAsync(")

    const approveCase = controllerSource.slice(
      controllerSource.indexOf('case "approvePendingMcp"'),
      controllerSource.indexOf('case "fetchMarketplaceData"'),
    )
    expect(approveCase).toContain("pendingProjectServers?.find(")
    expect(approveCase).toContain("await this.handleSaveConfig(")
    expect(approveCase).not.toContain("connectAll(")
  })

  it("uses the real session lifecycle for Clear Chat", () => {
    const clearChatCase = controllerSource.slice(
      controllerSource.indexOf('case "clearChat"'),
      controllerSource.indexOf('case "setMode"'),
    )
    expect(clearChatCase).toContain("await this.createNewSession()")
    expect(clearChatCase).not.toContain("Session.create(")
  })

  it("uses the real session lifecycle for the /clear command", () => {
    const slashClearCase = controllerSource.slice(
      controllerSource.indexOf('case "clear":'),
      controllerSource.indexOf("default:", controllerSource.indexOf('case "clear":')),
    )
    expect(slashClearCase).toContain("await this.createNewSession()")
    expect(slashClearCase).not.toContain("Session.create(")
  })

  it("fails closed instead of presenting a lossy local fork as a remote fork", () => {
    const forkCase = controllerSource.slice(
      controllerSource.indexOf('case "forkSession"'),
      controllerSource.indexOf('case "reindex"'),
    )
    expect(forkCase).toContain("if (this.getServerUrl())")
    expect(forkCase).toContain("Server-side session fork is not supported")
    expect(forkCase.indexOf("if (this.getServerUrl())")).toBeLessThan(
      forkCase.indexOf("this.session = this.session.fork("),
    )
  })

  it("does not advertise rollback when the host has no checkpoint capability", () => {
    expect(messageListSource).toContain(
      "const checkpointEnabled = useChatStore((s) => s.checkpointEnabled)",
    )
    expect(messageListSource).toContain(
      'const canRollback = message.role === "user" && checkpointEnabled',
    )
  })

  it("does not advertise client-scoped permission grants to a remote runtime", () => {
    expect(messageListSource).toContain(
      "const supportsScopedApproval = !useChatStore((s) => Boolean(s.serverUrl))",
    )
    expect(messageListSource).toContain("{supportsScopedApproval && (")
  })

  it("does not create local checkpoints for server-owned runs", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const serverUrl = controllerSource.indexOf(
      "const serverUrl = this.getServerUrl()",
      runStart,
    )
    const serverBranch = controllerSource.indexOf("if (serverUrl)", serverUrl)
    expect(controllerSource.slice(serverUrl, serverBranch))
      .not.toContain("commitCheckpointForUserMessage")
  })

  it("reports degraded MCP, rules, and skills readiness instead of dropping them silently", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const integrationStart = controllerSource.indexOf(
      "const emitDependencyDiagnostic",
      runStart,
    )
    const integrationEnd = controllerSource.indexOf(
      "const toolRegistry = new ToolRegistry()",
      integrationStart,
    )
    const integrationBody = controllerSource.slice(
      integrationStart,
      integrationEnd,
    )

    expect(integrationBody.match(/settleRuntimeDependency\(/g)).toHaveLength(3)
    expect(integrationBody).toContain('durableEventSink.emit({ type: "error", error })')
    expect(integrationBody).not.toContain(".catch(() => [])")
  })

  it("reuses workspace-owned live agent services across local turns", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)
    const disposeStart = controllerSource.indexOf("dispose(): void")

    expect(runBody).toContain("this.workspaceRunServices.get(cwd)")
    expect(runBody).not.toContain("new ParallelAgentManager()")
    expect(controllerSource.slice(disposeStart)).toContain(
      "this.workspaceRunServices.close()",
    )
    expect(controllerSource.slice(disposeStart)).toContain(
      "this.approvalResolveRef.current?.resolve({ approved: false })",
    )
  })

  it("projects session edit review from durable change sets only", () => {
    const start = controllerSource.indexOf(
      "private async refreshSessionChangeSets(",
    )
    const end = controllerSource.indexOf(
      "/** Push current state to webview",
      start,
    )
    const body = controllerSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).toContain("this.sessionUnacceptedEdits = durable")
    expect(body).toContain("changeSetId: record.id")
    expect(body).not.toContain("firstEdit")
    expect(controllerSource).not.toContain("onSessionEditSaved")
  })

  it("allows checkpoint diffs only for host-advertised checkpoint hashes", () => {
    const start = controllerSource.indexOf(
      "private async showCheckpointDiff(",
    )
    const end = controllerSource.indexOf(
      "/** Read agent presets",
      start,
    )
    const body = controllerSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).toContain("tracker.getEntries()")
    expect(body).toContain("!knownHashes.has(fromHash)")
    expect(body).toContain("!knownHashes.has(toHash)")
    expect(body.indexOf("await tracker.getDiff")).toBeGreaterThan(
      body.indexOf("!knownHashes.has(fromHash)"),
    )
  })

  it("revalidates preset capabilities in the host before persisting them", () => {
    const start = controllerSource.indexOf(
      "private async createAgentPreset(",
    )
    const end = controllerSource.indexOf(
      "private async deleteAgentPreset(",
      start,
    )
    const body = controllerSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).toContain("await this.getAgentPresetOptions()")
    expect(body).toContain("!availableSkills.has(skill)")
    expect(body).toContain("!availableMcpServers.has(server)")
    expect(body).toContain("!availableRulesFiles.has(file)")
    expect(body.indexOf("containsUnknownSelection")).toBeLessThan(
      body.indexOf("writeAgentPresetsForExtension"),
    )
  })

  it("prevents stale asynchronous skill loads from restoring old capabilities", () => {
    const start = controllerSource.indexOf(
      "private loadAndSendSkillDefinitions(): void",
    )
    const end = controllerSource.indexOf(
      "private async refreshAfterMarketplaceChange",
      start,
    )
    const body = controllerSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).toContain("++this.skillDefinitionsLoadGeneration")
    expect(body.match(/generation !== this\.skillDefinitionsLoadGeneration/gu))
      .toHaveLength(2)
  })

  it("resolves MCP prompts through the owning local or server workspace only", () => {
    const resolveStart = controllerSource.indexOf(
      "private async resolvePromptCommand(",
    )
    const resolveEnd = controllerSource.indexOf(
      "private async reconnectMcpServers(",
      resolveStart,
    )
    const resolveBody = controllerSource.slice(resolveStart, resolveEnd)
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)

    expect(resolveStart).toBeGreaterThanOrEqual(0)
    expect(resolveEnd).toBeGreaterThan(resolveStart)
    expect(resolveBody).toContain(
      "this.getServerUrl() && isMcpPromptCommandName(name)",
    )
    expect(resolveBody).toContain("resolveRemoteMcpPromptCommand(")
    expect(resolveBody.indexOf("resolveRemoteMcpPromptCommand(")).toBeLessThan(
      resolveBody.indexOf("this.reconnectMcpServers(this.config)"),
    )
    expect(resolveBody).toContain("resolveMcpPromptCommand(")
    expect(runBody).toContain("parseSlashPromptInvocation(trimmedInput)")
    expect(resolveBody).not.toContain("remote-mcp-unsupported")
  })

  it("publishes a bounded slash catalog from the runtime that owns MCP", () => {
    const start = controllerSource.indexOf(
      "private async getSlashCommandCatalog(",
    )
    const end = controllerSource.indexOf(
      "private async resolvePromptCommand(",
      start,
    )
    const body = controllerSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).toContain("getMcpPromptCommandCatalog(this.mcpClient)")
    expect(body).toContain("getRemoteMcpPromptCommandCatalog(catalog)")
    expect(body).toContain("remote.client.getMcpPromptCatalog(")
    expect(body).toContain("MAX_SLASH_COMMAND_CATALOG_ITEMS")
    expect(body).toContain("description.slice(0, 512)")
    expect(body).toContain("argumentHint.slice(0, 4_096)")
  })

  it("treats remote agent events as render-only observations", () => {
    const forwardStart = controllerSource.indexOf(
      "private forwardServerEvent(event: AgentEvent)",
    )
    const forwardEnd = controllerSource.indexOf(
      "private async restoreSelectedRemoteSession(",
      forwardStart,
    )
    const forwardBody = controllerSource.slice(forwardStart, forwardEnd)

    expect(forwardStart).toBeGreaterThanOrEqual(0)
    expect(forwardEnd).toBeGreaterThan(forwardStart)
    expect(forwardBody).not.toContain("workspace.fs.writeFile")
    expect(forwardBody).not.toContain("writtenContent")
  })

  it("forwards remote approval payloads to the actionable webview surface", () => {
    const forwardStart = controllerSource.indexOf(
      "private forwardServerEvent(event: AgentEvent)",
    )
    const forwardEnd = controllerSource.indexOf(
      "private async restoreSelectedRemoteSession(",
      forwardStart,
    )
    const forwardBody = controllerSource.slice(forwardStart, forwardEnd)

    expect(forwardBody).toContain(
      'if (event.type === "tool_approval_needed")',
    )
    expect(forwardBody).toContain('type: "pendingApproval"')
    expect(forwardBody).toContain("partId: event.partId")
    expect(forwardBody).toContain("action: event.action")
  })

  it("restores the selected remote session and attaches its exact active turn", () => {
    const initStart = controllerSource.indexOf(
      "async ensureInitialized(): Promise<void>",
    )
    const initEnd = controllerSource.indexOf(
      "async handleWebviewMessage(",
      initStart,
    )
    const resumeStart = controllerSource.indexOf(
      "private async resumeRemoteTurnIfActiveImpl()",
    )
    const resumeEnd = controllerSource.indexOf(
      "private async abortServerTask(",
      resumeStart,
    )
    const resumeBody = controllerSource.slice(resumeStart, resumeEnd)

    expect(controllerSource.slice(initStart, initEnd)).toContain(
      "restoreSelectedRemoteSession(cwd)",
    )
    expect(controllerSource.slice(initStart, initEnd)).toContain(
      "resumeRemoteTurnIfActive()",
    )
    expect(resumeBody).toContain("resumeVsCodeRemoteTurn({")
    expect(resumeBody).toContain(
      "cursorStore: this.getRemoteWorkspaceState(cwd)",
    )
    expect(resumeBody).toContain(
      "this.forwardServerEvent(event)",
    )
    expect(resumeBody).not.toContain(".runSessionTurn(")
  })

  it("binds a first remote user message to its server session before adding it", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const body = controllerSource.slice(runStart, runEnd)
    const ensureSession = body.indexOf(
      "const remote = await this.ensureRemoteSession()",
    )
    const addUserMessage = body.indexOf(
      "const userMessage = this.session.addMessage(",
    )

    expect(ensureSession).toBeGreaterThanOrEqual(0)
    expect(addUserMessage).toBeGreaterThan(ensureSession)
    expect(body).toContain(
      "remoteClientForRun ?? await this.createServerClient(cwd)",
    )
  })

  it("persists live remote admission before advancing replay cursors", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const runEnd = controllerSource.indexOf(
      "private async showPlanFollowup(",
      runStart,
    )
    const runBody = controllerSource.slice(runStart, runEnd)
    const admissionSave = runBody.indexOf(
      "afterSequence: acknowledgedSequence",
    )
    const sequenceSave = runBody.indexOf("onSequence: async (sequence)")

    expect(runBody).toContain("setSelectedSessionId(sid)")
    expect(admissionSave).toBeGreaterThanOrEqual(0)
    expect(sequenceSave).toBeGreaterThan(admissionSave)
    expect(runBody).toContain("prepared.afterSequence")
    expect(runBody).toContain("await admissionCursorWrite")
  })

  it("keeps a run busy until its loop has actually unwound after abort", () => {
    const abortCase = controllerSource.slice(
      controllerSource.indexOf('case "abort"'),
      controllerSource.indexOf('case "compact"'),
    )
    const cancelStart = controllerSource.indexOf(
      "async cancelTask(): Promise<void>",
    )
    const cancelEnd = controllerSource.indexOf(
      "async ensureInitialized(): Promise<void>",
      cancelStart,
    )
    const cancelBody = controllerSource.slice(cancelStart, cancelEnd)

    expect(abortCase).toContain("await this.cancelTask()")
    expect(cancelBody).toContain("this.abortController?.abort()")
    expect(cancelBody).toContain(
      "this.approvalResolveRef.current?.resolve({ approved: false })",
    )
    expect(abortCase).not.toContain("this.isRunning = false")
    expect(cancelBody).not.toContain("this.isRunning = false")
  })
})
