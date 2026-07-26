import { describe, expect, it } from "vitest"
import { rooCodeParser } from "./index.js"

describe("Roo-compatible semantic chunk parser", () => {
  it("indexes MDX through the markdown parser", async () => {
    const content = [
      "# Authentication",
      "",
      "This section documents how authentication tokens are validated and refreshed.",
      "It is intentionally long enough to form a useful semantic index block.",
    ].join("\n")

    const blocks = await rooCodeParser.parseFile("docs/auth.mdx", {
      content,
      fileHash: "mdx-hash",
    })

    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]?.content).toContain("Authentication")
  })

  it("loads the bundled JavaScript WASM grammar for modern module extensions", async () => {
    const content = [
      "export function validateAuthenticationToken(token) {",
      "  if (!token || token.length < 20) throw new Error('invalid token')",
      "  return { valid: true, token }",
      "}",
    ].join("\n")

    const blocks = await rooCodeParser.parseFile("src/auth.mjs", {
      content,
      fileHash: "mjs-hash",
    })

    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.some((block) => block.content.includes("validateAuthenticationToken"))).toBe(true)
  })
})
