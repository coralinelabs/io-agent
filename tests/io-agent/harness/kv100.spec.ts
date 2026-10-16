import { describe, expect, it } from 'vitest'
import { resolveConnection } from '../../../src/library/model/connection.ts'
import { modelIdentity } from '../../../src/library/host/models.ts'
import { hostFixture, turn } from './host-fixture.ts'
import { responses } from './fixture.ts'

const defaults = { baseURL: 'http://localhost:8000/v1', model: 'served', contextWindow: 32768, maxTokens: 4096 }

describe('kv100 mode', () => {
  it('validates the option, turns the idle prune off and joins the model identity', () => {
    const on = resolveConnection({ ...defaults, kv100: true, promptCacheTtlMinutes: 60 })
    expect(on.profile.kv100).toBe(true)
    expect(on.promptCacheTtlMs).toBe(0)
    const off = resolveConnection(defaults)
    expect(off.profile).not.toHaveProperty('kv100')
    expect(off.promptCacheTtlMs).toBe(60 * 60_000)
    expect(resolveConnection({ ...defaults, kv100: false }).profile).not.toHaveProperty('kv100')
    expect(modelIdentity({ ...defaults, kv100: true })).not.toBe(modelIdentity(defaults))
    expect(() => resolveConnection({ ...defaults, kv100: 'yes' as unknown as boolean })).toThrow('kv100 must be a boolean')
    expect(() => resolveConnection({ ...defaults, kv100: true, api: 'chat-completions' })).toThrow("kv100 needs api 'responses'")
    expect(() => resolveConnection({ ...defaults, kv100: true, reasoningReplay: 'none' })).toThrow('reasoningReplay')
  })

  it('sends kv100: true on every request, and each request extends the previous one unchanged', async () => {
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) {
        responses(response, [
          { type: 'reasoning', id: 'rs_kv100', text: 'The file has to be read first.' },
          { type: 'function_call', id: 'fc_kv100', callId: 'call_kv100', name: 'read', arguments: JSON.stringify({ file_path: 'missing.txt' }) },
        ])
      } else responses(response, [{ type: 'message', id: `msg_kv100_${index}`, text: 'Finished.' }])
    }, { model: { api: 'responses', reasoningReplay: 'plain', kv100: true } })
    const session = await f.host.createSession()
    const receipt = await f.host.submit(turn(session, 'Read missing.txt and report.', 'kv100-first'))
    await f.host.settled(session, receipt.activity_id!)
    expect(f.requests.map(request => request['kv100'])).toEqual([true, true])
    const [first, second] = f.requests
    // Append-only: the tool continuation resends the first request's input as it was, the model's
    // own reasoning and call included, and only adds after it.
    const before = first!['input'] as unknown[], after = second!['input'] as unknown[]
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(second!['instructions']).toEqual(first!['instructions'])
    expect(JSON.stringify(after.slice(before.length))).toContain('The file has to be read first.')

    // Another session on a connection without kv100 sends no such parameter.
    const other = await f.host.createSession()
    const plain = await f.host.submit(turn(other, 'Say hello.', 'kv100-plain'), { model: { ...f.options.ioAgent.model, kv100: false } })
    await f.host.settled(other, plain.activity_id!)
    expect(f.requests.at(-1)).not.toHaveProperty('kv100')
  }, 30000)
})
