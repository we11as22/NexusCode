#!/usr/bin/env node
/**
 * Exit with a clear message if Node < 20 (required for better-sqlite3 prebuilds).
 * Used by: pnpm run serve, and can be required by other scripts.
 */
const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) {
  console.error(
    "NexusCode requires Node.js 20+. You have " +
      process.version +
      ". Run: nvm use 20"
  );
  process.exit(1);
}
