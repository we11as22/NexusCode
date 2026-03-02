#!/usr/bin/env node
import { listen } from "./index.js"
listen().catch((err) => {
  console.error(err)
  process.exit(1)
})
