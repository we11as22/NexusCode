import React, { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ToolCallCard, InlineFileEditBlock } from "./ToolCallCard.js"
import { getExploredFromParts, getExploredPrefixFromParts, ExploredSummaryInline } from "./ExploredProgressBlock.js"
import { postMessage } from "../vscode.js"
import type { SessionMessage, MessagePart, ToolPart } from "../stores/chat.js"

const FILE_EDIT_TOOLS = new Set(["replace_in_file", "write_to_file"])
const BASH_OUTPUT_TAIL_LINES = 80

/** Bash (execute_command) block: command in header, expandable output (tail when long). */
function BashCommandBlock({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(true)
  const command = (part.input?.command as string)?.trim() ?? ""
  const output = (part.output ?? "").trim()
  const lines = output ? output.split("\n") : []
  const showTail = lines.length > BASH_OUTPUT_TAIL_LINES
  const displayLines = showTail ? lines.slice(-BASH_OUTPUT_TAIL_LINES) : lines
  const displayOutput = displayLines.join("\n")
  const elapsed =
    part.timeStart != null && part.timeEnd != null
      ? `${((part.timeEnd - part.timeStart) / 1000).toFixed(1)}s`
      : null
  const shortCommand = command.length > 72 ? command.slice(0, 69) + "…" : command

  return (
    <div className="my-2 rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
      >
        <span className="flex-shrink-0" title="bash">⌨️</span>
        <span className="flex-shrink-0 font-mono">bash</span>
        <span className="flex-1 min-w-0 truncate font-mono text-[var(--vscode-descriptionForeground)]" title={command}>
          {shortCommand || "—"}
        </span>
        {elapsed && <span className="flex-shrink-0 text-[var(--vscode-descriptionForeground)]">{elapsed}</span>}
        <span className="flex-shrink-0 text-[var(--vscode-descriptionForeground)]">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (output || part.error) && (
        <div className="border-t border-[var(--vscode-panel-border)] px-3 py-2">
          {showTail && (
            <div className="text-[10px] text-[var(--vscode-descriptionForeground)] mb-1">
              … last {BASH_OUTPUT_TAIL_LINES} lines (of {lines.length})
            </div>
          )}
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words overflow-x-auto max-h-64 overflow-y-auto bg-[var(--vscode-textCodeBlock-background)] rounded p-2">
            {displayOutput || " "}
          </pre>
          {part.error && (
            <div className="mt-1 text-red-400 text-[11px] bg-red-500/10 rounded p-2">{part.error}</div>
          )}
        </div>
      )}
    </div>
  )
}

interface Props {
  messages: SessionMessage[]
  isRunning?: boolean
}

