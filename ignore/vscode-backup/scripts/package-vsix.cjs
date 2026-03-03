#!/usr/bin/env node
/**
 * Run vsce package.
 * Node 18 lacks global File used by undici; inject a lightweight polyfill via NODE_OPTIONS.
 */
const { execSync } = require('child_process')
const path = require('path')
const cwd = path.resolve(__dirname, '..')
const polyfillPath = path.join(cwd, 'scripts', 'node18-file-polyfill.cjs')
const extraNodeOpts = `--require=${JSON.stringify(polyfillPath)}`
const inheritedNodeOpts = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''
execSync('pnpm exec vsce package --no-dependencies --allow-missing-repository --no-yarn', {
  stdio: 'inherit',
  cwd,
  env: {
    ...process.env,
    NODE_OPTIONS: `${inheritedNodeOpts}${extraNodeOpts}`.trim(),
  },
})
const vsixName = 'nexuscode-0.1.0.vsix'
console.log('')
console.log('Install: Extensions (Ctrl+Shift+X) → "..." → Install from VSIX... → packages/vscode/' + vsixName)
console.log('On SSH do NOT use "code --install-extension" — it will fail. Use the IDE menu above.')
