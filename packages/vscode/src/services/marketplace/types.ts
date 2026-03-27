/** Marketplace items: MCP (local/manual) + SkillNet skills catalog. */

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

/** Install from GitHub blob URL (SkillNet `skill_url` → repo tarball + subpath). */
export interface SkillInstallHint {
  kind: "github_blob"
  url: string
}

export interface SkillMarketplaceItem extends MarketplaceItemBase {
  type: "skill"
  category: string
  githubUrl: string
  /** Direct tarball URL (legacy); empty when `skillInstall` is set. */
  content: string
  displayName: string
  displayCategory: string
  skillInstall?: SkillInstallHint
  stars?: number
}

export type MarketplaceItem = McpMarketplaceItem | SkillMarketplaceItem

export interface SkillSearchMeta {
  query: string
  mode: string
  total: number
  limit: number
  page: number
}

export interface InstallMarketplaceItemOptions {
  target?: "global" | "project"
  parameters?: Record<string, unknown>
}

export interface MarketplaceInstalledMetadata {
  project: Record<string, { type: string }>
  global: Record<string, { type: string }>
}

export interface MarketplaceDataResponse {
  marketplaceItems: MarketplaceItem[]
  marketplaceInstalledMetadata: MarketplaceInstalledMetadata
  errors?: string[]
  skillSearchMeta?: SkillSearchMeta
}

export interface InstallResult {
  success: boolean
  slug: string
  error?: string
  filePath?: string
  line?: number
}

export interface RemoveResult {
  success: boolean
  slug: string
  error?: string
}
