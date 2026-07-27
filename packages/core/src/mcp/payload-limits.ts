import { z } from "zod"
import type { ToolResult } from "../types.js"
import { normalizeToolSchema } from "../provider/tool-schema.js"
import type { McpCallResult } from "./protocol-client.js"

const MAX_TOOL_DESCRIPTION_CHARS = 2_048
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_NODES = 4_096
const MAX_SCHEMA_ARRAY_ITEMS = 1_024
const MAX_SCHEMA_OBJECT_KEYS = 1_024
const MAX_SCHEMA_STRING_CHARS = 32_768
const MAX_SCHEMA_APPROX_CHARS = 256 * 1_024
const MAX_RESULT_CONTENT_ITEMS = 128
const MAX_RESULT_TEXT_CHARS = 2 * 1_024 * 1_024
const MAX_RESULT_STRUCTURED_CHARS = 2 * 1_024 * 1_024
const MAX_RESULT_IMAGE_BYTES = 8 * 1_024 * 1_024
const MAX_RESULT_TOTAL_IMAGE_BYTES = 16 * 1_024 * 1_024
const MAX_RESULT_ATTACHMENTS = 16

export const MAX_LIST_PAGES = 100
export const MAX_TOOLS_PER_SERVER = 512
export const MAX_TOOL_NAME_CHARS = 256
export const MAX_PROMPTS_PER_SERVER = 512
export const MAX_PROMPT_ARGUMENTS = 64
export const MAX_PROMPT_MESSAGES = 64
export const MAX_PROMPT_TEXT_CHARS = 256 * 1_024
export const MAX_PROMPT_BINARY_BYTES = 8 * 1_024 * 1_024
export const MAX_PROMPT_TOTAL_BINARY_BYTES = 16 * 1_024 * 1_024
export const MAX_RESOURCES_PER_SERVER = 2_048
export const MAX_RESOURCE_CONTENT_ITEMS = 64
export const MAX_RESOURCE_TEXT_CHARS = 2 * 1_024 * 1_024
export const MAX_RESOURCE_BLOB_BYTES = 8 * 1_024 * 1_024
export const MAX_RESOURCE_TOTAL_BLOB_BYTES = 16 * 1_024 * 1_024

const MAX_RESOURCE_FIELD_CHARS = 16_384

export class McpPayloadLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpPayloadLimitError"
  }
}

function assertBoundedJsonLike(
  value: unknown,
  label: string,
  limits: {
    maxDepth: number
    maxNodes: number
    maxArrayItems: number
    maxObjectKeys: number
    maxStringChars: number
    maxApproxChars: number
  },
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  let approximateChars = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > limits.maxNodes) {
      throw new McpPayloadLimitError(
        `${label} exceeded the maximum node count (${limits.maxNodes})`,
      )
    }
    if (current.depth > limits.maxDepth) {
      throw new McpPayloadLimitError(
        `${label} exceeded the maximum depth (${limits.maxDepth})`,
      )
    }

    if (typeof current.value === "string") {
      if (current.value.length > limits.maxStringChars) {
        throw new McpPayloadLimitError(
          `${label} contains a string longer than ${limits.maxStringChars} characters`,
        )
      }
      approximateChars += current.value.length
    } else if (
      current.value === null ||
      typeof current.value === "boolean" ||
      typeof current.value === "undefined"
    ) {
      approximateChars += 8
    } else if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        throw new McpPayloadLimitError(`${label} contains a non-finite number`)
      }
      approximateChars += 24
    } else if (typeof current.value === "object") {
      if (seen.has(current.value)) {
        throw new McpPayloadLimitError(`${label} contains a cyclic value`)
      }
      seen.add(current.value)
      if (Array.isArray(current.value)) {
        if (current.value.length > limits.maxArrayItems) {
          throw new McpPayloadLimitError(
            `${label} contains an array larger than ${limits.maxArrayItems} items`,
          )
        }
        for (const item of current.value) {
          stack.push({ value: item, depth: current.depth + 1 })
        }
      } else {
        const entries = Object.entries(current.value as Record<string, unknown>)
        if (entries.length > limits.maxObjectKeys) {
          throw new McpPayloadLimitError(
            `${label} contains an object larger than ${limits.maxObjectKeys} keys`,
          )
        }
        for (const [key, item] of entries) {
          if (key.length > limits.maxStringChars) {
            throw new McpPayloadLimitError(`${label} contains an oversized key`)
          }
          approximateChars += key.length
          stack.push({ value: item, depth: current.depth + 1 })
        }
      }
    } else {
      throw new McpPayloadLimitError(`${label} contains a non-JSON value`)
    }

    if (approximateChars > limits.maxApproxChars) {
      throw new McpPayloadLimitError(
        `${label} exceeded the maximum encoded size (${limits.maxApproxChars} characters)`,
      )
    }
  }
}

