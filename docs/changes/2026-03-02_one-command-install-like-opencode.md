# One-command install (OpenCode-style)

## Summary

Install, build, package extension, and link CLI in a single command so setup is as simple as OpenCode (`curl | bash` / `npm i -g opencode-ai`).

## Changes

- **`pnpm run ready`** — New top-level script: runs `fullbuild` (install → setup:native → build → package .vsix) then `npm link` from `packages/cli`. After that, `nexus` is global and `packages/vscode/nexuscode-0.1.0.vsix` is ready to install in VS Code.
- **README** — New leading section «Установка в одну команду (как OpenCode)» with the single command and store-dir note; «Полный билд» updated to reference `pnpm run ready`.

## Verification

- Ran `pnpm run ready` from `/root/asudakov/projects/NexusCode` (Node 20, pnpm): success.
- Confirmed `nexus` in PATH and `nexus --help` works from `/root/asudakov/projects`.
- Confirmed `packages/vscode/nexuscode-0.1.0.vsix` is produced (~2.5 MB).

## Node 20 at runtime (2026-03-02)

- **Problem:** If the user ran `pnpm run setup` / `fullbuild` with Node 20 but then runs `nexus` or `pnpm run serve` in a terminal where Node 18 is active, better-sqlite3 fails with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION 115 vs 109`.
- **Fix:** (1) Launcher `packages/cli/nexus` now checks Node >= 20 before starting and prints: "NexusCode requires Node.js 20+. You have 18.x. Run: nvm use 20". (2) `pnpm run serve` runs `scripts/check-node.js` first (same message if Node < 20). (3) README updated: requirement "Node 20 for run" and a note in the one-command section about `nvm use 20` when seeing NODE_MODULE_VERSION.
- **Check:** `nexus --help` and `pnpm run serve` (then `curl http://127.0.0.1:4097`) succeed with Node 20.
