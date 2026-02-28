// Config
export { loadConfig, writeConfig, writeGlobalProfiles, getGlobalConfigDir, ensureGlobalConfigDir } from "./config/index.js"
export { NexusConfigSchema } from "./config/schema.js"
export type { NexusConfig, ProviderConfig, EmbeddingConfig, McpServerConfig, SkillDef, ModeConfig } from "./types.js"

// Types
export type {
  Mode, IHost, ISession, IIndexer,
  AgentEvent, ToolDef, ToolResult, ToolContext,
  SessionMessage, ToolPart, MessagePart,
  IndexSearchResult, IndexSearchOptions, IndexStatus, SymbolKind,
  CheckpointEntry, ChangedFile,
  DiagnosticItem, ApprovalAction, PermissionResult,
} from "./types.js"

// Provider
export { createLLMClient, createEmbeddingClient } from "./provider/index.js"
export type { LLMClient, EmbeddingClient } from "./provider/types.js"

// Session
export { Session, generateSessionId, listSessions } from "./session/index.js"
export { createCompaction } from "./session/compaction.js"

// Agent
export { runAgentLoop } from "./agent/loop.js"
export { MODE_TOOL_GROUPS, TOOL_GROUP_MEMBERS, READ_ONLY_TOOLS, getBuiltinToolsForMode } from "./agent/modes.js"
export { classifyTools, classifySkills } from "./agent/classifier.js"
export { buildSystemPrompt } from "./agent/prompts/components/index.js"
export { ParallelAgentManager, createSpawnAgentTool } from "./agent/parallel.js"

// Tools
export { ToolRegistry } from "./tools/registry.js"
export { getAllBuiltinTools } from "./tools/built-in/index.js"

// Indexer
export { CodebaseIndexer } from "./indexer/index.js"
export { ProjectRegistry, getIndexDir } from "./indexer/multi-project.js"
export { createCodebaseIndexer } from "./indexer/factory.js"
export { ensureQdrantRunning } from "./indexer/qdrant-manager.js"

// Context
export { parseMentions } from "./context/mentions.js"
export { loadRules } from "./context/rules.js"
export { estimateTokens } from "./context/condense.js"

// Skills
export { loadSkills } from "./skills/manager.js"

// MCP
export { McpClient, setMcpClientInstance } from "./mcp/client.js"

// Checkpoint
export { CheckpointTracker } from "./checkpoint/tracker.js"
