import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../src/library/runtime/vendor/cordis/index.ts'
import LocalFileSystem from '../../src/library/filesystem/fs-local/index.ts'
import { applyTextEdits, MAX_EDITS } from '../../src/library/filesystem/edit.ts'
import { parseEditArgs } from '../../src/library/filesystem/tool-fs/edit.ts'
import type { FsReplacement } from '../../src/library/filesystem/fs/types.ts'
const edit = (oldString: string, newString: string, extra: Partial<FsReplacement> = {}): FsReplacement => ({ oldString, newString, replaceAll: false, ...extra })
const apply = (s: string, ...edits: FsReplacement[]) => applyTextEdits(s, edits, 'test.txt')

describe('atomic edit planning', () => {
  it('matches every edit in the original snapshot, not an earlier replacement', () => {
    expect(apply('a b', edit('a', 'b'), edit('b', 'c')).content).toBe('b c')
    expect(() => apply('a', edit('a', 'b'), edit('b', 'c'))).toThrowError(/not found/)
  })
  it('accepts edits in any order and replacements are literal, including dollar syntax', () => {
    expect(apply('first middle last', edit('last', '$&'), edit('first', '$1'))).toEqual({ content: '$1 middle $&', replacements: 2 })
  })
  it('does not recursively replace its own output', () => {
    expect(apply('a a', edit('a', 'aa', { replaceAll: true })).content).toBe('aa aa')
  })
  it('rejects overlapping and duplicate ranges before producing a result', () => {
    expect(() => apply('abcdef', edit('abc', 'X'), edit('cde', 'Y'))).toThrowError(/overlap/)
    expect(() => apply('abc', edit('abc', 'X'), edit('abc', 'Y'))).toThrowError(/overlap/)
    expect(() => apply('aa bb aa', edit('aa', 'X', { replaceAll: true }), edit('bb aa', 'Y'))).toThrowError(/overlap/)
  })
  it('allows adjacent disjoint ranges and deletions', () => {
    expect(apply('abcdef', edit('abc', ''), edit('def', 'Z'))).toEqual({ content: 'Z', replacements: 2 })
  })
  it('rejects a partial batch with a missing or ambiguous second edit', () => {
    expect(() => apply('A B B', edit('A', 'C'), edit('B', 'D'))).toThrowError(/matched 2 times/)
    expect(() => apply('A B B', edit('A', 'C'), edit('Z', 'D'))).toThrowError(/not found/)
  })
  it('bounds batch size and never interprets an empty needle as insertion', () => {
    expect(() => apply('a')).toThrowError(/between 1/)
    expect(() => apply('a', ...Array.from({ length: MAX_EDITS + 1 }, () => edit('a', 'b')))).toThrowError(/between 1/)
    expect(() => apply('a', edit('', 'b'))).toThrowError(/non-empty/)
  })
  it('normalizes CRLF edit arguments, not other Unicode', () => {
    expect(apply('a\nb\n', edit('a\r\nb', 'a\r\nc')).content).toBe('a\nc\n')
    expect(() => apply('curly “quotes”', edit('curly "quotes"', 'new', { matchMode: 'trailing-whitespace' }))).toThrow()
  })
  it('keeps exact match first, even when fallback would admit additional whitespace variants', () => {
    expect(apply('a \na\n', edit('a\n', 'b\n', { matchMode: 'trailing-whitespace' })).content).toBe('a \nb\n')
  })
  it('only explicitly enabled complete-line trailing whitespace can differ', () => {
    expect(() => apply('  a \n  b\t\nkeep  \n', edit('  a\n  b\n', '  c\n'))).toThrow()
    expect(apply('  a \n  b\t\nkeep  \n', edit('  a\n  b\n', '  c\n', { matchMode: 'trailing-whitespace' })).content).toBe('  c\nkeep  \n')
    expect(() => apply('  a \n', edit('a\n', 'b\n', { matchMode: 'trailing-whitespace' }))).toThrow()
    expect(() => apply('prefix a \n', edit('a\n', 'b\n', { matchMode: 'trailing-whitespace' }))).toThrow()
  })
  it('never synthesizes a missing terminal newline or silently chooses an ambiguous fallback', () => {
    expect(() => apply('a ', edit('a\n', 'b\n', { matchMode: 'trailing-whitespace' }))).toThrow()
    expect(() => apply('a \na\t\n', edit('a\n', 'b\n', { matchMode: 'trailing-whitespace' }))).toThrowError(/matched 2 times/)
    expect(apply('a \na\t\n', edit('a\n', 'b\n', { matchMode: 'trailing-whitespace', replaceAll: true })).content).toBe('b\nb\n')
  })
  it('treats already-present replacement as diagnostic evidence, never success', () => {
    expect(() => apply('new', edit('old', 'new'))).toThrowError(/does not prove/)
  })
  it('preserves prefix/suffix and supports original-snapshot swaps (300 generated cases)', () => {
    const text = fc.array(fc.constantFrom('a', 'b', ' ', '\n', '$', 'λ', '🙂'), { maxLength: 200 }).map(a => a.join(''))
    fc.assert(fc.property(text, text, text, (prefix, middle, suffix) => {
      const s = `${prefix}[FIRST]${middle}[LAST]${suffix}`
      expect(apply(s, edit('[LAST]', '[FIRST]'), edit('[FIRST]', '[LAST]')).content)
        .toBe(`${prefix}[LAST]${middle}[FIRST]${suffix}`)
    }), { numRuns: 300, seed: 505 })
  })
})

