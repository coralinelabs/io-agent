/**
 * Pure rendering for the model-facing `recall` tool.
 *
 * Every function reads one immutable session cut (the events of a single
 * `sessionQuery.observeSession` lease) through the session-query package's
 * exported helpers: surface labels come from `buildSessionEventRecords`,
 * searchable text from `buildSessionEventSearchDocuments` and literal matching
 * from `filterSessionEventDocuments`. There is no second index and nothing here
 * writes to the journal.
 *
 * @module io-agent/tool-recall/render
 */

import { modelText } from "../../context/text/index.ts"
import { isCompactCheckpointSource } from "../../context/compaction/compaction/checkpoint.ts"
import { HarnessError } from "../../model/llm/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { SessionEvent, SessionId } from "../journal/index.ts"
import {
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
  compileSessionTextFilter,
  extractSessionEventText,
  filterSessionEventDocuments,
} from "../query/query/index.ts"
import type { SessionEventSearchDocument, SessionEventSearchHit, SessionEventSurface } from "../query/query/index.ts"

/** The tool's model-facing name; pointers in pruned stubs and checkpoints name it. */
export const RECALL_TOOL_NAME = 'recall'

/**
 * Output bounds: one call can never return more than about 16K characters; a
 * composition can also bound it in UTF-8 bytes ({@link RecallOutputLimits}).
 */
export const RECALL_LIMITS = Object.freeze({
  /** Code points of one event returned per call; the rest is paged with `offset`. */
  eventPagePoints: 16_000,
  /** Characters of one range listing before it asks to continue. */
  rangeBudgetChars: 12_000,
  /** Code points of each event's preview in a range listing. */
  rangePreviewPoints: 240,
  /** Characters kept on each side of the first match in a search snippet. */
  snippetRadius: 120,
  /** Search matches shown when the call gives no `limit`. */
  defaultMatches: 10,
  /** Largest accepted `limit`. */
  maxMatches: 30,
  /** Query terms considered; later ones are ignored. */
  maxTerms: 8,
})

/**
 * An optional byte bound on one recall result. The
 * composition passes the spill policy's per-result threshold, so a page of
 * multi-byte text is never spilled back to a preview: pages, range listings
 * and search listings stop at this many UTF-8 bytes. Offsets, totals and
 * continuations stay in code points.
 */
export interface RecallOutputLimits {
  /** UTF-8 bytes one result may occupy; unset, only the code-point and character bounds apply. */
  readonly maxOutputBytes?: number
}

/** UTF-8 bytes of one code point. */
function codePointBytes(point: string): number {
  const code = point.codePointAt(0)!
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

/** UTF-8 bytes of a string. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Stable error codes for a recall call the model can correct. */
export type RecallErrorCode =
  | 'RECALL_INVALID_REQUEST'
  | 'RECALL_EVENT_NOT_FOUND'
  | 'RECALL_EVENT_STRUCTURAL'
  | 'RECALL_NO_SESSION'

/** A model-correctable recall failure; the message is the model-facing text. */
export class RecallError extends HarnessError {
  constructor(message: string, code: RecallErrorCode) {
    super(message, code)
    this.name = 'RecallError'
  }
}

/** The raw tool arguments, already validated against the parameter schema. */
export interface RecallArguments {
  readonly seq?: number
  readonly offset?: number
  readonly from?: number
  readonly to?: number
  readonly query?: string
  readonly limit?: number
}

/** One validated recall request: exactly one mode. */
export type RecallRequest =
  | { readonly mode: 'event'; readonly seq: number; readonly offset: number }
  | { readonly mode: 'range'; readonly from?: number; readonly to?: number }
  | { readonly mode: 'search'; readonly query: string; readonly limit: number }

/**
 * Select the one mode a call asks for. A blank `query` counts as absent, and a
 * modifier of another mode (`offset` without `seq`, `limit` without `query`) is
 * ignored, so a model that fills parameters with defaults still gets its mode.
 * @param args - schema-validated tool arguments.
 * @returns the validated request.
 * @throws RecallError when zero or several modes are named.
 */
export function parseRecallRequest(args: RecallArguments): RecallRequest {
  const query = args.query?.trim() === '' ? undefined : args.query
  const event = args.seq !== undefined
  const range = args.from !== undefined || args.to !== undefined
  const search = query !== undefined
  if (Number(event) + Number(range) + Number(search) !== 1) {
    throw new RecallError(modelText('tools/recall/mode-required'), 'RECALL_INVALID_REQUEST')
  }
  if (event) return { mode: 'event', seq: args.seq!, offset: args.offset ?? 0 }
  if (range) return { mode: 'range', ...args.from === undefined ? {} : { from: args.from }, ...args.to === undefined ? {} : { to: args.to } }
  const limit = Math.min(RECALL_LIMITS.maxMatches, Math.max(1, args.limit ?? RECALL_LIMITS.defaultMatches))
  return { mode: 'search', query: query!, limit }
}

/**
 * Split a query into at most eight literal terms. Double-quoted phrases stay
 * whole; every other run of non-space characters is one term. Duplicates
 * (ignoring case) are dropped.
 * @param query - the model's query text.
 * @returns the ordered terms.
 * @throws RecallError when the query holds no term.
 */
export function splitRecallQuery(query: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/gu)) {
    const term = (match[1] ?? match[2] ?? '').replace(/^"+|"+$/gu, '').trim()
    const key = term.toLowerCase()
    if (term.length === 0 || seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length === RECALL_LIMITS.maxTerms) break
  }
  if (terms.length === 0) throw new RecallError(modelText('tools/recall/query-empty'), 'RECALL_INVALID_REQUEST')
  return terms
}

