import { z } from 'zod';
import { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema, PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { LanguageModelV1 } from 'ai';
import * as http from 'node:http';
import { LookupFunction } from 'node:net';

declare function getNexusDataDir(): string;
declare function getToolOutputDir(): string;
declare function getRunLogsDir(): string;

interface McpRequestOptions {
    signal?: AbortSignal;
}
interface McpProtocolClient {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    connect(transport: Transport, options?: McpRequestOptions): Promise<void>;
    close(): Promise<void>;
    getServerCapabilities?(): {
        prompts?: {
            listChanged?: boolean;
        };
        resources?: {
            listChanged?: boolean;
            subscribe?: boolean;
        };
        tools?: {
            listChanged?: boolean;
        };
    } | undefined;
    listTools(params?: {
        cursor?: string;
    }, options?: McpRequestOptions): Promise<{
        tools: Array<{
            name: string;
            description?: string;
            inputSchema: Record<string, unknown>;
            annotations?: {
                readOnlyHint?: boolean;
                destructiveHint?: boolean;
                idempotentHint?: boolean;
                openWorldHint?: boolean;
            };
        }>;
        nextCursor?: string;
    }>;
    callTool(params: {
        name: string;
        arguments: Record<string, unknown>;
    }, resultSchema?: unknown, options?: McpRequestOptions): Promise<{
        content?: unknown[];
        structuredContent?: unknown;
        isError?: boolean;
    }>;
    listResources(params?: {
        cursor?: string;
    }, options?: McpRequestOptions): Promise<{
        resources?: Array<{
            uri: string;
            name: string;
            description?: string;
            mimeType?: string;
        }>;
        nextCursor?: string;
    }>;
    listResourceTemplates(params?: {
        cursor?: string;
    }, options?: McpRequestOptions): Promise<{
        resourceTemplates?: Array<{
            uriTemplate: string;
            name: string;
            description?: string;
            mimeType?: string;
        }>;
        nextCursor?: string;
    }>;
    readResource(params: {
        uri: string;
    }, options?: McpRequestOptions): Promise<{
        contents?: Array<{
            uri: string;
            mimeType?: string;
            text?: string;
            blob?: string;
        }>;
    }>;
    listPrompts(params?: {
        cursor?: string;
    }, options?: McpRequestOptions): Promise<{
        prompts: Array<{
            name: string;
            title?: string;
            description?: string;
            arguments?: Array<{
                name: string;
                description?: string;
                required?: boolean;
            }>;
        }>;
        nextCursor?: string;
    }>;
    getPrompt(params: {
        name: string;
        arguments?: Record<string, string>;
    }, options?: McpRequestOptions): Promise<{
        description?: string;
        messages: Array<{
            role: "user" | "assistant";
            content: unknown;
        }>;
    }>;
    setNotificationHandler(schema: typeof ToolListChangedNotificationSchema | typeof PromptListChangedNotificationSchema, handler: () => void | Promise<void>): void;
}

interface McpRemoteAuthorizationRequest {
    /** Canonical HTTP(S) URL for exactly one outbound hop. */
    url: string;
    /** Aborted when the SDK request no longer needs this authorization. */
    signal: AbortSignal;
}
type McpRemoteRequestAuthorizer = (request: McpRemoteAuthorizationRequest) => Promise<AuthorizedNetworkRequest>;
interface McpTransportFactoryOptions {
    remoteRequestAuthorizer?: McpRemoteRequestAuthorizer;
}
interface McpClientOptions {
    startupTimeoutMs?: number;
    toolTimeoutMs?: number;
    reconnectAttempts?: number;
    reconnectBaseDelayMs?: number;
    remoteRequestAuthorizer?: McpRemoteRequestAuthorizer;
    clientFactory?: () => McpProtocolClient;
    transportFactory?: (config: McpServerConfig) => Transport;
}
type McpConnectionState = "connecting" | "connected" | "disabled" | "failed" | "needs_auth" | "disconnected";
interface McpServerStatus {
    name: string;
    state: McpConnectionState;
    toolCount: number;
    updatedAt: number;
    connectedAt?: number;
    error?: string;
    transport?: "stdio" | "http" | "sse";
}
interface McpTool {
    name: string;
    originalName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    serverName: string;
    readOnly: boolean;
}
interface McpPromptArgument {
    name: string;
    description?: string;
    required: boolean;
}
interface McpPromptRef {
    serverName: string;
    name: string;
    title?: string;
    description?: string;
    arguments: readonly McpPromptArgument[];
}
type McpPromptContent = {
    type: "text";
    text: string;
} | {
    type: "image" | "audio";
    data: string;
    mimeType: string;
} | {
    type: "resource";
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
} | {
    type: "resource_link";
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
} | {
    type: "unsupported";
    originalType: string;
};
interface McpPromptMessage {
    role: "user" | "assistant";
    content: McpPromptContent;
}
interface McpPromptResult {
    serverName: string;
    name: string;
    description?: string;
    messages: readonly McpPromptMessage[];
}
interface McpResourceRef {
    serverName: string;
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}
interface McpResourceContent {
    serverName: string;
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}
interface McpResourceTemplateRef {
    serverName: string;
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
}

declare function buildMcpToolSchema(inputSchema: Record<string, unknown>): z.ZodTypeAny;

/**
 * Stateful MCP runtime with deterministic reconnects, explicit health, bounded
 * requests, paginated discovery, and list-changed refresh.
 */
declare class McpClient {
    private clients;
    private serverLifecycles;
    private tools;
    private prompts;
    private configs;
    private statuses;
    private refreshes;
    private promptRefreshes;
    private reconnects;
    private ensureConnects;
    private configFingerprints;
    private serverEpochs;
    private lifecycleEpoch;
    private readonly options;
    constructor(options?: McpClientOptions);
    private createClient;
    private createTransport;
    private nextServerEpoch;
    private isCurrentServerEpoch;
    private currentStatus;
    private setStatus;
    private deleteServerTools;
    private promptKey;
    private deleteServerPrompts;
    private abortServerRequests;
    private closeServer;
    private handleTransportLoss;
    private listAllTools;
    private refreshTools;
    private listAllPrompts;
    private refreshPrompts;
    connect(config: McpServerConfig): Promise<McpServerStatus>;
    /**
     * Additively reconcile a workspace-owned MCP runtime.
     *
     * Unlike connectAll(), servers omitted by one turn are retained for other
     * concurrent sessions and background agents. Callers still filter the
     * exposed ToolDef snapshot by the current turn's allowed server names.
     */
    ensureConnected(configs: McpServerConfig[]): Promise<Record<string, McpServerStatus>>;
    private connectAtEpoch;
    connectAll(configs: McpServerConfig[]): Promise<Record<string, McpServerStatus>>;
    testServers(configs: McpServerConfig[]): Promise<Array<{
        name: string;
        status: "ok" | "error";
        error?: string;
    }>>;
    getTools(): ToolDef[];
    getPromptCatalog(serverName?: string): McpPromptRef[];
    getPrompt(serverName: string, promptName: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult>;
    /** Backward-compatible coarse state for existing hosts. */
    getStatus(): Record<string, "connected" | "disconnected">;
    getServerStatuses(): Record<string, McpServerStatus>;
    disconnectAll(): Promise<void>;
    close(): Promise<void>;
    listResources(serverName?: string, signal?: AbortSignal): Promise<McpResourceRef[]>;
    listResourceTemplates(serverName?: string, signal?: AbortSignal): Promise<McpResourceTemplateRef[]>;
    readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<McpResourceContent[]>;
    authenticate(serverName: string, host?: IHost): Promise<{
        success: boolean;
        pending?: boolean;
        message: string;
    }>;
}
declare function renderMcpPromptResult(result: McpPromptResult): string;
/** Standalone test of MCP server configs (does not keep connections). */
declare function testMcpServers(configs: McpServerConfig[]): Promise<Array<{
    name: string;
    status: "ok" | "error";
    error?: string;
}>>;

declare function canonicalProjectRoot(cwd: string): string;
type StoredContextUsage = {
    usedTokens: number;
    limitTokens: number;
    percent: number;
};
interface StoredSession {
    id: string;
    cwd: string;
    ts: number;
    title?: string;
    todo?: string;
    contextUsage?: StoredContextUsage;
    messages: SessionMessage[];
    /** Monotonic durable journal revision. Legacy v1 files load as revision 0. */
    revision?: number;
}
interface StoredSessionMeta {
    id: string;
    cwd: string;
    ts: number;
    title?: string;
    todo?: string;
    messageCount: number;
    revision: number;
}
type SessionStorageDiagnosticCode = "corrupt-journal-tail" | "journal-backup-recovered" | "legacy-session-detected" | "legacy-session-migrated" | "session-corrupt";
interface SessionStorageDiagnostic {
    code: SessionStorageDiagnosticCode;
    path: string;
    message: string;
}
interface SessionStoreOptions {
    /** Nexus home containing sessions/. Defaults to ~/.nexus. */
    homeDir?: string;
    compactAfterRecords?: number;
    compactAfterBytes?: number;
    /** Bounded artifact cleanup batch; primarily configurable for embedded hosts/tests. */
    toolOutputDeleteBatchSize?: number;
    onDiagnostic?: (diagnostic: SessionStorageDiagnostic) => void;
}
interface SaveSessionOptions {
    expectedRevision?: number;
}
interface PersistedToolOutputProtection {
    sessionDirectories: Set<string>;
    artifactPaths: Set<string>;
    protectAll: boolean;
}
interface DeleteSessionOptions {
    /** Internal/embedded-host seam; defaults to the process-wide store. */
    store?: SessionStore;
    /** Runtime projection coordinator. Defaults to the workspace runtime. */
    runtime?: {
        deleteSessionRecords(sessionId: string): Promise<unknown>;
    };
}
declare class UnsafeSessionIdError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string);
}
declare class SessionConflictError extends Error {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly actualRevision: number;
    constructor(sessionId: string, expectedRevision: number, actualRevision: number);
}
declare class SessionCorruptionError extends Error {
    readonly journalPath: string;
    constructor(journalPath: string, message: string);
}
declare class SessionStore {
    private readonly homeDir;
    private readonly compactAfterRecords;
    private readonly compactAfterBytes;
    private readonly toolOutputDeleteBatchSize;
    private readonly onDiagnostic?;
    private readonly diagnostics;
    constructor(options?: SessionStoreOptions);
    getSessionsDir(cwd: string): string;
    getSessionPath(sessionId: string, cwd: string): string;
    private diagnostic;
    getDiagnostics(): readonly SessionStorageDiagnostic[];
    private parseJournal;
    private quarantineTail;
    private writeLocked;
    saveSession(session: StoredSession, options?: SaveSessionOptions): Promise<number>;
    mutateSession(sessionId: string, cwd: string, mutate: (session: StoredSession) => StoredSession | Promise<StoredSession>): Promise<StoredSession | null>;
    loadSession(sessionId: string, cwd: string): Promise<StoredSession | null>;
    getSessionMeta(sessionId: string, cwd: string): Promise<StoredSessionMeta | null>;
    loadSessionMessages(sessionId: string, cwd: string, limit: number, offset: number): Promise<{
        meta: StoredSessionMeta;
        messages: SessionMessage[];
    } | null>;
    listSessions(cwd: string): Promise<Array<{
        id: string;
        ts: number;
        title?: string;
        messageCount: number;
        revision: number;
    }>>;
    deleteSession(sessionId: string, cwd: string): Promise<boolean>;
    collectToolOutputProtection(cwd: string, excludeSessionId?: string): Promise<PersistedToolOutputProtection>;
}
declare function getSessionStorageDiagnostics(): readonly SessionStorageDiagnostic[];
declare function saveSession(session: StoredSession, options?: SaveSessionOptions): Promise<number>;
declare function mutateSession(sessionId: string, cwd: string, mutate: (session: StoredSession) => StoredSession | Promise<StoredSession>): Promise<StoredSession | null>;
declare function loadSession(sessionId: string, cwd: string): Promise<StoredSession | null>;
declare function getSessionMeta(sessionId: string, cwd: string): Promise<StoredSessionMeta | null>;
declare function loadSessionMessages(sessionId: string, cwd: string, limit: number, offset: number): Promise<{
    meta: StoredSessionMeta;
    messages: SessionMessage[];
} | null>;
declare function listSessions(cwd: string): Promise<Array<{
    id: string;
    ts: number;
    title?: string;
    messageCount: number;
    revision: number;
}>>;
declare function deleteSession(sessionId: string, cwd: string, options?: DeleteSessionOptions): Promise<boolean>;
declare function generateSessionId(): string;

interface SessionRecoverySnapshot {
    readonly messages: readonly SessionMessage[];
    readonly todo: string;
    readonly contextUsageSnapshot: StoredContextUsage | null;
}
/** Derive session title from first user message. */
declare function deriveSessionTitle(messages: SessionMessage[]): string;
/**
 * In-memory session implementation backed by JSONL storage.
 */
declare class Session implements ISession {
    readonly id: string;
    private _messages;
    private _todo;
    private cwd;
    /** Ephemeral sessions are never persisted to disk (used for sub-agents). */
    private _ephemeral;
    /** Cached token estimate for the active context; invalidated on every session mutation. */
    private _tokenEstimateCache;
    /** Last context_usage from agent (full formula). Cleared when messages change. */
    private _contextUsageSnapshot;
    /** Last verified durable journal revision used for optimistic concurrency. */
    private _revision;
    constructor(id: string, cwd: string, messages?: SessionMessage[], initialTodo?: string, ephemeral?: boolean, contextUsageSnapshot?: StoredContextUsage | null, revision?: number);
    get messages(): SessionMessage[];
    invalidateTokenEstimate(): void;
    private clearContextUsageSnapshot;
    addMessage(msg: Omit<SessionMessage, "id" | "ts">): SessionMessage;
    updateMessage(id: string, updates: Partial<SessionMessage>): void;
    addToolPart(messageId: string, part: ToolPart): void;
    updateToolPart(messageId: string, partId: string, updates: Partial<ToolPart>): void;
    updateTodo(markdown: string): void;
    getTodo(): string;
    getTokenEstimate(): number;
    getLastContextUsageSnapshot(): StoredContextUsage | undefined;
    recordContextUsage(snapshot: StoredContextUsage): void;
    fork(messageId: string): ISession;
    /** Rewind chat to timestamp. Keeps only messages with ts <= timestamp. */
    rewindToTimestamp(timestamp: number): void;
    /** Rewind so that only messages strictly before this timestamp remain (used for rollback before a given message). */
    rewindBeforeTimestamp(timestamp: number): void;
    /** Rewind so that only messages strictly before a specific message remain. */
    rewindBeforeMessageId(messageId: string): void;
    captureRecoverySnapshot(): SessionRecoverySnapshot;
    restoreRecoverySnapshot(snapshot: SessionRecoverySnapshot): void;
    save(): Promise<void>;
    load(): Promise<boolean>;
    static create(cwd: string): Session;
    /**
     * Create a session that is never saved to disk (for sub-agents).
     * An optional transcript is defensively cloned so resume/fork cannot mutate
     * the durable source snapshot.
     */
    static createEphemeral(cwd: string, messages?: readonly SessionMessage[]): Session;
    static resume(sessionId: string, cwd: string): Promise<Session | null>;
    static resumeWindow(sessionId: string, cwd: string, limit: number, offset: number): Promise<Session | null>;
    static getMeta(sessionId: string, cwd: string): Promise<StoredSessionMeta | null>;
}

type RegistrationResult = {
    ok: true;
    replaced: false;
} | {
    ok: false;
    reason: "reserved-name" | "duplicate";
};
/**
 * Tool registry — manages built-in, MCP, and custom tools.
 * Static, manager-bound, and dynamic tools use separate registration paths so
 * a reserved name cannot be silently discarded or replaced.
 */
declare class ToolRegistry {
    private tools;
    private static staticBuiltinNames;
    private static reservedBuiltinNames;
    private static canonicalReservedBuiltinNames;
    private static getStaticBuiltinNames;
    private static getReservedBuiltinNames;
    private static isReservedBuiltinName;
    constructor();
    registerDynamic(tool: ToolDef): RegistrationResult;
    registerBoundBuiltin(tool: ToolDef): RegistrationResult;
    registerDynamicOrThrow(tool: ToolDef, source?: string): void;
    registerBoundBuiltinOrThrow(tool: ToolDef, source?: string): void;
    /** @deprecated Use registerDynamic or registerBoundBuiltin explicitly. */
    register(tool: ToolDef): RegistrationResult;
    getAll(): ToolDef[];
    get(name: string): ToolDef | undefined;
    getByNames(names: string[]): ToolDef[];
    /**
     * Get tools for a given mode.
     * Built-in tools for the mode are always included.
     * Additional MCP/custom tools are returned separately for deterministic
     * deferred discovery.
     */
    getForMode(mode: Mode): {
        builtin: ToolDef[];
        dynamic: ToolDef[];
    };
    /**
     * Append tools with `hiddenFromAgent` (e.g. legacy Spawn*, BashOutput) so old transcript tool
     * names still execute, while {@link getForMode} keeps them out of the LLM manifest.
     */
    mergeWithHiddenExecutionTools(visibleTools: ToolDef[]): ToolDef[];
    /**
     * Load custom tools from JS/TS files.
     * Custom tools export a default ToolDef or array of ToolDef.
     */
    loadFromDirectory(dir: string): Promise<void>;
    private warnOnRegistrationFailure;
    private throwOnRegistrationFailure;
}

type OrchestrationDiagnosticCode = "corrupt-journal-tail" | "snapshot-backup-recovered" | "journal-recovered" | "legacy-state-detected" | "legacy-state-migrated" | "stale-run-reconciled";
interface OrchestrationDiagnostic {
    code: OrchestrationDiagnosticCode;
    path: string;
    message: string;
}
interface OrchestrationRuntimeOptions {
    homeDir?: string;
    compactAfterRecords?: number;
    compactAfterBytes?: number;
    reconcileStaleRuns?: boolean;
    onDiagnostic?: (diagnostic: OrchestrationDiagnostic) => void;
}
interface SessionRecordDeletionResult {
    removedTasks: number;
    removedBackgroundTasks: number;
    removedRemoteSessions: number;
    removedAgentMessages: number;
    removedMemories: number;
    removedTeams: number;
    updatedTeams: number;
    removedSnapshots: number;
    retainedSnapshots: number;
}
declare class OrchestrationCorruptionError extends Error {
    readonly statePath: string;
    constructor(statePath: string, message: string);
}
declare class OrchestrationInvariantError extends Error {
    constructor(message: string);
}
declare function getRuntimeDir(cwd: string, homeDir?: string): string;
declare class OrchestrationRuntime {
    readonly cwd: string;
    private readonly root;
    private readonly stateFile;
    private readonly journalFile;
    private readonly writer;
    private readonly compactAfterRecords;
    private readonly compactAfterBytes;
    private readonly reconcileStaleRuns;
    private readonly onDiagnostic?;
    private readonly diagnostics;
    private tasks;
    private teams;
    private worktrees;
    private backgroundTasks;
    private memories;
    private remoteSessions;
    private agentMessages;
    constructor(cwd: string, options?: OrchestrationRuntimeOptions);
    getStatePath(): string;
    getRuntimeDirectory(): string;
    getJournalPath(): string;
    getDiagnostics(): readonly OrchestrationDiagnostic[];
    private diagnostic;
    private applyState;
    private captureState;
    private parseSnapshot;
    private parseJournal;
    private reconcileState;
    private loadDurableState;
    private quarantineJournalTail;
    private persistLoaded;
    private ensureLoaded;
    private mutate;
    private assertCanComplete;
    private assertValidTaskDependencies;
    private synchronizeTaskEdges;
    private bindTeamToSession;
    private assertValidTaskTransition;
    createTask(input: {
        id?: string;
        kind?: TaskKind;
        subject: string;
        description: string;
        status?: TaskStatus;
        activeForm?: string;
        owner?: string;
        teamName?: string;
        metadata?: Record<string, unknown>;
        blocks?: string[];
        blockedBy?: string[];
        command?: string;
        shellRunner?: "bash" | "powershell";
        processId?: number;
        exitCode?: number;
        sessionId?: string;
        output?: string;
        outputFile?: string;
        snapshotFile?: string;
        error?: string;
        parentTaskId?: string;
        resumeOf?: string;
        forkOf?: string;
        agentType?: string;
        toolUseId?: string;
    }): Promise<TaskRecord>;
    getTask(taskId: string): Promise<TaskRecord | null>;
    listTasks(filters?: {
        kind?: TaskKind | TaskKind[];
        teamName?: string;
        owner?: string;
        status?: TaskStatus | TaskStatus[];
        includeDeleted?: boolean;
    }): Promise<TaskRecord[]>;
    updateTask(taskId: string, updates: Partial<Pick<TaskRecord, "status" | "subject" | "description" | "activeForm" | "owner" | "teamName" | "command" | "shellRunner" | "processId" | "exitCode" | "sessionId" | "output" | "outputFile" | "snapshotFile" | "error" | "parentTaskId" | "resumeOf" | "forkOf" | "agentType">> & {
        metadata?: Record<string, unknown | null>;
        addBlocks?: string[];
        addBlockedBy?: string[];
    }): Promise<TaskRecord | null>;
    createTeam(input: {
        teamName: string;
        description: string;
        members?: TeamMemberRecord[];
        sessionId?: string;
    }): Promise<TeamRecord>;
    getTeam(teamName: string): Promise<TeamRecord | null>;
    listTeams(): Promise<TeamRecord[]>;
    listTeamNamesForSession(sessionId: string): Promise<string[]>;
    /**
     * Transactionally remove session-bound orchestration projections.
     *
     * Running work is an ownership conflict, matching Codex thread deletion:
     * callers must stop it first. Snapshot paths are treated as untrusted
     * metadata and are unlinked only when they remain regular files inside this
     * workspace runtime's private `agent-runs` directory.
     */
    deleteSessionRecords(sessionId: string): Promise<SessionRecordDeletionResult>;
    private deleteOwnedSessionSnapshots;
    deleteTeam(teamName: string): Promise<boolean>;
    addTeamMember(teamName: string, member: TeamMemberRecord): Promise<TeamRecord | null>;
    updateTeamMember(teamName: string, memberName: string, updates: Partial<Omit<TeamMemberRecord, "name" | "joinedAt" | "note">> & {
        note?: string | null;
    }): Promise<TeamRecord | null>;
    sendMessage(input: {
        from: string;
        to: string;
        message: string;
        teamName?: string;
    }): Promise<TeamMessageRecord>;
    private assertOwnedAgentTarget;
    private pruneAcknowledgedAgentMessages;
    /**
     * Resolve only inside one root-session authority. Display names are useful
     * for model calls, but must be unique among that owner's persisted tasks.
     */
    resolveAgentMessageTarget(input: {
        ownerSessionId: string;
        target: string;
    }): Promise<string | null>;
    /**
     * Durably enqueue a message. The explicit id makes retries idempotent; a
     * reused id with different content is rejected rather than overwritten.
     */
    enqueueAgentMessage(input: {
        id?: string;
        ownerSessionId: string;
        targetAgentId: string;
        from: string;
        message: string;
    }): Promise<AgentMailboxMessage>;
    listPendingAgentMessages(input: {
        ownerSessionId: string;
        targetAgentId: string;
        limit?: number;
    }): Promise<AgentMailboxMessage[]>;
    /**
     * Acknowledge only the next FIFO prefix. Already-acknowledged ids from the
     * same worker are accepted so crash/retry after a durable checkpoint is safe.
     */
    acknowledgeAgentMessages(input: {
        ownerSessionId: string;
        targetAgentId: string;
        messageIds: readonly string[];
        acknowledgedBySessionId: string;
    }): Promise<AgentMailboxMessage[]>;
    registerBackgroundTask(task: Omit<BackgroundTaskRecord, "createdAt" | "updatedAt">): Promise<BackgroundTaskRecord>;
    updateBackgroundTask(taskId: string, updates: Partial<Omit<BackgroundTaskRecord, "id" | "kind" | "createdAt">>): Promise<BackgroundTaskRecord | null>;
    setBackgroundTaskStatus(taskId: string, status: BackgroundTaskStatus, extra?: Partial<BackgroundTaskRecord>): Promise<BackgroundTaskRecord | null>;
    getBackgroundTask(taskId: string): Promise<BackgroundTaskRecord | null>;
    listBackgroundTasks(): Promise<BackgroundTaskRecord[]>;
    createWorktreeSession(input: {
        originalCwd: string;
        worktreePath: string;
        branch: string;
        metadata?: Record<string, unknown>;
    }): Promise<WorktreeSession>;
    findActiveWorktree(worktreePath?: string): Promise<WorktreeSession | null>;
    updateWorktreeSession(worktreeId: string, updates: Partial<Pick<WorktreeSession, "status" | "metadata">>): Promise<WorktreeSession | null>;
    createMemory(input: {
        scope: MemoryRecord["scope"];
        title: string;
        content: string;
        kind?: MemoryRecord["kind"];
        source?: MemoryRecord["source"];
        author?: MemoryRecord["author"];
        trust?: MemoryRecord["trust"];
        confidence?: number;
        expiresAt?: number;
        supersedes?: string[];
        contradicts?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<MemoryRecord>;
    getMemory(memoryId: string): Promise<MemoryRecord | null>;
    listMemories(filters?: {
        scope?: MemoryRecord["scope"] | MemoryRecord["scope"][];
        limit?: number;
        metadataMatch?: Record<string, string | number | boolean>;
    }): Promise<MemoryRecord[]>;
    recordMemoryAccess(memoryIds: readonly string[], accessedAt?: number): Promise<MemoryRecord[]>;
    updateMemory(memoryId: string, updates: Partial<Pick<MemoryRecord, "title" | "content">> & {
        kind?: MemoryRecord["kind"];
        confidence?: number;
        expiresAt?: number | null;
        supersedes?: string[];
        contradicts?: string[];
        metadata?: Record<string, unknown | null>;
    }): Promise<MemoryRecord | null>;
    upsertMemoryByTitle(input: {
        scope: MemoryRecord["scope"];
        title: string;
        content: string;
        kind?: MemoryRecord["kind"];
        source?: MemoryRecord["source"];
        author?: MemoryRecord["author"];
        trust?: MemoryRecord["trust"];
        confidence?: number;
        expiresAt?: number;
        supersedes?: string[];
        contradicts?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<MemoryRecord>;
    deleteMemory(memoryId: string): Promise<boolean>;
    createRemoteSession(input: {
        url: string;
        sessionId?: string;
        runId?: string;
        status?: RemoteSessionRecord["status"];
        viewerOnly?: boolean;
        reconnectable?: boolean;
        metadata?: Record<string, unknown>;
    }): Promise<RemoteSessionRecord>;
    getRemoteSession(remoteSessionId: string): Promise<RemoteSessionRecord | null>;
    listRemoteSessions(filters?: {
        sessionId?: string;
        runId?: string;
        status?: RemoteSessionRecord["status"] | RemoteSessionRecord["status"][];
    }): Promise<RemoteSessionRecord[]>;
    updateRemoteSession(remoteSessionId: string, updates: Partial<Omit<RemoteSessionRecord, "id" | "createdAt" | "url">> & {
        metadata?: Record<string, unknown | null>;
    }): Promise<RemoteSessionRecord | null>;
}
declare function getOrchestrationRuntime(cwd: string): Promise<OrchestrationRuntime>;

interface SubAgentResult {
    subagentId: string;
    sessionId: string;
    success: boolean;
    output: string;
    error?: string;
    /** Write/Edit tool parts from the sub-agent session (merged into parent for session diff). */
    fileEditParts?: ToolPart[];
}
interface ResumeAgentOptions {
    followupInstruction?: string;
    fork?: boolean;
    runInBackground?: boolean;
}
interface AgentSpawnOptions {
    modelOverride?: string;
    taskName?: string;
    resumeSeed?: {
        sourceSubagentId: string;
        lineage: "resume" | "fork";
        messages: SessionMessage[];
        followupInstruction: string;
        /** Logical inboxes inherited from the resumed/forked lineage. */
        mailboxTargetIds?: string[];
    };
}
interface SubAgentRuntimeContext {
    host: IHost;
    services: NexusRunServices;
    /** Session that owns and may observe/control the delegated run. */
    ownerSessionId: string;
    /** Exact parent tool call that owns this delegated run. */
    executionIdentity?: ToolExecutionIdentity;
}
/**
 * A restrictive parent may delegate analysis, but it must never resume a
 * previously more-privileged agent/debug worker with write/execute access.
 */
declare function restrictDelegatedMode(parentMode: Mode, requestedMode: Mode): Mode;
/**
 * Register only immutable integration capabilities selected for the owning
 * root turn. Reading the live workspace MCP catalog here could leak tools
 * connected for another concurrent session or a newer config generation.
 */
declare function registerInheritedRunTools(registry: ToolRegistry, services: NexusRunServices): void;
type SubAgentStatus = "running" | "completed" | "error" | "killed";
interface SubAgentSnapshot {
    subagentId: string;
    sessionId: string;
    status: SubAgentStatus;
    output: string;
    error?: string;
}
/**
 * Manager for parallel sub-agents.
 * Each sub-agent runs its own isolated session and agent loop.
 *
 * Concurrency model: each promise added to `this.running` removes itself
 * via `.finally()`, so after `await Promise.race(...)` at least one slot
 * is guaranteed to be free (the race resolves in a microtask, `.finally`
 * queues in the next microtask, `await Promise.resolve()` drains them).
 */
declare class ParallelAgentManager {
    private running;
    private sessions;
    private outputById;
    private statusById;
    private errorById;
    private controllers;
    private ownerSessionById;
    private mailboxWaiters;
    private mailboxWorkerByTarget;
    private acceptingMailboxWorkers;
    private history;
    private acceptingTasks;
    private shutdownPromise;
    private static readonly HISTORY_CAP;
    readonly orchestrationRuntime: OrchestrationRuntime;
    constructor(orchestrationRuntime?: OrchestrationRuntime);
    private getRuntime;
    private assertAcceptingTasks;
    private rememberId;
    private startTask;
    spawn(description: string, mode: Mode | undefined, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, contextSummary?: string, parentPartId?: string, agentType?: string, spawnOptions?: AgentSpawnOptions, runtimeContext?: SubAgentRuntimeContext): Promise<SubAgentResult>;
    spawnInBackground(description: string, mode: Mode, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, contextSummary?: string, parentPartId?: string, agentType?: string, spawnOptions?: AgentSpawnOptions, runtimeContext?: SubAgentRuntimeContext): Promise<{
        subagentId: string;
    }>;
    getSnapshot(subagentId: string, ownerSessionId: string): SubAgentSnapshot | null;
    waitFor(subagentId: string, ownerSessionId: string): Promise<SubAgentSnapshot | null>;
    stop(subagentId: string, ownerSessionId: string): boolean;
    shutdown(): Promise<void>;
    private mailboxKey;
    private claimMailboxTargets;
    private setMailboxWorkerAccepting;
    private releaseMailboxWorker;
    private registerMailboxWorker;
    private unregisterMailboxWorker;
    private isMailboxTargetAccepting;
    private notifyMailbox;
    /**
     * Resolve and persist before notifying the live run. No mutable child
     * transcript is touched here; the child accepts input only at loop-owned
     * provider boundaries.
     */
    queueMessage(input: {
        target: string;
        message: string;
        from?: string;
        ownerSessionId: string;
        id?: string;
    }): Promise<{
        targetAgentId: string;
        record: AgentMailboxMessage;
        running: boolean;
    }>;
    private waitForMailboxInput;
    listRuns(cwd: string, ownerSessionId: string): Promise<BackgroundTaskRecord[]>;
    resume(subagentId: string, options: ResumeAgentOptions, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, parentPartId?: string, runtimeContext?: SubAgentRuntimeContext, parentMode?: Mode): Promise<SubAgentResult | {
        subagentId: string;
        background: true;
    }>;
    private runSubAgent;
    /** How many agents are currently running */
    get activeCount(): number;
}
declare const spawnOutputSchema: z.ZodObject<{
    subagent_id: z.ZodString;
    block: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    subagent_id: string;
    block?: boolean | undefined;
}, {
    subagent_id: string;
    block?: boolean | undefined;
}>;
declare const spawnStopSchema: z.ZodObject<{
    subagent_id: z.ZodString;
}, "strict", z.ZodTypeAny, {
    subagent_id: string;
}, {
    subagent_id: string;
}>;
declare const listAgentRunsSchema: z.ZodObject<{
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit?: number | undefined;
}, {
    limit?: number | undefined;
}>;
declare const agentRunSnapshotSchema: z.ZodObject<{
    subagent_id: z.ZodString;
    format: z.ZodOptional<z.ZodEnum<["summary", "json"]>>;
}, "strip", z.ZodTypeAny, {
    subagent_id: string;
    format?: "summary" | "json" | undefined;
}, {
    subagent_id: string;
    format?: "summary" | "json" | undefined;
}>;
declare const resumeAgentSchema: z.ZodObject<{
    subagent_id: z.ZodString;
    instruction: z.ZodOptional<z.ZodString>;
    fork: z.ZodOptional<z.ZodBoolean>;
    run_in_background: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    subagent_id: string;
    instruction?: string | undefined;
    run_in_background?: boolean | undefined;
    fork?: boolean | undefined;
}, {
    subagent_id: string;
    instruction?: string | undefined;
    run_in_background?: boolean | undefined;
    fork?: boolean | undefined;
}>;
declare const taskResumeSchema: z.ZodObject<{
    task_id: z.ZodString;
    instruction: z.ZodOptional<z.ZodString>;
    fork: z.ZodOptional<z.ZodBoolean>;
    block: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    instruction?: string | undefined;
    block?: boolean | undefined;
    fork?: boolean | undefined;
}, {
    task_id: string;
    instruction?: string | undefined;
    block?: boolean | undefined;
    fork?: boolean | undefined;
}>;
declare const taskSnapshotSchema: z.ZodObject<{
    task_id: z.ZodString;
    format: z.ZodOptional<z.ZodEnum<["summary", "json"]>>;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    format?: "summary" | "json" | undefined;
}, {
    task_id: string;
    format?: "summary" | "json" | undefined;
}>;
declare const taskCreateBatchSchema: z.ZodObject<{
    tasks: z.ZodArray<z.ZodObject<{
        description: z.ZodString;
        agent_type: z.ZodOptional<z.ZodString>;
        context_summary: z.ZodOptional<z.ZodString>;
        mode: z.ZodOptional<z.ZodEnum<["agent", "plan", "ask", "debug", "review", "search", "explore"]>>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        mode?: "search" | "agent" | "plan" | "ask" | "debug" | "review" | "explore" | undefined;
        agent_type?: string | undefined;
        context_summary?: string | undefined;
    }, {
        description: string;
        mode?: "search" | "agent" | "plan" | "ask" | "debug" | "review" | "explore" | undefined;
        agent_type?: string | undefined;
        context_summary?: string | undefined;
    }>, "many">;
    block: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    tasks: {
        description: string;
        mode?: "search" | "agent" | "plan" | "ask" | "debug" | "review" | "explore" | undefined;
        agent_type?: string | undefined;
        context_summary?: string | undefined;
    }[];
    block?: boolean | undefined;
}, {
    tasks: {
        description: string;
        mode?: "search" | "agent" | "plan" | "ask" | "debug" | "review" | "explore" | undefined;
        agent_type?: string | undefined;
        context_summary?: string | undefined;
    }[];
    block?: boolean | undefined;
}>;
declare function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef;
declare function createSpawnAgentOutputTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnOutputSchema>>;
declare function createSpawnAgentStopTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnStopSchema>>;
declare function createListAgentRunsTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof listAgentRunsSchema>>;
declare function createAgentRunSnapshotTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof agentRunSnapshotSchema>>;
declare function createResumeAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef<z.infer<typeof resumeAgentSchema>>;
declare function createTaskResumeTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef<z.infer<typeof taskResumeSchema>>;
declare function createTaskSnapshotTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof taskSnapshotSchema>>;
declare function createTaskCreateBatchTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef<z.infer<typeof taskCreateBatchSchema>>;
/**
 * SpawnAgentsParallel — simple alternative to Parallel+SpawnAgent for concurrent sub-agent launch.
 * Flat schema: no recipient_name/parameters wrapping needed.
 */
declare function createSpawnAgentsParallelTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef;
/**
 * Backward-compatible alias for old sessions/prompts that still call SpawnAgents.
 * Runtime behavior is identical to SpawnAgent (single sub-agent per call).
 */
declare function createSpawnAgentsAliasTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef;

type BackgroundProcessStopReason = "requested" | "owner_shutdown";
interface BackgroundProcessRecord {
    readonly taskId: string;
    readonly pid: number;
    /** Opaque per-spawn identity. A persisted PID alone is never sufficient. */
    readonly processIdentity: string;
    readonly logPath: string;
    readonly workspace: string;
    readonly sessionId: string;
    /** Live child/process-group terminator. Never reconstructed from a stored PID. */
    readonly terminate?: (signal: NodeJS.Signals) => boolean;
    /** Await process exit and durable terminal-state publication. */
    readonly stop: (reason: BackgroundProcessStopReason) => Promise<void>;
}
/**
 * Workspace-runtime-owned live process projection.
 *
 * Durable task state remains authoritative across process restarts. This
 * supervisor only owns live process handles in the current runtime and refuses
 * lookup without the exact workspace + session capability.
 */
declare class BackgroundProcessSupervisor {
    #private;
    register(record: BackgroundProcessRecord): void;
    get(taskId: string, owner: {
        workspace: string;
        sessionId: string;
    }): BackgroundProcessRecord | undefined;
    remove(taskId: string, owner: {
        workspace: string;
        sessionId: string;
    }): boolean;
    terminate(taskId: string, owner: {
        workspace: string;
        sessionId: string;
    }, signal?: NodeJS.Signals): boolean;
    stop(taskId: string, owner: {
        workspace: string;
        sessionId: string;
    }, options: {
        processIdentity: string;
        reason?: BackgroundProcessStopReason;
    }): Promise<boolean>;
    list(owner: {
        workspace: string;
        sessionId: string;
    }): BackgroundProcessRecord[];
    /** Protect active logs from retention cleanup across sessions/workspaces. */
    ownsLogPath(logPath: string): boolean;
    /**
     * Stop every owner-bound process and wait until each task has published a
     * durable terminal outcome. Handles are retained until the full drain
     * finishes so a partial shutdown can never masquerade as successful.
     */
    close(): Promise<void>;
}

interface WorkspaceTaskHandle {
    readonly started: boolean;
    readonly promise: Promise<void>;
}
/**
 * Owns non-turn background work (memory consolidation, maintenance, refresh)
 * for exactly one workspace runtime.
 */
declare class WorkspaceTaskSupervisor {
    #private;
    start(key: string, task: (signal: AbortSignal) => Promise<void>): WorkspaceTaskHandle;
    close(): Promise<void>;
}

declare const pluginTrustGrantSchema: z.ZodObject<{
    id: z.ZodString;
    pluginName: z.ZodString;
    declaredRootPath: z.ZodString;
    declaredSourcePath: z.ZodString;
    canonicalRootPath: z.ZodString;
    canonicalSourcePath: z.ZodString;
    rootDevice: z.ZodString;
    rootInode: z.ZodString;
    sourceDevice: z.ZodString;
    sourceInode: z.ZodString;
    fingerprint: z.ZodString;
    grantedAt: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    id: string;
    fingerprint: string;
    pluginName: string;
    declaredRootPath: string;
    declaredSourcePath: string;
    canonicalRootPath: string;
    canonicalSourcePath: string;
    rootDevice: string;
    rootInode: string;
    sourceDevice: string;
    sourceInode: string;
    grantedAt: number;
}, {
    id: string;
    fingerprint: string;
    pluginName: string;
    declaredRootPath: string;
    declaredSourcePath: string;
    canonicalRootPath: string;
    canonicalSourcePath: string;
    rootDevice: string;
    rootInode: string;
    sourceDevice: string;
    sourceInode: string;
    grantedAt: number;
}>;
type PluginTrustGrant = z.infer<typeof pluginTrustGrantSchema>;
interface PluginFingerprintLimits {
    maxEntries: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxDepth: number;
    maxRelativePathBytes: number;
}
interface PluginTrustStoreOptions {
    storePath?: string;
    limits?: Partial<PluginFingerprintLimits>;
    now?: () => number;
}
type PluginTrustReason = "trusted" | "not-granted" | "content-changed" | "identity-changed" | "unsafe-plugin" | "store-corrupt" | "store-unavailable";
interface PluginTrustEvaluation {
    trusted: boolean;
    reason: PluginTrustReason;
    fingerprint?: string;
    grantId?: string;
    revoked?: boolean;
    message?: string;
}
declare const DEFAULT_PLUGIN_FINGERPRINT_LIMITS: Readonly<PluginFingerprintLimits>;
declare class PluginTrustStoreCorruptionError extends Error {
    readonly storePath: string;
    constructor(storePath: string, message: string, options?: ErrorOptions);
}
declare class UnsafePluginContentError extends Error {
    readonly pluginPath: string;
    constructor(pluginPath: string, message: string);
}
declare function getPluginTrustStorePath(options?: Pick<PluginTrustStoreOptions, "storePath">): string;
declare function grantPluginTrust(plugin: PluginManifestRecord, options?: PluginTrustStoreOptions): Promise<PluginTrustGrant>;
declare function revokePluginTrust(plugin: PluginManifestRecord, options?: PluginTrustStoreOptions): Promise<boolean>;
declare function listPluginTrustGrants(options?: PluginTrustStoreOptions): Promise<PluginTrustGrant[]>;
declare function evaluatePluginTrust(plugin: PluginManifestRecord, options?: PluginTrustStoreOptions): Promise<PluginTrustEvaluation>;

declare const trustGrantSchema: z.ZodObject<{
    id: z.ZodString;
    declaredPath: z.ZodString;
    canonicalPath: z.ZodString;
    device: z.ZodString;
    inode: z.ZodString;
    kind: z.ZodEnum<["directory", "file"]>;
    fingerprint: z.ZodString;
    grantedAt: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "file" | "directory";
    fingerprint: string;
    grantedAt: number;
    canonicalPath: string;
    declaredPath: string;
    device: string;
    inode: string;
}, {
    id: string;
    kind: "file" | "directory";
    fingerprint: string;
    grantedAt: number;
    canonicalPath: string;
    declaredPath: string;
    device: string;
    inode: string;
}>;
interface ExecutableTreeLimits {
    maxEntries: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxDepth: number;
    maxRelativePathBytes: number;
}
declare const DEFAULT_EXECUTABLE_TREE_LIMITS: Readonly<ExecutableTreeLimits>;
interface ExecutableTreeSnapshot {
    declaredPath: string;
    canonicalPath: string;
    device: string;
    inode: string;
    kind: "directory" | "file";
    fingerprint: string;
    entries: number;
    totalBytes: number;
}
type CustomToolTrustGrant = z.infer<typeof trustGrantSchema>;
type CustomToolTrustReason = "trusted" | "not-granted" | "content-changed" | "identity-changed" | "unsafe-source" | "store-unavailable";
interface CustomToolTrustEvaluation {
    trusted: boolean;
    reason: CustomToolTrustReason;
    fingerprint?: string;
    grantId?: string;
    message?: string;
    snapshot?: ExecutableTreeSnapshot;
}
interface CustomToolTrustStoreOptions {
    storePath?: string;
    limits?: Partial<ExecutableTreeLimits>;
    now?: () => number;
}
interface SnapshotOptions {
    limits?: Partial<ExecutableTreeLimits>;
    /**
     * Kept internal to the executable-content boundary. Plugin tools use the
     * plugin tree version so their staged bytes can be compared to PluginTrust.
     */
    fingerprintVersion?: string;
    stagingRoot?: string;
}
declare class UnsafeCustomToolSourceError extends Error {
    readonly sourcePath: string;
    constructor(sourcePath: string, message: string);
}
declare class CustomToolTrustStoreError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
declare function fingerprintExecutableTree(sourcePath: string, options?: Omit<SnapshotOptions, "stagingRoot">): Promise<ExecutableTreeSnapshot>;
declare class CustomToolTrustStore {
    readonly storePath: string;
    private readonly options;
    constructor(options?: CustomToolTrustStoreOptions);
    grant(sourcePath: string): Promise<CustomToolTrustGrant>;
    evaluate(sourcePath: string): Promise<CustomToolTrustEvaluation>;
    evaluateSnapshot(snapshot: ExecutableTreeSnapshot): Promise<CustomToolTrustEvaluation>;
    list(): Promise<CustomToolTrustGrant[]>;
    revoke(sourcePath: string): Promise<boolean>;
}

type ToolContributionDiagnosticCode = "source-unsafe" | "source-untrusted" | "plugin-trust-missing" | "plugin-content-mismatch" | "no-entry-modules" | "too-many-entry-modules" | "bundler-unavailable" | "module-compile-failed" | "module-load-failed" | "invalid-name" | "reserved-name" | "duplicate-name" | "invalid-description" | "invalid-search-hint" | "invalid-modes" | "invalid-schema";
interface ToolContributionDiagnostic {
    level: "warning" | "error";
    code: ToolContributionDiagnosticCode;
    sourceId: string;
    sourcePath: string;
    message: string;
    toolName?: string;
    modulePath?: string;
}
interface ToolContributionSnapshot {
    readonly generation: string;
    readonly fingerprint: string;
    readonly tools: readonly ToolDef[];
    readonly diagnostics: readonly ToolContributionDiagnostic[];
}
interface WorkspaceToolContributionManagerOptions {
    runtimeRoot?: string;
    trustStore?: CustomToolTrustStore;
    trustStoreOptions?: CustomToolTrustStoreOptions;
    pluginTrustOptions?: PluginTrustStoreOptions;
    treeLimits?: Partial<ExecutableTreeLimits>;
    loadTimeoutMs?: number;
    callTimeoutMs?: number;
    loadPlugins?: (cwd: string, config: NexusConfig) => Promise<PluginManifestRecord[]>;
}
/** Attach one already-materialized generation without re-reading live files. */
declare function registerToolContributionSnapshot(registry: ToolRegistry, snapshot: ToolContributionSnapshot, source?: string): void;
declare class WorkspaceToolContributionManagerClosedError extends Error {
    constructor();
}
declare class WorkspaceToolContributionManager {
    readonly runtimeRoot: string;
    readonly trustStore: CustomToolTrustStore;
    private readonly pluginTrustOptions;
    private readonly treeLimits;
    private readonly loadTimeoutMs;
    private readonly callTimeoutMs;
    private readonly loadPlugins;
    private readonly generations;
    private currentSourceKey;
    private current;
    private closed;
    private materializationTail;
    private closePromise;
    constructor(options?: WorkspaceToolContributionManagerOptions);
    /**
     * Force the next turn to rematerialize even when source bytes are unchanged.
     * Existing snapshots remain executable until workspace shutdown.
     */
    invalidate(): void;
    materialize(cwd: string, config: NexusConfig): Promise<ToolContributionSnapshot>;
    private materializeOnce;
    private validateEntryCount;
    private validateDescriptor;
    private toolFromCandidate;
    close(): Promise<void>;
}

type ChangeSetState = "proposed" | "approved" | "applying" | "applied" | "rejected" | "accepted" | "reverting" | "reverted" | "conflicted";

type ChangeIdentity = ToolExecutionIdentity;
type FileStateRef = {
    readonly exists: true;
    readonly hash: string;
    readonly blob: string;
    readonly byteLength: number;
    readonly mode: number | null;
} | {
    readonly exists: false;
    readonly hash: null;
    readonly blob: null;
    readonly byteLength: 0;
    readonly mode: null;
};
interface ChangeHunk {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly patch: string;
}
interface ChangeOmission {
    readonly reason: "binary" | "oversize" | "unavailable" | "unsupported";
    readonly detail: string;
}
interface ChangeFileRecord {
    readonly path: string;
    readonly oldPath?: string;
    readonly operation: "create" | "modify" | "delete" | "rename";
    /** Earliest state restored by turn-level undo after coalesced edits. */
    readonly before: FileStateRef;
    /** Exact current state that this proposal is allowed to replace. */
    readonly applyBase: FileStateRef;
    /** Rename destination state captured before approval (normally absent). */
    readonly targetBase?: FileStateRef;
    readonly after: FileStateRef;
    readonly hunks: readonly ChangeHunk[];
    readonly binary: boolean;
    readonly omission?: ChangeOmission;
}
interface ChangeSetFailure {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
    readonly observedHash?: string | null;
}
interface ChangeSetRecord {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly identity: ChangeIdentity;
    readonly proposalHash: string;
    readonly supersedes?: string;
    readonly approvedHash?: string;
    readonly state: ChangeSetState;
    readonly files: readonly ChangeFileRecord[];
    readonly revision: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly failure?: ChangeSetFailure;
}
interface ChangeSetListQuery {
    readonly workspaceId: string;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly states?: readonly ChangeSetState[];
}
interface ChangeSetStore {
    putBlob(hash: string, content: Uint8Array): Promise<void>;
    getBlob(hash: string): Promise<Buffer>;
    /**
     * Atomically rejects duplicate ids and a second record with the same
     * execution identity, making replay idempotent across runtime instances.
     */
    insert(record: ChangeSetRecord): Promise<void>;
    get(id: string): Promise<ChangeSetRecord | undefined>;
    list(query: ChangeSetListQuery): Promise<readonly ChangeSetRecord[]>;
    replace(record: ChangeSetRecord, expectedRevision: number): Promise<void>;
}
type CapturedFileState = {
    readonly exists: true;
    readonly content: Uint8Array;
    readonly mode: number | null;
} | {
    readonly exists: false;
    readonly content: null;
    readonly mode: null;
};
type HostFileMutationNext = {
    readonly exists: true;
    readonly content: Uint8Array;
    readonly mode: number | null;
} | {
    readonly exists: false;
    readonly content: null;
    readonly mode: null;
};
interface HostFileMutation {
    readonly path: string;
    readonly expected: FileStateRef;
    readonly next: HostFileMutationNext;
}
interface ChangeSetFilePort {
    readFileState(path: string): Promise<CapturedFileState>;
    applyFileMutation(mutation: HostFileMutation): Promise<void>;
}
type ChangeProposalAfterState = {
    readonly exists: true;
    readonly content: string | Uint8Array;
    readonly mode?: number | null;
} | {
    readonly exists: false;
};
type ChangeProposalExpectedState = {
    readonly exists: true;
    readonly hash: string;
    readonly byteLength: number;
    readonly mode: number | null;
} | {
    readonly exists: false;
};
interface ChangeProposalFile {
    readonly path: string;
    readonly oldPath?: string;
    /**
     * Exact state used to compute the proposed output. The service recaptures
     * the path and rejects drift before persisting a proposal.
     */
    readonly expected?: ChangeProposalExpectedState;
    readonly after: ChangeProposalAfterState;
    readonly hunks: readonly ChangeHunk[];
    readonly binary: boolean;
    readonly omission?: ChangeOmission;
}
interface CreateChangeProposal {
    readonly identity: ChangeIdentity;
    readonly files: readonly ChangeProposalFile[];
}

interface GitCommandLimits {
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
}
interface GitCommandResult {
    readonly argv: readonly string[];
    readonly exitCode: number;
    readonly stdout: Buffer;
    readonly stderr: Buffer;
    readonly timedOut: boolean;
    readonly truncated: boolean;
}
type GitCommandFailureKind = "timeout" | "output_limit" | "spawn";
interface GitCommandRunnerPort {
    run(args: readonly string[], limits?: Partial<GitCommandLimits>): Promise<GitCommandResult>;
}
type GitIndexStatus = "." | " " | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!";
interface GitSubmoduleStatus {
    readonly isSubmodule: boolean;
    readonly commitChanged: boolean;
    readonly modified: boolean;
    readonly untracked: boolean;
}
interface GitOrdinaryStatusEntry {
    readonly kind: "ordinary";
    readonly path: string;
    readonly indexStatus: GitIndexStatus;
    readonly worktreeStatus: GitIndexStatus;
    readonly submodule: GitSubmoduleStatus;
    readonly headMode: string;
    readonly indexMode: string;
    readonly worktreeMode: string;
    readonly headOid: string;
    readonly indexOid: string;
}
interface GitRenameStatusEntry {
    readonly kind: "rename";
    readonly path: string;
    readonly originalPath: string;
    readonly indexStatus: GitIndexStatus;
    readonly worktreeStatus: GitIndexStatus;
    readonly submodule: GitSubmoduleStatus;
    readonly headMode: string;
    readonly indexMode: string;
    readonly worktreeMode: string;
    readonly headOid: string;
    readonly indexOid: string;
    readonly score: {
        readonly kind: "rename" | "copy";
        readonly percent: number;
    };
}
interface GitUnmergedStatusEntry {
    readonly kind: "unmerged";
    readonly path: string;
    readonly indexStatus: GitIndexStatus;
    readonly worktreeStatus: GitIndexStatus;
    readonly submodule: GitSubmoduleStatus;
    readonly stage1Mode: string;
    readonly stage2Mode: string;
    readonly stage3Mode: string;
    readonly worktreeMode: string;
    readonly stage1Oid: string;
    readonly stage2Oid: string;
    readonly stage3Oid: string;
}
interface GitUntrackedStatusEntry {
    readonly kind: "untracked";
    readonly path: string;
    readonly indexStatus: "?";
    readonly worktreeStatus: "?";
}
interface GitIgnoredStatusEntry {
    readonly kind: "ignored";
    readonly path: string;
    readonly indexStatus: "!";
    readonly worktreeStatus: "!";
}
type GitStatusEntry = GitOrdinaryStatusEntry | GitRenameStatusEntry | GitUnmergedStatusEntry | GitUntrackedStatusEntry | GitIgnoredStatusEntry;
type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
interface GitOmission {
    readonly reason: "file_limit" | "byte_limit" | "binary" | "oversize" | "unsupported" | "unreadable";
    readonly path?: string;
    readonly detail: string;
}
interface ParsedGitStatus {
    readonly oid?: string;
    readonly branch?: string;
    readonly upstream?: string;
    readonly ahead: number;
    readonly behind: number;
    readonly unborn: boolean;
    readonly detached: boolean;
    readonly entries: readonly GitStatusEntry[];
}
interface GitStatusSnapshot extends ParsedGitStatus {
    readonly available: boolean;
    readonly root?: string;
    readonly operation?: GitOperation;
    readonly omissions: readonly GitOmission[];
}
type GitDiffScope = "working" | "staged" | "combined" | "range";
interface GitDiffRequest {
    readonly scope: GitDiffScope;
    readonly from?: string;
    readonly to?: string;
    readonly paths?: readonly string[];
    readonly detail?: "summary" | "patch";
}
interface GitFileDiff {
    readonly path: string;
    readonly oldPath?: string;
    readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged";
    readonly staged: boolean;
    readonly unstaged: boolean;
    readonly binary: boolean;
    readonly additions?: number;
    readonly deletions?: number;
    readonly patch?: string;
    readonly omission?: GitOmission;
}
interface GitDiffResult {
    readonly available: boolean;
    readonly root?: string;
    readonly files: readonly GitFileDiff[];
    readonly additions: number;
    readonly deletions: number;
    readonly omissions: readonly GitOmission[];
}
interface GitDiffLimits {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxPatchBytesPerFile: number;
    readonly maxTotalPatchBytes: number;
}
interface GitTextInspectRequest {
    readonly operation: "show" | "log" | "blame";
    readonly revision?: string;
    readonly path?: string;
    readonly limit?: number;
}
interface GitTextInspectResult {
    readonly argv: readonly string[];
    readonly output: string;
    readonly exitCode: number;
    readonly truncated: boolean;
}

interface GitServiceOptions {
    runner?: GitCommandRunnerPort;
    diffLimits?: Partial<GitDiffLimits>;
}
declare class GitService {
    #private;
    constructor(cwd: string, options?: GitServiceOptions);
    status(): Promise<GitStatusSnapshot>;
    diff(request: GitDiffRequest): Promise<GitDiffResult>;
    /**
     * Run one of the small, explicitly read-only textual inspection commands.
     *
     * Keeping argv construction inside the workspace Git boundary means callers
     * never need to quote a shell command and cannot smuggle flags through a
     * revision or pathspec.
     */
    inspectText(request: GitTextInspectRequest): Promise<GitTextInspectResult>;
}

interface WorkspaceChangeSetBinding {
    readonly workspaceId: string;
    readonly store: ChangeSetStore;
}
interface NexusRunServices {
    parallelAgentManager: ParallelAgentManager;
    mcpClient?: McpClient;
    /**
     * Immutable root-turn MCP/resource capability snapshot. Delegated agents
     * inherit this exact list rather than reading the mutable workspace client.
     */
    mcpToolSnapshot?: readonly ToolDef[];
    backgroundProcesses: BackgroundProcessSupervisor;
    workspaceTasks: WorkspaceTaskSupervisor;
    /** Workspace-owned loader/runtime for exact-content trusted custom/plugin tools. */
    toolContributionManager: WorkspaceToolContributionManager;
    /** Immutable root-turn generation inherited by every delegated agent. */
    toolContributionSnapshot?: ToolContributionSnapshot;
    /** Workspace-owned durable task/team/memory projection. */
    orchestrationRuntime: OrchestrationRuntime;
    /** Workspace-owned durable change metadata/blob repository. */
    changeSets?: WorkspaceChangeSetBinding;
    /** Workspace-bound, read-only and bounded Git inspection service. */
    git?: GitService;
    /** Root run is 0; incremented for every delegated-agent generation. */
    subagentDepth: number;
    /** Current delegated run id; absent for the root run. */
    subagentId?: string;
}
declare function createNexusRunServices(input?: {
    parallelAgentManager?: ParallelAgentManager;
    mcpClient?: McpClient;
    mcpToolSnapshot?: readonly ToolDef[];
    backgroundProcesses?: BackgroundProcessSupervisor;
    workspaceTasks?: WorkspaceTaskSupervisor;
    toolContributionManager?: WorkspaceToolContributionManager;
    toolContributionSnapshot?: ToolContributionSnapshot;
    orchestrationRuntime?: OrchestrationRuntime;
    changeSets?: WorkspaceChangeSetBinding;
    git?: GitService;
    cwd?: string;
    subagentDepth?: number;
    subagentId?: string;
}): NexusRunServices;
/**
 * Drain the workspace-owned live services that are common to every host.
 * Host-specific integrations (MCP, indexers, state databases) remain owned by
 * the host and must be closed after this dependency barrier.
 */
declare function closeNexusRunServices(services: NexusRunServices): Promise<void>;

declare function normalizeChangePath(value: string): string;
declare function hashFileContent(content: string | Uint8Array): {
    hash: string;
    byteLength: number;
};
declare function hashWorkspaceIdentity(canonicalPath: string): string;
declare function sameChangeIdentity(left: ChangeIdentity, right: ChangeIdentity): boolean;
declare function hashChangeProposal(identity: ChangeIdentity, files: readonly ChangeFileRecord[]): string;
declare function assertChangeSetTransition(from: ChangeSetState, to: ChangeSetState): void;

declare class ChangeSetStorageCorruptionError extends Error {
    readonly diagnostics: readonly string[];
    constructor(manifestPath: string, diagnostics: readonly string[]);
}
declare class ChangeSetStoreConflictError extends Error {
    constructor(message: string);
}
interface FileChangeSetStoreOptions {
    rootDir: string;
    maxRecords?: number;
    maxManifestBytes?: number;
    maxBlobBytes?: number;
}
interface ChangeSetBlobPruneResult {
    readonly deleted: readonly string[];
    readonly retained: number;
    readonly errors: readonly string[];
}
declare class FileChangeSetStore implements ChangeSetStore {
    #private;
    readonly manifestPath: string;
    constructor(workspaceId: string, options: FileChangeSetStoreOptions);
    blobPath(hash: string): string;
    putBlob(hash: string, content: Uint8Array): Promise<void>;
    getBlob(hash: string): Promise<Buffer>;
    insert(record: ChangeSetRecord): Promise<void>;
    get(id: string): Promise<ChangeSetRecord | undefined>;
    list(query: ChangeSetListQuery): Promise<readonly ChangeSetRecord[]>;
    replace(record: ChangeSetRecord, expectedRevision: number): Promise<void>;
    pruneOrphanBlobs(olderThanMs?: number): Promise<ChangeSetBlobPruneResult>;
}

declare class ChangeSetApprovalError extends Error {
    constructor(message: string);
}
declare class ChangeSetConflictError extends Error {
    readonly changeSetId?: string;
    readonly path?: string;
    constructor(message: string, options?: {
        cause?: unknown;
        changeSetId?: string;
        path?: string;
    });
}
declare class FileMutationConflictError extends Error {
    readonly path: string;
    constructor(filePath: string);
}
interface ChangeSetServiceOptions {
    workspaceId: string;
    store: ChangeSetStore;
    files: ChangeSetFilePort;
    now?: () => number;
    idFactory?: () => string;
}
interface ChangeSetBatchConflict {
    readonly changeSetId: string;
    readonly paths: readonly string[];
    readonly message: string;
}
type ChangeSetBatchRevertResult = {
    readonly status: "reverted";
    /** Newest-to-oldest order in which records reached `reverted`. */
    readonly reverted: readonly ChangeSetRecord[];
} | {
    readonly status: "conflicted";
    /** Records still reverted after best-effort compensation. */
    readonly reverted: readonly ChangeSetRecord[];
    readonly conflicts: readonly ChangeSetBatchConflict[];
};
declare class ChangeSetService {
    #private;
    constructor(options: ChangeSetServiceOptions);
    propose(input: CreateChangeProposal): Promise<ChangeSetRecord>;
    get(id: string): Promise<ChangeSetRecord | undefined>;
    approve(id: string, proposalHash: string): Promise<ChangeSetRecord>;
    reject(id: string, proposalHash: string): Promise<ChangeSetRecord>;
    apply(id: string): Promise<ChangeSetRecord>;
    revert(id: string): Promise<ChangeSetRecord>;
    /**
     * Compensate a reverted change after a surrounding transaction (for
     * example, conversation rewind) fails to commit. Unlike a normal apply,
     * this compares against the earliest before-state retained by coalescing.
     */
    reapply(id: string): Promise<ChangeSetRecord>;
    accept(id: string): Promise<ChangeSetRecord>;
    recover(id: string): Promise<ChangeSetRecord>;
    /**
     * Reconcile every transition whose intent was durable but whose final
     * acknowledgement was not. Hosts call this before starting a new agent run
     * or at another proven-quiescent session boundary, so a process crash cannot
     * leave applied bytes hidden behind an `applying`/`reverting` journal state.
     * It must not be invoked while the selected session can still be mutating
     * files.
     */
    recoverInterrupted(input?: {
        sessionId?: string;
        turnId?: string;
    }): Promise<readonly ChangeSetRecord[]>;
    listEffectiveApplied(input: {
        sessionId: string;
        turnId?: string;
    }): Promise<readonly ChangeSetRecord[]>;
}
/**
 * Revert the effective Nexus-owned changes created at or after a durable
 * checkpoint boundary. The batch compensates back to the original workspace
 * state when any member conflicts, so callers never rewind chat after a
 * merely partial file restore.
 */
declare function revertEffectiveChangeSetsAfter(input: {
    service: ChangeSetService;
    sessionId: string;
    createdAtOrAfter: number;
}): Promise<ChangeSetBatchRevertResult>;
/**
 * Compensation half of a two-phase chat+file rewind. Input records must be in
 * the newest-to-oldest order returned by `revertEffectiveChangeSetsAfter`.
 */
declare function reapplyRevertedChangeSets(input: {
    service: ChangeSetService;
    reverted: readonly ChangeSetRecord[];
}): Promise<{
    readonly stillReverted: readonly ChangeSetRecord[];
    readonly conflicts: readonly ChangeSetBatchConflict[];
}>;

type Mode = "agent" | "plan" | "ask" | "debug" | "review";
declare const MODES: Mode[];
type PermissionAction = "read" | "write" | "execute" | "mcp" | "browser" | "search";
interface PermissionResult {
    approved: boolean;
    alwaysApprove?: boolean;
    /** When true, host should set autoApprove for the rest of the session (e.g. "Skip all") */
    skipAll?: boolean;
    /** For Bash: add this command to the project allowlist so it is not asked again in this folder */
    addToAllowedCommand?: string;
    /** When set with approved: false, the user declined the action and asked to do this instead; agent continues with this instruction. */
    whatToDoInstead?: string;
    /** For Bash: add this command pattern to allowCommandPatterns so matching commands are not asked again in this folder (e.g. "npm run:*"). */
    addToAllowedPattern?: string;
    /** For MCP: add this tool name to allowed list so it is not asked again in this folder (e.g. "codex - codex"). */
    addToAllowedMcpTool?: string;
}
type ToolApprovalCapability = "read" | "write" | "execute" | "mcp" | "plugin" | "browser";
/**
 * Declarative approval metadata owned by the tool definition.
 *
 * The execution pipeline remains the sole authority that interprets this
 * metadata against host/config permissions. Dynamic tools describe only the
 * capability and user-facing action derived from their input.
 */
interface ToolApprovalPolicy<TArgs = Record<string, unknown>> {
    capability: ToolApprovalCapability;
    /** Return false when this invocation has no side effect requiring approval. */
    when?(args: TArgs): boolean;
    /** Command used by execute allow/ask/deny matching. */
    command?(args: TArgs): string | undefined;
    /** Human-readable action presented to the user. */
    description(args: TArgs): string;
    /** Optional full command/path/payload shown in the approval surface. */
    content?(args: TArgs): string | undefined;
    /** Optional concise explanation supplied by the model/tool input. */
    shortDescription?(args: TArgs): string | undefined;
    /** Optional capability-specific warning. */
    warning?(args: TArgs): string | undefined;
    /**
     * Require a prompt even when this capability is otherwise auto-approved.
     * Reserved for irreversible/destructive actions such as killing a task.
     */
    alwaysPrompt?: boolean;
}
type ToolIntegrationProvenance = {
    kind: "mcp";
    serverName: string;
    originalName: string;
} | {
    kind: "custom";
    sourceId: string;
    sourcePath: string;
    fingerprint: string;
    bundleFingerprint: string;
    generation: string;
} | {
    kind: "plugin";
    pluginName: string;
    sourceId: string;
    sourcePath: string;
    fingerprint: string;
    bundleFingerprint: string;
    generation: string;
};
interface ToolDef<TArgs = Record<string, unknown>> {
    name: string;
    description: string;
    /** When true, keep the tool callable for compatibility/internal flows but do not expose it to the agent manifest/prompt. */
    hiddenFromAgent?: boolean;
    parameters: z.ZodType<TArgs>;
    /** Short searchable hint used by ToolSearch / deferred-tool discovery. */
    searchHint?: string;
    /** When true, the tool may be omitted from the initial prompt and loaded later via ToolSearch. */
    shouldDefer?: boolean;
    /** When true, the tool is always included in the initial prompt even if deferred-tool mode is active. */
    alwaysLoad?: boolean;
    /** If true, can be executed in parallel with other read-only tools */
    readOnly?: boolean;
    /** Stable integration provenance; never infer ownership from a tool-name delimiter. */
    integration?: ToolIntegrationProvenance;
    /** Which modes this tool is available in. undefined = all modes */
    modes?: Mode[];
    /**
     * Legacy marker that this tool participates in approval. Prefer `approval`
     * for capability-aware behavior and `approval.alwaysPrompt` when the prompt
     * must not be bypassed by an auto-approve setting.
     */
    requiresApproval?: boolean;
    /**
     * Capability policy for this tool. Prefer this over name-based approval
     * inference, especially when approval depends on invocation arguments.
     */
    approval?: ToolApprovalPolicy<TArgs>;
    /**
     * Optional: produce a human-readable validation error from a ZodError.
     * Return value is sent back to the LLM as the tool result so it can self-correct.
     * Pattern from kilocode — include the correct format example in the message.
     */
    formatValidationError?: (error: z.ZodError) => string;
    execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
interface ToolResult {
    success: boolean;
    output: string;
    /** Metadata for indexing/rendering */
    metadata?: Record<string, unknown>;
    /** Attachments (images, diffs, etc.) */
    attachments?: ToolAttachment[];
}
interface ToolAttachment {
    type: "image" | "diff" | "file";
    content: string;
    mimeType?: string;
}
interface NestedToolExecutionRequest {
    /** Resolved tool name. The authoritative pipeline still performs its own lookup. */
    toolName: string;
    /** Raw arguments. Normalization and schema validation belong to the pipeline. */
    input: Record<string, unknown>;
    /** Stable zero-based position inside the parent batch. */
    ordinal: number;
}
interface ToolActivationResult {
    /** Tools added to the active execution/manifest set by this operation. */
    activated: ToolDef[];
    /** Requested tools which were already active. */
    alreadyActive: ToolDef[];
    /** Names outside the authoritative searchable set. No activation occurs when this is non-empty. */
    rejected: string[];
}
/**
 * Immutable ownership allocated before an agent loop starts. It identifies
 * one admitted root/delegated execution without depending on mutable session
 * or workspace service state.
 */
interface AgentExecutionIdentity {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
}
/** Exact ownership of one tool call inside an immutable agent execution. */
interface ToolExecutionIdentity extends AgentExecutionIdentity {
    readonly messageId: string;
    readonly partId: string;
    readonly toolCallId: string;
}
interface ToolContext {
    cwd: string;
    host: IHost;
    session: ISession;
    config: NexusConfig;
    services: NexusRunServices;
    /** Immutable run-level identity; present for calls issued by agent loops. */
    executionIdentityBase?: AgentExecutionIdentity;
    /** Exact identity assigned by the authoritative tool pipeline. */
    executionIdentity?: ToolExecutionIdentity;
    /** Loop-bound durable change owner; absent only on legacy/non-file surfaces. */
    changeSetService?: ChangeSetService;
    /** Current loop mode (agent / plan / ask). Used e.g. by SpawnAgent to set sub-agent permissions. */
    mode?: Mode;
    indexer?: IIndexer;
    signal: AbortSignal;
    /** Optional: trigger context compaction (e.g. Condense tool). */
    compactSession?: () => Promise<void>;
    /** Current tool call part id (e.g. part_xyz). Set by loop for write/replace so tool can emit tool_approval_needed. */
    partId?: string;
    /** Assistant message id for the in-flight tool call (loop); used e.g. to merge sub-agent file edits when part id lookup fails. */
    toolExecutionMessageId?: string;
    /**
     * One-shot decision from the authoritative policy stage for a staged
     * Write/Edit operation. The tool owns diff construction; it must not
     * independently reinterpret config/rules when this decision is present.
     */
    fileEditApproval?: {
        required: boolean;
        permissionRule: boolean;
    };
    /** Currently active tools for this run. Composite tools may only execute this set. */
    resolvedTools?: ToolDef[];
    /**
     * Mode-authorized discovery universe. This may include tools intentionally
     * omitted from the current model manifest by deterministic deferred loading.
     */
    searchableTools?: ToolDef[];
    /**
     * Atomically activate exact names from searchableTools for subsequent model
     * requests and nested execution. Unknown/forbidden names reject the batch.
     */
    activateDeferredTools?: (toolNames: string[]) => ToolActivationResult;
    /**
     * Execute a child call through the same validation, policy, approval, hook,
     * spill, and cancellation boundary as a direct model tool call.
     *
     * Composite tools must fail closed when this capability is absent; directly
     * invoking another ToolDef.execute() would bypass the runtime policy.
     */
    executeNestedTool?: (request: NestedToolExecutionRequest) => Promise<ToolResult>;
}
interface ApprovalAction {
    type: "write" | "execute" | "mcp" | "plugin" | "browser" | "read" | "doom_loop";
    tool: string;
    description: string;
    content?: string;
    /** Short human-readable description for approval UI (e.g. "List prompts and built-in tools"). */
    shortDescription?: string;
    /** Optional warning to show in approval UI (e.g. "Command contains quoted characters in flag names"). */
    warning?: string;
    diff?: string;
    /** For write/replace_in_file: lines added and removed, shown in approval UI and after completion. */
    diffStats?: {
        added: number;
        removed: number;
    };
}
interface UserQuestionOption {
    id: string;
    label: string;
    /** Longer explanation (OpenClaude-style option description). */
    description?: string;
    /** Markdown preview when focused; hosts must hide for multi-select (OpenClaude rule). */
    preview?: string;
}
interface UserQuestionItem {
    id: string;
    question: string;
    /** Short chip / section label (OpenClaude `header`). */
    header?: string;
    options: UserQuestionOption[];
    allowCustom?: boolean;
    /** When true, user may pick several options; answers use `optionIds` / `optionLabels`. */
    multiSelect?: boolean;
}
interface UserQuestionRequest {
    requestId: string;
    title?: string;
    submitLabel?: string;
    customOptionLabel?: string;
    questions: UserQuestionItem[];
}
interface UserQuestionAnswer {
    questionId: string;
    /** Single-select */
    optionId?: string;
    optionLabel?: string;
    /** Multi-select (mutually exclusive with optionId for a given question). */
    optionIds?: string[];
    optionLabels?: string[];
    customText?: string;
}
type LspOperation = "goToDefinition" | "findReferences" | "hover" | "documentSymbol" | "workspaceSymbol" | "goToImplementation" | "prepareCallHierarchy" | "incomingCalls" | "outgoingCalls";
interface LspPosition {
    line: number;
    character: number;
}
interface LspRange {
    start: LspPosition;
    end: LspPosition;
}
interface LspLocation {
    path: string;
    range: LspRange;
    targetSelectionRange?: LspRange;
}
interface LspSymbolRecord {
    name: string;
    kind: string;
    detail?: string;
    path?: string;
    range?: LspRange;
}
interface LspCallRecord {
    name: string;
    kind?: string;
    path: string;
    range: LspRange;
    selectionRange?: LspRange;
    fromRanges?: LspRange[];
}
interface LspQueryRequest {
    operation: LspOperation;
    filePath?: string;
    line?: number;
    character?: number;
    query?: string;
}
interface LspQueryResult {
    operation: LspOperation;
    summary: string;
    locations?: LspLocation[];
    symbols?: LspSymbolRecord[];
    hover?: string;
    calls?: LspCallRecord[];
}
interface ModeChangeResult {
    success: boolean;
    mode: Mode;
    message?: string;
}
interface WorkingDirectoryChangeResult {
    success: boolean;
    cwd: string;
    message?: string;
}
interface McpAuthRequest {
    server: string;
    message?: string;
    startUrl?: string;
}
interface McpAuthResult {
    /**
     * True only after credentials have actually been completed and the caller
     * may reconnect. Merely opening an external URL is not completion.
     */
    success: boolean;
    /** Authentication was handed off and still requires user/browser action. */
    pending?: boolean;
    message: string;
}
interface HostReadFileOptions {
    /**
     * Reject before loading the file when the host can determine that its byte
     * size exceeds this limit. Model-facing tools must still bound their output.
     */
    maxBytes?: number;
}
type HostPathAccess = "read" | "list" | "write" | "delete" | "execute";
type NetworkRequestPurpose = "web_fetch" | "web_search" | "mcp" | "remote_session";
interface HostNetworkRequest {
    /** Fully-qualified URL for the next outbound hop. */
    url: string;
    /** Capability purpose, used by hosts for policy and audit decisions. */
    purpose: NetworkRequestPurpose;
}
interface ResolvedNetworkAddress {
    address: string;
    family: 4 | 6;
}
/**
 * Host authorization for exactly one outbound HTTP hop.
 *
 * The request transport must connect through one of `addresses` without
 * performing a second uncontrolled DNS lookup. Redirects require a fresh
 * authorization.
 */
interface AuthorizedNetworkRequest {
    url: string;
    hostname: string;
    addresses: readonly ResolvedNetworkAddress[];
}
interface IHost {
    readonly cwd: string;
    /**
     * Resolve and authorize a caller-controlled path before a core service uses
     * a lower-level filesystem/process API. Remote hosts must enforce their
     * canonical workspace capability here, including symlink escapes.
     */
    resolvePath(path: string, access: HostPathAccess): Promise<string>;
    /**
     * Validate and resolve a model/user-controlled outbound URL. Implementations
     * must fail closed for non-public destinations and return every allowed DNS
     * answer so the transport can pin the subsequent connection.
     */
    authorizeNetworkRequest(request: HostNetworkRequest): Promise<AuthorizedNetworkRequest>;
    readFile(path: string, options?: HostReadFileOptions): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    showDiff(path: string, before: string, after: string): Promise<boolean>;
    runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    showApprovalDialog(action: ApprovalAction, signal?: AbortSignal): Promise<PermissionResult>;
    emit(event: AgentEvent): void;
    /** Persist command to .nexus/allowed-commands.json for this cwd so it is not asked for approval again */
    addAllowedCommand?(cwd: string, command: string): Promise<void>;
    /** Persist command pattern to .nexus/settings.local.json permissions.allow so matching commands are not asked again (e.g. "npm run:*"). */
    addAllowedPattern?(cwd: string, pattern: string): Promise<void>;
    /** Persist MCP tool name to project allow list so it is not asked again (e.g. "codex - codex"). */
    addAllowedMcpTool?(cwd: string, toolName: string): Promise<void>;
    resolveAtMention?(mention: string): Promise<string | null>;
    getProblems?(): Promise<DiagnosticItem[]>;
    /** List checkpoint entries for UI. */
    getCheckpointEntries?(): Promise<CheckpointEntry[]>;
    /** Get diff between two checkpoints for preview. */
    getCheckpointDiff?(fromHash: string, toHash?: string): Promise<ChangedFile[]>;
    /** Called by the loop after a checkpoint is committed so the host can push updated entries to the UI. */
    notifyCheckpointEntriesUpdated?(): void;
    /** Host-side mode transition for the next turn/UI state. */
    requestModeChange?(mode: Mode, reason?: string): Promise<ModeChangeResult>;
    /** Host-side cwd/worktree transition for subsequent turns. */
    setWorkingDirectory?(cwd: string, reason?: string): Promise<WorkingDirectoryChangeResult>;
    /** Rich language-server operations when the current host can provide them (VS Code, IDE bridge, etc.). */
    queryLanguageServer?(request: LspQueryRequest): Promise<LspQueryResult>;
    /** Generic MCP auth handoff (open browser / show instructions / complete login). */
    requestMcpAuthentication?(request: McpAuthRequest): Promise<McpAuthResult>;
    /** Capture exact bytes and mode for durable change-set ownership. */
    readFileState?(path: string): Promise<CapturedFileState>;
    /** Apply one compare-and-swap file mutation. */
    applyFileMutation?(mutation: HostFileMutation): Promise<void>;
}
interface DiagnosticItem {
    file: string;
    line: number;
    col: number;
    severity: "error" | "warning" | "info";
    message: string;
    source?: string;
}
interface ISession {
    readonly id: string;
    readonly messages: SessionMessage[];
    addMessage(msg: Omit<SessionMessage, "id" | "ts">): SessionMessage;
    updateMessage(id: string, updates: Partial<SessionMessage>): void;
    addToolPart(messageId: string, part: ToolPart): void;
    updateToolPart(messageId: string, partId: string, updates: Partial<ToolPart>): void;
    updateTodo(markdown: string): void;
    getTodo(): string;
    getTokenEstimate(): number;
    /** Last full context bar values from agent (session + system + tools); undefined if stale or never recorded. */
    getLastContextUsageSnapshot(): {
        usedTokens: number;
        limitTokens: number;
        percent: number;
    } | undefined;
    /** Called by agent loop when emitting context_usage so resume/switch session can show the same numbers. */
    recordContextUsage(snapshot: {
        usedTokens: number;
        limitTokens: number;
        percent: number;
    }): void;
    fork(messageId: string): ISession;
    /** Rewind chat to timestamp; keeps only messages with ts <= timestamp (for checkpoint restore). */
    rewindToTimestamp(timestamp: number): void;
    /** Rewind so that only messages with ts < timestamp remain (for rollback before a message). */
    rewindBeforeTimestamp(timestamp: number): void;
    /** Rewind so that only messages strictly before the given message remain. */
    rewindBeforeMessageId(messageId: string): void;
    save(): Promise<void>;
    /** Reload durable state; false means the journal does not exist. */
    load(): Promise<boolean>;
}
type SessionRole = "user" | "assistant" | "system" | "tool";
interface SessionMessage {
    id: string;
    ts: number;
    role: SessionRole;
    content: string | MessagePart[];
    /** Durable delegated-agent inbox id accepted into this transcript. */
    mailboxMessageId?: string;
    /** Exact root session that owns the delegated-agent inbox. */
    mailboxOwnerSessionId?: string;
    /** Logical delegated-agent inbox from which this message was accepted. */
    mailboxTargetAgentId?: string;
    /** Display-only sender label copied from the durable inbox record. */
    mailboxSender?: string;
    /**
     * Optional per-user-message preset name (extension/server may attach).
     * Used to scope skills + MCP/tool visibility for the run that produced the assistant reply.
     */
    presetName?: string;
    parentId?: string;
    model?: string;
    tokens?: {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    cost?: number;
    /** If true, this message is a compaction summary */
    summary?: boolean;
    todo?: string;
}
interface TextPart {
    type: "text";
    text: string;
    /** Optional short line shown to the user (progress line); when present, explored block collapses. */
    user_message?: string;
}
interface ReasoningPart {
    type: "reasoning";
    text: string;
    reasoningId?: string;
    durationMs?: number;
    providerMetadata?: Record<string, unknown>;
}
/** User message part: image (base64 data URL or raw base64, with mimeType). */
interface ImagePart {
    type: "image";
    data: string;
    mimeType: string;
}
interface ChangeFileSummary {
    path: string;
    oldPath?: string;
    operation: "create" | "modify" | "delete" | "rename";
    diffStats: {
        added: number;
        removed: number;
    };
    binary: boolean;
}
interface ToolPart {
    type: "tool";
    id: string;
    tool: string;
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    attachments?: ToolAttachment[];
    error?: string;
    timeStart?: number;
    timeEnd?: number;
    /** If true, output has been pruned for compaction */
    compacted?: boolean;
    /**
     * Legacy absolute path retained only for migration of older transcripts.
     * New model-facing capabilities use outputArtifactId and never expose paths.
     */
    outputSpillPath?: string;
    /** Opaque handle accepted only by ToolOutputRead. */
    outputArtifactId?: string;
    /** Exact session whose private artifact directory owns this output. */
    outputArtifactOwnerSessionId?: string;
    /** Public task handle for a background shell/tool execution. */
    backgroundTaskId?: string;
    /** Set when a file mutation tool completes; used for session diff surfaces. */
    path?: string;
    diffStats?: {
        added: number;
        removed: number;
    };
    /** Durable ownership for an exact file-change proposal and its review state. */
    changeSetId?: string;
    proposalHash?: string;
    changeSetState?: ChangeSetState;
    /** Bounded per-file projection for multi-file diff surfaces. */
    changeFiles?: ChangeFileSummary[];
    /** Copied from sub-agent session into parent for diff; omit from chat tool rows (CLI). */
    mergedFromSubagent?: boolean;
    /**
     * Exact mode-authorized tools exposed by a successful ToolSearch call.
     * Persisted so deferred discovery survives compaction and session resume.
     */
    activatedToolNames?: string[];
}
type MessagePart = TextPart | ToolPart | ReasoningPart | ImagePart;
type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "killed" | "cancelled" | "deleted";
type TaskKind = "agent" | "shell" | "tracking" | "workflow" | "external";
interface TaskRecord {
    id: string;
    kind: TaskKind;
    subject: string;
    description: string;
    status: TaskStatus;
    createdAt: number;
    updatedAt: number;
    activeForm?: string;
    owner?: string;
    teamName?: string;
    metadata?: Record<string, unknown>;
    blocks?: string[];
    blockedBy?: string[];
    command?: string;
    shellRunner?: "bash" | "powershell";
    processId?: number;
    exitCode?: number;
    sessionId?: string;
    output?: string;
    outputFile?: string;
    snapshotFile?: string;
    error?: string;
    parentTaskId?: string;
    resumeOf?: string;
    forkOf?: string;
    agentType?: string;
    toolUseId?: string;
}
interface TeamMessageRecord {
    id: string;
    ts: number;
    from: string;
    to: string;
    message: string;
    teamName?: string;
}
/**
 * Durable, owner-scoped input for a delegated agent.
 *
 * A record remains pending until its target transcript has been checkpointed
 * with `mailboxMessageId`; acknowledgement is deliberately a separate step.
 */
interface AgentMailboxMessage {
    id: string;
    ownerSessionId: string;
    targetAgentId: string;
    sequence: number;
    from: string;
    message: string;
    createdAt: number;
    ackedAt?: number;
    acknowledgedBySessionId?: string;
}
/**
 * Turn-boundary port used by the agent loop. Implementations must checkpoint
 * the supplied session durably before acknowledging `messages`.
 */
interface AgentInputMailbox {
    readPending(limit?: number): Promise<AgentMailboxMessage[]>;
    waitForInput(signal: AbortSignal): Promise<void>;
    /**
     * Synchronously stop advertising this worker as an active consumer before
     * its final durable inbox check. Enqueues that finish after this call must
     * report that an explicit resume is required.
     */
    sealForCompletion(): void;
    /** Re-advertise the worker after the completion check found more input. */
    reopenAfterCompletionCheck(): void;
    checkpointAndAcknowledge(messages: readonly AgentMailboxMessage[], session: ISession): Promise<void>;
}
interface TeamMemberRecord {
    name: string;
    agentId?: string;
    agentType?: string;
    joinedAt: number;
    status?: "active" | "idle" | "offline";
    lastActiveAt?: number;
    lastIdleAt?: number;
    note?: string;
}
interface TeamRecord {
    name: string;
    description: string;
    createdAt: number;
    members: TeamMemberRecord[];
    messages: TeamMessageRecord[];
    /** Sessions that explicitly created or used this team. */
    sessionIds?: string[];
}
interface AgentDefinition {
    agentType: string;
    whenToUse: string;
    systemPrompt?: string;
    preferredMode?: Mode;
    tools?: string[];
    disallowedTools?: string[];
    hooks?: string[];
    sourcePath?: string;
    builtin?: boolean;
}
type BackgroundTaskKind = "bash" | "subagent" | "workflow" | "external";
type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "killed";
interface BackgroundTaskRecord {
    id: string;
    kind: BackgroundTaskKind;
    description: string;
    createdAt: number;
    updatedAt: number;
    status: BackgroundTaskStatus;
    command?: string;
    cwd?: string;
    processId?: number;
    exitCode?: number;
    logPath?: string;
    outputFile?: string;
    output?: string;
    error?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
}
interface RemoteSessionRecord {
    id: string;
    url: string;
    sessionId?: string;
    runId?: string;
    status: "connecting" | "connected" | "reconnecting" | "disconnected" | "completed" | "error";
    createdAt: number;
    updatedAt: number;
    lastEventSeq?: number;
    reconnectAttempts?: number;
    reconnectable?: boolean;
    error?: string;
    viewerOnly?: boolean;
    metadata?: Record<string, unknown>;
}
interface WorktreeSession {
    id: string;
    originalCwd: string;
    worktreePath: string;
    branch: string;
    createdAt: number;
    status: "active" | "kept" | "removed" | "error";
    metadata?: Record<string, unknown>;
}
interface DeferredToolDef {
    name: string;
    description: string;
    searchHint?: string;
}
interface MemoryRecord {
    id: string;
    schemaVersion: 2;
    scope: "global" | "project" | "session" | "team" | "task" | "agent";
    kind: "fact" | "preference" | "command" | "architecture" | "decision" | "instruction" | "summary" | "artifact_reference";
    title: string;
    content: string;
    source: {
        type: "user" | "tool" | "compaction" | "legacy_file" | "system" | "external";
        uri?: string;
        sessionId?: string;
        importedAt?: number;
    };
    author: {
        type: "user" | "agent" | "system" | "external";
        id?: string;
    };
    trust: "user" | "trusted" | "agent" | "external" | "untrusted";
    confidence: number;
    sensitivity: "normal" | "sensitive";
    createdAt: number;
    updatedAt: number;
    accessedAt: number;
    accessCount: number;
    expiresAt?: number;
    supersedes?: string[];
    contradicts?: string[];
    metadata?: Record<string, unknown>;
}
interface PluginManifestRecord {
    name: string;
    version?: string;
    description: string;
    commands: string[];
    commandEntries?: Array<{
        name: string;
        source?: string;
        content?: string;
        description?: string;
    }>;
    agents: string[];
    skills: string[];
    /** Executable tool modules or directories relative to the plugin root. */
    tools?: string[];
    hooks: string[];
    inlineHookConfigs?: Record<string, unknown>[];
    mcpServers: string[];
    inlineMcpServers?: Record<string, unknown>;
    enabled: boolean;
    rootDir: string;
    sourcePath: string;
    scope: "project" | "global";
    settingsSchema?: Record<string, unknown>;
    warnings?: string[];
    trusted?: boolean;
    /** Exact tree fingerprint evaluated by the host-owned plugin trust store. */
    trustFingerprint?: string;
    trustGrantId?: string;
    runtimeEnabled?: boolean;
    options?: Record<string, unknown>;
}
interface IIndexer {
    search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
    status(): IndexStatus;
    refreshFile?(filePath: string): Promise<void>;
    refreshFileNow?(filePath: string): Promise<void>;
    /** Batched incremental refresh (single tracker load/save). */
    refreshFilesBatchNow?(absPaths: string[]): Promise<void>;
    /**
     * True when Qdrant + embeddings are actually wired (not only indexing.vector in YAML).
     * Used by CodebaseSearch to explain YAML vs runtime mismatch.
     */
    semanticSearchActive?(): boolean;
    /** Pause full workspace indexing between parse/embed steps (Settings). */
    pauseIndexing?(): void;
    resumeIndexing?(): void;
    /** Incremental index run without clearing tracker/Qdrant (one index per workspace). */
    syncIndexing?(): Promise<void>;
    /** Clear tracker + collection and re-index from scratch. */
    fullRebuildIndex?(): Promise<void>;
    /** Remove indexed data for paths under this repo-relative prefix only. */
    deleteIndexScope?(relPathOrAbs: string): Promise<void>;
    /** Clear all index data for the workspace (tracker + vector collection). */
    deleteIndex?(): Promise<void>;
}
interface IndexSearchOptions {
    limit?: number;
    kind?: SymbolKind;
    semantic?: boolean;
    /** Scope search to paths under this prefix (relative to project root). Can be multiple. */
    pathScope?: string | string[];
}
interface IndexSearchResult {
    path: string;
    name?: string;
    kind?: SymbolKind;
    parent?: string;
    startLine?: number;
    endLine?: number;
    content: string;
    score?: number;
}
type SymbolKind = "class" | "function" | "method" | "interface" | "type" | "enum" | "const" | "arrow" | "chunk";
type IndexStatus = {
    state: "idle";
} | {
    state: "stopping";
    message?: string;
} | {
    state: "indexing";
    progress: number;
    total: number;
    chunksProcessed?: number;
    chunksTotal?: number;
    /** Without vector: files parsed / total files. With vector: chunks indexed / max(found, indexed) — Roo-style block ratio. */
    overallPercent?: number;
    phase?: "parsing" | "embedding";
    message?: string;
    /** Debounced file-watcher batch (Roo-style queue line), not full `startIndexing` scan. */
    watcherQueue?: boolean;
    paused?: boolean;
} | {
    state: "ready";
    files: number;
    symbols: number;
    chunks?: number;
} | {
    state: "error";
    error: string;
};
type AgentEvent = {
    type: "assistant_message_started";
    messageId: string;
} | {
    type: "assistant_content_complete";
    messageId: string;
} | {
    type: "text_delta";
    delta: string;
    messageId: string;
    user_message_delta?: string;
} | {
    type: "reasoning_start";
    messageId: string;
    reasoningId: string;
    providerMetadata?: Record<string, unknown>;
} | {
    type: "reasoning_delta";
    delta: string;
    messageId: string;
    reasoningId?: string;
    providerMetadata?: Record<string, unknown>;
} | {
    type: "reasoning_end";
    messageId: string;
    reasoningId?: string;
    providerMetadata?: Record<string, unknown>;
} | {
    type: "tool_start";
    tool: string;
    partId: string;
    messageId: string;
    input?: Record<string, unknown>;
} | {
    type: "tool_end";
    tool: string;
    partId: string;
    messageId: string;
    success: boolean;
    output?: string;
    error?: string;
    attachments?: ToolAttachment[];
    compacted?: boolean;
    path?: string;
    writtenContent?: string;
    diffStats?: {
        added: number;
        removed: number;
    };
    diffHunks?: Array<{
        type: string;
        lineNum: number;
        line: string;
    }>;
    appliedReplacements?: Array<{
        oldSnippet: string;
        newSnippet: string;
    }>;
    metadata?: Record<string, unknown>;
} | {
    type: "subagent_start";
    subagentId: string;
    mode: Mode;
    task: string;
    parentPartId?: string;
    depth?: number;
    parentSubagentId?: string;
} | {
    type: "subagent_tool_start";
    subagentId: string;
    tool: string;
    input?: Record<string, unknown>;
    parentPartId?: string;
} | {
    type: "subagent_tool_end";
    subagentId: string;
    tool: string;
    success: boolean;
    parentPartId?: string;
} | {
    type: "subagent_done";
    subagentId: string;
    success: boolean;
    outputPreview?: string;
    error?: string;
    parentPartId?: string;
} | {
    type: "tool_approval_needed";
    action: ApprovalAction;
    partId: string;
} | {
    type: "question_request";
    request: UserQuestionRequest;
    partId?: string;
} | {
    type: "compaction_start";
} | {
    type: "compaction_end";
} | {
    type: "run_context";
    mode: Mode;
    memoryCitations: string[];
    taskIds: string[];
} | {
    type: "index_update";
    status: IndexStatus;
} | {
    type: "vector_db_progress";
    message?: string;
} | {
    type: "vector_db_ready";
} | {
    type: "session_saved";
    sessionId: string;
} | {
    type: "context_usage";
    usedTokens: number;
    limitTokens: number;
    percent: number;
} | {
    type: "error";
    error: string;
    fatal?: boolean;
} | {
    type: "done";
    messageId: string;
} | {
    type: "todo_updated";
    todo: string;
} | {
    type: "doom_loop_detected";
    tool: string;
} | {
    type: "plan_followup_ask";
    planText: string;
} | {
    type: "task_created";
    task: TaskRecord;
} | {
    type: "task_updated";
    task: TaskRecord;
} | {
    type: "task_progress";
    task: TaskRecord;
    outputPreview?: string;
} | {
    type: "task_tool_start";
    taskId: string;
    taskKind: TaskKind;
    tool: string;
    input?: Record<string, unknown>;
    parentPartId?: string;
} | {
    type: "task_tool_end";
    taskId: string;
    taskKind: TaskKind;
    tool: string;
    success: boolean;
    parentPartId?: string;
} | {
    type: "task_completed";
    task: TaskRecord;
    outputPreview?: string;
} | {
    type: "team_updated";
    team: TeamRecord;
} | {
    type: "team_message";
    message: TeamMessageRecord;
} | {
    type: "background_task_updated";
    task: BackgroundTaskRecord;
} | {
    type: "remote_session_updated";
    remoteSession: RemoteSessionRecord;
} | {
    type: "plugin_hook";
    pluginName: string;
    hookEvent: string;
    output: string;
    success: boolean;
};
interface ProviderConfig {
    provider: ProviderName;
    id: string;
    apiKey?: string;
    baseUrl?: string;
    /**
     * Sampling temperature for generation. 0 = deterministic.
     * Most providers support range [0, 2].
     */
    temperature?: number;
    /**
     * Optional reasoning effort hint for reasoning-capable models.
     * Supported values depend on provider/model (e.g. low/medium/high/minimal/none/max).
     */
    reasoningEffort?: string;
    /**
     * Prior assistant reasoning on the next LLM request (KiloCode-style).
     * `auto` uses model heuristics (e.g. DeepSeek → `reasoning_content` on the message).
     */
    reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details";
    /** Optional explicit context window override in tokens for this model. */
    contextWindow?: number;
    /** Azure-specific */
    resourceName?: string;
    deploymentId?: string;
    apiVersion?: string;
    /** Extra provider options */
    extra?: Record<string, unknown>;
}
type ProviderName = "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
interface EmbeddingConfig {
    provider: "openai" | "openai-compatible" | "openrouter" | "ollama" | "google" | "mistral" | "bedrock" | "local";
    model: string;
    baseUrl?: string;
    apiKey?: string;
    dimensions?: number;
    region?: string;
}
interface NexusConfig {
    model: ProviderConfig;
    embeddings?: EmbeddingConfig;
    vectorDb?: {
        enabled: boolean;
        url: string;
        collection: string;
        autoStart: boolean;
        apiKey?: string;
        upsertWait?: boolean;
        searchMinScore?: number;
        searchHnswEf?: number;
        searchExact?: boolean;
    };
    modes: {
        agent?: ModeConfig;
        plan?: ModeConfig;
        ask?: ModeConfig;
        debug?: ModeConfig;
        review?: ModeConfig;
        [key: string]: ModeConfig | undefined;
    };
    indexing: {
        enabled: boolean;
        excludePatterns: string[];
        symbolExtract: boolean;
        vector: boolean;
        batchSize: number;
        embeddingBatchSize: number;
        embeddingConcurrency: number;
        maxPendingEmbedBatches: number;
        batchProcessingConcurrency: number;
        maxIndexedFiles: number;
        searchWhileIndexing: boolean;
        maxIndexingFailureRate: number;
        debounceMs: number;
        codebaseSearchSnippetMaxChars: number;
    };
    permissions: {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveMcp?: boolean;
        autoApproveBrowser?: boolean;
        /** Default true: skill loads without approval. Set false for Kilo-style confirmation. */
        autoApproveSkillLoad?: boolean;
        autoApproveReadPatterns: string[];
        /** Commands allowed without approval for this project (from .nexus/allowed-commands.json) */
        allowedCommands: string[];
        /** Command patterns from .nexus/settings.json + settings.local.json (allow = no approval) */
        allowCommandPatterns: string[];
        /** MCP tool names allowed without approval for this project */
        allowedMcpTools?: string[];
        /** Command patterns that always require approval (deny list) */
        denyCommandPatterns: string[];
        /** Command patterns that always ask (ask list) */
        askCommandPatterns: string[];
        denyPatterns: string[];
        /**
         * Fine-grained permission rules. First match wins inside each authority
         * layer; decisions from separate layers combine restrictively.
         */
        rules: PermissionRule[];
    };
    retry: RetryConfig;
    checkpoint: {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
        /** When true, first completion attempt (agent) is rejected; model must re-verify and complete again. */
        doubleCheckCompletion?: boolean;
    };
    /** UI preferences (e.g. chat pane). */
    ui?: {
        /** When true, streamed text_delta is shown in chat as muted/small; when false, only tool-written text is shown. */
        showReasoningInChat?: boolean;
    };
    mcp: {
        servers: McpServerConfig[];
        /** Repository-provided definitions awaiting exact host promotion. */
        pendingProjectServers?: Array<{
            source: "project";
            origin: "project-config" | "project-mcp-json";
            status: "pending";
            config: McpServerConfig;
        }>;
    };
    /** Repository endpoint/path/executable requests awaiting exact host approval. */
    pendingProjectAuthority?: PendingProjectAuthorityRequest[];
    /** Normalized list for UI: path + enabled. skills is derived (enabled only). */
    skillsConfig?: Array<{
        path: string;
        enabled: boolean;
    }>;
    skills: string[];
    /** Remote skill index URLs (optional). */
    skillsUrls?: string[];
    tools: {
        custom: string[];
        parallelReads: boolean;
        maxParallelReads: number;
        /** Deferred tool loading strategy. auto = use ToolSearch only when deferred tools are materially large. */
        deferredLoadingMode?: "auto" | "always" | "never";
        /** In auto mode, defer tool schemas once deferred tools exceed this fraction of model context. */
        deferredLoadingThresholdPercent?: number;
        /** In auto mode, always defer once at least this many tools are marked shouldDefer. */
        deferredLoadingMinimumTools?: number;
    };
    structuredOutput: "auto" | "always" | "never";
    summarization: {
        auto: boolean;
        threshold: number;
        keepRecentMessages: number;
        model: string;
    };
    parallelAgents: {
        maxParallel: number;
        maxTasksPerCall?: number;
        /** Maximum delegated-agent nesting depth. Root is depth 0. */
        maxDepth?: number;
    };
    compatibility?: {
        claude?: {
            enabled?: boolean;
            includeGlobalDir?: boolean;
            includeProjectDir?: boolean;
            includeLocalInstructions?: boolean;
            includeRules?: boolean;
            includeSettings?: boolean;
            includeCommands?: boolean;
            includeSkills?: boolean;
            includeAgents?: boolean;
            includePlugins?: boolean;
        };
    };
    plugins?: {
        enabled?: boolean;
        trusted?: string[];
        blocked?: string[];
        enableHooks?: boolean;
        hookTimeoutMs?: number;
        options?: Record<string, Record<string, unknown>>;
    };
    /** Optional overrides for agent loop limits (tool budget and max iterations per mode). */
    agentLoop?: {
        toolCallBudget?: Partial<Record<Mode, number>>;
        maxIterations?: Partial<Record<Mode, number>>;
    };
    /** OpenClaude-class: auto-memory dir, session memory file, tool spill hints. */
    memory?: {
        autoMemoryEnabled?: boolean;
        autoMemoryDirectory?: string;
        sessionMemoryEnabled?: boolean;
        sessionMemoryMinToolCallsBetweenUpdates?: number;
        sessionMemoryMaxChars?: number;
        emphasizeToolSpillPaths?: boolean;
        teamMemoryEnabled?: boolean;
        autoDreamEnabled?: boolean;
        autoDreamMinIntervalMs?: number;
    };
    rules: {
        files: string[];
    };
    profiles: Record<string, Partial<ProviderConfig>>;
}
interface ModeConfig {
    autoApprove?: PermissionAction[];
    systemPrompt?: string;
    customInstructions?: string;
}
type PermissionRuleAction = "allow" | "deny" | "ask";
interface PermissionRule {
    /**
     * Runtime provenance assigned while trusted host and untrusted project
     * layers are merged. Project input cannot promote itself to host authority.
     */
    authority?: "host" | "project";
    /** Tool name or glob pattern matching tool names */
    tool?: string;
    /** Path pattern (glob) to match against file args */
    pathPattern?: string;
    /** Regex to match against command args */
    commandPattern?: string;
    /** Action to take when rule matches */
    action: PermissionRuleAction;
    /** Human-readable reason for the rule */
    reason?: string;
}
interface RetryConfig {
    enabled: boolean;
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    /** HTTP status codes that trigger retry */
    retryOnStatus: number[];
}
interface McpServerConfig {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    /** Working directory for stdio MCP server process. */
    cwd?: string;
    url?: string;
    /** Remote transport. `http` = Streamable HTTP (MCP spec). `sse` = legacy SSE+POST. */
    transport?: "stdio" | "http" | "sse";
    /**
     * Roo / external configs: `streamable-http` | `sse` | `stdio`.
     * Used when `transport` is omitted (URL servers default to SSE unless type says streamable-http).
     */
    type?: "stdio" | "sse" | "streamable-http" | "http";
    /** Extra headers for SSE / Streamable HTTP (e.g. Authorization). */
    headers?: Record<string, string>;
    enabled?: boolean;
    /** Maximum time allowed for transport initialization and initial capability discovery. */
    startupTimeoutMs?: number;
    /** Maximum time allowed for a single MCP tool/resource request. */
    toolTimeoutMs?: number;
    /** Resolve an optional MCP bundle (e.g. "context-mode") through a host path or environment override. */
    bundle?: string;
    auth?: {
        type?: "oauth" | "url" | "manual";
        startUrl?: string;
        message?: string;
    };
}
interface SkillAuthority {
    lexicalRoot: string;
    realRoot: string;
}
interface SkillDef {
    name: string;
    path: string;
    /** Short description (YAML `description` or first heading / line). */
    summary: string;
    content: string;
    /** Captured discovery authority used by post-load skill operations. */
    authority?: SkillAuthority;
}
interface CheckpointEntry {
    hash: string;
    ts: number;
    /**
     * Exact user-message binding used to select Nexus-owned ChangeSets.
     * Older persisted entries may omit it and are preview/chat-only.
     */
    messageId?: string;
    description?: string;
}
interface ChangedFile {
    path: string;
    before: string;
    after: string;
    status: "added" | "modified" | "deleted";
}

declare const modelEndpointPayloadSchema: z.ZodObject<{
    model: z.ZodEffects<z.ZodObject<{
        provider: z.ZodOptional<z.ZodEnum<["anthropic", "openai", "google", "ollama", "openai-compatible", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "minimax"]>>;
        baseUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
        resourceName: z.ZodOptional<z.ZodString>;
        deploymentId: z.ZodOptional<z.ZodString>;
        apiVersion: z.ZodOptional<z.ZodString>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strict", z.ZodTypeAny, {
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>, {
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    model: {
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    };
}, {
    model: {
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    };
}>;
declare const embeddingsEndpointPayloadSchema: z.ZodObject<{
    embeddings: z.ZodObject<{
        provider: z.ZodEnum<["openai", "openai-compatible", "openrouter", "ollama", "google", "mistral", "bedrock", "local"]>;
        model: z.ZodString;
        baseUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
        dimensions: z.ZodOptional<z.ZodNumber>;
        region: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    }, {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    embeddings: {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    };
}, {
    embeddings: {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    };
}>;
declare const vectorDbEndpointPayloadSchema: z.ZodObject<{
    vectorDb: z.ZodEffects<z.ZodObject<{
        url: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
        autoStart: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        url?: string | undefined;
        autoStart?: boolean | undefined;
    }, {
        url?: string | undefined;
        autoStart?: boolean | undefined;
    }>, {
        url?: string | undefined;
        autoStart?: boolean | undefined;
    }, {
        url?: string | undefined;
        autoStart?: boolean | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    vectorDb: {
        url?: string | undefined;
        autoStart?: boolean | undefined;
    };
}, {
    vectorDb: {
        url?: string | undefined;
        autoStart?: boolean | undefined;
    };
}>;
declare const PROJECT_AUTHORITY_REQUEST_KINDS: readonly ["model-endpoint", "embeddings-endpoint", "vector-db-endpoint", "remote-skills", "custom-tools", "profiles", "external-skill-paths", "external-rule-paths", "external-memory-path", "claude-global-directory"];
type ProjectAuthorityRequestKind = typeof PROJECT_AUTHORITY_REQUEST_KINDS[number];
interface ProjectAuthorityPayloadByKind {
    "model-endpoint": z.infer<typeof modelEndpointPayloadSchema>;
    "embeddings-endpoint": z.infer<typeof embeddingsEndpointPayloadSchema>;
    "vector-db-endpoint": z.infer<typeof vectorDbEndpointPayloadSchema>;
    "remote-skills": {
        skillsUrls: string[];
    };
    "custom-tools": {
        tools: {
            custom: string[];
        };
    };
    "profiles": {
        profiles: Record<string, Partial<ProviderConfig>>;
    };
    "external-skill-paths": {
        skills: Array<string | {
            path: string;
            enabled?: boolean;
        }>;
    };
    "external-rule-paths": {
        rules: {
            files: string[];
        };
    };
    "external-memory-path": {
        memory: {
            autoMemoryDirectory: string;
        };
    };
    "claude-global-directory": {
        compatibility: {
            claude: {
                includeGlobalDir: true;
            };
        };
    };
}
interface PendingProjectAuthorityRequest<K extends ProjectAuthorityRequestKind = ProjectAuthorityRequestKind> {
    source: "project";
    origin: "project-config";
    status: "pending";
    kind: K;
    fingerprint: string;
    payload: ProjectAuthorityPayloadByKind[K];
}
declare function fingerprintProjectAuthorityPayload(kind: ProjectAuthorityRequestKind, payload: unknown): string;
declare function createPendingProjectAuthorityRequest<K extends ProjectAuthorityRequestKind>(kind: K, payload: ProjectAuthorityPayloadByKind[K]): PendingProjectAuthorityRequest<K>;
declare function isValidPendingProjectAuthorityRequest(value: unknown): value is PendingProjectAuthorityRequest;
declare function getPendingProjectAuthorityRequests(config: NexusConfig): readonly PendingProjectAuthorityRequest[];

declare const McpServerConfigSchema: z.ZodEffects<z.ZodObject<{
    name: z.ZodString;
    command: z.ZodOptional<z.ZodString>;
    args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    cwd: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    transport: z.ZodOptional<z.ZodEnum<["stdio", "http", "sse"]>>;
    type: z.ZodOptional<z.ZodEnum<["stdio", "sse", "streamable-http", "http"]>>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    /** Optional bundle id (e.g. "context-mode"); resolved by host to command/args/env when installed. */
    bundle: z.ZodOptional<z.ZodString>;
    auth: z.ZodOptional<z.ZodObject<{
        type: z.ZodOptional<z.ZodEnum<["oauth", "url", "manual"]>>;
        startUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
        message: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type?: "url" | "manual" | "oauth" | undefined;
        message?: string | undefined;
        startUrl?: string | undefined;
    }, {
        type?: "url" | "manual" | "oauth" | undefined;
        message?: string | undefined;
        startUrl?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    enabled: boolean;
    type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
    url?: string | undefined;
    headers?: Record<string, string> | undefined;
    startupTimeoutMs?: number | undefined;
    toolTimeoutMs?: number | undefined;
    transport?: "stdio" | "http" | "sse" | undefined;
    auth?: {
        type?: "url" | "manual" | "oauth" | undefined;
        message?: string | undefined;
        startUrl?: string | undefined;
    } | undefined;
    command?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    bundle?: string | undefined;
    args?: string[] | undefined;
}, {
    name: string;
    type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
    url?: string | undefined;
    headers?: Record<string, string> | undefined;
    startupTimeoutMs?: number | undefined;
    toolTimeoutMs?: number | undefined;
    transport?: "stdio" | "http" | "sse" | undefined;
    enabled?: boolean | undefined;
    auth?: {
        type?: "url" | "manual" | "oauth" | undefined;
        message?: string | undefined;
        startUrl?: string | undefined;
    } | undefined;
    command?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    bundle?: string | undefined;
    args?: string[] | undefined;
}>, {
    name: string;
    enabled: boolean;
    type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
    url?: string | undefined;
    headers?: Record<string, string> | undefined;
    startupTimeoutMs?: number | undefined;
    toolTimeoutMs?: number | undefined;
    transport?: "stdio" | "http" | "sse" | undefined;
    auth?: {
        type?: "url" | "manual" | "oauth" | undefined;
        message?: string | undefined;
        startUrl?: string | undefined;
    } | undefined;
    command?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    bundle?: string | undefined;
    args?: string[] | undefined;
}, {
    name: string;
    type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
    url?: string | undefined;
    headers?: Record<string, string> | undefined;
    startupTimeoutMs?: number | undefined;
    toolTimeoutMs?: number | undefined;
    transport?: "stdio" | "http" | "sse" | undefined;
    enabled?: boolean | undefined;
    auth?: {
        type?: "url" | "manual" | "oauth" | undefined;
        message?: string | undefined;
        startUrl?: string | undefined;
    } | undefined;
    command?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    bundle?: string | undefined;
    args?: string[] | undefined;
}>;
declare const NexusConfigSchema: z.ZodObject<{
    model: z.ZodDefault<z.ZodObject<{
        provider: z.ZodEnum<["anthropic", "openai", "google", "ollama", "openai-compatible", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "minimax"]>;
        id: z.ZodString;
        apiKey: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        /** Reasoning effort hint for reasoning-capable models. "auto" (default) enables thinking only for known reasoning models. */
        reasoningEffort: z.ZodDefault<z.ZodString>;
        /**
         * How stored assistant reasoning is sent on the next request (KiloCode-style).
         * `auto` hoists to `reasoning_content` for e.g. DeepSeek; otherwise keeps native `reasoning` parts in message content.
         */
        reasoningHistoryMode: z.ZodDefault<z.ZodEnum<["auto", "inline", "reasoning_content", "reasoning_details"]>>;
        /** Optional explicit context window size override (tokens). */
        contextWindow: z.ZodOptional<z.ZodNumber>;
        resourceName: z.ZodOptional<z.ZodString>;
        deploymentId: z.ZodOptional<z.ZodString>;
        apiVersion: z.ZodOptional<z.ZodString>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        provider: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity";
        reasoningEffort: string;
        reasoningHistoryMode: "inline" | "auto" | "reasoning_content" | "reasoning_details";
        temperature?: number | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        id: string;
        provider: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity";
        temperature?: number | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "inline" | "auto" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>>;
    embeddings: z.ZodOptional<z.ZodObject<{
        provider: z.ZodEnum<["openai", "openai-compatible", "openrouter", "ollama", "google", "mistral", "bedrock", "local"]>;
        model: z.ZodString;
        baseUrl: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        dimensions: z.ZodOptional<z.ZodNumber>;
        /** AWS region for Bedrock */
        region: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    }, {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    }>>;
    vectorDb: z.ZodOptional<z.ZodObject<{
        /** Disabled by default. Set to true to enable vector codebase search (requires Qdrant + embeddings). */
        enabled: z.ZodDefault<z.ZodBoolean>;
        url: z.ZodDefault<z.ZodString>;
        collection: z.ZodDefault<z.ZodString>;
        autoStart: z.ZodDefault<z.ZodBoolean>;
        /** Qdrant API key (e.g. Qdrant Cloud). Also read from env `QDRANT_API_KEY` when unset. */
        apiKey: z.ZodOptional<z.ZodString>;
        /** Wait for Qdrant to persist upserts/deletes (recommended). */
        upsertWait: z.ZodDefault<z.ZodBoolean>;
        /** Minimum similarity score (0–1 for cosine) for search hits. Omit for no threshold (legacy behavior). */
        searchMinScore: z.ZodOptional<z.ZodNumber>;
        /** HNSW `ef` at query time (higher → better recall, slower). Default 128. */
        searchHnswEf: z.ZodOptional<z.ZodNumber>;
        /** Exhaustive/exact vector search (slower). */
        searchExact: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        url: string;
        enabled: boolean;
        autoStart: boolean;
        collection: string;
        upsertWait: boolean;
        apiKey?: string | undefined;
        searchMinScore?: number | undefined;
        searchHnswEf?: number | undefined;
        searchExact?: boolean | undefined;
    }, {
        url?: string | undefined;
        enabled?: boolean | undefined;
        apiKey?: string | undefined;
        autoStart?: boolean | undefined;
        collection?: string | undefined;
        upsertWait?: boolean | undefined;
        searchMinScore?: number | undefined;
        searchHnswEf?: number | undefined;
        searchExact?: boolean | undefined;
    }>>;
    modes: z.ZodDefault<z.ZodObject<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, "strip", z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }>>, z.objectOutputType<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }>>, "strip">, z.objectInputType<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }>>, "strip">>>;
    indexing: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        excludePatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        symbolExtract: z.ZodDefault<z.ZodBoolean>;
        /** Disabled by default. Set to true with vectorDb.enabled to use semantic codebase_search. */
        vector: z.ZodDefault<z.ZodBoolean>;
        batchSize: z.ZodDefault<z.ZodNumber>;
        /** Min semantic segments per embed/upsert batch (Roo-style segment threshold). */
        embeddingBatchSize: z.ZodDefault<z.ZodNumber>;
        embeddingConcurrency: z.ZodDefault<z.ZodNumber>;
        /** Max embed batches in flight while parsing (backpressure / memory). */
        maxPendingEmbedBatches: z.ZodDefault<z.ZodNumber>;
        /** Parallel embed/upsert pipelines (batches). */
        batchProcessingConcurrency: z.ZodDefault<z.ZodNumber>;
        /**
         * Max indexable files per workspace. Roo parity: **0 = scan nothing** (same as `listFiles(..., 0)`).
         * Use a large positive value if you need an effectively unlimited tree. Default 50_000 matches Roo.
         */
        maxIndexedFiles: z.ZodDefault<z.ZodNumber>;
        /**
         * Allow CodebaseSearch while indexing is in progress when Qdrant already has points (partial results).
         * Default true. Set false to wait until `markIndexingComplete` (strict consistency).
         */
        searchWhileIndexing: z.ZodDefault<z.ZodBoolean>;
        /**
         * If >0, indexing is treated as failed when more than this fraction of chunks could not be embedded
         * (after retries). Triggers index + tracker reset (Roo-style).
         */
        maxIndexingFailureRate: z.ZodDefault<z.ZodNumber>;
        debounceMs: z.ZodDefault<z.ZodNumber>;
        /** Max characters of each hit’s code snippet in CodebaseSearch output (indexed payload is capped separately). */
        codebaseSearchSnippetMaxChars: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        excludePatterns: string[];
        symbolExtract: boolean;
        vector: boolean;
        batchSize: number;
        embeddingBatchSize: number;
        embeddingConcurrency: number;
        maxPendingEmbedBatches: number;
        batchProcessingConcurrency: number;
        maxIndexedFiles: number;
        searchWhileIndexing: boolean;
        maxIndexingFailureRate: number;
        debounceMs: number;
        codebaseSearchSnippetMaxChars: number;
    }, {
        enabled?: boolean | undefined;
        excludePatterns?: string[] | undefined;
        symbolExtract?: boolean | undefined;
        vector?: boolean | undefined;
        batchSize?: number | undefined;
        embeddingBatchSize?: number | undefined;
        embeddingConcurrency?: number | undefined;
        maxPendingEmbedBatches?: number | undefined;
        batchProcessingConcurrency?: number | undefined;
        maxIndexedFiles?: number | undefined;
        searchWhileIndexing?: boolean | undefined;
        maxIndexingFailureRate?: number | undefined;
        debounceMs?: number | undefined;
        codebaseSearchSnippetMaxChars?: number | undefined;
    }>>;
    permissions: z.ZodDefault<z.ZodObject<{
        autoApproveRead: z.ZodDefault<z.ZodBoolean>;
        autoApproveWrite: z.ZodDefault<z.ZodBoolean>;
        autoApproveCommand: z.ZodDefault<z.ZodBoolean>;
        autoApproveMcp: z.ZodDefault<z.ZodBoolean>;
        autoApproveBrowser: z.ZodDefault<z.ZodBoolean>;
        /** When false, loading a skill via `Skill` shows an approval dialog (Kilo-style). Default true = no prompt. */
        autoApproveSkillLoad: z.ZodDefault<z.ZodBoolean>;
        autoApproveReadPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** Commands allowed without approval for this project (stored in .nexus/allowed-commands.json) */
        allowedCommands: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** Command patterns from .nexus/settings.json + settings.local.json */
        allowCommandPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** MCP tool names allowed without approval for this project (e.g. ["codex - codex"]) */
        allowedMcpTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        denyCommandPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        askCommandPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        denyPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
            authority: z.ZodOptional<z.ZodEnum<["host", "project"]>>;
            tool: z.ZodOptional<z.ZodString>;
            pathPattern: z.ZodOptional<z.ZodString>;
            commandPattern: z.ZodOptional<z.ZodString>;
            action: z.ZodEnum<["allow", "deny", "ask"]>;
            reason: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            action: "allow" | "ask" | "deny";
            tool?: string | undefined;
            authority?: "host" | "project" | undefined;
            reason?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
        }, {
            action: "allow" | "ask" | "deny";
            tool?: string | undefined;
            authority?: "host" | "project" | undefined;
            reason?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        rules: {
            action: "allow" | "ask" | "deny";
            tool?: string | undefined;
            authority?: "host" | "project" | undefined;
            reason?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
        }[];
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveMcp: boolean;
        autoApproveBrowser: boolean;
        autoApproveSkillLoad: boolean;
        autoApproveReadPatterns: string[];
        allowedCommands: string[];
        allowCommandPatterns: string[];
        allowedMcpTools: string[];
        denyCommandPatterns: string[];
        askCommandPatterns: string[];
        denyPatterns: string[];
    }, {
        rules?: {
            action: "allow" | "ask" | "deny";
            tool?: string | undefined;
            authority?: "host" | "project" | undefined;
            reason?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
        }[] | undefined;
        autoApproveRead?: boolean | undefined;
        autoApproveWrite?: boolean | undefined;
        autoApproveCommand?: boolean | undefined;
        autoApproveMcp?: boolean | undefined;
        autoApproveBrowser?: boolean | undefined;
        autoApproveSkillLoad?: boolean | undefined;
        autoApproveReadPatterns?: string[] | undefined;
        allowedCommands?: string[] | undefined;
        allowCommandPatterns?: string[] | undefined;
        allowedMcpTools?: string[] | undefined;
        denyCommandPatterns?: string[] | undefined;
        askCommandPatterns?: string[] | undefined;
        denyPatterns?: string[] | undefined;
    }>>;
    retry: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        maxAttempts: z.ZodDefault<z.ZodNumber>;
        initialDelayMs: z.ZodDefault<z.ZodNumber>;
        maxDelayMs: z.ZodDefault<z.ZodNumber>;
        retryOnStatus: z.ZodDefault<z.ZodArray<z.ZodNumber, "many">>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        maxAttempts: number;
        initialDelayMs: number;
        maxDelayMs: number;
        retryOnStatus: number[];
    }, {
        enabled?: boolean | undefined;
        maxAttempts?: number | undefined;
        initialDelayMs?: number | undefined;
        maxDelayMs?: number | undefined;
        retryOnStatus?: number[] | undefined;
    }>>;
    checkpoint: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        createOnWrite: z.ZodDefault<z.ZodBoolean>;
        doubleCheckCompletion: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
        doubleCheckCompletion: boolean;
    }, {
        enabled?: boolean | undefined;
        timeoutMs?: number | undefined;
        createOnWrite?: boolean | undefined;
        doubleCheckCompletion?: boolean | undefined;
    }>>;
    /** UI preferences (e.g. chat pane). */
    ui: z.ZodDefault<z.ZodObject<{
        /** When true, streamed text_delta is shown in chat as muted/small "reasoning"; when false, only final assistant text is shown. */
        showReasoningInChat: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        showReasoningInChat: boolean;
    }, {
        showReasoningInChat?: boolean | undefined;
    }>>;
    mcp: z.ZodDefault<z.ZodObject<{
        servers: z.ZodDefault<z.ZodArray<z.ZodEffects<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            cwd: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
            transport: z.ZodOptional<z.ZodEnum<["stdio", "http", "sse"]>>;
            type: z.ZodOptional<z.ZodEnum<["stdio", "sse", "streamable-http", "http"]>>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            enabled: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
            toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
            /** Optional bundle id (e.g. "context-mode"); resolved by host to command/args/env when installed. */
            bundle: z.ZodOptional<z.ZodString>;
            auth: z.ZodOptional<z.ZodObject<{
                type: z.ZodOptional<z.ZodEnum<["oauth", "url", "manual"]>>;
                startUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            }, {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            enabled: boolean;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }, {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }>, {
            name: string;
            enabled: boolean;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }, {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }>, "many">>;
        /**
         * Repository-provided MCP definitions are data, not startup authority.
         * A host may present these requests and promote one only after an explicit
         * trusted approval flow.
         */
        pendingProjectServers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            source: z.ZodLiteral<"project">;
            origin: z.ZodEnum<["project-config", "project-mcp-json"]>;
            status: z.ZodLiteral<"pending">;
            config: z.ZodEffects<z.ZodObject<{
                name: z.ZodString;
                command: z.ZodOptional<z.ZodString>;
                args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                cwd: z.ZodOptional<z.ZodString>;
                url: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
                transport: z.ZodOptional<z.ZodEnum<["stdio", "http", "sse"]>>;
                type: z.ZodOptional<z.ZodEnum<["stdio", "sse", "streamable-http", "http"]>>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                enabled: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
                startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
                toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
                /** Optional bundle id (e.g. "context-mode"); resolved by host to command/args/env when installed. */
                bundle: z.ZodOptional<z.ZodString>;
                auth: z.ZodOptional<z.ZodObject<{
                    type: z.ZodOptional<z.ZodEnum<["oauth", "url", "manual"]>>;
                    startUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                }, {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                }>>;
            }, "strip", z.ZodTypeAny, {
                name: string;
                enabled: boolean;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            }, {
                name: string;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                enabled?: boolean | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            }>, {
                name: string;
                enabled: boolean;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            }, {
                name: string;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                enabled?: boolean | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            status: "pending";
            origin: "project-config" | "project-mcp-json";
            config: {
                name: string;
                enabled: boolean;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            };
            source: "project";
        }, {
            status: "pending";
            origin: "project-config" | "project-mcp-json";
            config: {
                name: string;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                enabled?: boolean | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            };
            source: "project";
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        servers: {
            name: string;
            enabled: boolean;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }[];
        pendingProjectServers: {
            status: "pending";
            origin: "project-config" | "project-mcp-json";
            config: {
                name: string;
                enabled: boolean;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            };
            source: "project";
        }[];
    }, {
        servers?: {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }[] | undefined;
        pendingProjectServers?: {
            status: "pending";
            origin: "project-config" | "project-mcp-json";
            config: {
                name: string;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                enabled?: boolean | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            };
            source: "project";
        }[] | undefined;
    }>>;
    /**
     * Normalized repository requests which are inert until the exact workspace
     * host store approves their content fingerprint.
     */
    pendingProjectAuthority: z.ZodDefault<z.ZodArray<z.ZodType<PendingProjectAuthorityRequest<"profiles" | "custom-tools" | "model-endpoint" | "embeddings-endpoint" | "vector-db-endpoint" | "remote-skills" | "external-skill-paths" | "external-rule-paths" | "external-memory-path" | "claude-global-directory">, z.ZodTypeDef, PendingProjectAuthorityRequest<"profiles" | "custom-tools" | "model-endpoint" | "embeddings-endpoint" | "vector-db-endpoint" | "remote-skills" | "external-skill-paths" | "external-rule-paths" | "external-memory-path" | "claude-global-directory">>, "many">>;
    skills: z.ZodDefault<z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodObject<{
        path: z.ZodString;
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        enabled?: boolean | undefined;
    }, {
        path: string;
        enabled?: boolean | undefined;
    }>]>, "many">>;
    /** Remote skill registries (base URL → index.json + files), cached under ~/.nexus/cache/skills/. */
    skillsUrls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tools: z.ZodDefault<z.ZodObject<{
        custom: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        parallelReads: z.ZodDefault<z.ZodBoolean>;
        maxParallelReads: z.ZodDefault<z.ZodNumber>;
        /** Deferred tool loading strategy for MCP/custom heavy tools. */
        deferredLoadingMode: z.ZodDefault<z.ZodEnum<["auto", "always", "never"]>>;
        /** In auto mode, switch to ToolSearch when deferred tools exceed this fraction of context. */
        deferredLoadingThresholdPercent: z.ZodDefault<z.ZodNumber>;
        /** In auto mode, always defer once this many tools are marked shouldDefer. */
        deferredLoadingMinimumTools: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        custom: string[];
        parallelReads: boolean;
        maxParallelReads: number;
        deferredLoadingMode: "never" | "always" | "auto";
        deferredLoadingThresholdPercent: number;
        deferredLoadingMinimumTools: number;
    }, {
        custom?: string[] | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
        deferredLoadingMode?: "never" | "always" | "auto" | undefined;
        deferredLoadingThresholdPercent?: number | undefined;
        deferredLoadingMinimumTools?: number | undefined;
    }>>;
    structuredOutput: z.ZodDefault<z.ZodEnum<["auto", "always", "never"]>>;
    summarization: z.ZodDefault<z.ZodObject<{
        auto: z.ZodDefault<z.ZodBoolean>;
        threshold: z.ZodDefault<z.ZodNumber>;
        keepRecentMessages: z.ZodDefault<z.ZodNumber>;
        model: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        model: string;
        auto: boolean;
        threshold: number;
        keepRecentMessages: number;
    }, {
        model?: string | undefined;
        auto?: boolean | undefined;
        threshold?: number | undefined;
        keepRecentMessages?: number | undefined;
    }>>;
    parallelAgents: z.ZodDefault<z.ZodObject<{
        maxParallel: z.ZodDefault<z.ZodNumber>;
        /** Maximum task/agent descriptors accepted by one parallel spawn call. */
        maxTasksPerCall: z.ZodDefault<z.ZodNumber>;
        maxDepth: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxDepth: number;
        maxTasksPerCall: number;
        maxParallel: number;
    }, {
        maxDepth?: number | undefined;
        maxTasksPerCall?: number | undefined;
        maxParallel?: number | undefined;
    }>>;
    compatibility: z.ZodDefault<z.ZodObject<{
        claude: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            includeGlobalDir: z.ZodDefault<z.ZodBoolean>;
            includeProjectDir: z.ZodDefault<z.ZodBoolean>;
            includeLocalInstructions: z.ZodDefault<z.ZodBoolean>;
            includeRules: z.ZodDefault<z.ZodBoolean>;
            includeSettings: z.ZodDefault<z.ZodBoolean>;
            includeCommands: z.ZodDefault<z.ZodBoolean>;
            includeSkills: z.ZodDefault<z.ZodBoolean>;
            includeAgents: z.ZodDefault<z.ZodBoolean>;
            includePlugins: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            includeGlobalDir: boolean;
            includeProjectDir: boolean;
            includeLocalInstructions: boolean;
            includeRules: boolean;
            includeSettings: boolean;
            includeCommands: boolean;
            includeSkills: boolean;
            includeAgents: boolean;
            includePlugins: boolean;
        }, {
            enabled?: boolean | undefined;
            includeGlobalDir?: boolean | undefined;
            includeProjectDir?: boolean | undefined;
            includeLocalInstructions?: boolean | undefined;
            includeRules?: boolean | undefined;
            includeSettings?: boolean | undefined;
            includeCommands?: boolean | undefined;
            includeSkills?: boolean | undefined;
            includeAgents?: boolean | undefined;
            includePlugins?: boolean | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        claude: {
            enabled: boolean;
            includeGlobalDir: boolean;
            includeProjectDir: boolean;
            includeLocalInstructions: boolean;
            includeRules: boolean;
            includeSettings: boolean;
            includeCommands: boolean;
            includeSkills: boolean;
            includeAgents: boolean;
            includePlugins: boolean;
        };
    }, {
        claude?: {
            enabled?: boolean | undefined;
            includeGlobalDir?: boolean | undefined;
            includeProjectDir?: boolean | undefined;
            includeLocalInstructions?: boolean | undefined;
            includeRules?: boolean | undefined;
            includeSettings?: boolean | undefined;
            includeCommands?: boolean | undefined;
            includeSkills?: boolean | undefined;
            includeAgents?: boolean | undefined;
            includePlugins?: boolean | undefined;
        } | undefined;
    }>>;
    plugins: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        trusted: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        blocked: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        enableHooks: z.ZodDefault<z.ZodBoolean>;
        hookTimeoutMs: z.ZodDefault<z.ZodNumber>;
        options: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, "strip", z.ZodTypeAny, {
        options: Record<string, Record<string, unknown>>;
        enabled: boolean;
        trusted: string[];
        enableHooks: boolean;
        blocked: string[];
        hookTimeoutMs: number;
    }, {
        options?: Record<string, Record<string, unknown>> | undefined;
        enabled?: boolean | undefined;
        trusted?: string[] | undefined;
        enableHooks?: boolean | undefined;
        blocked?: string[] | undefined;
        hookTimeoutMs?: number | undefined;
    }>>;
    /** Optional overrides for agent loop limits (OpenCode-style: allow enough tools/iterations to finish). */
    agentLoop: z.ZodDefault<z.ZodObject<{
        toolCallBudget: z.ZodOptional<z.ZodObject<{
            ask: z.ZodOptional<z.ZodNumber>;
            plan: z.ZodOptional<z.ZodNumber>;
            agent: z.ZodOptional<z.ZodNumber>;
            debug: z.ZodOptional<z.ZodNumber>;
            review: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        }, {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        }>>;
        maxIterations: z.ZodOptional<z.ZodObject<{
            ask: z.ZodOptional<z.ZodNumber>;
            plan: z.ZodOptional<z.ZodNumber>;
            agent: z.ZodOptional<z.ZodNumber>;
            debug: z.ZodOptional<z.ZodNumber>;
            review: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        }, {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        toolCallBudget?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
        maxIterations?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
    }, {
        toolCallBudget?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
        maxIterations?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
    }>>;
    rules: z.ZodDefault<z.ZodObject<{
        files: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        files: string[];
    }, {
        files?: string[] | undefined;
    }>>;
    /**
     * OpenClaude-class memory: auto-memory dir, session scrolling notes file, tool spill hints.
     * Session file lives next to JSONL under .nexus/sessions (per project hash).
     */
    memory: z.ZodDefault<z.ZodObject<{
        /** Load project auto-memory markdown into the rules block (OpenClaude auto-memory parity). */
        autoMemoryEnabled: z.ZodDefault<z.ZodBoolean>;
        /** Override directory; tilde expanded for home. When unset, uses default project memory dir. */
        autoMemoryDirectory: z.ZodOptional<z.ZodString>;
        /** Maintain session-memory.md next to JSONL and inject into system prompt. */
        sessionMemoryEnabled: z.ZodDefault<z.ZodBoolean>;
        /** Background LLM refresh after this many tool results in the outer loop (approximate). */
        sessionMemoryMinToolCallsBetweenUpdates: z.ZodDefault<z.ZodNumber>;
        /** Max stored characters for the session memory file. */
        sessionMemoryMaxChars: z.ZodDefault<z.ZodNumber>;
        /** When compacting tool results, keep spill path in model-facing text (stronger OpenClaude parity). */
        emphasizeToolSpillPaths: z.ZodDefault<z.ZodBoolean>;
        /** Load team markdown from ~/.nexus/teams/{encoded name}/memory/ for runtime teams. */
        teamMemoryEnabled: z.ZodDefault<z.ZodBoolean>;
        /** Periodically consolidate auto-memory dir into _nexus_consolidated_memory.md via LLM. */
        autoDreamEnabled: z.ZodDefault<z.ZodBoolean>;
        /** Min milliseconds between auto-dream runs. */
        autoDreamMinIntervalMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        sessionMemoryEnabled: boolean;
        autoMemoryEnabled: boolean;
        autoDreamEnabled: boolean;
        teamMemoryEnabled: boolean;
        emphasizeToolSpillPaths: boolean;
        sessionMemoryMinToolCallsBetweenUpdates: number;
        sessionMemoryMaxChars: number;
        autoDreamMinIntervalMs: number;
        autoMemoryDirectory?: string | undefined;
    }, {
        sessionMemoryEnabled?: boolean | undefined;
        autoMemoryEnabled?: boolean | undefined;
        autoDreamEnabled?: boolean | undefined;
        teamMemoryEnabled?: boolean | undefined;
        emphasizeToolSpillPaths?: boolean | undefined;
        autoMemoryDirectory?: string | undefined;
        sessionMemoryMinToolCallsBetweenUpdates?: number | undefined;
        sessionMemoryMaxChars?: number | undefined;
        autoDreamMinIntervalMs?: number | undefined;
    }>>;
    profiles: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodOptional<z.ZodEnum<["anthropic", "openai", "google", "ollama", "openai-compatible", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "minimax"]>>;
        id: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        temperature: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        reasoningEffort: z.ZodOptional<z.ZodDefault<z.ZodString>>;
        reasoningHistoryMode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "inline", "reasoning_content", "reasoning_details"]>>>;
        contextWindow: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        resourceName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        deploymentId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        apiVersion: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        extra: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, "strip", z.ZodTypeAny, {
        id?: string | undefined;
        temperature?: number | undefined;
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "inline" | "auto" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        id?: string | undefined;
        temperature?: number | undefined;
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "inline" | "auto" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    tools: {
        custom: string[];
        parallelReads: boolean;
        maxParallelReads: number;
        deferredLoadingMode: "never" | "always" | "auto";
        deferredLoadingThresholdPercent: number;
        deferredLoadingMinimumTools: number;
    };
    mcp: {
        servers: {
            name: string;
            enabled: boolean;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }[];
        pendingProjectServers: {
            status: "pending";
            origin: "project-config" | "project-mcp-json";
            config: {
                name: string;
                enabled: boolean;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            };
            source: "project";
        }[];
    };
    memory: {
        sessionMemoryEnabled: boolean;
        autoMemoryEnabled: boolean;
        autoDreamEnabled: boolean;
        teamMemoryEnabled: boolean;
        emphasizeToolSpillPaths: boolean;
        sessionMemoryMinToolCallsBetweenUpdates: number;
        sessionMemoryMaxChars: number;
        autoDreamMinIntervalMs: number;
        autoMemoryDirectory?: string | undefined;
    };
    model: {
        id: string;
        provider: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity";
        reasoningEffort: string;
        reasoningHistoryMode: "inline" | "auto" | "reasoning_content" | "reasoning_details";
        temperature?: number | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    };
    compatibility: {
        claude: {
            enabled: boolean;
            includeGlobalDir: boolean;
            includeProjectDir: boolean;
            includeLocalInstructions: boolean;
            includeRules: boolean;
            includeSettings: boolean;
            includeCommands: boolean;
            includeSkills: boolean;
            includeAgents: boolean;
            includePlugins: boolean;
        };
    };
    modes: {
        agent?: {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        plan?: {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        ask?: {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        debug?: {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        review?: {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        } | undefined;
    } & {
        [k: string]: {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        } | undefined;
    };
    indexing: {
        enabled: boolean;
        excludePatterns: string[];
        symbolExtract: boolean;
        vector: boolean;
        batchSize: number;
        embeddingBatchSize: number;
        embeddingConcurrency: number;
        maxPendingEmbedBatches: number;
        batchProcessingConcurrency: number;
        maxIndexedFiles: number;
        searchWhileIndexing: boolean;
        maxIndexingFailureRate: number;
        debounceMs: number;
        codebaseSearchSnippetMaxChars: number;
    };
    permissions: {
        rules: {
            action: "allow" | "ask" | "deny";
            tool?: string | undefined;
            authority?: "host" | "project" | undefined;
            reason?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
        }[];
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveMcp: boolean;
        autoApproveBrowser: boolean;
        autoApproveSkillLoad: boolean;
        autoApproveReadPatterns: string[];
        allowedCommands: string[];
        allowCommandPatterns: string[];
        allowedMcpTools: string[];
        denyCommandPatterns: string[];
        askCommandPatterns: string[];
        denyPatterns: string[];
    };
    retry: {
        enabled: boolean;
        maxAttempts: number;
        initialDelayMs: number;
        maxDelayMs: number;
        retryOnStatus: number[];
    };
    checkpoint: {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
        doubleCheckCompletion: boolean;
    };
    ui: {
        showReasoningInChat: boolean;
    };
    pendingProjectAuthority: PendingProjectAuthorityRequest<"profiles" | "custom-tools" | "model-endpoint" | "embeddings-endpoint" | "vector-db-endpoint" | "remote-skills" | "external-skill-paths" | "external-rule-paths" | "external-memory-path" | "claude-global-directory">[];
    skills: (string | {
        path: string;
        enabled?: boolean | undefined;
    })[];
    structuredOutput: "never" | "always" | "auto";
    summarization: {
        model: string;
        auto: boolean;
        threshold: number;
        keepRecentMessages: number;
    };
    parallelAgents: {
        maxDepth: number;
        maxTasksPerCall: number;
        maxParallel: number;
    };
    plugins: {
        options: Record<string, Record<string, unknown>>;
        enabled: boolean;
        trusted: string[];
        enableHooks: boolean;
        blocked: string[];
        hookTimeoutMs: number;
    };
    agentLoop: {
        toolCallBudget?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
        maxIterations?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
    };
    rules: {
        files: string[];
    };
    profiles: Record<string, {
        id?: string | undefined;
        temperature?: number | undefined;
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "inline" | "auto" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>;
    embeddings?: {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    } | undefined;
    vectorDb?: {
        url: string;
        enabled: boolean;
        autoStart: boolean;
        collection: string;
        upsertWait: boolean;
        apiKey?: string | undefined;
        searchMinScore?: number | undefined;
        searchHnswEf?: number | undefined;
        searchExact?: boolean | undefined;
    } | undefined;
    skillsUrls?: string[] | undefined;
}, {
    tools?: {
        custom?: string[] | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
        deferredLoadingMode?: "never" | "always" | "auto" | undefined;
        deferredLoadingThresholdPercent?: number | undefined;
        deferredLoadingMinimumTools?: number | undefined;
    } | undefined;
    mcp?: {
        servers?: {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            url?: string | undefined;
            headers?: Record<string, string> | undefined;
            startupTimeoutMs?: number | undefined;
            toolTimeoutMs?: number | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            auth?: {
                type?: "url" | "manual" | "oauth" | undefined;
                message?: string | undefined;
                startUrl?: string | undefined;
            } | undefined;
            command?: string | undefined;
            cwd?: string | undefined;
            env?: Record<string, string> | undefined;
            bundle?: string | undefined;
            args?: string[] | undefined;
        }[] | undefined;
        pendingProjectServers?: {
            status: "pending";
            origin: "project-config" | "project-mcp-json";
            config: {
                name: string;
                type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
                url?: string | undefined;
                headers?: Record<string, string> | undefined;
                startupTimeoutMs?: number | undefined;
                toolTimeoutMs?: number | undefined;
                transport?: "stdio" | "http" | "sse" | undefined;
                enabled?: boolean | undefined;
                auth?: {
                    type?: "url" | "manual" | "oauth" | undefined;
                    message?: string | undefined;
                    startUrl?: string | undefined;
                } | undefined;
                command?: string | undefined;
                cwd?: string | undefined;
                env?: Record<string, string> | undefined;
                bundle?: string | undefined;
                args?: string[] | undefined;
            };
            source: "project";
        }[] | undefined;
    } | undefined;
    memory?: {
        sessionMemoryEnabled?: boolean | undefined;
        autoMemoryEnabled?: boolean | undefined;
        autoDreamEnabled?: boolean | undefined;
        teamMemoryEnabled?: boolean | undefined;
        emphasizeToolSpillPaths?: boolean | undefined;
        autoMemoryDirectory?: string | undefined;
        sessionMemoryMinToolCallsBetweenUpdates?: number | undefined;
        sessionMemoryMaxChars?: number | undefined;
        autoDreamMinIntervalMs?: number | undefined;
    } | undefined;
    model?: {
        id: string;
        provider: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity";
        temperature?: number | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "inline" | "auto" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    } | undefined;
    compatibility?: {
        claude?: {
            enabled?: boolean | undefined;
            includeGlobalDir?: boolean | undefined;
            includeProjectDir?: boolean | undefined;
            includeLocalInstructions?: boolean | undefined;
            includeRules?: boolean | undefined;
            includeSettings?: boolean | undefined;
            includeCommands?: boolean | undefined;
            includeSkills?: boolean | undefined;
            includeAgents?: boolean | undefined;
            includePlugins?: boolean | undefined;
        } | undefined;
    } | undefined;
    embeddings?: {
        model: string;
        provider: "local" | "bedrock" | "openrouter" | "openai-compatible" | "openai" | "google" | "ollama" | "mistral";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    } | undefined;
    vectorDb?: {
        url?: string | undefined;
        enabled?: boolean | undefined;
        apiKey?: string | undefined;
        autoStart?: boolean | undefined;
        collection?: string | undefined;
        upsertWait?: boolean | undefined;
        searchMinScore?: number | undefined;
        searchHnswEf?: number | undefined;
        searchExact?: boolean | undefined;
    } | undefined;
    modes?: z.objectInputType<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }, {
            systemPrompt?: string | undefined;
            autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }, {
        systemPrompt?: string | undefined;
        autoApprove?: ("mcp" | "search" | "write" | "execute" | "browser" | "read")[] | undefined;
        customInstructions?: string | undefined;
    }>>, "strip"> | undefined;
    indexing?: {
        enabled?: boolean | undefined;
        excludePatterns?: string[] | undefined;
        symbolExtract?: boolean | undefined;
        vector?: boolean | undefined;
        batchSize?: number | undefined;
        embeddingBatchSize?: number | undefined;
        embeddingConcurrency?: number | undefined;
        maxPendingEmbedBatches?: number | undefined;
        batchProcessingConcurrency?: number | undefined;
        maxIndexedFiles?: number | undefined;
        searchWhileIndexing?: boolean | undefined;
        maxIndexingFailureRate?: number | undefined;
        debounceMs?: number | undefined;
        codebaseSearchSnippetMaxChars?: number | undefined;
    } | undefined;
    permissions?: {
        rules?: {
            action: "allow" | "ask" | "deny";
            tool?: string | undefined;
            authority?: "host" | "project" | undefined;
            reason?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
        }[] | undefined;
        autoApproveRead?: boolean | undefined;
        autoApproveWrite?: boolean | undefined;
        autoApproveCommand?: boolean | undefined;
        autoApproveMcp?: boolean | undefined;
        autoApproveBrowser?: boolean | undefined;
        autoApproveSkillLoad?: boolean | undefined;
        autoApproveReadPatterns?: string[] | undefined;
        allowedCommands?: string[] | undefined;
        allowCommandPatterns?: string[] | undefined;
        allowedMcpTools?: string[] | undefined;
        denyCommandPatterns?: string[] | undefined;
        askCommandPatterns?: string[] | undefined;
        denyPatterns?: string[] | undefined;
    } | undefined;
    retry?: {
        enabled?: boolean | undefined;
        maxAttempts?: number | undefined;
        initialDelayMs?: number | undefined;
        maxDelayMs?: number | undefined;
        retryOnStatus?: number[] | undefined;
    } | undefined;
    checkpoint?: {
        enabled?: boolean | undefined;
        timeoutMs?: number | undefined;
        createOnWrite?: boolean | undefined;
        doubleCheckCompletion?: boolean | undefined;
    } | undefined;
    ui?: {
        showReasoningInChat?: boolean | undefined;
    } | undefined;
    pendingProjectAuthority?: PendingProjectAuthorityRequest<"profiles" | "custom-tools" | "model-endpoint" | "embeddings-endpoint" | "vector-db-endpoint" | "remote-skills" | "external-skill-paths" | "external-rule-paths" | "external-memory-path" | "claude-global-directory">[] | undefined;
    skills?: (string | {
        path: string;
        enabled?: boolean | undefined;
    })[] | undefined;
    skillsUrls?: string[] | undefined;
    structuredOutput?: "never" | "always" | "auto" | undefined;
    summarization?: {
        model?: string | undefined;
        auto?: boolean | undefined;
        threshold?: number | undefined;
        keepRecentMessages?: number | undefined;
    } | undefined;
    parallelAgents?: {
        maxDepth?: number | undefined;
        maxTasksPerCall?: number | undefined;
        maxParallel?: number | undefined;
    } | undefined;
    plugins?: {
        options?: Record<string, Record<string, unknown>> | undefined;
        enabled?: boolean | undefined;
        trusted?: string[] | undefined;
        enableHooks?: boolean | undefined;
        blocked?: string[] | undefined;
        hookTimeoutMs?: number | undefined;
    } | undefined;
    agentLoop?: {
        toolCallBudget?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
        maxIterations?: {
            agent?: number | undefined;
            plan?: number | undefined;
            ask?: number | undefined;
            debug?: number | undefined;
            review?: number | undefined;
        } | undefined;
    } | undefined;
    rules?: {
        files?: string[] | undefined;
    } | undefined;
    profiles?: Record<string, {
        id?: string | undefined;
        temperature?: number | undefined;
        provider?: "anthropic" | "bedrock" | "openai-compatible" | "minimax" | "openai" | "google" | "ollama" | "azure" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "inline" | "auto" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }> | undefined;
}>;

interface ClaudeCompatibilityOptions {
    enabled: boolean;
    includeGlobalDir: boolean;
    includeProjectDir: boolean;
    includeLocalInstructions: boolean;
    includeRules: boolean;
    includeSettings: boolean;
    includeCommands: boolean;
    includeSkills: boolean;
    includeAgents: boolean;
    includePlugins: boolean;
}
declare function getClaudeCompatibilityOptions(config?: Pick<NexusConfig, "compatibility"> | null): ClaudeCompatibilityOptions;

type CredentialPurpose = "chat" | "embeddings";
interface CredentialIdentity {
    purpose: CredentialPurpose;
    provider: string;
    destination: string;
}
interface ResolvedCredential {
    identity: CredentialIdentity;
    apiKey?: string;
    source: "explicit" | "environment" | "local" | "kilo-free" | "native";
}
/**
 * Canonical credential destinations deliberately retain the complete base path:
 * credentials for two tenants on one host are not interchangeable.
 */
declare function canonicalizeCredentialDestination(baseUrl: string): string;
declare function getProviderCredentialIdentity(config: ProviderConfig): CredentialIdentity;
declare function getEmbeddingCredentialIdentity(config: EmbeddingConfig): CredentialIdentity;
declare function credentialIdentityKey(identity: CredentialIdentity): string;
declare function resolveProviderCredential(config: ProviderConfig, env?: NodeJS.ProcessEnv): ResolvedCredential;
declare function resolveEmbeddingCredential(config: EmbeddingConfig, env?: NodeJS.ProcessEnv): ResolvedCredential;
declare function mergeProviderConfigSafely(current: ProviderConfig, patch: Partial<ProviderConfig>): ProviderConfig;
declare function mergeProviderConfigPartialSafely(current: Partial<ProviderConfig>, patch: Partial<ProviderConfig>): Partial<ProviderConfig>;
/**
 * Apply a preset's model selector as one endpoint-aware transaction.
 * `openrouter` is an alias with a fixed trusted endpoint. A generic compatible
 * preset must reuse an already explicit compatible endpoint; provider+model
 * alone is not a complete or safe selection.
 */
declare function mergeModelPresetSelection(current: ProviderConfig, provider: string, modelId: string): ProviderConfig;
/**
 * Profile activation is a new credential binding even when provider and
 * destination match the active profile. Never inherit the active key.
 */
declare function selectProviderProfile(base: ProviderConfig, profile: Partial<ProviderConfig>): ProviderConfig;
declare function mergeEmbeddingConfigSafely(current: EmbeddingConfig, patch: Partial<EmbeddingConfig>): EmbeddingConfig;
declare function normalizeAzureResourceName(value: unknown): string;
declare function normalizeAwsRegion(value: unknown): string;

/**
 * Secrets store abstraction for hosts that support it.
 * API keys are never written to YAML; they are stored in a secure store and
 * applied at load time after env overrides.
 */

/** Key used in secrets store (VS Code secretStorage or file) for API keys payload. */
declare const NEXUS_SECRETS_STORAGE_KEY = "nexuscode_api";
interface NexusBoundSecret extends CredentialIdentity {
    secret: string;
}
interface NexusLegacyUnboundSecrets {
    model?: string;
    embeddings?: string;
    profiles?: Record<string, string>;
}
interface NexusSecretsPayload {
    version: 2;
    credentials: Record<string, NexusBoundSecret>;
    /**
     * Compatibility binding for named local profiles. The remote protocol still
     * needs stable profile IDs; names are never treated as credential identity.
     */
    profileCredentials?: Record<string, NexusBoundSecret>;
    /**
     * V1 values had no destination identity. They remain available for explicit
     * migration UI, but are never attached to a request automatically.
     */
    legacyUnbound?: NexusLegacyUnboundSecrets;
    /** Qdrant / vector DB API key (same store as other keys; never written to YAML). */
    qdrantApiKey?: string;
}
interface NexusSecretsStore {
    getSecret(key: string): Promise<string | undefined>;
    setSecret(key: string, value: string): Promise<void>;
    /**
     * Optional atomic read-modify-write primitive. File-backed stores implement
     * this under one cross-process lock; hosts without it are serialized by an
     * in-process per-store queue.
     */
    updateSecret?(key: string, update: (current: string | undefined) => string | undefined | Promise<string | undefined>): Promise<void>;
}
interface FinalizeConfigCredentialsOptions {
    /**
     * A named profile has an independent credential binding even when it points
     * at the same provider destination as another profile or the base model.
     */
    profileName?: string;
    /**
     * Immutable host-scoped environment captured while loading config. Passing
     * it avoids relying on global process mutation for project-local `.env`.
     */
    environment?: Readonly<Record<string, string | undefined>>;
}
interface ProfileCredentialRemoval {
    name: string;
    /** The previously resolved profile model whose binding must be removed. */
    model: ProviderConfig;
}
interface SecretsRemoval {
    /** `true` targets config.model; a config value can target an old scope. */
    model?: true | ProviderConfig;
    /** `true` targets config.embeddings; a config value can target an old scope. */
    embeddings?: true | EmbeddingConfig;
    /**
     * Remove a named binding only when it still matches this old identity.
     * This lets an endpoint change replace the key atomically.
     */
    profileBindings?: ProfileCredentialRemoval[];
    /** Unconditional user-requested deletion by profile name. */
    profileNames?: string[];
    qdrant?: boolean;
}
interface PersistSecretsOptions {
    remove?: SecretsRemoval;
}
declare class UnsupportedSecretsVersionError extends Error {
    readonly version: unknown;
    constructor(version: unknown);
}
type SecretsCorruptionReason = "invalid-json" | "invalid-root" | "missing-credentials" | "invalid-credentials" | "invalid-credential" | "credential-key-mismatch" | "invalid-profile-credentials" | "invalid-profile-credential" | "profile-name-collision" | "invalid-legacy-payload" | "invalid-qdrant-key";
declare class SecretsCorruptionError extends Error {
    readonly reason: SecretsCorruptionReason;
    constructor(reason: SecretsCorruptionReason, cause?: unknown);
}
declare class ProfileCredentialCollisionError extends Error {
    readonly canonicalName: string;
    constructor(canonicalName: string);
}
/**
 * Resolve secure-store credentials only after a host has finished selecting the
 * effective model, endpoint, profile, preset and embedding configuration.
 *
 * The input is never mutated. Raw profiles remain secretless: only the final
 * runtime model receives a named profile credential.
 */
declare function finalizeConfigCredentials<T extends Record<string, unknown>>(config: T, store: NexusSecretsStore, options?: FinalizeConfigCredentialsOptions): Promise<T>;
/**
 * Backward-compatible in-place finalization for older hosts. New host code
 * should use finalizeConfigCredentials after all selection overrides.
 */
declare function applySecretsToConfig(config: Record<string, unknown>, store: NexusSecretsStore): Promise<void>;
/**
 * Strip all known provider credentials from credential-bearing config sections.
 * MCP environment/header values are deliberately outside this sanitizer because
 * they have their own secure integration lifecycle.
 */
declare function stripSecretsFromConfig<T extends Record<string, unknown>>(config: T): T;
/**
 * Strip apiKey from each profile for writing to global YAML (~/.nexus/nexus.yaml).
 * Call before writeGlobalProfiles so profile keys are never persisted in plain text.
 */
declare function stripProfileSecrets(profiles: Record<string, unknown>): Record<string, unknown>;
/**
 * Build payload from current config (model.apiKey, embeddings.apiKey, vectorDb.apiKey, profile apiKeys) for persisting to secrets store.
 */
declare function getSecretsPayloadFromConfig(config: Record<string, unknown>): NexusSecretsPayload;
/**
 * Persist model and embeddings API keys from config into the secrets store.
 * Call after merging user config; then persist config with stripSecretsFromConfig.
 */
declare function persistSecretsFromConfig(config: Record<string, unknown>, store: NexusSecretsStore, options?: PersistSecretsOptions): Promise<void>;
/**
 * File-based secrets store for CLI (single file with mode 0o600).
 * Path: {globalConfigDir}/secrets.json
 */
declare function createFileSecretsStore(globalConfigDir: string): NexusSecretsStore;

type ConfigSubstitutionErrorCode = "project-env-forbidden" | "missing-env" | "missing-file" | "unreadable-file" | "project-file-outside-workspace" | "file-changed-during-read";
declare class ConfigSubstitutionError extends Error {
    readonly code: ConfigSubstitutionErrorCode;
    readonly configPath: string;
    readonly reference: string;
    constructor(code: ConfigSubstitutionErrorCode, configPath: string, reference: string, cause?: unknown);
}
declare class ConfigFileError extends Error {
    readonly configPath: string;
    constructor(configPath: string, message: string, cause?: unknown);
}

declare class UnsafeConfigWriteError extends Error {
    constructor();
}
declare class ConfigValidationError extends Error {
    readonly sources: readonly string[];
    readonly issues: readonly {
        path: readonly (string | number)[];
        message: string;
    }[];
    constructor(sources: readonly string[], issues: readonly {
        path: readonly (string | number)[];
        message: string;
    }[]);
}
interface PendingProjectMcpServer {
    source: "project";
    origin: "project-config" | "project-mcp-json";
    status: "pending";
    config: McpServerConfig;
}
declare function getPendingProjectMcpServers(config: NexusConfig): readonly PendingProjectMcpServer[];
/**
 * Load config by walking up from cwd.
 * Merges project config over global config.
 * Applies non-secret environment selection overrides. Secure-store credentials
 * are deliberately resolved later by the host, after its final selection.
 */
declare function loadConfig(cwd?: string, options?: {
    /** @deprecated Secure credentials are finalized by the host. */
    secrets?: NexusSecretsStore;
    /**
     * Remote hosts set false to load metadata without consulting the local
     * environment or resolving `{env:...}` / `{file:...}` substitutions.
     */
    loadEnv?: boolean;
    /**
     * Override the global config path for embedded hosts/tests. `false`
     * explicitly disables the global layer.
     */
    globalConfigPath?: string | false;
}): Promise<NexusConfig>;
declare function getConfigEnvironment(config: NexusConfig): Readonly<Record<string, string | undefined>> | undefined;
/**
 * Merge config layers without allowing a secret or provider-specific field to
 * hitchhike when the higher layer changes provider or destination.
 */
declare function mergeNexusConfigLayers(base: Record<string, unknown>, override: Record<string, unknown>, options?: {
    projectRoot?: string;
}): Record<string, unknown>;
/**
 * Write config to project .nexus/nexus.yaml.
 * By default strips API keys so they are never persisted to YAML (use secrets store instead).
 */
declare function writeConfig(config: Partial<NexusConfig>, cwd?: string, options?: {
    stripSecrets?: boolean;
}): void;
/**
 * Atomically merge an explicit patch into the raw project layer.
 *
 * Existing unknown fields and substitution tokens stay as raw values. Only the
 * supplied patch is credential-sanitized; no global/default/effective config is
 * ever serialized into the project file.
 */
declare function patchProjectConfig(patch: Record<string, unknown>, cwd?: string): Promise<void>;
interface GlobalConfigPatchOptions {
    /**
     * Override the host-owned global config path for an embedded host/test.
     * Production callers normally omit this and use ~/.nexus/nexus.yaml.
     */
    configPath?: string;
}
/**
 * Atomically patch the host-owned global layer.
 *
 * Unlike project patches, authority-bearing permissions, trusted plugins and
 * MCP servers are allowed here because this file is outside repository
 * control. Credentials are still stripped and effective configs are rejected.
 */
declare function patchGlobalConfig(patch: Record<string, unknown>, options?: GlobalConfigPatchOptions): Promise<void>;
/**
 * Persist profiles to global ~/.nexus/nexus.yaml so they are available across all projects.
 * Strips apiKey from each profile so keys are never written to YAML (use secrets store).
 */
declare function writeGlobalProfiles(profiles: Record<string, unknown>): void;
/**
 * Get the global config directory
 */
declare function getGlobalConfigDir(): string;
/**
 * Ensure global config directory exists with defaults
 */
declare function ensureGlobalConfigDir(): void;

/** Format like .claude: { permissions: { allow: string[], deny: string[], ask: string[] } } */
interface ProjectSettings {
    permissions?: {
        allow?: string[];
        deny?: string[];
        ask?: string[];
        allowedMcpTools?: string[];
    };
}
/**
 * Load global ~/.nexus/settings.json and ~/.nexus/settings.local.json.
 * Same structure as .claude: permissions.allow, permissions.deny, permissions.ask.
 */
declare function loadGlobalSettings(options?: {
    compatibility?: ClaudeCompatibilityOptions;
}): ProjectSettings;
/**
 * Load .nexus/settings.json and .nexus/settings.local.json (local overrides), merge with global settings.
 * Layer order: global base → global local → project base → project local (later overrides earlier).
 */
declare function loadProjectSettings(cwd: string, options?: {
    compatibility?: ClaudeCompatibilityOptions;
}): ProjectSettings;
/**
 * Write project settings to .nexus/settings.json.
 */
declare function writeProjectSettings(cwd: string, settings: ProjectSettings): void;
/**
 * Write global settings to ~/.nexus/settings.json.
 */
declare function writeGlobalSettings(settings: ProjectSettings): void;

type NetworkPolicyErrorCode = "invalid_url" | "invalid_purpose" | "unsupported_protocol" | "url_credentials" | "blocked_hostname" | "dns_failed" | "blocked_address" | "invalid_dns_result";
declare class NetworkPolicyError extends Error {
    readonly code: NetworkPolicyErrorCode;
    constructor(code: NetworkPolicyErrorCode, message: string, cause?: unknown);
}
type NetworkResolver = (hostname: string) => Promise<readonly ResolvedNetworkAddress[]>;
interface NetworkPolicyOptions {
    resolve?: NetworkResolver;
}
/**
 * True only for a syntactically valid, globally routable IP address.
 * Reserved, private, loopback, link-local, multicast, documentation and
 * unspecified ranges are rejected for both address families.
 */
declare function isPublicNetworkAddress(address: string): boolean;
declare function authorizeNetworkRequest(request: HostNetworkRequest, options?: NetworkPolicyOptions): Promise<AuthorizedNetworkRequest>;

type NetworkRequestErrorCode = "invalid_options" | "invalid_url" | "unsupported_protocol" | "url_credentials" | "authorization_unavailable" | "invalid_authorization" | "request_too_large" | "response_too_large" | "too_many_redirects" | "invalid_redirect" | "timeout" | "aborted" | "request_failed";
declare class NetworkRequestError extends Error {
    readonly code: NetworkRequestErrorCode;
    constructor(code: NetworkRequestErrorCode, message: string, cause?: unknown);
}
interface NetworkTransportRequest {
    url: string;
    authorization: AuthorizedNetworkRequest;
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
    maxResponseBytes: number;
    signal: AbortSignal;
}
interface NetworkTransportResponse {
    status: number;
    statusText: string;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
}
type NetworkTransport = (request: NetworkTransportRequest) => Promise<NetworkTransportResponse>;
interface NetworkRequestOptions {
    purpose: NetworkRequestPurpose;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string | Uint8Array;
    maxRedirects?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Injectable transport for deterministic, network-free tests. */
    transport?: NetworkTransport;
}
interface NetworkResourceResponse extends NetworkTransportResponse {
    /** Final URL after authorized redirects. */
    url: string;
    redirectCount: number;
}
declare function requestNetworkResource(host: IHost, rawUrl: string, options: NetworkRequestOptions): Promise<NetworkResourceResponse>;
/**
 * Node transport with DNS pinning. The host resolves and authorizes every
 * address first; this lookup callback returns only those exact addresses to
 * the socket, closing the DNS-rebinding window between validation and connect.
 * A fresh, non-pooled connection is used for every hop.
 */
declare const nodePinnedTransport: NetworkTransport;

/**
 * Session-scoped "always allow" grants must not widen one approved command
 * into blanket authority for every invocation of the same shell tool.
 */
declare function approvalGrantKey(action: ApprovalAction): string;

type WorkspacePathAuthorizationErrorCode = "invalid_workspace_root" | "invalid_requested_path" | "path_outside_workspace" | "unresolvable_path";
/**
 * Raised when a host filesystem capability cannot be safely confined to its
 * workspace. Keeping this distinct from ordinary ENOENT/permission errors lets
 * adapters fail closed without treating a policy denial as a missing file.
 */
declare class WorkspacePathAuthorizationError extends Error {
    readonly code: WorkspacePathAuthorizationErrorCode;
    readonly name = "WorkspacePathAuthorizationError";
    constructor(code: WorkspacePathAuthorizationErrorCode, message: string);
}
/**
 * Resolve a host path and prove that its canonical target is the workspace
 * root or one of its descendants.
 *
 * The returned path is canonicalized rather than merely validated, so callers
 * do not subsequently operate through a known symlink alias.
 */
declare function resolveAuthorizedWorkspacePath(workspaceRoot: string, requestedPath: string): string;

declare const WORKSPACE_AUTHORITY_STORE_VERSION: 2;
type WorkspaceAuthorityGrant = {
    kind: "command";
    value: string;
} | {
    kind: "command-pattern";
    value: string;
} | {
    kind: "mcp-tool";
    value: string;
};
interface WorkspaceAuthorityIdentity {
    canonicalPath: string;
    device: string;
    inode: string;
    digest: string;
}
interface WorkspaceAuthorityGrants {
    commands: string[];
    commandPatterns: string[];
    mcpTools: string[];
}
interface WorkspaceProjectAuthorityApproval {
    kind: ProjectAuthorityRequestKind;
    fingerprint: string;
}
interface WorkspaceAuthorityRecord {
    version: typeof WORKSPACE_AUTHORITY_STORE_VERSION;
    identity: WorkspaceAuthorityIdentity;
    grants: WorkspaceAuthorityGrants;
    projectConfigApprovals: WorkspaceProjectAuthorityApproval[];
    updatedAt: string;
}
interface WorkspaceAuthorityStoreOptions {
    /**
     * Override the complete store filename. Intended for an embedding host or a
     * temporary test directory; production defaults to the Nexus host data dir.
     */
    storePath?: string;
}
type WorkspaceAuthorityStoreErrorCode = "invalid_workspace" | "invalid_grant" | "unsafe_store" | "corrupt_store" | "unsupported_version" | "store_too_large";
declare class WorkspaceAuthorityStoreError extends Error {
    readonly code: WorkspaceAuthorityStoreErrorCode;
    readonly name = "WorkspaceAuthorityStoreError";
    constructor(code: WorkspaceAuthorityStoreErrorCode, message: string);
}
type AuthorityConfig = {
    permissions: {
        allowedCommands: string[];
        allowCommandPatterns: string[];
        allowedMcpTools?: string[];
    };
    pendingProjectAuthority?: PendingProjectAuthorityRequest[];
};
declare function getWorkspaceAuthorityStorePath(options?: WorkspaceAuthorityStoreOptions): string;
declare function getWorkspaceAuthorityIdentity(workspacePath: string): Promise<WorkspaceAuthorityIdentity>;
declare function loadWorkspaceAuthority(workspacePath: string, options?: WorkspaceAuthorityStoreOptions): Promise<WorkspaceAuthorityRecord | null>;
declare function grantWorkspaceAuthority(workspacePath: string, grant: WorkspaceAuthorityGrant, options?: WorkspaceAuthorityStoreOptions): Promise<WorkspaceAuthorityRecord>;
declare function revokeWorkspaceAuthority(workspacePath: string, grant?: WorkspaceAuthorityGrant, options?: WorkspaceAuthorityStoreOptions): Promise<boolean>;
declare function listWorkspaceAuthorities(options?: WorkspaceAuthorityStoreOptions): Promise<WorkspaceAuthorityRecord[]>;
declare function approveWorkspaceProjectAuthority(workspacePath: string, request: PendingProjectAuthorityRequest, options?: WorkspaceAuthorityStoreOptions): Promise<WorkspaceAuthorityRecord>;
declare function revokeWorkspaceProjectAuthority(workspacePath: string, approval: WorkspaceProjectAuthorityApproval, options?: WorkspaceAuthorityStoreOptions): Promise<boolean>;
/**
 * Add host-owned grants to a loaded config in place. Mutation is intentional:
 * loadConfig attaches non-enumerable credential-environment provenance which
 * must survive authority hydration.
 */
declare function applyWorkspaceAuthorityGrants<T extends AuthorityConfig>(config: T, authority: WorkspaceAuthorityRecord | null): T;
declare function hydrateWorkspaceAuthority<T extends AuthorityConfig>(config: T, workspacePath: string, options?: WorkspaceAuthorityStoreOptions): Promise<T>;

declare const MEMORY_SCHEMA_VERSION: 2;
declare const MAX_MEMORY_TITLE_CHARS = 4096;
declare const MAX_MEMORY_CONTENT_CHARS: number;
declare const MAX_MEMORY_IDENTIFIER_CHARS = 512;
declare const MAX_MEMORY_SOURCE_URI_CHARS: number;
declare const MAX_MEMORY_RELATION_IDS = 256;
type LegacyMemoryRecord = Pick<MemoryRecord, "id" | "scope" | "title" | "content" | "createdAt" | "updatedAt"> & Partial<Omit<MemoryRecord, "id" | "scope" | "title" | "content" | "createdAt" | "updatedAt">>;
declare function assertMemoryWriteInput(input: {
    title?: unknown;
    content?: unknown;
    source?: unknown;
    author?: unknown;
    metadata?: unknown;
    supersedes?: unknown;
    contradicts?: unknown;
}): void;
/**
 * Upgrade a persisted v1 memory in-memory. The next orchestration mutation
 * writes the upgraded record, so old checksummed snapshots remain readable.
 */
declare function normalizeMemoryRecord(input: LegacyMemoryRecord): MemoryRecord;

interface RetrievedMemory {
    memory: MemoryRecord;
    score: number;
    reasons: string[];
    citation: string;
    estimatedChars: number;
}
interface MemoryRetrievalResult {
    items: RetrievedMemory[];
    totalChars: number;
    excluded: {
        expired: number;
        superseded: number;
        contradicted: number;
        duplicate: number;
        irrelevant: number;
        budget: number;
    };
}
interface MemoryRetrievalOptions {
    memories: MemoryRecord[];
    query: string;
    limit?: number;
    maxChars?: number;
    now?: number;
    /** Optional healthy vector-service similarity scores keyed by memory id (0..1). */
    vectorScores?: ReadonlyMap<string, number> | Record<string, number>;
}
declare function tokenizeMemoryText(text: string): string[];
declare function retrieveMemories(options: MemoryRetrievalOptions): MemoryRetrievalResult;

declare class MemoryValueLimitError extends Error {
    constructor(message: string);
}
declare function redactMemorySecrets(input: string): {
    text: string;
    redacted: boolean;
};
interface SanitizedMemoryValue<T = unknown> {
    value: T;
    redacted: boolean;
}
/**
 * Convert memory metadata/source payloads into bounded JSON while removing
 * credentials from both values and credential-named fields.
 *
 * Strict mode is for new writes and rejects lossy coercion. Tolerant mode is
 * for legacy reads: it deterministically bounds malformed historic values so
 * one old record cannot grow prompts or snapshots without limit.
 */
declare function sanitizeMemoryValue<T>(input: T, options?: {
    strict?: boolean;
    label?: string;
}): SanitizedMemoryValue<T>;

type RunStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";
interface RunToolArtifact {
    partId: string;
    tool: string;
    path?: string;
    outputSpillPath?: string;
}
interface PendingRunApproval {
    partId: string;
    action: ApprovalAction;
    requestedAt: number;
}
interface DurableRunRecord {
    schemaVersion: 1;
    id: string;
    sessionId: string;
    cwd: string;
    mode: Mode;
    status: RunStatus;
    createdAt: number;
    updatedAt: number;
    lastSeq: number;
    lastChecksum: string | null;
    recentIdempotencyKeys: Record<string, number>;
    pendingApprovals: PendingRunApproval[];
    toolArtifacts: RunToolArtifact[];
    memoryCitations: string[];
    taskIds: string[];
}
interface RunEventEnvelope {
    type: "run_event";
    schemaVersion: 1;
    runId: string;
    seq: number;
    ts: number;
    idempotencyKey: string;
    previousChecksum: string | null;
    event: AgentEvent;
    checksum: string;
    deduplicated?: boolean;
}
interface RunEventDiagnostic {
    code: "corrupt-event-tail" | "snapshot-recovered";
    path: string;
    message: string;
}
interface RunEventStoreOptions {
    homeDir?: string;
    onDiagnostic?: (diagnostic: RunEventDiagnostic) => void;
}
interface DurableRunEventSinkOptions extends RunEventStoreOptions {
    runId?: string;
}
declare class RunEventStore {
    readonly cwd: string;
    private readonly root;
    private readonly diagnostics;
    private readonly onDiagnostic?;
    private readonly mutationCache;
    constructor(cwd: string, options?: RunEventStoreOptions);
    getSnapshotPath(runId: string): string;
    getJournalPath(runId: string): string;
    getDiagnostics(): readonly RunEventDiagnostic[];
    private diagnostic;
    private verifiedEventState;
    private verifiedEvents;
    private validateSnapshot;
    private readSnapshot;
    private normalizeSnapshotRecord;
    private writeSnapshot;
    private load;
    private loadForMutation;
    createRun(input: {
        id: string;
        sessionId: string;
        mode: Mode;
    }): Promise<DurableRunRecord>;
    getRun(runId: string): Promise<DurableRunRecord | null>;
    listRuns(filters?: {
        sessionId?: string;
        status?: RunStatus | RunStatus[];
        limit?: number;
    }): Promise<DurableRunRecord[]>;
    appendEvent(runId: string, event: AgentEvent, idempotencyKey?: string): Promise<RunEventEnvelope>;
    appendEvents(runId: string, inputs: Array<{
        event: AgentEvent;
        idempotencyKey?: string;
    }>): Promise<RunEventEnvelope[]>;
    readEvents(runId: string, afterSeq?: number): Promise<RunEventEnvelope[]>;
    finishRun(runId: string, status: Exclude<RunStatus, "running">): Promise<DurableRunRecord>;
}
/**
 * Persist-before-deliver event adapter for local hosts. `emit` stays
 * synchronous for IHost compatibility while writes and delivery are strictly
 * ordered through one promise chain.
 */
declare class DurableRunEventSink {
    readonly runId: string;
    private readonly store;
    private readonly deliver;
    private queue;
    private persistenceError;
    private pending;
    private flushTimer;
    private closed;
    private constructor();
    static create(input: {
        cwd: string;
        sessionId: string;
        mode: Mode;
        deliver: (event: AgentEvent) => void;
        options?: DurableRunEventSinkOptions;
    }): Promise<DurableRunEventSink>;
    emit(event: AgentEvent, idempotencyKey?: string): void;
    private flushPending;
    finish(status: Exclude<RunStatus, "running">): Promise<DurableRunRecord>;
}

interface LLMStreamEvent {
    type: "text_delta" | "reasoning_start" | "reasoning_delta" | "reasoning_end" | "tool_input_start" | "tool_call" | "tool_result" | "finish" | "error";
    delta?: string;
    reasoningId?: string;
    providerMetadata?: Record<string, unknown>;
    toolCallId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: string;
    finishReason?: "stop" | "length" | "tool_calls" | "error";
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
    error?: Error;
}
interface LLMMessage {
    role: "user" | "assistant" | "system" | "tool";
    content: LLMMessageContent;
}
type LLMMessageContent = string | Array<{
    type: "text";
    text: string;
}
/** Prior-turn chain-of-thought (KiloCode UIMessage / AI SDK); may be hoisted per model in buildAISDKMessages. */
 | {
    type: "reasoning";
    text: string;
} | {
    type: "image";
    data: string;
    mimeType: string;
} | {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
} | {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    result: string;
    isError?: boolean;
}>;
interface LLMToolDef {
    name: string;
    description: string;
    parameters: z.ZodType<unknown>;
}
interface StreamOptions {
    messages: LLMMessage[];
    tools?: LLMToolDef[];
    systemPrompt?: string;
    signal?: AbortSignal;
    /** For cache-aware providers (Anthropic): mark which system blocks are cacheable */
    cacheableSystemBlocks?: number;
    /** Stable conversation key for provider prompt caching (when supported). */
    promptCacheKey?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxRetries?: number;
    initialRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    retryOnStatus?: number[];
    /** Provider-specific options (e.g. anthropic: { thinking: { type: 'enabled', budgetTokens } }) */
    providerOptions?: Record<string, unknown>;
    /**
     * How assistant reasoning from history is sent on the next request (KiloCode-style).
     * `auto` hoists to `reasoning_content` for models like DeepSeek; otherwise keeps `type: "reasoning"` in content.
     */
    reasoningHistoryMode?: ReasoningHistoryMode;
}
/** @see StreamOptions.reasoningHistoryMode */
type ReasoningHistoryMode = "auto" | "inline" | "reasoning_content" | "reasoning_details";
interface GenerateOptions<T> {
    messages: LLMMessage[];
    schema: z.ZodType<T>;
    systemPrompt?: string;
    signal?: AbortSignal;
    maxRetries?: number;
}
interface LLMClient {
    readonly providerName: string;
    readonly modelId: string;
    stream(opts: StreamOptions): AsyncIterable<LLMStreamEvent>;
    generateStructured<T>(opts: GenerateOptions<T>): Promise<T>;
    /** Check if this provider/model supports native JSON schema output */
    supportsStructuredOutput(): boolean;
    /** Get model from underlying AI SDK (for direct use) */
    getModel(): LanguageModelV1;
}
interface EmbeddingClient {
    embed(texts: string[]): Promise<number[][]>;
    readonly dimensions: number;
}

declare function createEmbeddingClient(config: EmbeddingConfig): EmbeddingClient;

declare function createLLMClient(config: ProviderConfig): LLMClient;

/**
 * Kilocode-style: detect if the last assistant message completed plan_exit,
 * so the host can show "Ready to implement?" (New session / Continue here).
 */
declare function hadPlanExit(session: ISession): boolean;
/**
 * Plan content for follow-up: last assistant text, or from last Write/Edit to .nexus/plans, or first .nexus/plans/*.md file.
 * Used to inject "Implement the following plan: ..." into a new session or continue message.
 */
declare function getPlanContentForFollowup(session: ISession, cwd: string): Promise<string>;

type CompactionResult = {
    status: "compacted";
    summaryMessageId: string;
} | {
    status: "skipped";
    reason: "insufficient_history" | "no_new_messages";
} | {
    status: "failed";
    reason: "summarizer_error" | "empty_summary" | "incomplete_summary" | "history_changed" | "persistence_error" | "aborted" | "internal_error";
    error: Error;
};
interface SessionCompaction {
    prune(session: ISession): void;
    microcompact(session: ISession, keepRecentMessages?: number): number;
    compact(session: ISession, client: LLMClient, signal?: AbortSignal, opts?: {
        keepRecentMessages?: number;
        force?: boolean;
        durableContext?: CompactionDurableContext;
    }): Promise<CompactionResult>;
    isOverflow(tokenCount: number, contextLimit: number, threshold: number): boolean;
}
interface CompactionDurableContext {
    mode: string;
    memoryCitations: string[];
    taskIds: string[];
}
declare function createCompaction(): SessionCompaction;
/**
 * Run an explicit user-requested compaction and make the summary durable
 * before reporting success. UI surfaces must not duplicate the subtly
 * different force/result/save handling themselves.
 */
declare function compactSessionAndPersist(input: {
    session: ISession;
    client: LLMClient;
    compaction?: SessionCompaction;
    signal?: AbortSignal;
    durableContext?: CompactionDurableContext;
    projection?: {
        cwd: string;
        config: NexusConfig;
        orchestrationRuntime: OrchestrationRuntime;
    };
}): Promise<CompactionResult>;

declare const PROTOCOL_VERSION: 2;
declare const MAX_USER_INPUT_TEXT_CHARS: number;
declare const MAX_IMAGE_BASE64_CHARS: number;
declare const MAX_INPUT_PARTS = 64;
declare const MAX_IMAGES_PER_INPUT = 8;
declare const UserInputPartSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "text";
    text: string;
}, {
    type: "text";
    text: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
    data: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    data: string;
    type: "image";
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}, {
    data: string;
    type: "image";
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}>, z.ZodObject<{
    type: z.ZodLiteral<"mention">;
    name: z.ZodString;
    path: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    type: "mention";
    path: string;
    name: string;
}, {
    type: "mention";
    path: string;
    name: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"skill">;
    name: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "skill";
    name: string;
}, {
    type: "skill";
    name: string;
}>]>;
declare const ModeSchema: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
declare const ModelSelectionSchema: z.ZodObject<{
    profileId: z.ZodString;
    selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    profileId: string;
    selectionEpoch: number;
}, {
    profileId: string;
    selectionEpoch: number;
}>;
declare const TurnExecutionSnapshotSchema: z.ZodObject<{
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    selection: z.ZodOptional<z.ZodObject<{
        profileId: z.ZodString;
        selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        profileId: string;
        selectionEpoch: number;
    }, {
        profileId: string;
        selectionEpoch: number;
    }>>;
}, "strict", z.ZodTypeAny, {
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>;
declare const StartTurnCommandSchema: z.ZodObject<{
    type: z.ZodLiteral<"start_turn">;
    inputId: z.ZodString;
    input: z.ZodEffects<z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">, ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[], ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[]>;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    selection: z.ZodOptional<z.ZodObject<{
        profileId: z.ZodString;
        selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        profileId: string;
        selectionEpoch: number;
    }, {
        profileId: string;
        selectionEpoch: number;
    }>>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "start_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    type: "start_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>;
declare const QueueTurnCommandSchema: z.ZodObject<{
    type: z.ZodLiteral<"queue_turn">;
    inputId: z.ZodString;
    input: z.ZodEffects<z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">, ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[], ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[]>;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    selection: z.ZodOptional<z.ZodObject<{
        profileId: z.ZodString;
        selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        profileId: string;
        selectionEpoch: number;
    }, {
        profileId: string;
        selectionEpoch: number;
    }>>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "queue_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    type: "queue_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>;
declare const SteerTurnCommandSchema: z.ZodObject<{
    type: z.ZodLiteral<"steer_turn">;
    inputId: z.ZodString;
    expectedTurnId: z.ZodString;
    input: z.ZodEffects<z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">, ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[], ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[]>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "steer_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    sessionId: string;
    inputId: string;
    commandId: string;
    expectedTurnId: string;
}, {
    type: "steer_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    sessionId: string;
    inputId: string;
    commandId: string;
    expectedTurnId: string;
}>;
declare const InterruptTurnCommandSchema: z.ZodObject<{
    type: z.ZodLiteral<"interrupt_turn">;
    expectedTurnId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "interrupt_turn";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    reason?: string | undefined;
}, {
    type: "interrupt_turn";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    reason?: string | undefined;
}>;
declare const ResolveApprovalCommandSchema: z.ZodObject<{
    type: z.ZodLiteral<"resolve_approval">;
    approvalId: z.ZodString;
    expectedTurnId: z.ZodString;
    status: z.ZodEnum<["approved", "denied"]>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "resolve_approval";
    status: "approved" | "denied";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    approvalId: string;
}, {
    type: "resolve_approval";
    status: "approved" | "denied";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    approvalId: string;
}>;
declare const SessionCommandSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"start_turn">;
    inputId: z.ZodString;
    input: z.ZodEffects<z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">, ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[], ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[]>;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    selection: z.ZodOptional<z.ZodObject<{
        profileId: z.ZodString;
        selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        profileId: string;
        selectionEpoch: number;
    }, {
        profileId: string;
        selectionEpoch: number;
    }>>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "start_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    type: "start_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"queue_turn">;
    inputId: z.ZodString;
    input: z.ZodEffects<z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">, ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[], ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[]>;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    selection: z.ZodOptional<z.ZodObject<{
        profileId: z.ZodString;
        selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        profileId: string;
        selectionEpoch: number;
    }, {
        profileId: string;
        selectionEpoch: number;
    }>>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "queue_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    type: "queue_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    sessionId: string;
    inputId: string;
    commandId: string;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"steer_turn">;
    inputId: z.ZodString;
    expectedTurnId: z.ZodString;
    input: z.ZodEffects<z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">, ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[], ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[]>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "steer_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    sessionId: string;
    inputId: string;
    commandId: string;
    expectedTurnId: string;
}, {
    type: "steer_turn";
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 2;
    sessionId: string;
    inputId: string;
    commandId: string;
    expectedTurnId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"interrupt_turn">;
    expectedTurnId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "interrupt_turn";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    reason?: string | undefined;
}, {
    type: "interrupt_turn";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    reason?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"resolve_approval">;
    approvalId: z.ZodString;
    expectedTurnId: z.ZodString;
    status: z.ZodEnum<["approved", "denied"]>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "resolve_approval";
    status: "approved" | "denied";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    approvalId: string;
}, {
    type: "resolve_approval";
    status: "approved" | "denied";
    version: 2;
    sessionId: string;
    commandId: string;
    expectedTurnId: string;
    approvalId: string;
}>]>;
declare const ProtocolErrorCodeSchema: z.ZodEnum<["invalid_command", "input_too_large", "unsupported_version", "idempotency_conflict", "no_active_turn", "turn_conflict", "approval_conflict", "selection_conflict", "replay_gap", "not_found", "runtime_unavailable", "internal_error"]>;
declare const ProtocolErrorSchema: z.ZodObject<{
    code: z.ZodEnum<["invalid_command", "input_too_large", "unsupported_version", "idempotency_conflict", "no_active_turn", "turn_conflict", "approval_conflict", "selection_conflict", "replay_gap", "not_found", "runtime_unavailable", "internal_error"]>;
    message: z.ZodString;
    retryable: z.ZodBoolean;
    details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strict", z.ZodTypeAny, {
    code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
    message: string;
    retryable: boolean;
    details?: Record<string, unknown> | undefined;
}, {
    code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
    message: string;
    retryable: boolean;
    details?: Record<string, unknown> | undefined;
}>;
type UserInputPartV2 = z.infer<typeof UserInputPartSchema>;
type SessionCommandV2 = z.infer<typeof SessionCommandSchema>;
type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
declare class SessionProtocolError extends Error {
    readonly protocolError: ProtocolError;
    constructor(error: ProtocolError);
}
type ParseSessionCommandResult = {
    ok: true;
    command: SessionCommandV2;
} | {
    ok: false;
    error: ProtocolError;
};
declare function parseSessionCommand(value: unknown): ParseSessionCommandResult;

declare const MAX_AGENT_EVENT_JSON_CHARS: number;
declare const PendingSessionApprovalSchema: z.ZodObject<{
    approvalId: z.ZodString;
    turnId: z.ZodString;
    toolName: z.ZodString;
    redactedSummary: z.ZodString;
}, "strict", z.ZodTypeAny, {
    toolName: string;
    turnId: string;
    approvalId: string;
    redactedSummary: string;
}, {
    toolName: string;
    turnId: string;
    approvalId: string;
    redactedSummary: string;
}>;
declare const LegacyAgentEventSchema: z.ZodEffects<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"assistant_message_started">;
    messageId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"assistant_message_started">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"assistant_message_started">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"assistant_content_complete">;
    messageId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"assistant_content_complete">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"assistant_content_complete">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"text_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    user_message_delta: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"text_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    user_message_delta: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"text_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    user_message_delta: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning_start">;
    messageId: z.ZodString;
    reasoningId: z.ZodString;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"reasoning_start">;
    messageId: z.ZodString;
    reasoningId: z.ZodString;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"reasoning_start">;
    messageId: z.ZodString;
    reasoningId: z.ZodString;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"reasoning_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"reasoning_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning_end">;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"reasoning_end">;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"reasoning_end">;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"tool_start">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"tool_start">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"tool_start">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"tool_end">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    success: z.ZodBoolean;
    output: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
    compacted: z.ZodOptional<z.ZodBoolean>;
    path: z.ZodOptional<z.ZodString>;
    writtenContent: z.ZodOptional<z.ZodString>;
    diffStats: z.ZodOptional<z.ZodObject<{
        added: z.ZodEffects<z.ZodNumber, number, number>;
        removed: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        removed: number;
        added: number;
    }, {
        removed: number;
        added: number;
    }>>;
    diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        lineNum: z.ZodEffects<z.ZodNumber, number, number>;
        line: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: string;
        line: string;
        lineNum: number;
    }, {
        type: string;
        line: string;
        lineNum: number;
    }>, "many">>;
    appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
        oldSnippet: z.ZodString;
        newSnippet: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        oldSnippet: string;
        newSnippet: string;
    }, {
        oldSnippet: string;
        newSnippet: string;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"tool_end">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    success: z.ZodBoolean;
    output: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
    compacted: z.ZodOptional<z.ZodBoolean>;
    path: z.ZodOptional<z.ZodString>;
    writtenContent: z.ZodOptional<z.ZodString>;
    diffStats: z.ZodOptional<z.ZodObject<{
        added: z.ZodEffects<z.ZodNumber, number, number>;
        removed: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        removed: number;
        added: number;
    }, {
        removed: number;
        added: number;
    }>>;
    diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        lineNum: z.ZodEffects<z.ZodNumber, number, number>;
        line: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: string;
        line: string;
        lineNum: number;
    }, {
        type: string;
        line: string;
        lineNum: number;
    }>, "many">>;
    appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
        oldSnippet: z.ZodString;
        newSnippet: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        oldSnippet: string;
        newSnippet: string;
    }, {
        oldSnippet: string;
        newSnippet: string;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"tool_end">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    success: z.ZodBoolean;
    output: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
    compacted: z.ZodOptional<z.ZodBoolean>;
    path: z.ZodOptional<z.ZodString>;
    writtenContent: z.ZodOptional<z.ZodString>;
    diffStats: z.ZodOptional<z.ZodObject<{
        added: z.ZodEffects<z.ZodNumber, number, number>;
        removed: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        removed: number;
        added: number;
    }, {
        removed: number;
        added: number;
    }>>;
    diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        lineNum: z.ZodEffects<z.ZodNumber, number, number>;
        line: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: string;
        line: string;
        lineNum: number;
    }, {
        type: string;
        line: string;
        lineNum: number;
    }>, "many">>;
    appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
        oldSnippet: z.ZodString;
        newSnippet: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        oldSnippet: string;
        newSnippet: string;
    }, {
        oldSnippet: string;
        newSnippet: string;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"subagent_start">;
    subagentId: z.ZodString;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    task: z.ZodString;
    parentPartId: z.ZodOptional<z.ZodString>;
    depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    parentSubagentId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"subagent_start">;
    subagentId: z.ZodString;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    task: z.ZodString;
    parentPartId: z.ZodOptional<z.ZodString>;
    depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    parentSubagentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"subagent_start">;
    subagentId: z.ZodString;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    task: z.ZodString;
    parentPartId: z.ZodOptional<z.ZodString>;
    depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    parentSubagentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"subagent_tool_start">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"subagent_tool_start">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"subagent_tool_start">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"subagent_tool_end">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"subagent_tool_end">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"subagent_tool_end">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"subagent_done">;
    subagentId: z.ZodString;
    success: z.ZodBoolean;
    outputPreview: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"subagent_done">;
    subagentId: z.ZodString;
    success: z.ZodBoolean;
    outputPreview: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"subagent_done">;
    subagentId: z.ZodString;
    success: z.ZodBoolean;
    outputPreview: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"tool_approval_needed">;
    action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"tool_approval_needed">;
    action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"tool_approval_needed">;
    action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"question_request">;
    request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"question_request">;
    request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"question_request">;
    request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"compaction_start">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"compaction_start">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"compaction_start">;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"compaction_end">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"compaction_end">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"compaction_end">;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"run_context">;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    memoryCitations: z.ZodArray<z.ZodString, "many">;
    taskIds: z.ZodArray<z.ZodString, "many">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"run_context">;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    memoryCitations: z.ZodArray<z.ZodString, "many">;
    taskIds: z.ZodArray<z.ZodString, "many">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"run_context">;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    memoryCitations: z.ZodArray<z.ZodString, "many">;
    taskIds: z.ZodArray<z.ZodString, "many">;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"index_update">;
    status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"index_update">;
    status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"index_update">;
    status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"vector_db_progress">;
    message: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"vector_db_progress">;
    message: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"vector_db_progress">;
    message: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"vector_db_ready">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"vector_db_ready">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"vector_db_ready">;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"session_saved">;
    sessionId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"session_saved">;
    sessionId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"session_saved">;
    sessionId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"context_usage">;
    usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
    limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
    percent: z.ZodEffects<z.ZodNumber, number, number>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"context_usage">;
    usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
    limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
    percent: z.ZodEffects<z.ZodNumber, number, number>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"context_usage">;
    usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
    limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
    percent: z.ZodEffects<z.ZodNumber, number, number>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    error: z.ZodString;
    fatal: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"error">;
    error: z.ZodString;
    fatal: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"error">;
    error: z.ZodString;
    fatal: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"done">;
    messageId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"done">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"done">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"todo_updated">;
    todo: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"todo_updated">;
    todo: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"todo_updated">;
    todo: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"doom_loop_detected">;
    tool: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"doom_loop_detected">;
    tool: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"doom_loop_detected">;
    tool: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"plan_followup_ask">;
    planText: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"plan_followup_ask">;
    planText: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"plan_followup_ask">;
    planText: z.ZodString;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"task_created">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"task_created">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"task_created">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"task_progress">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"task_progress">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"task_progress">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"task_tool_start">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"task_tool_start">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"task_tool_start">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"task_tool_end">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"task_tool_end">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"task_tool_end">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"task_completed">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"task_completed">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"task_completed">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"team_updated">;
    team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"team_updated">;
    team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"team_updated">;
    team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"team_message">;
    message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"team_message">;
    message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"team_message">;
    message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"background_task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"background_task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"background_task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"remote_session_updated">;
    remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"remote_session_updated">;
    remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"remote_session_updated">;
    remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
    type: z.ZodLiteral<"plugin_hook">;
    pluginName: z.ZodString;
    hookEvent: z.ZodString;
    output: z.ZodString;
    success: z.ZodBoolean;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodLiteral<"plugin_hook">;
    pluginName: z.ZodString;
    hookEvent: z.ZodString;
    output: z.ZodString;
    success: z.ZodBoolean;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"plugin_hook">;
    pluginName: z.ZodString;
    hookEvent: z.ZodString;
    output: z.ZodString;
    success: z.ZodBoolean;
}, z.ZodTypeAny, "passthrough">>]>, z.objectOutputType<{
    type: z.ZodLiteral<"assistant_message_started">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"assistant_content_complete">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"text_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    user_message_delta: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"reasoning_start">;
    messageId: z.ZodString;
    reasoningId: z.ZodString;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"reasoning_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"reasoning_end">;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"tool_start">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"tool_end">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    success: z.ZodBoolean;
    output: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
    compacted: z.ZodOptional<z.ZodBoolean>;
    path: z.ZodOptional<z.ZodString>;
    writtenContent: z.ZodOptional<z.ZodString>;
    diffStats: z.ZodOptional<z.ZodObject<{
        added: z.ZodEffects<z.ZodNumber, number, number>;
        removed: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        removed: number;
        added: number;
    }, {
        removed: number;
        added: number;
    }>>;
    diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        lineNum: z.ZodEffects<z.ZodNumber, number, number>;
        line: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: string;
        line: string;
        lineNum: number;
    }, {
        type: string;
        line: string;
        lineNum: number;
    }>, "many">>;
    appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
        oldSnippet: z.ZodString;
        newSnippet: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        oldSnippet: string;
        newSnippet: string;
    }, {
        oldSnippet: string;
        newSnippet: string;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"subagent_start">;
    subagentId: z.ZodString;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    task: z.ZodString;
    parentPartId: z.ZodOptional<z.ZodString>;
    depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    parentSubagentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"subagent_tool_start">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"subagent_tool_end">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"subagent_done">;
    subagentId: z.ZodString;
    success: z.ZodBoolean;
    outputPreview: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"tool_approval_needed">;
    action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"question_request">;
    request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"compaction_start">;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"compaction_end">;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"run_context">;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    memoryCitations: z.ZodArray<z.ZodString, "many">;
    taskIds: z.ZodArray<z.ZodString, "many">;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"index_update">;
    status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"vector_db_progress">;
    message: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"vector_db_ready">;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"session_saved">;
    sessionId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"context_usage">;
    usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
    limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
    percent: z.ZodEffects<z.ZodNumber, number, number>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"error">;
    error: z.ZodString;
    fatal: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"done">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"todo_updated">;
    todo: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"doom_loop_detected">;
    tool: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"plan_followup_ask">;
    planText: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"task_created">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"task_progress">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"task_tool_start">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"task_tool_end">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"task_completed">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"team_updated">;
    team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"team_message">;
    message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"background_task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"remote_session_updated">;
    remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
    type: z.ZodLiteral<"plugin_hook">;
    pluginName: z.ZodString;
    hookEvent: z.ZodString;
    output: z.ZodString;
    success: z.ZodBoolean;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodLiteral<"assistant_message_started">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"assistant_content_complete">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"text_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    user_message_delta: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"reasoning_start">;
    messageId: z.ZodString;
    reasoningId: z.ZodString;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"reasoning_delta">;
    delta: z.ZodString;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"reasoning_end">;
    messageId: z.ZodString;
    reasoningId: z.ZodOptional<z.ZodString>;
    providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"tool_start">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"tool_end">;
    tool: z.ZodString;
    partId: z.ZodString;
    messageId: z.ZodString;
    success: z.ZodBoolean;
    output: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
    compacted: z.ZodOptional<z.ZodBoolean>;
    path: z.ZodOptional<z.ZodString>;
    writtenContent: z.ZodOptional<z.ZodString>;
    diffStats: z.ZodOptional<z.ZodObject<{
        added: z.ZodEffects<z.ZodNumber, number, number>;
        removed: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        removed: number;
        added: number;
    }, {
        removed: number;
        added: number;
    }>>;
    diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        lineNum: z.ZodEffects<z.ZodNumber, number, number>;
        line: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: string;
        line: string;
        lineNum: number;
    }, {
        type: string;
        line: string;
        lineNum: number;
    }>, "many">>;
    appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
        oldSnippet: z.ZodString;
        newSnippet: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        oldSnippet: string;
        newSnippet: string;
    }, {
        oldSnippet: string;
        newSnippet: string;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"subagent_start">;
    subagentId: z.ZodString;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    task: z.ZodString;
    parentPartId: z.ZodOptional<z.ZodString>;
    depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    parentSubagentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"subagent_tool_start">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"subagent_tool_end">;
    subagentId: z.ZodString;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"subagent_done">;
    subagentId: z.ZodString;
    success: z.ZodBoolean;
    outputPreview: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"tool_approval_needed">;
    action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"question_request">;
    request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    partId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"compaction_start">;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"compaction_end">;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"run_context">;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    memoryCitations: z.ZodArray<z.ZodString, "many">;
    taskIds: z.ZodArray<z.ZodString, "many">;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"index_update">;
    status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"vector_db_progress">;
    message: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"vector_db_ready">;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"session_saved">;
    sessionId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"context_usage">;
    usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
    limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
    percent: z.ZodEffects<z.ZodNumber, number, number>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"error">;
    error: z.ZodString;
    fatal: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"done">;
    messageId: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"todo_updated">;
    todo: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"doom_loop_detected">;
    tool: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"plan_followup_ask">;
    planText: z.ZodString;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"task_created">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"task_progress">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"task_tool_start">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"task_tool_end">;
    taskId: z.ZodString;
    taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
    tool: z.ZodString;
    success: z.ZodBoolean;
    parentPartId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"task_completed">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    outputPreview: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"team_updated">;
    team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"team_message">;
    message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"background_task_updated">;
    task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"remote_session_updated">;
    remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
}, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
    type: z.ZodLiteral<"plugin_hook">;
    pluginName: z.ZodString;
    hookEvent: z.ZodString;
    output: z.ZodString;
    success: z.ZodBoolean;
}, z.ZodTypeAny, "passthrough">>;
declare const ProtocolPayloadSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"input_admitted">;
    inputId: z.ZodString;
    reservedTurnId: z.ZodString;
    reservedRunId: z.ZodString;
    delivery: z.ZodEnum<["steer", "queue"]>;
    expectedTurnId: z.ZodOptional<z.ZodString>;
    admittedSequence: z.ZodEffects<z.ZodNumber, number, number>;
    execution: z.ZodObject<{
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        selection: z.ZodOptional<z.ZodObject<{
            profileId: z.ZodString;
            selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            profileId: string;
            selectionEpoch: number;
        }, {
            profileId: string;
            selectionEpoch: number;
        }>>;
    }, "strict", z.ZodTypeAny, {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    }, {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    type: "input_admitted";
    inputId: string;
    admittedSequence: number;
    execution: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    };
    reservedTurnId: string;
    reservedRunId: string;
    delivery: "steer" | "queue";
    expectedTurnId?: string | undefined;
}, {
    type: "input_admitted";
    inputId: string;
    admittedSequence: number;
    execution: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    };
    reservedTurnId: string;
    reservedRunId: string;
    delivery: "steer" | "queue";
    expectedTurnId?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"turn_started">;
    turnId: z.ZodString;
    runId: z.ZodString;
    configEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    contextEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    execution: z.ZodObject<{
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        selection: z.ZodOptional<z.ZodObject<{
            profileId: z.ZodString;
            selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            profileId: string;
            selectionEpoch: number;
        }, {
            profileId: string;
            selectionEpoch: number;
        }>>;
    }, "strict", z.ZodTypeAny, {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    }, {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    type: "turn_started";
    runId: string;
    turnId: string;
    execution: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    };
    configEpoch: number;
    contextEpoch: number;
}, {
    type: "turn_started";
    runId: string;
    turnId: string;
    execution: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    };
    configEpoch: number;
    contextEpoch: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"phase_changed">;
    phase: z.ZodEnum<["idle", "preparing", "streaming", "waiting_approval", "executing_tools", "compacting", "settling", "failed", "interrupted"]>;
}, "strict", z.ZodTypeAny, {
    type: "phase_changed";
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
}, {
    type: "phase_changed";
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
}>, z.ZodObject<{
    type: z.ZodLiteral<"steering_promoted">;
    inputIds: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    type: "steering_promoted";
    inputIds: string[];
}, {
    type: "steering_promoted";
    inputIds: string[];
}>, z.ZodObject<{
    type: z.ZodLiteral<"steering_requeued">;
    inputIds: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    type: "steering_requeued";
    inputIds: string[];
}, {
    type: "steering_requeued";
    inputIds: string[];
}>, z.ZodObject<{
    type: z.ZodLiteral<"interrupt_requested">;
    reason: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    type: "interrupt_requested";
    reason?: string | undefined;
}, {
    type: "interrupt_requested";
    reason?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"approval_requested">;
    approvalId: z.ZodString;
    toolName: z.ZodString;
    redactedSummary: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "approval_requested";
    toolName: string;
    approvalId: string;
    redactedSummary: string;
}, {
    type: "approval_requested";
    toolName: string;
    approvalId: string;
    redactedSummary: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"approval_resolved">;
    approvalId: z.ZodString;
    status: z.ZodEnum<["approved", "denied", "cancelled"]>;
}, "strict", z.ZodTypeAny, {
    type: "approval_resolved";
    status: "cancelled" | "approved" | "denied";
    approvalId: string;
}, {
    type: "approval_resolved";
    status: "cancelled" | "approved" | "denied";
    approvalId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"agent_event">;
    event: z.ZodEffects<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"compaction_start">;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"compaction_start">;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"compaction_start">;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"compaction_end">;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"compaction_end">;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"compaction_end">;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, z.ZodTypeAny, "passthrough">>]>, z.objectOutputType<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"compaction_start">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"compaction_end">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"compaction_start">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"compaction_end">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, z.ZodTypeAny, "passthrough">>;
}, "strict", z.ZodTypeAny, {
    type: "agent_event";
    event: z.objectOutputType<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"compaction_start">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"compaction_end">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, z.ZodTypeAny, "passthrough">;
}, {
    type: "agent_event";
    event: z.objectInputType<{
        type: z.ZodLiteral<"assistant_message_started">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"assistant_content_complete">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"text_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        user_message_delta: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"reasoning_start">;
        messageId: z.ZodString;
        reasoningId: z.ZodString;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"reasoning_delta">;
        delta: z.ZodString;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"reasoning_end">;
        messageId: z.ZodString;
        reasoningId: z.ZodOptional<z.ZodString>;
        providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"tool_start">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"tool_end">;
        tool: z.ZodString;
        partId: z.ZodString;
        messageId: z.ZodString;
        success: z.ZodBoolean;
        output: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
        compacted: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        writtenContent: z.ZodOptional<z.ZodString>;
        diffStats: z.ZodOptional<z.ZodObject<{
            added: z.ZodEffects<z.ZodNumber, number, number>;
            removed: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            removed: number;
            added: number;
        }, {
            removed: number;
            added: number;
        }>>;
        diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            lineNum: z.ZodEffects<z.ZodNumber, number, number>;
            line: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            line: string;
            lineNum: number;
        }, {
            type: string;
            line: string;
            lineNum: number;
        }>, "many">>;
        appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
            oldSnippet: z.ZodString;
            newSnippet: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            oldSnippet: string;
            newSnippet: string;
        }, {
            oldSnippet: string;
            newSnippet: string;
        }>, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_start">;
        subagentId: z.ZodString;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        task: z.ZodString;
        parentPartId: z.ZodOptional<z.ZodString>;
        depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        parentSubagentId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_tool_start">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_tool_end">;
        subagentId: z.ZodString;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"subagent_done">;
        subagentId: z.ZodString;
        success: z.ZodBoolean;
        outputPreview: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"tool_approval_needed">;
        action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"question_request">;
        request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        partId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"compaction_start">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"compaction_end">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"run_context">;
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        memoryCitations: z.ZodArray<z.ZodString, "many">;
        taskIds: z.ZodArray<z.ZodString, "many">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"index_update">;
        status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"vector_db_progress">;
        message: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"vector_db_ready">;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"session_saved">;
        sessionId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"context_usage">;
        usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
        limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
        percent: z.ZodEffects<z.ZodNumber, number, number>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"error">;
        error: z.ZodString;
        fatal: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"done">;
        messageId: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"todo_updated">;
        todo: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"doom_loop_detected">;
        tool: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"plan_followup_ask">;
        planText: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_created">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_progress">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_tool_start">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_tool_end">;
        taskId: z.ZodString;
        taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
        tool: z.ZodString;
        success: z.ZodBoolean;
        parentPartId: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"task_completed">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        outputPreview: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"team_updated">;
        team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"team_message">;
        message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"background_task_updated">;
        task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"remote_session_updated">;
        remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
    }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
        type: z.ZodLiteral<"plugin_hook">;
        pluginName: z.ZodString;
        hookEvent: z.ZodString;
        output: z.ZodString;
        success: z.ZodBoolean;
    }, z.ZodTypeAny, "passthrough">;
}>, z.ZodObject<{
    type: z.ZodLiteral<"turn_finished">;
    status: z.ZodEnum<["completed", "failed", "interrupted"]>;
    error: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    type: "turn_finished";
    status: "failed" | "completed" | "interrupted";
    error?: string | undefined;
}, {
    type: "turn_finished";
    status: "failed" | "completed" | "interrupted";
    error?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"command_error">;
    commandId: z.ZodString;
    error: z.ZodObject<{
        code: z.ZodEnum<["invalid_command", "input_too_large", "unsupported_version", "idempotency_conflict", "no_active_turn", "turn_conflict", "approval_conflict", "selection_conflict", "replay_gap", "not_found", "runtime_unavailable", "internal_error"]>;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strict", z.ZodTypeAny, {
        code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    }, {
        code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    type: "command_error";
    error: {
        code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    };
    commandId: string;
}, {
    type: "command_error";
    error: {
        code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    };
    commandId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"snapshot">;
    phase: z.ZodEnum<["idle", "preparing", "streaming", "waiting_approval", "executing_tools", "compacting", "settling", "failed", "interrupted"]>;
    activeTurnId: z.ZodOptional<z.ZodString>;
    activeRunId: z.ZodOptional<z.ZodString>;
    activeTurnFirstSequence: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    pendingApprovals: z.ZodArray<z.ZodObject<{
        approvalId: z.ZodString;
        turnId: z.ZodString;
        toolName: z.ZodString;
        redactedSummary: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }, {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }>, "many">;
    pendingQueueCount: z.ZodEffects<z.ZodNumber, number, number>;
    pendingSteerCount: z.ZodEffects<z.ZodNumber, number, number>;
    earliestAvailableSequence: z.ZodEffects<z.ZodNumber, number, number>;
    throughSequence: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    type: "snapshot";
    pendingApprovals: {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }[];
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    pendingQueueCount: number;
    pendingSteerCount: number;
    earliestAvailableSequence: number;
    throughSequence: number;
    activeTurnId?: string | undefined;
    activeRunId?: string | undefined;
    activeTurnFirstSequence?: number | undefined;
}, {
    type: "snapshot";
    pendingApprovals: {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }[];
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    pendingQueueCount: number;
    pendingSteerCount: number;
    earliestAvailableSequence: number;
    throughSequence: number;
    activeTurnId?: string | undefined;
    activeRunId?: string | undefined;
    activeTurnFirstSequence?: number | undefined;
}>]>;
declare const ProtocolPersistenceSchema: z.ZodObject<{
    state: z.ZodLiteral<"committed">;
    rollout: z.ZodEnum<["pending", "projected", "not_applicable"]>;
}, "strict", z.ZodTypeAny, {
    state: "committed";
    rollout: "pending" | "projected" | "not_applicable";
}, {
    state: "committed";
    rollout: "pending" | "projected" | "not_applicable";
}>;
declare const ProtocolEnvelopeSchema: z.ZodEffects<z.ZodObject<{
    version: z.ZodLiteral<2>;
    eventId: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
    sequence: z.ZodEffects<z.ZodNumber, number, number>;
    sessionId: z.ZodString;
    turnId: z.ZodOptional<z.ZodString>;
    parentEventId: z.ZodOptional<z.ZodString>;
    emittedAt: z.ZodEffects<z.ZodNumber, number, number>;
    persistence: z.ZodObject<{
        state: z.ZodLiteral<"committed">;
        rollout: z.ZodEnum<["pending", "projected", "not_applicable"]>;
    }, "strict", z.ZodTypeAny, {
        state: "committed";
        rollout: "pending" | "projected" | "not_applicable";
    }, {
        state: "committed";
        rollout: "pending" | "projected" | "not_applicable";
    }>;
    payload: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"input_admitted">;
        inputId: z.ZodString;
        reservedTurnId: z.ZodString;
        reservedRunId: z.ZodString;
        delivery: z.ZodEnum<["steer", "queue"]>;
        expectedTurnId: z.ZodOptional<z.ZodString>;
        admittedSequence: z.ZodEffects<z.ZodNumber, number, number>;
        execution: z.ZodObject<{
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            selection: z.ZodOptional<z.ZodObject<{
                profileId: z.ZodString;
                selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                profileId: string;
                selectionEpoch: number;
            }, {
                profileId: string;
                selectionEpoch: number;
            }>>;
        }, "strict", z.ZodTypeAny, {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        }, {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        }>;
    }, "strict", z.ZodTypeAny, {
        type: "input_admitted";
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        reservedTurnId: string;
        reservedRunId: string;
        delivery: "steer" | "queue";
        expectedTurnId?: string | undefined;
    }, {
        type: "input_admitted";
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        reservedTurnId: string;
        reservedRunId: string;
        delivery: "steer" | "queue";
        expectedTurnId?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"turn_started">;
        turnId: z.ZodString;
        runId: z.ZodString;
        configEpoch: z.ZodEffects<z.ZodNumber, number, number>;
        contextEpoch: z.ZodEffects<z.ZodNumber, number, number>;
        execution: z.ZodObject<{
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            selection: z.ZodOptional<z.ZodObject<{
                profileId: z.ZodString;
                selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                profileId: string;
                selectionEpoch: number;
            }, {
                profileId: string;
                selectionEpoch: number;
            }>>;
        }, "strict", z.ZodTypeAny, {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        }, {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        }>;
    }, "strict", z.ZodTypeAny, {
        type: "turn_started";
        runId: string;
        turnId: string;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        configEpoch: number;
        contextEpoch: number;
    }, {
        type: "turn_started";
        runId: string;
        turnId: string;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        configEpoch: number;
        contextEpoch: number;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"phase_changed">;
        phase: z.ZodEnum<["idle", "preparing", "streaming", "waiting_approval", "executing_tools", "compacting", "settling", "failed", "interrupted"]>;
    }, "strict", z.ZodTypeAny, {
        type: "phase_changed";
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    }, {
        type: "phase_changed";
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"steering_promoted">;
        inputIds: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        type: "steering_promoted";
        inputIds: string[];
    }, {
        type: "steering_promoted";
        inputIds: string[];
    }>, z.ZodObject<{
        type: z.ZodLiteral<"steering_requeued">;
        inputIds: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        type: "steering_requeued";
        inputIds: string[];
    }, {
        type: "steering_requeued";
        inputIds: string[];
    }>, z.ZodObject<{
        type: z.ZodLiteral<"interrupt_requested">;
        reason: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        type: "interrupt_requested";
        reason?: string | undefined;
    }, {
        type: "interrupt_requested";
        reason?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"approval_requested">;
        approvalId: z.ZodString;
        toolName: z.ZodString;
        redactedSummary: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "approval_requested";
        toolName: string;
        approvalId: string;
        redactedSummary: string;
    }, {
        type: "approval_requested";
        toolName: string;
        approvalId: string;
        redactedSummary: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"approval_resolved">;
        approvalId: z.ZodString;
        status: z.ZodEnum<["approved", "denied", "cancelled"]>;
    }, "strict", z.ZodTypeAny, {
        type: "approval_resolved";
        status: "cancelled" | "approved" | "denied";
        approvalId: string;
    }, {
        type: "approval_resolved";
        status: "cancelled" | "approved" | "denied";
        approvalId: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"agent_event">;
        event: z.ZodEffects<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"compaction_start">;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"compaction_end">;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough">>, z.ZodObject<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">>]>, z.objectOutputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">>;
    }, "strict", z.ZodTypeAny, {
        type: "agent_event";
        event: z.objectOutputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">;
    }, {
        type: "agent_event";
        event: z.objectInputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"turn_finished">;
        status: z.ZodEnum<["completed", "failed", "interrupted"]>;
        error: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        type: "turn_finished";
        status: "failed" | "completed" | "interrupted";
        error?: string | undefined;
    }, {
        type: "turn_finished";
        status: "failed" | "completed" | "interrupted";
        error?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"command_error">;
        commandId: z.ZodString;
        error: z.ZodObject<{
            code: z.ZodEnum<["invalid_command", "input_too_large", "unsupported_version", "idempotency_conflict", "no_active_turn", "turn_conflict", "approval_conflict", "selection_conflict", "replay_gap", "not_found", "runtime_unavailable", "internal_error"]>;
            message: z.ZodString;
            retryable: z.ZodBoolean;
            details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strict", z.ZodTypeAny, {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        }, {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        }>;
    }, "strict", z.ZodTypeAny, {
        type: "command_error";
        error: {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        };
        commandId: string;
    }, {
        type: "command_error";
        error: {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        };
        commandId: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"snapshot">;
        phase: z.ZodEnum<["idle", "preparing", "streaming", "waiting_approval", "executing_tools", "compacting", "settling", "failed", "interrupted"]>;
        activeTurnId: z.ZodOptional<z.ZodString>;
        activeRunId: z.ZodOptional<z.ZodString>;
        activeTurnFirstSequence: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
        pendingApprovals: z.ZodArray<z.ZodObject<{
            approvalId: z.ZodString;
            turnId: z.ZodString;
            toolName: z.ZodString;
            redactedSummary: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }, {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }>, "many">;
        pendingQueueCount: z.ZodEffects<z.ZodNumber, number, number>;
        pendingSteerCount: z.ZodEffects<z.ZodNumber, number, number>;
        earliestAvailableSequence: z.ZodEffects<z.ZodNumber, number, number>;
        throughSequence: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        type: "snapshot";
        pendingApprovals: {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }[];
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
        pendingQueueCount: number;
        pendingSteerCount: number;
        earliestAvailableSequence: number;
        throughSequence: number;
        activeTurnId?: string | undefined;
        activeRunId?: string | undefined;
        activeTurnFirstSequence?: number | undefined;
    }, {
        type: "snapshot";
        pendingApprovals: {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }[];
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
        pendingQueueCount: number;
        pendingSteerCount: number;
        earliestAvailableSequence: number;
        throughSequence: number;
        activeTurnId?: string | undefined;
        activeRunId?: string | undefined;
        activeTurnFirstSequence?: number | undefined;
    }>]>;
}, "strict", z.ZodTypeAny, {
    version: 2;
    sessionId: string;
    sequence: number;
    payload: {
        type: "input_admitted";
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        reservedTurnId: string;
        reservedRunId: string;
        delivery: "steer" | "queue";
        expectedTurnId?: string | undefined;
    } | {
        type: "turn_started";
        runId: string;
        turnId: string;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        configEpoch: number;
        contextEpoch: number;
    } | {
        type: "phase_changed";
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    } | {
        type: "steering_promoted";
        inputIds: string[];
    } | {
        type: "steering_requeued";
        inputIds: string[];
    } | {
        type: "interrupt_requested";
        reason?: string | undefined;
    } | {
        type: "approval_requested";
        toolName: string;
        approvalId: string;
        redactedSummary: string;
    } | {
        type: "approval_resolved";
        status: "cancelled" | "approved" | "denied";
        approvalId: string;
    } | {
        type: "agent_event";
        event: z.objectOutputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">;
    } | {
        type: "turn_finished";
        status: "failed" | "completed" | "interrupted";
        error?: string | undefined;
    } | {
        type: "command_error";
        error: {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        };
        commandId: string;
    } | {
        type: "snapshot";
        pendingApprovals: {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }[];
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
        pendingQueueCount: number;
        pendingSteerCount: number;
        earliestAvailableSequence: number;
        throughSequence: number;
        activeTurnId?: string | undefined;
        activeRunId?: string | undefined;
        activeTurnFirstSequence?: number | undefined;
    };
    eventId: string;
    emittedAt: number;
    persistence: {
        state: "committed";
        rollout: "pending" | "projected" | "not_applicable";
    };
    runId?: string | undefined;
    turnId?: string | undefined;
    parentEventId?: string | undefined;
}, {
    version: 2;
    sessionId: string;
    sequence: number;
    payload: {
        type: "input_admitted";
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        reservedTurnId: string;
        reservedRunId: string;
        delivery: "steer" | "queue";
        expectedTurnId?: string | undefined;
    } | {
        type: "turn_started";
        runId: string;
        turnId: string;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        configEpoch: number;
        contextEpoch: number;
    } | {
        type: "phase_changed";
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    } | {
        type: "steering_promoted";
        inputIds: string[];
    } | {
        type: "steering_requeued";
        inputIds: string[];
    } | {
        type: "interrupt_requested";
        reason?: string | undefined;
    } | {
        type: "approval_requested";
        toolName: string;
        approvalId: string;
        redactedSummary: string;
    } | {
        type: "approval_resolved";
        status: "cancelled" | "approved" | "denied";
        approvalId: string;
    } | {
        type: "agent_event";
        event: z.objectInputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">;
    } | {
        type: "turn_finished";
        status: "failed" | "completed" | "interrupted";
        error?: string | undefined;
    } | {
        type: "command_error";
        error: {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        };
        commandId: string;
    } | {
        type: "snapshot";
        pendingApprovals: {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }[];
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
        pendingQueueCount: number;
        pendingSteerCount: number;
        earliestAvailableSequence: number;
        throughSequence: number;
        activeTurnId?: string | undefined;
        activeRunId?: string | undefined;
        activeTurnFirstSequence?: number | undefined;
    };
    eventId: string;
    emittedAt: number;
    persistence: {
        state: "committed";
        rollout: "pending" | "projected" | "not_applicable";
    };
    runId?: string | undefined;
    turnId?: string | undefined;
    parentEventId?: string | undefined;
}>, {
    version: 2;
    sessionId: string;
    sequence: number;
    payload: {
        type: "input_admitted";
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        reservedTurnId: string;
        reservedRunId: string;
        delivery: "steer" | "queue";
        expectedTurnId?: string | undefined;
    } | {
        type: "turn_started";
        runId: string;
        turnId: string;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        configEpoch: number;
        contextEpoch: number;
    } | {
        type: "phase_changed";
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    } | {
        type: "steering_promoted";
        inputIds: string[];
    } | {
        type: "steering_requeued";
        inputIds: string[];
    } | {
        type: "interrupt_requested";
        reason?: string | undefined;
    } | {
        type: "approval_requested";
        toolName: string;
        approvalId: string;
        redactedSummary: string;
    } | {
        type: "approval_resolved";
        status: "cancelled" | "approved" | "denied";
        approvalId: string;
    } | {
        type: "agent_event";
        event: z.objectOutputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectOutputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">;
    } | {
        type: "turn_finished";
        status: "failed" | "completed" | "interrupted";
        error?: string | undefined;
    } | {
        type: "command_error";
        error: {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        };
        commandId: string;
    } | {
        type: "snapshot";
        pendingApprovals: {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }[];
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
        pendingQueueCount: number;
        pendingSteerCount: number;
        earliestAvailableSequence: number;
        throughSequence: number;
        activeTurnId?: string | undefined;
        activeRunId?: string | undefined;
        activeTurnFirstSequence?: number | undefined;
    };
    eventId: string;
    emittedAt: number;
    persistence: {
        state: "committed";
        rollout: "pending" | "projected" | "not_applicable";
    };
    runId?: string | undefined;
    turnId?: string | undefined;
    parentEventId?: string | undefined;
}, {
    version: 2;
    sessionId: string;
    sequence: number;
    payload: {
        type: "input_admitted";
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        reservedTurnId: string;
        reservedRunId: string;
        delivery: "steer" | "queue";
        expectedTurnId?: string | undefined;
    } | {
        type: "turn_started";
        runId: string;
        turnId: string;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
        configEpoch: number;
        contextEpoch: number;
    } | {
        type: "phase_changed";
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    } | {
        type: "steering_promoted";
        inputIds: string[];
    } | {
        type: "steering_requeued";
        inputIds: string[];
    } | {
        type: "interrupt_requested";
        reason?: string | undefined;
    } | {
        type: "approval_requested";
        toolName: string;
        approvalId: string;
        redactedSummary: string;
    } | {
        type: "approval_resolved";
        status: "cancelled" | "approved" | "denied";
        approvalId: string;
    } | {
        type: "agent_event";
        event: z.objectInputType<{
            type: z.ZodLiteral<"assistant_message_started">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"assistant_content_complete">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"text_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            user_message_delta: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_start">;
            messageId: z.ZodString;
            reasoningId: z.ZodString;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_delta">;
            delta: z.ZodString;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"reasoning_end">;
            messageId: z.ZodString;
            reasoningId: z.ZodOptional<z.ZodString>;
            providerMetadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_start">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_end">;
            tool: z.ZodString;
            partId: z.ZodString;
            messageId: z.ZodString;
            success: z.ZodBoolean;
            output: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodUnknown, "many">>;
            compacted: z.ZodOptional<z.ZodBoolean>;
            path: z.ZodOptional<z.ZodString>;
            writtenContent: z.ZodOptional<z.ZodString>;
            diffStats: z.ZodOptional<z.ZodObject<{
                added: z.ZodEffects<z.ZodNumber, number, number>;
                removed: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                removed: number;
                added: number;
            }, {
                removed: number;
                added: number;
            }>>;
            diffHunks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                lineNum: z.ZodEffects<z.ZodNumber, number, number>;
                line: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                type: string;
                line: string;
                lineNum: number;
            }, {
                type: string;
                line: string;
                lineNum: number;
            }>, "many">>;
            appliedReplacements: z.ZodOptional<z.ZodArray<z.ZodObject<{
                oldSnippet: z.ZodString;
                newSnippet: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                oldSnippet: string;
                newSnippet: string;
            }, {
                oldSnippet: string;
                newSnippet: string;
            }>, "many">>;
            metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_start">;
            subagentId: z.ZodString;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            task: z.ZodString;
            parentPartId: z.ZodOptional<z.ZodString>;
            depth: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
            parentSubagentId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_start">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_tool_end">;
            subagentId: z.ZodString;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"subagent_done">;
            subagentId: z.ZodString;
            success: z.ZodBoolean;
            outputPreview: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"tool_approval_needed">;
            action: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"question_request">;
            request: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            partId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_start">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"compaction_end">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"run_context">;
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            memoryCitations: z.ZodArray<z.ZodString, "many">;
            taskIds: z.ZodArray<z.ZodString, "many">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"index_update">;
            status: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_progress">;
            message: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"vector_db_ready">;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"session_saved">;
            sessionId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"context_usage">;
            usedTokens: z.ZodEffects<z.ZodNumber, number, number>;
            limitTokens: z.ZodEffects<z.ZodNumber, number, number>;
            percent: z.ZodEffects<z.ZodNumber, number, number>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"error">;
            error: z.ZodString;
            fatal: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"done">;
            messageId: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"todo_updated">;
            todo: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"doom_loop_detected">;
            tool: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plan_followup_ask">;
            planText: z.ZodString;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_created">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_progress">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_start">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_tool_end">;
            taskId: z.ZodString;
            taskKind: z.ZodEnum<["agent", "shell", "tracking", "workflow", "external"]>;
            tool: z.ZodString;
            success: z.ZodBoolean;
            parentPartId: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"task_completed">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
            outputPreview: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_updated">;
            team: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"team_message">;
            message: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"background_task_updated">;
            task: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"remote_session_updated">;
            remoteSession: z.ZodEffects<z.ZodUnknown, {} | null, unknown>;
        }, z.ZodTypeAny, "passthrough"> | z.objectInputType<{
            type: z.ZodLiteral<"plugin_hook">;
            pluginName: z.ZodString;
            hookEvent: z.ZodString;
            output: z.ZodString;
            success: z.ZodBoolean;
        }, z.ZodTypeAny, "passthrough">;
    } | {
        type: "turn_finished";
        status: "failed" | "completed" | "interrupted";
        error?: string | undefined;
    } | {
        type: "command_error";
        error: {
            code: "internal_error" | "unsupported_version" | "invalid_command" | "input_too_large" | "idempotency_conflict" | "no_active_turn" | "turn_conflict" | "approval_conflict" | "selection_conflict" | "replay_gap" | "not_found" | "runtime_unavailable";
            message: string;
            retryable: boolean;
            details?: Record<string, unknown> | undefined;
        };
        commandId: string;
    } | {
        type: "snapshot";
        pendingApprovals: {
            toolName: string;
            turnId: string;
            approvalId: string;
            redactedSummary: string;
        }[];
        phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
        pendingQueueCount: number;
        pendingSteerCount: number;
        earliestAvailableSequence: number;
        throughSequence: number;
        activeTurnId?: string | undefined;
        activeRunId?: string | undefined;
        activeTurnFirstSequence?: number | undefined;
    };
    eventId: string;
    emittedAt: number;
    persistence: {
        state: "committed";
        rollout: "pending" | "projected" | "not_applicable";
    };
    runId?: string | undefined;
    turnId?: string | undefined;
    parentEventId?: string | undefined;
}>;
declare const SessionCommandReceiptSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"start_turn">;
    inputId: z.ZodString;
    turnId: z.ZodString;
    runId: z.ZodString;
    started: z.ZodBoolean;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
    accepted: z.ZodLiteral<true>;
}, "strict", z.ZodTypeAny, {
    type: "start_turn";
    version: 2;
    sessionId: string;
    runId: string;
    accepted: true;
    turnId: string;
    started: boolean;
    inputId: string;
    commandId: string;
}, {
    type: "start_turn";
    version: 2;
    sessionId: string;
    runId: string;
    accepted: true;
    turnId: string;
    started: boolean;
    inputId: string;
    commandId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"queue_turn">;
    inputId: z.ZodString;
    turnId: z.ZodString;
    runId: z.ZodString;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
    accepted: z.ZodLiteral<true>;
}, "strict", z.ZodTypeAny, {
    type: "queue_turn";
    version: 2;
    sessionId: string;
    runId: string;
    accepted: true;
    turnId: string;
    inputId: string;
    commandId: string;
}, {
    type: "queue_turn";
    version: 2;
    sessionId: string;
    runId: string;
    accepted: true;
    turnId: string;
    inputId: string;
    commandId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"steer_turn">;
    inputId: z.ZodString;
    expectedTurnId: z.ZodString;
    reservedTurnId: z.ZodString;
    reservedRunId: z.ZodString;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
    accepted: z.ZodLiteral<true>;
}, "strict", z.ZodTypeAny, {
    type: "steer_turn";
    version: 2;
    sessionId: string;
    accepted: true;
    inputId: string;
    commandId: string;
    expectedTurnId: string;
    reservedTurnId: string;
    reservedRunId: string;
}, {
    type: "steer_turn";
    version: 2;
    sessionId: string;
    accepted: true;
    inputId: string;
    commandId: string;
    expectedTurnId: string;
    reservedTurnId: string;
    reservedRunId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"interrupt_turn">;
    expectedTurnId: z.ZodString;
    interrupted: z.ZodBoolean;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
    accepted: z.ZodLiteral<true>;
}, "strict", z.ZodTypeAny, {
    type: "interrupt_turn";
    version: 2;
    sessionId: string;
    accepted: true;
    interrupted: boolean;
    commandId: string;
    expectedTurnId: string;
}, {
    type: "interrupt_turn";
    version: 2;
    sessionId: string;
    accepted: true;
    interrupted: boolean;
    commandId: string;
    expectedTurnId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"resolve_approval">;
    approvalId: z.ZodString;
    expectedTurnId: z.ZodString;
    status: z.ZodEnum<["approved", "denied"]>;
    version: z.ZodLiteral<2>;
    commandId: z.ZodString;
    sessionId: z.ZodString;
    accepted: z.ZodLiteral<true>;
}, "strict", z.ZodTypeAny, {
    type: "resolve_approval";
    status: "approved" | "denied";
    version: 2;
    sessionId: string;
    accepted: true;
    commandId: string;
    expectedTurnId: string;
    approvalId: string;
}, {
    type: "resolve_approval";
    status: "approved" | "denied";
    version: 2;
    sessionId: string;
    accepted: true;
    commandId: string;
    expectedTurnId: string;
    approvalId: string;
}>]>;
declare const SessionProtocolSnapshotSchema: z.ZodEffects<z.ZodObject<{
    version: z.ZodLiteral<2>;
    sessionId: z.ZodString;
    phase: z.ZodEnum<["idle", "preparing", "streaming", "waiting_approval", "executing_tools", "compacting", "settling", "failed", "interrupted"]>;
    activeTurnId: z.ZodOptional<z.ZodString>;
    activeRunId: z.ZodOptional<z.ZodString>;
    activeTurnFirstSequence: z.ZodOptional<z.ZodEffects<z.ZodNumber, number, number>>;
    activeExecution: z.ZodOptional<z.ZodObject<{
        mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
        selection: z.ZodOptional<z.ZodObject<{
            profileId: z.ZodString;
            selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
        }, "strict", z.ZodTypeAny, {
            profileId: string;
            selectionEpoch: number;
        }, {
            profileId: string;
            selectionEpoch: number;
        }>>;
    }, "strict", z.ZodTypeAny, {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    }, {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    }>>;
    pendingApprovals: z.ZodArray<z.ZodObject<{
        approvalId: z.ZodString;
        turnId: z.ZodString;
        toolName: z.ZodString;
        redactedSummary: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }, {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }>, "many">;
    /**
     * Opaque identities only: queued prompts never cross this read surface.
     * Optional so a new client can fail closed against an older v2 server.
     */
    pendingTurns: z.ZodOptional<z.ZodArray<z.ZodObject<{
        inputId: z.ZodString;
        turnId: z.ZodString;
        runId: z.ZodString;
        admittedSequence: z.ZodEffects<z.ZodNumber, number, number>;
        execution: z.ZodObject<{
            mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
            selection: z.ZodOptional<z.ZodObject<{
                profileId: z.ZodString;
                selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
            }, "strict", z.ZodTypeAny, {
                profileId: string;
                selectionEpoch: number;
            }, {
                profileId: string;
                selectionEpoch: number;
            }>>;
        }, "strict", z.ZodTypeAny, {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        }, {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        }>;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        turnId: string;
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
    }, {
        runId: string;
        turnId: string;
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
    }>, "many">>;
    pendingQueueCount: z.ZodEffects<z.ZodNumber, number, number>;
    pendingSteerCount: z.ZodEffects<z.ZodNumber, number, number>;
    earliestAvailableSequence: z.ZodEffects<z.ZodNumber, number, number>;
    throughSequence: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    version: 2;
    sessionId: string;
    pendingApprovals: {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }[];
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    pendingQueueCount: number;
    pendingSteerCount: number;
    earliestAvailableSequence: number;
    throughSequence: number;
    activeTurnId?: string | undefined;
    activeRunId?: string | undefined;
    activeTurnFirstSequence?: number | undefined;
    activeExecution?: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    } | undefined;
    pendingTurns?: {
        runId: string;
        turnId: string;
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
    }[] | undefined;
}, {
    version: 2;
    sessionId: string;
    pendingApprovals: {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }[];
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    pendingQueueCount: number;
    pendingSteerCount: number;
    earliestAvailableSequence: number;
    throughSequence: number;
    activeTurnId?: string | undefined;
    activeRunId?: string | undefined;
    activeTurnFirstSequence?: number | undefined;
    activeExecution?: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    } | undefined;
    pendingTurns?: {
        runId: string;
        turnId: string;
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
    }[] | undefined;
}>, {
    version: 2;
    sessionId: string;
    pendingApprovals: {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }[];
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    pendingQueueCount: number;
    pendingSteerCount: number;
    earliestAvailableSequence: number;
    throughSequence: number;
    activeTurnId?: string | undefined;
    activeRunId?: string | undefined;
    activeTurnFirstSequence?: number | undefined;
    activeExecution?: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    } | undefined;
    pendingTurns?: {
        runId: string;
        turnId: string;
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
    }[] | undefined;
}, {
    version: 2;
    sessionId: string;
    pendingApprovals: {
        toolName: string;
        turnId: string;
        approvalId: string;
        redactedSummary: string;
    }[];
    phase: "failed" | "idle" | "interrupted" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling";
    pendingQueueCount: number;
    pendingSteerCount: number;
    earliestAvailableSequence: number;
    throughSequence: number;
    activeTurnId?: string | undefined;
    activeRunId?: string | undefined;
    activeTurnFirstSequence?: number | undefined;
    activeExecution?: {
        mode: "agent" | "plan" | "ask" | "debug" | "review";
        selection?: {
            profileId: string;
            selectionEpoch: number;
        } | undefined;
    } | undefined;
    pendingTurns?: {
        runId: string;
        turnId: string;
        inputId: string;
        admittedSequence: number;
        execution: {
            mode: "agent" | "plan" | "ask" | "debug" | "review";
            selection?: {
                profileId: string;
                selectionEpoch: number;
            } | undefined;
        };
    }[] | undefined;
}>;
type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>;
type SessionCommandReceipt = z.infer<typeof SessionCommandReceiptSchema>;
type SessionProtocolSnapshot = z.infer<typeof SessionProtocolSnapshotSchema>;
type PendingSessionApproval = z.infer<typeof PendingSessionApprovalSchema>;

declare const PreparedSessionTurnIdentitySchema: z.ZodObject<{
    commandId: z.ZodString;
    inputId: z.ZodString;
    afterSequence: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    inputId: string;
    commandId: string;
    afterSequence: number;
}, {
    inputId: string;
    commandId: string;
    afterSequence: number;
}>;
declare const RemotePreparedTurnRecordSchema: z.ZodEffects<z.ZodObject<{
    version: z.ZodLiteral<1>;
    phase: z.ZodLiteral<"prepared">;
    commandId: z.ZodString;
    inputId: z.ZodString;
    afterSequence: z.ZodEffects<z.ZodNumber, number, number>;
    input: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp"]>;
        data: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }, {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"mention">;
        name: z.ZodString;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        type: "mention";
        path: string;
        name: string;
    }, {
        type: "mention";
        path: string;
        name: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"skill">;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "skill";
        name: string;
    }, {
        type: "skill";
        name: string;
    }>]>, "many">;
    mode: z.ZodEnum<["agent", "plan", "ask", "debug", "review"]>;
    selection: z.ZodOptional<z.ZodObject<{
        profileId: z.ZodString;
        selectionEpoch: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        profileId: string;
        selectionEpoch: number;
    }, {
        profileId: string;
        selectionEpoch: number;
    }>>;
}, "strict", z.ZodTypeAny, {
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 1;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    inputId: string;
    commandId: string;
    phase: "prepared";
    afterSequence: number;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 1;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    inputId: string;
    commandId: string;
    phase: "prepared";
    afterSequence: number;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>, {
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 1;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    inputId: string;
    commandId: string;
    phase: "prepared";
    afterSequence: number;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}, {
    input: ({
        type: "text";
        text: string;
    } | {
        data: string;
        type: "image";
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    } | {
        type: "mention";
        path: string;
        name: string;
    } | {
        type: "skill";
        name: string;
    })[];
    version: 1;
    mode: "agent" | "plan" | "ask" | "debug" | "review";
    inputId: string;
    commandId: string;
    phase: "prepared";
    afterSequence: number;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    } | undefined;
}>;
declare const RemoteAdmittedTurnRecordSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    phase: z.ZodLiteral<"admitted">;
    turnId: z.ZodString;
    runId: z.ZodString;
    afterSequence: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    version: 1;
    runId: string;
    turnId: string;
    phase: "admitted";
    afterSequence: number;
}, {
    version: 1;
    runId: string;
    turnId: string;
    phase: "admitted";
    afterSequence: number;
}>;
type PreparedSessionTurnIdentity = z.infer<typeof PreparedSessionTurnIdentitySchema>;
type RemotePreparedTurnRecord = z.infer<typeof RemotePreparedTurnRecordSchema>;
type RemoteTurnCursorRecord = Pick<z.infer<typeof RemoteAdmittedTurnRecordSchema>, "turnId" | "runId" | "afterSequence">;
interface RemoteTurnRecoveryStore {
    load(sessionId: string): Promise<RemoteTurnCursorRecord | undefined>;
    loadPrepared(sessionId: string): Promise<RemotePreparedTurnRecord | undefined>;
    save(sessionId: string, record: RemoteTurnCursorRecord): Promise<void>;
    savePrepared(sessionId: string, record: RemotePreparedTurnRecord): Promise<void>;
    clear(sessionId: string): Promise<void>;
}
interface FileRemoteTurnRecoveryStoreOptions {
    readonly rootDir: string;
    /** Already-canonical server/workspace authority namespace. */
    readonly namespace: string;
}
/**
 * One-file state machine for the client half of protocol-v2 admission.
 *
 * `prepared` is fsynced before POST. Replacing it with `admitted` is one
 * atomic rename, so a crash can leave only an idempotently replayable command
 * or an exact turn cursor, never a gap between them.
 */
declare class FileRemoteTurnRecoveryStore implements RemoteTurnRecoveryStore {
    #private;
    constructor(options: FileRemoteTurnRecoveryStoreOptions);
    load(sessionId: string): Promise<RemoteTurnCursorRecord | undefined>;
    loadPrepared(sessionId: string): Promise<RemotePreparedTurnRecord | undefined>;
    save(sessionId: string, record: RemoteTurnCursorRecord): Promise<void>;
    savePrepared(sessionId: string, record: RemotePreparedTurnRecord): Promise<void>;
    clear(sessionId: string): Promise<void>;
}

declare const MAX_REMOTE_MCP_PROMPT_COMMANDS = 256;
declare const MAX_REMOTE_MCP_PROMPT_ARGUMENTS = 32;
declare const MAX_REMOTE_MCP_PROMPT_CATALOG_CHARS: number;
declare const MAX_REMOTE_MCP_PROMPT_ARGUMENT_VALUE_CHARS: number;
declare const RemoteMcpPromptArgumentSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    required: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    required: boolean;
    name: string;
    description?: string | undefined;
}, {
    required: boolean;
    name: string;
    description?: string | undefined;
}>;
declare const RemoteMcpPromptCommandSchema: z.ZodObject<{
    promptId: z.ZodString;
    commandName: z.ZodString;
    serverName: z.ZodString;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    arguments: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        required: boolean;
        name: string;
        description?: string | undefined;
    }, {
        required: boolean;
        name: string;
        description?: string | undefined;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    name: string;
    serverName: string;
    arguments: {
        required: boolean;
        name: string;
        description?: string | undefined;
    }[];
    promptId: string;
    commandName: string;
    description?: string | undefined;
    title?: string | undefined;
}, {
    name: string;
    serverName: string;
    arguments: {
        required: boolean;
        name: string;
        description?: string | undefined;
    }[];
    promptId: string;
    commandName: string;
    description?: string | undefined;
    title?: string | undefined;
}>;
declare const RemoteMcpPromptCatalogSchema: z.ZodObject<{
    revision: z.ZodString;
    commands: z.ZodArray<z.ZodObject<{
        promptId: z.ZodString;
        commandName: z.ZodString;
        serverName: z.ZodString;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        arguments: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            required: boolean;
            name: string;
            description?: string | undefined;
        }, {
            required: boolean;
            name: string;
            description?: string | undefined;
        }>, "many">;
    }, "strict", z.ZodTypeAny, {
        name: string;
        serverName: string;
        arguments: {
            required: boolean;
            name: string;
            description?: string | undefined;
        }[];
        promptId: string;
        commandName: string;
        description?: string | undefined;
        title?: string | undefined;
    }, {
        name: string;
        serverName: string;
        arguments: {
            required: boolean;
            name: string;
            description?: string | undefined;
        }[];
        promptId: string;
        commandName: string;
        description?: string | undefined;
        title?: string | undefined;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    revision: string;
    commands: {
        name: string;
        serverName: string;
        arguments: {
            required: boolean;
            name: string;
            description?: string | undefined;
        }[];
        promptId: string;
        commandName: string;
        description?: string | undefined;
        title?: string | undefined;
    }[];
}, {
    revision: string;
    commands: {
        name: string;
        serverName: string;
        arguments: {
            required: boolean;
            name: string;
            description?: string | undefined;
        }[];
        promptId: string;
        commandName: string;
        description?: string | undefined;
        title?: string | undefined;
    }[];
}>;
declare const RemoteMcpPromptResolveRequestSchema: z.ZodObject<{
    revision: z.ZodString;
    promptId: z.ZodString;
    arguments: z.ZodEffects<z.ZodRecord<z.ZodString, z.ZodString>, Record<string, string>, Record<string, string>>;
}, "strict", z.ZodTypeAny, {
    arguments: Record<string, string>;
    revision: string;
    promptId: string;
}, {
    arguments: Record<string, string>;
    revision: string;
    promptId: string;
}>;
declare const RemoteMcpPromptResolveResponseSchema: z.ZodObject<{
    input: z.ZodArray<z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    input: {
        type: "text";
        text: string;
    }[];
}, {
    input: {
        type: "text";
        text: string;
    }[];
}>;
type RemoteMcpPromptArgument = z.infer<typeof RemoteMcpPromptArgumentSchema>;
type RemoteMcpPromptCommand = z.infer<typeof RemoteMcpPromptCommandSchema>;
type RemoteMcpPromptCatalog = z.infer<typeof RemoteMcpPromptCatalogSchema>;
type RemoteMcpPromptResolveRequest = z.infer<typeof RemoteMcpPromptResolveRequestSchema>;
type RemoteMcpPromptResolveResponse = z.infer<typeof RemoteMcpPromptResolveResponseSchema>;
declare function mcpPromptCommandName(serverName: string, promptName: string): string;
declare function mcpPromptOpaqueId(serverName: string, promptName: string): string;
/**
 * Create a deterministic bounded projection. Oversized catalogs fail closed
 * instead of being silently truncated, because a truncated catalog would make
 * its revision ambiguous across clients.
 */
declare function buildRemoteMcpPromptCatalog(prompts: readonly McpPromptRef[]): RemoteMcpPromptCatalog;

interface NexusServerClientOptions {
    baseUrl: string;
    directory: string;
    token: string;
}
interface RemoteChangeReviewEntry {
    changeSetId: string;
    proposalHash: string;
    path: string;
    operation: "create" | "modify" | "delete" | "rename";
    originalContent?: string;
    newContent?: string;
    diffStats: {
        added: number;
        removed: number;
    };
    isNewFile: boolean;
    contentOmitted?: boolean;
}
interface RemoteChangeReviewSnapshot {
    changes: RemoteChangeReviewEntry[];
    truncated: boolean;
}
declare const NEXUS_SERVER_TOKEN_SECRET_KEY = "nexuscode_server_token";
interface SessionTurnIdentity {
    turnId: string;
    runId: string;
}
declare class SessionTurnTerminalError extends Error {
    readonly turnId: string;
    readonly runId: string;
    readonly sequence: number;
    readonly status: "failed";
    constructor(options: {
        turnId: string;
        runId: string;
        sequence: number;
        status: "failed";
        message: string;
    });
}
interface SessionApprovalIdentity extends SessionTurnIdentity {
    approvalId: string;
    toolName: string;
    redactedSummary: string;
}
interface RunSessionTurnOptions {
    sessionId: string;
    input: readonly UserInputPartV2[];
    mode: Mode;
    selection?: {
        profileId: string;
        selectionEpoch: number;
    };
    signal?: AbortSignal;
    onTurn?: (identity: SessionTurnIdentity) => void;
    onApproval?: (identity: SessionApprovalIdentity) => void;
    onSequence?: (sequence: number) => void | Promise<void>;
    /**
     * Exact pre-dispatch identity and replay boundary from a durable client
     * outbox. When present, Nexus retries this command instead of allocating a
     * second idempotency identity.
     */
    prepared?: PreparedSessionTurnIdentity;
    /**
     * Awaited after the initial snapshot and command identity allocation, but
     * before the first POST. Throwing here guarantees the server was untouched.
     */
    onCommandPrepared?: (prepared: PreparedSessionTurnIdentity) => void | Promise<void>;
}
interface AttachSessionTurnOptions extends SessionTurnIdentity {
    sessionId: string;
    /**
     * Last envelope durably applied by the caller. Omit it to rebuild the
     * complete active turn from its first durable envelope.
     */
    afterSequence?: number;
    /**
     * Follow an exact reservation that a prior authoritative snapshot proved
     * was queued. This permits replay when it finishes between snapshots; it
     * never substitutes the session's current active turn.
     */
    followAcceptedTurn?: boolean;
    signal?: AbortSignal;
    onTurn?: (identity: SessionTurnIdentity) => void;
    onApproval?: (identity: SessionApprovalIdentity) => void;
    onSequence?: (sequence: number) => void | Promise<void>;
}
declare function isLoopbackNexusServerDestination(input: string): boolean;
declare function canonicalizeNexusServerBaseUrl(input: string): string;
declare function getNexusServerTokenSecretKey(baseUrl: string): string;
/**
 * Client for NexusCode server — list/create sessions, get messages, stream agent events.
 * Shared by extension and CLI when serverUrl is set.
 */
declare class NexusServerClient {
    private baseUrl;
    private directory;
    private token;
    constructor(opts: NexusServerClientOptions);
    private headers;
    private url;
    private request;
    private sessionPath;
    private sessionV2Path;
    dispatchSessionCommand(command: SessionCommandV2): Promise<SessionCommandReceipt>;
    getSessionProtocolSnapshot(sessionId: string, options?: {
        includePendingTurns?: boolean;
    }): Promise<SessionProtocolSnapshot>;
    getSessionChanges(sessionId: string): Promise<RemoteChangeReviewSnapshot>;
    resolveSessionChange(sessionId: string, changeSetId: string, action: "accept" | "revert"): Promise<{
        changeSetId: string;
        proposalHash: string;
        state: "accepted" | "reverted";
    }>;
    getMcpPromptCatalog(sessionId: string): Promise<RemoteMcpPromptCatalog>;
    resolveMcpPrompt(sessionId: string, request: RemoteMcpPromptResolveRequest, signal?: AbortSignal): Promise<RemoteMcpPromptResolveResponse>;
    streamSessionEvents(sessionId: string, afterSequence: number, signal?: AbortSignal): AsyncGenerator<ProtocolEnvelope>;
    runSessionTurn(options: RunSessionTurnOptions): AsyncGenerator<AgentEvent>;
    attachSessionTurn(options: AttachSessionTurnOptions): AsyncGenerator<AgentEvent>;
    private streamTurn;
    interruptSessionTurn(sessionId: string, expectedTurnId: string, reason?: string): Promise<boolean>;
    resolveSessionApproval(sessionId: string, expectedTurnId: string, approvalId: string, result: Pick<PermissionResult, "approved">): Promise<void>;
    listSessions(): Promise<Array<{
        id: string;
        ts: number;
        title?: string;
        messageCount: number;
        revision: number;
    }>>;
    createSession(): Promise<{
        id: string;
        cwd: string;
        ts: number;
        messageCount: number;
        revision: number;
    }>;
    getMessages(sessionId: string, opts?: {
        limit?: number;
        offset?: number;
    }): Promise<SessionMessage[]>;
    getSession(sessionId: string): Promise<{
        id: string;
        cwd: string;
        ts: number;
        messageCount: number;
        revision: number;
    }>;
    getRecentMessages(sessionId: string, limit?: number): Promise<SessionMessage[]>;
    deleteSession(sessionId: string): Promise<boolean>;
    abortSession(sessionId: string): Promise<boolean>;
    respondToApproval(sessionId: string, runId: string, partId: string, result: PermissionResult): Promise<void>;
    /**
     * Send message and stream AgentEvents as NDJSON. Yields each event (heartbeat lines are skipped).
     * Malformed lines yield an error event. Throws on fetch error.
     */
    streamMessage(sessionId: string, content: string, mode: Mode, presetName?: string, signal?: AbortSignal, options?: {
        onRunId?: (runId: string) => void;
    }): AsyncGenerator<AgentEvent>;
}
/** If no event (including heartbeat) received for this long, consider stream dead. */
declare const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20000;

interface AgentLoopOptions {
    session: ISession;
    client: LLMClient;
    host: IHost;
    config: NexusConfig;
    services: NexusRunServices;
    /** Durable immutable ownership allocated before this loop begins. */
    executionIdentity: AgentExecutionIdentity;
    mode: Mode;
    tools: ToolDef[];
    skills: SkillDef[];
    rulesContent: string;
    indexer?: IIndexer;
    compaction: SessionCompaction;
    signal: AbortSignal;
    gitBranch?: string;
    /** When set, commit on completion of an agent turn and optionally double-check. */
    checkpoint?: {
        commit(description?: string): Promise<string>;
    };
    /** When true, inject create-skill instructions; host must allow writes to .nexus/skills (and ~/.nexus/skills if applicable). */
    createSkillMode?: boolean;
    /** Durable delegated-agent input accepted only at provider boundaries. */
    mailbox?: AgentInputMailbox;
}
/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
declare function runAgentLoop(opts: AgentLoopOptions): Promise<void>;

type ToolGroup = "read" | "write" | "execute" | "search" | "mcp" | "skills" | "agents" | "always" | "context" | "git_inspect" | "plan_exit"
/** Switch UI/session to plan mode (only where planning is not already the focus). */
 | "plan_enter";
/**
 * Core built-in tool groups per mode.
 * Access control is enforced in the backend (getBuiltinToolsForMode + getBlockedToolsForMode in loop);
 * prompts only describe behaviour — they do not grant or revoke tool access.
 */
declare const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]>;
/**
 * Built-in tool names per group.
 * Tools in "always" are mode-agnostic utilities; mode-specific entries use plan_enter, plan_exit, etc.
 */
declare const TOOL_GROUP_MEMBERS: Record<ToolGroup, string[]>;
/**
 * Read-only tools that can be parallelized safely.
 */
declare const READ_ONLY_TOOLS: Set<string>;
/**
 * Read-only in scheduling terms, but capable of sending model/user-controlled
 * data to the public network. These use the separate browser permission and
 * must never inherit ordinary filesystem-read auto approval.
 */
declare const BROWSER_TOOLS: Set<string>;
/**
 * Get all built-in tool names available for a given mode.
 */
declare function getBuiltinToolsForMode(mode: Mode): string[];

interface PromptContext {
    mode: Mode;
    config: NexusConfig;
    cwd: string;
    modelId: string;
    providerName: string;
    skills: SkillDef[];
    rulesContent: string;
    mentionsContext?: string;
    compactionSummary?: string;
    indexStatus?: IndexStatus;
    gitBranch?: string;
    todoList?: string;
    diagnostics?: DiagnosticItem[];
    /** Active background work summary (bash/subagents/tasks). */
    backgroundJobsSummary?: string;
    /** Short project layout (top-level dirs and key files) at start */
    initialProjectContext?: string;
    /** Persistent memories relevant to this run (project/session/team). */
    memories?: RetrievedMemory[];
    /** OpenClaude-class session scrolling notes (`<id>.session-memory.md`), re-read each loop iteration. */
    sessionMemoryContent?: string;
    /** After compaction in plan mode: inject short OpenClaude-style workflow reminder (once per compaction). */
    planModeSparseReminder?: boolean;
    /** Context window usage (shown at start of system info so model sees token budget) */
    contextUsedTokens?: number;
    contextLimitTokens?: number;
    contextPercent?: number;
    /** When true, inject create-skill instructions and allow writes to skill dirs */
    createSkillMode?: boolean;
    /** Capability flag from provider; reserved for future prompt branching. */
    supportsStructuredOutput?: boolean;
    /** Exact tool manifest exposed to the provider for this turn. */
    enabledToolNames?: readonly string[];
}
/**
 * Assemble the full system prompt from blocks.
 * Cacheable blocks come first (stable = good for Anthropic prompt caching).
 * Dynamic blocks come last (vary per turn).
 *
 * Cache layout:
 *   [Block 0] Role + Identity (cacheable — changes rarely)
 *   [Block 1] Rules (cacheable — project-specific but stable)
 *   [Block 2] Skills (cacheable — task-specific but stable within a task)
 *   --- cache boundary ---
 *   [Block 3] System info + todos + diagnostics (dynamic per turn)
 *   [Block 4] @mentions context (dynamic)
 *   [Block 5] Compaction summary (dynamic)
 */
declare function buildSystemPrompt(ctx: PromptContext): {
    blocks: string[];
    cacheableCount: number;
};

type StorageDiagnosticCode = "primary-corrupt" | "backup-corrupt" | "recovered-from-backup" | "stale-lock-recovered";
interface StorageDiagnostic {
    code: StorageDiagnosticCode;
    path: string;
    message: string;
}
declare class StorageCorruptionError extends Error {
    readonly diagnostics: readonly StorageDiagnostic[];
    constructor(target: string, diagnostics: readonly StorageDiagnostic[]);
}
declare class FileLockTimeoutError extends Error {
    readonly target: string;
    readonly timeoutMs: number;
    constructor(target: string, timeoutMs: number);
}
interface AtomicWriteOptions {
    backup?: boolean;
    mode?: number;
}
interface FileLockOptions {
    timeoutMs?: number;
    staleMs?: number;
    retryMinMs?: number;
    retryMaxMs?: number;
    signal?: AbortSignal;
    onDiagnostic?: (diagnostic: StorageDiagnostic) => void;
}
/**
 * Replace a file without exposing a partially written target. The temporary
 * file is created in the same directory so rename remains an atomic boundary.
 */
declare function atomicWriteFile(target: string, content: string | Uint8Array, options?: AtomicWriteOptions): Promise<void>;
declare function atomicWriteJson(target: string, value: unknown, options?: AtomicWriteOptions): Promise<void>;
interface JsonRecoveryResult<T> {
    value: T | undefined;
    source: "primary" | "backup" | "missing";
    diagnostics: StorageDiagnostic[];
}
declare function readJsonWithRecovery<T>(target: string): Promise<JsonRecoveryResult<T>>;
declare function getFileLockPath(target: string): string;
/**
 * Serialize a durable mutation across both async callers in this process and
 * other Nexus processes sharing the same state directory.
 */
declare function withFileLock<T>(target: string, operation: () => Promise<T>, options?: FileLockOptions): Promise<T>;

declare function loadAgentDefinitions(cwd: string, compatibility?: ClaudeCompatibilityOptions, config?: NexusConfig): Promise<AgentDefinition[]>;

declare function ensureTeamMemberForTask(args: {
    cwd: string;
    host: IHost;
    task: TaskRecord;
    agentId?: string;
    agentType?: string;
    runtime?: OrchestrationRuntime;
}): Promise<void>;
declare function handleCompletedTaskSideEffects(args: {
    cwd: string;
    host: IHost;
    config: NexusConfig;
    task: TaskRecord;
    outputPreview?: string;
    runtime?: OrchestrationRuntime;
}): Promise<void>;

interface ExtractedMemoryInput {
    scope: MemoryRecord["scope"];
    title: string;
    content: string;
    kind?: MemoryRecord["kind"];
    source?: MemoryRecord["source"];
    author?: MemoryRecord["author"];
    trust?: MemoryRecord["trust"];
    confidence?: number;
    metadata?: Record<string, unknown>;
}
declare function extractMemoriesFromCompactionSummary(summary: string, sessionId: string): ExtractedMemoryInput[];

interface PluginDiagnostic {
    level: "warning" | "error";
    code: "manifest-glob-failed" | "manifest-invalid" | "manifest-shadowed";
    path: string;
    pluginName?: string;
    message: string;
}
interface PluginDiscoveryResult {
    plugins: PluginManifestRecord[];
    diagnostics: PluginDiagnostic[];
}
declare function resolvePluginDeclaredPath(plugin: PluginManifestRecord, declaredPath: string): string;
declare function validatePluginManifestFile(filePath: string): Promise<{
    success: boolean;
    errors: string[];
    warnings: string[];
    plugin?: PluginManifestRecord;
}>;
declare function discoverPluginManifests(cwd: string, compatibility?: ClaudeCompatibilityOptions): Promise<PluginDiscoveryResult>;
declare function loadPluginManifests(cwd: string, compatibility?: ClaudeCompatibilityOptions): Promise<PluginManifestRecord[]>;

interface PluginHookExecution {
    pluginName: string;
    hookEvent: string;
    success: boolean;
    output: string;
    preventContinuation?: boolean;
    stopReason?: string;
    additionalContext?: string;
}
type PluginHookEvent = "user_prompt_submit" | "before_tool" | "after_tool" | "turn_complete" | "task_completed" | "subagent_start" | "subagent_stop" | "teammate_idle"
/** Fired once per agent run when the instruction bundle is active (observability; OpenClaude instructions_loaded parity). */
 | "instructions_loaded";
declare function applyPluginRuntimeSettings(plugin: PluginManifestRecord, config: NexusConfig, trust?: PluginTrustEvaluation): PluginManifestRecord;
declare function loadPluginRuntimeRecords(cwd: string, config: NexusConfig, trustOptions?: PluginTrustStoreOptions): Promise<PluginManifestRecord[]>;
/** Capabilities from project-controlled plugins are active only after explicit trust. */
declare function loadTrustedPluginRuntimeRecords(cwd: string, config: NexusConfig, trustOptions?: PluginTrustStoreOptions): Promise<PluginManifestRecord[]>;
declare function runPluginHooks(cwd: string, host: IHost, config: NexusConfig, hookEvent: PluginHookEvent, payload: Record<string, unknown>): Promise<PluginHookExecution[]>;
declare function runScopedHooks(cwd: string, host: IHost, hookEvent: PluginHookEvent, payload: Record<string, unknown>, items: Array<{
    name: string;
    rootDir: string;
    hooks: string[];
}>): Promise<PluginHookExecution[]>;

interface PluginCapabilityDiagnostic {
    level: "warning" | "error";
    code: "plugin-mcp-file-invalid" | "plugin-mcp-server-invalid" | "plugin-mcp-server-shadowed" | "plugin-mcp-cwd-escape" | "project-mcp-pending" | "project-mcp-pending-invalid";
    pluginName: string;
    path: string;
    serverName?: string;
    message: string;
}
interface McpServerCapabilityProvenance {
    serverName: string;
    status: "active" | "pending" | "shadowed";
    source: "plugin-inline" | "plugin-file" | "trusted-runtime-config" | "project-config" | "project-mcp-json";
    path: string;
    pluginName?: string;
    pluginRoot?: string;
    trustBinding?: "exact-content-grant";
    message?: string;
}
interface PendingMcpServerCapability {
    server: McpServerConfig;
    provenance: McpServerCapabilityProvenance;
}
interface PluginMcpCapabilityResult {
    servers: McpServerConfig[];
    diagnostics: PluginCapabilityDiagnostic[];
    provenance: McpServerCapabilityProvenance[];
    pendingServers: PendingMcpServerCapability[];
}
/**
 * Load MCP server definitions contributed by explicitly trusted and enabled
 * plugins. Invalid siblings are isolated and reported instead of hiding valid
 * servers from the same file.
 */
declare function loadPluginMcpServers(cwd: string, config: NexusConfig): Promise<PluginMcpCapabilityResult>;
/** Explicit project/user MCP configuration wins over plugin contributions. */
declare function resolveConfiguredAndPluginMcpServers(cwd: string, config: NexusConfig): Promise<PluginMcpCapabilityResult>;

interface LoadedSlashCommand {
    command: string;
    scope: "project" | "user" | "plugin";
    sourcePath: string;
    description: string;
    prompt: string;
    pluginName?: string;
}
type SlashCommandResolution = {
    status: "resolved";
    command: LoadedSlashCommand;
} | {
    status: "ambiguous";
    candidates: string[];
} | {
    status: "not-found";
};
declare function loadSlashCommands(cwd: string, compatibility?: ClaudeCompatibilityOptions, config?: NexusConfig): Promise<LoadedSlashCommand[]>;
/**
 * Resolve a slash command consistently across CLI and editor surfaces.
 * Canonical names always win. Project commands shadow user commands, while a
 * plugin basename is accepted only when exactly one plugin contributes it.
 */
declare function resolveSlashCommand(commands: LoadedSlashCommand[], requestedName: string): SlashCommandResolution;
declare function renderSlashCommandPrompt(command: LoadedSlashCommand, args: string): string;

declare function assertAgentExecutionIdentity(identity: AgentExecutionIdentity): void;
declare function toolExecutionIdentity(base: AgentExecutionIdentity, input: {
    messageId: string;
    partId: string;
    toolCallId: string;
}): ToolExecutionIdentity;
declare function delegatedAgentExecutionIdentity(parent: ToolExecutionIdentity, input: {
    workspaceId?: string;
    sessionId: string;
    subagentId: string;
}): AgentExecutionIdentity;

type CompletionState = {
    doubleCheckEnabled: boolean;
    pending: {
        current: boolean;
    };
    checkpoint?: {
        commit(description?: string): Promise<string>;
    };
};

type ToolExecutionOrigin = "native" | "textual" | "parallel" | "mcp" | "plugin" | "subagent";
interface ToolExecutionRequest {
    callId: string;
    messageId: string;
    partId: string;
    toolName: string;
    input: Record<string, unknown>;
    origin: ToolExecutionOrigin;
}
type HookRunner = (cwd: string, host: IHost, config: ToolContext["config"], event: PluginHookEvent, payload: Record<string, unknown>) => Promise<PluginHookExecution[]>;
type ToolPipelineStage = "validate" | "before_tool" | "approve" | "execute" | "spill" | "after_tool";
interface ToolExecutionEnvironment {
    tools: readonly ToolDef[];
    context: ToolContext;
    autoApproveActions: ReadonlySet<PermissionAction>;
    mode: Mode;
    mcpToolNames: ReadonlySet<string>;
    completionState?: CompletionState;
    hookRunner?: HookRunner;
    onStage?: (stage: ToolPipelineStage) => void;
}
interface ToolExecutionOutcome extends ToolResult {
    toolName: string;
    normalizedInput: Record<string, unknown>;
    denied?: boolean;
    stoppedByHook?: boolean;
    beforeHookResults?: PluginHookExecution[];
    afterHookResults?: PluginHookExecution[];
}
declare function executeToolPipeline(request: ToolExecutionRequest, environment: ToolExecutionEnvironment): Promise<ToolExecutionOutcome>;

/** Snippets actually applied by the Edit tool — for compact CLI/webview previews. */
type AppliedReplacementSnippet = {
    oldSnippet: string;
    newSnippet: string;
};
/** Normalize metadata from Edit.execute() for host events and UIs. */
declare function normalizedAppliedReplacementsFromMetadata(metadata: unknown): AppliedReplacementSnippet[] | undefined;

/** Exact line multiplicity for approval and review surfaces. */
declare function exactLineDiffStats(before: string, after: string): {
    added: number;
    removed: number;
};
/**
 * Recover exact changed-line counts from canonical unified hunks.
 *
 * Hunk old/new lengths include unchanged context and must never be exposed as
 * additions/removals. The patch body preserves the actual +/- ownership.
 */
declare function exactChangeHunkDiffStats(hunks: readonly ChangeHunk[]): {
    added: number;
    removed: number;
};
/**
 * Build canonical unified hunks for the durable proposal hash. UI-oriented
 * line deltas are intentionally a separate projection because they are
 * truncated and cannot prove the exact approved patch.
 */
declare function buildDurableChangeHunks(before: string, after: string): readonly ChangeHunk[];

declare function getAllBuiltinTools(): ToolDef[];

interface ShellCommandInterpretation {
    isError: boolean;
    message?: string;
}
declare function interpretShellCommandResult(command: string, exitCode: number, stdout: string, stderr: string): ShellCommandInterpretation;

/** One row from the model before padding / id assignment (OpenClaude-style). */
type QuestionOptionRow = {
    label: string;
    description?: string;
    preview?: string;
};
/** Synthetic option id for the host-added “Other / custom” row (never send from the model). */
declare const NEXUS_CUSTOM_OPTION_ID = "__nexus_other__";
/** First line of user messages created after submitting a questionnaire (hosts may use for compact UI). */
declare const NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX = "[nexus:questionnaire-response]\n";
declare function formatQuestionnaireAnswersForAgent(request: UserQuestionRequest, answers: UserQuestionAnswer[]): string;

/**
 * Shared rules for which tool starts count as “subagent parents” in hosts (CLI timeline, VS Code shadow, webview).
 * Keep webview `transcript/helpers.ts` in sync — webview cannot bundle @nexuscode/core.
 */
/** Strip functions./tools. prefix, then lowercase alnum-only (for Parallel inner recipient_name). */
declare function canonParallelInnerRecipient(raw: string): string;
declare function parallelInnerUseIsDelegatedAgent(use: {
    recipient_name?: unknown;
    parameters?: unknown;
}): boolean;
/** True when Parallel’s tool_uses are only delegated-agent spawns (legacy Spawn* or TaskCreate kind=agent). */
declare function isPureSubagentParallelInput(input: unknown): boolean;
declare function delegatedAgentDescriptionFromParallelInnerParams(parameters: unknown): string | null;
declare function getParallelDelegatedAgentTaskDescriptions(input?: Record<string, unknown>): string[];
/** Tool start that should receive subagent_* events when parentPartId is missing. */
declare function isDelegatedAgentParentTool(tool: string, input?: Record<string, unknown>): boolean;
/**
 * Whether finishing this tool should clear the “last subagent parent part id” fallback.
 * Parallel is excluded: subagent_* may arrive after Parallel tool_end; keep the parent id until a later tool overwrites it.
 */
declare function isDelegatedAgentParentToolEndClear(tool: string, input?: Record<string, unknown>): boolean;

/**
 * Optional host-provided behavior (VS Code: ripgrep file list + globalStorage tracker).
 * Roo-Code parity: `listFiles` + `CacheManager` in extension storage vs core walk + ~/.nexus tracker.
 */
type ListIndexAbsolutePathsFn = (root: string, maxList: number, signal: AbortSignal) => Promise<{
    paths: string[];
    limitReached: boolean;
}>;
interface CodebaseIndexerHostOptions {
    listAbsolutePaths?: ListIndexAbsolutePathsFn;
    /** When set, `file-tracker.json` is stored at this path (e.g. `globalStorageUri`). */
    fileTrackerJsonPath?: string;
}

declare class CodebaseIndexer implements IIndexer {
    private readonly projectRoot;
    private readonly config;
    private fileTracker;
    private vector?;
    private forceVectorBackfill;
    private _status;
    private indexing;
    private abortController?;
    private indexRun?;
    private lifecycleTail;
    private debounceTimers;
    private statusListeners;
    private indexingPaused;
    private pauseWaiters;
    private readonly hostListAbsolutePaths?;
    constructor(projectRoot: string, config: NexusConfig, embeddingClient?: EmbeddingClient, vectorUrl?: string, projectHash?: string, hostOptions?: CodebaseIndexerHostOptions);
    status(): IndexStatus;
    /** False when config requests vector search but factory fell back (no Qdrant, missing embed key, etc.). */
    semanticSearchActive(): boolean;
    onStatusChange(listener: (status: IndexStatus) => void): () => void;
    private notifyStatus;
    private flushPauseWaiters;
    private waitIfPaused;
    /** Pause between parse/embed checkpoints (does not cancel in-flight embedding API calls). */
    pauseIndexing(): void;
    resumeIndexing(): void;
    private withLifecycleLock;
    private stopActiveRun;
    startIndexing(): Promise<void>;
    private beginIndexing;
    private fatalResetAfterIndexingStarted;
    private indexInBackground;
    private extractEntriesForIndex;
    private extractEntriesLegacy;
    private processBatchLegacy;
    refreshFile(filePath: string): Promise<void>;
    refreshFileNow(filePath: string): Promise<void>;
    refreshFilesBatchNow(absPaths: string[]): Promise<void>;
    /** Roo `reportFileQueueProgress` — debounced watcher batch, not full scan. */
    private notifyWatcherQueueProgress;
    private refreshOneFileCore;
    search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
    /**
     * Incremental sync / resume: one Qdrant collection + one tracker per project; does not wipe data.
     * Use `fullRebuildIndex` to clear and rebuild from scratch.
     */
    syncIndexing(): Promise<void>;
    /** Full wipe + re-index (same collection name, empty contents). */
    fullRebuildIndex(): Promise<void>;
    /** @deprecated use syncIndexing */
    reindex(): Promise<void>;
    deleteIndex(): Promise<void>;
    private deleteIndexData;
    /**
     * Remove tracker + vector points for a repo-relative prefix (folder or file path).
     * Does not delete other paths; one collection remains for the workspace.
     */
    deleteIndexScope(relPathOrAbs: string): Promise<void>;
    private deleteIndexScopeData;
    stop(): void;
    close(): void;
    /** Await in-flight parse/embed work before replacing or disposing this indexer. */
    closeAndWait(): Promise<void>;
}

declare function getTreeSitterLanguageWasmsDir(): string;
declare function getWebTreeSitterWasmPath(): string;

/** Schema default; Roo parity: `maxIndexedFiles === 0` disables listing. */
declare const DEFAULT_MAX_INDEXED_FILES = 50000;
declare const DEFAULT_MAX_PENDING_EMBED_BATCHES = 20;
declare const DEFAULT_BATCH_PROCESSING_CONCURRENCY = 10;
/** VS Code–style batch debounce for file watcher (ms). */
declare const INDEX_FILE_WATCHER_DEBOUNCE_MS = 500;

interface ProjectInfo {
    root: string;
    hash: string;
    lastAccessed: number;
    indexDir: string;
}
/**
 * Project registry for multi-project support.
 * Assigns a unique hash-based index directory to each project root.
 */
declare class ProjectRegistry {
    private projects;
    static load(): Promise<ProjectRegistry>;
    registerProject(root: string): Promise<ProjectInfo>;
    getProject(root: string): ProjectInfo | undefined;
    listProjects(): ProjectInfo[];
    removeProject(root: string): Promise<void>;
    private evictOldest;
    private save;
}
declare function getIndexDir(projectRoot: string): string;
declare function getProjectHash(projectRoot: string): string;

interface IndexerFactoryOptions {
    onWarning?: (message: string) => void;
    /** Progress messages during Qdrant startup and indexer creation (e.g. for UI or terminal). */
    onProgress?: (message: string) => void;
    /** Max ms to wait for Qdrant when vector is enabled (e.g. 2500 for fast first message). Omit for default 20s. */
    maxQdrantWaitMs?: number;
    /** VS Code: ripgrep `listFiles` parity. Omit = recursive `walkDir` in core. */
    listAbsolutePaths?: ListIndexAbsolutePathsFn;
    /** VS Code `globalStorageUri` JSON path for file hashes (Roo `CacheManager` parity). */
    fileTrackerJsonPath?: string;
}
/**
 * Creates a CodebaseIndexer with optional vector search (Qdrant).
 * When vector prerequisites are missing, returns indexer without vector (no semantic search; agent works without codebase_search).
 */
declare function createCodebaseIndexer(projectRoot: string, config: NexusConfig, options?: IndexerFactoryOptions): Promise<CodebaseIndexer>;

/**
 * Optional sink for indexing diagnostics (Roo-style telemetry hooks without bundling a telemetry SDK).
 */
type IndexTelemetryPayload = Record<string, unknown>;
declare function setIndexTelemetrySink(fn: ((event: string, payload?: IndexTelemetryPayload) => void) | undefined): void;

/** When `vectorIndexing` is true, include full tree-sitter extension set from `roo/extensions`. */
declare function getIndexableExtensions(vectorIndexing: boolean): Set<string>;
/** VS Code `RelativePattern` glob: all indexable extensions (Roo `scannerExtensions`–style coverage when vector on). */
declare function buildIndexWatcherGlobPattern(vectorIndexing: boolean): string;

interface EnsureQdrantOptions {
    url: string;
    autoStart: boolean;
    log?: (message: string) => void;
    /** Progress messages during startup (e.g. "Checking Qdrant...", "Starting Qdrant (binary)..."). */
    onProgress?: (message: string) => void;
    /** Max ms to wait for Qdrant to become healthy after starting (e.g. 2500 for fast first message). Default 20_000. */
    maxWaitMs?: number;
}
interface EnsureQdrantResult {
    available: boolean;
    started: boolean;
    method?: "existing" | "binary" | "docker";
    warning?: string;
}
/**
 * Ensures Qdrant is reachable. If autoStart is enabled, tries to start a local instance.
 */
declare function ensureQdrantRunning(opts: EnsureQdrantOptions): Promise<EnsureQdrantResult>;

/**
 * Parse @mentions in text and resolve them to content.
 * @file:path, @folder:path, @url:..., @problems, @git, @terminal
 */
declare function parseMentions(text: string, cwd: string, host?: IHost): Promise<{
    text: string;
    contextBlocks: string[];
}>;

declare function loadRules(cwd: string, rulePatterns: string[], compatibility?: ClaudeCompatibilityOptions): Promise<string>;

/**
 * Trusted instruction bundle for the agent.
 *
 * Agent-authored auto/team/session memory must never be concatenated here:
 * this string is rendered as authoritative project rules. Memory is selected,
 * cited, and rendered through the explicitly untrusted memory prompt block.
 */
declare function loadAgentInstructionBundle(cwd: string, rulePatterns: string[], _config: NexusConfig, compatibility?: ClaudeCompatibilityOptions): Promise<string>;

/** OpenClaude-style: `~/.nexus/projects/<project-hash>/memory/`. */
declare function getDefaultAutoMemoryDir(cwd: string): string;
declare function resolveAutoMemoryDirectory(cwd: string, config: NexusConfig): string | null;
/**
 * Load all `*.md` under the auto-memory directory (project-scoped notes, agent-written memory).
 */
declare function loadAutoMemoryMarkdown(cwd: string, config: NexusConfig, options?: {
    excludeBasenames?: readonly string[];
}): Promise<string>;

declare function getSessionMemoryFilePath(sessionId: string, cwd: string, homeDir?: string): string;
declare function readSessionMemoryFile(sessionId: string, cwd: string, homeDir?: string): Promise<string>;
/**
 * Background refresh: merge conversation tail into the session memory file (OpenClaude Session Memory parity).
 */
declare function refreshSessionMemoryFile(opts: {
    session: ISession;
    client: LLMClient;
    cwd: string;
    config: NexusConfig;
    signal: AbortSignal;
}): Promise<void>;
declare function appendCompactionSnippetToSessionMemory(sessionId: string, cwd: string, summaryText: string, maxChars: number, homeDir?: string): Promise<void>;

type ToolSpillRegistryEntry = {
    absolutePath: string;
    artifactId: string;
    toolName: string;
    workspaceCwd: string;
    /** Session whose output directory physically owns the file. */
    ownerSessionId: string;
    /** Session whose transcript currently references the file. */
    sessionId: string;
    partId: string;
    createdAt: number;
};
declare function registerToolOutputSpill(args: {
    cwd: string;
    sessionId: string;
    partId: string;
    absolutePath: string;
    artifactId?: string;
    toolName: string;
    /** Used only when an owned subagent artifact is projected into its parent. */
    ownerSessionId?: string;
}): void;
declare function getToolOutputSpill(sessionId: string, partId: string): ToolSpillRegistryEntry | undefined;
/**
 * Re-key spill registry when a subagent {@link ToolPart} is cloned into the parent session (new part id).
 * Uses {@link ToolPart.outputSpillPath} if set, else looks up the subagent session + source part id.
 */
declare function inheritSpillRegistryForMergedToolPart(args: {
    cwd: string;
    parentSessionId: string;
    newPartId: string;
    subagentSessionId: string;
    sourcePartId: string;
    toolName: string;
    outputSpillPath?: string;
    outputArtifactId?: string;
    outputArtifactOwnerSessionId?: string;
}): string | undefined;
declare function clearToolSpillsForSession(sessionId: string): void;
/** All spills for a session (e.g. auto-dream / diagnostics). */
declare function listToolSpillsForSession(sessionId: string): ToolSpillRegistryEntry[];

/**
 * Optional team-scoped markdown under ~/.nexus/teams/{name}/memory/ (recursive .md files).
 */
declare function loadTeamMemoryMarkdown(cwd: string, config: NexusConfig, ownedRuntime?: OrchestrationRuntime): Promise<string>;

/**
 * Own session-memory refreshes at workspace scope.
 *
 * The supervisor deduplicates adjacent turns for the same session and aborts
 * the model request before workspace integrations are disposed. Ephemeral
 * delegated sessions already persist their transcript snapshot and must not
 * leak standalone session-memory files.
 */
declare function scheduleSessionMemoryRefresh(options: {
    session: ISession;
    client: LLMClient;
    cwd: string;
    config: NexusConfig;
    services: NexusRunServices;
    run?: typeof refreshSessionMemoryFile;
}): WorkspaceTaskHandle | undefined;

interface CompactionProjectionResult {
    readonly memoryRecords: number;
    readonly sessionMemoryUpdated: boolean;
    readonly diagnostics: readonly string[];
}
/**
 * Project one already-persisted summary into secondary memory stores.
 *
 * The transcript remains authoritative. Projection failures are returned as
 * diagnostics and never turn a durable compaction into a false failure.
 */
declare function projectPersistedCompactionSummary(input: {
    session: ISession;
    summaryMessageId: string;
    cwd: string;
    config: NexusConfig;
    orchestrationRuntime: OrchestrationRuntime;
    /** Optional storage root override for tests and embedded hosts. */
    sessionMemoryHomeDir?: string;
}): Promise<CompactionProjectionResult>;

interface LegacyMemoryImportResult {
    imported: number;
    unchanged: number;
    removed: number;
    skipped: number;
    truncated: boolean;
}
/**
 * Migrate OpenClaude-style Markdown memory into the canonical transactional
 * store. Files are treated as opaque, untrusted data: @include directives are
 * deliberately not expanded.
 */
declare function importLegacyMemoryFiles(input: {
    cwd: string;
    config: NexusConfig;
    runtime: OrchestrationRuntime;
    homeDir?: string;
}): Promise<LegacyMemoryImportResult>;

/**
 * Periodically merge project auto-memory markdown into one durable file (OpenClaude auto-dream parity).
 */
declare function runAutoMemoryDreamIfDue(opts: {
    cwd: string;
    config: NexusConfig;
    client: LLMClient;
    signal: AbortSignal;
}): Promise<void>;

interface ToolOutputMaintenanceResult {
    scannedSessionDirectories: number;
    scannedArtifacts: number;
    removedArtifacts: number;
    truncated: boolean;
    errors: string[];
}
interface ToolOutputMaintenanceOptions {
    signal?: AbortSignal;
    now?: number;
    retentionMs?: number;
    maxSessionDirectories?: number;
    maxArtifactsPerSession?: number;
    /** Session home override for isolated hosts/tests. */
    sessionHomeDir?: string;
}

declare function scheduleToolOutputMaintenance(options: {
    cwd: string;
    services: NexusRunServices;
    onResult?: (result: ToolOutputMaintenanceResult) => void;
    run?: (cwd: string, options: ToolOutputMaintenanceOptions) => Promise<ToolOutputMaintenanceResult>;
}): WorkspaceTaskHandle | undefined;

/**
 * Token estimation utilities.
 * Approximation: ~4 chars per token (standard heuristic).
 */
declare function estimateTokens(text: string): number;

/**
 * Model context window limit: config override or known defaults by model id substring.
 */
declare function getContextWindowLimit(modelId: string, configuredLimit?: number): number;
/**
 * Token estimate for messages that count toward the next model request (active context only).
 * Includes reasoning and images; tool outputs use stored text (already truncated at execution when huge).
 */
declare function estimateActiveContextSessionTokens(messages: SessionMessage[]): number;
/**
 * Rough token overhead for tool definitions sent with each request (name + description + schema fudge).
 */
declare function estimateToolsDefinitionsTokens(tools: Array<{
    name: string;
    description: string;
}>): number;
type ContextUsageSnapshot = {
    usedTokens: number;
    limitTokens: number;
    percent: number;
};
declare function computeContextUsageMetrics(opts: {
    sessionMessages: SessionMessage[];
    systemPromptText?: string;
    toolsDefinitionTokens?: number;
    modelId: string;
    configuredContextWindow?: number;
}): ContextUsageSnapshot & {
    sessionTokens: number;
    systemTokens: number;
    toolsTokens: number;
};

interface SkillUrlRegistryOptions {
    cacheDirectory?: string;
    fetcher?: typeof fetch;
    maxIndexBytes?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxSkills?: number;
    maxFilesPerSkill?: number;
    timeoutMs?: number;
}
/**
 * Download a registry's index and return cached directories containing a
 * regular `SKILL.md`. A broken refresh preserves the last complete pack.
 */
declare function fetchSkillUrlRegistryRoots(baseUrl: string, options?: SkillUrlRegistryOptions): Promise<string[]>;

type SkillLoadDiagnosticCode = "skill-too-large" | "skill-symlink" | "skill-frontmatter-invalid" | "skill-name-mismatch" | "skill-read-failed" | "skill-glob-failed" | "skill-registry-failed";
interface SkillLoadDiagnostic {
    code: SkillLoadDiagnosticCode;
    path: string;
    message: string;
}
interface SkillLoadOptions {
    homeDirectory?: string;
    onDiagnostic?: (diagnostic: SkillLoadDiagnostic) => void;
    remoteRegistry?: SkillUrlRegistryOptions;
}
/**
 * Load skills from configured paths and standard locations.
 *
 * Config paths can be:
 *  - A directory path like ".nexus/skills/my-skill" → loads SKILL.md + subdirectory context
 *  - A glob pattern like ".nexus/skills/**\/*.md"
 *  - A direct file path like ".nexus/skills/my-skill/SKILL.md"
 *
 * Standard locations are also auto-searched: **`~/.nexus/skills`** and **walk-up** from `cwd` for each ancestor’s **`.nexus/skills`** (monorepos / nested roots).
 *
 * Optional `skillsUrls`: remote registries (each base URL must serve `index.json` + skill files); cached under `~/.nexus/cache/skills/`.
 */
declare function loadSkills(skillPaths: string[], cwd: string, skillsUrls?: string[], compatibility?: ClaudeCompatibilityOptions, config?: NexusConfig, options?: SkillLoadOptions): Promise<SkillDef[]>;

type SkillToolDescriptionRow = {
    name: string;
    description: string;
    location: string;
};
type ResolvedSkillBody = {
    displayName: string;
    content: string;
    skillDir: string;
    authority: SkillAuthority;
};
declare class SkillNameAmbiguityError extends Error {
    readonly query: string;
    readonly candidates: string[];
    constructor(query: string, candidates: string[]);
}
/** Rows for the `Skill` tool description (`<available_skills>`), from the same set as `loadSkills`. */
declare function loadSkillToolCatalogRows(cwd: string, config: NexusConfig): Promise<SkillToolDescriptionRow[]>;
/**
 * Resolve skill body from `loadSkills` only.
 * Exact and normalized-exact names take precedence. Ambiguous partial matches
 * throw `SkillNameAmbiguityError` with deterministic candidate names.
 */
declare function resolveSkillBody(query: string, cwd: string, config: NexusConfig, loadOptions?: SkillLoadOptions): Promise<ResolvedSkillBody | null>;
/** Dynamic `Skill` tool description: lists discoverable skills for the LLM. */
declare function buildSkillToolDynamicDescription(rows: SkillToolDescriptionRow[]): string;
/** Sample files under the skill directory (paths containing `skill.md` skipped). */
declare function sampleSkillSiblingFiles(skillDir: string, signal?: AbortSignal, capturedAuthority?: SkillAuthority): Promise<string[]>;

/**
 * MCP client transports: stdio, SSE (legacy remote), Streamable HTTP (current spec).
 */

/** Remote URL transport: explicit `transport`, or Roo-style `type`, else SSE (backward compatible). */
declare function effectiveUrlTransport(config: McpServerConfig): "http" | "sse";
/**
 * Build MCP transport. `bundle` must already be resolved to `command`/`url` by the host.
 */
declare function createMcpTransport(config: McpServerConfig, options?: McpTransportFactoryOptions): Transport;

interface McpRemoteFetchHopRequest {
    url: string;
    authorization: AuthorizedNetworkRequest;
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
    signal: AbortSignal;
}
type McpRemoteFetchHop = (request: McpRemoteFetchHopRequest) => Promise<Response>;
interface McpAuthorizedFetchOptions {
    /** Injectable hop transport for deterministic, network-free tests. */
    hop?: McpRemoteFetchHop;
    maxRedirects?: number;
    maxRequestBytes?: number;
    maxRequestHeaders?: number;
    maxRequestHeaderBytes?: number;
    maxResponseHeaders?: number;
    maxResponseHeaderBytes?: number;
    /** Maximum bytes in a finite (for example JSON) response body. */
    maxResponseBytes?: number;
    /** Maximum raw bytes in one SSE record; the stream lifetime is unbounded. */
    maxSseEventBytes?: number;
}
type McpNodeRequestFactory = (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => http.ClientRequest;
interface McpPinnedNodeHopOptions {
    httpRequest?: McpNodeRequestFactory;
    httpsRequest?: McpNodeRequestFactory;
    maxResponseHeaders?: number;
    maxResponseHeaderBytes?: number;
}
/**
 * Build a Node lookup function which never consults DNS. It returns only the
 * host-authorized answers for the exact hostname of this request hop.
 */
declare function createMcpPinnedLookup(authorization: AuthorizedNetworkRequest): LookupFunction;
/**
 * Streaming Node HTTP(S) hop with DNS pinning. The original hostname remains
 * in the request options for Host/TLS certificate validation, while lookup()
 * can return only addresses authorized for this exact URL.
 */
declare function createNodePinnedMcpFetchHop(options?: McpPinnedNodeHopOptions): McpRemoteFetchHop;
declare function createMcpAuthorizedFetch(authorize: McpRemoteRequestAuthorizer, options?: McpAuthorizedFetchOptions): FetchLike;

interface McpResourceClient {
    listResources(serverName?: string, signal?: AbortSignal): Promise<McpResourceRef[]>;
    listResourceTemplates(serverName?: string, signal?: AbortSignal): Promise<McpResourceTemplateRef[]>;
    readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<McpResourceContent[]>;
}
/**
 * Codex-style MCP resource tools, materialized per server so approvals and
 * persisted grants remain scoped to one server and operation.
 */
declare function createMcpResourceTools(client: McpResourceClient, allowedServerNames: ReadonlySet<string>): ToolDef[];

declare const MAX_MODEL_TOOL_NAME_CHARS = 64;
/**
 * Preserve existing readable MCP names when already provider-safe. User-
 * controlled or oversized names receive a deterministic hash suffix, keeping
 * raw protocol identity separate and preventing sanitized-name collisions.
 */
declare function callableMcpToolName(serverName: string, toolName: string): string;

interface ResolveBundledOptions {
    /** Project directory (agent cwd); passed as CLAUDE_PROJECT_DIR to bundled servers */
    cwd: string;
    /**
     * NexusCode repo root for resolving relative bundle paths.
     * When null/undefined or path does not exist, bundled entries are skipped.
     */
    nexusRoot: string | null | undefined;
}
/**
 * Resolves any server with bundle === "context-mode" to a full config
 * (command, args, env with CLAUDE_PROJECT_DIR). An absolute
 * NEXUS_CONTEXT_MODE_PATH also works in installed CLI/VSIX builds that do not
 * have a Nexus repository root. Missing optional bundles are omitted.
 */
declare function resolveBundledMcpServers(servers: McpServerConfig[], options: ResolveBundledOptions): McpServerConfig[];

/**
 * Models catalog from models.dev.
 * Used by CLI and extension to show "Select model" with Recommended / free models.
 * Free models (cost.input === 0) are sorted first so users can start without an API key (OpenRouter free tier).
 */
interface CatalogModel {
    id: string;
    name: string;
    /** Zero-cost / free tier */
    free: boolean;
    /** Optional sort order for recommended (lower first) */
    recommendedIndex?: number;
}
interface CatalogProvider {
    id: string;
    name: string;
    baseUrl: string;
    /** Nexus uses openai-compatible with this baseUrl */
    models: CatalogModel[];
}
interface ModelsCatalog {
    providers: CatalogProvider[];
    /** Flat list: free models first (Recommended), then rest */
    recommended: Array<{
        providerId: string;
        modelId: string;
        name: string;
        free: boolean;
    }>;
}
declare function getModelsUrl(): string;
declare function getModelsPath(): string | undefined;
/**
 * Load catalog from all available sources with 15s timeout per source.
 * Uses only sources that respond in time; results are merged and deduplicated by (providerId, modelId).
 */
declare function getModelsCatalog(): Promise<ModelsCatalog>;
/**
 * Resolve a catalog selection to Nexus model config (provider + id + baseUrl).
 * Selection is from getModelsCatalog().recommended or .providers[].models.
 */
declare function catalogSelectionToModel(providerId: string, modelId: string, catalog: ModelsCatalog): {
    provider: string;
    id: string;
    baseUrl: string;
};

interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    content: string;
}
interface DiffFile {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    hunks: DiffHunk[];
    oldPath?: string;
}
interface DiffResult {
    files: DiffFile[];
    raw: string;
}

/**
 * Review module — builds code review prompts from git diff (Kilocode 1:1).
 * Runs git in the given cwd and returns a full prompt for the agent.
 */

/**
 * Build review prompt for uncommitted changes only (staged + unstaged).
 * Kilocode 1:1 — same prompt and behaviour.
 */
declare function buildReviewPromptUncommitted(cwd: string): Promise<string>;
/**
 * Build review prompt for branch diff vs base branch.
 * Kilocode 1:1 — same prompt and behaviour.
 */
declare function buildReviewPromptBranch(cwd: string): Promise<string>;

declare const SESSION_PROTOCOL_SERVICE_PORT_VERSION: 1;
interface WorkspaceOwnedService {
    shutdown?(): void | Promise<void>;
    close?(): void | Promise<void>;
    dispose?(): void | Promise<void>;
}
interface SessionProtocolService extends WorkspaceOwnedService {
    readonly portVersion: typeof SESSION_PROTOCOL_SERVICE_PORT_VERSION;
    /**
     * Dispatch must be backed by a durable idempotency ledger: the command
     * fingerprint, state mutation, and typed receipt commit atomically.
     */
    dispatch(command: SessionCommandV2): Awaitable<SessionCommandReceipt>;
    snapshot(sessionId: string): Awaitable<SessionProtocolSnapshot>;
    events(input: {
        readonly sessionId: string;
        readonly afterSequence: number;
        readonly signal?: AbortSignal;
    }): AsyncIterable<ProtocolEnvelope>;
    /**
     * Atomically tombstone an idle session before the portable JSONL transcript
     * is removed. Implementations reject deletion while accepted work exists.
     */
    deleteSession?(sessionId: string): Awaitable<{
        readonly deleted: boolean;
    }>;
}
interface WorkspaceRuntimeServices {
    sessions?: WorkspaceOwnedService;
    protocol?: SessionProtocolService;
    parallelAgents?: WorkspaceOwnedService;
    mcp?: WorkspaceOwnedService;
    plugins?: WorkspaceOwnedService;
    memory?: WorkspaceOwnedService;
    index?: WorkspaceOwnedService;
    state?: WorkspaceOwnedService;
    [name: string]: unknown;
}
interface WorkspaceRuntime {
    readonly canonicalDirectory: string;
    readonly services: Readonly<WorkspaceRuntimeServices>;
    readonly closed: boolean;
    close(): Promise<void>;
}
interface WorkspaceRuntimeFactory {
    create(canonicalDirectory: string): Promise<WorkspaceRuntime>;
}
interface WorkspaceRuntimeHandle {
    readonly canonicalDirectory: string;
    readonly runtime: WorkspaceRuntime;
    readonly released: boolean;
    release(): Promise<void>;
}
type Awaitable<T> = T | PromiseLike<T>;
type SessionPhase = "idle" | "preparing" | "streaming" | "waiting_approval" | "executing_tools" | "compacting" | "settling" | "failed" | "interrupted";
type SessionMode = "agent" | "plan" | "ask" | "debug" | "review";
interface ModelSelectionSnapshot {
    readonly profileId: string;
    readonly selectionEpoch: number;
}
interface TurnExecutionSnapshot {
    readonly mode: SessionMode;
    readonly selection?: ModelSelectionSnapshot;
}
type SessionInputPart = {
    type: "text";
    text: string;
} | {
    type: "image";
    mimeType: string;
    data: string;
} | {
    type: "mention";
    name: string;
    path: string;
} | {
    type: "skill";
    name: string;
};
interface AdmittedSessionInput {
    id: string;
    /**
     * Durable turn and run identities allocated atomically during admission.
     * They are intentionally distinct from the idempotent input/command
     * identity and must be reused if this input is retried or requeued.
     */
    reservedTurnId: string;
    reservedRunId: string;
    sessionId: string;
    delivery: "steer" | "queue";
    parts: readonly SessionInputPart[];
    execution: TurnExecutionSnapshot;
    admittedSequence: number;
    promotedSequence?: number;
    expectedTurnId?: string;
}
interface TurnEpochSnapshot {
    readonly configEpoch: number;
    readonly contextEpoch: number;
}
interface SessionOwnershipFence {
    readonly ownerId: string;
    readonly leaseEpoch: number;
}
interface DurableSessionTurn {
    readonly turnId: string;
    readonly runId: string;
    readonly input: AdmittedSessionInput;
    readonly phase: SessionPhase;
    readonly epochs: TurnEpochSnapshot;
    readonly execution: TurnExecutionSnapshot;
    /**
     * Proof from durable storage that a previously persisted next-turn policy
     * intentionally replaced only the admitted mode at claim time.
     */
    readonly modeOverride?: {
        readonly requestedByTurnId: string;
    };
    readonly fence: SessionOwnershipFence;
}
interface PendingSessionApprovalSnapshot {
    readonly approvalId: string;
    readonly turnId: string;
    readonly toolName: string;
    readonly redactedSummary: string;
}
interface SessionRuntimeSnapshot {
    readonly sessionId: string;
    readonly phase: SessionPhase;
    readonly activeTurn?: DurableSessionTurn;
    readonly pendingApprovals: readonly PendingSessionApprovalSnapshot[];
    readonly pendingQueue: readonly AdmittedSessionInput[];
    readonly pendingSteers: readonly AdmittedSessionInput[];
}
interface AdmitSessionInputCommand {
    readonly inputId: string;
    readonly delivery: "steer" | "queue";
    readonly parts: readonly SessionInputPart[];
    readonly execution: TurnExecutionSnapshot;
    readonly expectedTurnId?: string;
}
interface StartTurnCommand {
    readonly inputId: string;
    readonly parts: readonly SessionInputPart[];
    readonly mode: SessionMode;
    readonly selection?: ModelSelectionSnapshot;
}
interface SteerTurnCommand {
    readonly inputId: string;
    readonly expectedTurnId: string;
    readonly parts: readonly SessionInputPart[];
}
interface QueueTurnCommand {
    readonly inputId: string;
    readonly parts: readonly SessionInputPart[];
    readonly mode: SessionMode;
    readonly selection?: ModelSelectionSnapshot;
}
interface InterruptTurnCommand {
    readonly expectedTurnId: string;
    readonly reason?: string;
}
interface ResolveApprovalCommand {
    readonly approvalId: string;
    readonly expectedTurnId: string;
    readonly status: "approved" | "denied";
}
type TurnRunnerResult = {
    readonly status: "completed";
} | {
    readonly status: "failed";
    readonly error: string;
} | {
    readonly status: "interrupted";
    readonly error?: string;
};
interface FinishTurnCommit {
    /**
     * Steers accepted after the runner's final safe boundary. Storage atomically
     * converts them into queued turns instead of dropping accepted user input.
     */
    readonly requeuedInputs: readonly AdmittedSessionInput[];
}
interface TurnRunnerContext {
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly input: AdmittedSessionInput;
    readonly epochs: TurnEpochSnapshot;
    readonly execution: TurnExecutionSnapshot;
    readonly fence: SessionOwnershipFence;
    readonly signal: AbortSignal;
    readonly setPhase: (phase: SessionPhase) => Promise<void>;
    readonly safeBoundary: () => Promise<readonly AdmittedSessionInput[]>;
}
interface TurnRunner {
    run(context: TurnRunnerContext): Awaitable<TurnRunnerResult>;
}
declare const SESSION_COORDINATOR_STORAGE_PORT_VERSION: 1;
interface SessionCoordinatorStorage {
    readonly portVersion: typeof SESSION_COORDINATOR_STORAGE_PORT_VERSION;
    admitInput(input: {
        readonly inputId: string;
        readonly sessionId: string;
        readonly fence: SessionOwnershipFence;
        readonly delivery: "steer" | "queue";
        readonly expectedTurnId?: string;
        readonly parts: readonly SessionInputPart[];
        readonly execution: TurnExecutionSnapshot;
    }): Awaitable<AdmittedSessionInput>;
    pendingSteers(sessionId: string, turnId: string): Awaitable<readonly AdmittedSessionInput[]>;
    promoteSteers(sessionId: string, turnId: string, cutoff: number, fence: SessionOwnershipFence): Awaitable<readonly AdmittedSessionInput[]>;
    /**
     * Atomically promotes the oldest queued input and persists its turn snapshot.
     * Returning undefined means the queue is empty or another owner has a turn.
     */
    claimNextTurn(input: {
        readonly sessionId: string;
        readonly epochs: TurnEpochSnapshot;
        readonly fence: SessionOwnershipFence;
    }): Awaitable<DurableSessionTurn | undefined>;
    setPhase(input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly phase: SessionPhase;
        readonly fence: SessionOwnershipFence;
    }): Awaitable<void>;
    requestInterrupt(input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly reason?: string;
        readonly fence: SessionOwnershipFence;
    }): Awaitable<void>;
    finishTurn(input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly result: TurnRunnerResult;
        readonly fence: SessionOwnershipFence;
    }): Awaitable<FinishTurnCommit>;
    /**
     * Fenced hard-stop used only after bounded cooperative drain expires.
     * Late runner callbacks must be rejected by turn/fence checks.
     */
    forceInterrupt(input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly reason: string;
        readonly fence: SessionOwnershipFence;
    }): Awaitable<FinishTurnCommit>;
    resolveApproval(input: {
        readonly sessionId: string;
        readonly approvalId: string;
        readonly expectedTurnId: string;
        readonly status: "approved" | "denied";
        readonly fence: SessionOwnershipFence;
    }): Awaitable<void>;
    /**
     * Reads the durable decision after a commit-unknown resolveApproval call.
     * Absence means the mutation definitely did not commit and is safe to retry.
     */
    approvalResolution(input: {
        readonly sessionId: string;
        readonly approvalId: string;
    }): Awaitable<{
        readonly expectedTurnId: string;
        readonly status: "approved" | "denied";
    } | undefined>;
    snapshot(sessionId: string): Awaitable<SessionRuntimeSnapshot>;
    /**
     * Atomically reconciles ambiguous persisted execution under the current
     * fenced owner. Implementations must never replay uncertain side effects.
     */
    recoverSession(input: {
        readonly sessionId: string;
        readonly fence: SessionOwnershipFence;
    }): Awaitable<{
        readonly snapshot: SessionRuntimeSnapshot;
        readonly interruptedTurn?: {
            readonly turnId: string;
            readonly runId: string;
            readonly result: Extract<TurnRunnerResult, {
                status: "interrupted";
            }>;
            readonly requeuedInputs: readonly AdmittedSessionInput[];
        };
    }>;
}
type CoordinatorEvent = {
    readonly type: "input_admitted";
    readonly sessionId: string;
    readonly inputId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly delivery: "steer" | "queue";
    readonly expectedTurnId?: string;
    readonly admittedSequence: number;
    readonly execution: TurnExecutionSnapshot;
} | {
    readonly type: "turn_started";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly epochs: TurnEpochSnapshot;
    readonly execution: TurnExecutionSnapshot;
} | {
    readonly type: "phase_changed";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly phase: SessionPhase;
} | {
    readonly type: "steering_promoted";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly inputIds: readonly string[];
} | {
    readonly type: "steering_requeued";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly inputIds: readonly string[];
} | {
    readonly type: "interrupt_requested";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly reason?: string;
} | {
    readonly type: "approval_resolved";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly approvalId: string;
    readonly status: "approved" | "denied";
} | {
    readonly type: "turn_finished";
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly status: TurnRunnerResult["status"];
    readonly error?: string;
};
interface SessionCoordinatorOptions {
    readonly sessionId: string;
    readonly ownership: {
        readonly fence: SessionOwnershipFence;
    };
    readonly storage: SessionCoordinatorStorage;
    readonly runner: TurnRunner;
    readonly epochs: {
        capture(): Awaitable<TurnEpochSnapshot>;
    };
    /**
     * Best-effort wake/notification channel only. Storage must persist all
     * replay-relevant state and envelopes in the mutation transaction.
     */
    readonly events?: {
        publish(event: CoordinatorEvent): Awaitable<void>;
        /**
         * Notification failures are diagnostic only. Durable state and runner
         * progress must not depend on a connected UI/event subscriber.
         */
        onError?(error: unknown, event: CoordinatorEvent): Awaitable<void>;
    };
    readonly approvals?: {
        deliver(command: {
            readonly sessionId: string;
            readonly expectedTurnId: string;
            readonly approvalId: string;
            readonly status: "approved" | "denied";
        }): Awaitable<void>;
        onError?(error: unknown, command: {
            readonly sessionId: string;
            readonly expectedTurnId: string;
            readonly approvalId: string;
            readonly status: "approved" | "denied";
        }): Awaitable<void>;
    };
    /** Maximum diagnostic wait for the best-effort approval wake channel. */
    readonly approvalDeliveryTimeoutMs?: number;
    /** Maximum cooperative abort drain before a fenced hard-stop. */
    readonly shutdownTimeoutMs?: number;
}
interface TurnHandle {
    readonly turnId: string;
    readonly runId: string;
    /** True only when this command launched the runner rather than joining a queue. */
    readonly started: boolean;
    readonly settled: Promise<TurnRunnerResult>;
}

declare class ManagedWorkspaceRuntime implements WorkspaceRuntime {
    #private;
    readonly canonicalDirectory: string;
    readonly services: Readonly<WorkspaceRuntimeServices>;
    constructor(canonicalDirectory: string, services: WorkspaceRuntimeServices);
    get closed(): boolean;
    close(): Promise<void>;
}

declare class WorkspaceRuntimeRegistry {
    #private;
    constructor(factory: WorkspaceRuntimeFactory);
    acquire(directory: string): Promise<WorkspaceRuntimeHandle>;
    peek(directory: string): WorkspaceRuntime | undefined;
    close(directory: string): Promise<boolean>;
    closeAll(): Promise<void>;
}

/**
 * Resolve one optional turn dependency without silently changing the
 * capability set. A deadline or loader failure is always surfaced to the
 * owning UI/transport before the explicit fallback is returned.
 */
declare function settleRuntimeDependency<T>(label: string, work: Promise<T>, timeoutMs: number, fallback: T, onDiagnostic: (message: string) => void): Promise<T>;

type CoordinatorErrorCode = "closed" | "no_active_turn" | "turn_conflict" | "execution_conflict" | "invalid_phase";
declare class SessionCoordinatorError extends Error {
    readonly code: CoordinatorErrorCode;
    constructor(code: CoordinatorErrorCode, message: string);
}
interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}
interface ActiveTurn {
    readonly turn: DurableSessionTurn;
    readonly abortController: AbortController;
    readonly settlement: Deferred<TurnRunnerResult>;
    phase: SessionPhase;
}
interface ApprovalDelivery {
    readonly sessionId: string;
    readonly expectedTurnId: string;
    readonly approvalId: string;
    readonly status: "approved" | "denied";
}

declare abstract class SessionCoordinatorBase {
    protected readonly sessionId: string;
    protected readonly fence: SessionOwnershipFence;
    protected readonly storage: SessionCoordinatorOptions["storage"];
    protected readonly runner: SessionCoordinatorOptions["runner"];
    protected readonly epochs: SessionCoordinatorOptions["epochs"];
    protected readonly events: SessionCoordinatorOptions["events"];
    protected readonly approvals: SessionCoordinatorOptions["approvals"];
    protected readonly approvalDeliveryTimeoutMs: number;
    protected readonly shutdownTimeoutMs: number;
    protected readonly settlements: Map<string, Deferred<TurnRunnerResult>>;
    protected readonly completedResults: Map<string, TurnRunnerResult>;
    protected readonly completedOrder: string[];
    protected readonly reservedTurnOwners: Map<string, string>;
    protected readonly reservedRunOwners: Map<string, string>;
    protected readonly reservedIdentitiesByInput: Map<string, readonly [string, string]>;
    protected tail: Promise<void>;
    protected active: ActiveTurn | undefined;
    protected identityError: SessionCoordinatorError | undefined;
    protected recovered: boolean;
    protected closing: boolean;
    protected closed: boolean;
    protected closePromise: Promise<void> | undefined;
    constructor(options: SessionCoordinatorOptions);
    protected enqueue<T>(operation: () => Promise<T> | T): Promise<T>;
    protected assertAccepting(): void;
    protected ensureRecoveredLocked(): Promise<void>;
    protected recoverLocked(): Promise<SessionRuntimeSnapshot>;
    protected admitLocked(command: AdmitSessionInputCommand): Promise<AdmittedSessionInput>;
    protected requireActive(expectedTurnId?: string): ActiveTurn;
    protected settlementFor(turnId: string): Deferred<TurnRunnerResult>;
    protected registerSnapshotIdentities(snapshot: SessionRuntimeSnapshot): void;
    protected registerReservedIdentity(input: AdmittedSessionInput): void;
    protected rememberCompleted(turnId: string, result: TurnRunnerResult): void;
    protected reconcileAmbiguousActiveLocked(active: ActiveTurn, cause: unknown, intendedResult: TurnRunnerResult, operation: string): Promise<SessionRuntimeSnapshot>;
    protected drainOrForce(settlement: Promise<TurnRunnerResult>, timeoutReason: string): Promise<TurnRunnerResult>;
    protected startNextLocked(retryAfterReconciliation?: boolean): Promise<DurableSessionTurn | undefined>;
    protected launch(active: ActiveTurn): void;
    protected reconcilePipelineFailureLocked(active: ActiveTurn, cause: unknown, intendedResult: TurnRunnerResult | undefined): Promise<void>;
    protected setPhaseLocked(turnId: string, phase: SessionPhase): Promise<void>;
    protected safeBoundaryLocked(turnId: string): Promise<readonly AdmittedSessionInput[]>;
    protected settleLocked(turnId: string, result: TurnRunnerResult): Promise<void>;
    protected publishRequeued(turnId: string, runId: string, commit: FinishTurnCommit): void;
    protected publish(event: CoordinatorEvent): void;
    protected deliverApproval(command: ApprovalDelivery): void;
    protected reportApprovalError(error: unknown, command: ApprovalDelivery): void;
    protected reportPublishError(error: unknown, event: CoordinatorEvent): void;
}

declare class SessionCoordinator extends SessionCoordinatorBase {
    admit(command: AdmitSessionInputCommand): Promise<AdmittedSessionInput>;
    start(command: StartTurnCommand): Promise<TurnHandle>;
    steer(command: SteerTurnCommand): Promise<AdmittedSessionInput>;
    queue(command: QueueTurnCommand): Promise<AdmittedSessionInput>;
    interrupt(command: InterruptTurnCommand): Promise<boolean>;
    approve(command: ResolveApprovalCommand): Promise<void>;
    snapshot(): Promise<SessionRuntimeSnapshot>;
    recover(): Promise<SessionRuntimeSnapshot>;
    /**
     * Stop all in-memory activity after the durable ownership fence is lost.
     *
     * This path deliberately performs no storage mutation: only a replacement
     * owner may reconcile the ambiguous durable turn. Late runner completion is
     * ignored because the active handle is detached before abort is signalled.
     */
    abandon(cause: unknown): Promise<void>;
    close(): Promise<void>;
}

interface PersistedTurnCursor {
    turnId: string;
    runId: string;
    afterSequence: number;
}
/**
 * Select the durable event cursor for reattaching an already-running turn.
 * Missing, stale, corrupt, and future cursors replay the active turn from its
 * first available event instead of skipping to the snapshot high-water mark.
 */
declare function selectActiveTurnResumeCursor(snapshot: SessionProtocolSnapshot, stored: PersistedTurnCursor | undefined): number;

interface CheckpointTrackerOptions {
    /** Isolated Nexus home for embedded hosts/tests. */
    homeDir?: string;
}
/**
 * Read-only shadow history for checkpoint previews.
 * - Shadow repo lives in ~/.nexus/checkpoints/{cwdHash}/.git
 * - core.worktree points to the workspace; no file copy — worktree is the workspace.
 * - Workspace restoration is intentionally delegated to durable ChangeSet
 *   ownership; this tracker never cleans or resets a user worktree.
 */
declare class CheckpointTracker {
    private readonly taskId;
    private readonly workspaceRoot;
    private readonly options;
    private git;
    /** Directory containing .git (shadow repo root). */
    private readonly shadowDir;
    private readonly cwdHash;
    private initialized;
    private entries;
    private operationQueue;
    constructor(taskId: string, workspaceRoot: string, options?: CheckpointTrackerOptions);
    private getGit;
    private enqueue;
    /**
     * Initialize the shadow git repository with worktree = workspaceRoot.
     * Returns false if validation fails, git unavailable, or timeout.
     */
    init(timeoutMs?: number): Promise<boolean>;
    private initInternal;
    /**
     * Stage preview files without ever touching nested repository metadata.
     * Nested repositories are excluded as complete roots; old shadow indexes
     * are migrated by removing those paths from the index only.
     */
    private addCheckpointFiles;
    private refreshCheckpointExcludes;
    commit(description?: string): Promise<string>;
    /**
     * Commit a checkpoint associated with a specific user message.
     * Used by rollback-to-message flow in extension/CLI.
     */
    commitForMessage(messageId: string, description?: string): Promise<string>;
    private commitInternal;
    /** Blanket shadow-Git restore is permanently disabled. */
    resetHead(_hash: string): Promise<never>;
    getDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]>;
    getEntries(): CheckpointEntry[];
}

interface CheckpointStorageOptions {
    /** Embedded-host/test override; defaults to `~/.nexus`. */
    homeDir?: string;
}
/**
 * Persist checkpoint entries for a session (CLI use: after run or on each commit).
 * Stored under ~/.nexus/sessions/{cwdHash}/checkpoints.json keyed by sessionId.
 */
declare function writeCheckpointEntries(cwd: string, sessionId: string, entries: CheckpointEntry[], options?: CheckpointStorageOptions): Promise<void>;
/**
 * Load checkpoint entries for a session.
 */
declare function readCheckpointEntries(cwd: string, sessionId: string, options?: CheckpointStorageOptions): Promise<CheckpointEntry[]>;

declare function createSanitizedGitEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
declare class GitCommandExecutionError extends Error {
    readonly kind: GitCommandFailureKind;
    readonly result: GitCommandResult;
    constructor(kind: GitCommandFailureKind, message: string, result: GitCommandResult, options?: ErrorOptions);
}
interface GitCommandRunnerOptions {
    executable?: string;
    environment?: NodeJS.ProcessEnv;
    defaultLimits?: Partial<GitCommandLimits>;
}
/**
 * Workspace-bound, argv-only Git process boundary.
 *
 * Operation-specific callers still select read-only subcommands and pass
 * helper-disabling flags such as --no-ext-diff and --no-textconv.
 */
declare class GitCommandRunner implements GitCommandRunnerPort {
    #private;
    constructor(cwd: string, options?: GitCommandRunnerOptions);
    run(args: readonly string[], limitOverrides?: Partial<GitCommandLimits>): Promise<GitCommandResult>;
}

declare const DEFAULT_GIT_DIFF_LIMITS: GitDiffLimits;
declare function collectGitDiff(input: {
    runner: GitCommandRunnerPort;
    status: GitStatusSnapshot;
    request: GitDiffRequest;
    limits: GitDiffLimits;
}): Promise<GitDiffResult>;

declare class GitStatusParseError extends Error {
    constructor(message: string);
}
declare function parseGitStatusV2(output: Uint8Array): ParsedGitStatus;

export { type AdmitSessionInputCommand, type AdmittedSessionInput, type AgentDefinition, type AgentEvent, type AgentExecutionIdentity, type AppliedReplacementSnippet, type ApprovalAction, type AtomicWriteOptions, type AttachSessionTurnOptions, type AuthorizedNetworkRequest, BROWSER_TOOLS, type BackgroundProcessRecord, BackgroundProcessSupervisor, type BackgroundTaskRecord, type CapturedFileState, type CatalogModel, type CatalogProvider, type ChangeFileRecord, type ChangeHunk, type ChangeIdentity, type ChangeOmission, type ChangeProposalAfterState, type ChangeProposalFile, ChangeSetApprovalError, type ChangeSetBatchConflict, type ChangeSetBatchRevertResult, type ChangeSetBlobPruneResult, ChangeSetConflictError, type ChangeSetFailure, type ChangeSetFilePort, type ChangeSetListQuery, type ChangeSetRecord, ChangeSetService, type ChangeSetServiceOptions, type ChangeSetState, ChangeSetStorageCorruptionError, type ChangeSetStore, ChangeSetStoreConflictError, type ChangedFile, type CheckpointEntry, type CheckpointStorageOptions, CheckpointTracker, CodebaseIndexer, type CodebaseIndexerHostOptions, type CompactionProjectionResult, ConfigFileError, ConfigSubstitutionError, ConfigValidationError, type ContextUsageSnapshot, type CoordinatorEvent, type CreateChangeProposal, type CredentialIdentity, type CredentialPurpose, type CustomToolTrustEvaluation, type CustomToolTrustGrant, type CustomToolTrustReason, CustomToolTrustStore, CustomToolTrustStoreError, type CustomToolTrustStoreOptions, DEFAULT_BATCH_PROCESSING_CONCURRENCY, DEFAULT_EXECUTABLE_TREE_LIMITS, DEFAULT_GIT_DIFF_LIMITS, DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_MAX_INDEXED_FILES, DEFAULT_MAX_PENDING_EMBED_BATCHES, DEFAULT_PLUGIN_FINGERPRINT_LIMITS, type DeferredToolDef, type DeleteSessionOptions, type DiagnosticItem, type DiffFile, type DiffHunk, type DiffResult, DurableRunEventSink, type DurableRunEventSinkOptions, type DurableRunRecord, type DurableSessionTurn, type EmbeddingClient, type EmbeddingConfig, type ExecutableTreeLimits, type ExecutableTreeSnapshot, FileChangeSetStore, type FileChangeSetStoreOptions, type FileLockOptions, FileLockTimeoutError, FileMutationConflictError, FileRemoteTurnRecoveryStore, type FileRemoteTurnRecoveryStoreOptions, type FileStateRef, type FinalizeConfigCredentialsOptions, type FinishTurnCommit, GitCommandExecutionError, type GitCommandFailureKind, type GitCommandLimits, type GitCommandResult, GitCommandRunner, type GitCommandRunnerOptions, type GitCommandRunnerPort, type GitDiffLimits, type GitDiffRequest, type GitDiffResult, type GitDiffScope, type GitFileDiff, type GitIgnoredStatusEntry, type GitIndexStatus, type GitOmission, type GitOperation, type GitOrdinaryStatusEntry, type GitRenameStatusEntry, GitService, type GitServiceOptions, type GitStatusEntry, GitStatusParseError, type GitStatusSnapshot, type GitSubmoduleStatus, type GitUnmergedStatusEntry, type GitUntrackedStatusEntry, type HostFileMutation, type HostFileMutationNext, type HostNetworkRequest, type HostPathAccess, type HostReadFileOptions, type IHost, type IIndexer, INDEX_FILE_WATCHER_DEBOUNCE_MS, type ISession, type IndexSearchOptions, type IndexSearchResult, type IndexStatus, type IndexerFactoryOptions, type InterruptTurnCommand, InterruptTurnCommandSchema, type JsonRecoveryResult, type LLMClient, LegacyAgentEventSchema, type LegacyMemoryImportResult, type LegacyMemoryRecord, type ListIndexAbsolutePathsFn, type LoadedSlashCommand, type LspCallRecord, type LspLocation, type LspOperation, type LspPosition, type LspQueryRequest, type LspQueryResult, type LspRange, type LspSymbolRecord, MAX_AGENT_EVENT_JSON_CHARS, MAX_IMAGES_PER_INPUT, MAX_IMAGE_BASE64_CHARS, MAX_INPUT_PARTS, MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_IDENTIFIER_CHARS, MAX_MEMORY_RELATION_IDS, MAX_MEMORY_SOURCE_URI_CHARS, MAX_MEMORY_TITLE_CHARS, MAX_MODEL_TOOL_NAME_CHARS, MAX_REMOTE_MCP_PROMPT_ARGUMENTS, MAX_REMOTE_MCP_PROMPT_ARGUMENT_VALUE_CHARS, MAX_REMOTE_MCP_PROMPT_CATALOG_CHARS, MAX_REMOTE_MCP_PROMPT_COMMANDS, MAX_USER_INPUT_TEXT_CHARS, MEMORY_SCHEMA_VERSION, MODES, MODE_TOOL_GROUPS, ManagedWorkspaceRuntime, type McpAuthRequest, type McpAuthResult, type McpAuthorizedFetchOptions, McpClient, type McpClientOptions, type McpConnectionState, type McpNodeRequestFactory, type McpPinnedNodeHopOptions, type McpPromptArgument, type McpPromptContent, type McpPromptMessage, type McpPromptRef, type McpPromptResult, type McpRemoteAuthorizationRequest, type McpRemoteFetchHop, type McpRemoteFetchHopRequest, type McpRemoteRequestAuthorizer, type McpResourceClient, type McpResourceContent, type McpResourceRef, type McpResourceTemplateRef, type McpServerConfig, McpServerConfigSchema, type McpServerStatus, type McpTool, type McpTransportFactoryOptions, type MemoryRecord, type MemoryRetrievalOptions, type MemoryRetrievalResult, MemoryValueLimitError, type MessagePart, type Mode, type ModeChangeResult, type ModeConfig, ModeSchema, ModelSelectionSchema, type ModelSelectionSnapshot, type ModelsCatalog, NEXUS_CUSTOM_OPTION_ID, NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX, NEXUS_SECRETS_STORAGE_KEY, NEXUS_SERVER_TOKEN_SECRET_KEY, NetworkPolicyError, type NetworkPolicyErrorCode, type NetworkPolicyOptions, NetworkRequestError, type NetworkRequestErrorCode, type NetworkRequestOptions, type NetworkRequestPurpose, type NetworkResolver, type NetworkResourceResponse, type NetworkTransport, type NetworkTransportRequest, type NetworkTransportResponse, type NexusConfig, NexusConfigSchema, type NexusRunServices, type NexusSecretsPayload, type NexusSecretsStore, NexusServerClient, type NexusServerClientOptions, OrchestrationCorruptionError, type OrchestrationDiagnostic, type OrchestrationDiagnosticCode, OrchestrationInvariantError, OrchestrationRuntime, type OrchestrationRuntimeOptions, PROJECT_AUTHORITY_REQUEST_KINDS, PROTOCOL_VERSION, ParallelAgentManager, type ParseSessionCommandResult, type ParsedGitStatus, type PendingProjectAuthorityRequest, type PendingProjectMcpServer, type PendingRunApproval, type PendingSessionApproval, PendingSessionApprovalSchema, type PendingSessionApprovalSnapshot, type PermissionResult, type PersistSecretsOptions, type PersistedToolOutputProtection, type PersistedTurnCursor, type PluginCapabilityDiagnostic, type PluginDiagnostic, type PluginDiscoveryResult, type PluginFingerprintLimits, type PluginManifestRecord, type PluginMcpCapabilityResult, type PluginTrustEvaluation, type PluginTrustGrant, type PluginTrustReason, PluginTrustStoreCorruptionError, type PluginTrustStoreOptions, type PreparedSessionTurnIdentity, PreparedSessionTurnIdentitySchema, ProfileCredentialCollisionError, type ProfileCredentialRemoval, type ProjectAuthorityPayloadByKind, type ProjectAuthorityRequestKind, ProjectRegistry, type ProjectSettings, type ProtocolEnvelope, ProtocolEnvelopeSchema, type ProtocolError, ProtocolErrorCodeSchema, ProtocolErrorSchema, ProtocolPayloadSchema, ProtocolPersistenceSchema, type ProviderConfig, type ProviderName, type QuestionOptionRow, type QueueTurnCommand, QueueTurnCommandSchema, READ_ONLY_TOOLS, type RegistrationResult, type RemoteChangeReviewEntry, type RemoteChangeReviewSnapshot, type RemoteMcpPromptArgument, RemoteMcpPromptArgumentSchema, type RemoteMcpPromptCatalog, RemoteMcpPromptCatalogSchema, type RemoteMcpPromptCommand, RemoteMcpPromptCommandSchema, type RemoteMcpPromptResolveRequest, RemoteMcpPromptResolveRequestSchema, type RemoteMcpPromptResolveResponse, RemoteMcpPromptResolveResponseSchema, type RemotePreparedTurnRecord, RemotePreparedTurnRecordSchema, type RemoteSessionRecord, type RemoteTurnCursorRecord, type RemoteTurnRecoveryStore, type ResolveApprovalCommand, ResolveApprovalCommandSchema, type ResolveBundledOptions, type ResolvedCredential, type ResolvedNetworkAddress, type ResolvedSkillBody, type RetrievedMemory, type RunEventDiagnostic, type RunEventEnvelope, RunEventStore, type RunEventStoreOptions, type RunSessionTurnOptions, type RunStatus, type RunToolArtifact, SESSION_COORDINATOR_STORAGE_PORT_VERSION, SESSION_PROTOCOL_SERVICE_PORT_VERSION, type SanitizedMemoryValue, type SaveSessionOptions, SecretsCorruptionError, type SecretsCorruptionReason, type SecretsRemoval, Session, type SessionApprovalIdentity, type SessionCommandReceipt, SessionCommandReceiptSchema, SessionCommandSchema, type SessionCommandV2, SessionConflictError, SessionCoordinator, SessionCoordinatorError, type SessionCoordinatorOptions, type SessionCoordinatorStorage, SessionCorruptionError, type SessionInputPart, type SessionMessage, type SessionMode, type SessionOwnershipFence, type SessionPhase, SessionProtocolError, type SessionProtocolService, type SessionProtocolSnapshot, SessionProtocolSnapshotSchema, type SessionRecoverySnapshot, type SessionRuntimeSnapshot, type SessionStorageDiagnostic, type SessionStorageDiagnosticCode, SessionStore, type SessionStoreOptions, type SessionTurnIdentity, SessionTurnTerminalError, type SkillAuthority, type SkillDef, type SkillLoadDiagnostic, type SkillLoadDiagnosticCode, type SkillLoadOptions, SkillNameAmbiguityError, type SkillToolDescriptionRow, type SlashCommandResolution, type StartTurnCommand, StartTurnCommandSchema, type SteerTurnCommand, SteerTurnCommandSchema, StorageCorruptionError, type StorageDiagnostic, type StorageDiagnosticCode, type StoredContextUsage, type StoredSession, type StoredSessionMeta, type SubAgentRuntimeContext, type SymbolKind, TOOL_GROUP_MEMBERS, type TaskKind, type TaskRecord, type TaskStatus, type TeamRecord, type TextPart, type ToolContext, type ToolContributionDiagnostic, type ToolContributionDiagnosticCode, type ToolContributionSnapshot, type ToolDef, type ToolExecutionEnvironment, type ToolExecutionIdentity, type ToolExecutionOrigin, type ToolExecutionOutcome, type ToolExecutionRequest, type ToolIntegrationProvenance, type ToolOutputMaintenanceOptions, type ToolOutputMaintenanceResult, type ToolPart, ToolRegistry, type ToolResult, type ToolSpillRegistryEntry, type TurnEpochSnapshot, type TurnExecutionSnapshot, TurnExecutionSnapshotSchema, type TurnHandle, type TurnRunner, type TurnRunnerContext, type TurnRunnerResult, UnsafeConfigWriteError, UnsafeCustomToolSourceError, UnsafePluginContentError, UnsafeSessionIdError, UnsupportedSecretsVersionError, UserInputPartSchema, type UserInputPartV2, type UserQuestionAnswer, type UserQuestionItem, type UserQuestionOption, type UserQuestionRequest, WORKSPACE_AUTHORITY_STORE_VERSION, type WorkingDirectoryChangeResult, type WorkspaceAuthorityGrant, type WorkspaceAuthorityGrants, type WorkspaceAuthorityIdentity, type WorkspaceAuthorityRecord, WorkspaceAuthorityStoreError, type WorkspaceAuthorityStoreErrorCode, type WorkspaceAuthorityStoreOptions, type WorkspaceOwnedService, WorkspacePathAuthorizationError, type WorkspacePathAuthorizationErrorCode, type WorkspaceProjectAuthorityApproval, type WorkspaceRuntime, type WorkspaceRuntimeFactory, type WorkspaceRuntimeHandle, WorkspaceRuntimeRegistry, type WorkspaceRuntimeServices, type WorkspaceTaskHandle, WorkspaceTaskSupervisor, WorkspaceToolContributionManager, WorkspaceToolContributionManagerClosedError, type WorkspaceToolContributionManagerOptions, type WorktreeSession, appendCompactionSnippetToSessionMemory, applyPluginRuntimeSettings, applySecretsToConfig, applyWorkspaceAuthorityGrants, approvalGrantKey, approveWorkspaceProjectAuthority, assertAgentExecutionIdentity, assertChangeSetTransition, assertMemoryWriteInput, atomicWriteFile, atomicWriteJson, authorizeNetworkRequest, buildDurableChangeHunks, buildIndexWatcherGlobPattern, buildMcpToolSchema, buildRemoteMcpPromptCatalog, buildReviewPromptBranch, buildReviewPromptUncommitted, buildSkillToolDynamicDescription, buildSystemPrompt, callableMcpToolName, canonParallelInnerRecipient, canonicalProjectRoot, canonicalizeCredentialDestination, canonicalizeNexusServerBaseUrl, catalogSelectionToModel, clearToolSpillsForSession, closeNexusRunServices, collectGitDiff, compactSessionAndPersist, computeContextUsageMetrics, createAgentRunSnapshotTool, createCodebaseIndexer, createCompaction, createEmbeddingClient, createFileSecretsStore, createLLMClient, createListAgentRunsTool, createMcpAuthorizedFetch, createMcpPinnedLookup, createMcpResourceTools, createMcpTransport, createNexusRunServices, createNodePinnedMcpFetchHop, createPendingProjectAuthorityRequest, createResumeAgentTool, createSanitizedGitEnvironment, createSpawnAgentOutputTool, createSpawnAgentStopTool, createSpawnAgentTool, createSpawnAgentsAliasTool, createSpawnAgentsParallelTool, createTaskCreateBatchTool, createTaskResumeTool, createTaskSnapshotTool, credentialIdentityKey, delegatedAgentDescriptionFromParallelInnerParams, delegatedAgentExecutionIdentity, deleteSession, deriveSessionTitle, discoverPluginManifests, effectiveUrlTransport, ensureGlobalConfigDir, ensureQdrantRunning, ensureTeamMemberForTask, estimateActiveContextSessionTokens, estimateTokens, estimateToolsDefinitionsTokens, evaluatePluginTrust, exactChangeHunkDiffStats, exactLineDiffStats, executeToolPipeline, extractMemoriesFromCompactionSummary, fetchSkillUrlRegistryRoots, finalizeConfigCredentials, fingerprintExecutableTree, fingerprintProjectAuthorityPayload, formatQuestionnaireAnswersForAgent, generateSessionId, getAllBuiltinTools, getBuiltinToolsForMode, getClaudeCompatibilityOptions, getConfigEnvironment, getContextWindowLimit, getDefaultAutoMemoryDir, getEmbeddingCredentialIdentity, getFileLockPath, getGlobalConfigDir, getIndexDir, getIndexableExtensions, getModelsCatalog, getModelsPath, getModelsUrl, getNexusDataDir, getNexusServerTokenSecretKey, getOrchestrationRuntime, getParallelDelegatedAgentTaskDescriptions, getPendingProjectAuthorityRequests, getPendingProjectMcpServers, getPlanContentForFollowup, getPluginTrustStorePath, getProjectHash, getProviderCredentialIdentity, getRunLogsDir, getRuntimeDir, getSecretsPayloadFromConfig, getSessionMemoryFilePath, getSessionMeta, getSessionStorageDiagnostics, getToolOutputDir, getToolOutputSpill, getTreeSitterLanguageWasmsDir, getWebTreeSitterWasmPath, getWorkspaceAuthorityIdentity, getWorkspaceAuthorityStorePath, grantPluginTrust, grantWorkspaceAuthority, hadPlanExit, handleCompletedTaskSideEffects, hashChangeProposal, hashFileContent, hashWorkspaceIdentity, hydrateWorkspaceAuthority, importLegacyMemoryFiles, inheritSpillRegistryForMergedToolPart, interpretShellCommandResult, isDelegatedAgentParentTool, isDelegatedAgentParentToolEndClear, isLoopbackNexusServerDestination, isPublicNetworkAddress, isPureSubagentParallelInput, isValidPendingProjectAuthorityRequest, listPluginTrustGrants, listSessions, listToolSpillsForSession, listWorkspaceAuthorities, loadAgentDefinitions, loadAgentInstructionBundle, loadAutoMemoryMarkdown, loadConfig, loadGlobalSettings, loadPluginManifests, loadPluginMcpServers, loadPluginRuntimeRecords, loadProjectSettings, loadRules, loadSession, loadSessionMessages, loadSkillToolCatalogRows, loadSkills, loadSlashCommands, loadTeamMemoryMarkdown, loadTrustedPluginRuntimeRecords, loadWorkspaceAuthority, mcpPromptCommandName, mcpPromptOpaqueId, mergeEmbeddingConfigSafely, mergeModelPresetSelection, mergeNexusConfigLayers, mergeProviderConfigPartialSafely, mergeProviderConfigSafely, mutateSession, nodePinnedTransport, normalizeAwsRegion, normalizeAzureResourceName, normalizeChangePath, normalizeMemoryRecord, normalizedAppliedReplacementsFromMetadata, parallelInnerUseIsDelegatedAgent, parseGitStatusV2, parseMentions, parseSessionCommand, patchGlobalConfig, patchProjectConfig, persistSecretsFromConfig, projectPersistedCompactionSummary, readCheckpointEntries, readJsonWithRecovery, readSessionMemoryFile, reapplyRevertedChangeSets, redactMemorySecrets, refreshSessionMemoryFile, registerInheritedRunTools, registerToolContributionSnapshot, registerToolOutputSpill, renderMcpPromptResult, renderSlashCommandPrompt, requestNetworkResource, resolveAuthorizedWorkspacePath, resolveAutoMemoryDirectory, resolveBundledMcpServers, resolveConfiguredAndPluginMcpServers, resolveEmbeddingCredential, resolvePluginDeclaredPath, resolveProviderCredential, resolveSkillBody, resolveSlashCommand, restrictDelegatedMode, retrieveMemories, revertEffectiveChangeSetsAfter, revokePluginTrust, revokeWorkspaceAuthority, revokeWorkspaceProjectAuthority, runAgentLoop, runAutoMemoryDreamIfDue, runPluginHooks, runScopedHooks, sameChangeIdentity, sampleSkillSiblingFiles, sanitizeMemoryValue, saveSession, scheduleSessionMemoryRefresh, scheduleToolOutputMaintenance, selectActiveTurnResumeCursor, selectProviderProfile, setIndexTelemetrySink, settleRuntimeDependency, stripProfileSecrets, stripSecretsFromConfig, testMcpServers, tokenizeMemoryText, toolExecutionIdentity, validatePluginManifestFile, withFileLock, writeCheckpointEntries, writeConfig, writeGlobalProfiles, writeGlobalSettings, writeProjectSettings };