describe('model contract validation', () => {
  it('retains the single-edit form and empty-string deletion', () => {
    expect(parseEditArgs({ file_path: 'a', old_string: 'x', new_string: '' })).toEqual({ filePath: 'a', oldString: 'x', newString: '', replaceAll: false })
  })
  it('rejects mixed forms, missing forms and no-op edits', () => {
    expect(() => parseEditArgs({ file_path: 'a', old_string: 'x', new_string: 'y', edits: [] })).toThrow()
    expect(() => parseEditArgs({ file_path: 'a' })).toThrow()
    expect(() => parseEditArgs({ file_path: 'a', edits: [] })).toThrow()
    expect(() => parseEditArgs({ file_path: 'a', edits: [{ old_string: 'a', new_string: 'a' }] })).toThrow()
  })
})

const dispose: (() => Promise<void>)[] = []
afterEach(async () => { while (dispose.length) await dispose.pop()!() })
async function file(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'io-agent-edit-'))
  dispose.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'a.txt'); await writeFile(path, body, { mode: 0o640 })
  const ctx = new Context(); await ctx.plugin(LocalFileSystem, { cwd: dir })
  dispose.push(() => ctx.fiber.dispose())
  const target = await ctx.fs.resolve('a.txt'); const version = (await ctx.fs.stat(target))!.version
  return { path, fs: ctx.fs, target, version }
}
describe('one guarded filesystem transaction', () => {
  it('commits a batch once, preserving mode, BOM and CRLF', async () => {
    const f = await file('\uFEFFone\r\ntwo\r\nkeep  \r\n')
    const outcome = await f.fs.editText(f.target, { edits: [edit('one', 'ONE'), edit('two', 'TWO')] }, { version: f.version })
    expect(await readFile(f.path, 'utf8')).toBe('\uFEFFONE\r\nTWO\r\nkeep  \r\n')
    expect((await stat(f.path)).mode & 0o777).toBe(0o640)
    expect(outcome.version).not.toBe(f.version)
  })
  it('no partial mutation after a late ambiguity, missing match or overlap', async () => {
    const f = await file('first second second')
    for (const edits of [[edit('first', 'CHANGED'), edit('second', 'X')], [edit('first', 'CHANGED'), edit('missing', 'X')], [edit('first', 'CHANGED'), edit('first second', 'X')]]) {
      await expect(f.fs.editText(f.target, { edits }, { version: f.version })).rejects.toThrow()
      expect(await readFile(f.path, 'utf8')).toBe('first second second')
      expect((await f.fs.stat(f.target))!.version).toBe(f.version)
    }
  })
  it('rejects stale versions before attempting a match', async () => {
    const f = await file('old'); await writeFile(f.path, 'new contents')
    await expect(f.fs.editText(f.target, { edits: [edit('old', 'other')] }, { version: f.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(f.path, 'utf8')).toBe('new contents')
  })
  it('two concurrent batches against one observed version cannot both commit', async () => {
    const f = await file('one two')
    const results = await Promise.allSettled([
      f.fs.editText(f.target, { edits: [edit('one', 'A')] }, { version: f.version }),
      f.fs.editText(f.target, { edits: [edit('two', 'B')] }, { version: f.version }),
    ])
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(x => x.status === 'rejected')).toHaveLength(1)
    expect(['A two', 'one B']).toContain(await readFile(f.path, 'utf8'))
  })
  it('honors cancellation before mutation', async () => {
    const f = await file('one')
    await expect(f.fs.editText(f.target, { edits: [edit('one', 'A')] }, { version: f.version }, AbortSignal.abort())).rejects.toThrow()
    expect(await readFile(f.path, 'utf8')).toBe('one')
  })
})


describe('raw byte preservation around edited spans', () => {
  it('leaves mixed line endings and BOM untouched outside each original range', () => {
    const input = '\uFEFFzero\r\none\ntwo\r\nthree\nfour'
    expect(apply(input, edit('one', 'ONE'), edit('three', 'THREE')).content).toBe('\uFEFFzero\r\nONE\ntwo\r\nTHREE\nfour')
  })
  it('uses the replaced span convention for newly inserted line breaks', () => {
    expect(apply('a\r\nb\r\nc\nd', edit('a\nb', 'A\nB')).content).toBe('A\r\nB\r\nc\nd')
  })
  it('rejects overlapping occurrences of the same needle', () => {
    expect(() => apply('aaa', edit('aa', 'x', { replaceAll: true }))).toThrow(/overlap/)
  })
  it('preserves mixed newlines in a real transaction and does not fabricate a terminal newline', async () => {
    const f = await file('\uFEFFone\r\ntwo\nthree')
    await f.fs.editText(f.target, { edits: [edit('two', 'TWO')] }, { version: f.version })
    expect(await readFile(f.path, 'utf8')).toBe('\uFEFFone\r\nTWO\nthree')
  })
})
