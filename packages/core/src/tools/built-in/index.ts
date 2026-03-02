import type { ToolDef } from "../../types.js"
import { readFileTool } from "./read-file.js"
import { writeFileTool } from "./write-file.js"
import { replaceInFileTool } from "./replace-in-file.js"
import { applyPatchTool } from "./apply-patch.js"
import { executeCommandTool } from "./execute-command.js"
import { searchFilesTool, listFilesTool } from "./search-files.js"
import { listDefinitionsTool } from "./list-definitions.js"
import { codebaseSearchTool } from "./codebase-search.js"
import { webFetchTool, webSearchTool } from "./web-fetch.js"
import { useSkillTool, browserActionTool } from "./use-skill.js"
import { condenseTool, summarizeTaskTool, planExitTool } from "./context-tools.js"
import {
  attemptCompletionTool,
  askFollowupTool,
  updateTodoTool,
  createRuleTool,
} from "./attempt-completion.js"

export function getAllBuiltinTools(): ToolDef[] {
  return [
    // Always available
    attemptCompletionTool,
    askFollowupTool,
    updateTodoTool,

    // Read group
    readFileTool,
    listFilesTool,
    listDefinitionsTool,

    // Write group
    writeFileTool,
    replaceInFileTool,
    applyPatchTool,
    createRuleTool,

    // Execute group
    executeCommandTool,

    // Search group
    searchFilesTool,
    codebaseSearchTool,
    webFetchTool,
    webSearchTool,

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
  applyPatchTool,
  executeCommandTool,
  searchFilesTool,
  listFilesTool,
  listDefinitionsTool,
  codebaseSearchTool,
  webFetchTool,
  webSearchTool,
  browserActionTool,
  useSkillTool,
  attemptCompletionTool,
  askFollowupTool,
  updateTodoTool,
  createRuleTool,
  condenseTool,
  summarizeTaskTool,
  planExitTool,
}
