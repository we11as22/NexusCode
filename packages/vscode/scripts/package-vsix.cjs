#!/usr/bin/env node
/**
 * Run vsce package on the repository-pinned Node 20 runtime.
 */
const { execSync } = require('child_process')
const path = require('path')
const cwd = path.resolve(__dirname, '..')
execSync('corepack pnpm exec vsce package --no-dependencies --allow-missing-repository --no-yarn', {
  stdio: 'inherit',
  cwd,
})
const vsixName = 'nexuscode-0.1.0.vsix'
console.log('')
console.log('Install: Extensions (Ctrl+Shift+X) → "..." → Install from VSIX... → packages/vscode/' + vsixName)
console.log('On SSH do NOT use "code --install-extension" — it will fail. Use the IDE menu above.')
