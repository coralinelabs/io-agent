/**
 * Deterministic prefix-caching OpenAI-compatible provider.
 *
 * It caches like DeepSeek, GLM or Meta's automatic prefix cache: per
 * `prompt_cache_key`, the cached part of a request is the longest byte prefix
 * it shares with any earlier request under the same key (a prefix tree, so an
 * interleaved auxiliary call does not evict the main series), rounded down to
 * 64-token blocks with tokens approximated as bytes / 4. A request without a
 * key caches nothing, like the live Meta endpoint.
 *
 * The compared bytes are a canonical serialization of what a provider can
 * cache: one head unit (model, tools, tool choice and reasoning controls)
 * followed by one JSON unit per wire message (the system prompt is
 * messages[0]), joined by newlines. Sampling limits such as max_tokens are
 * not part of the cached prefix.
 */
import type { ServerResponse } from 'node:http'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgentOptions } from "../../../src/index.ts"
import { onFixtureCleanup, routerFixture } from './fixture.ts'
import type { Request, Usage } from './fixture.ts'

export const TOKEN_BYTES = 4
export const CACHE_BLOCK_TOKENS = 64

/** One observed request with its simulated cache accounting. */
export interface PrefixCacheRow {
  index: number
  key: string | undefined
  /** `purpose` of the matching model request (`agent`, `compaction`, …), in dispatch order. */
  purpose: string | undefined
  units: readonly string[]
  bytes: number
  promptTokens: number
  cachedTokens: number
  /** Longest common byte prefix with any earlier request under the same key. */
  lcp: number
}

/** Where one canonical request stops extending another. */
export interface PrefixDivergence {
  /** Byte length of the common prefix. */
  lcp: number
  /** Index of the first differing unit (0 = head, n = messages[n - 1]); -1 when the previous request is a prefix. */
  unit: number
  /** `head` or the wire role of the differing message. */
  role: string
  previous: string
  current: string
}

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

/** Canonical units of one wire request. */
export function canonicalUnits(request: Request): string[] {
  const head = JSON.stringify({
    model: request.model,
    tools: request.tools ?? [],
    tool_choice: request['tool_choice'] ?? null,
    reasoning_effort: request['reasoning_effort'] ?? null,
    chat_template_kwargs: request['chat_template_kwargs'] ?? null,
  })
  return [head, ...request.messages.map(message => JSON.stringify(message))]
}

