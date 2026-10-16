import { describe, expect, it } from 'vitest'
import { resolveConnection } from '../../../src/library/model/connection.ts'
import { modelIdentity } from '../../../src/library/host/models.ts'
import { applyRequestMetadata, snapshotRequestMetadata } from '../../../src/library/model/request-metadata.ts'
import { hostFixture, turn } from './host-fixture.ts'
import { responses, stream, tool } from './fixture.ts'

const defaults = { baseURL: 'http://localhost:8000/v1', model: 'served', contextWindow: 32768, maxTokens: 4096 }

describe('generic connection request metadata', () => {
  it('validates, snapshots and includes annotations in semantic model identity', () => {
    const input = { route_tier: 'private' }
    const selected = resolveConnection({ ...defaults, requestMetadata: input })
    const identity = modelIdentity({ ...defaults, requestMetadata: input })
    input.route_tier = 'extended'
    expect(selected.profile.requestMetadata).toEqual({ route_tier: 'private' })
    expect(Object.isFrozen(selected.profile.requestMetadata)).toBe(true)
    expect(modelIdentity({ ...defaults, requestMetadata: input })).not.toBe(identity)
    const empty = resolveConnection(defaults)
    expect(empty.profile).not.toHaveProperty('requestMetadata')
    for (const value of [null, [], 'private', { x: 1 }, { '': 'x' }, { ['x'.repeat(65)]: 'x' },
      { x: 'x'.repeat(513) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i), 'x'])),
      { get x() { throw new Error('must not execute accessor') } }]) {
      expect(() => snapshotRequestMetadata(value)).toThrow('requestMetadata')
    }
    expect(snapshotRequestMetadata({ ['x'.repeat(64)]: 'v'.repeat(512) })).toEqual({ ['x'.repeat(64)]: 'v'.repeat(512) })
    const original = { metadata: { transport: 'kept', route_tier: 'old' }, model: 'served' }
    expect(applyRequestMetadata(original, { route_tier: 'private' })).toEqual({
      metadata: { transport: 'kept', route_tier: 'private' }, model: 'served',
    })
    expect(original.metadata.route_tier).toBe('old')
  })

  it.each(['responses', 'chat-completions'] as const)('keeps %s annotations isolated across concurrent sessions, tool steps, retries and restart', async api => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) {
        entered.resolve(); await release.promise
        if (api === 'responses') responses(response, [{ type: 'function_call', id: 'fc_metadata', callId: 'call_metadata', name: 'read', arguments: JSON.stringify({ file_path: 'missing.txt' }) }])
        else tool(response, 'read', { file_path: 'missing.txt' }, 'call_metadata')
      } else if (api === 'responses') responses(response, [{ type: 'message', id: `msg_metadata_${index}`, text: 'Finished.' }])
      else stream(response, [{ content: 'Finished.' }])
    }, { model: { api } })
    const a = await f.host.createSession(), b = await f.host.createSession()
    const annotation = { route_tier: 'private' }
    const privateModel = { ...f.options.ioAgent.model, requestMetadata: annotation }
    const extendedModel = { ...f.options.ioAgent.model, requestMetadata: { route_tier: 'extended' } }
    const body = turn(a, 'Run the first task.', 'metadata-first')
    const receipt = await f.host.submit(body, { model: privateModel })
    await entered.promise
    try {
      annotation.route_tier = 'mutated-after-admission'
      const other = await f.host.submit(turn(b, 'Run concurrently.'), { model: extendedModel })
      await f.host.settled(b, other.activity_id!)
      await expect(f.host.submit(body, { model: extendedModel })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
      expect(await f.host.submit(body, { model: { ...privateModel, requestMetadata: { route_tier: 'private' } } })).toMatchObject({ duplicate: true })
    } finally { release.resolve() }
    await f.host.settled(a, receipt.activity_id!)
    expect(f.requests.map(request => request['metadata'])).toEqual([
      { route_tier: 'private' }, { route_tier: 'extended' }, { route_tier: 'private' },
    ])
    const next = await f.host.submit(turn(a, 'Switch this session.', 'metadata-next'), { model: extendedModel })
    await f.host.settled(a, next.activity_id!)
    expect(f.requests.at(-1)?.['metadata']).toEqual({ route_tier: 'extended' })
    const plain = await f.host.submit(turn(a, 'Use an unannotated connection.', 'metadata-plain'), { model: f.options.ioAgent.model })
    await f.host.settled(a, plain.activity_id!)
    expect(f.requests.at(-1)?.['metadata']).toBeUndefined()
    await f.host.close()
    const reopened = await f.open()
    expect(await reopened.submit(body, { model: { ...privateModel, requestMetadata: { route_tier: 'private' } } })).toMatchObject({ duplicate: true })
    await expect(reopened.submit(body, { model: extendedModel })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    expect(f.requests).toHaveLength(5)
    const resumed = await reopened.submit(turn(a, 'Continue after restart.', 'metadata-resumed'), { model: extendedModel })
    await reopened.settled(a, resumed.activity_id!)
    expect(f.requests.at(-1)?.['metadata']).toEqual({ route_tier: 'extended' })
  }, 30000)
})
