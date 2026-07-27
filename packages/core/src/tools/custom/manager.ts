import { builtinModules } from "node:module"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import type { Plugin as EsbuildPlugin } from "esbuild"

import type {
  Mode,
  NexusConfig,
  PluginManifestRecord,
  ToolDef,
  ToolIntegrationProvenance,
} from "../../types.js"
import { getNexusDataDir } from "../../data-dir.js"
import {
  assertMcpToolSchemaBounds,
  buildMcpToolSchema,
} from "../../mcp/payload-limits.js"
import {
  loadTrustedPluginRuntimeRecords,
} from "../../plugins/runtime.js"
import type { PluginTrustStoreOptions } from "../../plugins/trust.js"
import { ToolRegistry } from "../registry.js"
import {
  IsolatedToolModule,
  type IsolatedToolDescriptor,
} from "./isolated-runtime.js"
import {
  CustomToolTrustStore,
  DEFAULT_EXECUTABLE_TREE_LIMITS,
  stageExecutableTree,
  type CustomToolTrustStoreOptions,
  type ExecutableTreeLimits,
  type StagedExecutableTree,
} from "./tree-trust.js"

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
])
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const MAX_DESCRIPTION_CHARS = 2_048
const MAX_SEARCH_HINT_CHARS = 1_024
const MAX_ENTRY_MODULES = 256
const PLUGIN_TREE_FINGERPRINT_VERSION = "nexus-plugin-tree-v1"
const ALLOWED_CUSTOM_MODES = new Set<Mode>(["agent", "debug"])
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

export type ToolContributionDiagnosticCode =
  | "source-unsafe"
  | "source-untrusted"
  | "plugin-trust-missing"
  | "plugin-content-mismatch"
  | "no-entry-modules"
  | "too-many-entry-modules"
  | "bundler-unavailable"
  | "module-compile-failed"
  | "module-load-failed"
  | "invalid-name"
  | "reserved-name"
  | "duplicate-name"
  | "invalid-description"
  | "invalid-search-hint"
  | "invalid-modes"
  | "invalid-schema"

export interface ToolContributionDiagnostic {
  level: "warning" | "error"
  code: ToolContributionDiagnosticCode
  sourceId: string
  sourcePath: string
  message: string
  toolName?: string
  modulePath?: string
}

export interface ToolContributionSnapshot {
  readonly generation: string
  readonly fingerprint: string
  readonly tools: readonly ToolDef[]
  readonly diagnostics: readonly ToolContributionDiagnostic[]
}

export interface WorkspaceToolContributionManagerOptions {
  runtimeRoot?: string
  trustStore?: CustomToolTrustStore
  trustStoreOptions?: CustomToolTrustStoreOptions
  pluginTrustOptions?: PluginTrustStoreOptions
  treeLimits?: Partial<ExecutableTreeLimits>
  loadTimeoutMs?: number
  callTimeoutMs?: number
  loadPlugins?: (
    cwd: string,
    config: NexusConfig,
  ) => Promise<PluginManifestRecord[]>
}

/** Attach one already-materialized generation without re-reading live files. */
export function registerToolContributionSnapshot(
  registry: ToolRegistry,
  snapshot: ToolContributionSnapshot,
  source = "custom/plugin contribution",
): void {
  for (const tool of snapshot.tools) {
    registry.registerDynamicOrThrow(tool, source)
  }
}

interface PreparedSource {
  kind: "custom" | "plugin"
  pluginName?: string
  sourceId: string
  sourcePath: string
  fingerprint: string
  staged: StagedExecutableTree
  entryPaths: string[]
}

interface CompiledModule {
  source: PreparedSource
  entryPath: string
  bundlePath: string
  bundleFingerprint: string
}

interface CandidateTool {
  source: PreparedSource
  compiled: CompiledModule
  runtime: IsolatedToolModule
  descriptor: IsolatedToolDescriptor
  modes: Mode[]
  parameters: ToolDef["parameters"]
}

interface GenerationRuntime {
  root: string
  modules: Set<IsolatedToolModule>
  snapshot: ToolContributionSnapshot
  closed: boolean
}

export class WorkspaceToolContributionManagerClosedError extends Error {
  constructor() {
    super("Workspace tool contribution manager is closed")
    this.name = "WorkspaceToolContributionManagerClosedError"
  }
}

class CustomToolBundlerUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The installed Nexus runtime does not provide the required esbuild bundler",
      options,
    )
    this.name = "CustomToolBundlerUnavailableError"
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function sha256(...parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return `sha256:${hash.digest("hex")}`
}

