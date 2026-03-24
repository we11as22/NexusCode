/**
 * Top-level directory definition listing + per-file capture formatting (used by ListCodeDefinitions).
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { DefinitionQueryParsersByExt } from "./language-parser.js"
import { loadDefinitionQueryParsers } from "./language-parser.js"

function separateDefinitionListingFiles(allFiles: string[]): { filesToParse: string[] } {
  const extensions = [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".rs",
    ".go",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".rb",
    ".java",
    ".php",
    ".swift",
    ".kt",
  ]
  const filesToParse = allFiles.filter((file) => extensions.includes(path.extname(file).toLowerCase())).slice(0, 50)
  return { filesToParse }
}

/** Immediate children only, capped (non-recursive directory listing). */
async function listTopLevelFiles(dirPath: string, limit: number): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    out.push(path.join(dirPath, e.name))
    if (out.length >= limit) break
  }
  return out
}

/** Tree-sitter captures → `│` lines and `|----` separators. */
export async function parseDefinitionsForFile(
  filePath: string,
  languageParsers: DefinitionQueryParsersByExt,
): Promise<string | null> {
  const fileContent = await fs.readFile(filePath, "utf8")
  const ext = path.extname(filePath).toLowerCase().slice(1)

  const { parser, query } = languageParsers[ext] || {}
  if (!parser || !query) {
    return `Unsupported file type: ${filePath}`
  }

  let formattedOutput = ""

  try {
    const tree = parser.parse(fileContent)
    if (!tree || !tree.rootNode) {
      return null
    }

    const captures = query.captures(tree.rootNode)

    captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

    const lines = fileContent.split("\n")

    let lastLine = -1

    captures.forEach((capture) => {
      const { node, name } = capture
      const startLine = node.startPosition.row
      const endLine = node.endPosition.row

      if (lastLine !== -1 && startLine > lastLine + 1) {
        formattedOutput += "|----\n"
      }
      if (name.includes("name") && lines[startLine]) {
        formattedOutput += `│${lines[startLine]}\n`
      }

      lastLine = endLine
    })
  } catch {
    /* parse error → null */
  }

  if (formattedOutput.length > 0) {
    return `|----\n${formattedOutput}|----\n`
  }
  return null
}

/**
 * Non-recursive: only top-level files under `dirPath`, up to 50 parseable files after extension filter.
 */
export async function parseDefinitionsTopLevelDirectory(dirPath: string): Promise<string> {
  const resolved = path.resolve(dirPath)
  const dirExists = await fs
    .stat(resolved)
    .then((s) => s.isDirectory())
    .catch(() => false)

  if (!dirExists) {
    return "This directory does not exist or you do not have permission to access it."
  }

  const allFiles = await listTopLevelFiles(resolved, 200)
  const { filesToParse } = separateDefinitionListingFiles(allFiles)

  if (filesToParse.length === 0) {
    return "No source code definitions found."
  }

  const languageParsers = await loadDefinitionQueryParsers(filesToParse)

  let result = ""

  for (const filePath of filesToParse) {
    const definitions = await parseDefinitionsForFile(filePath, languageParsers)
    if (definitions) {
      result += `${path.relative(resolved, filePath).replace(/\\/g, "/")}\n${definitions}\n`
    }
  }

  return result ? result : "No source code definitions found."
}
