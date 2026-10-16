/** One OpenAI-compatible connection. Backend selection and serving policy belong to the host router. */
import type { PiAiProviderProfile } from "./pi-ai/config.ts"
import type { ReasoningReplayMode } from "./pi-ai/responses-replay.ts"
import { normalizeApiKey } from "./llm/api-key.ts"
import { LlmError } from "./llm/index.ts"
import { modelText } from "../context/text/index.ts"
import { snapshotRequestMetadata } from './request-metadata.ts'

export interface ModelConnection {
  /** API base including its prefix, for example https://router.example/v1. */
  baseURL: string
  /** Opaque model name/alias understood by the router; never interpreted as a provider. */
  model: string
  /** Non-secret routing annotations sent as metadata on every request of this connection,
   * including tool continuations and child agents. Snapshotted; at most 16 string entries,
   * keys 1-64 characters and values at most 512. Never put credentials here. */
  requestMetadata?: Readonly<Record<string, string>>
  /** Effective context capacity exposed by this route, used by the harness's context policy. */
  contextWindow: number
  /** Maximum output tokens per request, also bounds auxiliary model calls; with `outputCap: false`, only those. */
  maxTokens: number
  /**
   * Endpoint credential, sent as the bearer token: the key itself, or a
   * function returning the current key. The function is called once at
   * startup and before every model request, so a rotated key applies from the
   * next request on. The key lives only in memory: io-agent never reads one from
   * an environment variable, and any inherited environment entry holding it
   * (or one of the function's last four answers) is removed from every child
   * process io-agent starts (tools, MCP servers, workers). Omit it for an
   * endpoint without authentication.
   */
  apiKey?: string | (() => string | Promise<string>)
  input?: ('text' | 'image')[]
  timeoutMs?: number
  /**
   * Longest silence from the endpoint (default 300,000 ms): a request is ended
   * as failed when no byte arrives for this long. Any byte counts, including
   * the SSE comments a relay sends while the request waits upstream, so a
   * request that is queued or prefilling behind such a relay is never cut; only
   * a server that sends nothing at all is. An endpoint that streams nothing
   * while its model reasons hidden (some Chat Completions servers) is silent
   * for that long: raise this for it.
   */
  streamIdleTimeoutMs?: number
  /**
   * Reasoning effort sent with every request of the session (default
   * `'medium'`), including child agents, compaction and review, so the request
   * head stays constant. `false` sends no reasoning control, so the endpoint's
   * own default applies (measured `high` on Meta's Muse Spark endpoint); set it
   * for an endpoint or model that rejects `reasoning_effort`. `'none'` is not
   * accepted: the reference endpoint rejects it with HTTP 400.
   */
  reasoningEffort?: ReasoningEffort | false
  /**
   * Send one stable `prompt_cache_key` per session (default true). Some
   * endpoints, such as Meta's Model API, cache nothing without it; set false for
   * an endpoint that rejects the field.
   */
  promptCacheKey?: boolean
  /**
   * How long the endpoint keeps a prompt cache entry, in minutes. After a
   * session has had no model response for longer than this, its cache is
   * presumed cold, so old tool results are pruned before the next request at
   * no extra cache cost. Defaults to 60 (like ZCode's micro-compaction
   * trigger; also the one-hour marker TTL of `cacheRetention: 'long'` with
   * `cacheControlFormat: 'anthropic'`), and to 1440 with `cacheRetention:
   * 'long'` on the plain OpenAI-format route, which asks for
   * `prompt_cache_retention: '24h'`. Set it to the provider's real lifetime
   * when that is longer (DeepSeek's disk cache, for example): an idle prune
   * before the entry expires rewrites history the provider still has cached
   * and costs one full miss. `0` turns the idle prune off; pruning under
   * context pressure is unaffected. Integer from 0 to 10080 (one week).
   */
  promptCacheTtlMinutes?: number
  /**
   * Explicit prompt-cache markers, for gateways that cache only marked
   * prefixes (an Anthropic-format route behind an OpenAI-compatible gateway).
   * `'anthropic'` makes pi-ai mark the first system message, the last tool and
   * the last conversation message with `cache_control`. Omitted by default:
   * never enable it for implicit-prefix providers such as Meta, DeepSeek or
   * OpenAI, because the last-message marker moves on every request and turns
   * that message's string content into a one-part array, so the serialized
   * prefix stops matching the previous request's bytes.
   */
  cacheControlFormat?: 'anthropic'
  /**
   * Prompt-cache retention sent with every request (default `'short'`).
   * `'long'` asks for a one-hour marker TTL and `prompt_cache_retention: '24h'`;
   * it needs `promptCacheKey` because the retention request carries a cache
   * key. `'none'` sends no cache key and no markers. Always explicit, so the
   * ambient `PI_CACHE_RETENTION` variable never changes the request bytes.
   */
  cacheRetention?: 'short' | 'long' | 'none'
  /**
   * Wire protocol (default `'responses'`): OpenAI's Responses API
   * (`/responses`) with `store: false`. The reasoning effort goes out as
   * `reasoning.effort`, and the endpoint's reasoning items are replayed by
   * value on every later request of the session, including after a resume, as
   * `reasoningReplay` says. The same hashed per-session `prompt_cache_key` is
   * sent. A model or protocol change on resume drops the earlier reasoning
   * items with a logged warning, because they belong to the model that
   * produced them. `'chat-completions'` speaks `/chat/completions` instead;
   * `cacheControlFormat` applies to it only. The protocol names the route
   * (`pluto-responses` or `pluto`) that every `request/header` records, so a
   * session resumed on the other protocol logs a declared `route` prefix break.
   */
  api?: 'chat-completions' | 'responses'
  /**
   * How the Responses protocol replays the endpoint's reasoning items (default
   * `'encrypted'`); the Chat Completions protocol ignores it.
   * - `'encrypted'`: ask for `include: ['reasoning.encrypted_content']` and
   *   replay each item as its summary plus encrypted content. For endpoints
   *   that seal reasoning (OpenAI). An item with readable reasoning text but no
   *   encrypted content (vLLM's form) is replayed as `'plain'` would, with a
   *   one-time warning to configure `'plain'`; one with neither is dropped.
   * - `'plain'`: replay each item as its summary plus its readable `content`
   *   (`reasoning_text` parts), never `encrypted_content`, and ask for no
   *   encrypted content. For endpoints that return reasoning as text and
   *   refuse encrypted input (vLLM). An item with no reasoning text is dropped.
   * - `'none'`: replay no reasoning and ask for no encrypted content.
   */
  reasoningReplay?: ReasoningReplay
  /**
   * kv100 mode (default false): history is append-only by design, so the
   * endpoint can keep 100% of the previous request's KV cache. io-agent never
   * goes back to change what a request has sent: no tool-result prune (idle
   * or under context pressure) and no mid-series system prompt replacement.
   * A changed system prompt waits for the next compaction (the one planned
   * break) or a change of route; without pruning the context fills sooner, so
   * compaction comes more often. `promptCacheTtlMinutes` is ignored (no idle prune).
   * Every request carries the extra Responses parameter `kv100: true`, so
   * the serving side can tell. Needs `api: 'responses'` and a reasoning
   * replay other than `'none'`, since dropped reasoning would change what the
   * model generated. Recommended only for some hybrid models (see README).
   */
  kv100?: boolean
  /**
   * Send `maxTokens` as the output cap of the agents' requests (default true).
   * `false` sends no cap on them, so the endpoint's own limit (normally the
   * context left) applies and a long answer is never cut short by io-agent.
   * `maxTokens` still sizes the bounded auxiliary calls: compaction summaries
   * and the completion review.
   */
  outputCap?: boolean
}