export function assertMcpToolSchemaBounds(
  inputSchema: Record<string, unknown>,
  toolName = "unknown",
): void {
  assertBoundedJsonLike(inputSchema, `MCP tool "${toolName}" schema`, {
    maxDepth: MAX_SCHEMA_DEPTH,
    maxNodes: MAX_SCHEMA_NODES,
    maxArrayItems: MAX_SCHEMA_ARRAY_ITEMS,
    maxObjectKeys: MAX_SCHEMA_OBJECT_KEYS,
    maxStringChars: MAX_SCHEMA_STRING_CHARS,
    maxApproxChars: MAX_SCHEMA_APPROX_CHARS,
  })
}

export function approximateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

export function boundedDescription(value: string): string {
  if (value.length <= MAX_TOOL_DESCRIPTION_CHARS) return value
  return `${value.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1)}…`
}

export function boundedResourceField(value: string, label: string): string {
  if (value.length > MAX_RESOURCE_FIELD_CHARS) {
    throw new McpPayloadLimitError(
      `${label} exceeded ${MAX_RESOURCE_FIELD_CHARS} characters`,
    )
  }
  return value
}

export function formatMcpToolResult(
  result: McpCallResult,
  serverName: string,
  toolName: string,
): ToolResult {
  const rawParts = Array.isArray(result.content) ? result.content : []
  if (rawParts.length > MAX_RESULT_CONTENT_ITEMS) {
    throw new McpPayloadLimitError(
      `MCP result exceeded ${MAX_RESULT_CONTENT_ITEMS} content items`,
    )
  }
  const parts = rawParts.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  )
  const lines: string[] = []
  const attachments: NonNullable<ToolResult["attachments"]> = []
  let textChars = 0
  let totalImageBytes = 0
  const appendLine = (value: string) => {
    textChars += value.length
    if (textChars > MAX_RESULT_TEXT_CHARS) {
      throw new McpPayloadLimitError(
        `MCP result exceeded ${MAX_RESULT_TEXT_CHARS} text characters`,
      )
    }
    lines.push(value)
  }

  for (const content of parts) {
    const type = typeof content.type === "string" ? content.type : "unknown"
    if (type === "text" && typeof content.text === "string") {
      appendLine(content.text)
    } else if (type === "image" && typeof content.data === "string") {
      if (attachments.length >= MAX_RESULT_ATTACHMENTS) {
        throw new McpPayloadLimitError(
          `MCP result exceeded ${MAX_RESULT_ATTACHMENTS} attachments`,
        )
      }
      const bytes = approximateBase64Bytes(content.data)
      if (bytes > MAX_RESULT_IMAGE_BYTES) {
        throw new McpPayloadLimitError(
          `MCP image exceeded ${MAX_RESULT_IMAGE_BYTES} decoded bytes`,
        )
      }
      totalImageBytes += bytes
      if (totalImageBytes > MAX_RESULT_TOTAL_IMAGE_BYTES) {
        throw new McpPayloadLimitError(
          `MCP images exceeded ${MAX_RESULT_TOTAL_IMAGE_BYTES} total decoded bytes`,
        )
      }
      const mimeType = typeof content.mimeType === "string"
        ? content.mimeType.slice(0, 256)
        : "image/png"
      attachments.push({
        type: "image",
        content: content.data,
        mimeType,
      })
      appendLine(`[MCP image: ${mimeType}]`)
    } else if (type === "resource") {
      const resource = content.resource
      if (resource && typeof resource === "object" && !Array.isArray(resource)) {
        const value = resource as Record<string, unknown>
        if (typeof value.text === "string") appendLine(value.text)
        else if (typeof value.uri === "string") {
          appendLine(`[MCP resource: ${value.uri.slice(0, 4_096)}]`)
        } else {
          appendLine("[MCP resource]")
        }
      } else {
        appendLine("[MCP resource]")
      }
    } else if (typeof content.text === "string") {
      appendLine(content.text)
    } else {
      appendLine(`[MCP content type: ${type.slice(0, 128)}]`)
    }
  }

  let structuredText: string | undefined
  if (result.structuredContent !== undefined) {
    assertBoundedJsonLike(
      result.structuredContent,
      "MCP structured result",
      {
        maxDepth: MAX_SCHEMA_DEPTH,
        maxNodes: MAX_SCHEMA_NODES * 2,
        maxArrayItems: MAX_SCHEMA_ARRAY_ITEMS,
        maxObjectKeys: MAX_SCHEMA_OBJECT_KEYS,
        maxStringChars: MAX_RESULT_STRUCTURED_CHARS,
        maxApproxChars: MAX_RESULT_STRUCTURED_CHARS,
      },
    )
    try {
      structuredText = JSON.stringify(result.structuredContent, null, 2)
    } catch {
      throw new McpPayloadLimitError("MCP structured result was not serializable")
    }
    if (structuredText.length > MAX_RESULT_STRUCTURED_CHARS) {
      throw new McpPayloadLimitError(
        `MCP structured result exceeded ${MAX_RESULT_STRUCTURED_CHARS} characters`,
      )
    }
    appendLine(structuredText)
  }

  return {
    success: result.isError !== true,
    output: lines.join("\n").trim(),
    ...(attachments.length ? { attachments } : {}),
    metadata: {
      mcp: {
        serverName,
        toolName,
        contentItems: parts.length,
        attachmentCount: attachments.length,
        structuredContent: structuredText !== undefined,
      },
    },
  }
}

