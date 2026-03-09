import React, { useRef, useState, useCallback, useEffect, useMemo } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ToolCallCard, InlineFileEditBlock } from "./ToolCallCard.js"
import { getExploredPrefixFromParts, ExploredSummaryInline } from "./ExploredProgressBlock.js"
import { ThoughtBlock } from "./ThoughtBlock.js"
import { postMessage } from "../vscode.js"
import type { SessionMessage, MessagePart, ToolPart } from "../stores/chat.js"
import type { SubAgentState } from "../stores/chat.js"
import { useChatStore } from "../stores/chat.js"

const FILE_EDIT_TOOLS = new Set(["replace_in_file", "write_to_file", "Edit", "Write"])
const BASH_OUTPUT_TAIL_LINES = 80

const MessageListScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  (props, ref) => (
    <div
      {...props}
      ref={ref}
      className={`${props.className ?? ""} nexus-message-list-scroller`.trim()}
      style={{ ...props.style, minHeight: 0 }}
    />
  )
)
MessageListScroller.displayName = "MessageListScroller"

/** Approval request inline (Cline/Roo-style: Allow once, Always allow, Deny, Add to allowed for folder, Allow all session, Say what to do instead). */
function ApprovalInline({
  action,
  onResolve,
}: {
  action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } }
  onResolve: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean, whatToDoInstead?: string) => void
}) {
  const [showWhatToDoInstead, setShowWhatToDoInstead] = useState(false)
  const [whatToDoText, setWhatToDoText] = useState("")

  const label =
    action.type === "execute"
      ? (action.content ? `Run: ${action.content}` : action.description)
      : action.type === "write"
        ? `Edit file: ${action.description}`
        : action.description

  const submitWhatToDoInstead = () => {
    const trimmed = whatToDoText.trim()
    if (trimmed) {
      onResolve(false, undefined, undefined, undefined, trimmed)
      setShowWhatToDoInstead(false)
      setWhatToDoText("")
    }
  }

  if (showWhatToDoInstead) {
    return (
      <div className="nexus-approval-inline border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/30 px-3 py-2 flex flex-col gap-2">
        <span className="text-xs text-[var(--vscode-foreground)]">What should the agent do instead?</span>
        <textarea
          value={whatToDoText}
          onChange={(e) => setWhatToDoText(e.target.value)}
          placeholder="e.g. Use npm instead of pnpm"
          className="nexus-input w-full text-sm min-h-[60px] resize-y"
          rows={2}
          autoFocus
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="nexus-approval-inline-btn nexus-approval-inline-btn-allow"
            onClick={submitWhatToDoInstead}
            disabled={!whatToDoText.trim()}
          >
            Send
          </button>
          <button
            type="button"
            className="nexus-approval-inline-btn nexus-approval-inline-btn-deny"
            onClick={() => { setShowWhatToDoInstead(false); setWhatToDoText("") }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="nexus-approval-inline border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/30 px-3 py-2 flex flex-wrap items-center gap-2">
      <span className="nexus-approval-inline-icon text-[var(--vscode-editorWarning-foreground)]" title="Permission required">
        ⚠
      </span>
      <span className="nexus-approval-inline-text text-xs text-[var(--vscode-foreground)] truncate flex-1 min-w-0">
        {label}
      </span>
      {action.diffStats != null && (action.diffStats.added > 0 || action.diffStats.removed > 0) && (
        <span className="nexus-approval-inline-stats flex items-center gap-1 flex-shrink-0 text-[10px]">
          {action.diffStats.added > 0 && <span className="text-green-500">+{action.diffStats.added}</span>}
          {action.diffStats.removed > 0 && <span className="text-red-400">-{action.diffStats.removed}</span>}
        </span>
      )}
      <div className="nexus-approval-inline-buttons flex items-center gap-1.5 flex-shrink-0 flex-wrap">
        <button
          type="button"
          className="nexus-approval-inline-btn nexus-approval-inline-btn-allow"
          onClick={() => onResolve(true)}
        >
          Allow once
        </button>
        {action.type === "execute" && (
          <button
            type="button"
            className="nexus-approval-inline-btn nexus-approval-inline-btn-allow"
            onClick={() => onResolve(true, false, action.content)}
          >
            Add to allowed for this folder
          </button>
        )}
        <button
          type="button"
          className="nexus-approval-inline-btn nexus-approval-inline-btn-always"
          onClick={() => onResolve(true, true)}
        >
          Always allow
        </button>
        <button
          type="button"
          className="nexus-approval-inline-btn nexus-approval-inline-btn-session"
          onClick={() => onResolve(true, false, undefined, true)}
        >
          Allow all (session)
        </button>
        <button
          type="button"
          className="nexus-approval-inline-btn text-[var(--vscode-descriptionForeground)]"
          onClick={() => setShowWhatToDoInstead(true)}
        >
          Say what to do instead
        </button>
        <button
          type="button"
          className="nexus-approval-inline-btn nexus-approval-inline-btn-deny"
          onClick={() => onResolve(false)}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

/** Bash (execute_command) block: command in header, expandable output (tail when long). */
function BashCommandBlock({ part, approval }: { part: ToolPart; approval?: React.ReactNode }) {
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
      {approval}
    </div>
  )
}

interface Props {
  messages: SessionMessage[]
  isRunning?: boolean
  /** When true, show "Load older" at top (server session with more messages above). */
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
}

export function MessageList({ messages, isRunning = false, hasOlderMessages = false, loadingOlderMessages = false }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  const store = useChatStore()
  const renderedMessages = useMemo(() => mergeConsecutiveAssistantMessages(messages), [messages])

  const jumpToLatest = useCallback(() => {
    setStickToBottom(true)
    virtuosoRef.current?.scrollToIndex({
      index: renderedMessages.length - 1,
      behavior: "smooth",
      align: "end",
    })
  }, [renderedMessages.length])

  if (renderedMessages.length === 0) {
    return (
      <div className="message-list-container">
        <div className="message-list message-list-content-empty" />
      </div>
    )
  }

  return (
    <div className="message-list-container">
      {hasOlderMessages && (
        <div className="message-list-load-older">
          <button
            type="button"
            onClick={() => postMessage({ type: "loadOlderMessages" })}
            disabled={loadingOlderMessages}
            className="nexus-load-older-btn"
            title="Load older messages"
          >
            {loadingOlderMessages ? "Loading…" : "Load older messages"}
          </button>
        </div>
      )}
      <div className="message-list-virtuoso">
        <div className="message-list-virtuoso-wrap">
        <Virtuoso
          ref={virtuosoRef}
          data={renderedMessages}
          initialTopMostItemIndex={renderedMessages.length > 0 ? renderedMessages.length - 1 : undefined}
          followOutput={stickToBottom ? "auto" : false}
          atBottomStateChange={setStickToBottom}
          computeItemKey={(_, msg) => (msg as SessionMessage).id}
          itemContent={(idx, msg) => (
            <div className="message-list-item">
              <MessageBubble
                message={msg}
                messageIndex={idx}
                isComplete={!isRunning || idx < renderedMessages.length - 1}
                pendingApproval={store.pendingApproval}
                onResolveApproval={store.resolveApproval}
              />
            </div>
          )}
          style={{ height: "100%", minHeight: 0 }}
          className="message-list-virtuoso-inner"
          components={{
            Scroller: MessageListScroller,
          }}
        />
        </div>
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

function mergeConsecutiveAssistantMessages(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length < 2) return messages
  const merged: SessionMessage[] = []
  for (const message of messages) {
    const prev = merged[merged.length - 1]
    if (
      prev?.role === "assistant" &&
      message.role === "assistant" &&
      !prev.summary &&
      !message.summary &&
      Array.isArray(prev.content) &&
      Array.isArray(message.content)
    ) {
      merged[merged.length - 1] = {
        ...prev,
        ts: message.ts,
        content: [...(prev.content as MessagePart[]), ...(message.content as MessagePart[])],
      }
      continue
    }
    merged.push(message)
  }
  return merged
}

function MessageBubble({
  message,
  messageIndex,
  isComplete,
  pendingApproval,
  onResolveApproval,
}: {
  message: SessionMessage
  messageIndex: number
  isComplete: boolean
  pendingApproval: { partId: string; action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } } } | null
  onResolveApproval: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean) => void
}) {
  const canRollback = messageIndex > 0 && message.role === "user"

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
      <div className="nexus-user-msg-wrap">
        <div className={`nexus-user-msg-bubble${canRollback ? " nexus-user-msg-bubble-has-rollback" : ""}`}>
          <div className="nexus-user-msg-content">
            {typeof message.content === "string"
              ? message.content
              : (message.content as MessagePart[])
                  .filter(p => p.type === "text")
                  .map(p => (p as { text: string }).text)
                  .join("")}
          </div>
          {canRollback && (
            <button
              type="button"
              onClick={() => postMessage({ type: "rollbackToBeforeMessage", messageId: message.id })}
              className="nexus-rollback-btn nexus-rollback-btn-corner"
              title="Откатить чат и изменения до состояния до этого сообщения"
              aria-label="Rollback"
            >
              <span className="nexus-rollback-arrow">↶</span>
            </button>
          )}
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
  const showReasoningInChat = useChatStore((s) => s.config?.ui?.showReasoningInChat ?? false)
  const reasoningStartTime = useChatStore((s) => s.reasoningStartTime)
  const isRunning = useChatStore((s) => s.isRunning)
  return (
    <div className="w-full min-w-0">
      {typeof message.content === "string" ? (
        <AssistantText text={message.content} streaming={!isComplete} />
      ) : (
        <AssistantParts
          parts={message.content as MessagePart[]}
          isComplete={isComplete}
          isRunning={isRunning}
          reasoningStartTime={reasoningStartTime}
          pendingApproval={pendingApproval}
          onResolveApproval={onResolveApproval}
          showReasoningInChat={showReasoningInChat}
        />
      )}
    </div>
  )
}

function AssistantText({ text, streaming, variant = "normal" }: { text: string; streaming?: boolean; variant?: "normal" | "muted" }) {
  const isMuted = variant === "muted"
  return (
    <div className={`text-sm min-w-0 break-words ${isMuted ? "text-[11px] text-[var(--vscode-descriptionForeground)] opacity-90" : "text-[var(--vscode-foreground)]"}`}>
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
      {streaming && (
        <span className={`nexus-streaming-cursor inline-block w-0.5 h-4 ml-0.5 align-middle animate-pulse ${isMuted ? "bg-[var(--vscode-descriptionForeground)]" : "bg-[var(--vscode-foreground)]"}`} aria-hidden />
      )}
    </div>
  )
}

const SUBAGENT_TOOL_LABELS: Record<string, string> = {
  read_file: "Reading file",
  Read: "Reading file",
  list_dir: "Listing directory",
  List: "Listing directory",
  list_code_definitions: "Listing definitions",
  ListCodeDefinitions: "Listing definitions",
  search_files: "Searching files",
  codebase_search: "Searching codebase",
  CodebaseSearch: "Searching codebase",
  grep: "Searching files",
  Grep: "Searching files",
  write_to_file: "Edit file",
  replace_in_file: "Edit file",
  Write: "Edit file",
  Edit: "Edit file",
  execute_command: "Bash",
  Bash: "Bash",
  web_fetch: "Fetching URL",
  web_search: "Web search",
  use_skill: "Using skill",
  batch: "Batch operation",
}

function subagentStatusLine(a: SubAgentState): string {
  if (a.status === "completed") return "Completed"
  if (a.status === "error") return a.error ? `Failed: ${a.error.slice(0, 60)}` : "Failed"
  if (a.currentTool) return SUBAGENT_TOOL_LABELS[a.currentTool] ?? `Running ${a.currentTool}`
  return "Starting…"
}

function truncateTask(s: string, max = 56): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : one.slice(0, max - 1) + "…"
}

