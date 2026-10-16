import { describe, it, expect } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import z from '../../../src/library/runtime/vendor/schemastery/index.ts'
import { createExtensionManager } from '../../../src/library/extensions/index.ts'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('live headless extension ownership', () => {
  it('installs, replaces, and removes real scoped effects', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx), live = new Set<string>()
    const plugin = (tag: string) => (owner: Context) => { owner.effect(() => { live.add(tag); return () => { live.delete(tag) } }) }
    const first = await manager.install({ id: 'test', config: {}, load: () => plugin('one') })
    expect([...live]).toEqual(['one'])
    const second = await manager.replace({ id: 'test', config: {}, load: () => plugin('two') }, first.revision)
    expect([...live]).toEqual(['two']); expect(second.revision).toBeGreaterThan(first.revision)
    await expect(manager.remove('test', first.revision)).rejects.toMatchObject({ code: 'STALE' })
    expect([...live]).toEqual(['two'])
    await manager.remove('test', second.revision); expect([...live]).toEqual([])
    await ctx.fiber.dispose()
  })

  it('failed import does not detach the installed plugin', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx); let releases = 0
    const first = await manager.install({ id: 'test', config: null, load: () => (owner: Context) => { owner.effect(() => () => { releases++ }) } })
    await expect(manager.replace({ id: 'test', config: null, load: () => { throw new Error('syntax') } }, first.revision)).rejects.toThrow('syntax')
    expect(releases).toBe(0); expect(manager.list()[0]?.status).toBe('active')
    await ctx.fiber.dispose(); expect(releases).toBe(1)
  })

  it('restores the previous implementation and original config after partial activation fails', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx), values: number[] = []; let partial = 0
    const config = { value: 1 }
    const plugin = (_ctx: Context, c: {value: number}) => { values.push(c.value); c.value = 100 }
    const first = await manager.install({ id: 'test', config, load: () => plugin }); config.value = 9
    await expect(manager.replace({ id: 'test', config: {}, load: () => (owner: Context) => {
      owner.effect(() => { partial++; return () => { partial-- } }); throw new Error('activation')
    } }, first.revision)).rejects.toMatchObject({ code: 'ACTIVATION' })
    expect(values).toEqual([1,1]); expect(partial).toBe(0); expect(manager.list()[0]).toMatchObject(first)
    await ctx.fiber.dispose()
  })

  it('validates new config before stopping the previous generation', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx); let released = false
    const first = await manager.install({ id: 'test', config: {}, load: () => (c: Context) => { c.effect(() => () => { released = true }) } })
    const plugin = { Config: z.object({ name: z.string().required() }), apply() {} }
    await expect(manager.replace({ id: 'test', config: {} as {name:string}, load: () => plugin }, first.revision)).rejects.toThrow('invalid config')
    expect(released).toBe(false); await ctx.fiber.dispose()
  })

  it('reports unavailable dependencies rather than pretending a pending fiber is active', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx)
    await expect(manager.install({ id: 'test', config: {}, load: () => ({ inject: ['notInstalled'], apply() {} }) })).rejects.toMatchObject({ code: 'ACTIVATION' })
    expect(manager.list()).toEqual([]); await ctx.fiber.dispose()
  })

  it('rejects stale queued replacements before importing them', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx), pause = deferred<void>(); let staleImported = false
    const first = await manager.install({ id: 'test', config: {}, load: () => () => {} })
    const changing = manager.replace({ id: 'test', config: {}, load: async () => { await pause.promise; return () => {} } }, first.revision)
    const stale = manager.replace({ id: 'test', config: {}, load: () => { staleImported = true; return () => {} } }, first.revision)
    const rejection = expect(stale).rejects.toMatchObject({ code: 'STALE' }); pause.resolve(); await changing; await rejection
    expect(staleImported).toBe(false); await ctx.fiber.dispose()
  })

  it('close joins pending import and prevents resurrection', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx), entered = deferred<void>(), pause = deferred<void>(); let activated = false
    const pending = manager.install({ id: 'test', config: {}, load: async () => { entered.resolve(); await pause.promise; return () => { activated = true } } })
    await entered.promise
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
    const closed = manager.close(); pause.resolve(); await rejection; await closed
    expect(activated).toBe(false); expect(manager.list()).toEqual([])
    await expect(manager.install({id:'next', config:{}, load:()=>()=>{}})).rejects.toMatchObject({code:'CLOSED'})
    await ctx.fiber.dispose()
  })

  it('rejects cyclic and non-JSON configuration without invoking the loader', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx); let imports = 0
    const cycle: any = {}; cycle.self = cycle
    for (const config of [cycle, {f:()=>{}}, {n:NaN}]) {
      await expect(manager.install({ id: 'test', config, load: () => { imports++; return () => {} } })).rejects.toThrow('JSON')
    }
    expect(imports).toBe(0); await ctx.fiber.dispose()
  })

  it('reports restoration failure explicitly and keeps the failed identity removable', async () => {
    const ctx = new Context(), manager = createExtensionManager(ctx); let loads = 0
    const first = await manager.install({ id:'test', config:{}, load:()=>() => { if (++loads>1) throw new Error('old no longer starts') } })
    await expect(manager.replace({id:'test',config:{},load:()=>() => {throw new Error('new failed')}},first.revision)).rejects.toMatchObject({code:'ROLLBACK'})
    expect(manager.list()[0]?.status).toBe('failed')
    await manager.remove('test',first.revision); await ctx.fiber.dispose()
  })
})
