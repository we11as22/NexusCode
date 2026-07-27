import type { MarketplaceItem } from "./types.js"

export interface MarketplaceCatalogReference {
  id: string
  type: "mcp" | "skill"
}

export class MarketplaceCatalogCapabilityError extends Error {
  override readonly name = "MarketplaceCatalogCapabilityError"
}

function catalogKey(reference: MarketplaceCatalogReference): string {
  if (
    reference === null ||
    typeof reference !== "object" ||
    (reference.type !== "mcp" && reference.type !== "skill") ||
    typeof reference.id !== "string" ||
    reference.id.length < 1 ||
    reference.id.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(reference.id)
  ) {
    throw new MarketplaceCatalogCapabilityError(
      "Invalid marketplace catalog reference",
    )
  }
  return `${reference.type}\0${reference.id}`
}

function copyItem(item: MarketplaceItem): MarketplaceItem {
  return structuredClone(item)
}

/**
 * Host-owned marketplace capabilities.
 *
 * The webview receives display data, but a later mutation may identify only
 * the item it displayed. Installation content and remote URLs are always
 * recovered from this host-populated catalog rather than accepted back from
 * the webview.
 */
export class MarketplaceCatalogCapabilityStore {
  private readonly items = new Map<string, MarketplaceItem>()

  replace(items: readonly MarketplaceItem[]): void {
    const next = new Map<string, MarketplaceItem>()
    for (const item of items) {
      const key = catalogKey(item)
      if (next.has(key)) {
        throw new MarketplaceCatalogCapabilityError(
          "Marketplace catalog contains a duplicate item identity",
        )
      }
      next.set(key, copyItem(item))
    }
    this.items.clear()
    for (const [key, item] of next) this.items.set(key, item)
  }

  resolve(reference: MarketplaceCatalogReference): MarketplaceItem {
    const item = this.items.get(catalogKey(reference))
    if (!item) {
      throw new MarketplaceCatalogCapabilityError(
        "Marketplace item is not present in the host catalog. Refresh the marketplace and try again.",
      )
    }
    return copyItem(item)
  }

  clear(): void {
    this.items.clear()
  }
}
