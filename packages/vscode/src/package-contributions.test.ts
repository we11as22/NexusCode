import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type Keybinding = {
  command?: string
  key?: string
  mac?: string
}

const packageJsonPath = resolve(__dirname, "../package.json")
const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  contributes?: {
    keybindings?: Keybinding[]
  }
}

describe("VS Code package contributions", () => {
  it("does not shadow the editor's New Window shortcut", () => {
    const openPanel = manifest.contributes?.keybindings?.find(
      (binding) => binding.command === "nexuscode.openPanel",
    )

    expect(openPanel).toMatchObject({
      key: "ctrl+alt+n",
      mac: "cmd+alt+n",
    })
    expect(openPanel?.key).not.toBe("ctrl+shift+n")
    expect(openPanel?.mac).not.toBe("cmd+shift+n")
  })
})