/** How the Responses protocol replays reasoning items; see {@link ModelConnection.reasoningReplay}. */
export type ReasoningReplay = ReasoningReplayMode

/** An explicit reasoning effort; the OpenAI `reasoning_effort` spelling. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Every effort a connection may name, lowest first; also the wire spelling of each. */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

/**
 * Reasoning effort when a connection names none. On five SWE-bench-Live tasks
 * `medium` resolved all five like the endpoint default at 18% less cost and 21%
 * less wall time; `low` lost three.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

/** Default presumed prompt-cache lifetime, in minutes. */
export const DEFAULT_PROMPT_CACHE_TTL_MINUTES = 60
/** Presumed lifetime when the OpenAI-format route asks for `prompt_cache_retention: '24h'`, in minutes. */
export const LONG_RETENTION_PROMPT_CACHE_TTL_MINUTES = 1440
/** Longest accepted prompt-cache lifetime, in minutes (one week). */
const MAX_PROMPT_CACHE_TTL_MINUTES = 10_080

/**
 * The route of each wire protocol; one endpoint, so each replays the other's history. The values keep their
 * names from before io-agent: every session's `request/header` records them and replay matches on them.
 */
export const AGENT_ROUTES = ['pluto', 'pluto-responses'] as const

/** @internal Translation into the existing dsh adapter, not a public provider registry. */
export interface ResolvedConnection {
  /**
   * Provider route recorded in every `request/header`; one per wire protocol,
   * so a protocol switch is a declared route change, not an unexplained miss.
   */
  route: string
  model: string
  maxTokens: number
  /** Effective context capacity of the route, in tokens. */
  contextWindow: number
  /** Presumed prompt-cache lifetime in milliseconds; `0` disables the idle prune. */
  promptCacheTtlMs: number
  profile: PiAiProviderProfile
  /** The endpoint credential; absent for an anonymous endpoint. Functions only, so no field holds the key. */
  apiKey?: ConnectionKey
}

