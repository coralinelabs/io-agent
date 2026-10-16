/** One incremental view of the actual model context, never a second history store.
 * Replacements/projections invalidate the view; ordinary log events do not. On an
 * append only new nodes are interpreted. Source attribution stays with the event,
 * while content always comes from the journal's registered message projections.
 */
import { modelText } from './text/index.ts'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Message } from '../model/llm/index.ts'
import type { Session, SessionEvent, SessionSeq, UserMessage } from '../session/journal/index.ts'

export interface VisibleMessage {
  readonly seq: SessionSeq
  readonly event: SessionEvent
  readonly message: Message
}
interface View {
  generation: number
  length: number
  messages: readonly VisibleMessage[]
  users: readonly UserMessage[]
  authored: readonly UserMessage[]
}
const views = new WeakMap<Session, View>()
// Immutable projected messages are the cache keys. Pruned content has no strong
// owner here; hashing a large tool result is not repeated on every model step.
const fingerprints = new WeakMap<Message, readonly string[]>()
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

function project(session: Session): View {
  // These getters also validate that projection definitions have not disappeared.
  const generation = session.surface.contentGeneration, nodes = session.surface.nodes
  const cached = views.get(session)
  const continuing = cached?.generation === generation && cached.length <= nodes.length
  if (continuing && cached.length === nodes.length) return cached
  const messages = continuing ? [...cached.messages] : []
  const users = continuing ? [...cached.users] : []
  const authored = continuing ? [...cached.authored] : []
  for (let i = continuing ? cached.length : 0; i < nodes.length; i++) {
    const seq = nodes[i]!, event = session.eventAt(seq)
    if (event === undefined) throw new Error(modelText('control/missing-context-event', { seq }))
    const message = session.deriveEventMessage(event) ?? (event.type === 'system/message' ? event.data.message : null)
    if (message === null) continue
    messages.push(Object.freeze({ seq, event, message }))
    if (message.role === 'user') users.push(message as UserMessage)
    // Producer metadata describes the authored body, not a summary/redaction
    // a later projection retained under the same source tag.
    if (event.type === 'user/message' && message.role === 'user'
      && isDeepStrictEqual(message.content, event.data.content)
      && isDeepStrictEqual(message.source, event.data.source)) authored.push(message as UserMessage)
  }
  const view = { generation, length: nodes.length, messages: Object.freeze(messages), users: Object.freeze(users), authored: Object.freeze(authored) }
  views.set(session, view)
  return view
}

/** Authored metadata is reliable only while its exact content/source remains visible. */
export function visibleAuthoredUserMessages(session: Session): readonly UserMessage[] { return project(session).authored }

/** Current projected messages in model order; no unprojected historical text. */
export function visibleMessages(session: Session): readonly VisibleMessage[] { return project(session).messages }
export function visibleUserMessages(session: Session): readonly UserMessage[] { return project(session).users }

function contentDigests(message: Message): readonly string[] {
  let values = fingerprints.get(message)
  if (values !== undefined) return values
  values = []
  if (message.role === 'tool') {
    values = message.isError ? [] : message.content.flatMap(block => block.type === 'text' ? [digest(block.text)] : [])
  } else if (message.role === 'user') {
    values = message.content.flatMap(block => block.type === 'text' ? [digest(block.text)] : [])
  }
  fingerprints.set(message, values)
  return values
}

/** Exact successful disclosure, with real source provenance and still-visible content. */
export function hasVisibleDisclosure(session: Session, tool: string, rendered: string): boolean {
  const wanted = digest(rendered)
  for (const { event, message } of visibleMessages(session)) {
    if (event.type === 'user/message' && message.role === 'user'
      && message.source.kind === 'skill-invocation' && tool === 'skill') {
      if (contentDigests(message).includes(wanted)) return true
    } else if (event.type === 'tool/result' && message.role === 'tool') {
      const call = event.sourceEventSeqs?.map(seq => session.eventAt(seq)).find(e => e?.type === 'tool/call')
      if (call?.type !== 'tool/call' || call.data.name !== tool) continue
      // A projection must not launder another call's result as this disclosure.
      if (message.toolCallId !== call.data.callId) continue
      if (contentDigests(message).includes(wanted)) return true
    }
  }
  return false
}

/** A visible tool result attributed to its originating call. */
export interface VisibleToolResult {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
  /** The call the result answers, found through any replacements. */
  readonly call: SessionEvent<'tool/call'>
  /** The result cites its call directly: the unreplaced original, not a pruned or projected replacement. */
  readonly original: boolean
  /** Whether a successful text block of the visible result is exactly `text`. */
  shows(text: string): boolean
}

const MAX_REPLACEMENT_HOPS = 16

/** Follow replacement results (which cite the result they replace) back to the call. */
function owningCall(session: Session, event: SessionEvent<'tool/result'>): { call: SessionEvent<'tool/call'>; original: boolean } | undefined {
  let current = event
  for (let hop = 0; hop < MAX_REPLACEMENT_HOPS; hop++) {
    const sources = current.sourceEventSeqs?.map(seq => session.eventAt(seq)) ?? []
    const call = sources.find(source => source?.type === 'tool/call')
    if (call?.type === 'tool/call') return { call, original: hop === 0 }
    const replaced = sources.find(source => source?.type === 'tool/result')
    if (replaced?.type !== 'tool/result') return undefined
    current = replaced
  }
  return undefined
}

/**
 * Visible results of one tool, newest first, attributed through replacements to
 * their call; like {@link hasVisibleDisclosure}, a projection that carries another
 * call's result is never attributed to this one.
 */
export function* visibleToolResultsNewestFirst(session: Session, tool: string): Generator<VisibleToolResult> {
  const messages = visibleMessages(session)
  for (let index = messages.length - 1; index >= 0; index--) {
    const { seq, event, message } = messages[index]!
    if (event.type !== 'tool/result' || message.role !== 'tool') continue
    const owner = owningCall(session, event)
    if (owner === undefined || owner.call.data.name !== tool) continue
    if (message.toolCallId !== owner.call.data.callId) continue
    yield { seq, event, call: owner.call, original: owner.original, shows: text => contentDigests(message).includes(digest(text)) }
  }
}

/** Latest instruction still visible, not merely one that was loaded in the past. */
export function latestVisibleUserMessage(session: Session, accepts: (message: UserMessage) => boolean): UserMessage | undefined {
  return visibleUserMessages(session).findLast(accepts)
}
