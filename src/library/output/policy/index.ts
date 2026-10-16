import { boundedOutputPreview, unavailableOutputPreview } from '../preview.ts'
/**
 * The spill-policy PLUGIN: a `tools/post-execute` result transformer that keeps
 * oversized plain-text tool results out of the model's context. When a final
 * result's UTF-8 size exceeds `maxInlineBytes`, it saves the FULL text to a
 * session-scoped spill artifact (`ctx.spillStore`) and replaces the
 * model-facing result with a bounded head/tail preview plus the backend's
 * locator and retrieval guidance.
 *
 * It registers NO service and owns NO storage or preview mechanics: preview is
 * `io-agent/output-retention` (`TextRetainer`), storage is `ctx.spillStore`.
 * The policy only decides WHEN to spill and composes the notice.
 *
 * A second arm applies the SAME cap to the durable log: the
 * `tools/ptc-dispatch-log` waterfall bounds the `tool/ptc-dispatch` event's
 * copy of an oversized `run_code` sub-call result (the program's value is
 * untouched; UIs and replay read the full text through the spill artifact).
 *
 * ## Deliberately narrow
 *
 * - Omitted `maxInlineBytes` ⇒ the plugin registers nothing (a true no-op).
 * - Plain-text results only: a result carrying any non-text block is left
 *   untouched (the policy knows only the final formatted text, not tool
 *   internals).
 * - Nested composite calls skip the MODEL-facing arm; their durable log copy
 *   is bounded by the dispatch-log arm instead.
 * - Accepted value replacements pass through for registry revalidation and
 *   rendering; this presentation policy cannot also replace content in the
 *   same mutually exclusive decision.
 * - `exemptTools` (default `['read']`) are skipped by the model-facing arm
 *   and the per-step budget to avoid a `read → spill → read again` loop; the
 *   dispatch-log arm bounds `read` sub-calls too (a log copy is not model
 *   context, and `read` is precisely the tool that produces huge logs).
 * - The inline preview is `previewBytes` (when set) rather than the whole
 *   cap, so a spilled result costs a few KB of context instead of nearly
 *   `maxInlineBytes`; the replacement still never exceeds `maxInlineBytes`.
 * - A third, optional arm (`stepBudgetBytes`) bounds one model step's results
 *   TOGETHER: on `tools/batch-committed` (every result appended, none sent
 *   yet) it spills the largest eligible results first until the step's text
 *   total fits, through durable shadow-priced `tool/result` replacements. The
 *   original full results stay in the journal.
 * - Best-effort: no session owner, no `ctx.spillStore` backend, or a save
 *   failure ⇒ log and return the original result. A spill failure must NEVER
 *   turn a successful tool call into an `isError` or hide the inline result.
 *
 * It COMPOSES with other post-execute listeners: its prepended listener
 * delegates via `next()` and bounds the resulting content projection, so
 * tool-owned asynchronous projection runs before generic bounding, a hook that
 * replaced content still has its replacement bounded, and value replacements
 * and `block` decisions pass through unchanged.
 *
 * @module io-agent/spill-policy
 */

import type { Context } from "../../runtime/vendor/cordis/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import { estimateMessage } from "../../model/token-meter/estimate.ts"
// Type-only: the `ctx.tokenMeter` Context merge for the optional live pricing.
import type {} from "../../model/token-meter/index.ts"
import type { SaveTextSpill, SpillRef } from "../spill/index.ts"
import type { Session, SessionEvent, SessionId, ToolResultMessage } from "../../session/journal/index.ts"
import type { ToolCallId } from "../../model/llm/index.ts"
import type { PostToolDecision, ToolBatchCommit, ToolExecution } from "../../tools/index.ts"
import { appendToolResultReplacement } from "../../context/compaction/compaction/replace.ts"
import type { SpillPolicyExec } from './types.ts'
import { formatSpillNotice, hasSpillNotice } from './notice.ts'

export type { SpillPolicyExec } from './types.ts'
export { DEFAULT_PREVIEW_BYTES, TOOL_OUTPUT_BYTES_PER_TOKEN, toolOutputBudget } from './budget.ts'
export type { ToolOutputBudget } from './budget.ts'

