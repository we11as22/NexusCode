import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const permissionMenus = [
  "components/permissions/FallbackPermissionRequest.tsx",
  "components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx",
  "components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx",
  "components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx",
]

describe("CLI permission menu consistency", () => {
  it.each(permissionMenus)(
    "uses the same stable CustomSelect implementation in %s",
    (relativePath) => {
      const source = readFileSync(resolve(process.cwd(), "src", relativePath), "utf8")

      expect(source).toContain("CustomSelect")
      expect(source).not.toContain("import { Select } from '@inkjs/ui'")
    },
  )
})