/**
 * A call's identity: the journal requires call ids to be unique only within
 * one step, and some providers reuse ids across steps (a constant `call_1`,
 * Kimi-style `functions.bash:0`).
 */
function callKey(data: { readonly turn: number; readonly step: number }, callId: string): string {
  return `${data.turn}:${data.step}:${callId}`
}

/** Tool names by call identity, from the `tool/call` events of the same cut. */
function toolNames(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) if (event.type === 'tool/call') names.set(callKey(event.data, event.data.callId), event.data.name)
  return names
}

function surfaceLabel(surface: SessionEventSurface): string {
  switch (surface) {
    case 'current': return modelText('tools/recall/surface-current')
    case 'shadowed': return modelText('tools/recall/surface-shadowed')
    default: return modelText('tools/recall/surface-log-only')
  }
}

/** The tool a `tool/call` or `tool/result` event belongs to, when known. */
function toolOf(event: SessionEvent, names: ReadonlyMap<string, string>): string | undefined {
  if (event.type === 'tool/call') return event.data.name
  if (event.type === 'tool/result') return names.get(callKey(event.data, event.data.message.source.callId))
  return undefined
}

/** `#seq type[ tool][, error] [surface]`: one event's identity line. */
function eventLabel(event: SessionEvent, surface: SessionEventSurface, names: ReadonlyMap<string, string>): string {
  const tool = toolOf(event, names)
  const failed = event.type === 'tool/result' && event.data.message.isError === true
  return `#${event.seq} ${event.type}${tool === undefined ? '' : ` ${tool}`}`
    + `${failed ? `, ${modelText('tools/recall/error')}` : ''} [${surfaceLabel(surface)}]`
}

/** Full text of a tool result: its text blocks, with media named rather than dropped. */
function toolResultText(event: SessionEvent<'tool/result'>): string {
  return event.data.message.content.map((block: ContentBlock) => {
    switch (block.type) {
      case 'text': return block.text
      case 'image': return modelText('tools/recall/image')
      case 'file': return modelText('tools/recall/file')
      default: return ''
    }
  }).filter(text => text.length > 0).join('\n')
}

