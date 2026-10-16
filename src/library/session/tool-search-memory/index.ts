/**
 * Model-facing, read-only `search_memory` tool: a literal search over every
 * conversation of the calling session's workspace, the model's reasoning
 * included, and a reader for one entry of any of them. It is the cross-session
 * counterpart of `recall`, which reads only the caller's own session.
 *
 * "Conversations" are the root sessions whose header names the caller's
 * workspace (`cwd`); delegated children and other workspaces sharing the state
 * directory are never searched or read. Each call observes the sessions it
 * scans and matches their semantic documents in memory, like `rg` over the
 * logs: no index, nothing written beyond the normal tool call and result.
 *
 * @module io-agent/tool-search-memory
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { SessionEvent, SessionId } from "../journal/index.ts"
import { SessionId as toSessionId } from "../journal/index.ts"
import type {} from "../query/query/index.ts"
import { compileSessionTextFilter, extractSessionEventText, filterSessionEventDocuments } from "../query/query/index.ts"
import type { SessionEventSearchDocument } from "../query/query/index.ts"
import { foldSessionTitle } from "../title/index.ts"
import { RecallError, recallDocuments, splitRecallQuery, RECALL_LIMITS } from "../tool-recall/index.ts"

export const name = 'tool-search-memory'
export const inject = ['tools', 'sessionQuery', 'agents']

/** The tool's model-facing name. */
export const SEARCH_MEMORY_TOOL_NAME = 'search_memory'

/** Output bounds of one call. */
export interface Config {
  /** UTF-8 bytes one result may occupy; a composition passes its spill threshold. Omitted, only the character bounds apply. */
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  maxOutputBytes: z.number().step(1).min(1),
})

/** One searchable entry: a semantic document, or the reasoning of an assistant message. */
interface MemoryDocument extends SessionEventSearchDocument {
  readonly reasoning?: true
}

/** One conversation's matches, newest entry first, each already rendered as its listing line. */
interface ConversationMatches {
  readonly id: SessionId
  readonly title: string | undefined
  readonly lastActive: number
  readonly lines: string[]
}

/** The validated request: a search (optionally within one conversation), or a read. */
type Request =
  | { readonly mode: 'search'; readonly query: string; readonly conversation?: string; readonly limit: number }
  | { readonly mode: 'read'; readonly conversation: string; readonly seq: number; readonly offset: number }

function parseRequest(args: { query?: string; conversation?: string; seq?: number; offset?: number; limit?: number }): Request {
  const query = args.query?.trim() === '' ? undefined : args.query
  const conversation = args.conversation?.trim() === '' ? undefined : args.conversation?.trim()
  if (args.seq !== undefined && conversation !== undefined && query === undefined) {
    return { mode: 'read', conversation, seq: args.seq, offset: args.offset ?? 0 }
  }
  if (query === undefined || args.seq !== undefined) {
    throw new RecallError(modelText('tools/search-memory/mode-required'), 'RECALL_INVALID_REQUEST')
  }
  const limit = Math.min(RECALL_LIMITS.maxMatches, Math.max(1, args.limit ?? RECALL_LIMITS.defaultMatches))
  return { mode: 'search', query, limit, ...conversation === undefined ? {} : { conversation } }
}

/** The reasoning text of an assistant message, joined. */
function reasoningText(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  return event.data.message.content.flatMap((block: ContentBlock) => block.type === 'reasoning' ? [block.text.trim()] : [])
    .filter(text => text.length > 0).join('\n')
}

/** A call's identity within its step (providers may reuse ids across steps). */
function callKey(data: { readonly turn: number; readonly step: number }, callId: string): string {
  return `${data.turn}:${data.step}:${callId}`
}

/**
 * The entries of one conversation: recall's documents (runtime snapshots and recall's own calls left out),
 * without this tool's own calls and results, plus one entry per assistant message's reasoning.
 */
