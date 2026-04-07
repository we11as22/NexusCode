import { z } from 'zod';
import { LanguageModelV1 } from 'ai';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

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
        provider: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
        id: string;
        reasoningEffort: string;
        reasoningHistoryMode: "auto" | "inline" | "reasoning_content" | "reasoning_details";
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
        reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details" | undefined;
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
        collection: string;
        autoStart: boolean;
        upsertWait: boolean;
        apiKey?: string | undefined;
        searchMinScore?: number | undefined;
        searchHnswEf?: number | undefined;
        searchExact?: boolean | undefined;
    }, {
        apiKey?: string | undefined;
        url?: string | undefined;
        enabled?: boolean | undefined;
        collection?: string | undefined;
        autoStart?: boolean | undefined;
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
        autoApproveSkillLoad: boolean;
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
        autoApproveSkillLoad?: boolean | undefined;
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
            cwd: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodString>;
            transport: z.ZodOptional<z.ZodEnum<["stdio", "http", "sse"]>>;
            type: z.ZodOptional<z.ZodEnum<["stdio", "sse", "streamable-http", "http"]>>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            enabled: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            /** Bundled server id (e.g. "context-mode"); resolved by host to command/args/env */
            bundle: z.ZodOptional<z.ZodString>;
            auth: z.ZodOptional<z.ZodObject<{
                type: z.ZodOptional<z.ZodEnum<["oauth", "url", "manual"]>>;
                startUrl: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            }, {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            enabled: boolean;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            cwd?: string | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            headers?: Record<string, string> | undefined;
            bundle?: string | undefined;
            auth?: {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            } | undefined;
        }, {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            cwd?: string | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            headers?: Record<string, string> | undefined;
            enabled?: boolean | undefined;
            bundle?: string | undefined;
            auth?: {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            } | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        servers: {
            name: string;
            enabled: boolean;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            cwd?: string | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            headers?: Record<string, string> | undefined;
            bundle?: string | undefined;
            auth?: {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            } | undefined;
        }[];
    }, {
        servers?: {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            cwd?: string | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            headers?: Record<string, string> | undefined;
            enabled?: boolean | undefined;
            bundle?: string | undefined;
            auth?: {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            } | undefined;
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
    /** Remote skill registries (base URL → index.json + files), cached under ~/.nexus/cache/skills/. */
    skillsUrls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tools: z.ZodDefault<z.ZodObject<{
        custom: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** When true, use LLM to filter which MCP servers to use when server count > classifyThreshold. Default off. */
        classifyToolsEnabled: z.ZodDefault<z.ZodBoolean>;
        /** Threshold: when MCP server count exceeds this, classifier selects which servers to use. Default 20. */
        classifyThreshold: z.ZodDefault<z.ZodNumber>;
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
        classifyToolsEnabled: boolean;
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
        deferredLoadingMode: "never" | "auto" | "always";
        deferredLoadingThresholdPercent: number;
        deferredLoadingMinimumTools: number;
    }, {
        custom?: string[] | undefined;
        classifyToolsEnabled?: boolean | undefined;
        classifyThreshold?: number | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
        deferredLoadingMode?: "never" | "auto" | "always" | undefined;
        deferredLoadingThresholdPercent?: number | undefined;
        deferredLoadingMinimumTools?: number | undefined;
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
        blocked: string[];
        enableHooks: boolean;
        hookTimeoutMs: number;
    }, {
        options?: Record<string, Record<string, unknown>> | undefined;
        enabled?: boolean | undefined;
        trusted?: string[] | undefined;
        blocked?: string[] | undefined;
        enableHooks?: boolean | undefined;
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
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details" | undefined;
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
        reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details" | undefined;
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
        reasoningHistoryMode: "auto" | "inline" | "reasoning_content" | "reasoning_details";
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
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            cwd?: string | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            headers?: Record<string, string> | undefined;
            bundle?: string | undefined;
            auth?: {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            } | undefined;
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
        maxPendingEmbedBatches: number;
        batchProcessingConcurrency: number;
        maxIndexedFiles: number;
        searchWhileIndexing: boolean;
        maxIndexingFailureRate: number;
        debounceMs: number;
        codebaseSearchSnippetMaxChars: number;
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
        autoApproveSkillLoad: boolean;
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
        deferredLoadingMode: "never" | "auto" | "always";
        deferredLoadingThresholdPercent: number;
        deferredLoadingMinimumTools: number;
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
    plugins: {
        options: Record<string, Record<string, unknown>>;
        enabled: boolean;
        trusted: string[];
        blocked: string[];
        enableHooks: boolean;
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
    profiles: Record<string, {
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details" | undefined;
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
        upsertWait: boolean;
        apiKey?: string | undefined;
        searchMinScore?: number | undefined;
        searchHnswEf?: number | undefined;
        searchExact?: boolean | undefined;
    } | undefined;
    skillsUrls?: string[] | undefined;
}, {
    model?: {
        provider: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details" | undefined;
        contextWindow?: number | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    } | undefined;
    mcp?: {
        servers?: {
            name: string;
            type?: "stdio" | "http" | "sse" | "streamable-http" | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            cwd?: string | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
            headers?: Record<string, string> | undefined;
            enabled?: boolean | undefined;
            bundle?: string | undefined;
            auth?: {
                message?: string | undefined;
                type?: "url" | "oauth" | "manual" | undefined;
                startUrl?: string | undefined;
            } | undefined;
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
        apiKey?: string | undefined;
        url?: string | undefined;
        enabled?: boolean | undefined;
        collection?: string | undefined;
        autoStart?: boolean | undefined;
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
        maxPendingEmbedBatches?: number | undefined;
        batchProcessingConcurrency?: number | undefined;
        maxIndexedFiles?: number | undefined;
        searchWhileIndexing?: boolean | undefined;
        maxIndexingFailureRate?: number | undefined;
        debounceMs?: number | undefined;
        codebaseSearchSnippetMaxChars?: number | undefined;
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
        autoApproveSkillLoad?: boolean | undefined;
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
    skillsUrls?: string[] | undefined;
    tools?: {
        custom?: string[] | undefined;
        classifyToolsEnabled?: boolean | undefined;
        classifyThreshold?: number | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
        deferredLoadingMode?: "never" | "auto" | "always" | undefined;
        deferredLoadingThresholdPercent?: number | undefined;
        deferredLoadingMinimumTools?: number | undefined;
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
    plugins?: {
        options?: Record<string, Record<string, unknown>> | undefined;
        enabled?: boolean | undefined;
        trusted?: string[] | undefined;
        blocked?: string[] | undefined;
        enableHooks?: boolean | undefined;
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
    profiles?: Record<string, {
        provider?: "anthropic" | "openai" | "google" | "ollama" | "openai-compatible" | "azure" | "bedrock" | "groq" | "mistral" | "xai" | "deepinfra" | "cerebras" | "cohere" | "togetherai" | "perplexity" | "minimax" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        temperature?: number | undefined;
        reasoningEffort?: string | undefined;
        reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details" | undefined;
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
    /** Assistant message id for the in-flight tool call (loop); used e.g. to merge sub-agent file edits when part id lookup fails. */
    toolExecutionMessageId?: string;
    /**
     * Set by the Parallel tool around batched executes so concurrent SpawnAgent calls are not
     * mistaken for duplicate spawns (shared recentSpawnTasks guard).
     */
    skipSubagentDuplicateCheck?: boolean;
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
    success: boolean;
    message: string;
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
    /** Restore workspace to a checkpoint. Optional if host has no checkpoint. */
    restoreCheckpoint?(hash: string): Promise<void>;
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
    /**
     * File edit flow: open → [approval] → save or revert.
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
    /** Copied from sub-agent session into parent for diff; omit from chat tool rows (CLI). */
    mergedFromSubagent?: boolean;
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
    scope: "session" | "project" | "team";
    title: string;
    content: string;
    createdAt: number;
    updatedAt: number;
    metadata?: Record<string, unknown>;
}
interface PluginManifestRecord {
    name: string;
    version?: string;
    description: string;
    commands: string[];
    agents: string[];
    skills: string[];
    hooks: string[];
    mcpServers: string[];
    enabled: boolean;
    rootDir: string;
    sourcePath: string;
    scope: "project" | "global";
    settingsSchema?: Record<string, unknown>;
    warnings?: string[];
    trusted?: boolean;
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
        /** Fine-grained permission rules evaluated in order, first match wins */
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
    };
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
        classifyToolsEnabled: boolean;
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
        /** Deferred tool loading strategy. auto = use ToolSearch only when deferred tools are materially large. */
        deferredLoadingMode?: "auto" | "always" | "never";
        /** In auto mode, defer tool schemas once deferred tools exceed this fraction of model context. */
        deferredLoadingThresholdPercent?: number;
        /** In auto mode, always defer once at least this many tools are marked shouldDefer. */
        deferredLoadingMinimumTools?: number;
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
    /** Resolve to a bundled MCP server (e.g. "context-mode") when nexusRoot is set by host */
    bundle?: string;
    auth?: {
        type?: "oauth" | "url" | "manual";
        startUrl?: string;
        message?: string;
    };
}
interface SkillDef {
    name: string;
    path: string;
    /** Short description (YAML `description` or first heading / line). */
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

/**
 * Secrets store abstraction for hosts that support it.
 * API keys are never written to YAML; they are stored in a secure store and
 * applied at load time after env overrides.
 */
/** Key used in secrets store (VS Code secretStorage or file) for API keys payload. */
declare const NEXUS_SECRETS_STORAGE_KEY = "nexuscode_api";
interface NexusSecretsPayload {
    model?: string;
    embeddings?: string;
    /** Qdrant / vector DB API key (same store as other keys; never written to YAML). */
    qdrantApiKey?: string;
    /** API keys per profile name (global profiles in ~/.nexus/nexus.yaml). */
    profiles?: Record<string, string>;
}
interface NexusSecretsStore {
    getSecret(key: string): Promise<string | undefined>;
    setSecret(key: string, value: string): Promise<void>;
}
/**
 * Apply secrets from store into config (in-place).
 * Only sets model.apiKey, embeddings.apiKey, vectorDb.apiKey, and profiles[name].apiKey if not already set (env/config takes precedence).
 */
declare function applySecretsToConfig(config: Record<string, unknown>, store: NexusSecretsStore): Promise<void>;
/**
 * Strip secret fields from config for persisting to YAML (never write apiKey to repo).
 * Returns a deep copy with model.apiKey, embeddings.apiKey, vectorDb.apiKey, and each profiles[name].apiKey removed.
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
declare function persistSecretsFromConfig(config: Record<string, unknown>, store: NexusSecretsStore): Promise<void>;
/**
 * File-based secrets store for CLI (single file with mode 0o600).
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
    /** Rewind chat to timestamp. Keeps only messages with ts <= timestamp. */
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
    microcompact(session: ISession, keepRecentMessages?: number): number;
    compact(session: ISession, client: LLMClient, signal?: AbortSignal, opts?: {
        keepRecentMessages?: number;
        force?: boolean;
    }): Promise<void>;
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
    streamMessage(sessionId: string, content: string, mode: Mode, presetName?: string, signal?: AbortSignal): AsyncGenerator<AgentEvent>;
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
    /** When set, commit on completion of an agent turn and optionally double-check. */
    checkpoint?: {
        commit(description?: string): Promise<string>;
    };
    /** When true, inject create-skill instructions; host must allow writes to .nexus/skills (and ~/.nexus/skills if applicable). */
    createSkillMode?: boolean;
}
/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
declare function runAgentLoop(opts: AgentLoopOptions): Promise<void>;

type ToolGroup = "read" | "write" | "execute" | "search" | "mcp" | "skills" | "agents" | "always" | "context" | "plan_exit"
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
    /** Active background work summary (bash/subagents/tasks). */
    backgroundJobsSummary?: string;
    /** Short project layout (top-level dirs and key files) at start */
    initialProjectContext?: string;
    /** Persistent memories relevant to this run (project/session/team). */
    memories?: MemoryRecord[];
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
    /** Write/Edit tool parts from the sub-agent session (merged into parent for session diff). */
    fileEditParts?: ToolPart[];
}
interface ResumeAgentOptions {
    followupInstruction?: string;
    fork?: boolean;
    runInBackground?: boolean;
}
interface AgentSpawnOptions {
    skipDuplicateCheck?: boolean;
    modelOverride?: string;
    taskName?: string;
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
    /** Recent spawn task keys (normalized) to prevent infinite restart / duplicate spawns. */
    private recentSpawnTasks;
    private static readonly RECENT_SPAWN_CAP;
    private static readonly TASK_KEY_LEN;
    private rememberId;
    private startTask;
    spawn(description: string, mode: Mode | undefined, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, contextSummary?: string, parentPartId?: string, agentType?: string, spawnOptions?: AgentSpawnOptions): Promise<SubAgentResult>;
    spawnInBackground(description: string, mode: Mode, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, contextSummary?: string, parentPartId?: string, agentType?: string, spawnOptions?: AgentSpawnOptions): Promise<{
        subagentId: string;
    }>;
    getSnapshot(subagentId: string): SubAgentSnapshot | null;
    waitFor(subagentId: string): Promise<SubAgentSnapshot | null>;
    stop(subagentId: string): boolean;
    listRuns(cwd: string): Promise<BackgroundTaskRecord[]>;
    resume(subagentId: string, options: ResumeAgentOptions, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number, emit?: (event: AgentEvent) => void, parentPartId?: string): Promise<SubAgentResult | {
        subagentId: string;
        background: true;
    }>;
    private runSubAgent;
    /** How many agents are currently running */
    get activeCount(): number;
}
declare function setParallelAgentManager(manager: ParallelAgentManager | undefined): void;
declare function getParallelAgentManager(): ParallelAgentManager | undefined;
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
    run_in_background?: boolean | undefined;
    instruction?: string | undefined;
    fork?: boolean | undefined;
}, {
    subagent_id: string;
    run_in_background?: boolean | undefined;
    instruction?: string | undefined;
    fork?: boolean | undefined;
}>;
declare const taskResumeSchema: z.ZodObject<{
    task_id: z.ZodString;
    instruction: z.ZodOptional<z.ZodString>;
    fork: z.ZodOptional<z.ZodBoolean>;
    block: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    block?: boolean | undefined;
    instruction?: string | undefined;
    fork?: boolean | undefined;
}, {
    task_id: string;
    block?: boolean | undefined;
    instruction?: string | undefined;
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

declare function getRuntimeDir(cwd: string): string;
declare class OrchestrationRuntime {
    readonly cwd: string;
    private readonly root;
    private readonly stateFile;
    private loaded;
    private tasks;
    private teams;
    private worktrees;
    private backgroundTasks;
    private memories;
    private remoteSessions;
    constructor(cwd: string);
    private ensureLoaded;
    private persist;
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
    }): Promise<TeamRecord>;
    getTeam(teamName: string): Promise<TeamRecord | null>;
    listTeams(): Promise<TeamRecord[]>;
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
        metadata?: Record<string, unknown>;
    }): Promise<MemoryRecord>;
    getMemory(memoryId: string): Promise<MemoryRecord | null>;
    listMemories(filters?: {
        scope?: MemoryRecord["scope"] | MemoryRecord["scope"][];
        limit?: number;
        metadataMatch?: Record<string, string | number | boolean>;
    }): Promise<MemoryRecord[]>;
    updateMemory(memoryId: string, updates: Partial<Pick<MemoryRecord, "title" | "content">> & {
        metadata?: Record<string, unknown | null>;
    }): Promise<MemoryRecord | null>;
    upsertMemoryByTitle(input: {
        scope: MemoryRecord["scope"];
        title: string;
        content: string;
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

declare function loadAgentDefinitions(cwd: string, compatibility?: ClaudeCompatibilityOptions): Promise<AgentDefinition[]>;

declare function ensureTeamMemberForTask(args: {
    cwd: string;
    host: IHost;
    task: TaskRecord;
    agentId?: string;
    agentType?: string;
}): Promise<void>;
declare function handleCompletedTaskSideEffects(args: {
    cwd: string;
    host: IHost;
    config: NexusConfig;
    task: TaskRecord;
    outputPreview?: string;
}): Promise<void>;

interface ExtractedMemoryInput {
    scope: MemoryRecord["scope"];
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
}
declare function extractMemoriesFromCompactionSummary(summary: string, sessionId: string): ExtractedMemoryInput[];

declare function resolvePluginDeclaredPath(plugin: PluginManifestRecord, declaredPath: string): string;
declare function validatePluginManifestFile(filePath: string): Promise<{
    success: boolean;
    errors: string[];
    warnings: string[];
    plugin?: PluginManifestRecord;
}>;
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
type PluginHookEvent = "user_prompt_submit" | "before_tool" | "after_tool" | "turn_complete" | "task_completed" | "subagent_start" | "subagent_stop" | "teammate_idle";
declare function applyPluginRuntimeSettings(plugin: PluginManifestRecord, config: NexusConfig): PluginManifestRecord;
declare function loadPluginRuntimeRecords(cwd: string, config: NexusConfig): Promise<PluginManifestRecord[]>;
declare function runPluginHooks(cwd: string, host: IHost, config: NexusConfig, hookEvent: PluginHookEvent, payload: Record<string, unknown>): Promise<PluginHookExecution[]>;
declare function runScopedHooks(cwd: string, host: IHost, hookEvent: PluginHookEvent, payload: Record<string, unknown>, items: Array<{
    name: string;
    rootDir: string;
    hooks: string[];
}>): Promise<PluginHookExecution[]>;

interface LoadedSlashCommand {
    command: string;
    scope: "project" | "user";
    sourcePath: string;
    description: string;
    prompt: string;
}
declare function loadSlashCommands(cwd: string, compatibility?: ClaudeCompatibilityOptions): Promise<LoadedSlashCommand[]>;
declare function renderSlashCommandPrompt(command: LoadedSlashCommand, args: string): string;

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

/** Snippets actually applied by the Edit tool — for compact CLI/webview previews. */
type AppliedReplacementSnippet = {
    oldSnippet: string;
    newSnippet: string;
};
/** Normalize metadata from Edit.execute() for host events and UIs. */
declare function normalizedAppliedReplacementsFromMetadata(metadata: unknown): AppliedReplacementSnippet[] | undefined;

declare function getAllBuiltinTools(): ToolDef[];

interface ShellCommandInterpretation {
    isError: boolean;
    message?: string;
}
declare function interpretShellCommandResult(command: string, exitCode: number, stdout: string, stderr: string): ShellCommandInterpretation;

/** Synthetic option id for the host-added “Other / custom” row (never send from the model). */
declare const NEXUS_CUSTOM_OPTION_ID = "__nexus_other__";
/** First line of user messages created after submitting a questionnaire (hosts may use for compact UI). */
declare const NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX = "[nexus:questionnaire-response]\n";
declare function formatQuestionnaireAnswersForAgent(request: UserQuestionRequest, answers: UserQuestionAnswer[]): string;

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
    startIndexing(): Promise<void>;
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
    /**
     * Remove tracker + vector points for a repo-relative prefix (folder or file path).
     * Does not delete other paths; one collection remains for the workspace.
     */
    deleteIndexScope(relPathOrAbs: string): Promise<void>;
    stop(): void;
    close(): void;
}

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

/**
 * Load rules from NEXUS.md, CLAUDE.md, AGENTS.md, .nexus/rules/** etc.
 * Walks up from cwd to find all applicable rule files.
 */
declare function loadRules(cwd: string, rulePatterns: string[], compatibility?: ClaudeCompatibilityOptions): Promise<string>;

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
declare function loadSkills(skillPaths: string[], cwd: string, skillsUrls?: string[], compatibility?: ClaudeCompatibilityOptions): Promise<SkillDef[]>;

type SkillToolDescriptionRow = {
    name: string;
    description: string;
    location: string;
};
type ResolvedSkillBody = {
    displayName: string;
    content: string;
    skillDir: string;
};
/** Rows for the `Skill` tool description (`<available_skills>`), from the same set as `loadSkills`. */
declare function loadSkillToolCatalogRows(cwd: string, config: NexusConfig): Promise<SkillToolDescriptionRow[]>;
/**
 * Resolve skill body from `loadSkills` only (case-insensitive / normalized / partial match).
 */
declare function resolveSkillBody(query: string, cwd: string, config: NexusConfig): Promise<ResolvedSkillBody | null>;
/** Dynamic `Skill` tool description: lists discoverable skills for the LLM. */
declare function buildSkillToolDynamicDescription(rows: SkillToolDescriptionRow[]): string;
/** Sample files under the skill directory (paths containing `skill.md` skipped). */
declare function sampleSkillSiblingFiles(skillDir: string, signal?: AbortSignal): Promise<string[]>;

/**
 * Download registry from `baseUrl` (append index.json), return directories under cache that contain SKILL.md.
 */
declare function fetchSkillUrlRegistryRoots(baseUrl: string): Promise<string[]>;

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
/**
 * MCP client that connects to MCP servers and exposes their tools.
 */
declare class McpClient {
    private clients;
    private tools;
    private configs;
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
    listResources(serverName?: string): Promise<McpResourceRef[]>;
    readResource(serverName: string, uri: string): Promise<McpResourceContent[]>;
    authenticate(serverName: string, host?: IHost): Promise<{
        success: boolean;
        message: string;
    }>;
}
declare function setMcpClientInstance(client: McpClient): void;
declare function getMcpClientInstance(): McpClient | null;
/** Standalone test of MCP server configs (does not keep connections). */
declare function testMcpServers(configs: McpServerConfig[]): Promise<Array<{
    name: string;
    status: "ok" | "error";
    error?: string;
}>>;

/**
 * MCP client transports: stdio, SSE (legacy remote), Streamable HTTP (current spec).
 */

/** Remote URL transport: explicit `transport`, or Roo-style `type`, else SSE (backward compatible). */
declare function effectiveUrlTransport(config: McpServerConfig): "http" | "sse";
/**
 * Build MCP transport. `bundle` must already be resolved to `command`/`url` by the host.
 */
declare function createMcpTransport(config: McpServerConfig): Transport;

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
 * Shadow git repository for checkpoints.
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
    /** Stage files in worktree; temporarily renames nested .git dirs so git doesn't treat them as submodules. */
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
     * Restore workspace to a checkpoint.
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

export { type AgentDefinition, type AgentEvent, type AppliedReplacementSnippet, type ApprovalAction, type BackgroundTaskRecord, type CatalogModel, type CatalogProvider, type ChangedFile, type CheckpointEntry, CheckpointTracker, CodebaseIndexer, type CodebaseIndexerHostOptions, type ContextUsageSnapshot, DEFAULT_BATCH_PROCESSING_CONCURRENCY, DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_MAX_INDEXED_FILES, DEFAULT_MAX_PENDING_EMBED_BATCHES, type DeferredToolDef, type DiagnosticItem, type DiffFile, type DiffHunk, type DiffResult, type EmbeddingClient, type EmbeddingConfig, type IHost, type IIndexer, INDEX_FILE_WATCHER_DEBOUNCE_MS, type ISession, type IndexSearchOptions, type IndexSearchResult, type IndexStatus, type LLMClient, type ListIndexAbsolutePathsFn, type LoadedSlashCommand, type LspCallRecord, type LspLocation, type LspOperation, type LspPosition, type LspQueryRequest, type LspQueryResult, type LspRange, type LspSymbolRecord, MODES, MODE_TOOL_GROUPS, type McpAuthRequest, type McpAuthResult, McpClient, type McpResourceContent, type McpResourceRef, type McpServerConfig, type MemoryRecord, type MessagePart, type Mode, type ModeChangeResult, type ModeConfig, type ModelsCatalog, NEXUS_CUSTOM_OPTION_ID, NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX, NEXUS_SECRETS_STORAGE_KEY, type NexusConfig, NexusConfigSchema, type NexusSecretsPayload, type NexusSecretsStore, NexusServerClient, type NexusServerClientOptions, OrchestrationRuntime, ParallelAgentManager, type PermissionResult, type PluginManifestRecord, ProjectRegistry, type ProjectSettings, type ProviderConfig, type ProviderName, READ_ONLY_TOOLS, type RemoteSessionRecord, type ResolveBundledOptions, type ResolvedSkillBody, Session, type SessionMessage, type SkillDef, type SkillToolDescriptionRow, type StoredContextUsage, type StoredSession, type StoredSessionMeta, type SymbolKind, TOOL_GROUP_MEMBERS, type TaskKind, type TaskRecord, type TaskStatus, type TeamRecord, type TextPart, type ToolContext, type ToolDef, type ToolPart, ToolRegistry, type ToolResult, type UserQuestionAnswer, type UserQuestionItem, type UserQuestionOption, type UserQuestionRequest, type WorkingDirectoryChangeResult, type WorktreeSession, applyPluginRuntimeSettings, applySecretsToConfig, buildIndexWatcherGlobPattern, buildReviewPromptBranch, buildReviewPromptUncommitted, buildSkillToolDynamicDescription, buildSystemPrompt, canonicalProjectRoot, catalogSelectionToModel, classifySkills, classifyTools, computeContextUsageMetrics, createAgentRunSnapshotTool, createCodebaseIndexer, createCompaction, createEmbeddingClient, createFileSecretsStore, createLLMClient, createListAgentRunsTool, createMcpTransport, createResumeAgentTool, createSpawnAgentOutputTool, createSpawnAgentStopTool, createSpawnAgentTool, createSpawnAgentsAliasTool, createSpawnAgentsParallelTool, createTaskCreateBatchTool, createTaskResumeTool, createTaskSnapshotTool, deleteSession, deriveSessionTitle, effectiveUrlTransport, ensureGlobalConfigDir, ensureQdrantRunning, ensureTeamMemberForTask, estimateActiveContextSessionTokens, estimateTokens, estimateToolsDefinitionsTokens, extractMemoriesFromCompactionSummary, fetchSkillUrlRegistryRoots, formatQuestionnaireAnswersForAgent, generateSessionId, getAllBuiltinTools, getBuiltinToolsForMode, getClaudeCompatibilityOptions, getContextWindowLimit, getGlobalConfigDir, getIndexDir, getIndexableExtensions, getMcpClientInstance, getModelsCatalog, getModelsPath, getModelsUrl, getNexusDataDir, getOrchestrationRuntime, getParallelAgentManager, getPlanContentForFollowup, getRunLogsDir, getRuntimeDir, getSecretsPayloadFromConfig, getSessionMeta, getToolOutputDir, hadPlanExit, handleCompletedTaskSideEffects, interpretShellCommandResult, listSessions, loadAgentDefinitions, loadConfig, loadGlobalSettings, loadPluginManifests, loadPluginRuntimeRecords, loadProjectSettings, loadRules, loadSession, loadSessionMessages, loadSkillToolCatalogRows, loadSkills, loadSlashCommands, normalizedAppliedReplacementsFromMetadata, parseMentions, persistSecretsFromConfig, readCheckpointEntries, renderSlashCommandPrompt, resolveBundledMcpServers, resolvePluginDeclaredPath, resolveSkillBody, runAgentLoop, runPluginHooks, runScopedHooks, sampleSkillSiblingFiles, saveSession, setIndexTelemetrySink, setMcpClientInstance, setParallelAgentManager, stripProfileSecrets, stripSecretsFromConfig, testMcpServers, validatePluginManifestFile, writeCheckpointEntries, writeConfig, writeGlobalProfiles, writeGlobalSettings, writeProjectSettings };