/** Replacement and checkpoint hints: where the fuller text of a shortened event lives. */
function provenanceHint(event: SessionEvent, events: readonly SessionEvent[]): string | undefined {
  const op = event.surfaceOp
  const sources = event.sourceEventSeqs
  if (op === undefined || op === 'append' || sources === undefined || sources.length === 0) return undefined
  if (event.type === 'user/message' && isCompactCheckpointSource(event.data.source)) {
    // The checkpoint also cites its own compaction/start and summary records; only surface messages were condensed.
    const condensed = sources.filter((seq) => {
      const type = events[seq]?.type
      return type === 'user/message' || type === 'assistant/message' || type === 'tool/result' || type === 'system/message'
    })
    if (condensed.length === 0) return undefined
    const from = Math.min(...condensed)
    const to = Math.max(...condensed)
    return modelText('tools/recall/checkpoint', { from, to, pointer: modelText('tools/recall/pointer-range', { from, to }) })
  }
  if (sources.length !== 1) return undefined
  const source = sources[0]!
  return modelText('tools/recall/replaces', { source, pointer: modelText('tools/recall/pointer-seq', { seq: source }) })
}

/**
 * Render one event in full, paged at {@link RECALL_LIMITS.eventPagePoints} code
 * points, or fewer when `limits.maxOutputBytes` would be passed first (at least
 * one code point per page).
 * @param sessionId - session owning the cut.
 * @param events - the complete contiguous cut, indexed by seq.
 * @param seq - event to read.
 * @param offset - code-point offset to continue from.
 * @param limits - optional byte bound on the whole result.
 * @returns the event's identity line, provenance hint, and text page.
 * @throws RecallError for an absent event, a record with no readable text, or an offset past its end.
 */
export function renderRecallEvent(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  seq: number,
  offset = 0,
  limits: RecallOutputLimits = {},
): string {
  const last = events.length - 1
  const event = Number.isSafeInteger(seq) && seq >= 0 ? events[seq] : undefined
  if (event === undefined || event.seq !== seq) {
    throw new RecallError(modelText('tools/recall/event-missing', { seq, last }), 'RECALL_EVENT_NOT_FOUND')
  }
  let body = event.type === 'tool/result' ? toolResultText(event) : extractSessionEventText(event)
  if (body.length === 0) {
    if (event.type !== 'tool/result') {
      throw new RecallError(modelText('tools/recall/structural', { seq, type: event.type }), 'RECALL_EVENT_STRUCTURAL')
    }
    body = modelText('tools/recall/empty')
  }
  const points = Array.from(body)
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= points.length)) {
    throw new RecallError(modelText('tools/recall/offset-invalid', { seq, offset, length: points.length }), 'RECALL_INVALID_REQUEST')
  }
  const surface = buildSessionEventRecords(sessionId, events)[seq]?.surface ?? 'log-only'
  const header = [eventLabel(event, surface, toolNames(events))]
  const hint = provenanceHint(event, events)
  if (hint !== undefined) header.push(hint)
  const total = points.length
  const cap = Math.min(total, offset + RECALL_LIMITS.eventPagePoints)
  let end = cap
  if (limits.maxOutputBytes !== undefined) {
    // Reserve the page line and the continuation at their widest: every number in them is at most `total`.
    const reserved = utf8Bytes(header.join('\n')) + 2
      + utf8Bytes('\n' + modelText('tools/recall/page', { start: total, end: total, total }))
      + utf8Bytes('\n' + modelText('tools/recall/truncated', { remaining: total, seq, offset: total }))
    const room = limits.maxOutputBytes - reserved
    let used = 0
    end = offset
    while (end < cap) {
      const bytes = codePointBytes(points[end]!)
      if (end > offset && used + bytes > room) break
      used += bytes
      end += 1
    }
  }
  if (offset > 0 || end < points.length) {
    header.push(modelText('tools/recall/page', { start: offset, end, total: points.length }))
  }
  const page = points.slice(offset, end).join('')
  const more = end < points.length
    ? '\n' + modelText('tools/recall/truncated', { remaining: points.length - end, seq, offset: end })
    : ''
  return `${header.join('\n')}\n\n${page}${more}`
}

/** Collapse whitespace so one document renders as one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * List the readable events of a seq range, one line each, within
 * {@link RECALL_LIMITS.rangeBudgetChars} and, when set, `limits.maxOutputBytes`
 * (the continuation pointer included).
 * @param sessionId - session owning the cut.
 * @param events - the complete contiguous cut.
 * @param from - first seq (default 0).
 * @param to - last seq (default and cap: the last event).
 * @param limits - optional byte bound on the whole result.
 * @returns the listing, ending with a continuation pointer when it was cut.
 * @throws RecallError for a range outside the log.
 */
