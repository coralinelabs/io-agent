/** Catalog choices and retry keys enter the real host/loop/journal path. */
import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '../../../src/library/host/index.ts'
import type { HostFileChange, ModelConnection } from '../../../src/library/host/index.ts'
import { stream, tool } from './fixture.ts'
import { hostFixture, journal, run, turn } from './host-fixture.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'

describe('trusted host routing and receipts', () => {
  it('runs a cold background child, resumed after a restart, on its root\'s current connection', async () => {
    let childId = '', phase = 0, parentCalls = 0
    const child: string[] = []
    // The child's own first user message is its prompt; the parent's history carries it only inside a tool call.
    const isChild = (request: { messages: { role: string; content: unknown }[] }): boolean =>
      JSON.stringify(request.messages.find(message => message.role === 'user')?.content ?? '').includes('Prepare the research.')
    const f = await hostFixture((request, response) => {
      if (isChild(request)) { child.push(request.model); stream(response, [{ content: 'Child done.' }]); return }
      parentCalls += 1
      if (phase === 0 && parentCalls === 1) tool(response, 'subagent', { description: 'Research', prompt: 'Prepare the research.', run_in_background: true })
      else if (phase === 1 && parentCalls === 1) tool(response, 'send_message', { agent_id: childId, message: 'Continue the research.' })
      else stream(response, [{ content: 'Parent done.' }])
    }, { sandbox: 'danger-full-access', configure: (context) => {
      context.on('agent/created', ({ agent }) => { if (!context.agents.roots().includes(agent)) childId = String(agent.id); return undefined })
    } })
    const id = await f.host.createSession('cold-child')
    const before: ModelConnection = { ...f.options.ioAgent.model, model: 'model-before', requestMetadata: { mode: 'before' } }
    const first = await f.host.submit(turn(id, 'Start the research.'), { model: before })
    await f.host.settled(id, first.activity_id!)
    await expect.poll(() => child.length, { timeout: 5000 }).toBe(1)
    await expect.poll(async () => (await f.host.listSessions())[0]?.status, { timeout: 5000 }).toBe('idle')
    await f.host.close()
    // No adapter registration survives the restart; the root now selects another connection.
    const host = await f.open()
    phase = 1; parentCalls = 0
    const after: ModelConnection = { ...f.options.ioAgent.model, model: 'model-after', requestMetadata: { mode: 'after' } }
    const second = await host.submit(turn(id, 'Resume the child.', 'resume-child-turn'), { model: after })
    await host.settled(id, second.activity_id!)
    await expect.poll(() => child.length, { timeout: 5000 }).toBe(2)
    expect(child).toEqual(['model-before', 'model-after'])
  }, 30000)

  it('wakes a released session for its background work on the connection its turn chose, and a cold child follows it', async () => {
    let childId = ''
    const child: string[] = [], parent: string[] = []
    const isChild = (request: { messages: { role: string; content: unknown }[] }): boolean =>
      JSON.stringify(request.messages.find(message => message.role === 'user')?.content ?? '').includes('Prepare the research.')
    const f = await hostFixture((request, response) => {
      if (isChild(request)) { child.push(request.model); stream(response, [{ content: 'Child done.' }]); return }
      parent.push(request.model)
      const woken = JSON.stringify(request.messages.at(-1)?.content ?? '').includes('Watcher watch-1 fired')
      if (parent.length === 1) tool(response, 'subagent', { description: 'Research', prompt: 'Prepare the research.', run_in_background: true }, 'call-subagent')
      else if (parent.length === 2) tool(response, 'watch', { minutes: 0.03 }, 'call-watch')
      else if (woken) tool(response, 'send_message', { agent_id: childId, message: 'Continue the research.' }, 'call-send')
      else stream(response, [{ content: 'Parent done.' }])
    }, { sandbox: 'danger-full-access', configure: (context) => {
      context.on('agent/created', ({ agent }) => { if (!context.agents.roots().includes(agent)) childId = String(agent.id); return undefined })
    } }, { idleReleaseMs: 200 })
    const id = await f.host.createSession('woken-route')
    const chosen: ModelConnection = { ...f.options.ioAgent.model, model: 'model-chosen', requestMetadata: { mode: 'chosen' } }
    const first = await f.host.submit(turn(id, 'Start the research and wake me.'), { model: chosen })
    await f.host.settled(id, first.activity_id!)
    await expect.poll(() => child.length, { timeout: 5000 }).toBe(1)
    // Released while the watcher waits: nothing of this opening is left when it fires.
    await expect.poll(() => f.context().agents.get(SessionId(id)), { timeout: 5000 }).toBeUndefined()
    await expect.poll(() => child.length, { timeout: 10000 }).toBe(2)
    expect(new Set(parent)).toEqual(new Set(['model-chosen']))
    expect(child).toEqual(['model-chosen', 'model-chosen'])
  }, 30000)

  it('wakes a session owed a notice after a restart on the connection its embedder says it last chose', async () => {
    const f = await hostFixture((request, response, index) => {
      if (index === 0) tool(response, 'watch', { minutes: 0.02 }, 'call-watch')
      else stream(response, [{ content: `Seen on ${String(request.model)}.` }])
    }, { sandbox: 'danger-full-access' }, { connectionFor: (sessionId) => sessionId === 'restarted-route' ? chosen : undefined })
    const chosen: ModelConnection = { ...f.options.ioAgent.model, model: 'model-chosen', requestMetadata: { mode: 'chosen' } }
    const id = await f.host.createSession('restarted-route')
    const first = await f.host.submit(turn(id, 'Wake me soon.'), { model: chosen })
    await f.host.settled(id, first.activity_id!)
    await f.host.close()
    await new Promise(resolve => setTimeout(resolve, 1500))
    await f.open()
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    expect(f.requests.map(request => request.model)).toEqual(['model-chosen', 'model-chosen', 'model-chosen'])
    // The same connection is the same route: the model is not told it changed.
    expect(JSON.stringify(f.requests[2]?.messages)).not.toContain('[model changed')
  }, 30000)

  it('isolates concurrent session model/effort and output budgets, and rejects a changed retry without rerouting', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const f = await hostFixture(async (request, response) => {
      const isA = request.model === 'model-a'
      const calls = request.messages.filter(message => message.role === 'tool').length
      if (isA && calls === 0) { entered.resolve(); await release.promise; tool(response, 'read', { file_path: 'missing.txt' }) }
      else stream(response, [{ content: `from ${request.model}` }])
    })
    const a = await f.host.createSession(), b = await f.host.createSession()
    let token = 'first-token'
    const choice = (model: string, reasoningEffort: 'low' | 'high', maxTokens: number): ModelConnection => ({
      ...f.options.ioAgent.model, model, reasoningEffort, maxTokens,
    })
    const modelA = { ...choice('model-a', 'low', 2048), apiKey: () => token }, modelB = choice('model-b', 'high', 3000)
    const bodyA = turn(a, 'Run A', 'room:main:turn-a')
    const first = await f.host.submit(bodyA, { model: modelA })
    await entered.promise
    try {
      const second = await f.host.submit(turn(b, 'Run B'), { model: modelB })
      await f.host.settled(b, second.activity_id!)
      await expect(f.host.submit(bodyA, { model: modelB })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
      const duplicate = await f.host.submit(bodyA, { model: { ...modelA, apiKey: () => 'rotated-token' } })
      expect(duplicate.duplicate).toBe(true)
    } finally { token = 'next-token'; release.resolve() }
    await f.host.settled(a, first.activity_id!)
    expect(f.requests.map(request => [request.model, request.reasoning_effort, request.max_tokens]))
      .toEqual([['model-a', 'low', 2048], ['model-b', 'high', 3000], ['model-a', 'low', 2048]])
    expect(f.headers[0]?.authorization).toBe('Bearer first-token')
    expect(f.headers[2]?.authorization).toBe('Bearer next-token')
    const changed = await f.host.submit(turn(a, 'Now B', 'second-turn-a'), { model: modelB })
    await f.host.settled(a, changed.activity_id!)
    expect(f.requests.at(-1)).toMatchObject({ model: 'model-b', reasoning_effort: 'high', max_tokens: 3000 })
    expect(JSON.stringify(await journal(f.context(), a))).not.toContain('rotated-token')
  }, 30000)

  it('preserves opaque input metadata across history/restart without model disclosure and dedupes semantic models', async () => {
    const f = await hostFixture((_request, response) => stream(response, [{ content: 'Seen.' }]))
    const id = await f.host.createSession()
    const metadata = { attachments: [{ path: 'uploads/notes.txt' }], selection: { revision: 'private-ui-revision', range: [1, 2] },
      originalInput: 'x'.repeat(200000) }
    const body = { ...turn(id, 'Read the attachment.', 'room:main:metadata'), metadata }
    const model = { ...f.options.ioAgent.model, reasoningEffort: 'low' as const }
    expect(await f.host.lookupTurn(id, body.turn_id)).toBeUndefined()
    await expect(f.host.submit({ ...body, metadata: 'x'.repeat(262145) }, { model })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const receipt = await f.host.submit(body, { model })
    await f.host.settled(id, receipt.activity_id!)
    expect((await f.host.history(id)).events.find(event => event.type === 'turn')).toMatchObject({ metadata })
    expect(JSON.stringify(f.requests)).not.toContain('private-ui-revision')
    const lookup = await f.host.lookupTurn(id, body.turn_id)
    expect(lookup).toEqual({ receipt: { ...receipt, duplicate: true }, metadata })
    expect(lookup).not.toHaveProperty('prompt')
    if (lookup !== undefined) lookup.metadata = null
    expect((await f.host.lookupTurn(id, body.turn_id))?.metadata).toEqual(metadata)
    await f.host.close()
    const reopened = await f.open()
    expect(await reopened.lookupTurn(id, body.turn_id)).toMatchObject({ receipt: { session_id: id, turn_id: body.turn_id, duplicate: true }, metadata })
    expect(await reopened.submit(body, { model })).toMatchObject({ duplicate: true })
    await expect(reopened.submit({ ...body, metadata: { different: true } }, { model })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    await expect(reopened.submit(body, { model: { ...model, reasoningEffort: 'high' } })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    expect(f.requests).toHaveLength(1)
  }, 30000)

  it.each([true, false])('dedupes steering across restart/successor (explicit target: %s) and fences cancellation', async (explicit) => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) { entered.resolve(); await release.promise; tool(response, 'read', { file_path: 'missing.txt' }) }
      else if (index === 2) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders() }
      else stream(response, [{ content: 'Seen.' }])
    })
    const id = await f.host.createSession()
    const body = turn(id, 'Begin.', 'room:main:first')
    const receipt = await f.host.submit(body)
    await entered.promise
    const steering = { session_id: id, ...(explicit ? { turn_id: body.turn_id } : {}), steer_id: 'room:main:steer', prompt: 'One unique hint.' }
    try {
      expect(await Promise.all([f.host.steer(steering), f.host.steer(steering)])).toEqual([{ accepted: true }, { accepted: true }])
      await expect(f.host.steer({ ...steering, prompt: 'Different' })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    } finally { release.resolve() }
    await f.host.settled(id, receipt.activity_id!)
    expect((await f.host.history(id)).events.filter(event => event.type === 'steered')).toHaveLength(1)
    expect((await journal(f.context(), id)).find(event => event.type === 'host/steer')?.data)
      .toMatchObject({ turnId: body.turn_id, activityId: receipt.activity_id })
    await f.host.close()
    const reopened = await f.open()
    expect(await reopened.steer(steering)).toEqual({ accepted: true })
    const second = await reopened.submit(turn(id, 'A successor', 'room:main:second'))
    await expect.poll(() => f.requests.length).toBe(3)
    expect(await reopened.steer(steering)).toEqual({ accepted: true })
    await expect(reopened.steer({ ...steering, turn_id: body.turn_id, steer_id: 'room:main:new-hint' }))
      .rejects.toMatchObject({ code: 'SESSION_IDLE' })
    expect((await journal(f.context(), id)).filter(event => event.type === 'host/steer')).toHaveLength(1)
    await reopened.cancelTurn(id, body.turn_id)
    expect(reopened.readActivity(id, second.activity_id!).status).toBe('running')
    await reopened.cancelTurn(id, second.turn_id)
    expect(reopened.readActivity(id, second.activity_id!)).toMatchObject({ status: 'settled', end: 'cancelled' })
    await reopened.cancelTurn(id, second.turn_id)
  }, 30000)

  it.each([false, true])('turn lookup waits for admission persistence and preserves its failure (%s)', async (fail) => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const f = await hostFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders()
    })
    const id = await f.host.createSession()
    const flush = f.context().sessionPersistence.flush.bind(f.context().sessionPersistence)
    const error = new Error('Admission persistence failed')
    const spy = vi.spyOn(f.context().sessionPersistence, 'flush').mockImplementationOnce(async () => {
      entered.resolve(); await release.promise
      if (fail) throw error
      await flush()
    })
    const body = { ...turn(id, 'Admit.', 'lookup-admission'), metadata: { request_digest: 'stable-request' } }
    const admitted = f.host.submit(body).then(receipt => receipt, cause => cause as Error)
    let completed = false
    try {
      await entered.promise
      const lookup = f.host.lookupTurn(id, body.turn_id).then(value => { completed = true; return value }, cause => {
        completed = true; return cause as Error
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      release.resolve()
      if (fail) {
        expect(await admitted).toBe(error)
        expect(await lookup).toBe(error)
        await expect(f.host.lookupTurn(id, body.turn_id)).rejects.toBe(error)
      } else {
        const receipt = await admitted
        expect(await lookup).toEqual({ receipt: { ...receipt, duplicate: true }, metadata: body.metadata })
      }
    } finally { release.resolve(); await admitted; spy.mockRestore() }
  }, 30000)

  it('does not retarget an untargeted steering while attachment admission waits', async () => {
    const f = await hostFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders()
    })
    const id = await f.host.createSession()
    const first = await f.host.submit(turn(id, 'First.', 'first-turn-race'))
    await expect.poll(() => f.requests.length).toBe(1)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const admit = f.context().attachments.admitPromptContent.bind(f.context().attachments)
    const spy = vi.spyOn(f.context().attachments, 'admitPromptContent').mockImplementationOnce(async parts => {
      entered.resolve(); await release.promise; return admit(parts)
    })
    const input = { session_id: id, steer_id: 'steering-race', prompt: [{ type: 'text', text: 'For the captured activity.' }] }
    const steering = f.host.steer(input).then(value => value, cause => cause as Error)
    try {
      await entered.promise
      await f.host.cancelTurn(id, first.turn_id)
      const successor = await f.host.submit(turn(id, 'Second.', 'second-turn-race'))
      await expect.poll(() => f.requests.length).toBe(2)
      release.resolve()
      expect(await steering).toMatchObject({ code: 'SESSION_IDLE' })
      expect((await journal(f.context(), id)).filter(event => event.type === 'host/steer')).toHaveLength(0)
      expect(await f.host.steer(input)).toEqual({ accepted: true })
      expect((await journal(f.context(), id)).find(event => event.type === 'host/steer')?.data)
        .toMatchObject({ turnId: successor.turn_id, activityId: successor.activity_id })
    } finally { release.resolve(); await steering; spy.mockRestore() }
  }, 30000)

  it('awaits exact pre/postimages before the model advances and preserves typed tool media in history', async () => {
    const snapshots: { change: HostFileChange; phase: string; text: string }[] = []
    let root = ''
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) tool(response, 'read', { file_path: 'notes.txt' }, 'read-notes')
      else if (index === 1) tool(response, 'edit', { file_path: 'notes.txt', old_string: 'before', new_string: 'after' }, 'same-call')
      else if (index === 2) {
        expect(snapshots.map(row => [row.phase, row.text])).toEqual([['before', 'before'], ['after', 'after']])
        await writeFile(join(root, 'notes.txt'), 'later outside change')
        tool(response, 'show_media', {}, 'media-call')
      } else stream(response, [{ content: 'Finished.' }])
    }, { configure(ctx) {
      ctx.tools.register(defineTool({ name: 'show_media', description: 'Show media.', parameters: {},
        output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'Available.' }] },
        async execute() { return {} },
        presentResult: () => ({ card: 'generic', image: { path: 'outputs/image.png' }, show: { path: 'notes.txt' } }),
      }))
    } }, {
      onFileChange: async change => { snapshots.push({ change, phase: 'before', text: await readFile(change.paths[0]!, 'utf8') }) },
      onFileChangeComplete: async change => {
        await new Promise(resolve => setImmediate(resolve))
        snapshots.push({ change, phase: 'after', text: await readFile(change.paths[0]!, 'utf8') })
      },
    })
    root = f.workspace
    await writeFile(join(root, 'notes.txt'), 'before')
    const id = await f.host.createSession()
    const { receipt } = await run(f.host, turn(id, 'Edit and show.'))
    expect(snapshots).toHaveLength(2)
    expect(snapshots.every(row => row.change.session_id === id && row.change.turn_id === receipt.turn_id && row.change.call_id === 'same-call')).toBe(true)
    expect(f.host.readSession(id, receipt.after).events.find(event => event.type === 'file_change'))
      .toMatchObject({ session_id: id, turn_id: receipt.turn_id, call_id: 'same-call', paths: [join(root, 'notes.txt')] })
    expect((await f.host.history(id)).events.find(event => event.type === 'tool_end' && event.call_id === 'media-call'))
      .toMatchObject({ image: { path: 'outputs/image.png' }, show: { path: 'notes.txt' } })
  }, 30000)

  it('captures postimages even when dispatch fails after writing', async () => {
    const completed: string[] = []
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'write', { file_path: 'changed.txt', content: 'written' }, 'write-then-fail')
      else stream(response, [{ content: 'The write completed but the wrapper failed.' }])
    }, { configure(ctx) {
      ctx.on('tools/execute', async (exec, next) => {
        const result = await next()
        if (exec.name === 'write') throw new Error('Failure after actual mutation')
        return result
      })
    } }, { onFileChangeComplete: async change => { completed.push(await readFile(change.paths[0]!, 'utf8')) } })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Write.'))
    expect(completed).toEqual(['written'])
    expect((await f.host.history(id)).events.find(event => event.type === 'tool_end')).toMatchObject({ ok: false })
  }, 30000)

  it('keeps identical tool call IDs in concurrent sessions attached to their own snapshots', async () => {
    const completed: HostFileChange[] = []
    const f = await hostFixture((request, response) => {
      if (request.messages.some(message => message.role === 'tool')) stream(response, [{ content: 'Written.' }])
      else tool(response, 'write', { file_path: JSON.stringify(request.messages).includes('write alpha') ? 'alpha.txt' : 'beta.txt', content: 'data' }, 'shared-call')
    }, {}, { onFileChangeComplete: async change => { await new Promise(resolve => setImmediate(resolve)); completed.push(change) } })
    const alpha = await f.host.createSession(), beta = await f.host.createSession()
    await Promise.all([run(f.host, turn(alpha, 'write alpha')), run(f.host, turn(beta, 'write beta'))])
    expect(completed).toHaveLength(2)
    expect(completed.find(change => change.session_id === alpha)).toMatchObject({ call_id: 'shared-call', paths: [join(f.workspace, 'alpha.txt')] })
    expect(completed.find(change => change.session_id === beta)).toMatchObject({ call_id: 'shared-call', paths: [join(f.workspace, 'beta.txt')] })
  }, 30000)
})
