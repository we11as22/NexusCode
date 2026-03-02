#!/usr/bin/env node
/**
 * One-command install + build. Removes node_modules and local store so pnpm
 * never hits "Unexpected store location", then installs, sets up native modules, builds.
 */
require("./check-node.js");

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
process.chdir(root);

function rm(dir) {
  try {
    fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    console.log("Removed", dir);
  } catch (_) {}
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

console.log("Cleaning node_modules and local store...");
rm("node_modules");
rm(".pnpm-store");
rm("packages/core/node_modules");
rm("packages/cli/node_modules");
rm("packages/server/node_modules");
rm("packages/vscode/node_modules");
rm("packages/vscode/webview-ui/node_modules");

console.log("Installing dependencies...");
run("pnpm install");

console.log("Setting up native modules (better-sqlite3)...");
run("pnpm run setup:native");

console.log("Building...");
run("pnpm build");

console.log("Done. Run: nexus");
