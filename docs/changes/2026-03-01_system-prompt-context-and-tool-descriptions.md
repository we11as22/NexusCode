# System prompt context length and tool descriptions

**Date:** 2026-03-01

## Summary

- **Context in system prompt:** The agent now sees context window usage at the start of each turn (used/limit tokens and %) so it can manage long conversations (e.g. use `condense` when usage is high).
- **Tool descriptions:** All built-in tools were updated with "When to use" / "When NOT to use", clear parameters, and alignment with Cline/OpenCode/Claude Code style from `sources/prompts` and `sources/cline`.

## Changes

### Prompt (packages/core)

- **PromptContext:** Added optional `contextUsedTokens`, `contextLimitTokens`, `contextPercent`.
- **buildSystemInfoBlock:** First line in `<env>` is context: `Context: X / Y tokens (Z%) — manage length by using condense when the conversation is long.` (only when `contextLimitTokens > 0`).
- **loop.ts:** Before building the prompt, computes `limitTokens`, `usedTokens`, `contextPercent` and passes them into `promptCtx`.
- **TOOL_USE_GUIDE:** Added bullet about context window and using `condense` when usage is high.

### Tool descriptions (packages/core/src/tools/built-in)

All built-in tools now have When to use / When NOT to use and clear parameter notes: codebase_search, search_files, list_files, read_file, replace_in_file, write_to_file, execute_command, attempt_completion, ask_followup_question, update_todo_list, list_code_definitions, condense, summarize_task, plan_exit, create_rule, apply_patch, web_fetch, web_search, use_skill, browser_action.

## References

- Cline: `sources/cline/src/core/prompts/system-prompt/`
- Prompts: `sources/prompts/1`, `sources/prompts/2`, `sources/prompts/3`
