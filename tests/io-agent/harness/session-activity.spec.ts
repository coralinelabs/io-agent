/** Native observation and persistence barriers remain independent from submitted runs. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createUserMessage } from "../../../src/library/model/llm/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import { fixture, stream, tool } from './fixture.ts'
import { hostFixture, turn } from './host-fixture.ts'

describe('native session activity', () => {
  it('exposes nonwaking pending input and clears it without starting inference', async () => {
    let ctx!: Context
    const { app, requests } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => { ctx = context },
    })
    const session = await app.createSession()
    const agent = ctx.agents.get(SessionId(session.id))!
    expect(session.busy).toBe(false)
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Retained native context.' }], source: { kind: 'plugin', plugin: 'activity-fixture' } }))
    expect(session.status).toBe('idle')
    expect(session.pendingInput).toBe(true)
    expect(session.busy).toBe(true)
    await expect(session.run('Do not silently queue this.')).rejects.toThrow('busy')
    session.cancel()
    expect(session.pendingInput).toBe(false)
    expect(session.busy).toBe(false)
    expect(requests).toHaveLength(0)
  }, 30000)

  it('keeps run admission busy through its persistence drain after native idle', async () => {
    let ctx!: Context
    const { app } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => { ctx = context },
    })
    const session = await app.createSession()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const flush = ctx.sessionPersistence.flush.bind(ctx.sessionPersistence)
    const spy = vi.spyOn(ctx.sessionPersistence, 'flush').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      await flush()
    })
    const pending = session.run('Finish the native turn before releasing persistence.')
    try {
      await entered.promise
      expect(session.status).toBe('idle')
      expect(session.pendingInput).toBe(false)
      expect(session.busy).toBe(true)
      await expect(session.run('A second run must wait.')).rejects.toThrow('busy')
      release.resolve(undefined)
      await pending
      expect(session.busy).toBe(false)
    } finally { release.resolve(undefined); spy.mockRestore(); await pending }
  }, 30000)

  it('flushes persisted events while inference remains active', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const { app } = await fixture(async (_request, response) => {
      entered.resolve(undefined)
      await release.promise
      stream(response, [{ content: 'Done.' }])
    })
    const session = await app.createSession()
    session.send('Keep the request active until its event barrier completes.')
    try {
      await entered.promise
      await session.flush()
      expect(session.status).toBe('running')
      expect(session.busy).toBe(true)
      expect((await session.events()).some(event => event.type === 'turn/start')).toBe(true)
    } finally { release.resolve(undefined); await session.whenIdle() }
  }, 30000)

  it('drains an admitted persistence-only barrier during close', async () => {
    let ctx!: Context
    const { app } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => { ctx = context },
    })
    const session = await app.createSession()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const flush = ctx.sessionPersistence.flush.bind(ctx.sessionPersistence)
    const spy = vi.spyOn(ctx.sessionPersistence, 'flush').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      await flush()
    })
    const pending = session.flush()
    await entered.promise
    let closed = false
    const closing = session.close().then(() => { closed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(() => session.flush()).toThrow('closed')
      expect(() => session.busy).toThrow('closed')
      expect(() => session.pendingInput).toThrow('closed')
      release.resolve(undefined)
      await pending
      await closing
      expect(closed).toBe(true)
    } finally { release.resolve(undefined); spy.mockRestore(); await pending; await closing }
  }, 30000)

  it('observes idle before an already mounted handler synchronously wakes a replacement', async () => {
    let woken = false
    const { app, requests } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (ctx) => {
        ctx.on('agent/status', ({ agent, status }) => {
          if (status !== 'idle' || woken) return
          woken = true
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native replacement.' }], source: { kind: 'plugin', plugin: 'activity-fixture' } }))
        })
      },
    })
    const session = await app.createSession()
    const observed: string[] = []
    session.subscribe((event) => { if (event.type === 'status') observed.push(event.status) })
    await session.run('Initial input.')
    expect(observed).toEqual(['running', 'idle', 'running', 'idle'])
    expect(requests).toHaveLength(2)
    expect(session.busy).toBe(false)
  }, 30000)

  it('retires cancelled ownership before a latched native followup asks a new question', async () => {
    const entered = Promise.withResolvers<undefined>()
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) { entered.resolve(undefined); return }
      if (index === 1) tool(response, 'ask_user_question', { questions: [{ id: 'successor', question: 'Continue the new activity?', options: [{ label: 'yes' }] }] })
      else stream(response, [{ content: 'The successor received its own answer.' }])
    }, { sandbox: 'danger-full-access', approval: 'never' })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Start a request that the host will cancel.', 'cancel-before-native-followup'))
    await entered.promise
    const previous = f.host.readSession(id).activity
    if (previous === undefined) throw new Error('missing initial activity')
    let cancelled = false
    const cancellation = f.host.cancel(id, receipt.activity_id).then(() => { cancelled = true })
    const agent = f.context().agents.get(SessionId(id))
    if (agent === undefined) throw new Error('missing native root')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native work accepted after cancellation.' }], source: { kind: 'plugin', plugin: 'activity-fixture' } }))
    await expect.poll(() => cancelled, { timeout: 5000 }).toBe(true)
    await cancellation
    await expect.poll(() => f.host.readSession(id).activity?.pending_requests.some(request => request.kind === 'question'),
      { timeout: 5000 }).toBe(true)
    const successor = f.host.readSession(id).activity
    if (successor === undefined) throw new Error('missing successor activity')
    expect(successor.activity_id).not.toBe(previous.activity_id)
    expect(successor.turn_id).toBeUndefined()
    const question = successor.pending_requests.find(request => request.kind === 'question')
    if (question === undefined) throw new Error('missing successor question')
    await f.host.cancel(id, previous.activity_id)
    expect(f.host.readSession(id).activity?.activity_id).toBe(successor.activity_id)
    f.host.reply({ session_id: id, activity_id: successor.activity_id, request_id: question.request_id, kind: 'question',
      answer: { answers: [{ id: 'successor', selected: ['yes'] }] } })
    await expect.poll(() => f.host.readActivity(id, successor.activity_id).status).toBe('settled')
    expect(f.requests).toHaveLength(3)
  }, 30000)

  it('reports idle admission when a watcher receives autonomous activity settlement', async () => {
    const f = await hostFixture((_request, response) => { stream(response, [{ content: 'Native followup finished.' }]) },
      { sandbox: 'danger-full-access', approval: 'never' })
    const id = await f.host.createSession()
    const observed = (async () => {
      for await (const event of f.host.watchSession(id)) {
        if (event.type !== 'activity' || event.state !== 'settled') continue
        const view = f.host.readSession(id)
        expect(view.busy).toBe(false)
        expect(view.activity).toBeUndefined()
        expect(f.host.readActivity(id, event.activity_id!).status).toBe('settled')
        return event
      }
      throw new Error('session observation ended before activity settlement')
    })()
    const agent = f.context().agents.get(SessionId(id))
    if (agent === undefined) throw new Error('missing native root')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Autonomous native followup.' }], source: { kind: 'plugin', plugin: 'activity-fixture' } }))
    expect((await observed).turn_id).toBeUndefined()
    expect(f.requests).toHaveLength(1)
  }, 30000)
})
