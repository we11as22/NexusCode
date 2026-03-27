import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useChatStore } from "../../stores/chat.js"
import { postMessage } from "../../vscode.js"
import type {
  MarketplaceItem,
  McpMarketplaceItem,
  SkillMarketplaceItem,
  MarketplaceInstalledMetadata,
  McpInstallationMethod,
  McpParameter,
} from "../../types/marketplace.js"
import "./marketplace.css"

function installedScopes(
  id: string,
  itemType: string,
  metadata: MarketplaceInstalledMetadata,
): ("project" | "global")[] {
  const scopes: ("project" | "global")[] = []
  if (metadata.project[id]?.type === itemType) scopes.push("project")
  if (metadata.global[id]?.type === itemType) scopes.push("global")
  return scopes
}

function isInstalled(id: string, itemType: string, metadata: MarketplaceInstalledMetadata): boolean {
  return installedScopes(id, itemType, metadata).length > 0
}

function tagsFor(item: MarketplaceItem): string[] {
  if (item.type === "skill") return [(item as SkillMarketplaceItem).displayCategory]
  return item.tags ?? []
}

export function MarketplacePanel() {
  const projectDir = useChatStore((s) => s.projectDir)
  const hasWorkspace = Boolean(projectDir?.trim())

  const [items, setItems] = useState<MarketplaceItem[]>([])
  const [metadata, setMetadata] = useState<MarketplaceInstalledMetadata>({ project: {}, global: {} })
  const [fetching, setFetching] = useState(true)
  const [errors, setErrors] = useState<string[]>([])
  const [tab, setTab] = useState<"mcp" | "skill">("skill")
  const [search, setSearch] = useState("")
  const [skillQuery, setSkillQuery] = useState("skill")
  const [debouncedSkillQuery, setDebouncedSkillQuery] = useState("skill")
  const [skillMode, setSkillMode] = useState<"keyword" | "vector">("keyword")
  const [skillPage, setSkillPage] = useState(1)
  const [vectorThreshold, setVectorThreshold] = useState(0.65)
  const [skillSearchMeta, setSkillSearchMeta] = useState<{
    query: string
    mode: string
    total: number
    limit: number
    page: number
  } | null>(null)
  const [statusFilter, setStatusFilter] = useState<"all" | "installed" | "notInstalled">("all")
  const [activeTags, setActiveTags] = useState<string[]>([])

  const [installItem, setInstallItem] = useState<MarketplaceItem | null>(null)
  const [removeTarget, setRemoveTarget] = useState<{ item: MarketplaceItem; scope: "project" | "global" } | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSkillQuery(skillQuery), 400)
    return () => clearTimeout(t)
  }, [skillQuery])

  useEffect(() => {
    setSkillPage(1)
  }, [debouncedSkillQuery, skillMode])

  const fetchData = useCallback(() => {
    setFetching(true)
    postMessage({
      type: "fetchMarketplaceData",
      includeSkills: tab === "skill",
      skillSearchQuery: debouncedSkillQuery.trim() || "skill",
      skillSearchMode: skillMode,
      skillPage,
      skillVectorThreshold: skillMode === "vector" ? vectorThreshold : undefined,
    })
  }, [tab, debouncedSkillQuery, skillMode, skillPage, vectorThreshold])

  useEffect(() => {
    fetchData()
  }, [fetchData, projectDir])

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = ev.data as Record<string, unknown>
      if (!msg || typeof msg !== "object") return
      if (msg.type === "marketplaceData") {
        setItems((msg.marketplaceItems as MarketplaceItem[]) ?? [])
        setMetadata(
          (msg.marketplaceInstalledMetadata as MarketplaceInstalledMetadata) ?? { project: {}, global: {} },
        )
        setErrors(Array.isArray(msg.errors) ? (msg.errors as string[]) : [])
        const meta = msg.skillSearchMeta as
          | { query: string; mode: string; total: number; limit: number; page: number }
          | undefined
        setSkillSearchMeta(meta ?? null)
        setFetching(false)
      }
      if (msg.type === "marketplaceRemoveResult" && msg.success) {
        fetchData()
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [fetchData])

  const mcps = useMemo(() => items.filter((i): i is McpMarketplaceItem => i.type === "mcp"), [items])
  const skills = useMemo(() => items.filter((i): i is SkillMarketplaceItem => i.type === "skill"), [items])
  const listItems = tab === "mcp" ? mcps : skills

  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of listItems) {
      for (const tag of tagsFor(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    const min = tab === "mcp" ? 5 : 1
    return Array.from(counts.entries())
      .filter(([, n]) => n >= min)
      .map(([t]) => t)
      .sort()
  }, [listItems, tab])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const s = statusFilter
    const tagAct = activeTags
    return listItems.filter((item) => {
      if (s === "installed" && !isInstalled(item.id, item.type, metadata)) return false
      if (s === "notInstalled" && isInstalled(item.id, item.type, metadata)) return false
      if (tagAct.length > 0 && !tagAct.some((t) => tagsFor(item).includes(t))) return false
      if (!q) return true
      const sk = item.type === "skill" ? (item as SkillMarketplaceItem) : undefined
      return (
        item.id.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        (item.author?.toLowerCase().includes(q) ?? false) ||
        (sk?.displayName.toLowerCase().includes(q) ?? false)
      )
    })
  }, [listItems, search, statusFilter, activeTags, metadata])

  const toggleTag = (t: string) => {
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }

  const dismissError = (idx: number) => setErrors((prev) => prev.filter((_, i) => i !== idx))

  return (
    <div className="nexus-marketplace-view">
      {errors.length > 0 && (
        <div className="flex flex-col gap-1">
          {errors.map((err, idx) => (
            <div key={idx} className="nexus-marketplace-error-banner">
              <span>{err}</span>
              <button
                type="button"
                className="nexus-secondary-btn text-xs py-0.5"
                onClick={() => dismissError(idx)}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="nexus-marketplace-tabs">
        <button
          type="button"
          className={`nexus-marketplace-tab ${tab === "mcp" ? "nexus-marketplace-tab-active" : ""}`}
          onClick={() => setTab("mcp")}
        >
          MCP Servers
        </button>
        <button
          type="button"
          className={`nexus-marketplace-tab ${tab === "skill" ? "nexus-marketplace-tab-active" : ""}`}
          onClick={() => setTab("skill")}
        >
          Skills
        </button>
        <button type="button" className="nexus-secondary-btn text-xs ml-auto self-center" onClick={fetchData}>
          Refresh
        </button>
      </div>

      <p className="text-[11px] text-[var(--vscode-descriptionForeground)] m-0">
        <strong>Skills</strong> —{" "}
        <button
          type="button"
          className="text-[var(--vscode-textLink-foreground)] underline bg-transparent border-none cursor-pointer p-0"
          onClick={() => postMessage({ type: "openExternal", url: "http://api-skillnet.openkg.cn" })}
        >
          SkillNet
        </button>{" "}
        (OpenKG). <strong>MCP Servers</strong> — catalog from{" "}
        <button
          type="button"
          className="text-[var(--vscode-textLink-foreground)] underline bg-transparent border-none cursor-pointer p-0"
          onClick={() => postMessage({ type: "openExternal", url: "https://kilo.ai" })}
        >
          Kilo
        </button>{" "}
        (<code className="text-[10px]">api.kilo.ai</code>). MCP installs append to{" "}
        <code className="text-[10px]">.nexus/mcp-servers.json</code> or global. Skills install to{" "}
        <code className="text-[10px]">.kilo/skills/&lt;id&gt;</code>; legacy <code className="text-[10px]">.nexus/skills</code>{" "}
        is still detected.
      </p>

      <div className="nexus-marketplace-list">
        <div className="nexus-marketplace-filters flex-wrap">
          {tab === "skill" ? (
            <>
              <input
                className="nexus-marketplace-search flex-1 min-w-[120px]"
                placeholder="Search SkillNet (keywords or natural language)…"
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.target.value)}
              />
              <select
                className="nexus-marketplace-select"
                value={skillMode}
                onChange={(e) => setSkillMode(e.target.value as "keyword" | "vector")}
                title="Keyword = fuzzy match; Vector = semantic search"
              >
                <option value="keyword">Keyword</option>
                <option value="vector">Semantic</option>
              </select>
              {skillMode === "vector" && (
                <label className="flex items-center gap-1 text-[10px] text-[var(--vscode-descriptionForeground)]">
                  τ
                  <input
                    type="number"
                    min={0.2}
                    max={0.95}
                    step={0.05}
                    value={vectorThreshold}
                    onChange={(e) => setVectorThreshold(Number(e.target.value))}
                    className="w-14 bg-[var(--vscode-input-background)] border border-[var(--vscode-input-border)] rounded px-1"
                  />
                </label>
              )}
            </>
          ) : (
            <input
              className="nexus-marketplace-search flex-1"
              placeholder="Filter list…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          <select
            className="nexus-marketplace-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="all">All</option>
            <option value="installed">Installed</option>
            <option value="notInstalled">Not installed</option>
          </select>
        </div>

        {tab === "skill" && skillSearchMeta && (
          <p className="text-[10px] text-[var(--vscode-descriptionForeground)] m-0 mt-1">
            Query “{skillSearchMeta.query}” · {skillSearchMeta.mode} · {skillSearchMeta.total.toLocaleString()} result
            {skillSearchMeta.total === 1 ? "" : "s"}
            {skillSearchMeta.mode === "keyword" && skillSearchMeta.total > skillSearchMeta.limit ? (
              <>
                {" "}
                · page {skillSearchMeta.page} (
                {Math.min(skillSearchMeta.limit, skillSearchMeta.total - (skillSearchMeta.page - 1) * skillSearchMeta.limit)}{" "}
                shown)
              </>
            ) : null}
          </p>
        )}

        {tab === "skill" && skillSearchMeta && skillSearchMeta.mode === "keyword" && skillSearchMeta.total > skillSearchMeta.limit && (
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              className="nexus-secondary-btn text-xs py-0.5"
              disabled={skillPage <= 1 || fetching}
              onClick={() => setSkillPage((p) => Math.max(1, p - 1))}
            >
              Previous page
            </button>
            <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
              Page {skillPage} / {Math.max(1, Math.ceil(skillSearchMeta.total / skillSearchMeta.limit))}
            </span>
            <button
              type="button"
              className="nexus-secondary-btn text-xs py-0.5"
              disabled={fetching || skillPage * skillSearchMeta.limit >= skillSearchMeta.total}
              onClick={() => setSkillPage((p) => p + 1)}
            >
              Next page
            </button>
          </div>
        )}

        {allTags.length > 0 && (
          <div className="nexus-marketplace-tags">
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`nexus-marketplace-tag-btn ${activeTags.includes(t) ? "nexus-marketplace-tag-btn-active" : ""}`}
                onClick={() => toggleTag(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {fetching ? (
          <div className="nexus-marketplace-loading">Loading marketplace…</div>
        ) : tab === "mcp" && mcps.length === 0 && !fetching ? (
          <p className="nexus-marketplace-empty text-xs">
            No MCP entries loaded (network or Kilo API). Add servers manually under <strong>Integrations → MCP</strong> (
            <code className="text-[10px]">.nexus/mcp-servers.json</code>).
          </p>
        ) : tab === "skill" && skills.length === 0 && !fetching ? (
          <p className="nexus-marketplace-empty text-xs">
            No skills returned from SkillNet. Try another query, switch to semantic search, or adjust the similarity threshold (vector mode).
          </p>
        ) : filtered.length === 0 ? (
          <p className="nexus-marketplace-empty">No items match your filters.</p>
        ) : (
          <div className="nexus-marketplace-grid">
            {filtered.map((item) => (
              <MarketplaceCard
                key={`${item.type}-${item.id}`}
                item={item}
                metadata={metadata}
                onInstall={() => setInstallItem(item)}
                onRemove={(scope) => setRemoveTarget({ item, scope })}
              />
            ))}
          </div>
        )}
      </div>

      {installItem && (
        <InstallModal
          item={installItem}
          hasWorkspace={hasWorkspace}
          onClose={() => setInstallItem(null)}
          onDone={() => {
            setInstallItem(null)
            fetchData()
          }}
        />
      )}

      {removeTarget && (
        <RemoveModal
          name={removeTarget.item.name}
          scope={removeTarget.scope}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            postMessage({
              type: "removeInstalledMarketplaceItem",
              mpItem: removeTarget.item,
              mpInstallOptions: { target: removeTarget.scope },
            })
            setRemoveTarget(null)
          }}
        />
      )}
    </div>
  )
}

function MarketplaceCard({
  item,
  metadata,
  onInstall,
  onRemove,
}: {
  item: MarketplaceItem
  metadata: MarketplaceInstalledMetadata
  onInstall: () => void
  onRemove: (scope: "project" | "global") => void
}) {
  const scopes = installedScopes(item.id, item.type, metadata)
  const installed = scopes.length > 0
  const skill = item.type === "skill" ? (item as SkillMarketplaceItem) : undefined
  const mcp = item.type === "mcp" ? (item as McpMarketplaceItem) : undefined
  const displayName = skill?.displayName ?? item.name
  const linkUrl = skill?.githubUrl ?? mcp?.url
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const descRef = React.useCallback((el: HTMLParagraphElement | null) => {
    if (el && el.scrollHeight > el.clientHeight) setClamped(true)
  }, [])

  return (
    <div className="nexus-marketplace-card">
      <div>
        {linkUrl ? (
          <button
            type="button"
            className="nexus-marketplace-card-name nexus-marketplace-card-name-link bg-transparent border-none p-0 text-left"
            onClick={() => postMessage({ type: "openExternal", url: linkUrl })}
          >
            {displayName}
          </button>
        ) : (
          <div className="nexus-marketplace-card-name">{displayName}</div>
        )}
        {item.author && (
          <div className="nexus-marketplace-card-author">
            {item.authorUrl ? (
              <button
                type="button"
                className="bg-transparent border-none p-0 text-[var(--vscode-textLink-foreground)] underline cursor-pointer"
                onClick={() => postMessage({ type: "openExternal", url: item.authorUrl! })}
              >
                by {item.author}
              </button>
            ) : (
              <>by {item.author}</>
            )}
            {skill?.stars != null && skill.stars > 0 && (
              <span className="ml-2 text-[var(--vscode-descriptionForeground)]">★ {skill.stars.toLocaleString()}</span>
            )}
          </div>
        )}
      </div>
      <p
        ref={descRef}
        className={`nexus-marketplace-card-desc ${expanded ? "nexus-marketplace-card-desc-expanded" : ""}`}
      >
        {item.description}
      </p>
      {clamped && (
        <button type="button" className="nexus-marketplace-card-expand" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <div className="nexus-marketplace-card-footer">
        <div className="nexus-marketplace-card-tags">
          {installed && <span className="nexus-marketplace-pill nexus-marketplace-pill-installed">Installed</span>}
          {tagsFor(item).map((t) => (
            <span key={t} className="nexus-marketplace-pill">
              {t}
            </span>
          ))}
        </div>
        <div className="nexus-marketplace-card-actions">
          {!installed ? (
            <button type="button" className="nexus-btn nexus-btn-primary text-xs py-1 px-2" onClick={onInstall}>
              Install
            </button>
          ) : (
            scopes.map((scope) => (
              <button
                key={scope}
                type="button"
                className="nexus-secondary-btn text-xs py-1 px-2"
                onClick={() => onRemove(scope)}
              >
                {scopes.length > 1 ? `Remove (${scope})` : "Remove"}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function InstallModal({
  item,
  hasWorkspace,
  onClose,
  onDone,
}: {
  item: MarketplaceItem
  hasWorkspace: boolean
  onClose: () => void
  onDone: () => void
}) {
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone
  const scopeOptions: { value: "project" | "global"; label: string }[] = hasWorkspace
    ? [
        { value: "project", label: "This workspace" },
        { value: "global", label: "Global (~/.nexus)" },
      ]
    : [{ value: "global", label: "Global (~/.nexus)" }]

  const [scope, setScope] = useState<"project" | "global">(scopeOptions[0]!.value)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [params, setParams] = useState<Record<string, string>>({})

  const methods: McpInstallationMethod[] =
    item.type === "mcp" && Array.isArray((item as McpMarketplaceItem).content)
      ? ((item as McpMarketplaceItem).content as McpInstallationMethod[])
      : []

  const [method, setMethod] = useState<McpInstallationMethod | undefined>(methods[0])

  const prerequisites = (): string[] => {
    if (method?.prerequisites?.length) return method.prerequisites
    return item.prerequisites ?? []
  }

  const parameters = (): McpParameter[] => {
    if (method?.parameters?.length) return method.parameters
    if (item.type === "mcp") return (item as McpMarketplaceItem).parameters ?? []
    return []
  }

  const valid = (): boolean => {
    for (const p of parameters()) {
      if (!p.optional && !params[p.key]?.trim()) return false
    }
    return true
  }

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = ev.data as Record<string, unknown>
      if (msg.type !== "marketplaceInstallResult" || msg.slug !== item.id) return
      setInstalling(false)
      if (msg.success) {
        onDoneRef.current()
        return
      }
      setResult({ ok: false, error: typeof msg.error === "string" ? msg.error : undefined })
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [item.id])

  const doInstall = () => {
    setInstalling(true)
    setResult(null)
    const paramValues: Record<string, unknown> = { ...params }
    if (method) paramValues.__method = method.name
    postMessage({
      type: "installMarketplaceItem",
      mpItem: item,
      mpInstallOptions: {
        target: scope,
        parameters: Object.keys(paramValues).length > 0 ? paramValues : undefined,
      },
    })
  }

  return (
    <div className="nexus-mp-modal-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nexus-mp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Install {item.name}</h3>

        {!result && (
          <>
            <div className="nexus-mp-modal-section">
              <span className="nexus-mp-modal-label">Install scope</span>
              <div className="flex flex-col gap-1">
                {scopeOptions.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="radio"
                      name="mp-scope"
                      checked={scope === o.value}
                      onChange={() => setScope(o.value)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>

            {methods.length > 1 && (
              <div className="nexus-mp-modal-section">
                <span className="nexus-mp-modal-label">Installation method</span>
                <select
                  className="nexus-marketplace-select w-full"
                  value={method?.name ?? ""}
                  onChange={(e) => {
                    const m = methods.find((x) => x.name === e.target.value)
                    setMethod(m)
                    setParams({})
                  }}
                >
                  {methods.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {prerequisites().length > 0 && (
              <div className="nexus-mp-modal-section">
                <span className="nexus-mp-modal-label">Prerequisites</span>
                <ul className="nexus-mp-modal-prereq">
                  {prerequisites().map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {parameters().map((p) => (
              <div key={p.key} className="nexus-mp-modal-section nexus-mp-modal-param">
                <label>
                  {p.name}
                  {p.optional ? " (optional)" : ""}
                </label>
                <input
                  placeholder={p.placeholder ?? ""}
                  value={params[p.key] ?? ""}
                  onChange={(e) => setParams((prev) => ({ ...prev, [p.key]: e.target.value }))}
                />
              </div>
            ))}

            <div className="nexus-mp-modal-footer">
              <button type="button" className="nexus-secondary-btn text-xs" disabled={installing} onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="nexus-btn nexus-btn-primary text-xs"
                disabled={installing || !valid()}
                onClick={doInstall}
              >
                {installing ? "Installing…" : "Install"}
              </button>
            </div>
          </>
        )}

        {result && (
          <div>
            {result.ok ? (
              <p className="nexus-mp-success">Installed successfully.</p>
            ) : (
              <p className="nexus-mp-error">{result.error ?? "Installation failed."}</p>
            )}
            <div className="nexus-mp-modal-footer">
              <button type="button" className="nexus-btn nexus-btn-primary text-xs" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RemoveModal({
  name,
  scope,
  onCancel,
  onConfirm,
}: {
  name: string
  scope: "project" | "global"
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="nexus-mp-modal-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="nexus-mp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Remove {name}?</h3>
        <p className="text-xs text-[var(--vscode-descriptionForeground)] m-0 mb-3">
          Scope: <strong>{scope}</strong>{" "}
          {scope === "project" ? "(this workspace only)" : "(global ~/.nexus)"}
        </p>
        <div className="nexus-mp-modal-footer">
          <button type="button" className="nexus-secondary-btn text-xs" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="nexus-btn text-xs bg-[var(--vscode-errorForeground)] text-[var(--vscode-editor-background)] border-none" onClick={onConfirm}>
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}
