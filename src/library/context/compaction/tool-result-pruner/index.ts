/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module io-agent/compaction-tool-result-pruner
 */

import { Context, Service } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import type { ContentBlock } from "../../../model/llm/index.ts"
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from "../../../session/journal/index.ts"
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from "../compaction/index.ts"
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from "../../../model/token-meter/index.ts"
import { visibleMessages } from "../../visibility.ts"
import { appendToolResultReplacement, recordedToolResult } from "../compaction/replace.ts"
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import { removedSkillNames, renderSkillRemovedMarker, renderToolResultStub } from './stub.ts'
import type {
  PruneKind,
  PrunedEntry,
  PruneResult,
  PruneRetentionPolicy,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
export { describeCallArguments, removedSkillNames, renderSkillRemovedMarker, renderToolResultStub } from './stub.ts'
export type { ToolResultStubInput } from './stub.ts'
export type {
  PruneKind,
  PruneRetentionPolicy,
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultFormats,
  ToolResultPruneConfig,
} from './types.ts'

declare module "../../../runtime/vendor/cordis/index.ts" {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

/** The model's call for a result, read from the visible assistant message that issued it. */
interface VisibleCall {
  readonly name: string
  readonly argumentsJson: string
}

interface SnapshotCandidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
  /** The node's currently projected message (projections such as image offload applied). */
  readonly original: ToolResultMessage
  /** The call this result answers, or `undefined` when its issuing message is not visible. */
  readonly call: VisibleCall | undefined
}

/**
 * Key of one call within the step that issued it. The journal requires call
 * ids to be unique within a step only; models and OpenAI-compatible servers
 * reuse them across steps (a constant `call_1`, Kimi-style `functions.bash:0`),
 * so an id alone does not identify a call.
 */
function callKey(turn: number, step: number, id: string): string {
  return `${turn}:${step}:${id}`
}

/** All-text content flattened to one string, or `undefined` when any block is not text. */
function plainText(blocks: readonly ContentBlock[]): string | undefined {
  let text = ''
  for (const block of blocks) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

/** The `name` argument of a skill call, when the model supplied one. */
function skillArgument(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const name = (parsed as Record<string, unknown>)['name']
      if (typeof name === 'string' && name.length > 0) return name
    }
  } catch { /* malformed arguments name no skill */ }
  return undefined
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    retention: z.object({
      keepRecentToolGroups: z.number().step(1).min(0),
      preserveErrors: z.boolean(),
      preserveMedia: z.boolean(),
      minimumSavingsChars: z.number().step(1).min(0),
      stubAfterToolGroups: z.number().step(1).min(0),
      stubMinChars: z.number().step(1).min(0),
      skillToolName: z.string(),
      keepRecentSkillToolGroups: z.number().step(1).min(0),
    }),
    formats: z.object({
      skillBodyName: z.function(),
      retrievalNotice: z.function(),
      outcomeMarkers: z.dict(z.function()),
      logPointer: z.function(),
      pointedResults: z.function(),
    }),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune every over-budget tool result from one stable current-surface snapshot.
   *
   * Results are ranked by tool-group age in surface order (0 = the newest
   * `turn:step` group). Each result gets at most one rewrite:
   * - younger than `keepRecentToolGroups`, a preserved error, or preserved
   *   media: kept verbatim;
   * - pointed at by a result younger than `keepRecentToolGroups`
   *   (`formats.pointedResults`, such as a re-read's "unchanged" notice):
   *   kept verbatim;
   * - a loaded skill body (`skillToolName`, recognized by
   *   `formats.skillBodyName`): kept verbatim while that skill was requested
   *   within `keepRecentSkillToolGroups`, else replaced by the canonical
   *   skill-removed marker, never cut partway;
   * - at least `stubAfterToolGroups` old and longer than `stubMinChars`: a
   *   one-line stub sized on the recorded result and pointing back at it;
   * - otherwise over `thresholdChars`: the head/tail excerpt.
   *
   * Each result is matched to the call its own step issued (turn, step and
   * call id), so call ids reused across steps never cross-attribute a stub
   * or a skill marker.
   *
   * Each replacement preserves the complete event data except for `content`,
   * cites the shadowed node so replay can recover the replacement input, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session, overrides?: Readonly<PruneRetentionPolicy>): PruneResult {
    // One pass over the sanctioned journal view: tool calls come from the
    // visible assistant messages, keyed by the step that issued them, and each
    // visible tool result takes the call its own step issued with its id.
    const calls = new Map<string, VisibleCall>()
    const candidates: SnapshotCandidate[] = []
    for (const { seq, event, message } of visibleMessages(session)) {
      if (event.type === 'assistant/message') {
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            calls.set(callKey(event.data.turn, event.data.step, block.id), { name: block.name, argumentsJson: block.arguments })
          }
        }
      } else if (event.type === 'tool/result') {
        const original = message as ToolResultMessage
        const call = calls.get(callKey(event.data.turn, event.data.step, original.toolCallId))
        candidates.push({ seq, event, original, call })
      }
    }

    // Select in surface order. Replacement event seqs are not recency: an old
    // result can have a newer seq after a previous prune/offload.
    // a caller can run a deeper pass (compaction under pressure, to a watermark) without changing the configuration
    const retention = overrides === undefined ? this.config.retention : { ...this.config.retention, ...overrides }
    const formats = this.config.formats
    const groupKey = (candidate: SnapshotCandidate): string => `${candidate.event.data.turn}:${candidate.event.data.step}`
    const groups = [...new Set(candidates.map(groupKey))]
    const ranks = new Map(groups.map((key, index) => [key, groups.length - 1 - index]))
    const rankOf = (candidate: SnapshotCandidate): number => ranks.get(groupKey(candidate)) ?? 0
    const keep = retention?.keepRecentToolGroups ?? 0
    const stubAfter = retention?.stubAfterToolGroups
    const stubMinChars = retention?.stubMinChars ?? this.config.thresholdChars
    const skillTool = retention?.skillToolName
    const skillBodyName = formats?.skillBodyName
    const keepSkill = retention?.keepRecentSkillToolGroups ?? stubAfter ?? keep

    // The newest request for each skill, including a later "unchanged" reload,
    // keeps that skill's body in context (Hermes protects referenced skills too).
    const newestSkillRequest = new Map<string, number>()
    if (skillTool !== undefined && skillBodyName !== undefined) {
      for (const candidate of candidates) {
        if (candidate.call?.name !== skillTool) continue
        const text = plainText(candidate.original.content)
        const name = skillArgument(candidate.call.argumentsJson) ?? (text === undefined ? undefined : skillBodyName(text))
        if (name === undefined) continue
        newestSkillRequest.set(name, Math.min(rankOf(candidate), newestSkillRequest.get(name) ?? Infinity))
      }
    }

    // A result that points the model at an earlier one instead of repeating it
    // keeps that earlier one verbatim while the pointer is in the verbatim window.
    const newestPointer = new Map<SessionSeq, number>()
    const pointed = formats?.pointedResults?.(session)
    if (pointed !== undefined && pointed.size > 0) {
      const rankBySeq = new Map(candidates.map(candidate => [candidate.seq, rankOf(candidate)]))
      for (const [pointer, target] of pointed) {
        const rank = rankBySeq.get(pointer)
        if (rank !== undefined) newestPointer.set(target, Math.min(rank, newestPointer.get(target) ?? Infinity))
      }
    }

    /** The stub for an old result, sized on the result its call recorded rather than on a later excerpt. */
    const stubOf = (candidate: SnapshotCandidate, call: VisibleCall, text: string): string => {
      const identity = { tool: call.name, argumentsJson: call.argumentsJson }
      const at = (seq: SessionSeq): { seq: SessionSeq; logPointer?: string } => {
        const logPointer = formats?.logPointer?.(seq, session)
        return logPointer === undefined ? { seq } : { seq, logPointer }
      }
      const recorded = recordedToolResult(session, candidate.event)
      if (recorded === undefined) return renderToolResultStub({ ...identity, text, ...at(candidate.seq) }, formats)
      if (recorded === candidate.event) return renderToolResultStub({ ...identity, text, ...at(recorded.seq) }, formats)
      const message = session.deriveEventMessage(recorded) as ToolResultMessage | null
      const recordedText = message === null ? undefined : plainText(message.content)
      return renderToolResultStub(recordedText === undefined
        ? { ...identity, text, ...at(recorded.seq) }
        : { ...identity, text: recordedText, currentText: text, ...at(recorded.seq) }, formats)
    }

    const rewrite = (candidate: SnapshotCandidate): { content: ContentBlock[]; kind: PruneKind } | null => {
      const result = candidate.original
      const call = candidate.call
      const text = plainText(result.content)
      const rank = rankOf(candidate)
      if (skillTool !== undefined && skillBodyName !== undefined && call?.name === skillTool && text !== undefined) {
        // an already pruned body keeps its canonical marker, the model's cue to reload the skill, through deeper passes
        if (removedSkillNames(text).some(name => text === renderSkillRemovedMarker(name))) return null
        const bodyName = skillBodyName(text)
        if (bodyName !== undefined) {
          const name = skillArgument(call.argumentsJson) ?? bodyName
          if ((newestSkillRequest.get(name) ?? rank) < keepSkill) return null
          return { content: [{ type: 'text', text: renderSkillRemovedMarker(name) }], kind: 'skill' }
        }
      }
      if (stubAfter !== undefined && rank >= stubAfter && call !== undefined
        && text !== undefined && codePointLength(text) > stubMinChars) {
        return { content: [{ type: 'text', text: stubOf(candidate, call, text) }], kind: 'stub' }
      }
      const content = this.pruneContent(result.content)
      return content === null ? null : { content, kind: 'head-tail' }
    }

    const planned = candidates.flatMap(candidate => {
      if (rankOf(candidate) < keep || (newestPointer.get(candidate.seq) ?? Infinity) < keep) return []
      const result = candidate.original
      if (retention?.preserveErrors === true && result.isError === true) return []
      if (retention?.preserveMedia === true && result.content.some(block => block.type !== 'text')) return []
      const replacement = rewrite(candidate)
      if (replacement === null) return []
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(replacement.content)
      // A stub or marker that would not shrink the node is not worth a replacement.
      if (charsAfter >= charsBefore) return []
      return [{ ...candidate, ...replacement, charsBefore, charsAfter }]
    })
    const savings = planned.reduce((total, item) => total + item.charsBefore - item.charsAfter, 0)
    if (savings < (retention?.minimumSavingsChars ?? 0)) return { pruned: [], charsRemoved: 0 }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event, original, content, kind, charsBefore, charsAfter } of planned) {
      const replacement = appendToolResultReplacement(
        session, event, original, content, this.ctx.tokenMeter.estimateMessage(original))
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
        kind,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

export default ToolResultPruner
