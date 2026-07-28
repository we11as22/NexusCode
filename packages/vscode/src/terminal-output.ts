const OSC_FRAME = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu
const ANSI_ESCAPE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/gu

/**
 * Removes terminal protocol frames before command output crosses into the
 * agent event stream. VS Code shell integration uses OSC 633 frames whose
 * payload must be removed as a unit before stripping ordinary ANSI escapes.
 */
export function sanitizeTerminalOutput(output: string): string {
  return output
    .replace(OSC_FRAME, "")
    .replace(ANSI_ESCAPE, "")
    .replace(UNSAFE_CONTROL, "")
}
