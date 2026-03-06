import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name ?? ""
          if (name.endsWith(".css")) return "index.css"
          return "assets/[name].[ext]"
        },
        inlineDynamicImports: false,
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) {
              return "react"
            }
            if (id.includes("zustand")) {
              return "zustand"
            }
            if (
              id.includes("react-markdown") ||
              id.includes("remark-gfm") ||
              id.includes("micromark") ||
              id.includes("unist-") ||
              id.includes("mdast-") ||
              id.includes("property-information") ||
              id.includes("hast-") ||
              id.includes("ccount") ||
              id.includes("decode-named-character-reference")
            ) {
              return "markdown"
            }
            if (id.includes("react-syntax-highlighter") || id.includes("highlight.js")) {
              return "syntax-highlighter"
            }
            if (id.includes("react-virtuoso")) {
              return "virtuoso"
            }
          }
        },
      },
    },
  },
})
