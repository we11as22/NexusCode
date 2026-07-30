import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolUseContext } from '../../Tool.js'
import { setCwd, setOriginalCwd } from '../../utils/state.js'
import { BashTool } from './BashTool.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

function toolContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [BashTool],
      forkNumber: 0,
      messageLogName: 'native-sandbox-test',
      maxThinkingTokens: 0,
    },
    readFileTimestamps: {},
  }
}

async function finalResult(command: string) {
  let final
  for await (const item of BashTool.call({ command }, toolContext())) {
    final = item
  }
  if (!final || final.type !== 'result') {
    throw new Error('BashTool did not emit a final result')
  }
  return final.data
}

describe.runIf(
  process.platform === 'darwin' &&
    process.env.NEXUS_NATIVE_SANDBOX_SMOKE === '1',
)('legacy CLI Bash renderer compatibility', () => {
  it('uses the native broker and cannot write outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-bash-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'nexus-bash-outside-'))
    temporaryRoots.push(workspace, outside)
    setOriginalCwd(workspace)
    await setCwd(workspace)

    const allowed = await finalResult("printf 'inside' > inside.txt")
    expect(allowed.stderr).toBe('')
    await expect(readFile(join(workspace, 'inside.txt'), 'utf8')).resolves.toBe(
      'inside',
    )

    const blockedPath = join(outside, 'blocked.txt')
    const blocked = await finalResult(
      `printf 'blocked' > '${blockedPath.replaceAll("'", "'\\''")}'`,
    )
    expect(blocked.stderr, JSON.stringify(blocked)).toMatch(
      /Exit code|not permitted|denied/iu,
    )
    await expect(readFile(blockedPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
