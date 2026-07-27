import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as yaml from "js-yaml"
import {
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"

export type ConfigLayerKind = "global" | "project"

export type ConfigSubstitutionErrorCode =
  | "project-env-forbidden"
  | "missing-env"
  | "missing-file"
  | "unreadable-file"
  | "project-file-outside-workspace"
  | "file-changed-during-read"

export class ConfigSubstitutionError extends Error {
  constructor(
    readonly code: ConfigSubstitutionErrorCode,
    readonly configPath: string,
    readonly reference: string,
    cause?: unknown,
  ) {
    super(
      code === "project-env-forbidden"
        ? `Project config cannot use environment substitution ${reference}: ${configPath}`
        : code === "missing-env"
          ? `Config environment substitution is not defined ${reference}: ${configPath}`
          : code === "project-file-outside-workspace"
            ? `Project config file substitution escapes the canonical workspace ${reference}: ${configPath}`
            : code === "file-changed-during-read"
              ? `Config file substitution changed while it was being read ${reference}: ${configPath}`
              : `Config file substitution could not be read ${reference}: ${configPath}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "ConfigSubstitutionError"
  }
}

export class ConfigFileError extends Error {
  constructor(
    readonly configPath: string,
    message: string,
    cause?: unknown,
  ) {
    super(
      `Failed to load config ${configPath}: ${message}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "ConfigFileError"
  }
}

export interface ConfigLayerReadOptions {
  layer: ConfigLayerKind
  resolveExternalValues: boolean
  environment: Readonly<Record<string, string | undefined>>
  workspaceRoot?: string
}

const ENV_SUBSTITUTION = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const FILE_SUBSTITUTION = /\{file:([^}]+)\}/g

function isWithinCanonicalRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

function canonicalWorkspaceRoot(
  workspaceRoot: string | undefined,
  configPath: string,
): string {
  if (!workspaceRoot) {
    throw new ConfigFileError(
      configPath,
      "project config requires an explicit workspace root",
    )
  }
  try {
    return fs.realpathSync(workspaceRoot)
  } catch (error) {
    throw new ConfigFileError(
      configPath,
      `workspace root is not readable: ${workspaceRoot}`,
      error,
    )
  }
}

function readOpenedCanonicalFile(
  requestedPath: string,
  configPath: string,
  reference: string,
  workspaceRoot?: string,
): string {
  const canonicalRoot = workspaceRoot
    ? canonicalWorkspaceRoot(workspaceRoot, configPath)
    : undefined
  if (
    workspaceRoot &&
    !isWithinCanonicalRoot(
      path.resolve(workspaceRoot),
      path.resolve(requestedPath),
    )
  ) {
    throw new ConfigSubstitutionError(
      "project-file-outside-workspace",
      configPath,
      reference,
    )
  }

  let canonicalPath: string
  try {
    canonicalPath = fs.realpathSync(requestedPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new ConfigSubstitutionError(
      code === "ENOENT" ? "missing-file" : "unreadable-file",
      configPath,
      reference,
      error,
    )
  }

  if (
    canonicalRoot &&
    !isWithinCanonicalRoot(canonicalRoot, canonicalPath)
  ) {
    throw new ConfigSubstitutionError(
      "project-file-outside-workspace",
      configPath,
      reference,
    )
  }

  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(
      canonicalPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    )
    const opened = fs.fstatSync(descriptor)
    const canonicalAfterOpen = fs.realpathSync(canonicalPath)
    if (
      canonicalRoot &&
      !isWithinCanonicalRoot(canonicalRoot, canonicalAfterOpen)
    ) {
      throw new ConfigSubstitutionError(
        "project-file-outside-workspace",
        configPath,
        reference,
      )
    }
    const current = fs.statSync(canonicalAfterOpen)
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new ConfigSubstitutionError(
        "file-changed-during-read",
        configPath,
        reference,
      )
    }
    return fs.readFileSync(descriptor, "utf8")
  } catch (error) {
    if (error instanceof ConfigSubstitutionError) throw error
    throw new ConfigSubstitutionError(
      "unreadable-file",
      configPath,
      reference,
      error,
    )
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function readConfigText(
  configPath: string,
  options: ConfigLayerReadOptions,
): string | null {
  if (!fs.existsSync(configPath)) return null
  if (options.layer === "global") {
    try {
      return fs.readFileSync(configPath, "utf8")
    } catch (error) {
      throw new ConfigFileError(configPath, "file is unreadable", error)
    }
  }

  const canonicalRoot = canonicalWorkspaceRoot(
    options.workspaceRoot,
    configPath,
  )
  let canonicalConfigPath: string
  try {
    canonicalConfigPath = fs.realpathSync(configPath)
  } catch (error) {
    throw new ConfigFileError(configPath, "file is unreadable", error)
  }
  if (!isWithinCanonicalRoot(canonicalRoot, canonicalConfigPath)) {
    throw new ConfigFileError(
      configPath,
      "project config resolves outside the canonical workspace",
    )
  }
  try {
    return fs.readFileSync(canonicalConfigPath, "utf8")
  } catch (error) {
    throw new ConfigFileError(configPath, "file is unreadable", error)
  }
}

function substituteExternalValues(
  content: string,
  configPath: string,
  options: ConfigLayerReadOptions,
): string {
  if (!options.resolveExternalValues) return content

  const withEnvironment = content.replace(
    ENV_SUBSTITUTION,
    (reference: string, variableName: string) => {
      if (options.layer === "project") {
        throw new ConfigSubstitutionError(
          "project-env-forbidden",
          configPath,
          reference,
        )
      }
      const value = options.environment[variableName]
      if (value === undefined) {
        throw new ConfigSubstitutionError(
          "missing-env",
          configPath,
          reference,
        )
      }
      return value
    },
  )

  return withEnvironment.replace(
    FILE_SUBSTITUTION,
    (reference: string, rawReference: string) => {
      const configDirectory = path.dirname(configPath)
      const trimmed = rawReference.trim()
      let requestedPath: string
      if (trimmed.startsWith("~/")) {
        requestedPath = path.join(os.homedir(), trimmed.slice(2))
      } else {
        requestedPath = path.isAbsolute(trimmed)
          ? trimmed
          : path.resolve(configDirectory, trimmed)
      }
      const fileContent = readOpenedCanonicalFile(
        requestedPath,
        configPath,
        reference,
        options.layer === "project" ? options.workspaceRoot : undefined,
      ).trim()
      // Preserve the historical contract: file substitutions are escaped for
      // their usual quoted YAML/JSON scalar position.
      return JSON.stringify(fileContent).slice(1, -1)
    },
  )
}

function parseConfigDocument(
  content: string,
  configPath: string,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = configPath.endsWith(".json")
      ? JSON.parse(content)
      : yaml.load(content)
  } catch (error) {
    throw new ConfigFileError(configPath, "document is malformed", error)
  }
  if (parsed === undefined || parsed === null) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFileError(configPath, "document root must be an object")
  }
  return parsed as Record<string, unknown>
}

