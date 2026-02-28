#!/usr/bin/env node
/**
 * Run vsce package. Requires Node.js 20+ (vsce/undici use global File, not available in Node 18).
 */
const major = parseInt(process.version.slice(1).split('.')[0], 10)
if (major < 20) {
  console.error(
    'Error: Packaging the VS Code extension requires Node.js 20+ (current: ' +
      process.version +
      ').\n' +
      '  undici (used by vsce) needs the global File API from Node 20.\n' +
      '  Use: nvm use 20  (or install Node 20), then run: pnpm package:vscode'
  )
  process.exit(1)
}
const { execSync } = require('child_process')
const path = require('path')
const cwd = path.resolve(__dirname, '..')
execSync('pnpm exec vsce package --no-dependencies --allow-missing-repository --no-yarn', {
  stdio: 'inherit',
  cwd,
})
const vsixName = 'nexuscode-0.1.0.vsix'
console.log('')
console.log('Install: Extensions (Ctrl+Shift+X) → "..." → Install from VSIX... → packages/vscode/' + vsixName)
console.log('On SSH do NOT use "code --install-extension" — it will fail. Use the IDE menu above.')
