/**
 * Pure edit planning. Every range refers to the original byte-preserving text snapshot.
 * The filesystem layer supplies the lock, observation/version guard and atomic commit.
 * No fuzzy rewriting of an entire file: only selected ranges can change.
 */
import { modelText } from '../context/text/index.ts'
import { FsError, type FsReplacement } from './fs/types.ts'

export const MAX_EDITS = 64
interface Range { start: number; end: number }
interface Change extends Range { replacement: string; edit: number }
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

function exactRanges(content: string, needle: string): Range[] {
  const ranges: Range[] = []
  for (let start = content.indexOf(needle); start !== -1; start = content.indexOf(needle, start + 1)) {
    ranges.push({ start, end: start + needle.length })
  }
  return ranges
}

/** No indentation, Unicode, quote or punctuation normalization. Full lines only. */
function trailingWhitespaceRanges(content: string, needle: string): Range[] {
  const wantedNewline = needle.endsWith('\n')
  const expected = (wantedNewline ? needle.slice(0, -1) : needle).split('\n')
  const actual = [...content.matchAll(/[^\n]*\n|[^\n]+$/g)]
  const strip = (line: string): string => line.replace(/\n$/, '').replace(/[ \t]+$/, '')
  const ranges: Range[] = []
  for (let i = 0; i + expected.length <= actual.length; i++) {
    if (!expected.every((line, j) => strip(line) === strip(actual[i + j]![0]))) continue
    const last = actual[i + expected.length - 1]!
    const hasNewline = last[0].endsWith('\n')
    if (wantedNewline && !hasNewline) continue
    ranges.push({ start: actual[i]!.index, end: last.index + last[0].length - (!wantedNewline && hasNewline ? 1 : 0) })
    i += expected.length - 1
  }
  return ranges
}

/** Plan everything before producing output; any invalid edit rejects the entire batch. */
export function applyTextEdits(content: string, edits: readonly FsReplacement[], displayPath: string): {
  content: string; replacements: number
} {
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    throw new FsError(modelText('tools/edit/batch-limit', { limit: MAX_EDITS }), 'FS_INVALID_EDIT')
  }
  const raw = content
  // Matching may normalize CRLF; unchanged storage must not. Map selected ranges
  // back to the original text, preserving BOMs and mixed line endings verbatim.
  const removed: number[] = []
  for (const match of raw.matchAll(/\r\n/g)) removed.push(match.index - removed.length)
  content = lf(raw)
  const rawOffset = (offset: number): number => {
    let low = 0, high = removed.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (removed[mid]! < offset) low = mid + 1
      else high = mid
    }
    return offset + low
  }
  const changes: Change[] = []
  for (const [index, edit] of edits.entries()) {
    const oldText = lf(edit.oldString), replacement = lf(edit.newString)
    if (!oldText) throw new FsError(modelText('foundation/fs-local-fsio/text-31'), 'FS_EDIT_NOT_FOUND')
    let matches = exactRanges(content, oldText)
    if (matches.length === 0 && edit.matchMode === 'trailing-whitespace') matches = trailingWhitespaceRanges(content, oldText)
    if (matches.length === 0) {
      const message = modelText('foundation/fs-local-fsio/text-32', { value_1: displayPath })
      const hint = replacement && content.includes(replacement) ? modelText('tools/edit/already-present') : ''
      throw new FsError(message + hint, 'FS_EDIT_NOT_FOUND')
    }
    if (!edit.replaceAll && matches.length > 1) {
      throw new FsError(modelText('foundation/fs-local-fsio/text-33', { value_1: matches.length, value_2: displayPath }), 'FS_AMBIGUOUS_EDIT')
    }
    for (const range of matches) changes.push({ ...range, replacement, edit: index })
  }
  changes.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < changes.length; i++) {
    const previous = changes[i - 1]!, current = changes[i]!
    if (current.start < previous.end) throw new FsError(modelText('tools/edit/overlap', {
      first: previous.edit, second: current.edit, path: displayPath,
    }), 'FS_EDIT_OVERLAP')
  }
  // Forward assembly is linear in the file and replacement sizes, not O(edits * file).
  const chunks: string[] = []
  let cursor = 0
  for (const change of changes) {
    const start = rawOffset(change.start), end = rawOffset(change.end)
    const local = raw.slice(start, end).match(/\r?\n/)?.[0]
      ?? raw.slice(0, start).match(/\r?\n/g)?.at(-1)
      ?? raw.slice(end).match(/\r?\n/)?.[0] ?? '\n'
    chunks.push(raw.slice(cursor, start), change.replacement.replaceAll('\n', local))
    cursor = end
  }
  chunks.push(raw.slice(cursor))
  return { content: chunks.join(''), replacements: changes.length }
}
