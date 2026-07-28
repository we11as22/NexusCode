#!/usr/bin/env node
/**
 * One-command incremental install + build.
 *
 * The workspace pins a project-local pnpm store in .npmrc. Removing that store
 * and every node_modules directory on each setup wastes I/O and creates large
 * dependency/build spikes, so recovery from a genuinely corrupt store remains
 * an explicit manual operation rather than normal installer behavior.
 */
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
process.chdir(root);
execFileSync(process.execPath, [path.join(root, "scripts/check-node.js")], {
  stdio: "inherit",
  cwd: root,
});

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

console.log("Installing dependencies...");
run("corepack pnpm install");

console.log("Building...");
run("corepack pnpm build");

console.log("Done. Run: nexus");
