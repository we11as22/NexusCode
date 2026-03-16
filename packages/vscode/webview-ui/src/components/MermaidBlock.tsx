import React, { useEffect, useRef, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import mermaid from "mermaid"

// ─── Mermaid one-time initialization ───────────────────────────────────────
let _initialized = false
function ensureInit() {
  if (_initialized) return
  _initialized = true
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "dark",
    suppressErrorRendering: true,
    themeVariables: {
      background: "#1e1e1e",
      textColor: "#d4d4d4",
      mainBkg: "#2d2d2d",
      nodeBorder: "#6b6b6b",
      lineColor: "#cccccc",
      primaryColor: "#3c3c3c",
      primaryTextColor: "#ffffff",
      primaryBorderColor: "#6b6b6b",
      secondaryColor: "#2d2d2d",
      tertiaryColor: "#454545",
      classText: "#ffffff",
      labelColor: "#ffffff",
      actorBkg: "#2d2d2d",
      actorBorder: "#6b6b6b",
      actorTextColor: "#ffffff",
      noteTextColor: "#ffffff",
      noteBkgColor: "#454545",
      noteBorderColor: "#888888",
      critBorderColor: "#ff9580",
      critBkgColor: "#803d36",
      linkColor: "#6cb6ff",
      titleColor: "#ffffff",
      fontSize: "14px",
      fontFamily:
        "var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif)",
    },
  })
}

// ─── Types ──────────────────────────────────────────────────────────────────
interface MermaidBlockProps {
  code: string
}

// ─── Shared button styles ────────────────────────────────────────────────────
const ACTION_BTN: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vscode-foreground)",
  cursor: "pointer",
  padding: "3px 6px",
  fontSize: 13,
  lineHeight: 1,
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  opacity: 0.85,
}

const MODAL_BTN: React.CSSProperties = {
  background: "var(--vscode-list-hoverBackground)",
  border: "1px solid var(--vscode-panel-border)",
  borderRadius: 4,
  color: "var(--vscode-foreground)",
  cursor: "pointer",
  padding: "3px 10px",
  fontSize: 12,
  lineHeight: "1.5",
  minWidth: 28,
}

// ─── Main component ──────────────────────────────────────────────────────────
export function MermaidBlock({ code }: MermaidBlockProps) {
  const [svgHtml, setSvgHtml] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [copied, setCopied] = useState(false)
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renderIdRef = useRef(0)

  // ── Render on code change ────────────────────────────────────────────────
  useEffect(() => {
    ensureInit()
    setIsLoading(true)
    setError(null)
    setSvgHtml("")
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current)

    const currentId = ++renderIdRef.current
    renderTimerRef.current = setTimeout(async () => {
      try {
        await mermaid.parse(code)
        const id = `mermaid-${currentId}-${Math.random().toString(36).slice(2, 8)}`
        const { svg } = await mermaid.render(id, code)
        if (renderIdRef.current === currentId) {
          setSvgHtml(svg)
          setError(null)
        }
      } catch (err: unknown) {
        if (renderIdRef.current === currentId) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (renderIdRef.current === currentId) {
          setIsLoading(false)
        }
      }
    }, 350)

    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current)
    }
  }, [code])

  // ── Copy code ────────────────────────────────────────────────────────────
  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(code)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        /* ignore */
      }
    },
    [code],
  )

  // ── Open fullscreen modal ────────────────────────────────────────────────
  const openFullscreen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowModal(true)
  }, [])

  // ── Escape closes modal ──────────────────────────────────────────────────
  useEffect(() => {
    if (!showModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowModal(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [showModal])

  return (
    <>
      {showModal &&
        createPortal(
          <FullscreenModal
            svgHtml={svgHtml}
            code={code}
            onClose={() => setShowModal(false)}
          />,
          document.body,
        )}

      {/* Inline diagram block */}
      <div
        className="group/mermaid"
        style={{ position: "relative", margin: "10px 0" }}
      >
        {isLoading && (
          <div
            style={{
              padding: "12px 14px",
              color: "var(--vscode-descriptionForeground)",
              fontSize: 11,
              fontStyle: "italic",
            }}
          >
            Rendering diagram…
          </div>
        )}

        {error && !isLoading && (
          <MermaidError error={error} code={code} />
        )}

        {!error && svgHtml && (
          <div style={{ position: "relative" }}>
            {/* ── Hover action buttons top-right ── */}
            <div
              className="opacity-0 group-hover/mermaid:opacity-100 transition-opacity"
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                zIndex: 10,
                display: "flex",
                gap: 2,
                background:
                  "color-mix(in srgb, var(--vscode-editor-background) 90%, transparent 10%)",
                border: "1px solid var(--vscode-panel-border)",
                borderRadius: 6,
                padding: "2px 3px",
                backdropFilter: "blur(2px)",
              }}
            >
              <button
                onClick={handleCopy}
                title={copied ? "Copied!" : "Copy diagram source"}
                style={ACTION_BTN}
              >
                {copied ? "✓" : "⎘"}
              </button>
              <button
                onClick={openFullscreen}
                title="Open fullscreen"
                style={ACTION_BTN}
              >
                ⛶
              </button>
            </div>

            {/* ── Scrollable SVG container ── */}
            <div
              style={{
                overflowX: "auto",
                overflowY: "visible",
                border: "1px solid var(--vscode-panel-border)",
                borderRadius: 8,
                background: "#1e1e1e",
                padding: "14px",
                display: "flex",
                justifyContent: "flex-start",
              }}
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          </div>
        )}
      </div>
    </>
  )
}

