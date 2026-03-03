import type { ToolDef } from "../../types.js"
import { readFileTool } from "./read-file.js"
import { writeFileTool } from "./write-file.js"
import { replaceInFileTool } from "./replace-in-file.js"
import { executeCommandTool } from "./execute-command.js"
import { grepTool, listFilesTool } from "./search-files.js"
import { listDefinitionsTool } from "./list-definitions.js"
import { codebaseSearchTool } from "./codebase-search.js"
import { webFetchTool, webSearchTool } from "./web-fetch.js"
import { exaWebSearchTool, exaCodeSearchTool } from "./exa-search.js"
import { useSkillTool, browserActionTool } from "./use-skill.js"
import { condenseTool, summarizeTaskTool, planExitTool } from "./context-tools.js"
import {
  attemptCompletionTool,
  askFollowupTool,
  updateTodoTool,
  createRuleTool,
} from "./attempt-completion.js"
import { thinkingPreambleTool } from "./thinking-preamble.js"

export function getAllBuiltinTools(): ToolDef[] {
  return [
    attemptCompletionTool,
    askFollowupTool,
    updateTodoTool,
    thinkingPreambleTool,
    readFileTool,
    listFilesTool,
    listDefinitionsTool,
    writeFileTool,
    replaceInFileTool,
    createRuleTool,
    executeCommandTool,
    grepTool,
    codebaseSearchTool,
    webFetchTool,
    webSearchTool,
    exaWebSearchTool,
    exaCodeSearchTool,

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
  codebaseSearchTool,
  webFetchTool,
  webSearchTool,
  exaWebSearchTool,
  exaCodeSearchTool,
  browserActionTool,
  useSkillTool,
  attemptCompletionTool,
  askFollowupTool,
  updateTodoTool,
  createRuleTool,
  condenseTool,
  summarizeTaskTool,
  planExitTool,
  thinkingPreambleTool,
}
