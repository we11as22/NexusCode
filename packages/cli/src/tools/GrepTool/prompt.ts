export const TOOL_NAME_FOR_PROMPT = 'Grep'

export const DESCRIPTION = `
- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)
- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files containing specific patterns
- For open-ended investigations that need several rounds of searching and reading, you may escalate to the Agent tool, but exact symbol and text search should stay in Grep
`