// ─── Fullscreen modal ────────────────────────────────────────────────────────
function FullscreenModal({
  svgHtml,
  code,
  onClose,
}: {
  svgHtml: string
  code: string
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(0.9)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [tab, setTab] = useState<"diagram" | "code">("diagram")
  const [copied, setCopied] = useState(false)

  const adjustZoom = useCallback((delta: number) => {
    setZoom((z) => Math.max(0.1, Math.min(20, z + delta)))
  }, [])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (tab !== "diagram") return
      e.preventDefault()
      e.stopPropagation()
      adjustZoom(e.deltaY > 0 ? -0.12 : 0.12)
    },
    [tab, adjustZoom],
  )

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }, [code])

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999999,
        display: "flex",
        flexDirection: "column",
        background: "var(--vscode-editor-background)",
      }}
      onWheel={handleWheel}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          borderBottom: "1px solid var(--vscode-panel-border)",
          flexShrink: 0,
          gap: 8,
        }}
      >
        {/* Tab switcher */}
        <div style={{ display: "flex", gap: 2 }}>
          {(["diagram", "code"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...MODAL_BTN,
                background:
                  tab === t
                    ? "var(--vscode-list-activeSelectionBackground)"
                    : "transparent",
                color:
                  tab === t
                    ? "var(--vscode-list-activeSelectionForeground)"
                    : "var(--vscode-descriptionForeground)",
                border: "1px solid transparent",
                textTransform: "capitalize",
              }}
            >
              {t === "diagram" ? "📊 Diagram" : "{ } Code"}
            </button>
          ))}
        </div>

        {/* Right controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {tab === "diagram" && (
            <>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--vscode-descriptionForeground)",
                  minWidth: 36,
                  textAlign: "center",
                }}
              >
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => adjustZoom(-0.2)}
                style={MODAL_BTN}
                title="Zoom out"
              >
                −
              </button>
              <button
                onClick={() => {
                  setZoom(0.9)
                  setPos({ x: 0, y: 0 })
                }}
                style={MODAL_BTN}
                title="Reset zoom"
              >
                ↺
              </button>
              <button
                onClick={() => adjustZoom(0.2)}
                style={MODAL_BTN}
                title="Zoom in"
              >
                +
              </button>
              <div
                style={{
                  width: 1,
                  height: 18,
                  background: "var(--vscode-panel-border)",
                  margin: "0 4px",
                }}
              />
            </>
          )}
          <button
            onClick={handleCopy}
            style={MODAL_BTN}
            title="Copy diagram source"
          >
            {copied ? "✓ Copied" : "⎘ Copy"}
          </button>
          <button
            onClick={onClose}
            style={{ ...MODAL_BTN, marginLeft: 4 }}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── Content area ── */}
      {tab === "diagram" ? (
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            cursor: dragging ? "grabbing" : "grab",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            userSelect: "none",
          }}
          onMouseDown={(e) => {
            setDragging(true)
            e.preventDefault()
          }}
          onMouseMove={(e) => {
            if (!dragging) return
            setPos((p) => ({
              x: p.x + e.movementX / zoom,
              y: p.y + e.movementY / zoom,
            }))
          }}
          onMouseUp={() => setDragging(false)}
          onMouseLeave={() => setDragging(false)}
        >
          <div
            style={{
              transform: `scale(${zoom}) translate(${pos.x}px, ${pos.y}px)`,
              transformOrigin: "center center",
              transition: dragging ? "none" : "transform 0.08s ease",
            }}
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <textarea
            readOnly
            value={code}
            style={{
              flex: 1,
              resize: "none",
              background: "var(--vscode-textCodeBlock-background)",
              color: "var(--vscode-editor-foreground)",
              border: "1px solid var(--vscode-panel-border)",
              borderRadius: 6,
              padding: 12,
              fontFamily: "var(--vscode-editor-font-family, monospace)",
              fontSize: "var(--vscode-editor-font-size, 13px)",
              outline: "none",
              lineHeight: 1.5,
            }}
          />
        </div>
      )}

      {/* ── Footer hint (diagram tab only) ── */}
      {tab === "diagram" && (
        <div
          style={{
            flexShrink: 0,
            padding: "4px 12px",
            borderTop: "1px solid var(--vscode-panel-border)",
            fontSize: 10,
            color: "var(--vscode-descriptionForeground)",
            opacity: 0.6,
            textAlign: "center",
          }}
        >
          Scroll wheel to zoom · Drag to pan · Esc to close
        </div>
      )}
    </div>
  )
}

// ─── Error display ────────────────────────────────────────────────────────────
function MermaidError({ error, code }: { error: string; code: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      style={{
        border: "1px solid var(--vscode-panel-border)",
        borderRadius: 8,
        overflow: "hidden",
        fontSize: 11,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "rgba(255,100,100,0.06)",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
      >
        <span style={{ color: "var(--vscode-editorWarning-foreground)" }}>
          ⚠
        </span>
        <span style={{ flex: 1, color: "var(--vscode-foreground)" }}>
          Diagram render error
        </span>
        <span
          style={{
            color: "var(--vscode-descriptionForeground)",
            fontSize: 10,
          }}
        >
          {expanded ? "▲ hide" : "▼ show details"}
        </span>
      </div>
      {expanded && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--vscode-editor-background)",
          }}
        >
          <div
            style={{
              color: "var(--vscode-descriptionForeground)",
              marginBottom: 8,
              whiteSpace: "pre-wrap",
              fontSize: 10,
            }}
          >
            {error}
          </div>
          <pre
            style={{
              fontSize: 10,
              color: "var(--vscode-editor-foreground)",
              background: "var(--vscode-textCodeBlock-background)",
              padding: 8,
              borderRadius: 4,
              margin: 0,
              overflowX: "auto",
              whiteSpace: "pre",
            }}
          >
            {code}
          </pre>
        </div>
      )}
    </div>
  )
}