/** Resolved keys a function-supplied credential keeps withholding from child environments after rotation. */
export const RECENT_KEYS = 4

/** @internal The endpoint credential of one connection. */
export interface ConnectionKey {
  /** The key for one request: the fixed key, or the host function's current answer, validated. */
  resolve(): Promise<string>
  /**
   * Keys to withhold from child environments: the fixed key from the start, or the function's last
   * {@link RECENT_KEYS} distinct answers, so a rotated-out key that has not expired yet stays withheld.
   */
  recent(): readonly string[]
}

export function resolveConnection(options: ModelConnection): ResolvedConnection {
  const model = nonempty('model', options.model)
  const requestMetadata = options.requestMetadata === undefined ? undefined : snapshotRequestMetadata(options.requestMetadata)
  positiveInteger('contextWindow', options.contextWindow)
  positiveInteger('maxTokens', options.maxTokens)
  if (options.maxTokens >= options.contextWindow) throw new TypeError('maxTokens must be smaller than contextWindow')
  for (const name of ['timeoutMs', 'streamIdleTimeoutMs'] as const) {
    if (options[name] !== undefined) positiveInteger(name, options[name])
  }
  if (options.promptCacheKey !== undefined && typeof options.promptCacheKey !== 'boolean') {
    throw new TypeError('promptCacheKey must be a boolean')
  }
  if (options.cacheControlFormat !== undefined && options.cacheControlFormat !== 'anthropic') {
    throw new TypeError("cacheControlFormat must be 'anthropic' when set")
  }
  const cacheRetention = options.cacheRetention ?? 'short'
  if (!['short', 'long', 'none'].includes(cacheRetention)) {
    throw new TypeError("cacheRetention must be 'short', 'long' or 'none'")
  }
  // The idle prune must not fire while the retention this connection asks for still holds the entry.
  const ttlMinutes = options.promptCacheTtlMinutes
    ?? (cacheRetention === 'long' && options.cacheControlFormat === undefined
      ? LONG_RETENTION_PROMPT_CACHE_TTL_MINUTES
      : DEFAULT_PROMPT_CACHE_TTL_MINUTES)
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 0 || ttlMinutes > MAX_PROMPT_CACHE_TTL_MINUTES) {
    throw new TypeError(`promptCacheTtlMinutes must be an integer from 0 to ${MAX_PROMPT_CACHE_TTL_MINUTES}`)
  }
  // pi-ai sends the (clamped) raw session id as the key of a long-retention
  // request; only io-agent's hashed per-session key may replace it.
  if (cacheRetention === 'long' && options.promptCacheKey === false) {
    throw new TypeError("cacheRetention 'long' needs promptCacheKey; the raw session id must not be sent as the cache key")
  }
  const effort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  if (effort !== false && !REASONING_EFFORTS.includes(effort)) {
    throw new TypeError(`reasoningEffort must be false or one of ${REASONING_EFFORTS.map(level => `'${level}'`).join(', ')}`)
  }
  const api = options.api ?? 'responses'
  if (api !== 'chat-completions' && api !== 'responses') {
    throw new TypeError("api must be 'chat-completions' or 'responses'")
  }
  if (api === 'responses' && options.cacheControlFormat !== undefined) {
    throw new TypeError("cacheControlFormat applies to api 'chat-completions' only")
  }
  const reasoningReplay = options.reasoningReplay ?? 'encrypted'
  if (!['encrypted', 'plain', 'none'].includes(reasoningReplay)) {
    throw new TypeError("reasoningReplay must be 'encrypted', 'plain' or 'none'")
  }
  if (options.kv100 !== undefined && typeof options.kv100 !== 'boolean') {
    throw new TypeError('kv100 must be a boolean')
  }
  const kv100 = options.kv100 === true
  if (kv100 && api !== 'responses') throw new TypeError("kv100 needs api 'responses'")
  if (kv100 && reasoningReplay === 'none') {
    throw new TypeError("kv100 needs the model's reasoning replayed: reasoningReplay 'encrypted' or 'plain'")
  }
  if (options.outputCap !== undefined && typeof options.outputCap !== 'boolean') {
    throw new TypeError('outputCap must be a boolean')
  }
  if ('apiKeyEnv' in options) {
    throw new TypeError('apiKeyEnv was removed: pass apiKey, the key itself or a function returning it')
  }
  const apiKey = options.apiKey === undefined ? undefined : connectionKey(options.apiKey)
  const input = [...(options.input ?? ['text'])]
  const supportedInput = new Set<unknown>(['text', 'image'])
  if (!input.includes('text') || input.some(type => !supportedInput.has(type))) {
    throw new TypeError('input must include text and may include image')
  }
  return { route: api === 'responses' ? 'pluto-responses' : 'pluto', model, maxTokens: options.maxTokens, contextWindow: options.contextWindow,
    // kv100 never idle-prunes: the history a request sent stays as it was.
    promptCacheTtlMs: kv100 ? 0 : ttlMinutes * 60_000, ...apiKey === undefined ? {} : { apiKey }, profile: {
    api: api === 'responses' ? 'openai-responses' : 'openai-completions',
    displayName: 'Model endpoint',
    // Transient failures are retried for about 24 minutes (0.5 s doubling to a minute, 30 retries): long enough to
    // outlast an engine restart (5 minutes or more with its JIT build). Five retries over ~15 s, DeepSeek
    // Harness's default for a cloud API with a person watching, ended an unattended turn for good.
    retryPolicy: { mode: 'normal', maxRetries: 30, backoff: { initialDelayMs: 500, maxDelayMs: 60_000 } },
    ...(requestMetadata === undefined ? {} : { requestMetadata }),
    ...(kv100 ? { kv100: true } : {}),
    ...(options.outputCap === false ? { outputCap: false } : {}),
    baseURL: endpoint(options.baseURL),
    // Every level is declared with its own wire spelling, so `off` and `max`
    // are pinned unsupported and pi-ai can never send an off value ('none'),
    // on either protocol.
    models: [{ id: model, contextWindow: options.contextWindow, maxTokens: options.maxTokens, input,
      reasoningEfforts: effort === false ? false : Object.fromEntries(REASONING_EFFORTS.map(level => [level, level])) }],
    ...(effort === false ? {} : { reasoning: effort }),
    compat: api === 'responses'
      // Only switches the Responses protocol takes; pi-ai sends `store: false` itself.
      ? { supportsDeveloperRole: false, supportsStrictMode: false, supportsLongCacheRetention: cacheRetention === 'long' }
      // Use the inherited Chat Completions transport without backend-specific
      // request extensions; `reasoning_effort` is the standard OpenAI field.
      : { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false,
        supportsReasoningEffort: effort !== false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens',
        // Pinned, so the wire field is always `reasoning_effort`, never a
        // baseURL-detected `thinking` or `reasoning` object.
        ...(effort === false ? {} : { thinkingFormat: 'openai' as const }),
        // Long retention is sent only when this connection asks for it.
        supportsLongCacheRetention: cacheRetention === 'long',
        ...(options.cacheControlFormat === undefined ? {} : { cacheControlFormat: options.cacheControlFormat }) },
    // The inherited SDK needs a non-empty auth value even for an unauthenticated endpoint.
    ...(apiKey === undefined ? { headers: { Authorization: 'Bearer EMPTY' } } : {}),
    ...(api === 'responses' ? { reasoningReplay } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    promptCacheKey: options.promptCacheKey === false ? 'none' : 'session',
    // Explicit, so pi-ai never falls back to the ambient PI_CACHE_RETENTION.
    cacheRetention,
  } }
}