/** Plugin config. */
export interface Config {
  /**
   * The model-facing context cap for a plain-text tool result, in UTF-8 bytes.
   * Omitted disables the policy entirely (no-op). When set, a result larger than
   * this is spilled and replaced with a preview derived from this same budget.
   */
  maxInlineBytes?: number
  /** Bound context even if output storage fails, without changing execution success. */
  boundOnSaveFailure?: boolean
  /**
   * Head/tail preview budget kept inline for a spilled result, in UTF-8 bytes.
   * Omitted keeps the historical preview (the whole cap minus the notice).
   * The replacement never exceeds `maxInlineBytes` either way.
   */
  previewBytes?: number
  /**
   * Aggregate inline budget for the plain-text results of ONE model step, in
   * UTF-8 bytes; at least `maxInlineBytes`. When a committed step exceeds it,
   * the largest eligible results are spilled first until the total fits.
   * Omitted disables the per-step arm.
   */
  stepBudgetBytes?: number
  /**
   * Tools whose results are never spilled by the model-facing arm or the
   * per-step budget (they still count toward the step total). Defaults to
   * `['read']`, which avoids a `read → spill → read again` loop.
   */
  exemptTools?: string[]
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spill-policy'

/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export const inject = ['tools']

/** Tools skipped by default: spilling `read` would only prompt another `read`. */
const DEFAULT_EXEMPT_TOOLS: readonly string[] = ['read']

export const Config: z<Config> = z.object({
  maxInlineBytes: z.number(),
  boundOnSaveFailure: z.boolean().default(false),
  previewBytes: z.number(),
  stepBudgetBytes: z.number(),
  // An array schema would otherwise default an omitted key to [] and drop the `read` exemption.
  exemptTools: z.array(z.string()).default([...DEFAULT_EXEMPT_TOOLS]),
})

/** All-text content flattened to one UTF-8 string, or `undefined` if any block is non-text. */
function flattenPlainText(content: ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

/** The owning session id, or `undefined` for a call with no agent (a direct/test call). */
function ownerSessionId(exec: ToolExecution): SessionId | undefined {
  return (exec as SpillPolicyExec).agent?.session.header.id
}

/** All-text content of a durable result, or `undefined` for a result carrying any non-text block. */
function resultText(message: ToolResultMessage): string | undefined {
  return flattenPlainText(message.content)
}

/** Build the bounded head/tail preview for `text`, splitting `budget` bytes across the two ends. */

export function apply(ctx: Context, config: Config): void {
  const maxInlineBytes = config.maxInlineBytes
  // Omitted ⇒ no automatic spill policy: register nothing at all.
  if (maxInlineBytes === undefined) return
  // Validate at LOAD, not per call: a negative/fractional cap would reach
  // TextRetainer's assertBudget and throw, turning every oversized-result call
  // into an isError. A bad config must fail the deployment, not the tool.
  if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0) {
    throw new Error(`spill-policy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`)
  }
  // Narrowed once for the nested arms (closure narrowing does not survive awaits).
  const cap: number = maxInlineBytes
  const { previewBytes, stepBudgetBytes } = config
  if (previewBytes !== undefined && (!Number.isInteger(previewBytes) || previewBytes < 0)) {
    throw new Error(`spill-policy: previewBytes must be a non-negative integer (got ${previewBytes})`)
  }
  if (stepBudgetBytes !== undefined && (!Number.isInteger(stepBudgetBytes) || stepBudgetBytes < cap)) {
    throw new Error(`spill-policy: stepBudgetBytes must be an integer of at least maxInlineBytes ${cap} (got ${stepBudgetBytes})`)
  }
  if (config.exemptTools !== undefined && (!Array.isArray(config.exemptTools)
    || config.exemptTools.some(tool => typeof tool !== 'string' || tool.length === 0))) {
    throw new Error('spill-policy: exemptTools must be a list of non-empty tool names')
  }
  const exempt: ReadonlySet<string> = new Set(config.exemptTools ?? DEFAULT_EXEMPT_TOOLS)

  /**
   * Spill `text` and build the bounded replacement (preview + notice), or
   * return `undefined` when the policy must keep the original (no session
   * owner, no backend, storage failure, or no within-cap replacement).
   * Shared verbatim by the model-facing post-execute arm, the durable
   * dispatch-log arm and the per-step budget so all produce byte-identical
   * projections. `allowFallback: false` (the per-step arm) never applies the
   * `boundOnSaveFailure` preview: that result is already within the per-result
   * cap, so a replacement without a file behind it would only lose output.
   */
  async function spillReplacement(
    text: string,
    totalBytes: number,
    sessionId: SessionId | undefined,
    toolName: string,
    callId: ToolCallId,
    label: 'result' | 'dispatch',
    allowFallback = true,
  ): Promise<string | undefined> {
    const unavailable = (): string | undefined => allowFallback && config.boundOnSaveFailure === true
      ? unavailableOutputPreview(text, cap) : undefined
    if (sessionId === undefined) {
      ctx.logger.warn(`spill-policy: no session owner for ${toolName} ${label}; applying configured fallback`)
      return unavailable()
    }
    const spillStore = ctx.get('spillStore')
    if (!spillStore) {
      ctx.logger.warn('spill-policy: no ctx.spillStore backend loaded; applying configured fallback')
      return unavailable()
    }
    const save: SaveTextSpill = {
      owner: { sessionId },
      source: { kind: 'tool', toolName, callId, label },
      suggestedName: `${toolName}.txt`,
      content: text,
    }
    let ref: SpillRef
    try {
      ref = await spillStore.saveText(save)
    } catch (error: unknown) {
      // Best-effort: a storage failure (permissions, ENOSPC, backend down) must
      // never fail the call or hide the content — keep the original inline.
      ctx.logger.warn(`spill-policy: saveText failed for ${toolName}: ${String(error)}; applying configured fallback`)
      return unavailable()
    }

    // Reserve the notice's byte cost INSIDE maxInlineBytes so the replacement
    // (preview + blank line + notice) never exceeds the documented cap — a naive
    // preview that spent the whole budget then appended the notice could be
    // larger than the cap, and for a marginally-over result even larger than the
    // original. The reservation uses a notice priced at the worst-case omission
    // count (the full byte total): its digit count bounds the real count's, so
    // the reserved size is a safe upper bound and the final notice is never
    // longer than what we reserved. `\n\n` is the 2-byte join.
    const reserve = Buffer.byteLength(formatSpillNotice({ kind: 'exact', count: totalBytes }, ref), 'utf8') + 2
    // The configured preview is a ceiling inside the cap, never a way past it.
    const previewBudget = Math.max(0, Math.min(previewBytes ?? Number.POSITIVE_INFINITY, cap - reserve))
    const { text: previewText, omittedBytes: omitted } = boundedOutputPreview(text, previewBudget)
    const notice = formatSpillNotice(omitted, ref)
    const replacedText = previewText.length > 0 ? `${previewText}\n\n${notice}` : notice
    // Invariant: the policy NEVER emits a replacement larger than the cap. When
    // the notice alone exceeds maxInlineBytes (a tiny cap or a long spill root),
    // there is no within-cap replacement, so keep the inline content — spilling
    // would break the advertised cap. (A within-cap replacement is always
    // smaller than the original, which is > cap by the entry condition, so this
    // one check subsumes "not smaller than the original" too. The spill file
    // already written is a harmless orphan; cleanup is deferred.)
    if (Buffer.byteLength(replacedText, 'utf8') > cap) {
      ctx.logger.warn(`spill-policy: spill notice for ${toolName} exceeds maxInlineBytes; applying configured fallback`)
      return unavailable()
    }
    return replacedText
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Delegate first so a downstream listener (e.g. a hook) settles the result;
    // we bound whatever it accepted. A block passes through — spill only shapes
    // accepted plain-text results, never corrective feedback.
    const decision = await next()
    // Skip exempt tools (`read` by default) to avoid a read → spill → read again loop.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
      || exec.parent !== undefined || exempt.has(exec.name)) return decision

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= maxInlineBytes) return decision

