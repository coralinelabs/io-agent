/** Context-bearing steering uses the turn input path and one durable host admission. */
import { describe, expect, it, vi } from 'vitest'
import { digest, steering, submission } from '../../../src/library/host/validation.ts'
import { responses, stream, tool } from './fixture.ts'
import { hostFixture, journal, turn } from './host-fixture.ts'

const LIVE_ONLY = new Set(['text', 'reasoning', 'interaction', 'interaction_closed', 'activity'])

describe('steering context and annotations', () => {
  it('uses the turn context and metadata limits, snapshots metadata and rejects malformed values', () => {
    const base = { session_id: 'session', prompt: 'A hint.' }
    const metadata = { selection: { path: 'file', line: 3 }, flags: [true, null] }
    const parsed = steering({ ...base, context: 'Context.', metadata })
    metadata.selection.line = 4
    expect(parsed.metadata).toMatchObject({ selection: { line: 3 } })
    expect(steering({ ...base, metadata: null }).metadata).toBeNull()
    const circular: Record<string, unknown> = {}; circular.self = circular
    for (const invalid of [undefined, { nope: undefined }, { nope: NaN }, { nope: 1n }, circular, 'x'.repeat(262144)]) {
      for (const parse of [steering, (value: unknown) => submission({ ...(value as object), turn_id: 'bounded-turn' })]) {
        expect(() => parse({ ...base, metadata: invalid })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      }
    }
    for (const context of ['', '   ', null, 123, 'é'.repeat(65537)]) {
      expect(() => steering({ ...base, context })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    }
    expect(steering({ ...base, context: 'x'.repeat(131072) }).context).toHaveLength(131072)
    expect(steering({ ...base, metadata: 'x'.repeat(262142) }).metadata).toHaveLength(262142)
  })

  it.each(['responses', 'chat-completions'] as const)('keeps context hidden, metadata durable and a concurrent retry unique on %s', async api => {
    const release = Promise.withResolvers<void>()
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) {
        await release.promise
        if (api === 'responses') responses(response, [{ type: 'function_call', id: 'fc', callId: 'look', name: 'read', arguments: JSON.stringify({ file_path: 'missing.txt' }) }])
        else tool(response, 'read', { file_path: 'missing.txt' }, 'look')
      } else if (api === 'responses') responses(response, [{ type: 'message', id: 'msg', text: 'Seen.' }])
      else stream(response, [{ content: 'Seen.' }])
    }, { model: { api: api === 'responses' ? undefined : api } })
    const id = await f.host.createSession()
    const body = { ...turn(id, 'Begin.', 'context-turn-one'), context: 'TURN_CONTEXT' }
    const receipt = await f.host.submit(body)
    await expect.poll(() => f.requests.length).toBe(1)
    const metadata = { request_digest: 'opaque-private-ui-marker', selection: { path: 'notes', line: 4 } }
    const input = { session_id: id, steer_id: 'context-steer-one', prompt: 'Check these lines.', context: 'STEER_CONTEXT', metadata }
    expect(await f.host.lookupSteer(id, input.steer_id)).toBeUndefined()
    try {
      expect(await Promise.all([f.host.steer(input), f.host.steer(input)])).toEqual([{ accepted: true }, { accepted: true }])
      for (const changed of [{ context: 'Other context.' }, { metadata: { different: true } }, { prompt: 'Different hint.' }]) {
        await expect(f.host.steer({ ...input, ...changed })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
      }
      const lookup = await f.host.lookupSteer(id, input.steer_id)
      expect(lookup).toEqual({ receipt: { accepted: true }, metadata })
      expect(lookup).not.toHaveProperty('prompt')
      if (lookup !== undefined) lookup.metadata = null
      expect((await f.host.lookupSteer(id, input.steer_id))?.metadata).toEqual(metadata)
    } finally { release.resolve() }
    await f.host.settled(id, receipt.activity_id!)
    const wire = JSON.stringify(f.requests[1])
    expect(wire).toContain('STEER_CONTEXT')
    expect(wire.indexOf('STEER_CONTEXT')).toBeLessThan(wire.indexOf('Check these lines.'))
    expect(JSON.stringify(f.requests)).not.toContain('opaque-private-ui-marker')
    const history = (await f.host.history(id)).events
    expect(history.filter(event => event.type === 'steered')).toEqual([expect.objectContaining({ input: { text: input.prompt, images: [] }, metadata, turn_id: body.turn_id })])
    expect(JSON.stringify(history)).not.toContain('STEER_CONTEXT')
    expect(f.host.readSession(id, receipt.after).events.filter(event => !LIVE_ONLY.has(event.type)).map(({ activity_id: _activity, ...event }) => event)).toEqual(history)
    const log = await journal(f.context(), id)
    const contexts = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'host')
    expect(contexts.map(event => event.type === 'user/message' && event.data.content)).toEqual([
      [{ type: 'text', text: 'TURN_CONTEXT' }], [{ type: 'text', text: 'STEER_CONTEXT' }]])
    expect(log.filter(event => event.type === 'host/steer')).toHaveLength(1)
    await f.host.close()
    const reopened = await f.open()
    expect(await reopened.lookupSteer(id, input.steer_id)).toEqual({ receipt: { accepted: true }, metadata })
    expect(await reopened.steer(input)).toEqual({ accepted: true })
    await expect(reopened.steer({ ...input, context: 'Changed after restart.' })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    await expect(reopened.steer({ ...input, metadata: null })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    expect((await reopened.history(id)).events).toEqual(history)
    expect(f.requests).toHaveLength(2)
  }, 30000)

  it('persists metadata for unkeyed steering against its exact message', async () => {
    const release = Promise.withResolvers<void>()
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) { await release.promise; tool(response, 'read', { file_path: 'missing.txt' }) }
      else stream(response, [{ content: 'Done.' }])
    })
    const id = await f.host.createSession(), receipt = await f.host.submit(turn(id, 'Begin.'))
    await expect.poll(() => f.requests.length).toBe(1)
    try {
      await f.host.steer({ session_id: id, prompt: 'First hint.', metadata: { order: 1 } })
      await f.host.steer({ session_id: id, prompt: 'Second hint.', metadata: { order: 2 } })
    } finally { release.resolve() }
    await f.host.settled(id, receipt.activity_id!)
    const history = (await f.host.history(id)).events
    expect(history.filter(event => event.type === 'steered').map(event => ({ input: event.input.text, metadata: event.metadata })))
      .toEqual([{ input: 'First hint.', metadata: { order: 1 } }, { input: 'Second hint.', metadata: { order: 2 } }])
    expect((await journal(f.context(), id)).filter(event => event.type === 'host/steer').every(event => event.data.steerId === undefined)).toBe(true)
    await f.host.close()
    const reopened = await f.open()
    expect((await reopened.history(id)).events).toEqual(history)
  }, 30000)

  it('preserves legacy plain-steer digests and lookup after restart', async () => {
    const f = await hostFixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders() })
    const id = await f.host.createSession(), receipt = await f.host.submit(turn(id, 'Begin.'))
    await expect.poll(() => f.requests.length).toBe(1)
    const input = { session_id: id, steer_id: 'legacy-steer-one', prompt: 'Old hint.' }
    await f.host.steer(input)
    const record = (await journal(f.context(), id)).find(event => event.type === 'host/steer')
    expect(record?.data.digest).toBe(digest({ prompt: input.prompt, turn_id: null }))
    expect(record?.data).not.toHaveProperty('metadata')
    await f.host.cancelTurn(id, receipt.turn_id); await f.host.close()
    const reopened = await f.open()
    expect(await reopened.lookupSteer(id, input.steer_id)).toEqual({ receipt: { accepted: true } })
    expect(await reopened.steer(input)).toEqual({ accepted: true })
  }, 30000)

  it.each([false, true])('lookup waits for steering persistence and retains its failure (%s)', async fail => {
    const f = await hostFixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders() })
    const id = await f.host.createSession()
    await f.host.submit(turn(id, 'Wait.'))
    await expect.poll(() => f.requests.length).toBe(1)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), failure = new Error('Steering persistence failed')
    const flush = f.context().sessionPersistence.flush.bind(f.context().sessionPersistence)
    const spy = vi.spyOn(f.context().sessionPersistence, 'flush').mockImplementationOnce(async () => {
      entered.resolve(); await release.promise
      if (fail) throw failure
      await flush()
    })
    const input = { session_id: id, steer_id: 'persist-steer-one', prompt: 'One hint.', metadata: { marker: true } }
    const admission = f.host.steer(input).then(value => value, cause => cause as Error)
    let completed = false
    try {
      await entered.promise
      const lookup = f.host.lookupSteer(id, input.steer_id).then(value => { completed = true; return value }, cause => { completed = true; return cause as Error })
      await new Promise(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      release.resolve()
      if (fail) {
        expect(await admission).toBe(failure); expect(await lookup).toBe(failure)
        await expect(f.host.lookupSteer(id, input.steer_id)).rejects.toBe(failure)
      } else {
        expect(await admission).toEqual({ accepted: true })
        expect(await lookup).toEqual({ receipt: { accepted: true }, metadata: input.metadata })
      }
    } finally { release.resolve(); await admission; spy.mockRestore() }
  }, 30000)

  it('lookup observes a failed in-flight admission without inventing a receipt', async () => {
    const f = await hostFixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders() })
    const id = await f.host.createSession(), receipt = await f.host.submit(turn(id, 'Wait.'))
    await expect.poll(() => f.requests.length).toBe(1)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const admit = f.context().attachments.admitPromptContent.bind(f.context().attachments)
    const spy = vi.spyOn(f.context().attachments, 'admitPromptContent').mockImplementationOnce(async parts => { entered.resolve(); await release.promise; return admit(parts) })
    const input = { session_id: id, steer_id: 'cancelled-admission', prompt: [{ type: 'text', text: 'A late hint.' }] }
    const admission = f.host.steer(input).then(value => value, cause => cause as Error)
    try {
      await entered.promise
      const lookup = f.host.lookupSteer(id, input.steer_id)
      await f.host.cancelTurn(id, receipt.turn_id)
      release.resolve()
      expect(await admission).toMatchObject({ code: 'SESSION_IDLE' })
      expect(await lookup).toBeUndefined()
      expect(await f.host.lookupSteer(id, input.steer_id)).toBeUndefined()
    } finally { release.resolve(); await admission; spy.mockRestore() }
  }, 30000)
})
