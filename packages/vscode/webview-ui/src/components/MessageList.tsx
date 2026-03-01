import React, { useEffect, useRef } from "react"
import ReactMarkdown from "react-markdown"
import { ToolCallCard } from "./ToolCallCard.js"
import type { SessionMessage, MessagePart, ToolPart } from "../stores/chat.js"

interface Props {
  messages: SessionMessage[]
}

export function MessageList({ messages }: Props) {
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
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
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

function MessageBubble({ message }: { message: SessionMessage }) {
  if (message.summary) {
    return (
      <div className="rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--nexus-assistant-bubble)] px-4 py-3 text-xs">
        <div className="text-[var(--vscode-descriptionForeground)] mb-1.5 font-medium">📝 Conversation compacted</div>
        <ReactMarkdown className="prose-nexus text-xs">
          {typeof message.content === "string" ? message.content : ""}
        </ReactMarkdown>
      </div>
    )
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end w-full min-w-0">
        <div
          className="max-w-[92%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm"
          style={{ background: "var(--nexus-user-bubble)", border: "1px solid rgba(0, 120, 212, 0.2)" }}
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

  // Assistant — full-width card like Kilo
  return (
    <div className="w-full min-w-0 rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--nexus-assistant-bubble)] px-4 py-3">
      {typeof message.content === "string" ? (
        <AssistantText text={message.content} />
      ) : (
        <AssistantParts parts={message.content as MessagePart[]} />
      )}
    </div>
  )
}

function AssistantText({ text }: { text: string }) {
  return (
    <div className="text-sm text-[var(--vscode-foreground)]">
      <ReactMarkdown
        className="prose-nexus"
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function AssistantParts({ parts }: { parts: MessagePart[] }) {
  return (
    <div className="space-y-1">
      {parts.map((part, i) => {
        if (part.type === "text" && (part as { text: string }).text) {
          return <AssistantText key={i} text={(part as { text: string }).text} />
        }
        if (part.type === "tool") {
          return <ToolCallCard key={i} part={part as ToolPart} />
        }
        if (part.type === "reasoning") {
          return (
            <details key={i} className="text-xs text-[var(--vscode-descriptionForeground)]">
              <summary className="cursor-pointer hover:text-[var(--vscode-foreground)]">🧠 Reasoning</summary>
              <div className="mt-1 pl-2 border-l border-[var(--vscode-panel-border)] whitespace-pre-wrap">
                {(part as { text: string }).text}
              </div>
            </details>
          )
        }
        return null
      })}
    </div>
  )
}
