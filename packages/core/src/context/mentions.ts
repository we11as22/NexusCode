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
  switch (type) {
    case "file": {
      const absPath = path.resolve(cwd, arg)
      try {
        const content = await fs.readFile(absPath, "utf8")
        const lines = content.split("\n")
        const truncated = lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n[...truncated]" : content
        const relPath = path.relative(cwd, absPath)
        return `<file path="${relPath}">\n${truncated}\n</file>`
      } catch {
        return `<file path="${arg}" error="not found"/>`
      }
    }

    case "folder": {
      const absPath = path.resolve(cwd, arg)
      try {
        const entries = await listDirRecursive(absPath, cwd, 50)
        const relPath = path.relative(cwd, absPath)
        return `<folder path="${relPath}">\n${entries.join("\n")}\n</folder>`
      } catch {
        return `<folder path="${arg}" error="not found"/>`
      }
    }

    case "url": {
      try {
        const response = await fetch(arg, {
          headers: { "User-Agent": "NexusCode/1.0" },
          signal: AbortSignal.timeout(15000),
        })
        const text = await response.text()
        const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n[...truncated]" : text
        return `<url href="${arg}">\n${truncated}\n</url>`
      } catch {
        return `<url href="${arg}" error="fetch failed"/>`
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
      try {
        const { execa } = await import("execa")
        const { stdout } = await execa("git", ["diff", "--stat", "HEAD"], { cwd })
        const status = await execa("git", ["status", "--short"], { cwd })
        return `<git_state>\n${status.stdout}\n\n${stdout}\n</git_state>`
      } catch {
        return null
      }
    }

    default:
      return null
  }
}

async function listDirRecursive(dir: string, cwd: string, maxEntries: number): Promise<string[]> {
  const entries: string[] = []
  async function walk(d: string, prefix: string) {
    if (entries.length >= maxEntries) return
    const items = await fs.readdir(d).catch(() => [] as string[])
    for (const item of items) {
      if (entries.length >= maxEntries) break
      if (item === "node_modules" || item === ".git") continue
      const full = path.join(d, item)
      const rel = path.relative(cwd, full)
      const st = await fs.stat(full).catch(() => null)
      if (!st) continue
      entries.push(prefix + item + (st.isDirectory() ? "/" : ""))
      if (st.isDirectory()) await walk(full, prefix + "  ")
    }
  }
  await walk(dir, "")
  return entries
}
