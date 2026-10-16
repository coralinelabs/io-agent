import { SessionSeq } from '../session/journal/index.ts'
import { visibleMessages, latestVisibleUserMessage } from './visibility.ts'
import { modelText } from './text/index.ts'
/**
 * Durable projection state for the two loop-owned surface messages the system
 * prompt plugin forms: the system prompt (surface node 0 and any in-history
 * replacement) and the dynamic runtime-context snapshot.
 * @module io-agent/agent-loop/runtime-context
 */

import { createSystemMessage, createUserMessage } from "../model/llm/index.ts"
import type { ContextSnapshotSection, Message } from "../model/llm/index.ts"
import type { Session, SurfaceIntent, SystemMessage, UserMessage } from "../session/journal/index.ts"
import type { Context } from "../runtime/vendor/cordis/index.ts"

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = modelText('control/context-cleared')

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** One uncommitted system-prompt surface operation for request admission or reconciliation. */
export interface SystemPromptCommit {
  /** Rendered prompt or empty content: an empty head records no prompt; empty tails are dormant. */
  message: SystemMessage
  /** `append` for a new system node, otherwise a replacement of one surviving system node. */
  intent: SurfaceIntent<'system/message'>
}

/** The request-series facts one prompt decision is made under. */
export interface SystemPromptDecisionInput {
  /** Whether the prepared route for this attempt reads a later `system` message as the effective prompt. */
  inHistory: boolean
  /**
   * Whether this step's request starts a new model-message series: a pre-step
   * listener declared one, the surface was replaced since the last request, or
   * the assembled tool schemas differ from the logged header.
   */
  startsSeries: boolean
  /**
   * kv100: a continuing series never replaces a system node the previous
   * request sent. A changed prompt is appended where the route reads a later
   * `system` message, and otherwise waits for the next series (compaction).
   */
  appendOnly?: boolean
}

/**
 * A system-prompt message; a non-empty one records its sections. An empty
 * prompt records none, so providers are read afresh until a prompt appears.
 */
function prompt(text: string, sections: readonly ContextSnapshotSection[] | undefined): SystemMessage {
  return createSystemMessage(text, SOURCE, text.length === 0 ? undefined : sections)
}

/**
 * Decides how a rendered system prompt reaches the surface without owning the
 * commit. The first prompt, even empty, reserves surface node 0.
 * A capable continuing series appends changed nonempty text after the
 * cached history. An incapable route, broken series, or cleared prompt instead
 * normalizes the first system node and empties later active nodes. Dormant empty
 * tails do not supply effective text or require repeated replacements.
 * Under kv100 a continuing series never replaces: an incapable route or a
 * cleared prompt keeps the sent nodes until the next series.
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  /** The surviving `system/message` nodes in surface order. */
  private systemNodes(): { seq: SessionSeq; text: string | undefined }[] {
    return visibleMessages(this.session).flatMap(({ event, message, seq }) =>
      event.type === 'system/message' && message.role === 'system'
        ? [{ seq, text: message.content.length === 0 ? '' : textOf(message) }] : [])
  }

  /**
   * Reconcile effective text and retained nodes with the prepared route and series.
   * @param rendered - the fully rendered system prompt; `''` when none is active.
   * @param input - the route capability and series facts for this step.
   * @param sections - the named sections `rendered` joins; recorded on every
   *   committed prompt so {@link sessionPinnedSection} can keep them.
   * @returns ordered per-node updates; an empty list means no update is needed.
   */
  project(rendered: string, input: SystemPromptDecisionInput, sections?: readonly ContextSnapshotSection[]): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) {
      return [{ message: prompt(rendered, sections), intent: { surfaceOp: 'append' } }]
    }
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (input.appendOnly === true && !input.startsSeries
      && (!input.inHistory || rendered.length === 0 || latest.text === rendered)) return []
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '')
        .map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered, sections))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: prompt(rendered, sections), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string, sections?: readonly ContextSnapshotSection[]): SystemPromptCommit {
    return {
      message: prompt(text, sections),
      intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    }
  }
}

const recordedSections = new WeakMap<Message, ReadonlyMap<string, string>>()

/**
 * The sections recorded on the session's effective system prompt (the latest
 * non-empty system node, else the head), by name.
 * @param session - the session whose visible surface is read.
 * @returns the recorded sections, or `undefined` when there is no system node
 *   yet or it was committed without a record (before this change).
 */
export function headSections(session: Session): ReadonlyMap<string, string> | undefined {
  let head: Message | undefined
  let latest: Message | undefined
  for (const { event, message } of visibleMessages(session)) {
    if (event.type !== 'system/message' || message.role !== 'system') continue
    head ??= message
    if (message.content.length > 0) latest = message
  }
  const effective = latest ?? head
  if (effective === undefined) return undefined
  const cached = recordedSections.get(effective)
  if (cached !== undefined) return cached
  const source = effective.source
  if (source.kind !== 'plugin' || source.form !== 'snapshot') return undefined
  const sections = new Map(source.sections.map(section => [section.name, section.text]))
  recordedSections.set(effective, sections)
  return sections
}

/**
 * A system-prompt section's text as this session's prompt recorded it, so a
 * provider whose text arrives or changes after the prompt was built (an MCP
 * server connecting late, new text in a later process) never rewrites it;
 * the provider states the difference as runtime context instead.
 * @param session - the assembling agent's session; absent for diagnostics.
 * @param name - the section's registered name.
 * @param fallback - the provider's own text, used when there is no recorded prompt to follow.
 * @returns the recorded text; `''` when the recorded prompt has no such section;
 *   `fallback()` without a session or a recorded prompt.
 */
export function sessionPinnedSection(session: Session | undefined, name: string, fallback: () => string): string {
  const sections = session === undefined ? undefined : headSections(session)
  if (sections === undefined) return fallback()
  return sections.get(name) ?? ''
}

/** Runtime snapshot decisions use the same projected context as skill/instruction disclosure. */
export class RuntimeContextProjection {
  private existed = false

  constructor(ctx: Context, private readonly session: Session) {
    // Only restoration needs historical existence. No reversed copy of the log,
    // listener-owned retained-message mirror, or replacement-event bookkeeping.
    for (let seq: number = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined) break
      if (event.type === 'user/message' && isOwned(event.data)) { this.existed = true; break }
    }
    ctx.on('session/event', (subject, event) => {
      if (subject === session && event.type === 'user/message' && isOwned(event.data)) this.existed = true
    })
  }

  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    const retained = latestVisibleUserMessage(this.session, isOwned)
    if (!this.existed && retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (retained !== undefined && textOf(retained) === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: sections.length === 0
        ? { kind: 'plugin', plugin: SOURCE }
        : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
    })
  }
}
