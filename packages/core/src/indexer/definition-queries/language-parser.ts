/**
 * Loads web-tree-sitter grammars from `tree-sitter-wasms` + core `tree-sitter.wasm` (`wasm-paths`).
 */
import * as path from "node:path"
import { Parser, Language, Query } from "web-tree-sitter"
import {
  cppQuery,
  cQuery,
  csharpQuery,
  goQuery,
  javaQuery,
  javascriptQuery,
  kotlinQuery,
  phpQuery,
  pythonQuery,
  rubyQuery,
  rustQuery,
  swiftQuery,
  typescriptQuery,
} from "./queries/index.js"
import { getTreeSitterLanguageWasmsDir, getWebTreeSitterWasmPath } from "../roo/wasm-paths.js"

/** Parsers + definition queries keyed by file extension (no leading dot). */
export interface DefinitionQueryParsersByExt {
  [key: string]: {
    parser: Parser
    query: Query
  }
}

async function loadLanguage(langName: string): Promise<Language> {
  const wasmPath = path.join(getTreeSitterLanguageWasmsDir(), `tree-sitter-${langName}.wasm`)
  return await Language.load(wasmPath)
}

let isParserInitialized = false

async function initializeParser(): Promise<void> {
  if (!isParserInitialized) {
    await Parser.init({
      locateFile: () => getWebTreeSitterWasmPath(),
    })
    isParserInitialized = true
  }
}

export async function loadDefinitionQueryParsers(filesToParse: string[]): Promise<DefinitionQueryParsersByExt> {
  await initializeParser()
  const extensionsToLoad = new Set(filesToParse.map((file) => path.extname(file).toLowerCase().slice(1)))
  const parsers: DefinitionQueryParsersByExt = {}

  for (const ext of extensionsToLoad) {
    let language: Language
    let query: Query
    switch (ext) {
      case "js":
      case "jsx":
        language = await loadLanguage("javascript")
        query = language.query(javascriptQuery)
        break
      case "ts":
        language = await loadLanguage("typescript")
        query = language.query(typescriptQuery)
        break
      case "tsx":
        language = await loadLanguage("tsx")
        query = language.query(typescriptQuery)
        break
      case "py":
        language = await loadLanguage("python")
        query = language.query(pythonQuery)
        break
      case "rs":
        language = await loadLanguage("rust")
        query = language.query(rustQuery)
        break
      case "go":
        language = await loadLanguage("go")
        query = language.query(goQuery)
        break
      case "cpp":
      case "hpp":
        language = await loadLanguage("cpp")
        query = language.query(cppQuery)
        break
      case "c":
      case "h":
        language = await loadLanguage("c")
        query = language.query(cQuery)
        break
      case "cs":
        language = await loadLanguage("c_sharp")
        query = language.query(csharpQuery)
        break
      case "rb":
        language = await loadLanguage("ruby")
        query = language.query(rubyQuery)
        break
      case "java":
        language = await loadLanguage("java")
        query = language.query(javaQuery)
        break
      case "php":
        language = await loadLanguage("php")
        query = language.query(phpQuery)
        break
      case "swift":
        language = await loadLanguage("swift")
        query = language.query(swiftQuery)
        break
      case "kt":
        language = await loadLanguage("kotlin")
        query = language.query(kotlinQuery)
        break
      default:
        throw new Error(`Unsupported language: ${ext}`)
    }
    const parser = new Parser()
    parser.setLanguage(language)
    parsers[ext] = { parser, query }
  }
  return parsers
}

/** Extensions covered by `./queries` definition strings. */
export const DEFINITION_QUERY_EXTENSION_KEYS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "go",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "java",
  "php",
  "swift",
  "kt",
])

export function isDefinitionQueryExtension(extWithDot: string): boolean {
  const k = extWithDot.toLowerCase().replace(/^\./, "")
  return DEFINITION_QUERY_EXTENSION_KEYS.has(k)
}
