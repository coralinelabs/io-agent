/** Persisted event pages preserve invocation ordering and owned shutdown. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import { fixture, stream } from './fixture.ts'

describe('persisted event pages', () => {
  it('bounds pages and returns the complete run suffix across page boundaries', async () => {
    let ctx!: Context
    const { app } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => {
        ctx = context
        ctx.on('agent/request', async ({ agent }, next) => {
          for (let i = 0; i < 1005; i++) {
            agent.session.append('pluto/compaction-recovery', {
              attempt: 1, bytesBefore: 2, bytesAfter: 1, requestSha256: String(i),
            })
          }
          return next()
        })
      },
    })
    const session = await app.createSession()
    const run = await session.run('Produce a long event suffix.')
    expect(run.events.length).toBeGreaterThan(1000)
    const first = await session.events()
    const second = await session.events(first.length)
    expect(first).toHaveLength(1000)
    expect(second.length).toBeGreaterThan(0)
    expect([...first, ...second].map(event => event.seq)).toEqual(
      Array.from({ length: ctx.agents.get(SessionId(session.id))?.session.seq ?? 0 }, (_, index) => index),
    )
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(await session.events(Number.MAX_SAFE_INTEGER, 1)).toEqual([])
    expect(() => session.events(0, 1001)).toThrow('event limit')
    expect(() => session.events(-1)).toThrow('event offset')
  }, 30000)

  it('excludes appends after invocation while its persistence barrier waits', async () => {
    let ctx!: Context
    const { app } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => { ctx = context },
    })
    const session = await app.createSession()
    await session.run('Seed history.')
    const before = await session.events()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const flush = ctx.sessionPersistence.flush.bind(ctx.sessionPersistence)
    const spy = vi.spyOn(ctx.sessionPersistence, 'flush').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      await flush()
    })
    const pending = session.events()
    try {
      await entered.promise
      await session.run('Append while the earlier page waits.')
      release.resolve(undefined)
      expect(await pending).toEqual(before)
      expect((await session.events()).length).toBeGreaterThan(before.length)
    } finally { release.resolve(undefined); spy.mockRestore(); await pending }
  }, 30000)

  it('drains an accepted read before closing its writer and rejects later reads', async () => {
    let ctx!: Context
    const { app } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => { ctx = context },
    })
    const session = await app.createSession()
    await session.run('Seed history.')
    const before = await session.events()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const flush = ctx.sessionPersistence.flush.bind(ctx.sessionPersistence)
    const spy = vi.spyOn(ctx.sessionPersistence, 'flush').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      await flush()
    })
    const pending = session.events()
    await entered.promise
    let closed = false
    const closing = session.close().then(() => { closed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(() => session.events()).toThrow('closed')
      release.resolve(undefined)
      expect(await pending).toEqual(before)
      await closing
      expect(closed).toBe(true)
    } finally { release.resolve(undefined); spy.mockRestore(); await pending; await closing }
  }, 30000)
})
