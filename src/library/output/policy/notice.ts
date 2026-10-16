/** Browser-safe formatting and recognition of persisted spill-policy notices. */
import { describeOmitted, type Omitted } from "../../util/output-retention/index.ts"
import type { SpillRef } from "../spill/index.ts"

const OPEN = '('
const CLOSE = ')'
const LOCATION = ' Full formatted result stored at: '
const GUIDANCE_SEPARATOR = '. '
const SEPARATOR = '\n\n'
const EXACT_OMISSION = describeOmitted({ kind: 'exact', count: 0 }, 'bytes')
const COUNT_OFFSET = EXACT_OMISSION.indexOf('0')
const COUNT_SUFFIX = EXACT_OMISSION.slice(COUNT_OFFSET + 1)

/**
 * Format the notice appended to a retained preview, preserving its persisted spelling.
 * @param omitted - bytes omitted by the retention policy.
 * @param ref - saved text locator and retrieval guidance.
 * @returns the complete notice without a leading preview separator.
 */
export function formatSpillNotice(omitted: Omitted, ref: Pick<SpillRef, 'locator' | 'retrievalHint'>): string {
  return `${OPEN}${describeOmitted(omitted, 'bytes')}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`
}

function isOmission(text: string): boolean {
  if (text === describeOmitted({ kind: 'none' }, 'bytes')
    || text === describeOmitted({ kind: 'unknown' }, 'bytes')) return true
  const count = Number(text.slice(COUNT_OFFSET, text.length - COUNT_SUFFIX.length))
  return Number.isSafeInteger(count) && count >= 0
    && text === describeOmitted({ kind: 'exact', count }, 'bytes')
}

/**
 * Recognize a final spill-policy notice in persisted text, including notice-only output.
 * This identifies the text convention, not authenticated tool-output origin.
 * @param text - complete recorded text result.
 * @returns whether a complete notice occupies the end of the result.
 */
export function hasSpillNotice(text: string): boolean {
  return spillNoticeOf(text) !== undefined
}

/**
 * Return the exact final spill-policy notice in persisted text, using the same
 * scan as {@link hasSpillNotice}. Callers that must point back at the spilled
 * artifact (a pruned-result stub) reuse the notice verbatim instead of parsing
 * its locator or retrieval hint.
 * @param text - complete recorded text result.
 * @returns the notice from its opening parenthesis to the end, or `undefined` when there is none.
 */
export function spillNoticeOf(text: string): string | undefined {
  if (!text.endsWith(CLOSE)) return undefined
  let start = 0
  while (true) {
    const next = text.indexOf(`${SEPARATOR}${OPEN}`, start)
    const candidate = text.slice(start, next < 0 ? -CLOSE.length : next)
    const location = candidate.indexOf(LOCATION, OPEN.length)
    if (candidate.startsWith(OPEN) && location >= 0
      && isOmission(candidate.slice(OPEN.length, location))) {
      return text.indexOf(GUIDANCE_SEPARATOR, start + location + LOCATION.length) >= 0 ? text.slice(start) : undefined
    }
    if (next < 0) return undefined
    start = next + SEPARATOR.length
  }
}

/**
 * Split persisted text into the preview the spill policy kept inline and its
 * final notice, dropping the blank-line separator the policy put between them.
 * Consumers that describe a spilled result (a pruned-result stub) size the
 * preview and keep the notice verbatim, so they never re-derive this format.
 * @param text - complete recorded text result.
 * @returns the preview and the exact notice, or `undefined` when the text carries no notice.
 */
export function splitSpillNotice(text: string): { readonly body: string; readonly notice: string } | undefined {
  const notice = spillNoticeOf(text)
  if (notice === undefined) return undefined
  const body = text.slice(0, text.length - notice.length)
  return { body: body.endsWith(SEPARATOR) ? body.slice(0, -SEPARATOR.length) : body, notice }
}
