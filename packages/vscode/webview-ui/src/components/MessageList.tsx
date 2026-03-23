import React, { useRef, useState, useCallback, useEffect, useMemo } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ToolCallCard, InlineFileEditBlock } from "./ToolCallCard.js"
import { NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX } from "../constants/questionnaire.js"
import { ExploredSummaryInline, getExplorationItemsFromToolPart, type ExploredPrefixItem } from "./ExploredProgressBlock.js"
import { ThoughtBlock } from "./ThoughtBlock.js"
import { MermaidBlock } from "./MermaidBlock.js"
import { postMessage } from "../vscode.js"
import type { SessionMessage, MessagePart, ToolPart } from "../stores/chat.js"
import type { SubAgentState } from "../stores/chat.js"
import { useChatStore } from "../stores/chat.js"

const FILE_EDIT_TOOLS = new Set(["replace_in_file", "write_to_file", "Edit", "Write"])
const BASH_OUTPUT_TAIL_LINES = 80
const TODO_TOOL_NAMES = new Set(["TodoWrite", "update_todo_list"])
const SPAWN_AGENT_TOOL_NAMES = new Set(["SpawnAgent", "SpawnAgents"])
const HIDDEN_SUBAGENT_ORCHESTRATION_TOOLS = new Set(["SpawnAgentOutput", "SpawnAgentStop"])

function isDeniedFileEdit(part: ToolPart): boolean {
  if (!FILE_EDIT_TOOLS.has(part.tool)) return false
  if (part.status !== "error") return false
  const output = (part.output ?? "").trim()
  return /^User denied (write|edit) /i.test(output)
}

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

/**
 * Compact approval request inline.
 *
 * Layout:
 *   ─────────────────────────────────────
 *   ⚠  Run: echo 'test'          +3 -1
 *   [✓ Allow] [∞ Always] [⌀ Session] [✗]  [↩]
 *   ─────────────────────────────────────
 *
 * [↩] opens "Say what to do instead" textarea.
 */
