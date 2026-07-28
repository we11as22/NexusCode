import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    minWorkers: 1,
    maxWorkers: 2,
  },
})
