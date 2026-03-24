/**
 * Tree-sitter definition queries for ListCodeDefinitions (`indexer/definition-queries/`).
 */
export {
  loadDefinitionQueryParsers,
  isDefinitionQueryExtension,
  DEFINITION_QUERY_EXTENSION_KEYS,
  type DefinitionQueryParsersByExt,
} from "./language-parser.js"
export { parseDefinitionsForFile, parseDefinitionsTopLevelDirectory } from "./parse-definitions.js"
