/**
 * NexusCode CLI entry — avoid loading React/Ink for --help and --version.
 */
import { NEXUS_CLI_HELP } from './help-text.js'

const argv = process.argv.slice(2)
const hasHelp = argv.includes('--help') || argv.includes('-h')
const hasVersion = argv.includes('--version') || argv.includes('-v')

if (hasVersion) {
  console.log('0.1.0')
  process.exit(0)
}

if (hasHelp && argv.length <= 2) {
  // Minimal help without loading Commander/Ink
  console.log(NEXUS_CLI_HELP)
  process.exit(0)
}

// Load full CLI (Commander + Ink REPL)
import('./entrypoints/cli.js').catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exit(1)
})
