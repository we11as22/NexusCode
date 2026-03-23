import { z } from 'zod';
import { LanguageModelV1 } from 'ai';

declare function getNexusDataDir(): string;
declare function getToolOutputDir(): string;
declare function getRunLogsDir(): string;

declare const NexusConfigSchema: z.ZodObject<{
    model: z.ZodDefault<z.ZodObject<{
        provider: z.ZodEnum<["anthropic", "openai", "google", "ollama", "openai-compatible", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "minimax"]>;
        id: z.ZodString;
        apiKey: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        /** Reasoning effort hint for reasoning-capable models. "auto" (default) enables thinking only for known reasoning models. */
        reasoningEffort: z.ZodDefault<z.ZodString>;
        /** Optional explicit context window size override (tokens). */
        contextWindow: z.ZodOptional<z.ZodNumber>;
        resourceName: z.ZodOptional<z.ZodString>;
        deploymentId: z.ZodOptional<z.ZodString>;
        apiVersion: z.ZodOptional<z.ZodString>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
        id: string;
        reasoningEffort: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
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
        provider: "openai" | "google" | "ollama" | "openai-compatible" | "bedrock" | "mistral" | "openrouter" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    }, {
        provider: "openai" | "google" | "ollama" | "openai-compatible" | "bedrock" | "mistral" | "openrouter" | "local";
        model: string;
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
    }, "strip", z.ZodTypeAny, {
        url: string;
        enabled: boolean;
        collection: string;
        autoStart: boolean;
    }, {
        url?: string | undefined;
        enabled?: boolean | undefined;
        collection?: string | undefined;
        autoStart?: boolean | undefined;
    }>>;
    modes: z.ZodDefault<z.ZodObject<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, "strip", z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }>>, z.objectOutputType<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }>>, "strip">, z.objectInputType<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }>>, "strip">>>;
    indexing: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        excludePatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        symbolExtract: z.ZodDefault<z.ZodBoolean>;
        /** Disabled by default. Set to true with vectorDb.enabled to use semantic codebase_search. */
        vector: z.ZodDefault<z.ZodBoolean>;
        batchSize: z.ZodDefault<z.ZodNumber>;
        embeddingBatchSize: z.ZodDefault<z.ZodNumber>;
        embeddingConcurrency: z.ZodDefault<z.ZodNumber>;
        debounceMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        excludePatterns: string[];
        symbolExtract: boolean;
        vector: boolean;
        batchSize: number;
        embeddingBatchSize: number;
        embeddingConcurrency: number;
        debounceMs: number;
    }, {
        enabled?: boolean | undefined;
        excludePatterns?: string[] | undefined;
        symbolExtract?: boolean | undefined;
        vector?: boolean | undefined;
        batchSize?: number | undefined;
        embeddingBatchSize?: number | undefined;
        embeddingConcurrency?: number | undefined;
        debounceMs?: number | undefined;
    }>>;
    permissions: z.ZodDefault<z.ZodObject<{
        autoApproveRead: z.ZodDefault<z.ZodBoolean>;
        autoApproveWrite: z.ZodDefault<z.ZodBoolean>;
        autoApproveCommand: z.ZodDefault<z.ZodBoolean>;
        autoApproveMcp: z.ZodDefault<z.ZodBoolean>;
        autoApproveBrowser: z.ZodDefault<z.ZodBoolean>;
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
            tool: z.ZodOptional<z.ZodString>;
            pathPattern: z.ZodOptional<z.ZodString>;
            commandPattern: z.ZodOptional<z.ZodString>;
            action: z.ZodEnum<["allow", "deny", "ask"]>;
            reason: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            action: "ask" | "allow" | "deny";
            tool?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
            reason?: string | undefined;
        }, {
            action: "ask" | "allow" | "deny";
            tool?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
            reason?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveMcp: boolean;
        autoApproveBrowser: boolean;
        autoApproveReadPatterns: string[];
        allowedCommands: string[];
        allowCommandPatterns: string[];
        allowedMcpTools: string[];
        denyCommandPatterns: string[];
        askCommandPatterns: string[];
        denyPatterns: string[];
        rules: {
            action: "ask" | "allow" | "deny";
            tool?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
            reason?: string | undefined;
        }[];
    }, {
        autoApproveRead?: boolean | undefined;
        autoApproveWrite?: boolean | undefined;
        autoApproveCommand?: boolean | undefined;
        autoApproveMcp?: boolean | undefined;
        autoApproveBrowser?: boolean | undefined;
        autoApproveReadPatterns?: string[] | undefined;
        allowedCommands?: string[] | undefined;
        allowCommandPatterns?: string[] | undefined;
        allowedMcpTools?: string[] | undefined;
        denyCommandPatterns?: string[] | undefined;
        askCommandPatterns?: string[] | undefined;
        denyPatterns?: string[] | undefined;
        rules?: {
            action: "ask" | "allow" | "deny";
            tool?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
            reason?: string | undefined;
        }[] | undefined;
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
        servers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            url: z.ZodOptional<z.ZodString>;
            transport: z.ZodOptional<z.ZodEnum<["stdio", "http", "sse"]>>;
            enabled: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            /** Bundled server id (e.g. "context-mode"); resolved by host to command/args/env */
            bundle: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            enabled: boolean;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            bundle?: string | undefined;
        }, {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            bundle?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        servers: {
            name: string;
            enabled: boolean;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            bundle?: string | undefined;
        }[];
    }, {
        servers?: {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            bundle?: string | undefined;
        }[] | undefined;
    }>>;
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
    tools: z.ZodDefault<z.ZodObject<{
        custom: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** When true, use LLM to filter which MCP servers to use when server count > classifyThreshold. Default off. */
        classifyToolsEnabled: z.ZodDefault<z.ZodBoolean>;
        /** Threshold: when MCP server count exceeds this, classifier selects which servers to use. Default 20. */
        classifyThreshold: z.ZodDefault<z.ZodNumber>;
        parallelReads: z.ZodDefault<z.ZodBoolean>;
        maxParallelReads: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        custom: string[];
        classifyToolsEnabled: boolean;
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
    }, {
        custom?: string[] | undefined;
        classifyToolsEnabled?: boolean | undefined;
        classifyThreshold?: number | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
    }>>;
    /** When true, use LLM to filter skills by task when count > skillClassifyThreshold. Default off. */
    skillClassifyEnabled: z.ZodDefault<z.ZodBoolean>;
    /** Threshold for skill classification. Default 20. */
    skillClassifyThreshold: z.ZodDefault<z.ZodNumber>;
    structuredOutput: z.ZodDefault<z.ZodEnum<["auto", "always", "never"]>>;
    summarization: z.ZodDefault<z.ZodObject<{
        auto: z.ZodDefault<z.ZodBoolean>;
        threshold: z.ZodDefault<z.ZodNumber>;
        keepRecentMessages: z.ZodDefault<z.ZodNumber>;
        model: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        auto: boolean;
        model: string;
        threshold: number;
        keepRecentMessages: number;
    }, {
        auto?: boolean | undefined;
        model?: string | undefined;
        threshold?: number | undefined;
        keepRecentMessages?: number | undefined;
    }>>;
    parallelAgents: z.ZodDefault<z.ZodObject<{
        maxParallel: z.ZodDefault<z.ZodNumber>;
        /** Deprecated: old SpawnAgents multi-task setting. Parallel sub-agent batching now uses Parallel + SpawnAgent calls. */
        maxTasksPerCall: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxParallel: number;
        maxTasksPerCall: number;
    }, {
        maxParallel?: number | undefined;
        maxTasksPerCall?: number | undefined;
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
    profiles: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodOptional<z.ZodEnum<["anthropic", "openai", "google", "ollama", "openai-compatible", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "minimax"]>>;
        id: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        temperature: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        reasoningEffort: z.ZodOptional<z.ZodDefault<z.ZodString>>;
        contextWindow: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        resourceName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        deploymentId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        apiVersion: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        extra: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, "strip", z.ZodTypeAny, {
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    model: {
        provider: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
        id: string;
        reasoningEffort: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    };
    mcp: {
        servers: {
            name: string;
            enabled: boolean;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            bundle?: string | undefined;
        }[];
    };
    modes: {
        agent?: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        plan?: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        ask?: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        debug?: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        review?: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        } | undefined;
    } & {
        [k: string]: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
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
        debounceMs: number;
    };
    rules: {
        files: string[];
    };
    permissions: {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveMcp: boolean;
        autoApproveBrowser: boolean;
        autoApproveReadPatterns: string[];
        allowedCommands: string[];
        allowCommandPatterns: string[];
        allowedMcpTools: string[];
        denyCommandPatterns: string[];
        askCommandPatterns: string[];
        denyPatterns: string[];
        rules: {
            action: "ask" | "allow" | "deny";
            tool?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
            reason?: string | undefined;
        }[];
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
    skills: (string | {
        path: string;
        enabled?: boolean | undefined;
    })[];
    tools: {
        custom: string[];
        classifyToolsEnabled: boolean;
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
    };
    skillClassifyEnabled: boolean;
    skillClassifyThreshold: number;
    structuredOutput: "never" | "auto" | "always";
    summarization: {
        auto: boolean;
        model: string;
        threshold: number;
        keepRecentMessages: number;
    };
    parallelAgents: {
        maxParallel: number;
        maxTasksPerCall: number;
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
    profiles: Record<string, {
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>;
    embeddings?: {
        provider: "openai" | "google" | "ollama" | "openai-compatible" | "bedrock" | "mistral" | "openrouter" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    } | undefined;
    vectorDb?: {
        url: string;
        enabled: boolean;
        collection: string;
        autoStart: boolean;
    } | undefined;
}, {
    model?: {
        provider: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    } | undefined;
    mcp?: {
        servers?: {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            enabled?: boolean | undefined;
            bundle?: string | undefined;
        }[] | undefined;
    } | undefined;
    embeddings?: {
        provider: "openai" | "google" | "ollama" | "openai-compatible" | "bedrock" | "mistral" | "openrouter" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
        region?: string | undefined;
    } | undefined;
    vectorDb?: {
        url?: string | undefined;
        enabled?: boolean | undefined;
        collection?: string | undefined;
        autoStart?: boolean | undefined;
    } | undefined;
    modes?: z.objectInputType<{
        agent: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        plan: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        ask: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        debug: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
        review: z.ZodOptional<z.ZodObject<{
            autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            customInstructions: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }, {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        }>>;
    }, z.ZodOptional<z.ZodObject<{
        autoApprove: z.ZodOptional<z.ZodArray<z.ZodEnum<["read", "write", "execute", "mcp", "browser", "search"]>, "many">>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        customInstructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
        customInstructions?: string | undefined;
    }, {
        autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
        systemPrompt?: string | undefined;
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
        debounceMs?: number | undefined;
    } | undefined;
    rules?: {
        files?: string[] | undefined;
    } | undefined;
    permissions?: {
        autoApproveRead?: boolean | undefined;
        autoApproveWrite?: boolean | undefined;
        autoApproveCommand?: boolean | undefined;
        autoApproveMcp?: boolean | undefined;
        autoApproveBrowser?: boolean | undefined;
        autoApproveReadPatterns?: string[] | undefined;
        allowedCommands?: string[] | undefined;
        allowCommandPatterns?: string[] | undefined;
        allowedMcpTools?: string[] | undefined;
        denyCommandPatterns?: string[] | undefined;
        askCommandPatterns?: string[] | undefined;
        denyPatterns?: string[] | undefined;
        rules?: {
            action: "ask" | "allow" | "deny";
            tool?: string | undefined;
            pathPattern?: string | undefined;
            commandPattern?: string | undefined;
            reason?: string | undefined;
        }[] | undefined;
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
    skills?: (string | {
        path: string;
        enabled?: boolean | undefined;
    })[] | undefined;
    tools?: {
        custom?: string[] | undefined;
        classifyToolsEnabled?: boolean | undefined;
        classifyThreshold?: number | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
    } | undefined;
    skillClassifyEnabled?: boolean | undefined;
    skillClassifyThreshold?: number | undefined;
    structuredOutput?: "never" | "auto" | "always" | undefined;
    summarization?: {
        auto?: boolean | undefined;
        model?: string | undefined;
        threshold?: number | undefined;
        keepRecentMessages?: number | undefined;
    } | undefined;
    parallelAgents?: {
        maxParallel?: number | undefined;
        maxTasksPerCall?: number | undefined;
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
    profiles?: Record<string, {
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }> | undefined;
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
interface ToolDef<TArgs = Record<string, unknown>> {
    name: string;
    description: string;
    parameters: z.ZodType<TArgs>;
    /** If true, can be executed in parallel with other read-only tools */
    readOnly?: boolean;
    /** Which modes this tool is available in. undefined = all modes */
    modes?: Mode[];
    /** If true, always show approval dialog */
    requiresApproval?: boolean;
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
interface ToolContext {
    cwd: string;
    host: IHost;
    session: ISession;
    config: NexusConfig;
    /** Current loop mode (agent / plan / ask). Used e.g. by SpawnAgent to set sub-agent permissions. */
    mode?: Mode;
    indexer?: IIndexer;
    signal: AbortSignal;
    /** Optional: trigger context compaction (condense/summarize_task tools). */
    compactSession?: () => Promise<void>;
    /** Current tool call part id (e.g. part_xyz). Set by loop for write/replace so tool can emit tool_approval_needed. */
    partId?: string;
    /** All resolved tools for this run (set by loop). Used e.g. by Parallel to run multiple tools in one call. */
    resolvedTools?: ToolDef[];
}
interface ApprovalAction {
    type: "write" | "execute" | "mcp" | "browser" | "read" | "doom_loop";
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
}
interface UserQuestionItem {
    id: string;
    question: string;
    options: UserQuestionOption[];
    allowCustom?: boolean;
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
    optionId?: string;
    optionLabel?: string;
    customText?: string;
}
interface IHost {
    readonly cwd: string;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    showDiff(path: string, before: string, after: string): Promise<boolean>;
    runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    showApprovalDialog(action: ApprovalAction): Promise<PermissionResult>;
    emit(event: AgentEvent): void;
    /** Persist command to .nexus/allowed-commands.json for this cwd so it is not asked for approval again */
    addAllowedCommand?(cwd: string, command: string): Promise<void>;
    /** Persist command pattern to .nexus/settings.local.json permissions.allow so matching commands are not asked again (e.g. "npm run:*"). */
    addAllowedPattern?(cwd: string, pattern: string): Promise<void>;
    /** Persist MCP tool name to project allow list so it is not asked again (e.g. "codex - codex"). */
    addAllowedMcpTool?(cwd: string, toolName: string): Promise<void>;
    resolveAtMention?(mention: string): Promise<string | null>;
    getProblems?(): Promise<DiagnosticItem[]>;
    /** Restore workspace to a checkpoint (Cline-style). Optional if host has no checkpoint. */
    restoreCheckpoint?(hash: string): Promise<void>;
    /** List checkpoint entries for UI. */
    getCheckpointEntries?(): Promise<CheckpointEntry[]>;
    /** Get diff between two checkpoints for preview. */
    getCheckpointDiff?(fromHash: string, toHash?: string): Promise<ChangedFile[]>;
    /** Called by the loop after a checkpoint is committed so the host can push updated entries to the UI. */
    notifyCheckpointEntriesUpdated?(): void;
    /**
     * Roo/Cline-style file edit flow: open → [approval] → save or revert.
     * openFileEdit: open diff view (extension) or store pending edit (CLI). Do not write to disk yet.
     * saveFileEdit: commit current pending edit to disk.
     * revertFileEdit: discard pending edit; for new files do not create, for existing restore original (if view was opened).
     */
    openFileEdit?(path: string, options: {
        originalContent: string;
        newContent: string;
        isNewFile: boolean;
    }): Promise<void>;
    saveFileEdit?(path: string): Promise<void>;
    revertFileEdit?(path: string): Promise<void>;
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
    load(): Promise<void>;
}
type SessionRole = "user" | "assistant" | "system" | "tool";
interface SessionMessage {
    id: string;
    ts: number;
    role: SessionRole;
    content: string | MessagePart[];
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
interface ToolPart {
    type: "tool";
    id: string;
    tool: string;
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    timeStart?: number;
    timeEnd?: number;
    /** If true, output has been pruned for compaction */
    compacted?: boolean;
    /** Set when tool is Write/Edit and completed; used for session diff (e.g. CLI "N files" block). */
    path?: string;
    diffStats?: {
        added: number;
        removed: number;
    };
}
type MessagePart = TextPart | ToolPart | ReasoningPart | ImagePart;
interface IIndexer {
    search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
    status(): IndexStatus;
    refreshFile?(filePath: string): Promise<void>;
    refreshFileNow?(filePath: string): Promise<void>;
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
    state: "indexing";
    progress: number;
    total: number;
    chunksProcessed?: number;
    chunksTotal?: number;
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
    metadata?: Record<string, unknown>;
} | {
    type: "subagent_start";
    subagentId: string;
    mode: Mode;
    task: string;
    parentPartId?: string;
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
        debounceMs: number;
    };
    permissions: {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveMcp?: boolean;
        autoApproveBrowser?: boolean;
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
        /** Fine-grained permission rules evaluated in order, first match wins */
        rules: PermissionRule[];
    };
    retry: RetryConfig;
    checkpoint: {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
        /** When true, first completion attempt (agent) is rejected; model must re-verify and complete again (Cline-style). */
        doubleCheckCompletion?: boolean;
    };
    /** UI preferences (e.g. chat pane). */
    ui?: {
        /** When true, streamed text_delta is shown in chat as muted/small; when false, only tool-written text is shown. */
        showReasoningInChat?: boolean;
    };
    mcp: {
        servers: McpServerConfig[];
    };
    /** Normalized list for UI: path + enabled. skills is derived (enabled only). */
    skillsConfig?: Array<{
        path: string;
        enabled: boolean;
    }>;
    skills: string[];
    tools: {
        custom: string[];
        classifyToolsEnabled: boolean;
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
    };
    skillClassifyEnabled: boolean;
    skillClassifyThreshold: number;
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
    };
    /** Optional overrides for agent loop limits (tool budget and max iterations per mode). */
    agentLoop?: {
        toolCallBudget?: Partial<Record<Mode, number>>;
        maxIterations?: Partial<Record<Mode, number>>;
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
    url?: string;
    transport?: "stdio" | "http" | "sse";
    enabled?: boolean;
    /** Resolve to a bundled MCP server (e.g. "context-mode") when nexusRoot is set by host */
    bundle?: string;
}
interface SkillDef {
    name: string;
    path: string;
    /** First non-empty line as summary */
    summary: string;
    content: string;
}
interface CheckpointEntry {
    hash: string;
    ts: number;
    messageId: string;
    description?: string;
}
interface ChangedFile {
    path: string;
    before: string;
    after: string;
    status: "added" | "modified" | "deleted";
}

/**
 * Secrets store abstraction (Roo-Code / Cline best practice).
 * API keys are never written to YAML; they are stored in a secure store and
 * applied at load time after env overrides.
 */
/** Key used in secrets store (VS Code secretStorage or file) for API keys payload. */
declare const NEXUS_SECRETS_STORAGE_KEY = "nexuscode_api";
interface NexusSecretsPayload {
    model?: string;
    embeddings?: string;
    /** API keys per profile name (global profiles in ~/.nexus/nexus.yaml). */
    profiles?: Record<string, string>;
}
interface NexusSecretsStore {
    getSecret(key: string): Promise<string | undefined>;
    setSecret(key: string, value: string): Promise<void>;
}
/**
 * Apply secrets from store into config (in-place).
 * Only sets model.apiKey, embeddings.apiKey, and profiles[name].apiKey if not already set (env/config takes precedence).
 */
declare function applySecretsToConfig(config: Record<string, unknown>, store: NexusSecretsStore): Promise<void>;
/**
 * Strip secret fields from config for persisting to YAML (never write apiKey to repo).
 * Returns a deep copy with model.apiKey, embeddings.apiKey, and each profiles[name].apiKey removed.
 */
declare function stripSecretsFromConfig<T extends Record<string, unknown>>(config: T): T;
/**
 * Strip apiKey from each profile for writing to global YAML (~/.nexus/nexus.yaml).
 * Call before writeGlobalProfiles so profile keys are never persisted in plain text.
 */
declare function stripProfileSecrets(profiles: Record<string, unknown>): Record<string, unknown>;
/**
 * Build payload from current config (model.apiKey, embeddings.apiKey, profile apiKeys) for persisting to secrets store.
 */
declare function getSecretsPayloadFromConfig(config: Record<string, unknown>): NexusSecretsPayload;
/**
 * Persist model and embeddings API keys from config into the secrets store.
 * Call after merging user config; then persist config with stripSecretsFromConfig.
 */
declare function persistSecretsFromConfig(config: Record<string, unknown>, store: NexusSecretsStore): Promise<void>;
/**
 * File-based secrets store for CLI (Cline-style: single file with mode 0o600).
 * Path: {globalConfigDir}/secrets.json
 */
declare function createFileSecretsStore(globalConfigDir: string): NexusSecretsStore;

/**
 * Load config by walking up from cwd.
 * Merges project config over global config.
 * Applies env overrides, then optional secrets store (API keys).
 */
declare function loadConfig(cwd?: string, options?: {
    secrets?: NexusSecretsStore;
}): Promise<NexusConfig>;
/**
 * Write config to project .nexus/nexus.yaml.
 * By default strips API keys so they are never persisted to YAML (use secrets store instead).
 */
declare function writeConfig(config: Partial<NexusConfig>, cwd?: string, options?: {
    stripSecrets?: boolean;
}): void;
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
declare function loadGlobalSettings(): ProjectSettings;
/**
 * Load .nexus/settings.json and .nexus/settings.local.json (local overrides), merge with global settings.
 * Layer order: global base → global local → project base → project local (later overrides earlier).
 */
declare function loadProjectSettings(cwd: string): ProjectSettings;
/**
 * Write project settings to .nexus/settings.json.
 */
declare function writeProjectSettings(cwd: string, settings: ProjectSettings): void;
/**
 * Write global settings to ~/.nexus/settings.json.
 */
declare function writeGlobalSettings(settings: ProjectSettings): void;

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
}
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
 * Session storage using JSONL format (like Pi).
 * Each line is a JSON entry with { id, parentId, role, content, ts, metadata }.
 * Sessions are stored per project in ~/.nexus/sessions/{project-hash}/
 *
 * All callers should use the same logical project root: CLI, VS Code, and server
 * resolve paths here so one bucket is used per workspace (symlinks, trailing
 * slashes, and Windows drive casing are normalized when possible).
 */
declare function canonicalProjectRoot(cwd: string): string;
/** Last UI context bar snapshot (session + system + tools overhead) from agent loop; optional for older files. */
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
    /** Global todo list for the chat (persisted with session) */
    todo?: string;
    /** Persisted so CLI/extension can show the same ctx bar after resume without re-running the agent. */
    contextUsage?: StoredContextUsage;
    messages: SessionMessage[];
}
interface StoredSessionMeta {
    id: string;
    cwd: string;
    ts: number;
    title?: string;
    todo?: string;
    messageCount: number;
}
declare function saveSession(session: StoredSession): Promise<void>;
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
}>>;
declare function deleteSession(sessionId: string, cwd: string): Promise<boolean>;
declare function generateSessionId(): string;

/** Derive session title from first user message (Cline-style). */
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
    constructor(id: string, cwd: string, messages?: SessionMessage[], initialTodo?: string, ephemeral?: boolean, contextUsageSnapshot?: StoredContextUsage | null);
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
    /** Rewind chat to timestamp (Cline/Roo-Code style). Keeps only messages with ts <= timestamp. */
    rewindToTimestamp(timestamp: number): void;
    /** Rewind so that only messages strictly before this timestamp remain (used for rollback before a given message). */
    rewindBeforeTimestamp(timestamp: number): void;
    /** Rewind so that only messages strictly before a specific message remain. */
    rewindBeforeMessageId(messageId: string): void;
    save(): Promise<void>;
    load(): Promise<void>;
    static create(cwd: string): Session;
    /** Create a session that is never saved to disk (for sub-agents). */
    static createEphemeral(cwd: string): Session;
    static resume(sessionId: string, cwd: string): Promise<Session | null>;
    static resumeWindow(sessionId: string, cwd: string, limit: number, offset: number): Promise<Session | null>;
    static getMeta(sessionId: string, cwd: string): Promise<StoredSessionMeta | null>;
}

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

interface SessionCompaction {
    prune(session: ISession): void;
    compact(session: ISession, client: LLMClient, signal?: AbortSignal): Promise<void>;
    isOverflow(tokenCount: number, contextLimit: number, threshold: number): boolean;
}
declare function createCompaction(): SessionCompaction;

interface NexusServerClientOptions {
    baseUrl: string;
    directory: string;
}
/**
 * Client for NexusCode server — list/create sessions, get messages, stream agent events.
 * Shared by extension and CLI when serverUrl is set.
 */
declare class NexusServerClient {
    private baseUrl;
    private directory;
    constructor(opts: NexusServerClientOptions);
    private headers;
    private url;
    listSessions(): Promise<Array<{
        id: string;
        ts: number;
        title?: string;
        messageCount: number;
    }>>;
    createSession(): Promise<{
        id: string;
        cwd: string;
        ts: number;
        messageCount: number;
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
    }>;
    deleteSession(sessionId: string): Promise<boolean>;
    /**
     * Send message and stream AgentEvents as NDJSON. Yields each event (heartbeat lines are skipped).
     * Malformed lines yield an error event. Throws on fetch error.
     */
    streamMessage(sessionId: string, content: string, mode: Mode, signal?: AbortSignal): AsyncGenerator<AgentEvent>;
}
/** If no event (including heartbeat) received for this long, consider stream dead. */
declare const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20000;

interface AgentLoopOptions {
    session: ISession;
    client: LLMClient;
    host: IHost;
    config: NexusConfig;
    mode: Mode;
    tools: ToolDef[];
    skills: SkillDef[];
    rulesContent: string;
    indexer?: IIndexer;
    compaction: SessionCompaction;
    signal: AbortSignal;
    gitBranch?: string;
    /** When set, commit on completion of an agent turn and optionally double-check (Cline-style). */
    checkpoint?: {
        commit(description?: string): Promise<string>;
    };
    /** When true, inject create-skill instructions; host must allow writes to .nexus/skills and .cursor/skills */
    createSkillMode?: boolean;
}
/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
declare function runAgentLoop(opts: AgentLoopOptions): Promise<void>;

type ToolGroup = "read" | "write" | "execute" | "search" | "mcp" | "skills" | "agents" | "always" | "context" | "plan_exit";
/**
 * Core built-in tool groups per mode.
 * Access control is enforced in the backend (getBuiltinToolsForMode + getBlockedToolsForMode in loop);
 * prompts only describe behaviour — they do not grant or revoke tool access.
 */
declare const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]>;
/**
 * Built-in tool names per group.
 * Tools in "always" group are available in every mode.
 */
declare const TOOL_GROUP_MEMBERS: Record<ToolGroup, string[]>;
/**
 * Read-only tools that can be parallelized safely.
 */
declare const READ_ONLY_TOOLS: Set<string>;
/**
 * Get all built-in tool names available for a given mode.
 */
declare function getBuiltinToolsForMode(mode: Mode): string[];

/**
 * Classify which MCP/custom tools are relevant for the given task (legacy; prefer classifyMcpServers).
 * Returns the selected tool names. Built-in mode tools are NOT filtered here.
 */
declare function classifyTools(tools: ToolDef[], taskDescription: string, client: LLMClient): Promise<string[]>;
/**
 * Classify which skills are relevant for the given task.
 * Returns selected skill names.
 */
declare function classifySkills(skills: SkillDef[], taskDescription: string, client: LLMClient): Promise<SkillDef[]>;

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
    /** Active background bash jobs (bash_id, status, log path). */
    backgroundJobsSummary?: string;
    /** Short project layout (top-level dirs and key files) at start */
    initialProjectContext?: string;
    /** Context window usage (shown at start of system info so model sees token budget) */
    contextUsedTokens?: number;
    contextLimitTokens?: number;
    contextPercent?: number;
    /** When true, inject create-skill instructions and allow writes to skill dirs */
    createSkillMode?: boolean;
    /** Capability flag from provider; reserved for future prompt branching. */
    supportsStructuredOutput?: boolean;
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

interface SubAgentResult {
    subagentId: string;
    sessionId: string;
    success: boolean;
    output: string;
    error?: string;
}
type SubAgentStatus = "running" | "completed" | "error";
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
    private history;
    private static readonly HISTORY_CAP;
    /** Recent spawn task keys (normalized) to prevent infinite restart / duplicate spawns (Cline-style guard). */
    private recentSpawnTasks;
    private static readonly RECENT_SPAWN_CAP;
    private static readonly TASK_KEY_LEN;
    private rememberId;
    private startTask;
    spawn(description: string, mode: Mode | undefined, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, contextSummary?: string, parentPartId?: string): Promise<SubAgentResult>;
    spawnInBackground(description: string, mode: Mode, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, contextSummary?: string, parentPartId?: string): Promise<{
        subagentId: string;
    }>;
    getSnapshot(subagentId: string): SubAgentSnapshot | null;
    waitFor(subagentId: string): Promise<SubAgentSnapshot | null>;
    stop(subagentId: string): boolean;
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
declare function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef;
declare function createSpawnAgentOutputTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnOutputSchema>>;
declare function createSpawnAgentStopTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnStopSchema>>;
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

/**
 * Tool registry — manages built-in, MCP, and custom tools.
 * Built-in tools are never overwritten by MCP/custom registration (same name = keep built-in).
 */
declare class ToolRegistry {
    private tools;
    private static readonly BUILTIN_NAMES;
    constructor();
    register(tool: ToolDef): void;
    getAll(): ToolDef[];
    get(name: string): ToolDef | undefined;
    getByNames(names: string[]): ToolDef[];
    /**
     * Get tools for a given mode.
     * Built-in tools for the mode are always included.
     * Additional MCP/custom tools are returned separately for optional classification.
     */
    getForMode(mode: Mode): {
        builtin: ToolDef[];
        dynamic: ToolDef[];
    };
    /**
     * Load custom tools from JS/TS files.
     * Custom tools export a default ToolDef or array of ToolDef.
     */
    loadFromDirectory(dir: string): Promise<void>;
}

declare function getAllBuiltinTools(): ToolDef[];

/** Synthetic option id for the host-added “Other / custom” row (never send from the model). */
declare const NEXUS_CUSTOM_OPTION_ID = "__nexus_other__";
/** First line of user messages created after submitting a questionnaire (hosts may use for compact UI). */
declare const NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX = "[nexus:questionnaire-response]\n";
declare function formatQuestionnaireAnswersForAgent(request: UserQuestionRequest, answers: UserQuestionAnswer[]): string;

/**
 * Codebase indexer: vector-only (Qdrant).
 * When vector client is missing, indexing is no-op and search returns [].
 */
declare class CodebaseIndexer implements IIndexer {
    private readonly projectRoot;
    private readonly config;
    private fileTracker;
    private vector?;
    private forceVectorBackfill;
    private _status;
    private indexing;
    private abortController?;
    private debounceTimers;
    private statusListeners;
    constructor(projectRoot: string, config: NexusConfig, embeddingClient?: EmbeddingClient, vectorUrl?: string, projectHash?: string);
    status(): IndexStatus;
    onStatusChange(listener: (status: IndexStatus) => void): () => void;
    private notifyStatus;
    startIndexing(): Promise<void>;
    private indexInBackground;
    private extractEntries;
    private processPreparedBatch;
    private processBatch;
    refreshFile(filePath: string): Promise<void>;
    refreshFileNow(filePath: string): Promise<void>;
    search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
    reindex(): Promise<void>;
    /** Clear index (vector + file tracker) without reindexing. */
    deleteIndex(): Promise<void>;
    stop(): void;
    close(): void;
}

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

interface IndexerFactoryOptions {
    onWarning?: (message: string) => void;
    /** Progress messages during Qdrant startup and indexer creation (e.g. for UI or terminal). */
    onProgress?: (message: string) => void;
    /** Max ms to wait for Qdrant when vector is enabled (e.g. 2500 for fast first message). Omit for default 20s. */
    maxQdrantWaitMs?: number;
}
/**
 * Creates a CodebaseIndexer with optional vector search (Qdrant).
 * When vector prerequisites are missing, returns indexer without vector (no semantic search; agent works without codebase_search).
 */
declare function createCodebaseIndexer(projectRoot: string, config: NexusConfig, options?: IndexerFactoryOptions): Promise<CodebaseIndexer>;

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

/**
 * Load rules from CLAUDE.md, AGENTS.md, .nexus/rules/** etc.
 * Walks up from cwd to find all applicable rule files.
 */
declare function loadRules(cwd: string, rulePatterns: string[]): Promise<string>;

/**
 * Token estimation utilities.
 * Approximation: ~4 chars per token (standard heuristic).
 */
declare function estimateTokens(text: string): number;

/** Same cap as buildMessagesFromSession in loop.ts — large tool results are truncated in the request. */
declare const MAX_TOOL_OUTPUT_CHARS_CONTEXT_ESTIMATE = 16000;
/**
 * Model context window limit: config override or known defaults by model id substring.
 */
declare function getContextWindowLimit(modelId: string, configuredLimit?: number): number;
/**
 * Token estimate for messages that count toward the next model request (active context only).
 * Includes reasoning and images; tool outputs capped like the LLM message builder.
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

/**
 * Load skills from configured paths and standard locations.
 *
 * Config paths can be:
 *  - A directory path like ".nexus/skills/my-skill" → loads SKILL.md + subdirectory context
 *  - A glob pattern like ".nexus/skills/**\/*.md"
 *  - A direct file path like ".nexus/skills/my-skill/SKILL.md"
 *
 * Standard locations are also auto-searched.
 */
declare function loadSkills(skillPaths: string[], cwd: string): Promise<SkillDef[]>;

/**
 * MCP client that connects to MCP servers and exposes their tools.
 */
declare class McpClient {
    private clients;
    private tools;
    connect(config: McpServerConfig): Promise<void>;
    connectAll(configs: McpServerConfig[]): Promise<void>;
    /** Test each server and return status (ok or error message). Does not keep connections. */
    testServers(configs: McpServerConfig[]): Promise<Array<{
        name: string;
        status: "ok" | "error";
        error?: string;
    }>>;
    getTools(): ToolDef[];
    getStatus(): Record<string, "connected" | "disconnected">;
    disconnectAll(): Promise<void>;
}
declare function setMcpClientInstance(client: McpClient): void;
/** Standalone test of MCP server configs (does not keep connections). */
declare function testMcpServers(configs: McpServerConfig[]): Promise<Array<{
    name: string;
    status: "ok" | "error";
    error?: string;
}>>;

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
 * (command, args, env with CLAUDE_PROJECT_DIR). Skips the entry if nexusRoot
 * is missing or start.mjs is not present.
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

/**
 * Shadow git repository for checkpoints (Cline/Roo-Code style).
 * - Shadow repo lives in ~/.nexus/checkpoints/{cwdHash}/.git
 * - core.worktree points to the workspace; no file copy — worktree is the workspace.
 * - saveCheckpoint = stage + commit in shadow; restore = git clean -fd + git reset --hard hash.
 */
declare class CheckpointTracker {
    private readonly taskId;
    private readonly workspaceRoot;
    private git;
    /** Directory containing .git (shadow repo root). */
    private readonly shadowDir;
    private readonly cwdHash;
    private initialized;
    private entries;
    private operationQueue;
    constructor(taskId: string, workspaceRoot: string);
    private getGit;
    private enqueue;
    /**
     * Initialize the shadow git repository with worktree = workspaceRoot.
     * Returns false if validation fails, git unavailable, or timeout.
     */
    init(timeoutMs?: number): Promise<boolean>;
    private initInternal;
    /** Stage files in worktree; temporarily renames nested .git dirs so git doesn't treat them as submodules (Cline-style). */
    private addCheckpointFiles;
    private renameNestedGitRepos;
    commit(description?: string): Promise<string>;
    /**
     * Commit a checkpoint associated with a specific user message.
     * Used by rollback-to-message flow in extension/CLI.
     */
    commitForMessage(messageId: string, description?: string): Promise<string>;
    private commitInternal;
    /**
     * Restore workspace to a checkpoint (Cline/Roo-Code style).
     * Runs git clean -fd then git reset --hard in the shadow repo; worktree = workspace so files are restored in place.
     */
    resetHead(hash: string): Promise<void>;
    getDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]>;
    getEntries(): CheckpointEntry[];
}

/**
 * Persist checkpoint entries for a session (CLI use: after run or on each commit).
 * Stored under ~/.nexus/sessions/{cwdHash}/checkpoints.json keyed by sessionId.
 */
declare function writeCheckpointEntries(cwd: string, sessionId: string, entries: CheckpointEntry[]): Promise<void>;
/**
 * Load checkpoint entries for a session.
 */
declare function readCheckpointEntries(cwd: string, sessionId: string): Promise<CheckpointEntry[]>;

export { type AgentEvent, type ApprovalAction, type CatalogModel, type CatalogProvider, type ChangedFile, type CheckpointEntry, CheckpointTracker, CodebaseIndexer, type ContextUsageSnapshot, DEFAULT_HEARTBEAT_TIMEOUT_MS, type DiagnosticItem, type DiffFile, type DiffHunk, type DiffResult, type EmbeddingClient, type EmbeddingConfig, type IHost, type IIndexer, type ISession, type IndexSearchOptions, type IndexSearchResult, type IndexStatus, type LLMClient, MAX_TOOL_OUTPUT_CHARS_CONTEXT_ESTIMATE, MODES, MODE_TOOL_GROUPS, McpClient, type McpServerConfig, type MessagePart, type Mode, type ModeConfig, type ModelsCatalog, NEXUS_CUSTOM_OPTION_ID, NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX, NEXUS_SECRETS_STORAGE_KEY, type NexusConfig, NexusConfigSchema, type NexusSecretsPayload, type NexusSecretsStore, NexusServerClient, type NexusServerClientOptions, ParallelAgentManager, type PermissionResult, ProjectRegistry, type ProjectSettings, type ProviderConfig, READ_ONLY_TOOLS, type ResolveBundledOptions, Session, type SessionMessage, type SkillDef, type StoredContextUsage, type StoredSession, type StoredSessionMeta, type SymbolKind, TOOL_GROUP_MEMBERS, type TextPart, type ToolContext, type ToolDef, type ToolPart, ToolRegistry, type ToolResult, type UserQuestionAnswer, type UserQuestionItem, type UserQuestionOption, type UserQuestionRequest, applySecretsToConfig, buildReviewPromptBranch, buildReviewPromptUncommitted, buildSystemPrompt, canonicalProjectRoot, catalogSelectionToModel, classifySkills, classifyTools, computeContextUsageMetrics, createCodebaseIndexer, createCompaction, createEmbeddingClient, createFileSecretsStore, createLLMClient, createSpawnAgentOutputTool, createSpawnAgentStopTool, createSpawnAgentTool, createSpawnAgentsAliasTool, createSpawnAgentsParallelTool, deleteSession, deriveSessionTitle, ensureGlobalConfigDir, ensureQdrantRunning, estimateActiveContextSessionTokens, estimateTokens, estimateToolsDefinitionsTokens, formatQuestionnaireAnswersForAgent, generateSessionId, getAllBuiltinTools, getBuiltinToolsForMode, getContextWindowLimit, getGlobalConfigDir, getIndexDir, getModelsCatalog, getModelsPath, getModelsUrl, getNexusDataDir, getPlanContentForFollowup, getRunLogsDir, getSecretsPayloadFromConfig, getSessionMeta, getToolOutputDir, hadPlanExit, listSessions, loadConfig, loadGlobalSettings, loadProjectSettings, loadRules, loadSession, loadSessionMessages, loadSkills, parseMentions, persistSecretsFromConfig, readCheckpointEntries, resolveBundledMcpServers, runAgentLoop, saveSession, setMcpClientInstance, stripProfileSecrets, stripSecretsFromConfig, testMcpServers, writeCheckpointEntries, writeConfig, writeGlobalProfiles, writeGlobalSettings, writeProjectSettings };
