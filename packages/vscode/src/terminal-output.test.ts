import { describe, expect, it } from "vitest"

import { sanitizeTerminalOutput } from "./terminal-output.js"

describe("sanitizeTerminalOutput", () => {
  it("removes VS Code shell-integration OSC frames without leaking their payload", () => {
    expect(
      sanitizeTerminalOutput(
        "\u001b]633;E;pwd;command-id\u0007/Users/mac/project\r\n" +
          "\u001b]633;C\u0007",
      ),
    ).toBe("/Users/mac/project\r\n")
  })

  it("removes ANSI styling while preserving command output and line breaks", () => {
    expect(
      sanitizeTerminalOutput(
        "\u001b[32mgreen\u001b[0m\nplain\ttext\n",
      ),
    ).toBe("green\nplain\ttext\n")
  })

  it("removes OSC frames terminated by the string terminator", () => {
    expect(
      sanitizeTerminalOutput(
        "before\u001b]0;private terminal title\u001b\\after",
      ),
    ).toBe("beforeafter")
  })
})
