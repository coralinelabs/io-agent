import { createHash } from 'node:crypto'

/**
 * Where a profile's `prompt_cache_key` comes from. `session` sends one stable
 * key per harness session; `none` leaves the field to pi-ai (which only sends
 * one for api.openai.com).
 */
export type PromptCacheKeyMode = 'session' | 'none'

/**
 * One fixed-length key per session. Hashing rather than clamping: root session
 * ids are `<agent>-session-<uuid>`, and a 64-character clamp would drop the
 * uuid of a long agent id and make distinct sessions share one key. The raw id
 * never leaves the process. The `pluto-` prefix is from before io-agent; a new one would cost every open
 * session one prompt-cache miss.
 */
export function derivePromptCacheKey(sessionId: string): string {
  return 'pluto-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 40)
}

/** Only the cache-key field is set: never overwrite messages, tools, model, or budgets. */
export function applyPromptCacheKey(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('expected a provider request object')
  return { ...payload as Record<string, unknown>, prompt_cache_key: key }
}
