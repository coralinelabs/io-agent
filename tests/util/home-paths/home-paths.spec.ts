import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as homePaths from "../../../src/library/util/home-paths/index.ts"
import { canonicalizeWatchPath, USER_DIR_ENV } from "../../../src/library/util/home-paths/index.ts"

describe('dsh path helpers', () => {
  it('has no default home: only the variable name it sets for children, and no resolver that reads one', () => {
    expect(USER_DIR_ENV).toBe('IO_AGENT_USER_DIR')
    expect(Object.keys(homePaths).sort()).toEqual(['USER_DIR_ENV', 'canonicalizeWatchPath'])
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
