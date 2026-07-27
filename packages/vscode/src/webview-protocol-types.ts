import type {
  Mode,
  NexusConfig,
  UserQuestionAnswer,
} from "@nexuscode/core"

export type MarketplaceItemReference = {
  id: string
  type: "mcp" | "skill"
}

export type WebviewMessage =
  | {
      type: "newMessage"
      clientMessageId: string
      content: string
      mode: Mode
      mentions?: string
      images?: Array<{ data: string; mimeType: string }>
      presetName?: string
    }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "clearChat" }
  | { type: "setMode"; mode: Mode }
  | { type: "setProfile"; profile: string }
  | { type: "getState" }
  | { type: "webviewDidLaunch" }
  | { type: "openSettings" }
  | {
      type: "saveConfig"
      config: Partial<NexusConfig> & {
        skillsConfig?: Array<{ path: string; enabled: boolean }>
      }
    }
  | {
      type: "removeCredential"
      target: "model" | "embeddings" | "qdrant" | "profile"
      profileName?: string
    }
  | { type: "switchSession"; sessionId: string }
  | { type: "createNewSession" }
  | { type: "forkSession"; messageId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "reindex" }
  | { type: "clearIndex" }
  | { type: "fullRebuildIndex" }
  | { type: "pauseIndexing" }
  | { type: "resumeIndexing" }
  | {
      type: "openFileAtLocation"
      path: string
      line?: number
      endLine?: number
    }
  | { type: "showDiff"; path: string }
  | { type: "setServerUrl"; url: string }
  | { type: "setServerToken"; token: string }
  | { type: "openNexusConfigFolder"; scope: "global" | "project" }
  | { type: "openCursorignore" }
  | { type: "openMcpConfig" }
  | { type: "testMcpServers" }
  | {
      type: "approvePendingMcp"
      name: string
      origin: "project-config" | "project-mcp-json"
    }
  | {
      type: "approvePendingProjectAuthority"
      fingerprint: string
    }
  | { type: "openSkillFolder"; path: string }
  | {
      type: "approvalResponse"
      partId: string
      approved: boolean
      alwaysApprove?: boolean
      addToAllowedCommand?: string
      skipAll?: boolean
      whatToDoInstead?: string
    }
  | { type: "openExternal"; url: string }
  | { type: "showConfirm"; id: string; message: string }
  | { type: "openNexusignore" }
  | { type: "getModelsCatalog" }
  | { type: "getSlashCommandCatalog" }
  | { type: "reloadConfiguration" }
  | {
      type: "restoreCheckpoint"
      hash: string
      restoreType: "task" | "workspace" | "taskAndWorkspace"
    }
  | { type: "showCheckpointDiff"; fromHash: string; toHash?: string }
  | { type: "getAgentPresets" }
  | { type: "getAgentPresetOptions" }
  | {
      type: "createAgentPreset"
      preset: {
        name: string
        vector: boolean
        skills: string[]
        mcpServers: string[]
        rulesFiles: string[]
        modelProvider?: string
        modelId?: string
      }
    }
  | { type: "deleteAgentPreset"; presetName: string }
  | { type: "applyAgentPreset"; presetName: string }
  | {
      type: "planFollowupChoice"
      choice: "implement" | "revise" | "dismiss"
      planText?: string
      instruction?: string
      newSession?: boolean
    }
  | { type: "dismissQuestionnaire"; requestId: string }
  | {
      type: "questionnaireResponse"
      requestId: string
      answers: UserQuestionAnswer[]
    }
  | { type: "loadOlderMessages" }
  | { type: "rollbackToBeforeMessage"; messageId: string }
  | {
      type: "startOrConnectVectorDb"
      url: string
      autoStart?: boolean
    }
  | { type: "openSessionEditDiff"; path: string }
  | { type: "undoSessionEdits" }
  | { type: "keepAllSessionEdits" }
  | { type: "revertSessionEditFile"; path: string }
  | { type: "acceptSessionEditFile"; path: string }
  | { type: "slashCommand"; command: string }
  | { type: "setChatPreset"; presetName: string }
  | {
      type: "fetchMarketplaceData"
      includeSkills?: boolean
      skillSearchQuery?: string
      skillSearchMode?: "keyword" | "vector"
      skillPage?: number
      skillCategory?: string
      skillVectorThreshold?: number
      forceRefresh?: boolean
    }
  | {
      type: "installMarketplaceItem"
      item: MarketplaceItemReference
      options: {
        target?: "global" | "project"
        parameters?: Record<string, string | number | boolean | null>
      }
    }
  | {
      type: "removeInstalledMarketplaceItem"
      item: MarketplaceItemReference
      options: { target: "global" | "project" }
    }
  | {
      type: "setAutocompleteExtensionSettings"
      patch: Partial<{
        enableAutoTrigger: boolean
        useSeparateModel: boolean
        modelProvider: string
        modelId: string
        modelApiKey: string
        modelBaseUrl: string
        modelTemperature: string
        modelReasoningEffort: string
        modelContextWindow: string
      }>
    }

export type WebviewDiagnosticMessage =
  | { type: "webviewBootstrap"; phase: string }
  | { type: "webviewScriptError"; message: string }
  | {
      type: "webviewRuntimeError"
      message: string
      source: string
      line: number
      column: number
    }

export type ParsedWebviewInboundMessage =
  | { kind: "request"; message: WebviewMessage }
  | { kind: "diagnostic"; message: WebviewDiagnosticMessage }
