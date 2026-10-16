/**
 * The one durable way to rewrite a current tool-result node's content: a
 * `compaction/prune` shadow-price event immediately followed by a
 * `tool/result` surface replacement that cites the shadowed node. It lives
 * with the module that declares `compaction/prune`, so both writers depend
 * downward on it: the pressure/idle tool-result pruner and the spill policy's
 * per-step budget land byte-identical journal shapes that replay derives the
 * same way, and neither imports the other. `recordedToolResult` follows such
 * a chain back to the result its call recorded, for the pruner's stub sizes
 * and the compaction checkpoint.
 *
 * @module io-agent/compaction/replace
 */

import { freezeMessage } from "../../../model/llm/index.ts"
import type { ContentBlock } from "../../../model/llm/index.ts"
import type { Session, SessionEvent, ToolResultMessage } from "../../../session/journal/index.ts"
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from './types.ts'

/**
 * The original append holding a tool result as its call recorded it: the node
 * itself when it is an append, else the end of its replacement chain. Every
 * replacement written here (a head/tail excerpt, a step-budget spill, a stub,
 * a skill marker) cites the node it shadowed first in `sourceEventSeqs`, so
 * the chain strictly descends and ends at the append.
 * @param session - session whose log holds the chain.
 * @param event - a current or shadowed `tool/result` node.
 * @returns the original append, or `undefined` only for a malformed chain.
 */
export function recordedToolResult(session: Session, event: SessionEvent<'tool/result'>): SessionEvent<'tool/result'> | undefined {
  let current = event
  while (current.surfaceOp !== 'append') {
    const shadowed = current.sourceEventSeqs?.[0]
    if (shadowed === undefined || shadowed >= current.seq) return undefined
    // A shadowed node is in no visible view and the journal has no other
    // synchronous reader: the same cited-event read hasVisibleDisclosure does.
    // oxlint-disable-next-line typescript/no-deprecated -- no non-deprecated reader of shadowed events exists.
    const source = session.eventAt(shadowed)
    if (source?.type !== 'tool/result') return undefined
    current = source
  }
  return current
}

/**
 * Replace one current `tool/result` surface node's content, preserving every
 * other field of the event data.
 *
 * Shadow-price protocol: the metering event and its replacement are appended
 * synchronously adjacent, so pure consumers subtract the shadowed node's
 * heuristic price without retaining per-node state.
 * @param session - session whose current surface holds `event`.
 * @param event - the current surface node being shadowed (an append or an earlier replacement).
 * @param original - the node's currently projected message (projections such as image offload retained).
 * @param content - replacement content for the native tool-result message.
 * @param shadowedTokenCount - heuristic price of `original`, logged on the shadow-price event.
 * @returns the appended replacement event.
 * @throws when the session rejects either append (for example, the node is no longer current).
 */
export function appendToolResultReplacement(
  session: Session,
  event: SessionEvent<'tool/result'>,
  original: ToolResultMessage,
  content: ContentBlock[],
  shadowedTokenCount: number,
): SessionEvent<'tool/result'> {
  const seq = event.seq
  const message = freezeMessage<ToolResultMessage>({
    ...original,
    content,
  })
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount,
  })
  return session.append('tool/result', {
    ...event.data,
    message,
  }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
}
