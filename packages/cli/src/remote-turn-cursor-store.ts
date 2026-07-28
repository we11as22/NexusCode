import path from "node:path"

import {
  FileRemoteTurnRecoveryStore,
  canonicalProjectRoot,
  canonicalizeNexusServerBaseUrl,
} from "@nexuscode/core"
import type { RemoteTurnCursorStore } from "./remote-turn.js"

export interface CliRemoteTurnCursorStoreOptions {
  rootDir: string
  serverUrl: string
  cwd: string
}

/**
 * The CLI and VS Code use the same one-record prepared→admitted state
 * machine. Its file is fsynced before the first command POST.
 */
export function createCliRemoteTurnCursorStore(
  options: CliRemoteTurnCursorStoreOptions,
): RemoteTurnCursorStore {
  return new FileRemoteTurnRecoveryStore({
    rootDir: path.join(path.resolve(options.rootDir), "data"),
    namespace: JSON.stringify([
      canonicalizeNexusServerBaseUrl(options.serverUrl),
      canonicalProjectRoot(options.cwd),
    ]),
  })
}
