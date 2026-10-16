/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from "../../util/brand/index.ts"
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from "../llm/index.ts"
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from "../llm/index.ts"
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { parseJsonWithRepair } from '@earendil-works/pi-ai/utils/json-parse'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'
import { transportFailureCode } from './transport.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai, and carried as its reported subset).
 *
 * Reported cache counts are always carried, zeros included, so a 0%
 * prompt-cache hit is journaled as `cacheReadTokens: 0` rather than as an
 * absent field. pi-ai substitutes 0 when a provider sends none of its cache
 * fields; io-agent's pi-ai patch marks that case (`cacheReadReported: false` on
 * the OpenAI routes), and it maps to absent cache counts with
 * `cacheReported: false`.
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total and the cache counts the provider reported.
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  const cacheReported = (usage as PiUsage & { cacheReadReported?: boolean }).cacheReadReported !== false
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...cacheReported
      ? { cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite }
      : { cacheReported: false as const },
    // A subset of output. pi-ai reports 0 both for a measured zero and for a provider that sends no
    // breakdown, so only a positive count is carried.
    ...usage.reasoning !== undefined && usage.reasoning > 0 && usage.reasoning <= usage.output ? { reasoningTokens: usage.reasoning } : {},
  }
}

/**
 * Whether a terminal pi-ai message carries usage the provider reported.
 * pi-ai starts every response at zero usage and overwrites it only when a
 * usage record arrives, so all-zero counts mean "none reported" (a real
 * completion always has output or total tokens).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns true when any token count is non-zero.
 */
export function usageReported(usage: PiUsage): boolean {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0
}

/**
 * Whether raw streamed tool-call arguments were cut off before their JSON
 * closed: strict parsing (with pi-ai's string-literal repair) fails and a
 * string, object or array is still open at the end. Closed but malformed
 * JSON (`{"a":1,}`) is not truncation and keeps pi-ai's repair path; empty
 * arguments are a no-argument call.
 * @param raw - the concatenated `toolcall_delta` text of one call.
 * @returns true when the arguments end inside an unclosed JSON value.
 */
export function argumentsTruncated(raw: string): boolean {
  if (raw.trim().length === 0) return false
  try {
    parseJsonWithRepair(raw)
    return false
  } catch {
    // fall through to the structural scan
  }
  let inString = false
  let escaped = false
  let depth = 0
  for (const char of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth++
    else if ((char === '}' || char === ']') && depth > 0) depth--
  }
  return inString || depth > 0
}

/** How {@link toStreamChunks} reads one route's terminal events. */
export interface StreamChunkOptions {
  /**
   * The route asked for usage on every stream (Chat Completions
   * `stream_options.include_usage`, declared explicitly by the profile).
   * Meta's endpoint signals output exhaustion as a usage-less stream with no
   * visible output (an empty or reasoning-only `stop`) or with a tool call
   * whose arguments are empty, never as `length`. Such a completion maps to
   * `max-tokens`, and no zero `usage` chunk is emitted for it. A usage-less
   * completion with visible text or complete calls stays what it says: an
   * endpoint that ignores `include_usage` must keep working.
   */
  usageExpected?: boolean
  /**
   * The output ceiling this request carried (or the model's own when it
   * carried none). Reported output at or above it is evidence that the
   * budget, not the endpoint's tool parser, cut a call's arguments.
   */
  maxTokens?: number
  /**
   * Codes of the transport failure the request's fetch observed (see
   * `transport.ts`); a timeout or transport code decides a terminal error's
   * code over the message patterns.
   */
  failureCodes?: () => readonly string[]
  /**
   * Appended to a 404 error's message: on the Responses route it names the
   * setting that switches an endpoint without `/responses` to Chat Completions.
   */
  notFoundHint?: string
}

/**
 * Whether a completion produced anything a reader or the tool layer can act
 * on: non-blank text or a tool call. Reasoning alone is not visible output.
 * @param message - the terminal pi-ai message.
 * @returns true when some text block is non-blank or a tool call exists.
 */
function visibleOutput(message: AssistantMessage): boolean {
  return message.content.some(block => block.type === 'toolCall' || (block.type === 'text' && block.text.trim().length > 0))
}