    const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, 'result')
    if (replacedText === undefined) return decision
    const replaced: ContentBlock[] = [{ type: 'text', text: replacedText }]
    return { kind: 'accept', content: replaced, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  }, { prepend: true })

  // The durable-log arm: bound the `tool/ptc-dispatch` event's copy of an
  // oversized sub-call result the same way the model-facing arm bounds an
  // outer result. The program's returned value is untouched (it already
  // crossed the worker boundary whole); only the session log's copy shrinks
  // to preview + locator, so replay and UIs read the full text through the
  // spill artifact exactly as they do for spilled native results.
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next): Promise<ContentBlock[]> => {
    const content = await next()
    // `read` sub-calls spill too: the log copy is not model context, so the
    // read → spill → read-again loop the post-execute arm avoids cannot
    // happen here, and read is precisely the tool that produces huge logs.
    const text = flattenPlainText(content)
    if (text === undefined) return content
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= maxInlineBytes) return content

    const replacedText = await spillReplacement(
      text, totalBytes, ownerSessionId(dispatch.exec), dispatch.name, dispatch.subCallId, 'dispatch')
    if (replacedText === undefined) return content
    return [{ type: 'text', text: replacedText }]
  }, { prepend: true })

  if (stepBudgetBytes === undefined) return
  const budget: number = stepBudgetBytes

  /** Land one step-budget replacement through the shared shadow-priced helper. */
  const replaceResult = (session: Session, event: SessionEvent<'tool/result'>, original: ToolResultMessage, text: string): void => {
    const price = ctx.get('tokenMeter')?.estimateMessage(original) ?? estimateMessage(original)
    appendToolResultReplacement(session, event, original, [{ type: 'text', text }], price)
  }

  /*
   * The per-step arm. Runs once per committed batch, before the step ends and
   * before any of its results is sent, so the rewrite changes no bytes the
   * provider has cached. Every result's text counts toward the total; only
   * successful plain-text, non-exempt, not-yet-spilled results are
   * candidates, largest first (model order breaks ties). A save failure skips
   * that candidate — a result is never replaced without a file behind it —
   * and cancellation stops the pass.
   */
  ctx.on('tools/batch-committed', async (batch: ToolBatchCommit): Promise<void> => {
    const { session } = batch.agent
    const measured = batch.results.map(({ event, name }, order) => {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const text = resultText(original)
      const bytes = text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
      return { event, name, order, original, text, bytes }
    })
    let total = measured.reduce((sum, item) => sum + item.bytes, 0)
    if (total <= budget) return
    // A result no larger than the preview itself cannot shrink; skip it before writing a file.
    const floor = previewBytes ?? cap
    const candidates = measured
      .filter(item => item.text !== undefined && item.bytes > floor && item.original.isError !== true
        && !exempt.has(item.name) && !hasSpillNotice(item.text))
      .sort((left, right) => right.bytes - left.bytes || left.order - right.order)
    for (const candidate of candidates) {
      if (total <= budget || batch.signal.aborted) return
      const text = candidate.text as string
      const replacedText = await spillReplacement(
        text, candidate.bytes, session.header.id, candidate.name,
        candidate.event.data.message.source.callId, 'result', false)
      // The step may have been cancelled, or the node rewritten, while the
      // artifact was being written: never replace a node that is no longer current.
      if (replacedText === undefined || batch.signal.aborted
        || !session.surface.nodes.includes(candidate.event.seq)) continue
      const replacedBytes = Buffer.byteLength(replacedText, 'utf8')
      if (replacedBytes >= candidate.bytes) continue
      replaceResult(session, candidate.event, candidate.original, replacedText)
      total -= candidate.bytes - replacedBytes
      ctx.logger.info(`spill-policy: step budget spilled ${candidate.name} result `
        + `(${candidate.bytes} -> ${replacedBytes} bytes; step total now ${total} of ${budget})`)
    }
  })
}
