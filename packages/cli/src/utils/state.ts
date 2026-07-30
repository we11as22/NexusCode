import { realpath, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'

// DO NOT ADD MORE STATE HERE OR BORIS WILL CURSE YOU
const STATE: {
  originalCwd: string
  currentCwd: string
} = {
  originalCwd: cwd(),
  currentCwd: cwd(),
}

export async function setCwd(nextCwd: string): Promise<void> {
  const absolute = resolve(STATE.currentCwd, nextCwd)
  const canonical = await realpath(absolute)
  const info = await stat(canonical)
  if (!info.isDirectory()) {
    throw new Error(`Not a directory: ${canonical}`)
  }
  STATE.currentCwd = canonical
}

export function setOriginalCwd(originalCwd: string): void {
  STATE.originalCwd = realpathSync.native(resolve(originalCwd))
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

export function getCwd(): string {
  return STATE.currentCwd
}
