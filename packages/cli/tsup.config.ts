import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  minify: true,
  splitting: true,
  sourcemap: false,
  clean: true,
})
