import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { createExtensionManager, loadFileExtension } from '../../../src/library/extensions/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const source = (label: string): string => `export default function(ctx, config) {
  ctx.root.__reloadEvents.push(['start', ${JSON.stringify(label)}, config.value]);
  ctx.effect(() => () => { ctx.root.__reloadEvents.push(['stop', ${JSON.stringify(label)}]); });
}`
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'io-extension-')), file = join(dir, 'tool.mjs')
  const ctx = new Context(), events: unknown[][] = []
  Reflect.set(ctx, '__reloadEvents', events)
  const manager = createExtensionManager(ctx)
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await writeFile(file, source('one'))
  return { dir, file, ctx, manager, events }
}

describe('trusted ESM file extensions', () => {
  it('loads exact code snapshots and cleans temporary modules', async () => {
    const { dir, file, manager, events } = await fixture()
    const extension = await loadFileExtension(manager, { id: 'file', file, config: { value: 7 }, watch: false })
    expect(events).toEqual([['start', 'one', 7]])
    const revision = extension.snapshot().revision
    await writeFile(file, source('two'))
    await extension.reload()
    expect(events).toEqual([['start', 'one', 7], ['stop', 'one'], ['start', 'two', 7]])
    expect(extension.snapshot().revision).toBeGreaterThan(revision)
    expect(await readdir(dir)).toEqual(['tool.mjs'])
    await extension.close(); expect(events.at(-1)).toEqual(['stop', 'two'])
    await expect(extension.reload()).rejects.toMatchObject({ code: 'CLOSED' })
  })
  it('does not restart on identical content; updates configuration with owned snapshots', async () => {
    const { file, manager, events } = await fixture()
    const config = { value: 1 }
    const extension = await loadFileExtension(manager, { id: 'file', file, config, watch: false })
    config.value = 99
    const initial = extension.snapshot()
    await writeFile(file, source('one')); await extension.reload()
    expect(extension.snapshot().revision).toBe(initial.revision)
    expect(events).toHaveLength(1)
    const next = { value: 2 }, updated = extension.updateConfig(next); next.value = 777
    await updated
    expect(events.at(-1)).toEqual(['start', 'one', 2])
    await extension.close()
  })
  it('syntax failure leaves old implementation running; corrected file can be loaded', async () => {
    const { file, manager, events } = await fixture()
    const extension = await loadFileExtension(manager, { id: 'file', file, config: { value: 1 }, watch: false })
    await writeFile(file, 'export default ?????')
    await expect(extension.reload()).rejects.toThrow()
    expect(events).toEqual([['start', 'one', 1]])
    expect(extension.snapshot().status).toBe('active')
    await writeFile(file, source('corrected')); await extension.reload()
    expect(events.at(-1)).toEqual(['start', 'corrected', 1])
    await extension.close()
  })
  it('restores old code and config after a replacement starts then fails', async () => {
    const { file, manager, events } = await fixture()
    const extension = await loadFileExtension(manager, { id: 'file', file, config: { value: 1 }, watch: false })
    await writeFile(file, 'export default function(ctx) { ctx.effect(()=>()=>ctx.root.__reloadEvents.push(["partial-stop"])); throw Error("bad") }')
    await expect(extension.reload()).rejects.toMatchObject({ code: 'ACTIVATION' })
    expect(events).toEqual([['start', 'one', 1], ['stop', 'one'], ['partial-stop'], ['start', 'one', 1]])
    expect(extension.snapshot().status).toBe('active')
    await extension.close()
  })
  it('watches atomic replacements and reports errors without withdrawing the last good generation', async () => {
    const { file, dir, manager, events } = await fixture(), errors: unknown[] = []
    const extension = await loadFileExtension(manager, { id: 'file', file, config: { value: 1 }, debounceMs: 10, onError: e => { errors.push(e) } })
    await writeFile(file, 'invalid !! javascript')
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    expect(events).toHaveLength(1)
    const replacement = join(dir, 'next.mjs'); await writeFile(replacement, source('two')); await rename(replacement, file)
    await vi.waitFor(() => expect(events.at(-1)).toEqual(['start', 'two', 1]))
    expect(extension.snapshot().lastError).toBeUndefined()
    await extension.close()
    expect(extension.snapshot().watching).toBe(false)
  })
  it('scope shutdown closes the watcher and prevents later reactivation', async () => {
    const { file, ctx, manager, events } = await fixture()
    const extension = await loadFileExtension(manager, { id: 'file', file, config: {}, debounceMs: 0 })
    await ctx.fiber.dispose()
    expect(extension.snapshot().watching).toBe(false)
    const count = events.length
    await writeFile(file, source('later'))
    await expect(extension.reload()).rejects.toMatchObject({ code: 'CLOSED' })
    expect(events).toHaveLength(count)
    await extension.close()
  })
  it('closing an obsolete controller cannot remove another owner’s successor', async () => {
    const { file, manager } = await fixture()
    const extension = await loadFileExtension(manager, { id: 'file', file, config: {}, watch: false })
    const successor = await manager.replace({ id: 'file', config: {}, load: () => () => {} }, extension.snapshot().revision)
    await expect(extension.reload()).rejects.toMatchObject({ code: 'STALE' })
    await extension.close()
    expect(manager.list()).toEqual([successor])
  })
  it('counts failed module imports toward the Node cache bound', async () => {
    const { file, manager, events } = await fixture()
    const extension = await loadFileExtension(manager, { id: 'file', file, config: {}, watch: false, maxCodeGenerations: 2 })
    await writeFile(file, 'export invalid')
    await expect(extension.reload()).rejects.toThrow()
    await writeFile(file, source('third'))
    await expect(extension.reload()).rejects.toMatchObject({ code: 'RELOAD_LIMIT' })
    expect(events).toHaveLength(1)
    // Config updates reuse the already loaded code, even after the code-generation ceiling.
    await writeFile(file, source('one')); await extension.updateConfig({ value: 3 })
    expect(events.at(-1)).toEqual(['start', 'one', 3])
    await extension.close()
  })
  it('imports assets relative to the original entry directory', async () => {
    const { file, dir, manager, events } = await fixture()
    await writeFile(join(dir, 'asset.txt'), 'hello')
    await writeFile(file, `import {readFileSync} from 'node:fs'; const content=readFileSync(new URL('./asset.txt',import.meta.url),'utf8'); export default ctx=>{ctx.root.__reloadEvents.push([content])}`)
    const extension = await loadFileExtension(manager, { id: 'file', file, config: {}, watch: false })
    expect(events).toEqual([['hello']]); await extension.close()
  })
})
