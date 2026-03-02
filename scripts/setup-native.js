#!/usr/bin/env node
/**
 * Run prebuild-install for all better-sqlite3 copies in node_modules.
 * This downloads prebuilt .node binaries when available, avoiding node-gyp build.
 */
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pnpmDir = path.join(root, "node_modules", ".pnpm");

if (!fs.existsSync(pnpmDir)) {
  console.warn("No node_modules/.pnpm found. Run: pnpm install");
  process.exit(1);
}

const dirs = fs.readdirSync(pnpmDir, { withFileTypes: true });
const betterSqlite3Dirs = [];

for (const ent of dirs) {
  if (!ent.isDirectory()) continue;
  const match = ent.name.match(/^better-sqlite3@[\d.]+/);
  if (!match) continue;
  const pkgDir = path.join(pnpmDir, ent.name, "node_modules", "better-sqlite3");
  if (fs.existsSync(pkgDir)) {
    betterSqlite3Dirs.push(pkgDir);
  }
}

if (betterSqlite3Dirs.length === 0) {
  console.warn("No better-sqlite3 package dirs found. Run: pnpm install");
  process.exit(1);
}

for (const dir of betterSqlite3Dirs) {
  const rel = path.relative(root, dir);
  console.log("Running prebuild-install in", rel);
  try {
    execSync("npx prebuild-install", {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, npm_config_build_from_source: "false" },
    });
  } catch (e) {
    console.warn("prebuild-install failed for", rel, "- if nexus fails with 'Could not locate the bindings file', run: pnpm rebuild better-sqlite3");
    // Do not exit: install may have already fetched the binary; let build run
  }
}

console.log("setup:native done.");
