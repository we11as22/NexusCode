import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@nexuscode/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    // The continuedev subtree is imported upstream code with its own fixture
    // assumptions. Nexus-owned extension tests live at the src root.
    include: ["src/*.test.ts"],
    minWorkers: 1,
    maxWorkers: 2,
  },
})
