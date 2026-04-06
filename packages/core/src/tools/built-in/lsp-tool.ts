import * as path from "node:path"
import { z } from "zod"
import type { LspLocation, LspQueryResult, LspRange, ToolDef } from "../../types.js"

const schema = z.object({
  operation: z.enum([
    "goToDefinition",
    "findReferences",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
    "goToImplementation",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
  ]),
  filePath: z.string().optional().describe("Absolute or project-relative file path."),
  line: z.number().int().positive().optional().describe("1-based line number."),
  character: z.number().int().positive().optional().describe("1-based character offset."),
  query: z.string().optional().describe("Workspace-symbol query."),
})

function formatRange(range: LspRange): string {
  return `L${range.start.line}:C${range.start.character}`
}

function formatLocation(location: LspLocation, cwd: string): string {
  const rel = path.isAbsolute(location.path) ? path.relative(cwd, location.path).replace(/\\/g, "/") || location.path : location.path
  return `- ${rel} ${formatRange(location.range)}`
}

function formatResult(result: LspQueryResult, cwd: string): string {
  const lines = [result.summary.trim()]
  if (result.hover?.trim()) {
    lines.push("")
    lines.push(result.hover.trim())
  }
  if (result.locations?.length) {
    lines.push("")
    lines.push("Locations:")
    lines.push(...result.locations.map((location) => formatLocation(location, cwd)))
  }
  if (result.symbols?.length) {
    lines.push("")
    lines.push("Symbols:")
    lines.push(
      ...result.symbols.map((symbol) => {
        const rel = symbol.path
          ? (path.isAbsolute(symbol.path) ? path.relative(cwd, symbol.path).replace(/\\/g, "/") || symbol.path : symbol.path)
          : ""
        return `- [${symbol.kind}] ${symbol.name}${symbol.detail ? ` — ${symbol.detail}` : ""}${rel ? ` (${rel}${symbol.range ? ` ${formatRange(symbol.range)}` : ""})` : ""}`
      }),
    )
  }
  if (result.calls?.length) {
    lines.push("")
    lines.push("Calls:")
    lines.push(
      ...result.calls.map((call) => {
        const rel = path.isAbsolute(call.path) ? path.relative(cwd, call.path).replace(/\\/g, "/") || call.path : call.path
        return `- ${call.name}${call.kind ? ` [${call.kind}]` : ""} (${rel} ${formatRange(call.range)})`
      }),
    )
  }
  return lines.join("\n").trim()
}

function validateRequest(args: z.infer<typeof schema>): string | null {
  if (args.operation === "workspaceSymbol") {
    return args.query?.trim() ? null : "workspaceSymbol requires a non-empty query."
  }
  if (!args.filePath?.trim()) return `${args.operation} requires filePath.`
  if (args.operation === "documentSymbol") return null
  if (!args.line || !args.character) {
    return `${args.operation} requires line and character (1-based).`
  }
  return null
}

export const lspTool: ToolDef<z.infer<typeof schema>> = {
  name: "LSP",
  description: "IDE/LSP-aware code intelligence: definitions, references, hover, symbols, implementations, and call hierarchy when supported by the current host.",
  parameters: schema,
  readOnly: true,
  shouldDefer: true,
  searchHint: "language server, go to definition, references, hover, symbols, call hierarchy",
  async execute(args, ctx) {
    const validation = validateRequest(args)
    if (validation) return { success: false, output: validation }
    if (!ctx.host.queryLanguageServer) {
      return {
        success: false,
        output: "LSP is not available in this host/runtime. Use ListCodeDefinitions, Grep, CodebaseSearch, or run inside the VS Code host.",
      }
    }
    const result = await ctx.host.queryLanguageServer(args)
    return {
      success: true,
      output: formatResult(result, ctx.cwd),
      metadata: { lsp: result },
    }
  },
}