function ApprovalInline({
  action,
  onResolve,
}: {
  action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } }
  onResolve: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean, whatToDoInstead?: string) => void
}) {
  const [showRedirect, setShowRedirect] = useState(false)
  const [redirectText, setRedirectText] = useState("")

  const label =
    action.type === "execute"
      ? (action.content ? `Run: ${action.content}` : action.description)
      : action.type === "write"
        ? `Edit: ${action.description}`
        : action.description

  const submitRedirect = () => {
    const trimmed = redirectText.trim()
    if (!trimmed) return
    onResolve(false, undefined, undefined, undefined, trimmed)
    setShowRedirect(false)
    setRedirectText("")
  }

  const BTN = "flex-shrink-0 px-2 py-0.5 rounded text-[11px] font-medium border transition-colors"
  const BTN_ALLOW = `${BTN} border-green-600/40 text-green-400 hover:bg-green-600/15`
  const BTN_DENY = `${BTN} border-red-500/40 text-red-400 hover:bg-red-500/15`
  const BTN_NEUTRAL = `${BTN} border-[var(--vscode-panel-border)] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]`

  if (showRedirect) {
    return (
      <div className="border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/20 px-3 py-2 flex flex-col gap-1.5">
        <span className="text-[11px] text-[var(--vscode-descriptionForeground)]">What should the agent do instead?</span>
        <textarea
          value={redirectText}
          onChange={(e) => setRedirectText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitRedirect() }}
          placeholder="e.g. Use npm instead of pnpm"
          className="nexus-input w-full text-xs min-h-[48px] resize-none"
          rows={2}
          autoFocus
        />
        <div className="flex items-center gap-1.5">
          <button type="button" className={BTN_ALLOW} onClick={submitRedirect} disabled={!redirectText.trim()}>Send</button>
          <button type="button" className={BTN_NEUTRAL} onClick={() => { setShowRedirect(false); setRedirectText("") }}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/20 px-3 py-2 space-y-1.5">
      {/* Label row */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="flex-shrink-0 text-[var(--vscode-editorWarning-foreground)] text-[11px]">⚠</span>
        <span className="text-[11px] text-[var(--vscode-foreground)] truncate flex-1 min-w-0" title={label}>{label}</span>
        {action.diffStats != null && (action.diffStats.added > 0 || action.diffStats.removed > 0) && (
          <span className="flex-shrink-0 flex items-center gap-1 text-[10px]">
            {action.diffStats.added > 0 && <span className="text-green-500">+{action.diffStats.added}</span>}
            {action.diffStats.removed > 0 && <span className="text-red-400">-{action.diffStats.removed}</span>}
          </span>
        )}
      </div>
      {/* Action buttons row */}
      <div className="flex items-center gap-1 flex-wrap">
        <button type="button" className={BTN_ALLOW} onClick={() => onResolve(true)} title="Allow once">✓ Allow</button>
        <button type="button" className={BTN_ALLOW} onClick={() => onResolve(true, true)} title="Always allow this tool">∞ Always</button>
        <button type="button" className={BTN_NEUTRAL} onClick={() => onResolve(true, false, undefined, true)} title="Allow all for this session">⌀ Session</button>
        <button type="button" className={BTN_DENY} onClick={() => onResolve(false)} title="Deny">✗</button>
        <button type="button" className={BTN_NEUTRAL} onClick={() => setShowRedirect(true)} title="Say what to do instead">↩</button>
      </div>
    </div>
  )
}

/** Bash (execute_command) block: command in header, expandable output (tail when long). */
function BashCommandBlock({ part, approval }: { part: ToolPart; approval?: React.ReactNode }) {
  // null = follow auto logic; true/false = user override
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  // Auto-expand when command completes; stay collapsed while pending/running (so approval doesn't look like edit field)
  const isDone = part.status === "completed" || part.status === "error"
  const expanded = userExpanded !== null ? userExpanded : isDone
  const setExpanded = (v: boolean) => setUserExpanded(v)
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
        onClick={() => setExpanded(!expanded)}
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
          <pre className="nexus-output-pre text-[11px] font-mono whitespace-pre-wrap break-words overflow-x-auto max-h-64 overflow-y-auto bg-[var(--vscode-textCodeBlock-background)] rounded">
            {displayOutput || " "}
          </pre>
          {part.error && (
            <div className="mt-1 text-red-400 text-[11px] bg-red-500/10 rounded p-2 px-3">{part.error}</div>
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

type ChatRenderItem =
  | {
      type: "message"
      key: string
      message: SessionMessage
      messageIndex: number
      isComplete: boolean
    }
  | {
      type: "assistant_part"
      key: string
      message: SessionMessage
      messageIndex: number
      isComplete: boolean
      parts: MessagePart[]
      part: MessagePart
      partIndex: number
      canonicalReplyIndex: number
      isLastPart: boolean
    }
  | {
      type: "explored"
      key: string
      prefixItems: ExploredPrefixItem[]
      isRunning: boolean
    }

function getCanonicalReplyIndex(parts: MessagePart[]): number {
  const textPartIndices = parts
    .map((part, index) => (part.type === "text" ? index : -1))
    .filter((index) => index >= 0)

  if (textPartIndices.length === 0) return -1

  const withUserMessage = textPartIndices.filter(
    (index) => (parts[index] as { user_message?: string }).user_message?.trim()
  )

  if (withUserMessage.length > 0) return withUserMessage[withUserMessage.length - 1]!
  return textPartIndices[textPartIndices.length - 1]!
}

function hasVisibleTextPart(part: MessagePart): boolean {
  if (part.type !== "text") return false
  const textPart = part as { text?: string; user_message?: string }
  return Boolean(textPart.text?.trim() || textPart.user_message?.trim())
}

function isReasoningPartRenderable(part: MessagePart): boolean {
  if (part.type !== "reasoning") return false
  const reasoning = part as { text?: string }
  const PLACEHOLDER_TEXT = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."
  return Boolean(reasoning.text?.trim()) && reasoning.text !== PLACEHOLDER_TEXT
}

function buildChatRenderItems(messages: SessionMessage[], isRunning: boolean): ChatRenderItem[] {
  const renderItems: ChatRenderItem[] = []
  let pendingReasoning: Array<Extract<ChatRenderItem, { type: "assistant_part" }>> = []
  let activeExploration:
    | {
        key: string
        prefixItems: ExploredPrefixItem[]
      }
    | null = null

  const flushPendingReasoning = () => {
    if (pendingReasoning.length === 0) return
    renderItems.push(...pendingReasoning)
    pendingReasoning = []
  }

  const flushExploration = (running: boolean) => {
    if (!activeExploration || activeExploration.prefixItems.length === 0) {
      activeExploration = null
      return
    }
    renderItems.push({
      type: "explored",
      key: activeExploration.key,
      prefixItems: [...activeExploration.prefixItems],
      isRunning: running,
    })
    activeExploration = null
  }

  messages.forEach((message, messageIndex) => {
    const isComplete = !isRunning || messageIndex < messages.length - 1

    if (message.role !== "assistant" || typeof message.content === "string" || !Array.isArray(message.content)) {
      flushExploration(false)
      flushPendingReasoning()
      renderItems.push({
        type: "message",
        key: message.id,
        message,
        messageIndex,
        isComplete,
      })
      return
    }

    const parts = message.content as MessagePart[]
    const canonicalReplyIndex = getCanonicalReplyIndex(parts)

    parts.forEach((part, partIndex) => {
      const baseItem: Extract<ChatRenderItem, { type: "assistant_part" }> = {
        type: "assistant_part",
        key: `${message.id}-part-${partIndex}`,
        message,
        messageIndex,
        isComplete,
        parts,
        part,
        partIndex,
        canonicalReplyIndex,
        isLastPart: partIndex === parts.length - 1,
      }

      if (part.type === "reasoning") {
        if (activeExploration) {
          if (isReasoningPartRenderable(part)) {
            const reasoning = part as { text: string; durationMs?: number }
            activeExploration.prefixItems.push({
              type: "reasoning",
              text: reasoning.text,
              durationMs: reasoning.durationMs,
            })
          }
          return
        }
        pendingReasoning.push(baseItem)
        return
      }

      if (part.type === "tool") {
        if (TODO_TOOL_NAMES.has((part as ToolPart).tool)) return
        const explorationItems = getExplorationItemsFromToolPart(part as ToolPart)
        if (explorationItems.length > 0) {
          if (!activeExploration) {
            activeExploration = {
              // Never reuse `${message.id}-part-*` here — Virtuoso keys must stay unique vs assistant rows
              // (reusing part-0 caused wrong row reuse / “ghost” duplicates when expanding Thought).
              key: `${message.id}-explored-${partIndex}`,
              prefixItems: pendingReasoning
                .filter((item) => item.part.type === "reasoning" && isReasoningPartRenderable(item.part))
                .map((item) => {
                  const reasoning = item.part as { text: string; durationMs?: number }
                  return {
                    type: "reasoning" as const,
                    text: reasoning.text,
                    durationMs: reasoning.durationMs,
                  }
                }),
            }
            pendingReasoning = []
          }
          activeExploration.prefixItems.push(...explorationItems)
          return
        }

        flushExploration(false)
        flushPendingReasoning()
        renderItems.push(baseItem)
        return
      }

      if (part.type === "text") {
        if (hasVisibleTextPart(part)) {
          flushExploration(false)
          flushPendingReasoning()
          renderItems.push(baseItem)
        }
        return
      }

      flushExploration(false)
      flushPendingReasoning()
      renderItems.push(baseItem)
    })
  })

  if (activeExploration) {
    flushExploration(isRunning)
  } else {
    flushPendingReasoning()
  }

  return renderItems
}

export function MessageList({ messages, isRunning = false, hasOlderMessages = false, loadingOlderMessages = false }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const initialTopMostItemIndexRef = useRef<number | undefined>(undefined)
  const [stickToBottom, setStickToBottom] = useState(true)
  const store = useChatStore()
  const renderedMessages = useMemo(() => buildChatRenderItems(messages, isRunning), [messages, isRunning])
  const virtuosoComponents = useMemo(() => ({ Scroller: MessageListScroller }), [])

  if (initialTopMostItemIndexRef.current == null && renderedMessages.length > 0) {
    initialTopMostItemIndexRef.current = renderedMessages.length - 1
  }

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
          initialTopMostItemIndex={initialTopMostItemIndexRef.current}
          followOutput={stickToBottom ? "auto" : false}
          atBottomStateChange={setStickToBottom}
          atBottomThreshold={10}
          computeItemKey={(_, item) => (item as ChatRenderItem).key}
          itemContent={(idx, item) => (
            <div className="message-list-item">
              <RenderItemRow
                item={item as ChatRenderItem}
                pendingApproval={store.pendingApproval}
                onResolveApproval={store.resolveApproval}
              />
            </div>
          )}
          style={{ height: "100%", minHeight: 0, overflowAnchor: "none" }}
          className="message-list-virtuoso-inner"
          components={virtuosoComponents}
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

function RenderItemRow({
  item,
  pendingApproval,
  onResolveApproval,
}: {
  item: ChatRenderItem
  pendingApproval: { partId: string; action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } } } | null
  onResolveApproval: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean) => void
}) {
  const showReasoningInChat = useChatStore((s) => s.config?.ui?.showReasoningInChat ?? false)
  const reasoningStartTime = useChatStore((s) => s.reasoningStartTime)
  const activeReasoning = useChatStore((s) => s.activeReasoning)
  const isRunning = useChatStore((s) => s.isRunning)

  if (item.type === "explored") {
    return (
      <div className="w-full min-w-0">
        <ExploredSummaryInline
          prefixItems={item.prefixItems}
          isRunning={item.isRunning}
          onOpenFile={(path, line, endLine) =>
            postMessage({ type: "openFileAtLocation", path, line, endLine })
          }
        />
      </div>
    )
  }

  if (item.type === "assistant_part") {
    return (
      <div className="w-full min-w-0">
        <AssistantPartRow
          part={item.part}
          partIndex={item.partIndex}
          parts={item.parts}
          messageId={item.message.id}
          isComplete={item.isComplete}
          isRunning={isRunning}
          reasoningStartTime={reasoningStartTime}
          activeReasoning={activeReasoning}
          canonicalReplyIndex={item.canonicalReplyIndex}
          isLastPart={item.isLastPart}
          pendingApproval={pendingApproval}
          onResolveApproval={onResolveApproval}
          showReasoningInChat={showReasoningInChat}
        />
      </div>
    )
  }

  const { message, messageIndex, isComplete } = item
  const canRollback = messageIndex > 0 && message.role === "user"
  const checkpointEntries = useChatStore((s) => s.checkpointEntries)
  const restoreCheckpoint = useChatStore((s) => s.restoreCheckpoint)
  const showCheckpointDiff = useChatStore((s) => s.showCheckpointDiff)

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
    const checkpointEntry = checkpointEntries.find((entry) => entry.messageId === message.id)
    const userText =
      typeof message.content === "string"
        ? message.content
        : (message.content as MessagePart[])
            .filter(p => p.type === "text")
            .map(p => (p as { text: string }).text)
            .join("")
    if (userText.startsWith(NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX)) {
      const body = userText.slice(NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX.length).trim()
      const lines = body ? body.split("\n").filter(Boolean) : []
      return (
        <div className="nexus-qnr-user-wrap">
          <div className={`nexus-qnr-user-row${canRollback ? " nexus-qnr-user-row--rollback" : ""}`}>
            <div className="nexus-qnr-user-lines">
              {lines.map((line, i) => (
                <div key={i} className="nexus-qnr-user-line" title={line}>
                  {line}
                </div>
              ))}
            </div>
            {canRollback && (
              <MessageCheckpointMenu
                messageId={message.id}
                checkpointHash={checkpointEntry?.hash}
                onCompare={() => checkpointEntry && showCheckpointDiff(checkpointEntry.hash)}
                onRestoreFilesOnly={() => checkpointEntry && restoreCheckpoint(checkpointEntry.hash, "workspace")}
                onRestoreTaskOnly={() => checkpointEntry && restoreCheckpoint(checkpointEntry.hash, "task")}
                onRestoreFilesAndTask={() => checkpointEntry && restoreCheckpoint(checkpointEntry.hash, "taskAndWorkspace")}
              />
            )}
          </div>
        </div>
      )
    }
    return (
      <div className="nexus-user-msg-wrap">
        <div className={`nexus-user-msg-bubble${canRollback ? " nexus-user-msg-bubble-has-rollback" : ""}`}>
          <div className="nexus-user-msg-content">{renderUserTextWithPasteChips(userText)}</div>
          {canRollback && (
            <MessageCheckpointMenu
              messageId={message.id}
              checkpointHash={checkpointEntry?.hash}
              onCompare={() => checkpointEntry && showCheckpointDiff(checkpointEntry.hash)}
              onRestoreFilesOnly={() => checkpointEntry && restoreCheckpoint(checkpointEntry.hash, "workspace")}
              onRestoreTaskOnly={() => checkpointEntry && restoreCheckpoint(checkpointEntry.hash, "task")}
              onRestoreFilesAndTask={() => checkpointEntry && restoreCheckpoint(checkpointEntry.hash, "taskAndWorkspace")}
            />
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
  return (
    <div className="w-full min-w-0">
      {typeof message.content === "string" ? (
        <AssistantText text={message.content} streaming={!isComplete} />
      ) : (
        <AssistantText text="" streaming={false} />
      )}
    </div>
  )
}

function MessageCheckpointMenu({
  messageId,
  checkpointHash,
  onCompare,
  onRestoreFilesOnly,
  onRestoreTaskOnly,
  onRestoreFilesAndTask,
}: {
  messageId: string
  checkpointHash?: string
  onCompare: () => void
  onRestoreFilesOnly: () => void
  onRestoreTaskOnly: () => void
  onRestoreFilesAndTask: () => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("click", close, true)
    return () => document.removeEventListener("click", close, true)
  }, [open])

  return (
    <div className="nexus-rollback-btn-corner nexus-message-checkpoint-wrap" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="nexus-rollback-btn"
        title="Rollback / restore options"
        aria-label="Rollback"
        aria-expanded={open}
      >
        <span className="nexus-rollback-arrow">↶</span>
      </button>
      {open && (
        <div className="nexus-checkpoint-tooltip nexus-message-checkpoint-tooltip">
          <div className="nexus-checkpoint-tooltip-primary">
            <button
              type="button"
              className="nexus-checkpoint-tooltip-btn primary"
              onClick={() => {
                if (checkpointHash) onRestoreFilesAndTask()
                else postMessage({ type: "rollbackToBeforeMessage", messageId })
                setOpen(false)
              }}
            >
              <span className="codicon codicon-debug-restart" aria-hidden />
              Restore Files & Task
            </button>
            <p>Revert files and clear messages after this point</p>
          </div>
          {checkpointHash && (
            <div className="nexus-checkpoint-tooltip-more">
              <div className="nexus-checkpoint-tooltip-option">
                <button
                  type="button"
                  className="nexus-checkpoint-tooltip-btn secondary"
                  onClick={() => {
                    onCompare()
                    setOpen(false)
                  }}
                >
                  <span className="codicon codicon-diff" aria-hidden />
                  Compare
                </button>
                <p>Compare current workspace against this checkpoint</p>
              </div>
              <div className="nexus-checkpoint-tooltip-option">
                <button
                  type="button"
                  className="nexus-checkpoint-tooltip-btn secondary"
                  onClick={() => {
                    onRestoreFilesOnly()
                    setOpen(false)
                  }}
                >
                  <span className="codicon codicon-file-symlink-directory" aria-hidden />
                  Restore Files Only
                </button>
                <p>Revert files to this checkpoint</p>
              </div>
              <div className="nexus-checkpoint-tooltip-option">
                <button
                  type="button"
                  className="nexus-checkpoint-tooltip-btn secondary"
                  onClick={() => {
                    onRestoreTaskOnly()
                    setOpen(false)
                  }}
                >
                  <span className="codicon codicon-comment-discussion" aria-hidden />
                  Restore Task Only
                </button>
                <p>Clear messages after this point</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const MODERN_PASTE_TOKEN = /\[(📋)\s+(bash|text)\s+\((\d+)-(\d+)\)\]/g
const LEGACY_PASTE_TOKEN = /\[Pasted (terminal|text) \((\d+) lines\) #([a-z0-9_-]+)\]/gi

function renderUserTextWithPasteChips(text: string): React.ReactNode {
  const chunks: React.ReactNode[] = []
  let last = 0
  const matches: Array<{ start: number; end: number; kind: "modern" | "legacy"; label: string }> = []

  let m: RegExpExecArray | null
  MODERN_PASTE_TOKEN.lastIndex = 0
  while ((m = MODERN_PASTE_TOKEN.exec(text)) !== null) {
    const full = m[0] ?? ""
    const kind = m[2] ?? "text"
    const from = m[3] ?? "1"
    const to = m[4] ?? "1"
    matches.push({
      start: m.index,
      end: m.index + full.length,
      kind: "modern",
      label: `${kind} (${from}-${to})`,
    })
  }

  LEGACY_PASTE_TOKEN.lastIndex = 0
  while ((m = LEGACY_PASTE_TOKEN.exec(text)) !== null) {
    const full = m[0] ?? ""
    const kind = m[1]?.toLowerCase() === "terminal" ? "bash" : "text"
    const lines = m[2] ?? "1"
    matches.push({
      start: m.index,
      end: m.index + full.length,
      kind: "legacy",
      label: `${kind} (1-${lines})`,
    })
  }

  matches.sort((a, b) => a.start - b.start)
  const deduped = matches.filter((cur, idx, arr) => idx === 0 || cur.start >= arr[idx - 1]!.end)

  for (let i = 0; i < deduped.length; i++) {
    const item = deduped[i]!
    if (item.start > last) chunks.push(<span key={`txt-${i}`}>{text.slice(last, item.start)}</span>)
    chunks.push(
      <span
        key={`chip-${i}`}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-1.5 py-0.5 text-[11px] text-[var(--vscode-descriptionForeground)] align-middle"
      >
        <span aria-hidden>📄</span>
        <span>{item.label}</span>
      </span>
    )
    last = item.end
  }
  if (last < text.length) chunks.push(<span key="txt-last">{text.slice(last)}</span>)
  if (chunks.length === 0) return text
  return chunks
}

/** Recursively extract plain text from React children (used to get mermaid/code source). */
function extractReactText(node: React.ReactNode): string {
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (!node) return ""
  if (Array.isArray(node)) return node.map(extractReactText).join("")
  if (React.isValidElement(node)) return extractReactText((node.props as { children?: React.ReactNode }).children)
  return ""
}

/** Code block wrapper with overflow scroll and copy button (top-right, visible on hover). */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)

  const extractText = (node: React.ReactNode): string => {
    if (typeof node === "string") return node
    if (typeof node === "number") return String(node)
    if (!node) return ""
    if (Array.isArray(node)) return node.map(extractText).join("")
    if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode }).children)
    return ""
  }

  const text = extractText(children).trimEnd()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <div className="relative group/code my-2 max-w-full overflow-x-auto overflow-y-hidden min-w-0 rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <pre className="m-0 p-3 text-xs font-mono bg-transparent overflow-visible whitespace-pre">
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy code"}
        aria-label={copied ? "Copied!" : "Copy code"}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 focus:opacity-100 transition-opacity px-1.5 py-0.5 rounded text-[11px] font-mono leading-none select-none text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  )
}

const AssistantText = React.memo(function AssistantText({ text, streaming, variant = "normal" }: { text: string; streaming?: boolean; variant?: "normal" | "muted" }) {
  const isMuted = variant === "muted"
  if (streaming) {
    return (
      <div className={`text-sm min-w-0 max-w-full overflow-x-hidden break-words whitespace-pre-wrap ${isMuted ? "text-[11px] text-[var(--vscode-descriptionForeground)] opacity-90" : "text-[var(--vscode-foreground)]"}`}>
        {text}
        <span className={`nexus-streaming-cursor inline-block w-0.5 h-4 ml-0.5 align-middle animate-pulse ${isMuted ? "bg-[var(--vscode-descriptionForeground)]" : "bg-[var(--vscode-foreground)]"}`} aria-hidden />
      </div>
    )
  }
  return (
    <div className={`text-sm min-w-0 max-w-full overflow-x-hidden break-words ${isMuted ? "text-[11px] text-[var(--vscode-descriptionForeground)] opacity-90" : "text-[var(--vscode-foreground)]"}`}>
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
            // Block code — no overflow here; CodeBlock wrapper handles it
            return (
              <code className="text-[var(--vscode-editor-foreground,#d4d4d4)]" {...props}>
                {children}
              </code>
            )
          },
          pre({ children }) {
            // Detect mermaid code blocks: <pre><code class="language-mermaid">...</code></pre>
            if (React.isValidElement(children)) {
              const child = children as React.ReactElement<{ className?: string; children?: React.ReactNode }>
              if (child.props?.className?.includes("language-mermaid")) {
                const mermaidCode = extractReactText(child.props.children).trim()
                if (mermaidCode) return <MermaidBlock code={mermaidCode} />
              }
            }
            return <CodeBlock>{children}</CodeBlock>
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
})

function subagentStatusLine(a: SubAgentState): string {
  if (a.status === "completed") return "Done"
  if (a.status === "error") return a.error ? `Error: ${a.error.slice(0, 72)}` : "Failed"
  if (a.currentTool) return `Using ${a.currentTool}`
  const lastTool = a.toolHistory?.[a.toolHistory.length - 1]
  if (lastTool) return `${lastTool} · thinking…`
  return "Starting…"
}

function truncateTask(s: string, max = 56): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : one.slice(0, max - 1) + "…"
}

type SubagentDisplayItem = {
  key: string
  task: string
  status: "running" | "completed" | "error" | "pending"
  detail: string
  toolHistory?: string[]
  error?: string
}

function isSpawnAgentRecipientName(raw: string): boolean {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
  return normalized === "spawnagent" || normalized === "spawnagents"
}

function getSpawnAgentsParallelDescriptions(input?: Record<string, unknown>): string[] {
  const agents = input?.agents
  if (!Array.isArray(agents)) return []
  return agents
    .map((item) => {
      if (item == null || typeof item !== "object") return null
      const description = (item as Record<string, unknown>).description
      return typeof description === "string" && description.trim().length > 0 ? description.trim() : null
    })
    .filter((value): value is string => value != null)
}

function getParallelSpawnAgentDescriptions(input?: Record<string, unknown>): string[] {
  const uses = input?.tool_uses
  if (!Array.isArray(uses)) return []
  return uses
    .map((item) => {
      if (item == null || typeof item !== "object") return null
      const use = item as { recipient_name?: unknown; parameters?: unknown }
      if (typeof use.recipient_name !== "string" || !isSpawnAgentRecipientName(use.recipient_name)) return null
      if (use.parameters == null || typeof use.parameters !== "object") return null
      const description = (use.parameters as Record<string, unknown>).description
      return typeof description === "string" && description.trim().length > 0 ? description.trim() : null
    })
    .filter((value): value is string => value != null)
}

function isPureSubagentParallelTool(part: ToolPart): boolean {
  if (part.tool !== "Parallel" && part.tool !== "parallel") return false
  const uses = part.input?.tool_uses
  if (!Array.isArray(uses) || uses.length === 0) return false
  return uses.every((item) => {
    if (item == null || typeof item !== "object") return false
    const recipientName = (item as { recipient_name?: unknown }).recipient_name
    return typeof recipientName === "string" && isSpawnAgentRecipientName(recipientName)
  })
}

function getSubagentDisplayItems(part: ToolPart): SubagentDisplayItem[] {
  const liveSubagents = part.subagents ?? []
  const isParallelBatch = part.tool === "SpawnAgentsParallel"
  const declaredTasks =
    SPAWN_AGENT_TOOL_NAMES.has(part.tool)
      ? (() => {
          const task = typeof part.input?.description === "string" ? part.input.description.trim() : ""
          return task ? [task] : []
        })()
      : isParallelBatch
        ? getSpawnAgentsParallelDescriptions(part.input)
        : isPureSubagentParallelTool(part)
          ? getParallelSpawnAgentDescriptions(part.input)
          : []

  const items: SubagentDisplayItem[] = []
  const usedLiveIds = new Set<string>()

  declaredTasks.forEach((task, index) => {
    const live = liveSubagents.find((subagent) => subagent.task.trim() === task.trim() && !usedLiveIds.has(subagent.id))
    if (live) {
      usedLiveIds.add(live.id)
      items.push({
        key: live.id,
        task: live.task,
        status: live.status,
        detail: subagentStatusLine(live),
        toolHistory: live.toolHistory,
        error: live.error,
      })
      return
    }
    const isSingleSpawnAgent = SPAWN_AGENT_TOOL_NAMES.has(part.tool) && declaredTasks.length === 1
    items.push({
      key: `${part.id}-pending-${index}`,
      task,
      status:
        isSingleSpawnAgent && part.status === "completed"
          ? "completed"
          : isSingleSpawnAgent && part.status === "error"
            ? "error"
            : isParallelBatch && part.status === "completed"
              ? "completed"
              : isParallelBatch && part.status === "error"
                ? "error"
                : "pending",
      detail:
        isSingleSpawnAgent && part.status === "completed"
          ? "Done"
          : isSingleSpawnAgent && part.status === "error"
            ? (part.error?.trim() || "Failed")
            : isParallelBatch && part.status === "completed"
              ? "Done"
              : "Starting…",
      error: (isSingleSpawnAgent || isParallelBatch) && part.status === "error" ? part.error : undefined,
    })
  })

  liveSubagents.forEach((subagent) => {
    if (usedLiveIds.has(subagent.id)) return
    items.push({
      key: subagent.id,
      task: subagent.task,
      status: subagent.status,
      detail: subagentStatusLine(subagent),
      toolHistory: subagent.toolHistory,
      error: subagent.error,
    })
  })

  return items
}

function StatusCircleIcon({ status }: { status: SubagentDisplayItem["status"] }) {
  if (status === "completed") {
    return (
      <svg className="nexus-subtask-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16.5 9" />
      </svg>
    )
  }
  if (status === "error") {
    return (
      <svg className="nexus-subtask-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9l6 6M15 9l-6 6" />
      </svg>
    )
  }
  return (
    <svg className="nexus-subtask-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  )
}

/** Subagent task cards — standalone UI, without visible Parallel/SpawnAgent tool wrapper. */
function SubagentInlineList({ items }: { items: SubagentDisplayItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="nexus-subagent-inline-outer w-full min-w-0 max-w-full box-border">
    <div className="nexus-subtask-stack">
      {items.map((item) => {
        const isRunning = item.status === "running"
        return (
          <div
            key={item.key}
            className={`nexus-subtask-card ${
              item.status === "completed"
                ? "nexus-subtask-card-done"
                : item.status === "error"
                  ? "nexus-subtask-card-error"
                  : isRunning
                    ? "nexus-subtask-card-running"
                    : "nexus-subtask-card-pending"
            }`}
          >
            <div className="nexus-subtask-status">
              {isRunning ? <SpinnerSubtask /> : <StatusCircleIcon status={item.status} />}
            </div>
            <div className="nexus-subtask-body">
              <div className="nexus-subtask-title" title={item.task}>
                {truncateTask(item.task, 72)}
              </div>
              <div className="nexus-subtask-subtitle">
                {isRunning
                  ? <span className="nexus-subtask-subtitle-shimmer">{item.detail}</span>
                  : item.detail}
              </div>
              {item.error && item.status === "error" && (
                <div className="nexus-subtask-error" title={item.error}>
                  {item.error}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
    </div>
  )
}

function SpinnerSubtask() {
  return (
    <svg className="animate-spin nexus-subtask-status-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" />
      <path className="opacity-80" fill="currentColor" d="M12 3a9 9 0 019 9h-2.5A6.5 6.5 0 0012 5.5V3z" />
    </svg>
  )
}

function AssistantPartRow({
  part,
  partIndex,
  parts,
  messageId,
  isComplete,
  isRunning,
  reasoningStartTime,
  activeReasoning,
  canonicalReplyIndex,
  isLastPart,
  pendingApproval,
  onResolveApproval,
  showReasoningInChat,
}: {
  part: MessagePart
  partIndex: number
  parts: MessagePart[]
  messageId: string
  isComplete: boolean
  isRunning: boolean
  reasoningStartTime: number | null
  activeReasoning: { messageId: string; reasoningId: string } | null
  canonicalReplyIndex: number
  isLastPart: boolean
  pendingApproval: { partId: string; action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } } } | null
  onResolveApproval: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean) => void
  showReasoningInChat: boolean
}) {
  if (part.type === "reasoning") {
    const r = part as { text: string; durationMs?: number; reasoningId?: string }
    const PLACEHOLDER_TEXT = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."
    const reasoningId = r.reasoningId ?? "reasoning-0"
    const isActiveThought =
      !isComplete &&
      isRunning &&
      isLastPart &&
      reasoningStartTime != null &&
      activeReasoning?.messageId === messageId &&
      activeReasoning.reasoningId === reasoningId

    if (isActiveThought) {
      const reasoningText = r.text === PLACEHOLDER_TEXT ? "" : r.text
      return (
        <ThoughtBlock
          key={`${messageId}-${reasoningId}`}
          reasoningText={reasoningText}
          startTime={reasoningStartTime}
          isRunning={true}
        />
      )
    }

    if (!r.text?.trim() || r.text === PLACEHOLDER_TEXT) return null
    return <ThoughtInlineBlock text={r.text} durationMs={r.durationMs} />
  }

  if (part.type === "text") {
    const textPart = part as { text: string; user_message?: string }
    const text = textPart.text
    const userMessage = textPart.user_message?.trim()
    const showStreaming = !isComplete && isLastPart
    if (partIndex !== canonicalReplyIndex) return null
    if (userMessage) {
      return (
        <div className="space-y-0">
          <AssistantText text={userMessage} streaming={false} />
        </div>
      )
    }
    const displayText = text?.trim() ?? ""
    if (!showStreaming && !displayText) return null
    return (
      <div className="space-y-0">
        <AssistantText text={displayText} streaming={showStreaming} variant={showReasoningInChat ? "muted" : "normal"} />
      </div>
    )
  }

  if (part.type === "tool") {
    const toolPart = part as ToolPart
    if (TODO_TOOL_NAMES.has(toolPart.tool)) return null
    if (HIDDEN_SUBAGENT_ORCHESTRATION_TOOLS.has(toolPart.tool)) return null
    if (isDeniedFileEdit(toolPart)) return null
    if (SPAWN_AGENT_TOOL_NAMES.has(toolPart.tool) || isPureSubagentParallelTool(toolPart)) {
      return <SubagentInlineList items={getSubagentDisplayItems(toolPart)} />
    }
    if (toolPart.tool === "replace_in_file" || toolPart.tool === "write_to_file" || toolPart.tool === "Edit" || toolPart.tool === "Write") {
      const approval =
        pendingApproval?.partId === toolPart.id ? (
          <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
        ) : undefined
      return <InlineFileEditBlock part={toolPart} approval={approval} />
    }
    if (toolPart.tool === "execute_command" || toolPart.tool === "Bash") {
      const approval =
        pendingApproval?.partId === toolPart.id ? (
          <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
        ) : undefined
      return <BashCommandBlock part={toolPart} approval={approval} />
    }
    if (
      toolPart.tool === "Parallel" ||
      toolPart.tool === "parallel" ||
      toolPart.tool === "SpawnAgentsParallel"
    ) {
      const displayItems = getSubagentDisplayItems(toolPart)
      const approval =
        pendingApproval?.partId === toolPart.id ? (
          <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
        ) : undefined
      // SpawnAgentsParallel: hide the tool wrapper entirely, only show cards
      if (toolPart.tool === "SpawnAgentsParallel") {
        return (
          <>
            {displayItems.length > 0
              ? <SubagentInlineList items={displayItems} />
              : <ToolCallCard part={toolPart} approval={approval} />}
          </>
        )
      }
      return (
        <>
          <ToolCallCard part={toolPart} approval={approval} />
          {displayItems.length > 0 ? (
            <SubagentInlineList items={displayItems} />
          ) : null}
        </>
      )
    }
    const approval =
      pendingApproval?.partId === toolPart.id ? (
        <ApprovalInline action={pendingApproval.action} onResolve={onResolveApproval} />
      ) : undefined
    return <ToolCallCard part={toolPart} approval={approval} />
  }

  return null
}

/** Thought inline: one reasoning part, tool-like (header + optional duration, expandable body). Always shown chronologically. */
function ThoughtInlineBlock({ text, durationMs }: { text: string; durationMs?: number }) {
  const [open, setOpen] = useState(false)
  const seconds = durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : undefined
  const label = seconds != null ? `Thought for ${seconds}s` : text.trim().length < 80 ? "Thought briefly" : "Thought"

  return (
    <div className="nexus-thought-inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-0 py-1 text-left text-xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
      >
        <span className="flex-shrink-0 text-[10px] transition-transform" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        <span className="flex-shrink-0">{label}</span>
      </button>
      {open && (
        <div className="px-2 pb-1">
          <div className="px-2 py-2 text-[11px] text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans max-h-[min(50vh,320px)] overflow-y-auto border border-[var(--vscode-panel-border)] rounded bg-[var(--vscode-editor-background)]">
            {text.trim() || "Model reasoning is active, but no visible reasoning text was streamed."}
          </div>
        </div>
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
    <div className="nexus-reasoning-block font-sans">
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
