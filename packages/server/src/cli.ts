#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import * as path from "node:path"
import { listen } from "./index.js"

const generateLocalToken = process.argv.includes("--generate-local-token")
const generatedToken = generateLocalToken
  ? randomBytes(32).toString("base64url")
  : undefined
const generatedSecurity = generatedToken
  ? {
      token: generatedToken,
      workspaceRoots: (process.env.NEXUS_SERVER_ROOTS ?? process.cwd())
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean),
      allowedOrigins: (process.env.NEXUS_SERVER_ORIGINS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    }
  : undefined

if (generatedToken) {
  process.stderr.write(
    `[nexus] Generated local server token (set NEXUS_SERVER_TOKEN in the client): ${generatedToken}\n`,
  )
}

listen(generatedSecurity ? { security: generatedSecurity } : undefined).catch((err) => {
  console.error(err)
  process.exit(1)
})
