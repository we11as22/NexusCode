# 2026-03-01 — VS Code: Cline-style UX, open-at-line, integration check

## What changed

### Extension behavior (Cline-aligned)
- **Approval banner**: Awaiting-approval state uses a dedicated Cline-style banner (icon + message) with Allow / Allow Always / Deny referenced; banner is more visible and consistent with Cline.
- **State**: `projectDir` (workspace root) is included in webview state for future use and for open-in-editor resolution.
- **Settings**: Tabbed settings (LLM, Embeddings, Index, Tools, MCP/Rules, Profiles) unchanged; Apply/Reset and MCP reconnect on save already matched Cline expectations. Removed the non-functional "Review" button from the chat bar.

### Open file at line (reduce context bloat)
- **New message**: `openFileAtLocation` from webview with `path` (relative to workspace) and optional `line` / `endLine`.
- **Provider**: Handles `openFileAtLocation` by opening the file in the editor and revealing the line range (InCenter).
- **Tool output links**: In tool cards, output is scanned for `path:line` patterns (e.g. from `search_files` and `codebase_search`). For each match we show an "Open file:line" link that sends `openFileAtLocation` so the user can jump to the relevant spot without pasting paths. Supports multiple links per tool output (up to 12).

### Integration verification
- **Multiple search**: `search_files` supports `patterns` + `paths`; `codebase_search` supports `queries` + `paths`; both return path and line info.
- **Multiple edits**: Single-file tools (`replace_in_file`, `write_to_file`, `apply_patch`) are used in sequence for multi-file edits; agent can use `read_file` with `start_line`/`end_line` after search to keep context small.
- **Vector index**: `codebase_search` uses indexer with `semantic: true` when vector indexing is enabled; FTS fallback when not.
- **Subagents**: Subagent strip in chat shows running/completed/error subagents; events `subagent_start`, `subagent_tool_*`, `subagent_done` are reflected in the UI.

## Why
- User requested VS Code extension to behave like Cline while keeping Nexus features, with a cleaner chat design and working settings.
- User requested correct integration of multi-search, multi-edit, vector index, and subagents, and the ability to open/scroll to file locations after code search to avoid context bloat.

## Validation
- `pnpm run build` — passed.
- No linter errors in modified files.
