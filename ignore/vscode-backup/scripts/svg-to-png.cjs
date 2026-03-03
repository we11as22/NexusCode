#!/usr/bin/env node
/**
 * Convert assets/icon.svg to assets/icon.png for vsce (marketplace does not allow SVG icons).
 */
const path = require('path')
const fs = require('fs')
const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'assets', 'icon.svg')
const pngPath = path.join(root, 'assets', 'icon.png')

async function run() {
  let sharp
  try {
    sharp = require('sharp')
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.error('Run: pnpm add -D sharp (in packages/vscode) then retry package.')
      process.exit(1)
    }
    throw err
  }
  const svg = fs.readFileSync(svgPath)
  await sharp(svg).resize(28, 28).png().toFile(pngPath)
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('svg-to-png:', err.message)
    process.exit(1)
  })
