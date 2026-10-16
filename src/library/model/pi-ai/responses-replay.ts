/**
 * By-value history for the OpenAI Responses protocol under `store: false`.
 *
 * pi-ai replays a Responses assistant turn as its native output items, ids
 * included. With `store: false` the provider keeps nothing, so an id is a
 * reference to an item it cannot look up; Meta's endpoint also mints
 * composite reasoning ids (`rs_x:rs_y`). This rewrite sends each item by value
 * instead, as Hermes does (`agent/codex_responses_adapter.py`
 * `_replay_reasoning_items`, `_replay_message_items`,
 * `_replay_tool_call_items`), and drops what the provider rejects.
 *
 * Endpoints differ in what a reasoning item carries. OpenAI seals it
 * (`encrypted_content`); vLLM returns the text as `content` parts of type
 * `reasoning_text`, sends no encrypted content and refuses it on input. The
 * replay mode names which form the endpoint takes back.
 *
 * @module dsh-llm-pi-ai/responses-replay
 */

/**
 * Which form of a reasoning item goes back to the endpoint: `encrypted`
 * (summary plus encrypted content), `plain` (summary plus readable content),
 * or `none` (no reasoning at all).
 */
export type ReasoningReplayMode = 'encrypted' | 'plain' | 'none'

type Item = Record<string, unknown>

/** The `include` entry that asks the endpoint for sealed reasoning. */
const ENCRYPTED_REASONING_INCLUDE = 'reasoning.encrypted_content'

function isItem(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An item a reasoning item may precede: the assistant output it was produced with. */
function followsReasoning(item: unknown): boolean {
  return isItem(item) && (item['type'] === 'function_call' || (item['type'] === 'message' && item['role'] === 'assistant'))
}

/** An item pi-ai replays with the provider's id: the id goes, the content stays. */
function withoutId(item: Item): Item {
  const { id: _id, ...rest } = item
  return rest
}

/** The text parts of a list (`reasoning_text` content or `summary_text` summary), rebuilt with only their type and text. */
function textParts(value: unknown, type: string): Item[] {
  if (!Array.isArray(value)) return []
  return value.filter((part): part is Item => isItem(part) && part['type'] === type && typeof part['text'] === 'string')
    .map(part => ({ type, text: part['text'] }))
}

/** One reasoning item as the endpoint takes it back under `mode`, or undefined when it cannot be replayed. */
function replayedReasoning(item: Item, mode: ReasoningReplayMode, onPlainFallback?: () => void): Item | undefined {
  if (mode === 'none') return undefined
  const summary = Array.isArray(item['summary']) ? item['summary'] : []
  const content = textParts(item['content'], 'reasoning_text')
  if (mode === 'encrypted') {
    const encrypted = item['encrypted_content']
    if (typeof encrypted === 'string' && encrypted.length > 0) return { type: 'reasoning', summary, encrypted_content: encrypted }
    // An endpoint that returned readable reasoning and no sealed form (vLLM) takes it back as text;
    // dropping it would make the model plan its next step again from scratch.
    if (!content.some(part => part['text'] !== '')) return undefined
    onPlainFallback?.()
    return { type: 'reasoning', summary, content }
  }
  const hasText = [...content, ...textParts(summary, 'summary_text')].some(part => part['text'] !== '')
  return hasText ? { type: 'reasoning', summary, content } : undefined
}

/**
 * Rewrite a Responses request so every replayed item travels by value.
 *
 * - A reasoning item keeps `type` and `summary` plus, by `mode`, its
 *   `encrypted_content` (`encrypted`) or its `reasoning_text` content parts
 *   (`plain`); the id and status are dropped. Under `encrypted`, an item with
 *   reasoning text but no encrypted content (what vLLM returns) is replayed
 *   in the plain form and reported through `onPlainFallback`. An item with
 *   neither is dropped, and `none` drops every one.
 * - A run of reasoning items not followed by an assistant `message` or a
 *   `function_call` is dropped: that is what remains of a response cut off at
 *   its output limit whose calls were discarded, and the provider rejects
 *   reasoning without its following item.
 * - `function_call` and assistant `message` items lose their `id`.
 * - User, system and `function_call_output` items are unchanged.
 * - Outside `encrypted`, the request no longer asks for encrypted reasoning
 *   (`include: ['reasoning.encrypted_content']` is removed).
 *
 * The result is deterministic, so the same history serializes to the same
 * bytes on every request (prompt-cache prefix stability). The input is not
 * mutated.
 * @param payload - the request pi-ai built, before it is sent.
 * @param mode - which form of reasoning the endpoint takes back (default `encrypted`).
 * @param onPlainFallback - called for each reasoning item `encrypted` mode replays as plain text.
 * @returns the rewritten payload, or the payload itself when it is not a request object.
 */
export function toByValueResponsesInput(payload: unknown, mode: ReasoningReplayMode = 'encrypted', onPlainFallback?: () => void): unknown {
  if (!isItem(payload)) return payload
  const request = mode === 'encrypted' ? payload : withoutEncryptedInclude(payload)
  if (!Array.isArray(request['input'])) return request
  const input: unknown[] = []
  let reasoning: Item[] = []
  for (const item of request['input'] as unknown[]) {
    if (isItem(item) && item['type'] === 'reasoning') {
      const replayed = replayedReasoning(item, mode, onPlainFallback)
      if (replayed !== undefined) reasoning.push(replayed)
      continue
    }
    if (followsReasoning(item)) input.push(...reasoning)
    reasoning = []
    input.push(followsReasoning(item) ? withoutId(item as Item) : item)
  }
  return { ...request, input }
}

/** The request without its ask for encrypted reasoning; `include` goes when nothing else is in it. */
function withoutEncryptedInclude(payload: Item): Item {
  if (!Array.isArray(payload['include'])) return payload
  const { include, ...rest } = payload
  const kept = (include as unknown[]).filter(entry => entry !== ENCRYPTED_REASONING_INCLUDE)
  return kept.length === 0 ? rest : { ...rest, include: kept }
}
