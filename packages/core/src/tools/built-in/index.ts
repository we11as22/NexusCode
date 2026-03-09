import type { ToolDef } from "../../types.js"
import { readFileTool } from "./read-file.js"
import { writeFileTool } from "./write-file.js"
import { editTool } from "./replace-in-file.js"
import { bashTool } from "./execute-command.js"
import { bashOutputTool } from "./bash-output.js"
import { killBashTool } from "./kill-bash.js"
import { grepTool, listTool } from "./search-files.js"
import { listDefinitionsTool } from "./list-definitions.js"
import { readLintsTool } from "./read-lints.js"
import { codebaseSearchTool } from "./codebase-search.js"
import { webFetchTool, webSearchTool } from "./web-fetch.js"
import { globFileSearchTool } from "./glob-file-search.js"
import { useSkillTool } from "./use-skill.js"
import { condenseTool, planExitTool } from "./context-tools.js"
import {
  askFollowupTool,
  todoWriteTool,
} from "./report-and-control.js"
import { parallelTool } from "./parallel.js"

export function getAllBuiltinTools(): ToolDef[] {
  return [
    askFollowupTool,
    todoWriteTool,
    parallelTool,
    readFileTool,
    listTool,
    listDefinitionsTool,
    readLintsTool,
    writeFileTool,
    editTool,
    bashTool,
    bashOutputTool,
    killBashTool,
    grepTool,
    codebaseSearchTool,
    webFetchTool,
    webSearchTool,
    globFileSearchTool,

    condenseTool,
    planExitTool,

    useSkillTool,
  ]
}

export {
  readFileTool,
  writeFileTool,
  editTool,
  parallelTool,
  bashTool,
  bashOutputTool,
  killBashTool,
  grepTool,
  listTool,
  listDefinitionsTool,
  readLintsTool,
  codebaseSearchTool,
  webFetchTool,
  webSearchTool,
  globFileSearchTool,
  useSkillTool,
  askFollowupTool,
  todoWriteTool,
  condenseTool,
  planExitTool,
}
