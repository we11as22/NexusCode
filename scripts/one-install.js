#!/usr/bin/env node
/**
 * One-command install + build. Removes node_modules and local store so pnpm
 * never hits "Unexpected store location", then installs and builds.
 */
const path = require("path");
const fs = require("fs");
const { execFileSync, execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
process.chdir(root);
execFileSync(process.execPath, [path.join(root, "scripts/check-node.js")], {
  stdio: "inherit",
  cwd: root,
});

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
run("corepack pnpm install");

console.log("Building...");
run("corepack pnpm build");

console.log("Done. Run: nexus");
