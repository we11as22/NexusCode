import type { ToolDef } from "../../types.js"
import { readFileTool } from "./read-file.js"
import { writeFileTool } from "./write-file.js"
import { replaceInFileTool } from "./replace-in-file.js"
import { executeCommandTool } from "./execute-command.js"
import { grepTool, listFilesTool } from "./search-files.js"
import { listDefinitionsTool } from "./list-definitions.js"
import { readLintsTool } from "./read-lints.js"
import { codebaseSearchTool } from "./codebase-search.js"
import { webFetchTool, webSearchTool } from "./web-fetch.js"
import { globFileSearchTool } from "./glob-file-search.js"
import { useSkillTool, browserActionTool } from "./use-skill.js"
import { condenseTool, summarizeTaskTool, planExitTool } from "./context-tools.js"
import {
  askFollowupTool,
  updateTodoTool,
  createRuleTool,
  reportToUserTool,
  progressNoteTool,
} from "./report-and-control.js"

export function getAllBuiltinTools(): ToolDef[] {
  return [
    askFollowupTool,
    updateTodoTool,
    reportToUserTool,
    progressNoteTool,
    readFileTool,
    listFilesTool,
    listDefinitionsTool,
    readLintsTool,
    writeFileTool,
    replaceInFileTool,
    createRuleTool,
    executeCommandTool,
    grepTool,
    codebaseSearchTool,
    webFetchTool,
    webSearchTool,
    globFileSearchTool,

    // Browser group
    browserActionTool,

    // Context (Cline-style)
    condenseTool,
    summarizeTaskTool,
    planExitTool,

    // Skills group
    useSkillTool,
  ]
}

export {
  readFileTool,
  writeFileTool,
  replaceInFileTool,
  executeCommandTool,
  grepTool,
  listFilesTool,
  listDefinitionsTool,
  readLintsTool,
  codebaseSearchTool,
  webFetchTool,
  webSearchTool,
  globFileSearchTool,
  browserActionTool,
  useSkillTool,
  askFollowupTool,
  updateTodoTool,
  createRuleTool,
  condenseTool,
  summarizeTaskTool,
  planExitTool,
  reportToUserTool,
  progressNoteTool,
}