export function renderRecallRange(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  from?: number,
  to?: number,
  limits: RecallOutputLimits = {},
): string {
  const last = events.length - 1
  const start = from ?? 0
  const end = Math.min(to ?? last, last)
  if (last < 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > last || end < start) {
    throw new RecallError(modelText('tools/recall/range-invalid', { last: Math.max(last, 0) }), 'RECALL_INVALID_REQUEST')
  }
  const documents = filterSessionEventDocuments(buildSessionEventSearchDocuments(sessionId, events), [{ kind: 'seq', from: start, to: end }])
  if (documents.length === 0) return modelText('tools/recall/range-empty', { from: start, to: end })
  const names = toolNames(events)
  const lines: string[] = []
  let used = 0
  // The continuation at its widest (its `from` is at most `end`) always fits within the byte bound.
  const byteRoom = limits.maxOutputBytes === undefined ? Infinity
    : limits.maxOutputBytes - utf8Bytes('\n' + modelText('tools/recall/range-more', { from: end, to: end }))
  let usedBytes = 0
  for (const document of documents) {
    const points = Array.from(oneLine(document.text))
    const preview = points.slice(0, RECALL_LIMITS.rangePreviewPoints).join('')
    const rest = points.length - RECALL_LIMITS.rangePreviewPoints
    const line = `${eventLabel(events[document.seq]!, document.surface, names)}: ${preview}`
      + (rest > 0 ? ` ${modelText('tools/recall/more-chars', { count: rest })}` : '')
    const lineBytes = utf8Bytes(line) + (lines.length > 0 ? 1 : 0)
    if (lines.length > 0 && (used + line.length + 1 > RECALL_LIMITS.rangeBudgetChars || usedBytes + lineBytes > byteRoom)) {
      lines.push(modelText('tools/recall/range-more', { from: document.seq, to: end }))
      break
    }
    lines.push(line)
    used += line.length + 1
    usedBytes += lineBytes
  }
  return lines.join('\n')
}

/** Whether a user message is a runtime-context snapshot: superseded state, not history worth finding. */
function isContextSnapshot(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return source.kind === 'plugin' && source.form === 'snapshot'
}

/**
 * Searchable documents for recall: the session-query semantic documents minus
 * recall's own calls and results (so a search never finds itself), recall
 * tool-call blocks inside assistant messages, and runtime-context snapshots.
 * @param sessionId - session owning the cut.
 * @param events - the complete contiguous cut.
 * @returns documents in ascending seq order.
 */
export function recallDocuments(sessionId: SessionId, events: readonly SessionEvent[]): SessionEventSearchDocument[] {
  const recallCalls = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === RECALL_TOOL_NAME) recallCalls.add(callKey(event.data, event.data.callId))
  }
  return buildSessionEventSearchDocuments(sessionId, events).flatMap((document) => {
    const event = events[document.seq]!
    if (event.type === 'tool/call' && recallCalls.has(callKey(event.data, event.data.callId))) return []
    if (event.type === 'tool/result' && recallCalls.has(callKey(event.data, event.data.message.source.callId))) return []
    if (isContextSnapshot(event)) return []
    if (event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call' && block.name === RECALL_TOOL_NAME)) {
      const content = event.data.message.content.filter(block => !(block.type === 'tool-call' && block.name === RECALL_TOOL_NAME))
      const text = extractSessionEventText({ ...event, data: { ...event.data, message: { ...event.data.message, content } } })
      return text.length === 0 ? [] : [{ ...document, text }]
    }
    return [document]
  })
}

/** A window of the text around the earliest match of any term. */
function snippet(text: string, terms: readonly string[]): string {
  let index = -1
  let length = 0
  for (const term of terms) {
    const match = compileSessionTextFilter(term).exec(text)
    if (match !== null && (index < 0 || match.index < index)) {
      index = match.index
      length = match[0].length
    }
  }
  if (index < 0) return oneLine(text).slice(0, RECALL_LIMITS.snippetRadius * 2)
  let start = Math.max(0, index - RECALL_LIMITS.snippetRadius)
  let end = Math.min(text.length, index + length + RECALL_LIMITS.snippetRadius)
  // Never split a surrogate pair at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start -= 1
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end += 1
  return `${start > 0 ? '…' : ''}${oneLine(text.slice(start, end))}${end < text.length ? '…' : ''}`
}

