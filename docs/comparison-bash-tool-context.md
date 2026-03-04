# Bash/terminal tool: streaming, context protection, and “catching needed” — comparison

## Protection from disk/memory overflow by saved files

### NexusCode (current)

- **Tool output**: When output exceeds 50 KB, full output is written to `.nexus/tool-output/tool_<timestamp>.out` (OpenCode-style). **Per-file cap**: 50 MB max written to protect disk. **Cleanup**: when creating a new tool-output file, files in `.nexus/tool-output/` older than **7 days** are deleted. The agent receives a truncated preview plus a hint: “Full output saved to: <path>. Use grep or read_file with start_line/end_line to view specific sections.” Reads to `.nexus/tool-output/**` are auto-approved (like OpenCode’s allow for Truncate.DIR).
- **Indexing**: Only code files are indexed; `.nexus/**` is excluded from the codebase index (and from `list_files` / `list_code_definitions`), so tool-output and run logs are never indexed.
- **Background command logs**: We write to `.nexus/run_<timestamp>.log` per background run. **Cleanup**: when creating a new background log, we delete any `run_*.log` in `.nexus` older than **7 days**.

### OpenCode

- **Tool output**: When output is truncated, the full text is written to a file under `Global.Path.data` / `tool-output` (e.g. `~/.opencode/.../tool-output/tool_<id>`). Filenames use an ascending id that encodes a timestamp.
- **Cleanup**: `Truncate.init()` (called from `project/bootstrap.ts`) registers a **scheduler task** that runs **every hour**:
  - `Truncate.cleanup()` lists files in `tool-output` matching `tool_*`.
  - For each file, it derives a timestamp from the id and deletes the file if it is older than **7 days** (`RETENTION_MS`).
- So protection is **time-based retention**: old tool-output files are removed; there is no per-file size cap or total directory quota. Disk use is bounded by “whatever is written in the last 7 days”.

### Cline

- For long-running command output they switch to file-based logging (path in their constants). The result returned to the model is a summary. Cleanup of those log files is not inspected here; typically they are tied to a run/session.

---

## Summary (table)

| | **NexusCode** | **Cline** | **OpenCode** |
|---|--------------|-----------|----------------|
| **Bash tool** | `execute_command` | `run_terminal_cmd` (CommandExecutor) | `bash` (BashTool) |
| **Streaming to UI** | No — result after command finishes | Yes — chunks via `say("command_output", ...)` (CHUNK_LINE_COUNT=20, debounce 100ms) | Yes — `ctx.metadata({ output })` on every stdout/stderr chunk |
| **What the agent receives** | Single tool result after completion | Single tool result after completion | Single tool result after completion |
| **Context protection** | Truncate in tool: 50 KB to agent; if over → full saved to `.nexus/tool-output/` (cap 50 MB/file), 7-day cleanup; hint to use grep/read_file | Truncate in `processOutput()`: default 500 lines (first 250 + “…truncated…” + last 250). For huge output: file logging (1000 lines / 512 KB) then summary (first + last 100) | Truncate in **central** `Truncate.output()`: 2000 lines / 50 KB; if over limit → full output saved to file, agent gets preview + **hint** |
| **How agent gets “needed” part** | **Hint in tool result**: “Full output saved to: .nexus/tool-output/…. Use grep or read_file with start_line/end_line.” Reads to `.nexus/tool-output/**` auto-approved | Only truncated/summary; can run e.g. `tail`/`grep` on log path if file was used | **Hint in tool result**: “Full output saved to: &lt;path&gt;. Use Grep to search or Read with offset/limit to view specific sections.” (or Task tool for explore agent) |

---

## 1. NexusCode (`execute_command`)

- **Execution**: `execa` (or `spawn` for background). No streaming; we wait for the process to finish.
- **Context**: In `execute-command.ts`, output is capped at 50 KB for the agent: first 100 lines + “… N lines truncated …” + last 100 lines. If over 50 KB, full output is written to `.nexus/tool-output/tool_<timestamp>.out` (max 50 MB per file to protect disk); 7-day retention cleanup runs when writing a new file. The agent gets the truncated preview plus a hint: “Full output saved to: <relPath>. Use grep or read_file with start_line/end_line to view specific sections.”
- **Access**: Reads to `.nexus/tool-output/**` are in `autoApproveReadPatterns` by default (OpenCode-style allow for tool-output). `.nexus/**` is excluded from codebase index and from `list_files` / `list_code_definitions`, so only code files are indexed.
- **Streaming**: None. UI gets the same final truncated output when the tool ends.
- **“Catching needed”**: The agent is told the path to the saved file and can use `grep` or `read_file(path, start_line, end_line)` to retrieve only what it needs.

---

## 2. Cline (CommandExecutor + CommandOrchestrator)

- **Streaming**: Output is buffered (e.g. 20 lines or 2 KB) and sent to the UI via `say("command_output", text, …, partial)` so the user sees live updates. The **model** does not receive chunks; it gets one final tool result.
- **Context**: `terminalManager.processOutput(outputLines)` truncates to `terminalOutputLineLimit` (default **500** lines): first 250 + “… (output truncated) …” + last 250. So the agent always gets a bounded string.
- **Large runs**: If output exceeds MAX_LINES_BEFORE_FILE (1000) or MAX_BYTES_BEFORE_FILE (512 KB), Cline switches to file-based logging; the **result for the model** is a summary (first + last SUMMARY_LINES_TO_KEEP = 100 lines). So again the agent never gets unbounded output.
- **“Catching needed”**: The model only sees the truncated/summary result. To get more, it would have to run another command (e.g. on a log path) — there is no built-in hint in the tool result like OpenCode’s.

---

## 3. OpenCode (`bash` tool)

- **Streaming**: On every stdout/stderr chunk, `ctx.metadata({ metadata: { output: … } })` is called so the UI can show live output. Metadata is capped at 30 K chars to avoid huge blobs; the **full** `output` is still accumulated in memory for the tool result.
- **Context**: Every tool result goes through `Tool.define` → `Truncate.output()` (unless the tool sets `metadata.truncated`). Limits: **2000 lines** and **50 KB**. If over limit:
  - Full output is written to a file under `Truncate.DIR` (e.g. `tool_<id>`).
  - The agent gets a short preview (head or tail, depending on `direction`) plus an explicit **hint**:  
    “Full output saved to: &lt;path&gt;. Use Grep to search the full content or Read with offset/limit to view specific sections.”  
    (Or, if the task tool is available: “Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit).”)
- **“Catching needed”**: The model is told exactly how to get the needed part: grep or read_file with range on the saved file. So context is protected **and** the agent can still “catch” what it needs in a follow-up step.

---

## Recommendation for NexusCode

- **Implemented** (OpenCode-style): When truncating, full output is written to `.nexus/tool-output/tool_<timestamp>.out` (capped at 50 MB per file); 7-day cleanup; hint in tool result; `.nexus/tool-output/**` auto-approved for read; `.nexus/**` excluded from indexing and from list_files / list_code_definitions so only code files are indexed.