function literalSchema(value: unknown): z.ZodTypeAny {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return z.literal(value)
  }
  return z.unknown()
}

function schemaForNode(node: unknown): z.ZodTypeAny {
  if (!node || typeof node !== "object" || Array.isArray(node)) return z.unknown()
  const schema = node as Record<string, unknown>
  if ("const" in schema) return literalSchema(schema.const)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const schemas = schema.enum.map(literalSchema)
    return schemas.length === 1
      ? schemas[0]!
      : z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (alternatives?.length) {
    const schemas = alternatives.map(schemaForNode)
    return schemas.length === 1
      ? schemas[0]!
      : z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  const rawTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : []
  const nullable = rawTypes.includes("null")
  const type = rawTypes.find((item) => item !== "null")
  let result: z.ZodTypeAny
  switch (type) {
    case "string":
      result = z.string()
      break
    case "number":
      result = z.number()
      break
    case "integer":
      result = z.number().int()
      break
    case "boolean":
      result = z.boolean()
      break
    case "null":
      result = z.null()
      break
    case "array":
      result = z.array(schemaForNode(schema.items))
      break
    case "object":
    default: {
      if (type !== "object" && !schema.properties) {
        result = z.unknown()
        break
      }
      const properties =
        schema.properties &&
          typeof schema.properties === "object" &&
          !Array.isArray(schema.properties)
          ? schema.properties as Record<string, unknown>
          : {}
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((item): item is string => typeof item === "string")
          : [],
      )
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, property] of Object.entries(properties)) {
        let field = schemaForNode(property)
        const description =
          property && typeof property === "object" && !Array.isArray(property)
            ? (property as Record<string, unknown>).description
            : undefined
        if (typeof description === "string") field = field.describe(description)
        shape[key] = required.has(key) ? field : field.optional()
      }
      const object = z.object(shape)
      result = schema.additionalProperties === false
        ? object.strict()
        : object.passthrough()
      break
    }
  }
  return nullable ? result.nullable() : result
}

export function buildMcpToolSchema(
  inputSchema: Record<string, unknown>,
): z.ZodTypeAny {
  assertMcpToolSchemaBounds(inputSchema)
  return schemaForNode(normalizeToolSchema(inputSchema))
}
