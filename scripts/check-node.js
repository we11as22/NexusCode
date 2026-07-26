#!/usr/bin/env node

void import("./runtime-version.mjs").then(({ assertRuntimeVersion }) => {
  if (!assertRuntimeVersion()) process.exit(1)
})