function memoryDocuments(sessionId: SessionId, events: readonly SessionEvent[]): MemoryDocument[] {
  const own = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === SEARCH_MEMORY_TOOL_NAME) own.add(callKey(event.data, event.data.callId))
  }
  const documents: MemoryDocument[] = []
  for (const document of recallDocuments(sessionId, events)) {
    const event = events[document.seq]!
    if (event.type === 'tool/call' && own.has(callKey(event.data, event.data.callId))) continue
    if (event.type === 'tool/result' && own.has(callKey(event.data, event.data.message.source.callId))) continue
    if (event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call' && block.name === SEARCH_MEMORY_TOOL_NAME)) {
      const content = event.data.message.content.filter(block => !(block.type === 'tool-call' && block.name === SEARCH_MEMORY_TOOL_NAME))
      const text = extractSessionEventText({ ...event, data: { ...event.data, message: { ...event.data.message, content } } })
      if (text.length > 0) documents.push({ ...document, text })
      continue
    }
    documents.push(document)
  }
  for (const event of events) {
    const text = reasoningText(event)
    if (text.length > 0) {
      documents.push({ sessionId, seq: event.seq, type: event.type, time: event.time, surface: 'log-only', text, source: 'reasoning', reasoning: true })
    }
  }
  return documents.sort((a, b) => a.seq - b.seq || Number(a.reasoning === true) - Number(b.reasoning === true))
}

/** Collapse whitespace so one entry renders as one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
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
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start -= 1
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end += 1
  return `${start > 0 ? '…' : ''}${oneLine(text.slice(start, end))}${end < text.length ? '…' : ''}`
}

/** `#seq type[ tool][ reasoning]`: one entry's identity. */
function entryLabel(document: MemoryDocument, event: SessionEvent, tools: ReadonlyMap<string, string>): string {
  const tool = event.type === 'tool/call' ? event.data.name
    : event.type === 'tool/result' ? tools.get(callKey(event.data, event.data.message.source.callId)) : undefined
  return `#${document.seq} ${document.type}${tool === undefined ? '' : ` ${tool}`}${document.reasoning === true ? ` ${modelText('tools/search-memory/reasoning')}` : ''}`
}

function toolNames(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) if (event.type === 'tool/call') names.set(callKey(event.data, event.data.callId), event.data.name)
  return names
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/** Full text of one entry: a tool result's text, a message's text followed by its reasoning, or the event's semantic text. */
function entryText(event: SessionEvent): string {
  if (event.type === 'tool/result') {
    return event.data.message.content.flatMap((block: ContentBlock) => block.type === 'text' ? [block.text] : []).join('\n')
  }
  const text = extractSessionEventText(event)
  const reasoning = reasoningText(event)
  if (reasoning.length === 0) return text
  return `${text}${text.length > 0 ? '\n\n' : ''}[${modelText('tools/search-memory/reasoning')}]\n${reasoning}`
}