/**
 * Keep listing lines in order while the whole listing stays within the byte
 * bound (at least one line).
 * @param lines - candidate lines, best first.
 * @param framing - UTF-8 bytes of the header and footer around them, their newlines included.
 * @param limits - optional byte bound on the whole result.
 * @returns the lines that fit.
 */
function fitLines(lines: readonly string[], framing: number, limits: RecallOutputLimits): string[] {
  if (limits.maxOutputBytes === undefined) return [...lines]
  const kept: string[] = []
  let used = framing
  for (const line of lines) {
    const bytes = utf8Bytes(line) + 1
    if (kept.length > 0 && used + bytes > limits.maxOutputBytes) break
    kept.push(line)
    used += bytes
  }
  return kept
}

/**
 * Literal search: every term must appear (case-insensitive,
 * whitespace-flexible), newest match first. Within `limits.maxOutputBytes`
 * fewer matches are shown, and the header's count says so.
 * @param sessionId - session owning the cut.
 * @param events - the complete contiguous cut.
 * @param query - the model's query.
 * @param limit - matches to show.
 * @param limits - optional byte bound on the whole result.
 * @returns the match listing, or the no-match line.
 */
export function searchRecallLiteral(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  query: string,
  limit: number,
  limits: RecallOutputLimits = {},
): string {
  const terms = splitRecallQuery(query)
  const matches = filterSessionEventDocuments(recallDocuments(sessionId, events), terms.map(text => ({ kind: 'text' as const, text })))
    .reverse()
  if (matches.length === 0) return modelText('tools/recall/no-matches', { query: JSON.stringify(query.trim()) })
  const names = toolNames(events)
  const footer = modelText('tools/recall/matches-footer')
  const widest = modelText('tools/recall/matches-header', { shown: matches.length, count: matches.length })
  const shown = fitLines(matches.slice(0, limit).map(document =>
    `${eventLabel(events[document.seq]!, document.surface, names)}: ${snippet(document.text, terms)}`),
  utf8Bytes(widest) + 1 + utf8Bytes(footer), limits)
  return [
    modelText('tools/recall/matches-header', { shown: shown.length, count: matches.length }),
    ...shown,
    footer,
  ].join('\n')
}

/**
 * Render ranked full-text hits with the literal search's line format and exclusions.
 * An assistant message that matched only through a recall call is dropped.
 * Within `limits.maxOutputBytes` fewer hits are shown.
 * @param sessionId - session owning the cut.
 * @param events - the complete contiguous cut, read before the search.
 * @param hits - ranked hits from `sessionQuery.searchEvents`.
 * @param query - the model's query.
 * @param limit - matches to show.
 * @param limits - optional byte bound on the whole result.
 * @returns the match listing, or the no-match line.
 */
export function renderRecallHits(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  hits: readonly SessionEventSearchHit[],
  query: string,
  limit: number,
  limits: RecallOutputLimits = {},
): string {
  const terms = splitRecallQuery(query)
  const documents = new Map(recallDocuments(sessionId, events).map(document => [document.seq as number, document]))
  const names = toolNames(events)
  const lines: string[] = []
  for (const hit of hits) {
    if (lines.length === limit) break
    const event = events[hit.seq]
    if (event === undefined) continue
    const document = documents.get(hit.seq)
    if (document === undefined) continue
    if (event.type === 'assistant/message' && document.text !== extractSessionEventText(event)
      && !terms.some(term => compileSessionTextFilter(term).test(document.text))) continue
    lines.push(`${eventLabel(event, hit.surface, names)}: ${oneLine(hit.snippet)}`)
  }
  if (lines.length === 0) return modelText('tools/recall/no-matches', { query: JSON.stringify(query.trim()) })
  const footer = modelText('tools/recall/matches-footer')
  const shown = fitLines(lines, utf8Bytes(modelText('tools/recall/ranked-header', { shown: lines.length })) + 1 + utf8Bytes(footer), limits)
  return [modelText('tools/recall/ranked-header', { shown: shown.length }), ...shown, footer].join('\n')
}
