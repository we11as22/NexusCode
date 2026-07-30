#!/usr/bin/env node
/**
 * Run vsce package on the repository-pinned Node 24 runtime.
 */
const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const cwd = path.resolve(__dirname, '..')
const target = `${process.platform}-${process.arch}`
const helperName = process.platform === 'win32' ? 'nexus-sandbox.exe' : 'nexus-sandbox'
const helperRelative = `vendor/${target}/${helperName}`
const helperPath = path.join(cwd, helperRelative)
const linuxCompanions = process.platform === 'linux'
  ? [
      `vendor/${target}/nexus-bwrap`,
      `vendor/${target}/COPYING.bubblewrap`,
    ]
  : []

if (!fs.statSync(helperPath).isFile()) {
  throw new Error(`Native sandbox helper is missing: ${helperPath}`)
}
const helperVersion = execFileSync(helperPath, ['--version'], {
  cwd,
  encoding: 'utf8',
}).trim()
if (!/^nexus-sandbox \S+ protocol=1$/u.test(helperVersion)) {
  throw new Error(`Native sandbox helper failed its version probe: ${helperVersion}`)
}
const helperBackend = execFileSync(helperPath, ['--check'], {
  cwd,
  encoding: 'utf8',
}).trim()
if (!/^nexus-sandbox backend=\S+ ready$/u.test(helperBackend)) {
  throw new Error(`Native sandbox backend failed its readiness probe: ${helperBackend}`)
}

const packageFiles = execSync(
  'corepack pnpm exec vsce ls --no-dependencies --no-yarn',
  { cwd, encoding: 'utf8' },
)
  .split(/\r?\n/u)
  .map((entry) => entry.trim())
if (!packageFiles.includes(helperRelative)) {
  throw new Error(`VSIX file list omits native sandbox helper: ${helperRelative}`)
}
for (const companion of linuxCompanions) {
  if (!packageFiles.includes(companion)) {
    throw new Error(`VSIX file list omits Linux sandbox companion: ${companion}`)
  }
}

execSync('corepack pnpm exec vsce package --no-dependencies --allow-missing-repository --no-yarn', {
  stdio: 'inherit',
  cwd,
})
const vsixName = 'nexuscode-0.1.0.vsix'
console.log('')
console.log('Install: Extensions (Ctrl+Shift+X) → "..." → Install from VSIX... → packages/vscode/' + vsixName)
console.log('On SSH do NOT use "code --install-extension" — it will fail. Use the IDE menu above.')