export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxOutputBytes
  /** Root conversations of one workspace, newest first. */
  const conversations = async (cwd: string | undefined, signal: AbortSignal) => (await ctx.sessionQuery.filterSessions(
    [{ kind: 'parent', values: [null] }, { kind: 'cwd', values: [cwd ?? null] }], signal)).map(record => record.header.id)

  ctx.tools.register(defineTool({
    name: SEARCH_MEMORY_TOOL_NAME,
    description: modelText('tools/search-memory/description'),
    parameters: {
      query: { type: 'string', description: modelText('tools/search-memory/query') },
      conversation: { type: 'string', description: modelText('tools/search-memory/conversation') },
      seq: { type: 'integer', description: modelText('tools/search-memory/seq') },
      offset: { type: 'integer', description: modelText('tools/search-memory/offset') },
      limit: { type: 'integer', description: modelText('tools/search-memory/limit') },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // Reads immutable cuts of stored conversations; it never mutates anything.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new RecallError(modelText('tools/search-memory/no-session'), 'RECALL_NO_SESSION')
      const request = parseRequest(args)
      // The caller's workspace bounds everything this call can see.
      const cwd = agent.session.header.cwd
      const ids = await conversations(cwd, exec.signal)
      const own = rootOf(ctx, agent.session.id) ?? agent.session.id
      if (request.mode === 'read' || request.conversation !== undefined) {
        const wanted = request.conversation
        if (!ids.some(id => String(id) === wanted)) {
          throw new RecallError(modelText('tools/search-memory/unknown-conversation', { conversation: JSON.stringify(wanted) }), 'RECALL_INVALID_REQUEST')
        }
      }
      if (request.mode === 'read') return await read(toSessionId(request.conversation), request.seq, request.offset, exec.signal)
      const terms = splitRecallQuery(request.query)
      const filters = terms.map(text => ({ kind: 'text' as const, text }))
      const found: ConversationMatches[] = []
      for (const id of request.conversation === undefined ? ids : [toSessionId(request.conversation)]) {
        exec.signal.throwIfAborted()
        using observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none', signal: exec.signal })
        const events = observation.events
        const matches = filterSessionEventDocuments(memoryDocuments(id, events), filters).reverse()
        if (matches.length === 0) continue
        // Keep only the rendered lines: a conversation's log is released before the next one is read.
        const tools = toolNames(events)
        found.push({ id, title: foldSessionTitle(events)?.title, lastActive: events.at(-1)?.time ?? observation.header.createdAt,
          lines: matches.map(match => `  ${entryLabel(match, events[match.seq]!, tools)}: ${snippet(match.text, terms)}`) })
      }
      const count = found.reduce((sum, conversation) => sum + conversation.lines.length, 0)
      if (count === 0) return modelText('tools/search-memory/no-matches', { query: JSON.stringify(request.query.trim()) })
      found.sort((a, b) => b.lastActive - a.lastActive)
      const footer = modelText('tools/search-memory/matches-footer')
      const widest = modelText('tools/search-memory/matches-header', { shown: count, count })
      let room = maxBytes === undefined ? Infinity : maxBytes - utf8Bytes(widest) - utf8Bytes(footer) - 2
      const lines: string[] = []
      let shown = 0
      for (const conversation of found) {
        if (shown === request.limit) break
        const heading = modelText('tools/search-memory/conversation-line', {
          conversation: String(conversation.id),
          title: conversation.title === undefined ? modelText('tools/search-memory/untitled') : JSON.stringify(conversation.title),
          date: day(conversation.lastActive),
          current: conversation.id === own ? modelText('tools/search-memory/this-conversation') : '',
        })
        const entries: string[] = []
        for (const line of conversation.lines) {
          if (shown + entries.length === request.limit) break
          const bytes = utf8Bytes(line) + 1 + (entries.length === 0 ? utf8Bytes(heading) + 1 : 0)
          if (shown + entries.length > 0 && bytes > room) break
          entries.push(line)
          room -= bytes
        }
        if (entries.length === 0) break
        lines.push(heading, ...entries)
        shown += entries.length
      }
      return [modelText('tools/search-memory/matches-header', { shown, count }), ...lines, footer].join('\n')
    },
  }))

  /** Read one entry of one conversation in full, paged like `recall seq=`. */
  async function read(conversation: SessionId, seq: number, offset: number, signal: AbortSignal): Promise<string> {
    using observation = await ctx.sessionQuery.observeSession(conversation, { projectionMode: 'none', signal })
    const events = observation.events
    const event = Number.isSafeInteger(seq) && seq >= 0 ? events[seq] : undefined
    const body = event === undefined || event.seq !== seq ? '' : entryText(event)
    if (event === undefined || body.length === 0) {
      throw new RecallError(modelText('tools/search-memory/entry-missing', { conversation: String(conversation), seq }), 'RECALL_EVENT_NOT_FOUND')
    }
    const points = Array.from(body)
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= points.length)) {
      throw new RecallError(modelText('tools/search-memory/offset-invalid', { offset, seq, length: points.length }), 'RECALL_INVALID_REQUEST')
    }
    const label = entryLabel({ sessionId: conversation, seq: event.seq, type: event.type, time: event.time, surface: 'log-only', text: body },
      event, toolNames(events))
    const total = points.length
    const header = [`conversation ${String(conversation)} ${label}`]
    let end = Math.min(total, offset + RECALL_LIMITS.eventPagePoints)
    if (maxBytes !== undefined) {
      const reserved = utf8Bytes(header[0]!) + 2
        + utf8Bytes('\n' + modelText('tools/recall/page', { start: total, end: total, total }))
        + utf8Bytes('\n' + modelText('tools/search-memory/truncated', { remaining: total, conversation: String(conversation), seq, offset: total }))
      let used = 0
      let cut = offset
      while (cut < end) {
        const bytes = utf8Bytes(points[cut]!)
        if (cut > offset && used + bytes > maxBytes - reserved) break
        used += bytes
        cut += 1
      }
      end = cut
    }
    if (offset > 0 || end < total) header.push(modelText('tools/recall/page', { start: offset, end, total }))
    const more = end < total
      ? '\n' + modelText('tools/search-memory/truncated', { remaining: total - end, conversation: String(conversation), seq, offset: end })
      : ''
    return `${header.join('\n')}\n\n${points.slice(offset, end).join('')}${more}`
  }
}

/** The root session a delegated child belongs to, by its recorded lineage. */
function rootOf(ctx: Context, id: SessionId): SessionId | undefined {
  let current = ctx.agents.get(id)
  for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
    const parent = current.session.header.parentSession
    if (parent === undefined) return current.session.id
    current = ctx.agents.get(parent)
  }
  return undefined
}
