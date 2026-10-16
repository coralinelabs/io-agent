import { describe, expect, it } from 'vitest'
import { applyPromptCacheKey, derivePromptCacheKey } from "../../../src/library/model/pi-ai/prompt-cache-key.ts"

describe('per-session prompt cache key', () => {
  it('is stable for one session and distinct across sessions', () => {
    expect(derivePromptCacheKey('main-session-a')).toBe(derivePromptCacheKey('main-session-a'))
    expect(derivePromptCacheKey('main-session-a')).not.toBe(derivePromptCacheKey('main-session-b'))
  })
  it('fits the 64-character limit without truncating long ids into collisions', () => {
    const agent = 'a'.repeat(80)
    const first = derivePromptCacheKey(`${agent}-session-00000000-0000-4000-8000-000000000001`)
    const second = derivePromptCacheKey(`${agent}-session-00000000-0000-4000-8000-000000000002`)
    expect(first).not.toBe(second)
    for (const key of [first, second]) {
      expect(key).toMatch(/^pluto-[0-9a-f]{40}$/)
      expect(key.length).toBeLessThanOrEqual(64)
    }
  })
  it('does not expose the raw session id', () => {
    expect(derivePromptCacheKey('secret-agent-session-x')).not.toContain('secret')
  })
  it('only sets the cache key and never mutates the source payload', () => {
    const request = { model: 'chosen', messages: [{ role: 'user', content: 'task' }], prompt_cache_key: 'raw' }
    expect(applyPromptCacheKey(request, 'pluto-k')).toEqual({ ...request, prompt_cache_key: 'pluto-k' })
    expect(request.prompt_cache_key).toBe('raw')
  })
  it.each([null, [], 'text', 1])('rejects a non-object payload %#', payload => {
    expect(() => applyPromptCacheKey(payload, 'pluto-k')).toThrow('provider request object')
  })
})
