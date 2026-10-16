import { describe, expect, it } from 'vitest'
import { resolveConnection } from "../../../src/library/model/connection.ts"
import type { ModelConnection } from "../../../src/library/model/connection.ts"
import * as publicAPI from "../../../src/index.ts"

describe('one OpenAI-compatible router connection', () => {
  const defaults = { baseURL: 'http://localhost:8000/v1/', model: 'served', contextWindow: 32768, maxTokens: 4096 }
  // The Chat Completions shape is pinned: the protocol default is Responses.
  const options = { ...defaults, api: 'chat-completions' as const }
  it('speaks the Responses protocol by default, replaying encrypted reasoning unless told otherwise', () => {
    const selected = resolveConnection(defaults)
    expect(selected.route).toBe('pluto-responses')
    expect(selected.profile).toMatchObject({ api: 'openai-responses', baseURL: 'http://localhost:8000/v1', reasoningReplay: 'encrypted' })
    for (const reasoningReplay of ['encrypted', 'plain', 'none'] as const) {
      expect(resolveConnection({ ...defaults, reasoningReplay }).profile.reasoningReplay).toBe(reasoningReplay)
    }
    // Chat Completions has no reasoning items to replay; the setting does not reach its profile.
    expect(resolveConnection({ ...options, reasoningReplay: 'plain' }).profile).not.toHaveProperty('reasoningReplay')
    for (const reasoningReplay of ['sealed', '', 'PLAIN', true]) {
      expect(() => resolveConnection({ ...defaults, reasoningReplay: reasoningReplay as unknown as 'plain' })).toThrow('reasoningReplay')
    }
  })
  it('uses an explicit endpoint and capacities, without selecting a backend', () => {
    const selected = resolveConnection(options)
    expect(selected.route).toBe('pluto')
    expect(selected.profile).toMatchObject({ api: 'openai-completions', baseURL: 'http://localhost:8000/v1',
      headers: { Authorization: 'Bearer EMPTY' }, models: [{ id: 'served', contextWindow: 32768, maxTokens: 4096, input: ['text'] }],
      compat: { supportsDeveloperRole: false, supportsStrictMode: false, supportsStore: false } })
    expect(selected.profile.requestTemplateKwargs).toBeUndefined()
  })
  it.each([0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid capacities %s', value => {
    expect(() => resolveConnection({ ...options, contextWindow: value })).toThrow()
    expect(() => resolveConnection({ ...options, maxTokens: value })).toThrow()
  })
  it('rejects an output budget that leaves no input capacity', () => {
    expect(() => resolveConnection({ ...options, maxTokens: 32768 })).toThrow('smaller')
  })
  it.each(['no-url', 'file:///tmp/x', 'https://user:secret@example.org/v1', 'https://example.org/v1?key=x', 'https://example.org/v1#x'])('rejects unsafe endpoint %s', baseURL => {
    expect(() => resolveConnection({ ...options, baseURL })).toThrow('baseURL')
  })
  it('keeps model aliases opaque even when they contain a provider name', () => {
    for (const model of ['anthropic/example', 'openrouter/example', 'vllm/example']) {
      const selected = resolveConnection({ ...options, model })
      expect(selected.route).toBe('pluto')
      expect(selected.profile.api).toBe('openai-completions')
      expect(selected.profile.baseURL).toBe('http://localhost:8000/v1')
      expect(selected.model).toBe(model)
    }
  })
  it('takes the key by value, holding it only in functions, never in a serializable field', async () => {
    const selected = resolveConnection({ ...options, apiKey: '  sk-value-key  ' })
    expect(selected.profile.headers).toBeUndefined()
    expect(selected.profile).not.toHaveProperty('apiKeyEnv')
    expect(await selected.apiKey?.resolve()).toBe('sk-value-key')
    expect(selected.apiKey?.recent()).toEqual(['sk-value-key'])
    expect(JSON.stringify(selected)).not.toContain('sk-value-key')
    for (const apiKey of ['', '   ', 'bad key', 'bad\nkey', 42]) {
      expect(() => resolveConnection({ ...options, apiKey: apiKey as unknown as string })).toThrow('apiKey')
    }
  })
  it('calls a key function on every resolution, so a rotated key applies to the next request', async () => {
    let key = 'first-key'
    const selected = resolveConnection({ ...options, apiKey: async () => key })
    expect(selected.apiKey?.recent()).toEqual([])
    expect(await selected.apiKey?.resolve()).toBe('first-key')
    key = 'second-key'
    expect(selected.apiKey?.recent()).toEqual(['first-key'])
    expect(await selected.apiKey?.resolve()).toBe('second-key')
    // A rotated-out key may still be valid, so it stays withheld for the next few rotations.
    expect(selected.apiKey?.recent()).toEqual(['second-key', 'first-key'])
    expect(await selected.apiKey?.resolve()).toBe('second-key')
    expect(selected.apiKey?.recent()).toEqual(['second-key', 'first-key'])
    for (const next of ['third-key', 'fourth-key', 'fifth-key']) { key = next; await selected.apiKey?.resolve() }
    expect(selected.apiKey?.recent()).toEqual(['fifth-key', 'fourth-key', 'third-key', 'second-key'])
    for (const answer of [() => '', () => undefined, () => { throw new Error('vault down') }]) {
      await expect(resolveConnection({ ...options, apiKey: answer as () => string }).apiKey?.resolve()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    }
    await expect(resolveConnection({ ...options, apiKey: () => 'bad key' }).apiKey?.resolve()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })
  it('has no credential for an anonymous endpoint and refuses the removed environment-variable reference', () => {
    const anonymous = resolveConnection(options)
    expect(anonymous.apiKey).toBeUndefined()
    expect(anonymous.profile.headers).toEqual({ Authorization: 'Bearer EMPTY' })
    expect(() => resolveConnection({ ...options, apiKeyEnv: 'IO_AGENT_API_KEY' } as unknown as typeof options)).toThrow('apiKeyEnv was removed')
  })
  it('snapshots model capabilities rather than accepting subsequent mutation', () => {
    const input: ModelConnection['input'] = ['text', 'image']
    const selected = resolveConnection({ ...options, input })
    input.pop()
    expect(selected.profile.models?.[0]?.input).toEqual(['text', 'image'])
  })
  it('validates optional transport deadlines and modalities', () => {
    expect(() => resolveConnection({ ...options, timeoutMs: 0 })).toThrow('timeoutMs')
    expect(() => resolveConnection({ ...options, streamIdleTimeoutMs: -1 })).toThrow('streamIdleTimeoutMs')
    expect(() => resolveConnection({ ...options, input: [] })).toThrow('input')
    expect(resolveConnection({ ...options, timeoutMs: 10000, streamIdleTimeoutMs: 2000 }).profile)
      .toMatchObject({ timeoutMs: 10000, streamIdleTimeoutMs: 2000 })
  })
  it('sends a per-session prompt cache key by default and lets a connection turn it off', () => {
    expect(resolveConnection(options).profile.promptCacheKey).toBe('session')
    expect(resolveConnection({ ...options, promptCacheKey: true }).profile.promptCacheKey).toBe('session')
    expect(resolveConnection({ ...options, promptCacheKey: false }).profile.promptCacheKey).toBe('none')
    expect(() => resolveConnection({ ...options, promptCacheKey: 'yes' as unknown as boolean })).toThrow('promptCacheKey')
  })
  it('presumes a 60-minute prompt-cache lifetime for the idle prune, validated and switchable off', () => {
    expect(resolveConnection(options)).toMatchObject({ contextWindow: 32768, promptCacheTtlMs: 60 * 60_000 })
    expect(resolveConnection({ ...options, promptCacheTtlMinutes: 5 }).promptCacheTtlMs).toBe(5 * 60_000)
    expect(resolveConnection({ ...options, promptCacheTtlMinutes: 0 }).promptCacheTtlMs).toBe(0)
    expect(resolveConnection({ ...options, promptCacheTtlMinutes: 10080 }).promptCacheTtlMs).toBe(10080 * 60_000)
    for (const value of [-1, 1.5, 10081, Number.NaN, '60' as unknown as number]) {
      expect(() => resolveConnection({ ...options, promptCacheTtlMinutes: value })).toThrow('promptCacheTtlMinutes')
    }
  })
  it('derives the presumed lifetime from the retention it asks for, unless the host sets one', () => {
    // prompt_cache_retention: '24h' on the OpenAI-format route keeps entries a day.
    expect(resolveConnection({ ...options, cacheRetention: 'long' }).promptCacheTtlMs).toBe(1440 * 60_000)
    // Anthropic-format markers ask for a one-hour TTL.
    expect(resolveConnection({ ...options, cacheRetention: 'long', cacheControlFormat: 'anthropic' }).promptCacheTtlMs).toBe(60 * 60_000)
    for (const cacheRetention of ['short', 'none'] as const) {
      expect(resolveConnection({ ...options, cacheRetention }).promptCacheTtlMs).toBe(60 * 60_000)
    }
    expect(resolveConnection({ ...options, cacheRetention: 'long', promptCacheTtlMinutes: 90 }).promptCacheTtlMs).toBe(90 * 60_000)
    expect(resolveConnection({ ...options, cacheRetention: 'long', promptCacheTtlMinutes: 0 }).promptCacheTtlMs).toBe(0)
  })
  it('always sends an explicit cache retention and offers opt-in cache markers', () => {
    const plain = resolveConnection(options).profile
    expect(plain.cacheRetention).toBe('short')
    expect(plain.compat).toMatchObject({ supportsLongCacheRetention: false })
    expect(plain.compat).not.toHaveProperty('cacheControlFormat')
    const marked = resolveConnection({ ...options, cacheControlFormat: 'anthropic', cacheRetention: 'long' }).profile
    expect(marked.cacheRetention).toBe('long')
    expect(marked.compat).toMatchObject({ cacheControlFormat: 'anthropic', supportsLongCacheRetention: true })
    expect(marked.promptCacheKey).toBe('session')
    expect(resolveConnection({ ...options, cacheRetention: 'none' }).profile.cacheRetention).toBe('none')
  })
  it('rejects unknown cache settings and a long retention without the hashed session key', () => {
    expect(() => resolveConnection({ ...options, cacheControlFormat: 'openai' as unknown as 'anthropic' })).toThrow('cacheControlFormat')
    expect(() => resolveConnection({ ...options, cacheRetention: '24h' as unknown as 'long' })).toThrow('cacheRetention')
    expect(() => resolveConnection({ ...options, cacheRetention: 'long', promptCacheKey: false })).toThrow('raw session id')
    expect(resolveConnection({ ...options, cacheRetention: 'short', promptCacheKey: false }).profile.promptCacheKey).toBe('none')
  })
  it("declares every reasoning effort and sends 'medium' by default", () => {
    const profile = resolveConnection(options).profile
    expect(profile.reasoning).toBe('medium')
    expect(profile.models?.[0]?.reasoningEfforts).toEqual({ minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' })
    expect(profile.compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: 'openai' })
    for (const reasoningEffort of ['minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      const selected = resolveConnection({ ...options, reasoningEffort }).profile
      expect(selected.reasoning).toBe(reasoningEffort)
      expect(selected.compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: 'openai' })
    }
  })
  it('sends no reasoning control when the connection sets reasoningEffort false', () => {
    const profile = resolveConnection({ ...options, reasoningEffort: false }).profile
    expect(profile.models?.[0]?.reasoningEfforts).toBe(false)
    expect(profile).not.toHaveProperty('reasoning')
    expect(profile.compat).toMatchObject({ supportsReasoningEffort: false })
    expect(profile.compat).not.toHaveProperty('thinkingFormat')
  })
  it.each(['none', 'off', 'max', true, 'MEDIUM', ''])('rejects reasoning effort %s', (reasoningEffort) => {
    expect(() => resolveConnection({ ...options, reasoningEffort: reasoningEffort as unknown as 'medium' })).toThrow('reasoningEffort')
  })
  it("opts into the Responses protocol with its own compat switches, the same efforts and the same session key", () => {
    const profile = resolveConnection({ ...options, api: 'responses' }).profile
    expect(profile).toMatchObject({ api: 'openai-responses', reasoning: 'medium', promptCacheKey: 'session', cacheRetention: 'short',
      models: [{ id: 'served', reasoningEfforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } }] })
    expect(profile.compat).toEqual({ supportsDeveloperRole: false, supportsStrictMode: false, supportsLongCacheRetention: false })
    expect(resolveConnection({ ...options, api: 'responses', cacheRetention: 'long' }).profile.compat).toMatchObject({ supportsLongCacheRetention: true })
    const off = resolveConnection({ ...options, api: 'responses', reasoningEffort: false }).profile
    expect(off.models?.[0]?.reasoningEfforts).toBe(false)
    expect(off).not.toHaveProperty('reasoning')
    expect(resolveConnection({ ...options, api: 'chat-completions' }).profile.api).toBe('openai-completions')
  })
  it('rejects an unknown api and chat-only cache markers on the Responses protocol', () => {
    expect(() => resolveConnection({ ...options, api: 'completions' as unknown as 'responses' })).toThrow('api')
    expect(() => resolveConnection({ ...options, api: 'responses', cacheControlFormat: 'anthropic' })).toThrow('cacheControlFormat')
  })
  it('does not expose a provider registry, vLLM helper, or OpenRouter helper', () => {
    for (const name of ['vllm', 'openRouter', 'provider']) expect(publicAPI).not.toHaveProperty(name)
  })
})