function diagnostic(
  source: Pick<PreparedSource, "sourceId" | "sourcePath">,
  input: Omit<ToolContributionDiagnostic, "sourceId" | "sourcePath">,
): ToolContributionDiagnostic {
  return {
    sourceId: source.sourceId,
    sourcePath: source.sourcePath,
    ...input,
  }
}

async function discoverEntryModules(target: string): Promise<string[]> {
  const stats = await lstat(target)
  if (stats.isFile()) {
    return SUPPORTED_EXTENSIONS.has(path.extname(target).toLowerCase())
      ? [target]
      : []
  }
  if (!stats.isDirectory()) return []
  const children = await readdir(target, { withFileTypes: true })
  return children
    .filter(
      (entry) =>
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => path.join(target, entry.name))
    .sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    )
}

function pathPolicyPlugin(sourceRoot: string): EsbuildPlugin {
  return {
    name: "nexus-custom-tool-path-policy",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined
        if (NODE_BUILTINS.has(args.path)) {
          return { path: args.path, external: true }
        }
        if (args.path.startsWith(".") || path.isAbsolute(args.path)) {
          const candidate = path.resolve(args.resolveDir, args.path)
          if (isPathInside(sourceRoot, candidate)) return undefined
          return {
            errors: [{
              text:
                `Import escapes the trusted custom tool source: ${args.path}`,
            }],
          }
        }
        return {
          errors: [{
            text:
              `Bare package imports are not allowed in P0 custom tools: ${args.path}`,
          }],
        }
      })
    },
  }
}

async function compileEntry(
  source: PreparedSource,
  entryPath: string,
  outputPath: string,
): Promise<CompiledModule> {
  let esbuild: typeof import("esbuild")
  try {
    esbuild = await import("esbuild")
  } catch (error) {
    throw new CustomToolBundlerUnavailableError({ cause: error })
  }
  const sourceRoot = source.staged.kind === "directory"
    ? source.staged.stagedPath
    : path.dirname(source.staged.stagedPath)
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    plugins: [pathPolicyPlugin(sourceRoot)],
  })
  const output = result.outputFiles?.find((file) =>
    file.path.endsWith(".js")
  ) ?? result.outputFiles?.[0]
  if (!output) throw new Error("esbuild produced no JavaScript output")
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  await writeFile(outputPath, output.contents, {
    flag: "wx",
    mode: 0o600,
  })
  return {
    source,
    entryPath,
    bundlePath: outputPath,
    bundleFingerprint: sha256(output.contents),
  }
}

function validateModes(
  descriptor: IsolatedToolDescriptor,
): Mode[] | undefined {
  if (descriptor.modes === undefined) return ["agent", "debug"]
  if (
    !Array.isArray(descriptor.modes) ||
    descriptor.modes.length === 0 ||
    descriptor.modes.length > 2
  ) {
    return undefined
  }
  const modes: Mode[] = []
  for (const value of descriptor.modes) {
    if (
      typeof value !== "string" ||
      !ALLOWED_CUSTOM_MODES.has(value as Mode)
    ) {
      return undefined
    }
    if (!modes.includes(value as Mode)) modes.push(value as Mode)
  }
  return modes
}

function approvalContent(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args).slice(0, 4_096)
  } catch {
    return "[unserializable custom tool arguments]"
  }
}

function customApproval(
  source: PreparedSource,
  toolName: string,
): NonNullable<ToolDef["approval"]> {
  return {
    capability: "plugin",
    alwaysPrompt: true,
    description: () =>
      source.kind === "plugin"
        ? `Run trusted plugin tool ${source.pluginName}/${toolName}`
        : `Run trusted local custom tool ${toolName}`,
    content: approvalContent,
    warning: () =>
      "This invokes exact-content trusted local code in an isolated worker. " +
      "The worker is a crash boundary, not an operating-system security sandbox.",
  }
}

function integrationFor(
  candidate: CandidateTool,
  generation: string,
): ToolIntegrationProvenance {
  const common = {
    sourceId: candidate.source.sourceId,
    sourcePath: candidate.source.sourcePath,
    fingerprint: candidate.source.fingerprint,
    bundleFingerprint: candidate.compiled.bundleFingerprint,
    generation,
  }
  return candidate.source.kind === "plugin"
    ? {
        kind: "plugin",
        pluginName: candidate.source.pluginName!,
        ...common,
      }
    : {
        kind: "custom",
        ...common,
      }
}