/** Hold the credential in closures: the fixed key is checked now, a function's answer on every request. */
function connectionKey(source: NonNullable<ModelConnection['apiKey']>): ConnectionKey {
  if (typeof source === 'string') {
    const checked = normalizeApiKey(source)
    if (!checked.ok) throw new TypeError('apiKey must be a non-empty HTTP token (printable ASCII, no spaces)')
    const fixed = [checked.value]
    return { resolve: () => Promise.resolve(checked.value), recent: () => fixed }
  }
  if (typeof source !== 'function') throw new TypeError('apiKey must be a string or a function returning one')
  let recent: readonly string[] = []
  return {
    async resolve() {
      let raw: unknown
      try { raw = await source() } catch (cause) {
        throw new LlmError(modelText('runtime/router/missing-key'), 'MISSING_CREDENTIAL', { cause })
      }
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw new LlmError(modelText('runtime/router/missing-key'), 'MISSING_CREDENTIAL')
      }
      const checked = normalizeApiKey(raw)
      if (!checked.ok) throw new LlmError(modelText('runtime/router/invalid-key'), 'INVALID_CREDENTIAL')
      if (recent[0] !== checked.value) recent = [checked.value, ...recent.filter(key => key !== checked.value)].slice(0, RECENT_KEYS)
      return checked.value
    },
    recent: () => recent,
  }
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}

export function nonempty(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string without surrounding whitespace`)
  }
  return value
}

function endpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError('baseURL must be an absolute HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('baseURL must be HTTP(S), without embedded credentials, query, or fragment')
  }
  return url.href.replace(/\/+$/, '')
}
