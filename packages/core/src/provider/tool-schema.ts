/**
 * Normalize JSON Schema for MCP (and other raw) tool parameters so they are
 * compatible with strict providers (OpenAI, Anthropic, etc.).
 * - Ensures object schemas have additionalProperties: false
 * - Ensures root is type "object" with properties/required
 * - Recursively normalizes nested objects and array items
 */

export type JSONSchema = Record<string, unknown>

function isObjectSchema(s: JSONSchema): boolean {
  const t = s["type"]
  if (t === "object") return true
  if (Array.isArray(t) && t.includes("object")) return true
  return false
}

function isArraySchema(s: JSONSchema): boolean {
  const t = s["type"]
  if (t === "array") return true
  if (Array.isArray(t) && t.includes("array")) return true
  return false
}

/**
 * Normalize a single schema node (object or array): set additionalProperties: false
 * on objects, recurse into properties and items.
 */
function normalizeNode(schema: JSONSchema): JSONSchema {
  if (!schema || typeof schema !== "object") return schema

  const out = { ...schema }

  if (isObjectSchema(out)) {
    out["additionalProperties"] = false
    const props = out["properties"] as Record<string, JSONSchema> | undefined
    if (props && typeof props === "object") {
      const normalizedProps: Record<string, JSONSchema> = {}
      for (const [k, v] of Object.entries(props)) {
        normalizedProps[k] = normalizeNode((v ?? {}) as JSONSchema)
      }
      out["properties"] = normalizedProps
    }
    if (!out["required"] || !Array.isArray(out["required"])) {
      out["required"] = []
    }
  }

  if (isArraySchema(out)) {
    const items = out["items"] as JSONSchema | JSONSchema[] | undefined
    if (items && typeof items === "object" && !Array.isArray(items)) {
      out["items"] = normalizeNode(items)
    }
  }

  return out
}

/**
 * Normalize a tool's input schema (e.g. from MCP listTools).
 * - If root has no type or type is not object, treat as empty object schema
 * - Sets additionalProperties: false on all object schemas
 * - Recursively normalizes properties and array items
 */
export function normalizeToolSchema(inputSchema: JSONSchema): JSONSchema {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {}, required: [], additionalProperties: false }
  }

  const root = { ...inputSchema }

  if (!isObjectSchema(root)) {
    const props = (root["properties"] as Record<string, JSONSchema>) ?? {}
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, normalizeNode((v ?? {}) as JSONSchema)])
      ),
      required: Array.isArray(root["required"]) ? root["required"] : [],
      additionalProperties: false,
    }
  }

  return normalizeNode(root) as JSONSchema
}
