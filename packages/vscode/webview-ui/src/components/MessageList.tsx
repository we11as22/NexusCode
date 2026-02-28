import React, { useEffect, useRef } from "react"
import ReactMarkdown from "react-markdown"
import { ToolCallCard } from "./ToolCallCard.js"
import type { SessionMessage, MessagePart, ToolPart } from "../stores/chat.js"

interface Props {
  messages: SessionMessage[]
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <div>
          <div className="text-4xl mb-3">⚡</div>
          <div className="text-[var(--vscode-foreground)] text-sm font-medium mb-1">NexusCode</div>
          <div className="text-[var(--vscode-descriptionForeground)] text-xs max-w-48">
            AI coding agent combining best practices from all vibe-coding tools.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

function MessageBubble({ message }: { message: SessionMessage }) {
  if (message.summary) {
    return (
      <div className="border border-[var(--vscode-panel-border)] rounded p-2 text-xs">
        <div className="text-[var(--vscode-descriptionForeground)] mb-1 font-medium">📝 Conversation Compacted</div>
        <ReactMarkdown className="prose-nexus text-xs">
          {typeof message.content === "string" ? message.content : ""}
        </ReactMarkdown>
      </div>
    )
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] rounded-lg px-3 py-2 text-sm">
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
      <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">
        {typeof message.content === "string" ? message.content : ""}
      </div>
    )
  }

  // Assistant message
  return (
    <div className="max-w-[95%]">
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
                <code className="bg-[var(--vscode-editor-background)] rounded px-1 py-0.5 text-xs font-mono text-[#4ec9b0]" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="block bg-[var(--vscode-editor-background)] rounded p-2 text-xs font-mono overflow-x-auto text-[var(--vscode-editor-foreground,#d4d4d4)]" {...props}>
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
            return <blockquote className="border-l-2 border-[var(--vscode-panel-border)] pl-2 text-[var(--vscode-descriptionForeground)]">{children}</blockquote>
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
