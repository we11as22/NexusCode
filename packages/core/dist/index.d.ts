import { z } from 'zod';
import { LanguageModelV1 } from 'ai';

declare const NexusConfigSchema: z.ZodObject<{
    model: z.ZodDefault<z.ZodObject<{
        provider: z.ZodEnum<["anthropic", "openai", "google", "openrouter", "ollama", "openai-compatible", "azure", "bedrock"]>;
        id: z.ZodString;
        apiKey: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        resourceName: z.ZodOptional<z.ZodString>;
        deploymentId: z.ZodOptional<z.ZodString>;
        apiVersion: z.ZodOptional<z.ZodString>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>>;
    maxMode: z.ZodDefault<z.ZodObject<{
        provider: z.ZodEnum<["anthropic", "openai", "google", "openrouter", "ollama", "openai-compatible", "azure", "bedrock"]>;
        id: z.ZodString;
        apiKey: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        resourceName: z.ZodOptional<z.ZodString>;
        deploymentId: z.ZodOptional<z.ZodString>;
        apiVersion: z.ZodOptional<z.ZodString>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    } & {
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        enabled: boolean;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
        enabled?: boolean | undefined;
    }>>;
    embeddings: z.ZodOptional<z.ZodObject<{
        provider: z.ZodEnum<["openai", "openai-compatible", "ollama", "local"]>;
        model: z.ZodString;
        baseUrl: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        dimensions: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        provider: "openai" | "ollama" | "openai-compatible" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
    }, {
        provider: "openai" | "ollama" | "openai-compatible" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
    }>>;
    vectorDb: z.ZodOptional<z.ZodObject<{
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
        fts: z.ZodDefault<z.ZodBoolean>;
        vector: z.ZodDefault<z.ZodBoolean>;
        batchSize: z.ZodDefault<z.ZodNumber>;
        debounceMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        excludePatterns: string[];
        symbolExtract: boolean;
        fts: boolean;
        vector: boolean;
        batchSize: number;
        debounceMs: number;
    }, {
        enabled?: boolean | undefined;
        excludePatterns?: string[] | undefined;
        symbolExtract?: boolean | undefined;
        fts?: boolean | undefined;
        vector?: boolean | undefined;
        batchSize?: number | undefined;
        debounceMs?: number | undefined;
    }>>;
    permissions: z.ZodDefault<z.ZodObject<{
        autoApproveRead: z.ZodDefault<z.ZodBoolean>;
        autoApproveWrite: z.ZodDefault<z.ZodBoolean>;
        autoApproveCommand: z.ZodDefault<z.ZodBoolean>;
        autoApproveReadPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        denyPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveReadPatterns: string[];
        denyPatterns: string[];
    }, {
        autoApproveRead?: boolean | undefined;
        autoApproveWrite?: boolean | undefined;
        autoApproveCommand?: boolean | undefined;
        autoApproveReadPatterns?: string[] | undefined;
        denyPatterns?: string[] | undefined;
    }>>;
    checkpoint: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        createOnWrite: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
    }, {
        enabled?: boolean | undefined;
        timeoutMs?: number | undefined;
        createOnWrite?: boolean | undefined;
    }>>;
    mcp: z.ZodDefault<z.ZodObject<{
        servers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            url: z.ZodOptional<z.ZodString>;
            transport: z.ZodOptional<z.ZodEnum<["stdio", "http", "sse"]>>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
        }, {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        servers: {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
        }[];
    }, {
        servers?: {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
        }[] | undefined;
    }>>;
    skills: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    tools: z.ZodDefault<z.ZodObject<{
        custom: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        classifyThreshold: z.ZodDefault<z.ZodNumber>;
        parallelReads: z.ZodDefault<z.ZodBoolean>;
        maxParallelReads: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        custom: string[];
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
    }, {
        custom?: string[] | undefined;
        classifyThreshold?: number | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
    }>>;
    skillClassifyThreshold: z.ZodDefault<z.ZodNumber>;
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
    }, "strip", z.ZodTypeAny, {
        maxParallel: number;
    }, {
        maxParallel?: number | undefined;
    }>>;
    rules: z.ZodDefault<z.ZodObject<{
        files: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        files: string[];
    }, {
        files?: string[] | undefined;
    }>>;
    profiles: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodOptional<z.ZodEnum<["anthropic", "openai", "google", "openrouter", "ollama", "openai-compatible", "azure", "bedrock"]>>;
        id: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        resourceName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        deploymentId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        apiVersion: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        extra: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, "strip", z.ZodTypeAny, {
        provider?: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }, {
        provider?: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    model: {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    };
    mcp: {
        servers: {
            name: string;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
            transport?: "stdio" | "http" | "sse" | undefined;
        }[];
    };
    maxMode: {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        enabled: boolean;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
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
        debug?: {
            autoApprove?: ("read" | "write" | "execute" | "mcp" | "browser" | "search")[] | undefined;
            systemPrompt?: string | undefined;
            customInstructions?: string | undefined;
        } | undefined;
        ask?: {
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
        fts: boolean;
        vector: boolean;
        batchSize: number;
        debounceMs: number;
    };
    permissions: {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveReadPatterns: string[];
        denyPatterns: string[];
    };
    checkpoint: {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
    };
    skills: string[];
    tools: {
        custom: string[];
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
    };
    skillClassifyThreshold: number;
    structuredOutput: "never" | "auto" | "always";
    summarization: {
        model: string;
        auto: boolean;
        threshold: number;
        keepRecentMessages: number;
    };
    parallelAgents: {
        maxParallel: number;
    };
    rules: {
        files: string[];
    };
    profiles: Record<string, {
        provider?: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }>;
    embeddings?: {
        provider: "openai" | "ollama" | "openai-compatible" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
    } | undefined;
    vectorDb?: {
        url: string;
        enabled: boolean;
        collection: string;
        autoStart: boolean;
    } | undefined;
}, {
    model?: {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
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
        }[] | undefined;
    } | undefined;
    maxMode?: {
        provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
        id: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
        enabled?: boolean | undefined;
    } | undefined;
    embeddings?: {
        provider: "openai" | "ollama" | "openai-compatible" | "local";
        model: string;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        dimensions?: number | undefined;
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
        fts?: boolean | undefined;
        vector?: boolean | undefined;
        batchSize?: number | undefined;
        debounceMs?: number | undefined;
    } | undefined;
    permissions?: {
        autoApproveRead?: boolean | undefined;
        autoApproveWrite?: boolean | undefined;
        autoApproveCommand?: boolean | undefined;
        autoApproveReadPatterns?: string[] | undefined;
        denyPatterns?: string[] | undefined;
    } | undefined;
    checkpoint?: {
        enabled?: boolean | undefined;
        timeoutMs?: number | undefined;
        createOnWrite?: boolean | undefined;
    } | undefined;
    skills?: string[] | undefined;
    tools?: {
        custom?: string[] | undefined;
        classifyThreshold?: number | undefined;
        parallelReads?: boolean | undefined;
        maxParallelReads?: number | undefined;
    } | undefined;
    skillClassifyThreshold?: number | undefined;
    structuredOutput?: "never" | "auto" | "always" | undefined;
    summarization?: {
        model?: string | undefined;
        auto?: boolean | undefined;
        threshold?: number | undefined;
        keepRecentMessages?: number | undefined;
    } | undefined;
    parallelAgents?: {
        maxParallel?: number | undefined;
    } | undefined;
    rules?: {
        files?: string[] | undefined;
    } | undefined;
    profiles?: Record<string, {
        provider?: "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock" | undefined;
        id?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        resourceName?: string | undefined;
        deploymentId?: string | undefined;
        apiVersion?: string | undefined;
        extra?: Record<string, unknown> | undefined;
    }> | undefined;
}>;

