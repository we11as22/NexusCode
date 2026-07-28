import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { IHost, DiagnosticItem } from "../types.js"

const MENTION_REGEX = /@(file|folder|url|problems|git|terminal):([^\s]+)|@(problems|git|terminal)/g

export interface ResolvedMention {
  original: string
  type: string
  content: string
}

/**
 * Parse @mentions in text and resolve them to content.
 * @file:path, @folder:path, @url:..., @problems, @git, @terminal
 */
export async function parseMentions(
  text: string,
  cwd: string,
  host?: IHost
): Promise<{ text: string; contextBlocks: string[] }> {
  const mentions: ResolvedMention[] = []
  const regex = new RegExp(MENTION_REGEX.source, "g")
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const type = match[1] ?? match[3] ?? ""
    const arg = match[2] ?? ""

    const resolved = await resolveMention(type, arg, cwd, host)
    if (resolved) {
      mentions.push({ original: match[0]!, type, content: resolved })
    }
  }

  if (mentions.length === 0) return { text, contextBlocks: [] }

  // Replace mentions in text with placeholders
  let processedText = text
  const contextBlocks: string[] = []

  for (const mention of mentions) {
    const blockId = `mention_${mention.type}`
    processedText = processedText.replace(mention.original, `[${mention.type} context below]`)
    contextBlocks.push(mention.content)
  }

  return { text: processedText, contextBlocks }
}

async function resolveMention(
  type: string,
  arg: string,
  cwd: string,
  host?: IHost
): Promise<string | null> {
  if (host?.resolveAtMention) {
    const custom = await host.resolveAtMention(
      `@${type}${arg ? `:${arg}` : ""}`,
    ).catch(() => null)
    if (custom != null) return custom
  }

  switch (type) {
    case "file": {
      if (!host) return `<file path="${safeAttribute(arg)}" error="unavailable"/>`
      try {
        const absPath = await host.resolvePath(arg, "read")
        const content = await host.readFile(absPath, {
          maxBytes: 512 * 1024,
        })
        const lines = content.split("\n")
        const truncated = lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n[...truncated]" : content
        const relPath = path.relative(cwd, absPath)
        return `<file path="${safeAttribute(relPath)}">\n${truncated}\n</file>`
      } catch {
        return `<file path="${safeAttribute(arg)}" error="unavailable"/>`
      }
    }

    case "folder": {
      if (!host) return `<folder path="${safeAttribute(arg)}" error="unavailable"/>`
      try {
        const absPath = await host.resolvePath(arg, "list")
        const entries = await listDirRecursive(absPath, 50)
        const relPath = path.relative(cwd, absPath)
        return `<folder path="${safeAttribute(relPath)}">\n${entries.join("\n")}\n</folder>`
      } catch {
        return `<folder path="${safeAttribute(arg)}" error="unavailable"/>`
      }
    }

    case "url": {
      try {
        const parsed = new URL(arg)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("unsupported protocol")
        }
        return (
          `<url href="${safeAttribute(parsed.toString())}">` +
          "URL was referenced by the user but not fetched during prompt construction. " +
          "Use the permission-aware WebFetch tool if page content is needed." +
          "</url>"
        )
      } catch {
        return `<url href="${safeAttribute(arg)}" error="invalid URL"/>`
      }
    }

    case "problems": {
      if (!host?.getProblems) return null
      try {
        const problems = await host.getProblems()
        if (problems.length === 0) return `<problems>No diagnostics found.</problems>`
        const formatted = problems.slice(0, 50).map(p =>
          `[${p.severity.toUpperCase()}] ${p.file}:${p.line} — ${p.message}`
        ).join("\n")
        return `<problems>\n${formatted}\n</problems>`
      } catch {
        return null
      }
    }

    case "git": {
      return (
        "<git_context_request>" +
        "Git state was referenced by the user but no process was launched during prompt construction. " +
        "Use the permission-aware GitInspect tool when it is available." +
        "</git_context_request>"
      )
    }

    case "terminal": {
      return (
        "<terminal_context_request>" +
        "Terminal context was referenced by the user, but this host did not provide a trusted terminal snapshot." +
        "</terminal_context_request>"
      )
    }

    default:
      return null
  }
}

function safeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

async function listDirRecursive(
  dir: string,
  maxEntries: number,
): Promise<string[]> {
  const entries: string[] = []
  async function walk(d: string, prefix: string) {
    if (entries.length >= maxEntries) return
    const items = await fs.readdir(d).catch(() => [] as string[])
    for (const item of items) {
      if (entries.length >= maxEntries) break
      if (item === "node_modules" || item === ".git") continue
      const full = path.join(d, item)
      const st = await fs.lstat(full).catch(() => null)
      if (!st) continue
      if (st.isSymbolicLink()) {
        entries.push(`${prefix}${item}@`)
        continue
      }
      entries.push(prefix + item + (st.isDirectory() ? "/" : ""))
      if (st.isDirectory()) await walk(full, prefix + "  ")
    }
  }
  await walk(dir, "")
  return entries
}
