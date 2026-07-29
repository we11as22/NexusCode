import { NexusConfigSchema } from "@nexuscode/core"

import {
  isLoopbackExternalHttpUrl,
  parseStrictExternalHttpUrl,
} from "./external-url-policy.js"
import type {
  MarketplaceItemReference,
  ParsedWebviewInboundMessage,
  WebviewDiagnosticMessage,
  WebviewMessage,
} from "./webview-protocol-types.js"

const MAX_TOTAL_STRING_CHARS = 24 * 1024 * 1024
const MAX_NODES = 20_000
const MAX_DEPTH = 16
const MAX_OBJECT_KEYS = 256
const MODES = ["agent", "plan", "ask", "debug", "review"] as const
const CONFIG_PATCH_SCHEMA = NexusConfigSchema.deepPartial()

type PlainRecord = Record<string, unknown>
type Rule = (value: unknown, path: string) => void

export class WebviewProtocolError extends Error {
  override readonly name = "WebviewProtocolError"

  constructor(
    readonly code:
      | "invalid_shape"
      | "unknown_type"
      | "unknown_field"
      | "invalid_field"
      | "payload_limit",
    message: string,
  ) {
    super(message)
  }
}

function fail(
  code: WebviewProtocolError["code"],
  message: string,
): never {
  throw new WebviewProtocolError(code, message)
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function inspectPayloadShape(
  value: unknown,
  state = { nodes: 0, chars: 0 },
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > MAX_DEPTH) {
    fail("payload_limit", `Webview payload exceeds depth limit ${MAX_DEPTH}`)
  }
  state.nodes += 1
  if (state.nodes > MAX_NODES) {
    fail("payload_limit", `Webview payload exceeds node limit ${MAX_NODES}`)
  }
  if (typeof value === "string") {
    state.chars += value.length
    if (state.chars > MAX_TOTAL_STRING_CHARS) {
      fail("payload_limit", "Webview payload is too large")
    }
    return
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return
  }
  if (typeof value !== "object") {
    fail("invalid_shape", "Webview payload contains an unsupported value")
  }
  if (seen.has(value)) {
    fail("invalid_shape", "Webview payload must not contain cycles")
  }
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > 2_048) {
      fail("payload_limit", "Webview payload array is too large")
    }
    for (const item of value) {
      inspectPayloadShape(item, state, depth + 1, seen)
    }
  } else {
    if (!isPlainRecord(value)) {
      fail("invalid_shape", "Webview payload objects must be plain records")
    }
    const entries = Object.entries(value)
    if (entries.length > MAX_OBJECT_KEYS) {
      fail("payload_limit", "Webview payload object has too many fields")
    }
    for (const [key, item] of entries) {
      state.chars += key.length
      if (state.chars > MAX_TOTAL_STRING_CHARS) {
        fail("payload_limit", "Webview payload is too large")
      }
      inspectPayloadShape(item, state, depth + 1, seen)
    }
  }
  seen.delete(value)
}

function exactRecord(
  value: unknown,
  path: string,
  required: Record<string, Rule>,
  optional: Record<string, Rule> = {},
): PlainRecord {
  if (!isPlainRecord(value)) {
    fail("invalid_shape", `${path} must be an object`)
  }
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unknown_field", `${path} contains unknown field "${key}"`)
    }
  }
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("invalid_field", `${path}.${key} is required`)
    }
    rule(value[key], `${path}.${key}`)
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (
      Object.prototype.hasOwnProperty.call(value, key) &&
      value[key] !== undefined
    ) {
      rule(value[key], `${path}.${key}`)
    }
  }
  return value
}

const stringRule =
  (max: number, min = 0): Rule =>
  (value, path) => {
    if (
      typeof value !== "string" ||
      value.length < min ||
      value.length > max
    ) {
      fail("invalid_field", `${path} must be a string of ${min}-${max} characters`)
    }
  }

const booleanRule: Rule = (value, path) => {
  if (typeof value !== "boolean") {
    fail("invalid_field", `${path} must be a boolean`)
  }
}

