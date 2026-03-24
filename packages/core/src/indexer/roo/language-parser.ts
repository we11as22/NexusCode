/**
 * Tree-sitter language loading for vector semantic chunks (`tree-sitter-wasms` + `web-tree-sitter` WASM).
 */
import * as path from "node:path"
import { Parser, Language, Query, type Language as LanguageT, type Query as QueryT } from "web-tree-sitter"
import {
  javascriptQuery,
  typescriptQuery,
  tsxQuery,
  pythonQuery,
  rustQuery,
  goQuery,
  cppQuery,
  cQuery,
  csharpQuery,
  rubyQuery,
  javaQuery,
  phpQuery,
  htmlQuery,
  swiftQuery,
  kotlinQuery,
  cssQuery,
  ocamlQuery,
  solidityQuery,
  tomlQuery,
  vueQuery,
  luaQuery,
  systemrdlQuery,
  tlaPlusQuery,
  zigQuery,
  embeddedTemplateQuery,
  elispQuery,
  elixirQuery,
} from "./queries/index.js"
import { getTreeSitterLanguageWasmsDir, getWebTreeSitterWasmPath } from "./wasm-paths.js"

export interface LanguageParser {
  [key: string]: {
    parser: Parser
    query: QueryT
  }
}

async function loadLanguage(langName: string): Promise<LanguageT> {
  const wasmPath = path.join(getTreeSitterLanguageWasmsDir(), `tree-sitter-${langName}.wasm`)
  try {
    return await Language.load(wasmPath)
  } catch (error) {
    console.error(`[nexus/roo] Error loading language: ${wasmPath}: ${error instanceof Error ? error.message : error}`)
    throw error
  }
}

let isParserInitialized = false

export async function loadRequiredLanguageParsers(filesToParse: string[]): Promise<LanguageParser> {
  if (!isParserInitialized) {
    try {
      await Parser.init({
        locateFile: () => getWebTreeSitterWasmPath(),
      })
      isParserInitialized = true
    } catch (error) {
      console.error(`[nexus/roo] Error initializing Parser: ${error instanceof Error ? error.message : error}`)
      throw error
    }
  }

  const extensionsToLoad = new Set(filesToParse.map((file) => path.extname(file).toLowerCase().slice(1)))
  const parsers: LanguageParser = {}

  for (const ext of extensionsToLoad) {
    let language: LanguageT
    let query: QueryT
    let parserKey = ext

    switch (ext) {
      case "js":
      case "jsx":
      case "json":
        language = await loadLanguage("javascript")
        query = new Query(language, javascriptQuery)
        break
      case "ts":
        language = await loadLanguage("typescript")
        query = new Query(language, typescriptQuery)
        break
      case "tsx":
        language = await loadLanguage("tsx")
        query = new Query(language, tsxQuery)
        break
      case "py":
        language = await loadLanguage("python")
        query = new Query(language, pythonQuery)
        break
      case "rs":
        language = await loadLanguage("rust")
        query = new Query(language, rustQuery)
        break
      case "go":
        language = await loadLanguage("go")
        query = new Query(language, goQuery)
        break
      case "cpp":
      case "hpp":
        language = await loadLanguage("cpp")
        query = new Query(language, cppQuery)
        break
      case "c":
      case "h":
        language = await loadLanguage("c")
        query = new Query(language, cQuery)
        break
      case "cs":
        language = await loadLanguage("c_sharp")
        query = new Query(language, csharpQuery)
        break
      case "rb":
        language = await loadLanguage("ruby")
        query = new Query(language, rubyQuery)
        break
      case "java":
        language = await loadLanguage("java")
        query = new Query(language, javaQuery)
        break
      case "php":
        language = await loadLanguage("php")
        query = new Query(language, phpQuery)
        break
      case "swift":
        language = await loadLanguage("swift")
        query = new Query(language, swiftQuery)
        break
      case "kt":
      case "kts":
        language = await loadLanguage("kotlin")
        query = new Query(language, kotlinQuery)
        break
      case "css":
        language = await loadLanguage("css")
        query = new Query(language, cssQuery)
        break
      case "html":
      case "htm":
        language = await loadLanguage("html")
        query = new Query(language, htmlQuery)
        break
      case "ml":
      case "mli":
        language = await loadLanguage("ocaml")
        query = new Query(language, ocamlQuery)
        break
      case "scala":
        language = await loadLanguage("scala")
        query = new Query(language, luaQuery) // Scala: temporary Lua query until a dedicated Scala query ships
        break
      case "sol":
        language = await loadLanguage("solidity")
        query = new Query(language, solidityQuery)
        break
      case "toml":
        language = await loadLanguage("toml")
        query = new Query(language, tomlQuery)
        break
      case "vue":
        language = await loadLanguage("vue")
        query = new Query(language, vueQuery)
        break
      case "lua":
        language = await loadLanguage("lua")
        query = new Query(language, luaQuery)
        break
      case "rdl":
        language = await loadLanguage("systemrdl")
        query = new Query(language, systemrdlQuery)
        break
      case "tla":
        language = await loadLanguage("tlaplus")
        query = new Query(language, tlaPlusQuery)
        break
      case "zig":
        language = await loadLanguage("zig")
        query = new Query(language, zigQuery)
        break
      case "ejs":
      case "erb":
        parserKey = "embedded_template"
        language = await loadLanguage("embedded_template")
        query = new Query(language, embeddedTemplateQuery)
        break
      case "el":
        language = await loadLanguage("elisp")
        query = new Query(language, elispQuery)
        break
      case "ex":
      case "exs":
        language = await loadLanguage("elixir")
        query = new Query(language, elixirQuery)
        break
      default:
        throw new Error(`Unsupported language: ${ext}`)
    }

    const parser = new Parser()
    parser.setLanguage(language)
    parsers[parserKey] = { parser, query }
  }

  return parsers
}