export function MessageList({ messages, isRunning = false }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = React.useState(true)

  useEffect(() => {
    if (!stickToBottom) return
    bottomRef.current?.scrollIntoView({ behavior: "auto" })
  }, [messages, stickToBottom])

  const handleScroll = () => {
    const el = listRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    setStickToBottom(distanceToBottom < 24)
  }

  const jumpToLatest = () => {
    setStickToBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  if (messages.length === 0) {
    return (
      <div className="message-list-container">
        <div className="message-list">
          <div className="message-list-content-empty">
            <div className="message-list-empty">
              <div className="w-10 h-10 rounded-xl border border-[var(--nexus-accent)]/40 bg-[var(--nexus-accent-muted)] flex items-center justify-center text-[var(--nexus-accent)] font-bold">NX</div>
              <p className="text-[var(--vscode-foreground)] text-sm font-semibold mb-1.5">NexusCode</p>
              <p className="text-[var(--vscode-descriptionForeground)] text-xs leading-relaxed max-w-[260px]">
                AI coding agent. Ask anything or describe a task — use @ to add files or context.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="message-list-container">
      <div ref={listRef} onScroll={handleScroll} className="message-list flex flex-col space-y-4">
        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isComplete={!isRunning || idx < messages.length - 1}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {!stickToBottom && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="nexus-jump-latest"
          title="Jump to latest message"
        >
          Jump to latest
        </button>
      )}
    </div>
  )
}

function MessageBubble({ message, isComplete }: { message: SessionMessage; isComplete: boolean }) {
  if (message.summary) {
    return (
      <div className="text-xs text-[var(--vscode-descriptionForeground)] py-2">
        <div className="font-medium mb-1">📝 Conversation compacted</div>
        <ReactMarkdown className="prose-nexus text-xs" remarkPlugins={[remarkGfm]}>
          {typeof message.content === "string" ? message.content : ""}
        </ReactMarkdown>
      </div>
    )
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-start w-full min-w-0">
        <div
          className="max-w-[92%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm bg-[var(--vscode-editor-inactiveSelectionBackground)] border border-[var(--vscode-panel-border)]"
          style={{ background: "var(--vscode-editor-inactiveSelectionBackground)", borderColor: "var(--vscode-panel-border)" }}
        >
          {typeof message.content === "string"
            ? message.content
            : (message.content as MessagePart[])
                .filter(p => p.type === "text")
                .map(p => (p as { text: string }).text)
                .join("")}
        </div>
      </div>
    )
  }

  if (message.role === "system") {
    return (
      <div className="rounded-xl px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20">
        {typeof message.content === "string" ? message.content : ""}
      </div>
    )
  }

  // Assistant — on chat background, no frame (only user messages are in a bubble)
  return (
    <div className="w-full min-w-0">
      {typeof message.content === "string" ? (
        <AssistantText text={message.content} />
      ) : (
        <AssistantParts parts={message.content as MessagePart[]} isComplete={isComplete} />
      )}
    </div>
  )
}