export class WorkspaceToolContributionManager {
  readonly runtimeRoot: string
  readonly trustStore: CustomToolTrustStore
  private readonly pluginTrustOptions: PluginTrustStoreOptions
  private readonly treeLimits: Partial<ExecutableTreeLimits>
  private readonly loadTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly loadPlugins: NonNullable<
    WorkspaceToolContributionManagerOptions["loadPlugins"]
  >
  private readonly generations = new Set<GenerationRuntime>()
  private currentSourceKey: string | undefined
  private current: GenerationRuntime | undefined
  private closed = false
  private materializationTail: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined

  constructor(options: WorkspaceToolContributionManagerOptions = {}) {
    this.runtimeRoot = path.resolve(
      options.runtimeRoot ??
        path.join(getNexusDataDir(), "runtime", "custom-tools"),
    )
    this.trustStore =
      options.trustStore ??
      new CustomToolTrustStore(options.trustStoreOptions)
    this.pluginTrustOptions = options.pluginTrustOptions ?? {}
    this.treeLimits = {
      ...DEFAULT_EXECUTABLE_TREE_LIMITS,
      ...options.treeLimits,
    }
    this.loadTimeoutMs = options.loadTimeoutMs ?? 5_000
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.loadTimeoutMs) || this.loadTimeoutMs <= 0) {
      throw new TypeError("loadTimeoutMs must be a positive safe integer")
    }
    if (!Number.isSafeInteger(this.callTimeoutMs) || this.callTimeoutMs <= 0) {
      throw new TypeError("callTimeoutMs must be a positive safe integer")
    }
    this.loadPlugins =
      options.loadPlugins ??
      ((cwd, config) =>
        loadTrustedPluginRuntimeRecords(
          cwd,
          config,
          this.pluginTrustOptions,
        ))
  }

  /**
   * Force the next turn to rematerialize even when source bytes are unchanged.
   * Existing snapshots remain executable until workspace shutdown.
   */
  invalidate(): void {
    this.currentSourceKey = undefined
  }

  async materialize(
    cwd: string,
    config: NexusConfig,
  ): Promise<ToolContributionSnapshot> {
    if (this.closed) {
      throw new WorkspaceToolContributionManagerClosedError()
    }
    const operation = this.materializationTail.then(() => {
      if (this.closed) {
        throw new WorkspaceToolContributionManagerClosedError()
      }
      return this.materializeOnce(cwd, config)
    })
    this.materializationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async materializeOnce(
    cwd: string,
    config: NexusConfig,
  ): Promise<ToolContributionSnapshot> {
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 })
    const generationRoot = await mkdtemp(
      path.join(this.runtimeRoot, "generation-"),
    )
    const diagnostics: ToolContributionDiagnostic[] = []
    const prepared: PreparedSource[] = []
    const sourceKeyParts: string[] = [path.resolve(cwd)]

    const customPaths = [...new Set(config.tools.custom.map((value) =>
      path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(cwd, value)
    ))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))

    for (const [index, sourcePath] of customPaths.entries()) {
      const placeholder = {
        sourceId: `custom:${sourcePath}`,
        sourcePath,
      }
      try {
        const staged = await stageExecutableTree(
          sourcePath,
          path.join(generationRoot, "sources", `custom-${index}`),
          { limits: this.treeLimits },
        )
        const trust = await this.trustStore.evaluateSnapshot(staged)
        sourceKeyParts.push(
          `custom\0${sourcePath}\0${staged.fingerprint}\0${trust.reason}\0${trust.grantId ?? ""}`,
        )
        if (!trust.trusted) {
          diagnostics.push(diagnostic(placeholder, {
            level: "warning",
            code: "source-untrusted",
            message:
              `Custom tool source is inactive until its exact content is trusted (${trust.reason}).`,
          }))
          continue
        }
        const entryPaths = await discoverEntryModules(staged.stagedPath)
        const source: PreparedSource = {
          kind: "custom",
          sourceId: `custom:${staged.canonicalPath}`,
          sourcePath: staged.canonicalPath,
          fingerprint: staged.fingerprint,
          staged,
          entryPaths,
        }
        this.validateEntryCount(source, diagnostics)
        if (
          entryPaths.length > 0 &&
          entryPaths.length <= MAX_ENTRY_MODULES
        ) {
          prepared.push(source)
        }
      } catch (error) {
        sourceKeyParts.push(`custom\0${sourcePath}\0unsafe\0${String(error)}`)
        diagnostics.push(diagnostic(placeholder, {
          level: "error",
          code: "source-unsafe",
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    let plugins: PluginManifestRecord[] = []
    try {
      plugins = await this.loadPlugins(cwd, config)
    } catch (error) {
      const source = { sourceId: "plugins", sourcePath: path.resolve(cwd) }
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "source-unsafe",
        message:
          `Could not resolve trusted plugin tools: ${
            error instanceof Error ? error.message : String(error)
          }`,
      }))
      sourceKeyParts.push(`plugins\0error\0${String(error)}`)
    }
    const toolPlugins = plugins
      .filter((plugin) => (plugin.tools?.length ?? 0) > 0)
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const [index, plugin] of toolPlugins.entries()) {
      const placeholder = {
        sourceId: `plugin:${plugin.name}`,
        sourcePath: path.resolve(plugin.rootDir),
      }
      if (!plugin.trustFingerprint) {
        sourceKeyParts.push(`plugin\0${plugin.name}\0missing-trust`)
        diagnostics.push(diagnostic(placeholder, {
          level: "error",
          code: "plugin-trust-missing",
          message:
            "Trusted plugin runtime record did not include an exact tree fingerprint.",
        }))
        continue
      }
      try {
        const staged = await stageExecutableTree(
          plugin.rootDir,
          path.join(generationRoot, "sources", `plugin-${index}`),
          {
            limits: this.treeLimits,
            fingerprintVersion: PLUGIN_TREE_FINGERPRINT_VERSION,
          },
        )
        sourceKeyParts.push(
          `plugin\0${plugin.name}\0${staged.fingerprint}\0${plugin.trustFingerprint}`,
        )
        if (staged.fingerprint !== plugin.trustFingerprint) {
          diagnostics.push(diagnostic(placeholder, {
            level: "error",
            code: "plugin-content-mismatch",
            message:
              "Plugin bytes changed between trust evaluation and executable staging.",
          }))
          continue
        }
        const entrySet = new Set<string>()
        for (const declared of plugin.tools ?? []) {
          const originalTarget = path.resolve(plugin.rootDir, declared)
          if (!isPathInside(path.resolve(plugin.rootDir), originalTarget)) {
            throw new Error(`Plugin tool path escapes root: ${declared}`)
          }
          const relative = path.relative(
            path.resolve(plugin.rootDir),
            originalTarget,
          )
          const stagedTarget = path.resolve(staged.stagedPath, relative)
          if (!isPathInside(staged.stagedPath, stagedTarget)) {
            throw new Error(`Plugin tool path escapes staged root: ${declared}`)
          }
          for (const entry of await discoverEntryModules(stagedTarget)) {
            entrySet.add(entry)
          }
        }
        const source: PreparedSource = {
          kind: "plugin",
          pluginName: plugin.name,
          sourceId: `plugin:${plugin.name}`,
          sourcePath: staged.canonicalPath,
          fingerprint: staged.fingerprint,
          staged,
          entryPaths: [...entrySet].sort((left, right) =>
            Buffer.from(left).compare(Buffer.from(right))
          ),
        }
        this.validateEntryCount(source, diagnostics)
        if (
          source.entryPaths.length > 0 &&
          source.entryPaths.length <= MAX_ENTRY_MODULES
        ) {
          prepared.push(source)
        }
      } catch (error) {
        sourceKeyParts.push(
          `plugin\0${plugin.name}\0unsafe\0${String(error)}`,
        )
        diagnostics.push(diagnostic(placeholder, {
          level: "error",
          code: "source-unsafe",
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    const sourceKey = sha256(
      "nexus-tool-contribution-source-v1\0",
      ...sourceKeyParts.sort(),
    )
    if (this.current && this.currentSourceKey === sourceKey) {
      await rm(generationRoot, { recursive: true, force: true })
      return this.current.snapshot
    }

    const modules = new Set<IsolatedToolModule>()
    const compiled: CompiledModule[] = []
    let moduleOrdinal = 0
    for (const source of prepared) {
      for (const entryPath of source.entryPaths) {
        const bundlePath = path.join(
          generationRoot,
          "bundles",
          `${moduleOrdinal.toString().padStart(4, "0")}.mjs`,
        )
        moduleOrdinal += 1
        try {
          compiled.push(
            await compileEntry(source, entryPath, bundlePath),
          )
        } catch (error) {
          diagnostics.push(diagnostic(source, {
            level: "error",
            code:
              error instanceof CustomToolBundlerUnavailableError
                ? "bundler-unavailable"
                : "module-compile-failed",
            modulePath: entryPath,
            message: error instanceof Error ? error.message : String(error),
          }))
        }
      }
    }

    const provisionalGeneration = sha256(
      sourceKey,
      ...compiled.map((item) =>
        `${item.source.sourceId}\0${item.entryPath}\0${item.bundleFingerprint}`
      ),
    )
    const candidates: CandidateTool[] = []
    for (const item of compiled) {
      try {
        const loaded = await IsolatedToolModule.load(item.bundlePath, {
          generation: provisionalGeneration,
          loadTimeoutMs: this.loadTimeoutMs,
          callTimeoutMs: this.callTimeoutMs,
        })
        modules.add(loaded.runtime)
        for (const descriptor of loaded.descriptors) {
          const validated = this.validateDescriptor(
            item,
            loaded.runtime,
            descriptor,
            diagnostics,
          )
          if (validated) candidates.push(validated)
        }
      } catch (error) {
        diagnostics.push(diagnostic(item.source, {
          level: "error",
          code: "module-load-failed",
          modulePath: item.entryPath,
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    const generation = sha256(
      "nexus-tool-contribution-generation-v1\0",
      provisionalGeneration,
      ...candidates.map((candidate) =>
        JSON.stringify({
          sourceId: candidate.source.sourceId,
          bundle: candidate.compiled.bundleFingerprint,
          exportId: candidate.descriptor.exportId,
          name: candidate.descriptor.name,
          description: candidate.descriptor.description,
          inputSchema: candidate.descriptor.inputSchema,
          modes: candidate.modes,
        })
      ),
    )
    const byName = new Map<string, CandidateTool[]>()
    for (const candidate of candidates) {
      const list = byName.get(candidate.descriptor.name) ?? []
      list.push(candidate)
      byName.set(candidate.descriptor.name, list)
    }

    const tools: ToolDef[] = []
    const usedModules = new Set<IsolatedToolModule>()
    const registrationProbe = new ToolRegistry()
    for (const name of [...byName.keys()].sort()) {
      const matching = byName.get(name)!
      if (matching.length > 1) {
        diagnostics.push(diagnostic(matching[0]!.source, {
          level: "error",
          code: "duplicate-name",
          toolName: name,
          message:
            `Custom/plugin tool name "${name}" is declared ${matching.length} times; every conflicting declaration was dropped.`,
        }))
        continue
      }
      const candidate = matching[0]!
      const tool = this.toolFromCandidate(candidate, generation)
      const registration = registrationProbe.registerDynamic(tool)
      if (!registration.ok) {
        diagnostics.push(diagnostic(candidate.source, {
          level: "error",
          code:
            registration.reason === "reserved-name"
              ? "reserved-name"
              : "duplicate-name",
          toolName: name,
          message:
            `Custom/plugin tool name "${name}" is ${registration.reason}.`,
        }))
        continue
      }
      tools.push(Object.freeze(tool))
      usedModules.add(candidate.runtime)
    }
    await Promise.all(
      [...modules]
        .filter((runtime) => !usedModules.has(runtime))
        .map((runtime) => runtime.close()),
    )
    for (const runtime of [...modules]) {
      if (!usedModules.has(runtime)) modules.delete(runtime)
    }

    const snapshot: ToolContributionSnapshot = Object.freeze({
      generation,
      fingerprint: sourceKey,
      tools: Object.freeze(tools),
      diagnostics: Object.freeze(diagnostics),
    })
    const runtime: GenerationRuntime = {
      root: generationRoot,
      modules,
      snapshot,
      closed: false,
    }
    this.generations.add(runtime)
    this.current = runtime
    this.currentSourceKey = sourceKey
    return snapshot
  }

  private validateEntryCount(
    source: PreparedSource,
    diagnostics: ToolContributionDiagnostic[],
  ): void {
    if (source.entryPaths.length === 0) {
      diagnostics.push(diagnostic(source, {
        level: "warning",
        code: "no-entry-modules",
        message:
          "Executable source contains no top-level .js/.mjs/.cjs/.ts/.mts/.cts tool modules.",
      }))
    } else if (source.entryPaths.length > MAX_ENTRY_MODULES) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "too-many-entry-modules",
        message:
          `Executable source exceeds ${MAX_ENTRY_MODULES} entry modules.`,
      }))
    }
  }

  private validateDescriptor(
    compiled: CompiledModule,
    runtime: IsolatedToolModule,
    descriptor: IsolatedToolDescriptor,
    diagnostics: ToolContributionDiagnostic[],
  ): CandidateTool | undefined {
    const source = compiled.source
    if (
      descriptor.name !== descriptor.name.trim() ||
      !TOOL_NAME_PATTERN.test(descriptor.name)
    ) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "invalid-name",
        toolName: descriptor.name,
        modulePath: compiled.entryPath,
        message:
          "Tool name must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$ without surrounding whitespace.",
      }))
      return undefined
    }
    if (
      descriptor.name === "mcp" ||
      descriptor.name.startsWith("mcp__")
    ) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "reserved-name",
        toolName: descriptor.name,
        modulePath: compiled.entryPath,
        message: `Tool name "${descriptor.name}" is reserved.`,
      }))
      return undefined
    }
    if (
      descriptor.description !== descriptor.description.trim() ||
      descriptor.description.length === 0 ||
      descriptor.description.length > MAX_DESCRIPTION_CHARS
    ) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "invalid-description",
        toolName: descriptor.name,
        modulePath: compiled.entryPath,
        message:
          `Tool description must contain 1-${MAX_DESCRIPTION_CHARS} trimmed characters.`,
      }))
      return undefined
    }
    if (
      descriptor.searchHint !== undefined &&
      (descriptor.searchHint !== descriptor.searchHint.trim() ||
        descriptor.searchHint.length === 0 ||
        descriptor.searchHint.length > MAX_SEARCH_HINT_CHARS)
    ) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "invalid-search-hint",
        toolName: descriptor.name,
        modulePath: compiled.entryPath,
        message:
          `Tool searchHint must contain 1-${MAX_SEARCH_HINT_CHARS} trimmed characters.`,
      }))
      return undefined
    }
    const modes = validateModes(descriptor)
    if (!modes) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "invalid-modes",
        toolName: descriptor.name,
        modulePath: compiled.entryPath,
        message:
          "P0 custom/plugin tools may declare only non-empty agent/debug mode subsets.",
      }))
      return undefined
    }
    try {
      if (descriptor.inputSchema.type !== "object") {
        throw new Error("root inputSchema.type must be object")
      }
      assertMcpToolSchemaBounds(
        descriptor.inputSchema,
        descriptor.name,
      )
      const parameters = buildMcpToolSchema(descriptor.inputSchema)
      return {
        source,
        compiled,
        runtime,
        descriptor,
        modes,
        parameters,
      }
    } catch (error) {
      diagnostics.push(diagnostic(source, {
        level: "error",
        code: "invalid-schema",
        toolName: descriptor.name,
        modulePath: compiled.entryPath,
        message: error instanceof Error ? error.message : String(error),
      }))
      return undefined
    }
  }

  private toolFromCandidate(
    candidate: CandidateTool,
    generation: string,
  ): ToolDef {
    const integration = Object.freeze(
      integrationFor(candidate, generation),
    )
    const modes = Object.freeze([...candidate.modes]) as Mode[]
    const approval = Object.freeze(
      customApproval(candidate.source, candidate.descriptor.name),
    )
    return {
      name: candidate.descriptor.name,
      description: candidate.descriptor.description,
      parameters: candidate.parameters,
      ...(candidate.descriptor.searchHint
        ? { searchHint: candidate.descriptor.searchHint }
        : {}),
      ...(candidate.descriptor.shouldDefer === true
        ? { shouldDefer: true }
        : {}),
      // Arbitrary local code cannot prove that it is read-only. Restricting
      // modes remains host-owned even when the descriptor claims readOnly.
      readOnly: false,
      modes,
      integration,
      requiresApproval: true,
      approval,
      execute: (args, context) =>
        candidate.runtime.call(
          candidate.descriptor.exportId,
          args,
          {
            cwd: context.cwd,
            mode: context.mode,
            signal: context.signal,
          },
        ),
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      await this.materializationTail
      const runtimes = [...this.generations]
      this.generations.clear()
      this.current = undefined
      this.currentSourceKey = undefined
      const errors: unknown[] = []
      for (const runtime of runtimes) {
        if (runtime.closed) continue
        runtime.closed = true
        const results = await Promise.allSettled([
          ...[...runtime.modules].map((module) => module.close()),
          rm(runtime.root, { recursive: true, force: true }),
        ])
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Failed to close workspace tool contribution generations",
        )
      }
    })()
    return this.closePromise
  }
}
