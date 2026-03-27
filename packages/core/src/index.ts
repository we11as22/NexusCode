// Global data dir (Kilo-style: terminal outputs outside project)
export { getNexusDataDir, getToolOutputDir, getRunLogsDir } from "./data-dir.js"

// Config
export {
  loadConfig,
  writeConfig,
  writeGlobalProfiles,
  getGlobalConfigDir,
  ensureGlobalConfigDir,
  loadProjectSettings,
  loadGlobalSettings,
  writeProjectSettings,
  writeGlobalSettings,
  applySecretsToConfig,
  stripSecretsFromConfig,
  stripProfileSecrets,
  getSecretsPayloadFromConfig,
  persistSecretsFromConfig,
  createFileSecretsStore,
  NEXUS_SECRETS_STORAGE_KEY,
} from "./config/index.js"
export type { ProjectSettings, NexusSecretsStore, NexusSecretsPayload } from "./config/index.js"
export { NexusConfigSchema } from "./config/schema.js"
export type { NexusConfig, ProviderConfig, EmbeddingConfig, McpServerConfig, SkillDef, ModeConfig } from "./types.js"

// Types
export { MODES } from "./types.js"
export type {
  Mode, IHost, ISession, IIndexer,
  AgentEvent, ToolDef, ToolResult, ToolContext,
  SessionMessage, ToolPart, MessagePart, TextPart,
  IndexSearchResult, IndexSearchOptions, IndexStatus, SymbolKind,
  CheckpointEntry, ChangedFile,
  DiagnosticItem, ApprovalAction, PermissionResult, UserQuestionRequest, UserQuestionItem, UserQuestionOption, UserQuestionAnswer,
} from "./types.js"

// Provider
export { createLLMClient, createEmbeddingClient } from "./provider/index.js"
export type { LLMClient, EmbeddingClient } from "./provider/types.js"

// Session
export {
  Session,
  generateSessionId,
  listSessions,
  deleteSession,
  deriveSessionTitle,
  getSessionMeta,
  loadSessionMessages,
  canonicalProjectRoot,
  saveSession,
  loadSession,
} from "./session/index.js"
export type { StoredSession, StoredSessionMeta, StoredContextUsage } from "./session/storage.js"
export { hadPlanExit, getPlanContentForFollowup } from "./session/plan-followup.js"
export { createCompaction } from "./session/compaction.js"

// Server client (extension + CLI when serverUrl is set)
export { NexusServerClient, DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./server-client.js"
export type { NexusServerClientOptions } from "./server-client.js"

// Agent
export { runAgentLoop } from "./agent/loop.js"
export { MODE_TOOL_GROUPS, TOOL_GROUP_MEMBERS, READ_ONLY_TOOLS, getBuiltinToolsForMode } from "./agent/modes.js"
export { classifyTools, classifySkills } from "./agent/classifier.js"
export { buildSystemPrompt } from "./agent/prompts/components/index.js"
export {
  ParallelAgentManager,
  createSpawnAgentTool,
  createSpawnAgentsAliasTool,
  createSpawnAgentOutputTool,
  createSpawnAgentStopTool,
  createSpawnAgentsParallelTool,
} from "./agent/parallel.js"

// Tools
export { ToolRegistry } from "./tools/registry.js"
export { getAllBuiltinTools } from "./tools/built-in/index.js"
export {
  NEXUS_CUSTOM_OPTION_ID,
  NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX,
  formatQuestionnaireAnswersForAgent,
} from "./tools/user-question-utils.js"

// Indexer
export { CodebaseIndexer } from "./indexer/index.js"
export { ProjectRegistry, getIndexDir } from "./indexer/multi-project.js"
export { createCodebaseIndexer } from "./indexer/factory.js"
export { ensureQdrantRunning } from "./indexer/qdrant-manager.js"

// Context
export { parseMentions } from "./context/mentions.js"
export { loadRules } from "./context/rules.js"
export { estimateTokens } from "./context/condense.js"
export {
  computeContextUsageMetrics,
  estimateToolsDefinitionsTokens,
  estimateActiveContextSessionTokens,
  getContextWindowLimit,
  MAX_TOOL_OUTPUT_CHARS_CONTEXT_ESTIMATE,
} from "./context/context-usage.js"
export type { ContextUsageSnapshot } from "./context/context-usage.js"

// Skills
export { loadSkills } from "./skills/manager.js"
export {
  loadSkillToolCatalogRows,
  resolveSkillBody,
  buildSkillToolDynamicDescription,
  sampleSkillSiblingFiles,
} from "./skills/skill-tool-catalog.js"
export type { SkillToolDescriptionRow, ResolvedSkillBody } from "./skills/skill-tool-catalog.js"
export { fetchSkillUrlRegistryRoots } from "./skills/url-registry.js"

// MCP
export { McpClient, setMcpClientInstance, testMcpServers } from "./mcp/client.js"
export { createMcpTransport, effectiveUrlTransport } from "./mcp/transport-factory.js"
export { resolveBundledMcpServers } from "./mcp/resolve-bundled.js"
export type { ResolveBundledOptions } from "./mcp/resolve-bundled.js"

// Models catalog (models.dev — free/recommended models for CLI & extension)
export {
  getModelsCatalog,
  getModelsUrl,
  getModelsPath,
  catalogSelectionToModel,
} from "./models/catalog.js"
export type { ModelsCatalog, CatalogProvider, CatalogModel } from "./models/catalog.js"

// Review (Kilocode 1:1 — build review prompts from git diff)
export { buildReviewPromptBranch, buildReviewPromptUncommitted } from "./review/index.js"
export type { DiffFile, DiffHunk, DiffResult } from "./review/types.js"

// Checkpoint
export { CheckpointTracker, writeCheckpointEntries, readCheckpointEntries } from "./checkpoint/index.js"