function unitLcp(left: string, right: string): number {
  const a = encoder.encode(left), b = encoder.encode(right)
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * Compare two canonical requests unit by unit.
 * @returns the common byte prefix, and whether `previous` is wholly a prefix of `current`.
 */
export function comparePrefix(previous: readonly string[], current: readonly string[]): { lcp: number; extends: boolean; divergence?: PrefixDivergence } {
  let lcp = 0
  for (let i = 0; i < previous.length; i++) {
    const before = previous[i]!, after = current[i]
    if (after === before) {
      lcp += byteLength(before) + (i < previous.length - 1 ? 1 : 0)
      continue
    }
    const within = after === undefined ? 0 : unitLcp(before, after)
    const excerpt = (text: string | undefined): string => text === undefined ? '<missing>' : text.slice(Math.max(0, within - 20), within + 100)
    return {
      lcp: lcp + within,
      extends: false,
      divergence: {
        lcp: lcp + within,
        unit: i,
        role: i === 0 ? 'head' : String((JSON.parse(before) as { role?: unknown }).role),
        previous: excerpt(before),
        current: excerpt(after),
      },
    }
  }
  return { lcp, extends: true }
}

/** How one request's tool list and messages relate to the previous request's. */
export interface ToolAppend {
  /** Model, tool choice and reasoning controls are unchanged. */
  sameHeadFields: boolean
  /** The previous tool schemas open the current list, byte for byte and in order. */
  keepsTools: boolean
  /** Names of the tools after the previous list. */
  appended: string[]
  /** The messages (system prompt first) extend the previous ones byte for byte. */
  messagesExtend: boolean
  /** Common byte prefix in the fixture's tools-first layout. */
  lcp: number
  /** Where that prefix would end if nothing but the tool list grew: right after the previous list's last schema. */
  toolsEnd: number
  /** Common byte prefix with the system prompt first (OpenAI harmony, Qwen and DeepSeek templates). */
  systemFirstLcp: number
  /** Bytes of the system prompt and every previous tool schema: what a system-first layout keeps. */
  systemAndToolsEnd: number
}

/**
 * Compare a request whose tool set grew with the previous one.
 * @param previous - canonical units of the previous request.
 * @param current - canonical units of this request.
 * @returns what stayed, what was appended, and how far each layout's cached prefix reaches.
 */
export function compareToolAppend(previous: readonly string[], current: readonly string[]): ToolAppend {
  type Head = { model: unknown; tools: unknown[]; tool_choice: unknown; reasoning_effort: unknown; chat_template_kwargs: unknown }
  const before = JSON.parse(previous[0]!) as Head, after = JSON.parse(current[0]!) as Head
  const fields = (head: Head): string => JSON.stringify([head.model, head.tool_choice, head.reasoning_effort, head.chat_template_kwargs])
  const kept = after.tools.slice(0, before.tools.length)
  const toolsEnd = byteLength(JSON.stringify({ model: before.model, tools: before.tools }).slice(0, -2))
  const systemFirst = (units: readonly string[]): string[] => [units[1]!, units[0]!, ...units.slice(2)]
  return {
    sameHeadFields: fields(before) === fields(after),
    keepsTools: JSON.stringify(kept) === JSON.stringify(before.tools),
    appended: after.tools.slice(before.tools.length).map(tool => (tool as { function: { name: string } }).function.name),
    messagesExtend: comparePrefix(previous.slice(1), current.slice(1)).extends,
    lcp: comparePrefix(previous, current).lcp,
    toolsEnd,
    systemFirstLcp: comparePrefix(systemFirst(previous), systemFirst(current)).lcp,
    systemAndToolsEnd: byteLength(previous[1]!) + 1 + toolsEnd,
  }
}

export type PrefixCacheReply =(request: Request, response: ServerResponse, index: number, usage: Usage) => void | Promise<void>

/**
 * Boot io-agent against the prefix-caching provider.
 * @param reply - scripted responder; pass `usage` through to the stream helpers.
 * @param overrides - io-agent options; `model` fields merge over the fixture route
 *   (purposes are captured through `onModelRequest`).
 */
export async function prefixCacheFixture(reply: PrefixCacheReply,
  overrides: Partial<Omit<IoAgentOptions, 'model'>> & { model?: Partial<IoAgentOptions['model']> } = {}) {
  const rows: PrefixCacheRow[] = []
  const purposes: string[] = []
  const history = new Map<string, string[][]>()
  const { model, onModelRequest: observer, ...host } = overrides
  const base = await routerFixture(async (request, response, index) => {
    const key = typeof request['prompt_cache_key'] === 'string' ? request['prompt_cache_key'] : undefined
    const units = canonicalUnits(request)
    const bytes = units.reduce((total, unit) => total + byteLength(unit), 0) + units.length - 1
    const earlier = key === undefined ? [] : history.get(key) ?? []
    const lcp = earlier.reduce((best, previous) => Math.max(best, comparePrefix(previous, units).lcp), 0)
    if (key !== undefined) history.set(key, [...earlier, units])
    const promptTokens = Math.ceil(bytes / TOKEN_BYTES)
    const cachedTokens = Math.floor(Math.floor(lcp / TOKEN_BYTES) / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS
    rows.push({ index, key, purpose: purposes[index], units, bytes, promptTokens, cachedTokens, lcp })
    const completion = 12
    await reply(request, response, index, {
      prompt_tokens: promptTokens,
      completion_tokens: completion,
      total_tokens: promptTokens + completion,
      prompt_tokens_details: { cached_tokens: cachedTokens },
      prompt_cache_hit_tokens: cachedTokens,
      prompt_cache_miss_tokens: promptTokens - cachedTokens,
    })
  })
  const app = await createIoAgent({ workspace: base.workspace, stateDirectory: base.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
    ...host,
    model: { api: 'chat-completions', baseURL: base.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, ...model },
    onModelRequest: async (snapshot, signal) => {
      purposes.push(snapshot.purpose)
      await observer?.(snapshot, signal)
    },
  })
  onFixtureCleanup(() => app.close())
  return { ...base, app, rows, purposes }
}
