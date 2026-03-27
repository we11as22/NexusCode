/**
 * Smoke-test MCP transport factory + skills loader after `pnpm --filter @nexuscode/core build`.
 * Does not start real MCP servers or open network connections.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const coreEntry = join(__dirname, "../packages/core/dist/index.mjs")

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed")
}

const { createMcpTransport, effectiveUrlTransport, loadSkills } = await import(coreEntry)

// --- effectiveUrlTransport
assert(effectiveUrlTransport({ name: "x", url: "http://a" }) === "sse", "default URL → SSE")
assert(effectiveUrlTransport({ name: "x", url: "http://a", transport: "http" }) === "http", "transport http")
assert(effectiveUrlTransport({ name: "x", url: "http://a", transport: "sse" }) === "sse", "transport sse")
assert(effectiveUrlTransport({ name: "x", url: "http://a", type: "streamable-http" }) === "http", "type streamable-http")
assert(effectiveUrlTransport({ name: "x", url: "http://a", type: "http" }) === "http", "type http alias")
assert(effectiveUrlTransport({ name: "x", url: "http://a", type: "sse" }) === "sse", "type sse")

// --- createMcpTransport (constructors only)
const stdio = createMcpTransport({ name: "s", command: "node", args: ["-e", "0"] })
assert(stdio.constructor.name === "StdioClientTransport", "stdio transport class")

const sse = createMcpTransport({ name: "r", url: "http://127.0.0.1:9/mcp" })
assert(sse.constructor.name === "SSEClientTransport", "default remote → SSE")

const stream = createMcpTransport({
  name: "h",
  url: "http://127.0.0.1:9/mcp",
  transport: "http",
})
assert(stream.constructor.name === "StreamableHTTPClientTransport", "transport http → Streamable HTTP")

const stream2 = createMcpTransport({
  name: "h2",
  url: "http://127.0.0.1:9/mcp",
  headers: { Authorization: "Bearer x" },
  type: "streamable-http",
})
assert(stream2.constructor.name === "StreamableHTTPClientTransport", "headers + type streamable-http")

let threw = false
try {
  createMcpTransport({ name: "bad", bundle: true })
} catch {
  threw = true
}
assert(threw, "unresolved bundle should throw")

// --- loadSkills + YAML frontmatter
const tmp = await mkdtemp(join(tmpdir(), "nexus-validate-skills-"))
try {
  const skillMd = join(tmp, "SKILL.md")
  await writeFile(
    skillMd,
    `---
name: yaml-named-skill
description: Summary from frontmatter
---
# Ignored heading for summary

Body line.
`,
    "utf8",
  )

  const skills = await loadSkills([skillMd], tmp)
  const mine = skills.find(s => s.path === skillMd)
  assert(mine, `expected skill at ${skillMd} (got ${skills.length} total from paths + standard discovery)`)
  assert(mine.name === "yaml-named-skill", "frontmatter name")
  assert(mine.summary === "Summary from frontmatter", "frontmatter description as summary")
  assert(mine.content.includes("Body line."), "body content preserved")
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log("validate-mcp-skills-workflow: OK")