// The message is what pi-ai keeps of a caught error (it flattens the Error and
// its `cause` chain), so these patterns are the fallback: a transport failure
// the adapter's fetch observed is classified by its codes first (transport.ts,
// applied in toStreamChunks).
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
 *   to non-retryable `PI_AI_ERROR` failures.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Whether a completion that left tool-call arguments cut mid-JSON shows that
 * its output budget ran out: no usage was reported (Meta's exhaustion
 * signature, and pi-ai's own zero usage on a stream that never delivered
 * any), or the reported output reached the requested ceiling. A `length`
 * finish already maps to `max-tokens`. Reported usage below the ceiling means
 * the endpoint's tool parser, not the budget, left the JSON open.
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @param maxTokens - the request's output ceiling, when known.
 * @returns true when the cut is attributable to the output budget.
 */
export function budgetExhausted(usage: PiUsage, maxTokens: number | undefined): boolean {
  if (!usageReported(usage)) return true
  return maxTokens !== undefined && usage.output >= maxTokens
}

/**
 * Reclassify a completed response that ran out of output as `max-tokens`, so
 * none of its tool calls is dispatched (the assembler drops them) and the
 * loop's output-limit policy decides what follows. Context overflow and
 * terminal pi-ai failures keep precedence; an empty completion becomes
 * `max-tokens` only when it was cut off, not when it reported usage.
 * @param reason - the finish mapped from pi-ai's stop reason.
 * @param cutOff - truncated tool-call arguments, or the endpoint's usage-less exhaustion signature, were seen.
 * @returns the finish reason to emit.
 */
function outputLimited(reason: FinishReason, cutOff: boolean): FinishReason {
  if (!cutOff) return reason
  if (reason.kind === 'stop' || reason.kind === 'tool-calls') return { kind: 'max-tokens' }
  if (reason.kind === 'error' && reason.failure.code === EMPTY_RESPONSE_CODE) return { kind: 'max-tokens' }
  return reason
}

/**
 * Refine a terminal error with what the route knows beyond pi-ai's message: an
 * observed transport failure decides the code (context overflow keeps its own),
 * and a 404 gets the route's hint. Neither changes whether the error is retried
 * by anything but the code.
 * @param reason - the finish mapped from pi-ai's terminal error.
 * @param options - the route's observation and hint.
 * @returns the reason to emit.
 */
function refineFailure(reason: FinishReason, options: StreamChunkOptions): FinishReason {
  if (reason.kind !== 'error') return reason
  let failure = reason.failure
  const transport = transportFailureCode(options.failureCodes?.() ?? [])
  if (transport !== undefined && failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) failure = { ...failure, code: transport }
  if (options.notFoundHint !== undefined && /\(404\)/.test(failure.message)) {
    failure = { ...failure, message: `${failure.message}. ${options.notFoundHint}` }
  }
  return failure === reason.failure ? reason : { ...reason, failure }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity recorded for durable replay.
 * @param options - how this route reports output exhaustion.
 * @returns the harness chunks, ending with `usage` then `finish` (no `usage`
 *   for a completion read as cut off); a completion whose tool-call arguments
 *   were cut mid-JSON by its output budget (see {@link budgetExhausted}), or
 *   with no expected usage and no visible output or an empty-argument call,
 *   finishes `max-tokens`. Cut arguments without budget evidence keep their
 *   raw text and the mapped finish, so the tool layer rejects them as
 *   malformed; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
  options: StreamChunkOptions = {},
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()
  // Raw argument text per call: pi-ai drops its own buffer before
  // `toolcall_end` and hands back arguments its partial-JSON parser repaired.
  const rawArguments = new Map<number, string>()
  let truncatedArguments = false
  let emptyArguments = false

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        rawArguments.set(event.contentIndex, (rawArguments.get(event.contentIndex) ?? '') + event.delta)
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end': {
        const raw = rawArguments.get(event.contentIndex) ?? ''
        const truncated = argumentsTruncated(raw)
        if (truncated) truncatedArguments = true
        if (raw.trim().length === 0) emptyArguments = true
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string. Arguments cut mid-JSON keep their cut
            // text rather than pi-ai's repaired object: when the budget did
            // not end the response, the tool layer rejects that text as
            // malformed arguments instead of executing a partial call.
            arguments: truncated ? raw : JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      }
      case 'done': {
        const unreported = options.usageExpected === true && !usageReported(event.message.usage)
        const exhausted = unreported && (emptyArguments || !visibleOutput(event.message))
        const cutByBudget = truncatedArguments && budgetExhausted(event.message.usage, options.maxTokens)
        // No phantom zero-usage record for a cut-off completion.
        if (!exhausted) yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: outputLimited(mapStopReason(event.message, contextWindow), cutByBudget || exhausted),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      }
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: refineFailure(mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ), options),
        }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