export function readConfigLayerFile(
  configPath: string,
  options: ConfigLayerReadOptions,
): Record<string, unknown> | null {
  const content = readConfigText(configPath, options)
  if (content === null) return null
  return parseConfigDocument(
    substituteExternalValues(content, configPath, options),
    configPath,
  )
}

export function readRawConfigFile(
  configPath: string,
): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return null
  let content: string
  try {
    content = fs.readFileSync(configPath, "utf8")
  } catch (error) {
    throw new ConfigFileError(configPath, "file is unreadable", error)
  }
  return parseConfigDocument(content, configPath)
}

export function loadScopedEnvironment(
  startDirectory: string,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  const scoped: Record<string, string | undefined> = { ...ambient }
  let directory = path.resolve(startDirectory)
  let remaining = 20
  while (remaining-- > 0) {
    const envPath = path.join(directory, ".env")
    if (fs.existsSync(envPath)) {
      let content: string
      try {
        content = fs.readFileSync(envPath, "utf8")
      } catch (error) {
        throw new ConfigFileError(envPath, "file is unreadable", error)
      }
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue
        const match = line.match(
          /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
        )
        if (!match) continue
        const key = match[1]!
        if (scoped[key] !== undefined) continue
        let value = match[2] ?? ""
        if (
          (value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        scoped[key] = value
      }
      break
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return Object.freeze(scoped)
}

export function mergeRawConfigPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = result[key]
    result[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
        ? mergeRawConfigPatch(
            baseValue as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value
  }
  return result
}

function dumpConfigDocument(config: Record<string, unknown>): string {
  return yaml.dump(config, { indent: 2, lineWidth: 120 })
}

export async function writeRawConfigFile(
  configPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  await atomicWriteFile(configPath, dumpConfigDocument(config), {
    mode: 0o600,
  })
}

export async function patchRawConfigFile(
  configPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withFileLock(configPath, async () => {
    const current = readRawConfigFile(configPath) ?? {}
    await writeRawConfigFile(
      configPath,
      mergeRawConfigPatch(current, patch),
    )
  })
}

export function writeRawConfigFileSync(
  configPath: string,
  config: Record<string, unknown>,
): void {
  writeAtomicTextFileSync(configPath, dumpConfigDocument(config))
}

export function writeAtomicTextFileSync(
  targetPath: string,
  content: string,
  mode = 0o600,
): void {
  const resolved = path.resolve(targetPath)
  const directory = path.dirname(resolved)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY,
      mode,
    )
    fs.writeFileSync(descriptor, content, "utf8")
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, resolved)
    try {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY)
      try {
        fs.fsyncSync(directoryDescriptor)
      } finally {
        fs.closeSync(directoryDescriptor)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        code !== "EINVAL" &&
        code !== "ENOTSUP" &&
        code !== "EISDIR" &&
        code !== "EPERM"
      ) {
        throw error
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}