/** Subagents inline under the SpawnAgents tool card; one line per subagent (task + dynamic status). */
function SubagentInlineList({ subagents }: { subagents: SubAgentState[] }) {
  return (
    <div className="mt-1.5 ml-1 space-y-1">
      {subagents.map((a) => (
        <div
          key={a.id}
          className={`rounded border px-2 py-1.5 text-xs ${
            a.status === "completed"
              ? "border-green-500/30 bg-green-500/10"
              : a.status === "error"
                ? "border-red-500/30 bg-red-500/10"
                : "border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/20"
          }`}
        >
          <div className="font-medium text-[var(--vscode-foreground)] truncate" title={a.task}>
            {truncateTask(a.task)}
          </div>
          <div className="text-[11px] text-[var(--vscode-descriptionForeground)] mt-0.5">
            {subagentStatusLine(a)}
          </div>
          {a.error && a.status === "error" && (
            <div className="text-[10px] text-red-400 mt-1 truncate" title={a.error}>
              {a.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AssistantParts({
  parts,
  isComplete,
  isRunning,
  reasoningStartTime,
  pendingApproval,
  onResolveApproval,
  showReasoningInChat,
}: {
  parts: MessagePart[]
  isComplete: boolean
  isRunning: boolean
  reasoningStartTime: number | null
  pendingApproval: { partId: string; action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } } } | null
  onResolveApproval: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean) => void
  showReasoningInChat: boolean
}) {
  const { prefixItems, prefixIndices } = getExploredPrefixFromParts(parts)
  const hasExploredBlock = prefixItems.length > 0

  // Single reply per message: show only one block (canonical part) to avoid multiple identical bubbles.
  const textPartIndices = parts
    .map((p, i) => (p.type === "text" ? i : -1))
    .filter((i) => i >= 0)
  const canonicalReplyIndex =
    textPartIndices.length === 0
      ? -1
      : (() => {
          const withUserMessage = textPartIndices.filter(
            (i) => (parts[i] as { user_message?: string }).user_message?.trim()
          )
          if (withUserMessage.length > 0) return withUserMessage[withUserMessage.length - 1]!
          return textPartIndices[textPartIndices.length - 1]!
        })()

  return (
    <div className="space-y-3">
      {/* Explored: reasoning + exploration tools in order. Collapsed by default so user can expand to see Thoughts and tools. */}
      {hasExploredBlock && (
        <ExploredSummaryInline
          prefixItems={prefixItems}
          defaultCollapsed={true}
          onOpenFile={(path, line, endLine) =>
            postMessage({ type: "openFileAtLocation", path, line, endLine })
          }
        />
      )}
      {parts.map((part, i) => {
        if (prefixIndices.has(i)) return null
        if (part.type === "reasoning") {
          const r = part as { text: string; durationMs?: number }
          const isLastPart = i === parts.length - 1
          const showLiveThought = !isComplete && isRunning && isLastPart && reasoningStartTime != null
          if (showLiveThought) {
            return (
              <ThoughtBlock
                key={i}
                reasoningText={r.text}
                startTime={reasoningStartTime}
                isRunning={true}
              />
            )
          }
          return (
            <ThoughtInlineBlock
              key={i}
              text={r.text}
              durationMs={r.durationMs}
            />
          )
        }
        if (part.type === "text") {
          const textPart = part as { text: string; user_message?: string }
          const text = textPart.text
          const userMessage = textPart.user_message?.trim()
          const isLastPart = i === parts.length - 1
          const showStreaming = !isComplete && isLastPart
          if (i !== canonicalReplyIndex) return null
          // Main reply: prefer tool-written summary (user_message); otherwise show streamed/model text so it never disappears.
          const hasToolReply = !!userMessage
          const displayText = text?.trim() ?? ""
          if (hasToolReply) {
            return (
              <div key={i} className="space-y-0">
                <AssistantText text={userMessage!} streaming={false} />
              </div>
            )
          }
          // Show model's text as main reply (always, so streamed content stays visible after done/stateUpdate).
          if (!showStreaming && !displayText) return null
          return (
            <div key={i} className="space-y-0">
              <AssistantText text={displayText} streaming={showStreaming} variant={showReasoningInChat ? "muted" : "normal"} />
            </div>
          )
        }
        if (part.type === "tool") {
          const toolPart = part as ToolPart
          if (toolPart.tool === "replace_in_file" || toolPart.tool === "write_to_file" || toolPart.tool === "Edit" || toolPart.tool === "Write") {
            const approval =
              pendingApproval?.partId === toolPart.id ? (
                <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
              ) : undefined
            return <InlineFileEditBlock key={i} part={toolPart} approval={approval} />
          }
          if (toolPart.tool === "execute_command" || toolPart.tool === "Bash") {
            const approval =
              pendingApproval?.partId === toolPart.id ? (
                <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
              ) : undefined
            return <BashCommandBlock key={i} part={toolPart} approval={approval} />
          }
          if (toolPart.tool === "thinking_preamble") {
            const reasoning = (toolPart.input?.reasoning_and_next_actions as string)?.trim()
            if (reasoning) {
              return (
                <ThoughtInlineBlock
                  key={i}
                  text={reasoning}
                  durationMs={toolPart.timeStart != null && toolPart.timeEnd != null ? toolPart.timeEnd - toolPart.timeStart : undefined}
                />
              )
            }
            return null
          }
          if (toolPart.tool === "SpawnAgents") {
            const approval =
              pendingApproval?.partId === toolPart.id ? (
                <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
              ) : undefined
            return (
              <React.Fragment key={i}>
                <ToolCallCard part={toolPart} approval={approval} />
                {toolPart.subagents && toolPart.subagents.length > 0 ? (
                  <SubagentInlineList subagents={toolPart.subagents} />
                ) : null}
              </React.Fragment>
            )
          }
          const approval =
            pendingApproval?.partId === toolPart.id ? (
              <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
            ) : undefined
          return <ToolCallCard key={i} part={toolPart} approval={approval} />
        }
        if (part.type === "reasoning") {
          return null
        }
        return null
      })}
    </div>
  )
}

/** Thought inline: one reasoning part, tool-like (header + optional duration, expandable body). Always shown chronologically. */
function ThoughtInlineBlock({ text, durationMs }: { text: string; durationMs?: number }) {
  const [open, setOpen] = useState(true)
  const durationStr = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : ""
  return (
    <div className="my-2 rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
      >
        <span className="flex-shrink-0" title="Thought">💭</span>
        <span className="flex-shrink-0 font-medium">Thought{durationStr}</span>
        <span className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
      </button>
      {open && text.trim() && (
        <div className="border-t border-[var(--vscode-panel-border)] px-3 py-2 text-[11px] text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans max-h-[min(50vh,320px)] overflow-y-auto">
          {text.trim()}
        </div>
      )}
    </div>
  )
}

/** Thinking preamble:
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
