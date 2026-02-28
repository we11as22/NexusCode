# ⚡ NexusCode

> AI coding agent combining the best practices from Cline, Continue, KiloCode, OpenCode, Pi, and Roo-Code.

**VS Code extension + CLI** with:
- Modes: **agent** | **plan** | **debug** | **ask**
- **Max Mode** toggle for deeper, more thorough analysis
- **AST-based codebase indexing** (classes, functions, methods by language)
- **All LLM providers** including any OpenAI-compatible API
- **Parallel tool execution** (read operations run concurrently)
- **Doom loop detection** — no artificial step limits
- **Structured output** with JSON schema when supported by provider
- **Skill & tool classification** — smart context selection from large sets
- **Parallel sub-agents** for concurrent task execution
- **Shadow git checkpoints** with task/workspace restore
- **Two-level context compaction** (prune output → LLM summary with OpenCode-style structure)
- **MCP support** with OAuth and tool classification
- Beautiful Claude Code–inspired interface

---

## Installation

### VS Code Extension

Build from source:
```bash
git clone ...
cd NexusCode
pnpm install
pnpm build
# Install the generated .vsix file
```

### CLI

```bash
pnpm install
pnpm build:cli
npm link packages/cli
nexus --help
```

---

## Configuration

Create `.nexus/nexus.yaml` in your project root:

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-5
  # apiKey: from ANTHROPIC_API_KEY env var

maxMode:
  provider: anthropic
  id: claude-opus-4-5
  enabled: false

indexing:
  enabled: true
  symbolExtract: true

permissions:
  autoApproveRead: true
  autoApproveWrite: false
  autoApproveCommand: false
```

See `.nexus/nexus.yaml` for the complete reference.

---

## CLI Usage

```bash
# Interactive agent (default)
nexus

# With initial message
nexus "Refactor the auth module to use JWT"

# Specific mode
nexus plan "Design the database schema for a blog"
nexus debug "The tests are failing with timeout errors"
nexus ask "How does the caching layer work?"

# Max mode (deeper analysis)
nexus --max-mode "Review the entire codebase for security issues"

# Different model
nexus --model openai/gpt-4o "Add TypeScript generics to this API"
nexus --model ollama/qwen2.5-coder:32b "..."

# OpenAI-compatible provider
NEXUS_BASE_URL=http://localhost:1234/v1 nexus

# Resume last session
nexus --continue

# CI/CD (no approval prompts)
nexus --auto "Run tests and fix all failures"

# Print mode (non-interactive)
nexus -p "Summarize this codebase"
```

### Key Bindings (CLI TUI)
| Key | Action |
|-----|--------|
| Enter | Send message |
| Shift+Enter | Newline |
| Tab | Switch mode |
| Ctrl+S | Compact history |
| Ctrl+K | Clear chat |
| Ctrl+C | Abort / Quit |

---

## Modes

| Mode | Permissions | Use for |
|------|-------------|---------|
| **agent** | Full (read+write+execute+browser+mcp) | General coding tasks |
| **plan** | Read + create .md plan files | Planning without touching code |
| **debug** | Full (focused on tracing bugs) | Finding and fixing bugs |
| **ask** | Read only | Questions and explanations |

**Max Mode** (`⚡` in VS Code, `--max-mode` in CLI): Switches to the max mode model configured in `nexus.yaml` and uses a deeper exploration prompt. The agent reads more context, verifies changes, and considers edge cases.

---

## Rules & Skills

### Rules
Create `.nexus/rules/` with markdown files for project guidelines. These are loaded into every session.

Also supported: `CLAUDE.md`, `AGENTS.md` in project root.

### Skills
Place skill files in `.nexus/skills/skill-name/SKILL.md`. Skills provide domain-specific knowledge and patterns.

When many skills are configured, NexusCode uses LLM classification to select only relevant ones for the task — keeping the context clean.

---

## MCP Integration

```yaml
# .nexus/nexus.yaml
mcp:
  servers:
    - name: github
      command: npx
      args: [-y, "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"
    - name: my-service
      url: "http://localhost:3100/mcp"
```

When many MCP tools are available, NexusCode automatically classifies which tools are relevant for the current task. Built-in tools are always available.

---

## Codebase Indexing

NexusCode indexes your codebase on startup (incremental updates on file save):

- **Symbols**: classes, functions, methods, interfaces, types, enums (via AST)
- **FTS**: SQLite FTS5 for keyword search
- **Vector** (optional): semantic search via Qdrant + embeddings

Use `codebase_search` tool or `@problems` in chat to leverage the index.

---

## Architecture

```
NexusCode/
├── packages/
│   ├── core/              ← Provider-agnostic agent engine
│   │   ├── agent/         ← Agent loop, modes, classifiers, prompts
│   │   ├── tools/         ← Tool registry + 19 built-in tools
│   │   ├── session/       ← JSONL storage + compaction
│   │   ├── indexer/       ← AST + FTS + Qdrant
│   │   ├── provider/      ← All LLM providers + embeddings
│   │   ├── checkpoint/    ← Shadow git
│   │   ├── context/       ← @mentions, rules, condense
│   │   ├── skills/        ← Skill loader + classifier
│   │   └── mcp/           ← MCP client
│   ├── vscode/            ← VS Code extension + React UI
│   └── cli/               ← CLI with Ink TUI
└── .nexus/               ← Project config
    ├── nexus.yaml
    ├── rules/
    └── skills/
```

---

## Key Design Decisions

1. **No step limits** — Doom loop detection (3 identical consecutive calls) prevents infinite loops
2. **Built-in tools always active** — Mode permissions gate which tools are available; classifier only filters MCP/custom tools
3. **Parallel reads** — Multiple read-only tools execute concurrently with `Promise.all`
4. **Cache-aware prompts** — Stable blocks (role, rules, skills) use `cache_control: ephemeral` on Anthropic
5. **Two-level compaction** — Fast prune (remove old tool outputs) + LLM compact (full summary) from OpenCode
6. **Multi-project** — Separate FTS/vector indices per project hash in `~/.nexus/index/`

---

## License

MIT