const numberRule =
  (min: number, max: number, integer = false): Rule =>
  (value, path) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      fail(
        "invalid_field",
        `${path} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`,
      )
    }
  }

const enumRule =
  <T extends readonly string[]>(values: T): Rule =>
  (value, path) => {
    if (typeof value !== "string" || !values.includes(value)) {
      fail("invalid_field", `${path} must be one of: ${values.join(", ")}`)
    }
  }

const arrayRule =
  (itemRule: Rule, max: number): Rule =>
  (value, path) => {
    if (!Array.isArray(value) || value.length > max) {
      fail("invalid_field", `${path} must be an array with at most ${max} items`)
    }
    value.forEach((item, index) => itemRule(item, `${path}[${index}]`))
  }

const identifierRule: Rule = (value, path) => {
  stringRule(512, 1)(value, path)
  if (/[\u0000-\u001f\u007f]/u.test(value as string)) {
    fail("invalid_field", `${path} contains control characters`)
  }
}

const pathRule: Rule = (value, fieldPath) => {
  stringRule(2_048, 1)(value, fieldPath)
  const raw = value as string
  if (/[\0\r\n]/u.test(raw)) {
    fail("invalid_field", `${fieldPath} is not a valid path`)
  }
  if (!/^[/\\]/u.test(raw) && raw.split(/[\\/]+/u).includes("..")) {
    fail("invalid_field", `${fieldPath} must not traverse outside its base`)
  }
}

const imageRule: Rule = (value, path) => {
  const image = exactRecord(
    value,
    path,
    { data: stringRule(8 * 1024 * 1024, 1), mimeType: stringRule(128, 1) },
  )
  if (!/^image\/[a-z0-9.+-]+$/iu.test(image["mimeType"] as string)) {
    fail("invalid_field", `${path}.mimeType must be an image MIME type`)
  }
}

const marketplaceReferenceRule: Rule = (value, path) => {
  exactRecord(
    value,
    path,
    { id: identifierRule, type: enumRule(["mcp", "skill"] as const) },
  )
}

const primitiveParametersRule: Rule = (value, path) => {
  if (!isPlainRecord(value) || Object.keys(value).length > 64) {
    fail("invalid_field", `${path} must be an object with at most 64 parameters`)
  }
  for (const [key, parameter] of Object.entries(value)) {
    if (
      key.length < 1 ||
      key.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(key)
    ) {
      fail("invalid_field", `${path} has an invalid parameter name`)
    }
    if (
      parameter !== null &&
      typeof parameter !== "string" &&
      typeof parameter !== "number" &&
      typeof parameter !== "boolean"
    ) {
      fail("invalid_field", `${path}.${key} must be a primitive value`)
    }
    if (typeof parameter === "string" && parameter.length > 16_384) {
      fail("payload_limit", `${path}.${key} is too large`)
    }
    if (typeof parameter === "number" && !Number.isFinite(parameter)) {
      fail("invalid_field", `${path}.${key} must be finite`)
    }
  }
}

const questionnaireAnswerRule: Rule = (value, path) => {
  const answer = exactRecord(
    value,
    path,
    { questionId: identifierRule },
    {
      optionId: identifierRule,
      optionLabel: stringRule(1_024),
      optionIds: arrayRule(identifierRule, 4),
      optionLabels: arrayRule(stringRule(1_024), 4),
      customText: stringRule(16_384),
    },
  )
  const hasSingle = answer["optionId"] !== undefined
  const hasMultiple = answer["optionIds"] !== undefined
  if (hasSingle === hasMultiple) {
    fail(
      "invalid_field",
      `${path} must contain exactly one of optionId or optionIds`,
    )
  }
  if (
    hasMultiple &&
    (answer["optionIds"] as unknown[]).length === 0
  ) {
    fail("invalid_field", `${path}.optionIds must not be empty`)
  }
}

