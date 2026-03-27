import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { McpServerConfig, ToolDef } from "../types.js"
import { createMcpTransport } from "./transport-factory.js"
import { normalizeToolSchema } from "../provider/tool-schema.js"
import { z } from "zod"

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
}

/**
 * MCP client that connects to MCP servers and exposes their tools.
 */
export class McpClient {
  private clients = new Map<string, Client>()
  private tools = new Map<string, McpTool>()

  async connect(config: McpServerConfig): Promise<void> {
    try {
      const client = new Client({
        name: "nexuscode",
        version: "0.1.0",
      })

      const transport = createMcpTransport(config)
      await client.connect(transport)

      const toolsResponse = await client.listTools()
      for (const tool of toolsResponse.tools) {
        this.tools.set(`${config.name}__${tool.name}`, {
          name: `${config.name}__${tool.name}`,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
          serverName: config.name,
        })
      }

      this.clients.set(config.name, client)
    } catch (err) {
      console.warn(`[nexus] Failed to connect MCP server "${config.name}":`, err)
    }
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled !== false)
    await Promise.all(enabled.map((c) => this.connect(c)))
  }

  /** Test each server and return status (ok or error message). Does not keep connections. */
  async testServers(configs: McpServerConfig[]): Promise<Array<{ name: string; status: "ok" | "error"; error?: string }>> {
    const results: Array<{ name: string; status: "ok" | "error"; error?: string }> = []
    for (const config of configs) {
      if (config.enabled === false) {
        results.push({ name: config.name, status: "ok" })
        continue
      }
      try {
        const client = new Client({
          name: "nexuscode",
          version: "0.1.0",
        })
        const transport = createMcpTransport(config)
        await client.connect(transport)
        await client.listTools()
        await client.close()
        results.push({ name: config.name, status: "ok" })
      } catch (err) {
        results.push({
          name: config.name,
          status: "error",
          error: (err as Error).message ?? String(err),
        })
      }
    }
    return results
  }

  getTools(): ToolDef[] {
    return Array.from(this.tools.values()).map(mcpTool => {
      const normalizedSchema = normalizeToolSchema(mcpTool.inputSchema)
      const schema = buildZodSchema(normalizedSchema)
      const serverName = mcpTool.serverName

      return {
        name: mcpTool.name,
        description: `[MCP: ${serverName}] ${mcpTool.description}`,
        parameters: schema,
        readOnly: false,

        async execute(args: Record<string, unknown>, _ctx) {
          const client = (McpClientRegistry.instance as McpClient).clients.get(serverName)
          if (!client) {
            return { success: false, output: `MCP server "${serverName}" not connected` }
          }

          try {
            const toolName = mcpTool.name.replace(`${serverName}__`, "")
            const result = await client.callTool({
              name: toolName,
              arguments: args,
            })

            const parts = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
            const lines: string[] = []
            for (const c of parts) {
              if (c.type === "text" && c.text) {
                lines.push(c.text)
              } else if (c.type === "image" || c.type === "audio" || c.type === "resource") {
                lines.push(`[MCP ${c.type}${c.mimeType ? `: ${c.mimeType}` : ""}]`)
              } else if (c.type && c.text) {
                lines.push(c.text)
              } else if (c.type) {
                lines.push(`[MCP content type: ${c.type}]`)
              }
            }
            const output = lines.join("\n").trim()

            return { success: !result.isError, output }
          } catch (err) {
            return { success: false, output: `MCP error: ${(err as Error).message}` }
          }
        },
      }
    })
  }

  getStatus(): Record<string, "connected" | "disconnected"> {
    const status: Record<string, "connected" | "disconnected"> = {}
    for (const [name, client] of this.clients) {
      status[name] = "connected"
    }
    return status
  }

  async disconnectAll(): Promise<void> {
    for (const [, client] of this.clients) {
      try { await client.close() } catch {}
    }
    this.clients.clear()
    this.tools.clear()
  }
}

// Simple registry for tool execution callbacks
class McpClientRegistryClass {
  instance: McpClient | null = null
}
const McpClientRegistry = new McpClientRegistryClass()

export function setMcpClientInstance(client: McpClient): void {
  McpClientRegistry.instance = client
}

/** Standalone test of MCP server configs (does not keep connections). */
export async function testMcpServers(
  configs: McpServerConfig[]
): Promise<Array<{ name: string; status: "ok" | "error"; error?: string }>> {
  const client = new McpClient()
  return client.testServers(configs)
}

function buildZodSchema(inputSchema: Record<string, unknown>): z.ZodType {
  // Build Zod from normalized JSON Schema (supports nested object and array)
  const properties = (inputSchema["properties"] as Record<string, Record<string, unknown>>) ?? {}
  const required = (inputSchema["required"] as string[]) ?? []

  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") {
      shape[key] = z.unknown()
      continue
    }
    const propType = prop["type"] as string | string[] | undefined
    const desc = prop["description"] as string | undefined
    let fieldSchema: z.ZodType = z.string()
    if (propType === "number" || propType === "integer" || (Array.isArray(propType) && (propType.includes("number") || propType.includes("integer")))) {
      fieldSchema = z.number()
    } else if (propType === "boolean" || (Array.isArray(propType) && propType.includes("boolean"))) {
      fieldSchema = z.boolean()
    } else if (propType === "array" || (Array.isArray(propType) && propType.includes("array"))) {
      const items = prop["items"] as Record<string, unknown> | undefined
      fieldSchema = items && typeof items === "object"
        ? z.array(buildZodSchema(items as Record<string, unknown>))
        : z.array(z.unknown())
    } else if (propType === "object" || (Array.isArray(propType) && propType.includes("object"))) {
      fieldSchema = buildZodSchema(prop as Record<string, unknown>)
    }
    if (desc) fieldSchema = fieldSchema.describe(desc)
    if (!required.includes(key)) fieldSchema = fieldSchema.optional() as z.ZodType
    shape[key] = fieldSchema
  }

  if (Object.keys(shape).length === 0) {
    return z.record(z.unknown()).optional().default({}) as z.ZodType
  }

  return z.object(shape)
}
