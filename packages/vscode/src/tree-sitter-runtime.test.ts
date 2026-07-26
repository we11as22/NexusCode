import { describe, expect, it } from "vitest"
import {
  getParserForFile,
  getQueryForFile,
} from "./services/autocomplete/continuedev/core/util/treeSitter.js"

describe("autocomplete Tree-sitter runtime", () => {
  it("loads the core and language WASM and resolves bundled query sources", async () => {
    const parser = await getParserForFile("/workspace/example.ts")
    expect(parser).toBeDefined()

    const tree = parser?.parse("function greet(name: string): string { return name }")
    expect(tree?.rootNode.type).toBe("program")

    const query = await getQueryForFile(
      "/workspace/example.ts",
      "root-path-context-queries/typescript/function_declaration.scm",
    )
    expect(query).toBeDefined()

    tree?.delete()
    parser?.delete()
  })
})