type Mode = "agent" | "plan" | "debug" | "ask";
type PermissionAction = "read" | "write" | "execute" | "mcp" | "browser" | "search";
interface PermissionResult {
    approved: boolean;
    alwaysApprove?: boolean;
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
    indexer?: IIndexer;
    signal: AbortSignal;
}
interface ApprovalAction {
    type: "write" | "execute" | "mcp" | "browser" | "read" | "doom_loop";
    tool: string;
    description: string;
    content?: string;
    diff?: string;
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
    resolveAtMention?(mention: string): Promise<string | null>;
    getProblems?(): Promise<DiagnosticItem[]>;
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
    fork(messageId: string): ISession;
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
type MessagePart = TextPart | ToolPart | ReasoningPart;
interface TextPart {
    type: "text";
    text: string;
}
interface ReasoningPart {
    type: "reasoning";
    text: string;
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
}
interface IIndexer {
    search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
    status(): IndexStatus;
}
interface IndexSearchOptions {
    limit?: number;
    kind?: SymbolKind;
    semantic?: boolean;
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
} | {
    state: "ready";
    files: number;
    symbols: number;
} | {
    state: "error";
    error: string;
};
type AgentEvent = {
    type: "text_delta";
    delta: string;
    messageId: string;
} | {
    type: "reasoning_delta";
    delta: string;
    messageId: string;
} | {
    type: "tool_start";
    tool: string;
    partId: string;
    messageId: string;
} | {
    type: "tool_end";
    tool: string;
    partId: string;
    messageId: string;
    success: boolean;
} | {
    type: "tool_approval_needed";
    action: ApprovalAction;
    partId: string;
} | {
    type: "compaction_start";
} | {
    type: "compaction_end";
} | {
    type: "index_update";
    status: IndexStatus;
} | {
    type: "session_saved";
    sessionId: string;
} | {
    type: "error";
    error: string;
    fatal?: boolean;
} | {
    type: "done";
    messageId: string;
} | {
    type: "doom_loop_detected";
    tool: string;
};
interface ProviderConfig {
    provider: ProviderName;
    id: string;
    apiKey?: string;
    baseUrl?: string;
    /** Azure-specific */
    resourceName?: string;
    deploymentId?: string;
    apiVersion?: string;
    /** Extra provider options */
    extra?: Record<string, unknown>;
}
type ProviderName = "anthropic" | "openai" | "google" | "openrouter" | "ollama" | "openai-compatible" | "azure" | "bedrock";
interface EmbeddingConfig {
    provider: "openai" | "openai-compatible" | "ollama" | "local";
    model: string;
    baseUrl?: string;
    apiKey?: string;
    dimensions?: number;
}
interface NexusConfig {
    model: ProviderConfig;
    maxMode: ProviderConfig & {
        enabled: boolean;
    };
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
        debug?: ModeConfig;
        ask?: ModeConfig;
        [key: string]: ModeConfig | undefined;
    };
    indexing: {
        enabled: boolean;
        excludePatterns: string[];
        symbolExtract: boolean;
        fts: boolean;
        vector: boolean;
        batchSize: number;
        debounceMs: number;
    };
    permissions: {
        autoApproveRead: boolean;
        autoApproveWrite: boolean;
        autoApproveCommand: boolean;
        autoApproveReadPatterns: string[];
        denyPatterns: string[];
    };
    checkpoint: {
        enabled: boolean;
        timeoutMs: number;
        createOnWrite: boolean;
    };
    mcp: {
        servers: McpServerConfig[];
    };
    skills: string[];
    tools: {
        custom: string[];
        classifyThreshold: number;
        parallelReads: boolean;
        maxParallelReads: number;
    };
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
interface McpServerConfig {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    transport?: "stdio" | "http" | "sse";
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
 * Load config by walking up from cwd.
 * Merges project config over global config.
 * Applies env overrides.
 */
declare function loadConfig(cwd?: string): Promise<NexusConfig>;
/**
 * Write config to project .nexus/nexus.yaml
 */
declare function writeConfig(config: Partial<NexusConfig>, cwd?: string): void;
/**
 * Get the global config directory
 */
declare function getGlobalConfigDir(): string;
/**
 * Ensure global config directory exists with defaults
 */
declare function ensureGlobalConfigDir(): void;

interface LLMStreamEvent {
    type: "text_delta" | "reasoning_delta" | "reasoning_end" | "tool_input_start" | "tool_call" | "tool_result" | "finish" | "error";
    delta?: string;
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
    role: "user" | "assistant" | "system";
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
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
} | {
    type: "tool_result";
    toolCallId: string;
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
    maxTokens?: number;
    temperature?: number;
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

declare function listSessions(cwd: string): Promise<Array<{
    id: string;
    ts: number;
    title?: string;
    messageCount: number;
}>>;
declare function generateSessionId(): string;

/**
 * In-memory session implementation backed by JSONL storage.
 */
declare class Session implements ISession {
    readonly id: string;
    private _messages;
    private _todo;
    private cwd;
    constructor(id: string, cwd: string, messages?: SessionMessage[]);
    get messages(): SessionMessage[];
    addMessage(msg: Omit<SessionMessage, "id" | "ts">): SessionMessage;
    updateMessage(id: string, updates: Partial<SessionMessage>): void;
    addToolPart(messageId: string, part: ToolPart): void;
    updateToolPart(messageId: string, partId: string, updates: Partial<ToolPart>): void;
    updateTodo(markdown: string): void;
    getTodo(): string;
    getTokenEstimate(): number;
    fork(messageId: string): ISession;
    save(): Promise<void>;
    load(): Promise<void>;
    static create(cwd: string): Session;
    static resume(sessionId: string, cwd: string): Promise<Session | null>;
}

interface SessionCompaction {
    prune(session: ISession): void;
    compact(session: ISession, client: LLMClient, signal?: AbortSignal): Promise<void>;
    isOverflow(tokenCount: number, contextLimit: number, threshold: number): boolean;
}
declare function createCompaction(): SessionCompaction;

interface AgentLoopOptions {
    session: ISession;
    client: LLMClient;
    maxModeClient?: LLMClient;
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
}
/**
 * Main agent loop — runs until completion, abort, or doom loop.
 * No artificial step limit. Doom loop detection protects against infinite loops.
 */
declare function runAgentLoop(opts: AgentLoopOptions): Promise<void>;

type ToolGroup = "read" | "write" | "execute" | "search" | "browser" | "mcp" | "skills" | "agents" | "always";
/**
 * Core built-in tool groups per mode.
 * These are ALWAYS active if the mode permits — no classifier applied.
 * Classifier only applies to MCP tools and custom skills when count exceeds threshold.
 */
declare const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]>;
/**
 * Built-in tool names per group.
 * Tools in "always" group are available in every mode.
 */
declare const TOOL_GROUP_MEMBERS: Record<ToolGroup, string[]>;
/**
 * Read-only tools that can be parallelized.
 */
declare const READ_ONLY_TOOLS: Set<string>;
/**
 * Get all built-in tool names available for a given mode.
 */
declare function getBuiltinToolsForMode(mode: Mode): string[];

/**
 * Classify which MCP/custom tools are relevant for the given task.
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
    maxMode: boolean;
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
}
/**
 * Assemble the full system prompt from blocks.
 * First 3 blocks are stable/cacheable. Last 3 are dynamic.
 */
declare function buildSystemPrompt(ctx: PromptContext): {
    blocks: string[];
    cacheableCount: number;
};

interface SubAgentResult {
    sessionId: string;
    success: boolean;
    output: string;
    error?: string;
}
/**
 * Manager for parallel sub-agents.
 * Each sub-agent runs its own session and agent loop.
 */
declare class ParallelAgentManager {
    private running;
    spawn(description: string, mode: Mode | undefined, config: NexusConfig, cwd: string, signal: AbortSignal, maxParallel: number): Promise<SubAgentResult>;
    private runSubAgent;
}
declare function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef;

/**
 * Tool registry — manages built-in, MCP, and custom tools.
 */
declare class ToolRegistry {
    private tools;
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

/**
 * Main codebase indexer. Manages FTS and optional vector index.
 */
declare class CodebaseIndexer implements IIndexer {
    private readonly projectRoot;
    private readonly config;
    private fts;
    private vector?;
    private _status;
    private indexing;
    private abortController?;
    private debounceTimers;
    constructor(projectRoot: string, config: NexusConfig, embeddingClient?: EmbeddingClient, vectorUrl?: string, projectHash?: string);
    status(): IndexStatus;
    startIndexing(): Promise<void>;
    private indexInBackground;
    private processBatch;
    refreshFile(filePath: string): Promise<void>;
    search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
    stop(): void;
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

/**
 * Load skills from configured paths and standard locations.
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
    getTools(): ToolDef[];
    getStatus(): Record<string, "connected" | "disconnected">;
    disconnectAll(): Promise<void>;
}
declare function setMcpClientInstance(client: McpClient): void;

/**
 * Shadow git repository for checkpoints.
 * Uses a separate git repo in ~/.nexus/checkpoints/{task-id}/
 * to snapshot the workspace state without interfering with the project's git.
 */
declare class CheckpointTracker {
    private readonly taskId;
    private readonly workspaceRoot;
    private git;
    private readonly shadowRoot;
    private initialized;
    private entries;
    constructor(taskId: string, workspaceRoot: string);
    /**
     * Initialize the shadow git repository.
     * Returns false if workspace is too large or git unavailable.
     */
    init(timeoutMs?: number): Promise<boolean>;
    private initInternal;
    commit(description?: string): Promise<string>;
    resetHead(hash: string): Promise<void>;
    getDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]>;
    getEntries(): CheckpointEntry[];
    private syncWorkspace;
    private restoreToWorkspace;
}

export { type AgentEvent, type ApprovalAction, type ChangedFile, type CheckpointEntry, CheckpointTracker, CodebaseIndexer, type DiagnosticItem, type EmbeddingClient, type EmbeddingConfig, type IHost, type IIndexer, type ISession, type IndexSearchOptions, type IndexSearchResult, type IndexStatus, type LLMClient, MODE_TOOL_GROUPS, McpClient, type McpServerConfig, type MessagePart, type Mode, type ModeConfig, type NexusConfig, NexusConfigSchema, ParallelAgentManager, type PermissionResult, ProjectRegistry, type ProviderConfig, READ_ONLY_TOOLS, Session, type SessionMessage, type SkillDef, type SymbolKind, TOOL_GROUP_MEMBERS, type ToolContext, type ToolDef, type ToolPart, ToolRegistry, type ToolResult, buildSystemPrompt, classifySkills, classifyTools, createCompaction, createEmbeddingClient, createLLMClient, createSpawnAgentTool, ensureGlobalConfigDir, estimateTokens, generateSessionId, getAllBuiltinTools, getBuiltinToolsForMode, getGlobalConfigDir, getIndexDir, listSessions, loadConfig, loadRules, loadSkills, parseMentions, runAgentLoop, setMcpClientInstance, writeConfig };
