/**
 * NexusCode CLI entry — avoid loading React/Ink for --help and --version.
 */
const argv = process.argv.slice(2)
const hasHelp = argv.includes('--help') || argv.includes('-h')
const hasVersion = argv.includes('--version') || argv.includes('-v')

if (hasVersion) {
  console.log('0.1.0')
  process.exit(0)
}

if (hasHelp && argv.length <= 2) {
  // Minimal help without loading Commander/Ink
  console.log(`
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
  --mode <mode>         Mode: agent | ask | plan | debug (default: agent)
  -h, --help            Show this help
  -v, --version         Show version

Commands:
  task                  Task checkpoints and restore (task checkpoints | task restore <id>)
  config                Manage configuration
  approved-tools        Manage approved tools
  mcp                   Configure MCP servers
  doctor                Check installation health

Run 'nexus' for interactive mode, or 'nexus "your prompt"' to run once.
Use 'nexus task --help' for checkpoint/restore options.
`)
  process.exit(0)
}

// Load full CLI (Commander + Ink REPL)
import('./entrypoints/cli.js').catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exit(1)
})
