import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { getCwd, setCwd } from './state.js'

describe('CLI cwd state', () => {
  it('tracks cwd without starting a persistent login shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-state-'))

    await setCwd(directory)

    expect(getCwd()).toBe(await realpath(directory))
  })

  it('rejects files and keeps the previous cwd', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-state-'))
    const file = join(directory, 'file.txt')
    await writeFile(file, 'not a directory')
    await setCwd(directory)

    await expect(setCwd(file)).rejects.toThrow('Not a directory')
    expect(getCwd()).toBe(await realpath(directory))
  })
})
