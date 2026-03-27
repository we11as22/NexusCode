export interface McpParameter {
  name: string
  key: string
  placeholder?: string
  optional?: boolean
}

export interface McpInstallationMethod {
  name: string
  content: string
  parameters?: McpParameter[]
  prerequisites?: string[]
}

export interface MarketplaceItemBase {
  id: string
  name: string
  description: string
  author?: string
  authorUrl?: string
  tags?: string[]
  prerequisites?: string[]
}

export interface McpMarketplaceItem extends MarketplaceItemBase {
  type: "mcp"
  url: string
  content: string | McpInstallationMethod[]
  parameters?: McpParameter[]
}

export interface SkillInstallHint {
  kind: "github_blob"
  url: string
}

export interface SkillMarketplaceItem extends MarketplaceItemBase {
  type: "skill"
  category: string
  githubUrl: string
  content: string
  displayName: string
  displayCategory: string
  skillInstall?: SkillInstallHint
  stars?: number
}

export type MarketplaceItem = McpMarketplaceItem | SkillMarketplaceItem

export interface MarketplaceInstalledMetadata {
  project: Record<string, { type: string }>
  global: Record<string, { type: string }>
}
