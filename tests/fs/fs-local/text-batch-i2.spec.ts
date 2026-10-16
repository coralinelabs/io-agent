/** One guarded executor for skill packages and other multi-file text operations. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { LocalFileSystem } from '../../../src/library/filesystem/fs-local/index.ts'
import { applyTextBatch, type BatchSnapshot, type TextBatchIO, type FsTextMutation } from '../../../src/library/filesystem/batch.ts'
import { FsTargetKey, FsVersion, type FsTarget } from '../../../src/library/filesystem/fs/types.ts'

function memory(initial: Record<string, string> = {}) {
  let revision = 0
  const data = new Map<string, BatchSnapshot>()
  const target = (key: string): FsTarget => ({ targetKey: FsTargetKey(key), displayPath: key })
  const set = (key: string, content: string): void => { data.set(key, { content, version: FsVersion(String(++revision)), mode: 0o600 }) }
  for (const [key, value] of Object.entries(initial)) set(key, value)
  let mutations = 0
  const io: TextBatchIO = {
    inspect: async t => data.get(t.targetKey),
    put: async (t, text) => { mutations++; set(t.targetKey, text) },
    remove: async t => { mutations++; data.delete(t.targetKey) },
  }
  const change = (key: string, content: string | null): FsTextMutation => ({ target: target(key), content,
    expected: data.has(key) ? { kind: 'present', version: data.get(key)!.version } : { kind: 'absent' } })
  return { io, data, set, change, mutationCount: () => mutations }
}

describe('bounded conditional text batch', () => {
  it('preflights every expected revision before executing anything', async () => {
    const f = memory({ a: 'before', b: 'old' }), changes = [f.change('a', 'after'), f.change('b', 'new')]
    f.set('b', 'other writer')
    await expect(applyTextBatch(changes, f.io)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(f.data.get('a')!.content).toBe('before'); expect(f.mutationCount()).toBe(0)
  })
  it.each(['duplicate', 'surrogate', 'missing-delete', 'empty', 'oversized'] as const)('rejects %s before an effect', async kind => {
    const f = memory({ a: 'original' })
    const changes = kind === 'duplicate' ? [f.change('a', 'one'), f.change('a', 'two')]
      : kind === 'surrogate' ? [f.change('a', '\ud800')]
      : kind === 'missing-delete' ? [f.change('missing', null)]
      : kind === 'oversized' ? [f.change('a', 'x'.repeat(8 * 1024 * 1024 + 1))] : []
    await expect(applyTextBatch(changes, f.io)).rejects.toMatchObject({ code: 'FS_INVALID_EDIT' })
    expect(f.mutationCount()).toBe(0)
  })
  it('returns exact changes for a create, update, delete and unchanged file', async () => {
    const f = memory({ a: '\ufeffold\r\nline\n', b: 'delete', c: 'same' })
    const before = f.data.get('c')!.version
    const result = await applyTextBatch([f.change('a', '\ufeffnew\r\nline\n'), f.change('b', null), f.change('c', 'same'), f.change('d', 'new')], f.io)
    expect(result.changes.map(c => [c.before, c.after])).toEqual([
      ['\ufeffold\r\nline\n', '\ufeffnew\r\nline\n'], ['delete', null], ['same', 'same'], [null, 'new'],
    ])
    expect(f.mutationCount()).toBe(3); expect(f.data.get('c')!.version).toBe(before)
  })
  it('rolls acknowledged changes back when the next primitive fails without an effect', async () => {
    const f = memory({ a: 'old' }), put = f.io.put
    f.io.put = async (...args) => { if (args[0].targetKey === 'b') throw new Error('disk full'); await put(...args) }
    await expect(applyTextBatch([f.change('a', 'new'), f.change('b', 'create')], f.io)).rejects.toMatchObject({ status: 'rolled-back', uncertainPaths: [] })
    expect(f.data.get('a')!.content).toBe('old'); expect(f.data.has('b')).toBe(false)
  })
  it('never reports complete rollback after an unacknowledged published effect', async () => {
    const f = memory({ a: 'old' }), put = f.io.put
    f.io.put = async (...args) => { await put(...args); if (args[0].targetKey === 'b') throw new Error('directory fsync failed') }
    await expect(applyTextBatch([f.change('a', 'new'), f.change('b', 'create')], f.io)).rejects.toMatchObject({ status: 'partial', uncertainPaths: ['b'] })
    expect(f.data.get('a')!.content).toBe('old'); expect(f.data.get('b')!.content).toBe('create')
  })
  it('does not overwrite a third-party write while rolling back', async () => {
    const f = memory({ a: 'old' }), put = f.io.put
    f.io.put = async (...args) => { if (args[0].targetKey === 'b') { f.set('a', 'other owner'); throw new Error('failure') }; await put(...args) }
    await expect(applyTextBatch([f.change('a', 'new'), f.change('b', 'create')], f.io)).rejects.toMatchObject({ status: 'partial', uncertainPaths: ['a'] })
    expect(f.data.get('a')!.content).toBe('other owner')
  })
  it('rolls back with an independent cleanup lifetime after cancellation', async () => {
    const f = memory({ a: 'old' }), abort = new AbortController(), put = f.io.put
    f.io.put = async (...args) => { await put(...args); abort.abort(new Error('stop')) }
    await expect(applyTextBatch([f.change('a', 'new'), f.change('b', 'create')], f.io, abort.signal)).rejects.toMatchObject({ status: 'rolled-back' })
    expect(f.data.get('a')!.content).toBe('old'); expect(f.data.has('b')).toBe(false)
  })
  it('does not delete after cancellation during the final inspection', async () => {
    const f = memory({ a: 'old' }), abort = new AbortController(), inspect = f.io.inspect
    let count = 0
    f.io.inspect = async (...args) => { if (++count === 2) abort.abort(); return inspect(...args) }
    await expect(applyTextBatch([f.change('a', null)], f.io, abort.signal)).rejects.toBeDefined()
    expect(f.data.get('a')!.content).toBe('old'); expect(f.mutationCount()).toBe(0)
  })
})

describe('real local text-batch storage', () => {
  let root: string, ctx: Context, fs: LocalFileSystem
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'io-batch-')); ctx = new Context(); await ctx.plugin(LocalFileSystem, { cwd: root }); fs = ctx.fs as LocalFileSystem })
  afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const change = async (path: string, content: string | null): Promise<FsTextMutation> => {
    const target = await fs.resolve(path), found = await fs.stat(target)
    return { target, content, expected: found ? { kind: 'present', version: found.version } : { kind: 'absent' } }
  }
  it('preserves exact BOM, mixed line endings, executable mode, and creates supporting directories', async () => {
    await writeFile(join(root, 'SKILL.md'), '\ufeffold\r\nline\n'); await chmod(join(root, 'SKILL.md'), 0o750)
    const result = await fs.applyTextBatch([await change('scripts/run.py', 'print(42)\n'), await change('SKILL.md', '\ufeffnew\r\nline\n')])
    expect(result.changes).toHaveLength(2)
    expect(await readFile(join(root, 'SKILL.md'), 'utf8')).toBe('\ufeffnew\r\nline\n')
    expect((await stat(join(root, 'SKILL.md'))).mode & 0o777).toBe(0o750)
    expect(await readFile(join(root, 'scripts/run.py'), 'utf8')).toBe('print(42)\n')
  })
  it('uses the same locks and versions as ordinary file operations', async () => {
    await writeFile(join(root, 'a'), 'initial')
    const operation = await change('a', 'batch')
    await fs.writeText(operation.target, 'ordinary')
    await expect(fs.applyTextBatch([operation])).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(join(root, 'a'), 'utf8')).toBe('ordinary')
  })
  it('rejects a directory or binary target before changing an earlier file', async () => {
    await writeFile(join(root, 'a'), 'original'); await writeFile(join(root, 'binary'), Buffer.from([0xff, 0xfe]))
    await expect(fs.applyTextBatch([await change('a', 'changed'), await change('binary', 'text')])).rejects.toBeDefined()
    expect(await readFile(join(root, 'a'), 'utf8')).toBe('original')
    await mkdir(join(root, 'directory'))
    await expect(fs.applyTextBatch([await change('a', 'changed'), await change('directory', 'text')])).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect(await readFile(join(root, 'a'), 'utf8')).toBe('original')
  })
  it('rejects ancestor/descendant file targets without creating either', async () => {
    await expect(fs.applyTextBatch([await change('parent', 'file'), await change('parent/child', 'file')])).rejects.toMatchObject({ code: 'FS_INVALID_EDIT' })
    expect(await fs.stat(await fs.resolve('parent'))).toBeUndefined()
  })
})
