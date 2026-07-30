import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

import review from './review.js'
import { getCwd, setCwd } from '../utils/state.js'

describe('/review command', () => {
  it('keeps user guidance inside the dedicated reviewer instruction', async () => {
    if (review.type !== 'prompt') throw new Error('review must be a prompt command')
    const messages = await review.getPromptForCommand(
      'focus on cancellation and leaked processes',
    )
    const content = messages[0]?.content
    const text =
      Array.isArray(content) && content[0]?.type === 'text'
        ? content[0].text
        : ''

    expect(text).toContain('dedicated code reviewer')
    expect(text).toContain('focus on cancellation and leaked processes')
    expect(text).toContain('Do not modify files')
  })

  it('resolves Git targets from the CLI --cwd workspace, not process.cwd()', async () => {
    if (review.type !== 'prompt') throw new Error('review must be a prompt command')
    const originalCwd = getCwd()
    const cwd = await mkdtemp(join(tmpdir(), 'nexus-cli-review-'))
    try {
      await execa('git', ['init', '--initial-branch=review-base'], { cwd })
      await execa('git', ['config', 'user.name', 'Nexus Test'], { cwd })
      await execa('git', ['config', 'user.email', 'nexus@example.test'], { cwd })
      await writeFile(join(cwd, 'baseline.txt'), 'baseline\n')
      await execa('git', ['add', 'baseline.txt'], { cwd })
      await execa('git', ['commit', '-m', 'baseline'], { cwd })
      await setCwd(cwd)

      const messages = await review.getPromptForCommand('branch review-base')
      const content = messages[0]?.content
      const text =
        Array.isArray(content) && content[0]?.type === 'text'
          ? content[0].text
          : ''

      expect(text).toContain('revision: "review-base"')
      expect(text).toContain('mergeBase: true')
    } finally {
      await setCwd(originalCwd)
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
