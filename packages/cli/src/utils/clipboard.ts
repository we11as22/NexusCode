/**
 * Cross-platform clipboard read/write for terminal text.
 * Used for copy/cut/paste in input fields.
 * - Windows: PowerShell Get-Clipboard / Set-Clipboard (via temp file to avoid escaping)
 * - macOS: pbcopy / pbpaste
 * - Linux: xclip -selection c, or xsel -b, or wl-copy/wl-paste (Wayland)
 */
import { execSync, spawnSync } from 'node:child_process'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function getClipboardUnix(): string {
  if (process.platform === 'darwin') {
    try {
      return execSync('pbpaste', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      return ''
    }
  }
  // Linux: try xclip, then xsel, then wl-paste (Wayland)
  try {
    return execSync('xclip -selection clipboard -o', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    try {
      return execSync('xsel -b', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      try {
        return execSync('wl-paste', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      } catch {
        return ''
      }
    }
  }
}

function setClipboardUnix(text: string): void {
  if (process.platform === 'darwin') {
    spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    return
  }
  try {
    spawnSync('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
  } catch {
    try {
      spawnSync('xsel', ['--clipboard', '--input'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      try {
        spawnSync('wl-copy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      } catch {
        // no-op if no clipboard tool
      }
    }
  }
}

function getClipboardWin(): string {
  try {
    const script = "Get-Clipboard -Raw"
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "& { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script} }"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    return out ?? ''
  } catch {
    return ''
  }
}

function setClipboardWin(text: string): void {
  const tmpPath = join(tmpdir(), `nexus_clip_${process.pid}.txt`)
  try {
    writeFileSync(tmpPath, text, 'utf8')
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Path '${tmpPath.replace(/'/g, "''")}' -Raw | Set-Clipboard"`,
      { stdio: 'ignore', windowsHide: true }
    )
  } catch {
    try {
      spawnSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'], shell: true })
    } catch {
      // no-op
    }
  }
  try {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  } catch {
    /* ignore */
  }
}

export function getClipboardText(): string {
  if (process.platform === 'win32') {
    return getClipboardWin()
  }
  return getClipboardUnix()
}

export function setClipboardText(text: string): void {
  if (typeof text !== 'string') return
  if (process.platform === 'win32') {
    setClipboardWin(text)
    return
  }
  setClipboardUnix(text)
}