const questionnaireAnswersRule: Rule = (value, path) => {
  arrayRule(questionnaireAnswerRule, 4)(value, path)
  const answers = value as Array<{ questionId: string }>
  if (answers.length === 0) {
    fail("invalid_field", `${path} must contain at least one answer`)
  }
  const questionIds = new Set<string>()
  for (const answer of answers) {
    if (questionIds.has(answer.questionId)) {
      fail(
        "invalid_field",
        `${path} contains duplicate questionId "${answer.questionId}"`,
      )
    }
    questionIds.add(answer.questionId)
  }
}

const presetRule: Rule = (value, path) => {
  exactRecord(
    value,
    path,
    {
      name: stringRule(128, 1),
      vector: booleanRule,
      skills: arrayRule(pathRule, 512),
      mcpServers: arrayRule(identifierRule, 512),
      rulesFiles: arrayRule(pathRule, 512),
    },
    {
      modelProvider: stringRule(128, 1),
      modelId: stringRule(512, 1),
    },
  )
}

function assertNoUnknownInputKeys(
  input: unknown,
  parsed: unknown,
  path: string,
): void {
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed)) return
    input.forEach((item, index) => {
      assertNoUnknownInputKeys(item, parsed[index], `${path}[${index}]`)
    })
    return
  }
  if (!isPlainRecord(input)) return
  if (!isPlainRecord(parsed)) return
  for (const [key, item] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      fail("unknown_field", `${path} contains unknown config field "${key}"`)
    }
    assertNoUnknownInputKeys(item, parsed[key], `${path}.${key}`)
  }
}

