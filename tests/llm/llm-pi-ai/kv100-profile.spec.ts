import type { ConnectionProfiles } from './connection-fixture.ts'
/**
 * kv100 on a direct provider profile gets the same guard as ModelConnection: a Responses route that replays
 * the model's reasoning. Codex's review probe on b3faff2 (harness #230), inverted: a profile that would drop
 * the reasoning is refused where profiles resolve, and an accepted one keeps it on the wire beside kv100.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
const streamSimple = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-ai/api/openai-responses.lazy', () => ({
  openAIResponsesApi: () => ({ stream: streamSimple, streamSimple }),
}))
import { PiAiAdapter } from "../../../src/library/model/pi-ai/adapter.ts"
import { resolveProfiles } from "../../../src/library/model/pi-ai/config.ts"
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })
const route = { baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }] }

describe('kv100 provider profiles', () => {
  it('refuses a profile that would drop the reasoning or leave the Responses protocol', () => {
    for (const profile of [{ api: 'openai-responses', reasoningReplay: 'none' }, { api: 'openai-completions' }] as const) {
      const configuration = ({ providers: { 'local-gateway': { ...route, ...profile, kv100: true } } })
      expect(() => resolveProfiles(configuration.providers)).toThrow('kv100 needs api openai-responses and a reasoningReplay other than none')
    }
  })

  it('declares kv100 on the model and sends it beside the replayed reasoning', async () => {
    const configuration = ({ providers: { 'local-gateway': { ...route, api: 'openai-responses', reasoningReplay: 'plain', kv100: true } } })
    expect(() => resolveProfiles(configuration.providers)).not.toThrow()
    const adapter = new PiAiAdapter({ profiles: () => resolveProfiles(configuration.providers),
      resolveApiKey: () => Promise.resolve('dummy-only'), auth: memoryAuth() })
    expect((await adapter.resolveModel('local-gateway', 'local-model')).kv100).toBe(true)
    streamSimple.mockImplementation(() => { throw new Error('offline SDK interception') })
    for await (const _ of adapter.stream({ provider: 'local-gateway', model: 'local-model', messages: [] })) { /* drained */ }
    expect(streamSimple).toHaveBeenCalledOnce()
    const hook = streamSimple.mock.calls[0]![2].onPayload
    const result = hook({ input: [
      { role: 'user', content: 'Proceed' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Preserve this reasoning' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
    ] })
    expect(result.kv100).toBe(true)
    expect(JSON.stringify(result.input)).toContain('Preserve this reasoning')
  })
})
