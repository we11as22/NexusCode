import { describe, expect, it } from "vitest"

import {
  MarketplaceCatalogCapabilityError,
  MarketplaceCatalogCapabilityStore,
} from "./services/marketplace/catalog-capability.js"
import type {
  McpMarketplaceItem,
  SkillMarketplaceItem,
} from "./services/marketplace/types.js"

const mcpItem: McpMarketplaceItem = {
  type: "mcp",
  id: "github",
  name: "GitHub",
  description: "GitHub MCP",
  url: "https://example.com/github",
  content: '{"command":"npx","args":["github-mcp"]}',
}

const skillItem: SkillMarketplaceItem = {
  type: "skill",
  id: "review",
  name: "review",
  description: "Review code",
  category: "Engineering",
  githubUrl: "https://github.com/example/skills/blob/main/review/SKILL.md",
  content: "",
  displayName: "Review",
  displayCategory: "Engineering",
  skillInstall: {
    kind: "github_blob",
    url: "https://github.com/example/skills/blob/main/review/SKILL.md",
  },
}

describe("MarketplaceCatalogCapabilityStore", () => {
  it("resolves only exact identities that the host fetched", () => {
    const store = new MarketplaceCatalogCapabilityStore()
    store.replace([mcpItem, skillItem])

    expect(store.resolve({ id: "github", type: "mcp" })).toEqual(mcpItem)
    expect(store.resolve({ id: "review", type: "skill" })).toEqual(skillItem)
    expect(() =>
      store.resolve({ id: "review", type: "mcp" }),
    ).toThrow(MarketplaceCatalogCapabilityError)
    expect(() =>
      store.resolve({ id: "forged", type: "skill" }),
    ).toThrow(MarketplaceCatalogCapabilityError)
  })

  it("returns an isolated copy so callers cannot rewrite a granted catalog item", () => {
    const store = new MarketplaceCatalogCapabilityStore()
    store.replace([mcpItem])

    const first = store.resolve({ id: "github", type: "mcp" })
    first.name = "forged"
    const second = store.resolve({ id: "github", type: "mcp" })

    expect(second.name).toBe("GitHub")
  })

  it("replaces stale capabilities with the subsequent host catalog response", () => {
    const store = new MarketplaceCatalogCapabilityStore()
    store.replace([mcpItem, skillItem])
    store.replace([{ ...mcpItem, name: "GitHub MCP (updated)" }])

    expect(store.resolve({ id: "github", type: "mcp" }).name).toBe(
      "GitHub MCP (updated)",
    )
    expect(() =>
      store.resolve({ id: "review", type: "skill" }),
    ).toThrow(MarketplaceCatalogCapabilityError)
  })

  it("drops all catalog capabilities on dispose", () => {
    const store = new MarketplaceCatalogCapabilityStore()
    store.replace([skillItem])
    store.clear()

    expect(() =>
      store.resolve({ id: "review", type: "skill" }),
    ).toThrow(MarketplaceCatalogCapabilityError)
  })

  it("rejects malformed host catalog rows without turning them into capabilities", () => {
    const store = new MarketplaceCatalogCapabilityStore()

    expect(() =>
      store.replace([null as unknown as McpMarketplaceItem]),
    ).toThrow(MarketplaceCatalogCapabilityError)
    expect(() =>
      store.replace([{ ...mcpItem, id: "" }]),
    ).toThrow(MarketplaceCatalogCapabilityError)
  })

  it("rejects duplicate identities instead of installing an ambiguous row", () => {
    const store = new MarketplaceCatalogCapabilityStore()

    expect(() =>
      store.replace([
        mcpItem,
        { ...mcpItem, name: "Conflicting GitHub entry" },
      ]),
    ).toThrow(/duplicate item identity/i)
    expect(() =>
      store.resolve({ id: "github", type: "mcp" }),
    ).toThrow(MarketplaceCatalogCapabilityError)
  })
})
