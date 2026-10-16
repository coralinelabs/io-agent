/** Bounded output even when storage fails; execution and evidence completeness are distinct. */
import { modelText } from '../context/text/index.ts'
import { TextRetainer, type Omitted } from '../util/output-retention/index.ts'

/** A single bounded display of retained source spans; gap prose spends the same byte budget. */
export function boundedOutputPreview(text: string, maxBytes: number): { text: string; omittedBytes: Omitted } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid preview budget')
  if (Buffer.byteLength(text) <= maxBytes) return { text, omittedBytes: { kind: 'none' } }
  const marker = `\n${modelText('tools/output-gap')}\n`
  const available = maxBytes - Buffer.byteLength(marker)
  // A tiny budget cannot afford two spans and a truthful separator. Keep a single prefix;
  // the caller's omission notice still describes the loss. Never join unrelated fragments.
  // Four bytes per span accommodate any complete UTF-8 scalar after boundary trimming.
  const retainer = new TextRetainer(available < 8
    ? { kind: 'head', maxBytes }
    : { kind: 'headTail', headBytes: Math.ceil(available / 2), tailBytes: Math.floor(available / 2) })
  retainer.push(text)
  const kept = retainer.finish()
  return {
    text: kept.gapOffset === undefined ? kept.text
      : kept.text.slice(0, kept.gapOffset) + marker + kept.text.slice(kept.gapOffset),
    omittedBytes: kept.omittedBytes,
  }
}

export function unavailableOutputPreview(text: string, maxBytes: number): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid preview budget')
  const total = Buffer.byteLength(text)
  if (total <= maxBytes) return text
  const notice = modelText('tools/output-unavailable', { omitted: total })
  const available = maxBytes - Buffer.byteLength(notice) - 2
  // A caller that configured less than the minimum truthful notice needs an
  // explicit failure policy; never silently claim empty output is complete.
  if (available < 0) return undefined
  const result = boundedOutputPreview(text, available)
  const omitted = result.omittedBytes.kind === 'exact' ? result.omittedBytes.count : total
  return `${result.text}\n\n${modelText('tools/output-unavailable', { omitted })}`
}
