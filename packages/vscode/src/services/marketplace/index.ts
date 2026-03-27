import * as vscode from "vscode"
import { MarketplaceApiClient } from "./api.js"
import { MarketplacePaths } from "./paths.js"
import { InstallationDetector } from "./detection.js"
import { MarketplaceInstaller } from "./installer.js"
import type { SkillSearchOptions } from "./api.js"
import type {
  MarketplaceItem,
  InstallMarketplaceItemOptions,
  MarketplaceDataResponse,
  InstallResult,
  RemoveResult,
} from "./types.js"

export class MarketplaceService {
  private api: MarketplaceApiClient
  private paths: MarketplacePaths
  private detector: InstallationDetector
  private installer: MarketplaceInstaller

  constructor() {
    this.paths = new MarketplacePaths()
    this.api = new MarketplaceApiClient()
    this.detector = new InstallationDetector(this.paths)
    this.installer = new MarketplaceInstaller(this.paths)
  }

  async fetchData(
    workspace?: string,
    options?: { includeSkills?: boolean; skillSearch?: SkillSearchOptions },
  ): Promise<MarketplaceDataResponse> {
    const [fetched, metadata] = await Promise.all([
      this.api.fetchAll({
        includeSkills: options?.includeSkills,
        skillSearch: options?.skillSearch,
      }),
      this.detector.detect(workspace),
    ])

    return {
      marketplaceItems: fetched.items,
      marketplaceInstalledMetadata: metadata,
      errors: fetched.errors.length > 0 ? fetched.errors : undefined,
      skillSearchMeta: fetched.skillSearchMeta,
    }
  }

  async install(
    item: MarketplaceItem,
    options: InstallMarketplaceItemOptions,
    workspace?: string,
  ): Promise<InstallResult> {
    const result = await this.installer.install(item, options, workspace)

    if (result.success) {
      void vscode.window.showInformationMessage(`NexusCode: Installed ${item.name}`)
    }

    return result
  }

  async remove(item: MarketplaceItem, scope: "project" | "global", workspace?: string): Promise<RemoveResult> {
    const result = await this.installer.remove(item, scope, workspace)

    if (result.success) {
      void vscode.window.showInformationMessage(`NexusCode: Removed ${item.name}`)
    }

    return result
  }

  dispose(): void {
    this.api.dispose()
  }
}

export type {
  MarketplaceItem,
  InstallMarketplaceItemOptions,
  MarketplaceDataResponse,
  InstallResult,
  RemoveResult,
  McpMarketplaceItem,
  SkillMarketplaceItem,
  SkillSearchMeta,
} from "./types.js"
export type { SkillSearchOptions } from "./api.js"
