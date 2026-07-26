import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Workspace tests must exercise the current source tree, not whatever
    // generated core/dist artifact happens to be left from an earlier build.
    alias: {
      "@nexuscode/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/constants/macro.ts"],
    restoreMocks: true,
    clearMocks: true,
    pool: "forks",
  },
})