const configPatchRule: Rule = (value, path) => {
  if (!isPlainRecord(value)) {
    fail("invalid_field", `${path} must be an object`)
  }
  const config = { ...value }
  const skillsConfig = config["skillsConfig"]
  delete config["skillsConfig"]
  if (skillsConfig !== undefined) {
    arrayRule((item, itemPath) => {
      exactRecord(
        item,
        itemPath,
        { path: pathRule, enabled: booleanRule },
      )
    }, 512)(skillsConfig, `${path}.skillsConfig`)
  }
  const parsed = CONFIG_PATCH_SCHEMA.safeParse(config)
  if (!parsed.success) {
    fail(
      "invalid_field",
      `${path} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    )
  }
  assertNoUnknownInputKeys(config, parsed.data, path)
}

const autocompletePatchRule: Rule = (value, path) => {
  exactRecord(
    value,
    path,
    {},
    {
      enableAutoTrigger: booleanRule,
      useSeparateModel: booleanRule,
      modelProvider: stringRule(128),
      modelId: stringRule(512),
      modelApiKey: stringRule(16_384),
      modelBaseUrl: stringRule(4_096),
      modelTemperature: stringRule(64),
      modelReasoningEffort: stringRule(64),
      modelContextWindow: stringRule(64),
    },
  )
}

function validateRequest(message: PlainRecord): WebviewMessage {
  const type = message["type"]
  if (typeof type !== "string") {
    fail("invalid_shape", "Webview message type must be a string")
  }
  const none = () => exactRecord(message, "message", { type: enumRule([type]) })
  const one = (name: string, rule: Rule) =>
    exactRecord(message, "message", { type: enumRule([type]), [name]: rule })

  switch (type) {
    case "abort":
    case "compact":
    case "clearChat":
    case "getState":
    case "webviewDidLaunch":
    case "openSettings":
    case "createNewSession":
    case "reindex":
    case "clearIndex":
    case "fullRebuildIndex":
    case "pauseIndexing":
    case "resumeIndexing":
    case "openCursorignore":
    case "openMcpConfig":
    case "testMcpServers":
    case "openNexusignore":
    case "getModelsCatalog":
    case "getSlashCommandCatalog":
    case "reloadConfiguration":
    case "getAgentPresets":
    case "getAgentPresetOptions":
    case "loadOlderMessages":
    case "undoSessionEdits":
    case "keepAllSessionEdits":
      none()
      break
    case "newMessage":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          clientMessageId: identifierRule,
          content: stringRule(1_000_000),
          mode: enumRule(MODES),
        },
        {
          mentions: stringRule(128_000),
          images: arrayRule(imageRule, 8),
          presetName: stringRule(128),
        },
      )
      break
    case "setMode":
      one("mode", enumRule(MODES))
      break
    case "setProfile":
      one("profile", stringRule(256))
      break
    case "saveConfig":
      one("config", configPatchRule)
      break
    case "removeCredential":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          target: enumRule(["model", "embeddings", "qdrant", "profile"] as const),
        },
        { profileName: stringRule(256, 1) },
      )
      break
    case "switchSession":
    case "deleteSession":
      one("sessionId", identifierRule)
      break
    case "forkSession":
    case "rollbackToBeforeMessage":
      one("messageId", identifierRule)
      break
    case "openFileAtLocation":
      exactRecord(
        message,
        "message",
        { type: enumRule([type]), path: pathRule },
        {
          line: numberRule(1, 10_000_000, true),
          endLine: numberRule(1, 10_000_000, true),
        },
      )
      break
    case "showDiff":
    case "openSkillFolder":
    case "openSessionEditDiff":
    case "revertSessionEditFile":
    case "acceptSessionEditFile":
      one("path", pathRule)
      break
    case "setServerUrl":
      one("url", stringRule(4_096))
      if ((message["url"] as string).length > 0) {
        parseExternalHttpUrl(message["url"] as string)
      }
      break
    case "setServerToken":
      one("token", stringRule(16_384))
      break
    case "openNexusConfigFolder":
      one("scope", enumRule(["global", "project"] as const))
      break
    case "approvePendingMcp":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          name: identifierRule,
          origin: enumRule(["project-config", "project-mcp-json"] as const),
        },
      )
      break
    case "approvePendingProjectAuthority":
      one("fingerprint", (value, path) => {
        if (
          typeof value !== "string" ||
          !/^[a-f0-9]{64}$/iu.test(value)
        ) {
          fail("invalid_field", `${path} must be a SHA-256 fingerprint`)
        }
      })
      break
    case "approvalResponse":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          partId: identifierRule,
          approved: booleanRule,
        },
        {
          alwaysApprove: booleanRule,
          addToAllowedCommand: stringRule(8_192),
          skipAll: booleanRule,
          whatToDoInstead: stringRule(128_000),
        },
      )
      break
    case "openExternal":
      one("url", (value, path) => {
        stringRule(4_096, 1)(value, path)
        parseExternalHttpUrl(value as string)
      })
      break
    case "showConfirm":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          id: identifierRule,
          message: stringRule(16_384, 1),
        },
      )
      break
    case "restoreCheckpoint":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          hash: identifierRule,
          restoreType: enumRule(["task", "workspace", "taskAndWorkspace"] as const),
        },
      )
      break
    case "showCheckpointDiff":
      exactRecord(
        message,
        "message",
        { type: enumRule([type]), fromHash: identifierRule },
        { toHash: identifierRule },
      )
      break
    case "createAgentPreset":
      one("preset", presetRule)
      break
    case "deleteAgentPreset":
    case "applyAgentPreset":
    case "setChatPreset":
      one("presetName", stringRule(128, 1))
      break
    case "planFollowupChoice":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          choice: enumRule(["implement", "revise", "dismiss"] as const),
        },
        {
          planText: stringRule(1_000_000),
          instruction: stringRule(128_000),
          newSession: booleanRule,
        },
      )
      break
    case "dismissQuestionnaire":
      one("requestId", identifierRule)
      break
    case "questionnaireResponse":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          requestId: identifierRule,
          answers: questionnaireAnswersRule,
        },
      )
      break
    case "startOrConnectVectorDb":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          url: (value, path) => {
            stringRule(4_096, 1)(value, path)
            parseExternalHttpUrl(value as string)
          },
        },
        { autoStart: booleanRule },
      )
      break
    case "slashCommand":
      one("command", stringRule(8_192, 1))
      break
    case "fetchMarketplaceData":
      exactRecord(
        message,
        "message",
        { type: enumRule([type]) },
        {
          includeSkills: booleanRule,
          skillSearchQuery: stringRule(2_048),
          skillSearchMode: enumRule(["keyword", "vector"] as const),
          skillPage: numberRule(1, 10_000, true),
          skillCategory: stringRule(256),
          skillVectorThreshold: numberRule(0, 1),
          forceRefresh: booleanRule,
        },
      )
      break
    case "installMarketplaceItem":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          item: marketplaceReferenceRule,
          options: (value, path) => {
            exactRecord(
              value,
              path,
              {},
              {
                target: enumRule(["global", "project"] as const),
                parameters: primitiveParametersRule,
              },
            )
          },
        },
      )
      break
    case "removeInstalledMarketplaceItem":
      exactRecord(
        message,
        "message",
        {
          type: enumRule([type]),
          item: marketplaceReferenceRule,
          options: (value, path) => {
            exactRecord(
              value,
              path,
              { target: enumRule(["global", "project"] as const) },
            )
          },
        },
      )
      break
    case "setAutocompleteExtensionSettings":
      one("patch", autocompletePatchRule)
      break
    default:
      fail("unknown_type", `Unknown webview message type "${type}"`)
  }

  return message as WebviewMessage
}

function validateDiagnostic(message: PlainRecord): WebviewDiagnosticMessage {
  switch (message["type"]) {
    case "webviewBootstrap":
      exactRecord(
        message,
        "diagnostic",
        { type: enumRule(["webviewBootstrap"]), phase: stringRule(256, 1) },
      )
      break
    case "webviewScriptError":
      exactRecord(
        message,
        "diagnostic",
        { type: enumRule(["webviewScriptError"]), message: stringRule(4_096, 1) },
      )
      break
    case "webviewRuntimeError":
      exactRecord(
        message,
        "diagnostic",
        {
          type: enumRule(["webviewRuntimeError"]),
          message: stringRule(4_096, 1),
          source: stringRule(4_096),
          line: numberRule(0, 10_000_000, true),
          column: numberRule(0, 10_000_000, true),
        },
      )
      break
    default:
      fail("unknown_type", "Unknown webview diagnostic")
  }
  return message as WebviewDiagnosticMessage
}

export function parseWebviewInboundMessage(
  value: unknown,
): ParsedWebviewInboundMessage {
  inspectPayloadShape(value)
  if (!isPlainRecord(value)) {
    fail("invalid_shape", "Webview message must be an object")
  }
  const type = value["type"]
  if (typeof type !== "string") {
    fail("invalid_shape", "Webview message type must be a string")
  }
  if (
    type === "webviewBootstrap" ||
    type === "webviewScriptError" ||
    type === "webviewRuntimeError"
  ) {
    return { kind: "diagnostic", message: validateDiagnostic(value) }
  }
  return { kind: "request", message: validateRequest(value) }
}

export function parseExternalHttpUrl(raw: string): URL {
  try {
    return parseStrictExternalHttpUrl(raw)
  } catch (error) {
    fail(
      "invalid_field",
      error instanceof Error ? error.message : "External URL is malformed",
    )
  }
}

export function isLoopbackHttpUrl(raw: string): boolean {
  return isLoopbackExternalHttpUrl(raw)
}

export function resolveVectorDbRequest(
  rawUrl: string,
  requestedAutoStart: boolean,
  runtimeHost: "local" | "remote" = "local",
): {
  url: string
  autoStart: boolean
  requiresConfirmation: boolean
} {
  const url = parseExternalHttpUrl(rawUrl).toString()
  if (runtimeHost === "remote") {
    fail(
      "invalid_field",
      "Vector database lifecycle is owned by the remote NexusCode runtime host",
    )
  }
  if (requestedAutoStart && !isLoopbackHttpUrl(url)) {
    fail(
      "invalid_field",
      "Vector database auto-start is restricted to an explicit local loopback destination",
    )
  }
  return {
    url,
    autoStart: requestedAutoStart,
    requiresConfirmation: requestedAutoStart,
  }
}

export type {
  MarketplaceItemReference,
  ParsedWebviewInboundMessage,
  WebviewDiagnosticMessage,
  WebviewMessage,
} from "./webview-protocol-types.js"
