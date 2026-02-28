import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { McpServerConfig, ToolDef } from "../types.js"
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

      let transport: StdioClientTransport | SSEClientTransport

      if (config.url) {
        transport = new SSEClientTransport(new URL(config.url))
      } else if (config.command) {
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...process.env, ...config.env } as Record<string, string>,
        })
      } else {
        throw new Error(`MCP server "${config.name}" requires either command or url`)
      }

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
    await Promise.all(configs.map(c => this.connect(c)))
  }

  getTools(): ToolDef[] {
    return Array.from(this.tools.values()).map(mcpTool => {
      const schema = buildZodSchema(mcpTool.inputSchema)
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

            const output = (result.content as Array<{ type: string; text?: string }>)
              .filter(c => c.type === "text")
              .map(c => c.text ?? "")
              .join("\n")

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

function buildZodSchema(inputSchema: Record<string, unknown>): z.ZodType {
  // Build a flexible schema that accepts any object
  const properties = (inputSchema["properties"] as Record<string, { description?: string; type?: string }>) ?? {}
  const required = (inputSchema["required"] as string[]) ?? []

  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema: z.ZodType = z.string()
    if (prop.type === "number" || prop.type === "integer") fieldSchema = z.number()
    if (prop.type === "boolean") fieldSchema = z.boolean()
    if (prop.type === "array") fieldSchema = z.array(z.unknown())
    if (prop.type === "object") fieldSchema = z.record(z.unknown())
    if (prop.description) fieldSchema = fieldSchema.describe(prop.description)
    if (!required.includes(key)) fieldSchema = fieldSchema.optional() as z.ZodType

    shape[key] = fieldSchema
  }

  if (Object.keys(shape).length === 0) {
    return z.record(z.unknown()).optional().default({}) as z.ZodType
  }

  return z.object(shape)
}