function AssistantText({ text }: { text: string }) {
  return (
    <div className="text-sm text-[var(--vscode-foreground)] min-w-0 break-words">
      <ReactMarkdown
        className="prose-nexus"
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const isInline = !className
            if (isInline) {
              return (
                <code className="bg-[var(--vscode-editor-background)] rounded px-1.5 py-0.5 text-xs font-mono text-[var(--nexus-accent)]" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="block bg-[var(--vscode-editor-background)] rounded-lg p-3 text-xs font-mono overflow-x-auto text-[var(--vscode-editor-foreground,#d4d4d4)] border border-[var(--vscode-panel-border)]" {...props}>
                {children}
              </code>
            )
          },
          pre({ children }) {
            return <pre className="my-2">{children}</pre>
          },
          p({ children }) {
            return <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
          },
          ul({ children }) {
            return <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>
          },
          ol({ children }) {
            return <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>
          },
          h1({ children }) { return <h1 className="text-base font-bold mb-2">{children}</h1> },
          h2({ children }) { return <h2 className="text-sm font-bold mb-1.5">{children}</h2> },
          h3({ children }) { return <h3 className="text-sm font-semibold mb-1">{children}</h3> },
          blockquote({ children }) {
            return <blockquote className="border-l-4 border-[var(--nexus-accent)] pl-3 py-0.5 my-2 text-[var(--vscode-descriptionForeground)] bg-[var(--nexus-accent-muted)] rounded-r">{children}</blockquote>
          },
          table({ children }) {
            return <div className="nexus-markdown-table-wrap my-2 overflow-x-auto"><table className="nexus-markdown-table">{children}</table></div>
          },
          thead({ children }) {
            return <thead className="nexus-markdown-thead">{children}</thead>
          },
          tbody({ children }) {
            return <tbody className="nexus-markdown-tbody">{children}</tbody>
          },
          tr({ children }) {
            return <tr className="nexus-markdown-tr">{children}</tr>
          },
          th({ children }) {
            return <th className="nexus-markdown-th">{children}</th>
          },
          td({ children }) {
            return <td className="nexus-markdown-td">{children}</td>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function AssistantParts({ parts, isComplete }: { parts: MessagePart[]; isComplete: boolean }) {
  const { prefixParts, prefixIndices } = getExploredPrefixFromParts(parts)
  const explored = getExploredFromParts(prefixParts)
  const hasExploredBlock = (explored.filesCount > 0 || explored.searchesCount > 0) && prefixParts.length > 0

  return (
    <div className="space-y-3">
      {/* Explored block at top so it doesn't jump when new content streams below; only exploration tools before first other tool/text */}
      {hasExploredBlock && (
        <ExploredSummaryInline
          filesCount={explored.filesCount}
          searchesCount={explored.searchesCount}
          entries={explored.entries}
          defaultCollapsed={isComplete}
          onOpenFile={(path, line, endLine) =>
            postMessage({ type: "openFileAtLocation", path, line, endLine })
          }
        />
      )}
      {parts.map((part, i) => {
        if (prefixIndices.has(i)) return null
        if (part.type === "text") {
          const text = (part as { text: string }).text
          if (!text || !text.trim()) return null
          return <AssistantText key={i} text={text} />
        }
        if (part.type === "tool") {
          const toolPart = part as ToolPart
          if (toolPart.tool === "replace_in_file" || toolPart.tool === "write_to_file") {
            return <InlineFileEditBlock key={i} part={toolPart} />
          }
          if (toolPart.tool === "execute_command") {
            return <BashCommandBlock key={i} part={toolPart} />
          }
          if (toolPart.tool === "thinking_preamble") {
            const userMsg = (toolPart.input?.user_message as string)?.trim()
            const reasoning = (toolPart.input?.reasoning_and_next_actions as string) || ""
            if (userMsg || reasoning) return <ThinkingPreambleBlock key={i} userMessage={userMsg} reasoning={reasoning} />
            return <ToolCallCard key={i} part={toolPart} />
          }
          return null
        }
        if (part.type === "reasoning") {
          const reasoningText = (part as { text: string }).text
          if (!reasoningText.trim()) return null
          return (
            <ReasoningPartBlock key={i} text={reasoningText} />
          )
        }
        return null
      })}
    </div>
  )
}

/** Thinking preamble: reasoning (required) + optional user-visible message — on chat background, no frame */
function ThinkingPreambleBlock({ userMessage, reasoning }: { userMessage: string; reasoning: string }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const hasReasoning = reasoning.trim().length > 0
  return (
    <div className="nexus-thinking-preamble-block my-2 font-sans">
      {userMessage ? (
        <div className="px-0 py-1 text-sm text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans" style={{ fontFamily: "var(--vscode-font-family)" }}>
          {userMessage}
        </div>
      ) : null}
      {hasReasoning && (
        <>
          <button
            type="button"
            onClick={() => setShowReasoning(!showReasoning)}
            className="text-[10px] text-[var(--nexus-accent)] hover:bg-[var(--vscode-list-hoverBackground)] rounded px-0 py-1"
          >
            {showReasoning ? "Hide reasoning" : "Show reasoning"}
          </button>
          {showReasoning && (
            <div className="px-0 py-2 text-xs text-[var(--vscode-descriptionForeground)] whitespace-pre-wrap break-words border-t border-[var(--vscode-panel-border)] font-sans mt-1" style={{ fontFamily: "var(--vscode-font-family)" }}>
              {reasoning}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Inline reasoning/thinking block — on chat background, no frame */
function ReasoningPartBlock({ text }: { text: string }) {
  const [collapsed, setCollapsed] = useState(false)
  const isLong = text.length > 600
  const displayText = collapsed && isLong ? text.slice(0, 600) + "\n…" : text

  return (
    <div className="nexus-reasoning-block my-2 font-sans">
      <div className="px-0 py-1 text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans" style={{ fontFamily: "var(--vscode-font-family)" }}>
        {displayText}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-[10px] text-[var(--nexus-accent)] hover:bg-[var(--vscode-list-hoverBackground)] rounded px-0 py-1"
        >
          {collapsed ? "Show more" : "Show less"}
        </button>
      )}
    </div>
  )
}
