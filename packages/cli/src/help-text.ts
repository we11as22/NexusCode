export const NEXUS_CLI_HELP = `
NexusCode - AI coding agent for the terminal

Usage: nexus [options] [prompt]

Options:
  -c, --cwd <cwd>       Current working directory (default: .)
  -d, --debug           Enable debug mode
  --verbose             Override verbose mode from config
  -p, --print           Print response and exit (for pipes)
  --dangerously-skip-permissions  Skip permission checks (Docker only)
  -m, --model <model>   Provider/model (e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o)
  --temperature <n>     Sampling temperature (0-2)
  --reasoning-effort <effort>  Reasoning effort (none|minimal|low|medium|high|max)
  --project <dir>       Project directory (default: current directory)
  --no-index            Disable codebase indexing
  -s, --session <id>    Session ID to resume
  --server <url>        NexusCode server URL (NEXUS_SERVER_URL env)
  --continue            Continue most recent session
  --profile <name>      Named profile from nexus.yaml
  --mode <mode>         Override: agent | ask | plan | debug | review; resume keeps saved mode
  -h, --help            Show this help
  -v, --version         Show version

Commands:
  task                  Task checkpoints and restore (task checkpoints | task restore <id>)
  config                Manage configuration
  approved-tools        Manage approved tools
  mcp                   Configure MCP servers
  sandbox               Inspect or set up the native OS sandbox
  doctor                Check installation health

Run 'nexus' for interactive mode, or 'nexus "your prompt"' to run once.
Use 'nexus task --help' for checkpoint/restore options.
`
