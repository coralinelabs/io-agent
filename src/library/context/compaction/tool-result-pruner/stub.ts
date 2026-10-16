/**
 * Deterministic one-line replacements for pruned tool results
 * and the canonical marker for a pruned skill body.
 *
 * Every rendered byte derives from the journal (tool name, call arguments,
 * recorded result text and event seq), the prompt assets and the pure
 * tool-owned formats the composition layer supplies, never from time or
 * process state, so a stub is byte-identical on resume and replay.
 *
 * @module io-agent/compaction-tool-result-pruner/stub
 */

import { modelText } from "../../text/index.ts"
import type { SessionSeq } from "../../../session/journal/index.ts"
import { codePointLength, outcomeMarkerFormat } from './config.ts'
import type { ToolResultFormats } from './types.ts'

/**
 * Argument keys that identify what a call did, in preference order: the first
 * one present is the stub's key argument. Covers the built-in shell, file,
 * search, web, job, skill and agent tools; other tools fall back to their raw
 * argument JSON.
 */
const KEY_ARGUMENTS = [
  'command', 'file_path', 'path', 'pattern', 'url', 'query', 'name', 'job_id', 'description', 'key', 'action',
] as const
/** Code points kept of the key argument's value. */
const MAX_KEY_POINTS = 120
/** Code points a further string argument may have to be shown at all. */
const MAX_EXTRA_STRING_POINTS = 40
/** Further short scalar arguments shown after the key one (for example offset and limit). */
const MAX_EXTRA_ARGUMENTS = 2
/** Code points of the whole rendered argument description. */
const MAX_ARGUMENT_POINTS = 160

/** Inputs for one stub: the call identity, the recorded result and where the full result lives. */
export interface ToolResultStubInput {
  /** Tool name the model called. */
  readonly tool: string
  /** The call's raw argument JSON as the model sent it. */
  readonly argumentsJson: string
  /**
   * The result text as the tool call recorded it (the original append), never
   * a later head/tail excerpt or step-budget preview: the stub's size and
   * outcome describe this text.
   */
  readonly text: string
  /**
   * The node's current text when a later rewrite replaced the recorded one.
   * A retrieval notice it carries (a step-budget spill) is the preferred pointer.
   */
  readonly currentText?: string
  /** Journal event holding the recorded result, named when no retrieval notice exists. */
  readonly seq: SessionSeq
  /** The composition's pointer to that event (`formats.logPointer`); omitted, the generic session-log pointer. */
  readonly logPointer?: string
}

function clip(text: string, points: number): string {
  const chars = Array.from(text)
  return chars.length <= points ? text : chars.slice(0, points - 1).join('') + '…'
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A short scalar rendered as data, or `undefined` when the value is not worth a stub's space. */
function shortScalar(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value)
    && codePointLength(value) <= MAX_EXTRA_STRING_POINTS) return JSON.stringify(value)
  return undefined
}

/**
 * Describe a call by its key argument plus up to two further short scalars,
 * or by its clipped raw argument JSON when no key argument is present.
 * @param argumentsJson - the call's raw argument JSON.
 * @returns one line of at most 160 code points; data, never prose.
 */
export function describeCallArguments(argumentsJson: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(argumentsJson) } catch { parsed = undefined }
  if (isRecord(parsed)) {
    const record = parsed
    const key = KEY_ARGUMENTS.find(name => typeof record[name] === 'string' && (record[name] as string).length > 0)
    if (key !== undefined) {
      const parts = [`${key}=${JSON.stringify(clip(oneLine(record[key] as string), MAX_KEY_POINTS))}`]
      for (const [name, value] of Object.entries(record)) {
        if (parts.length > MAX_EXTRA_ARGUMENTS) break
        if (name === key) continue
        const scalar = shortScalar(value)
        if (scalar !== undefined) parts.push(`${name}=${scalar}`)
      }
      return clip(parts.join(', '), MAX_ARGUMENT_POINTS)
    }
  }
  const raw = oneLine(argumentsJson)
  return clip(raw.length === 0 ? '{}' : raw, MAX_KEY_POINTS)
}

/** Lines in a text, not counting a final newline as the start of another line. */
function lineCount(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Render the one-line stub that replaces an old tool result: tool, key
 * argument, the recorded result's size, its terminal outcome marker when the
 * tool's format found one, and a pointer back to the full result.
 *
 * The size is measured on the recorded result. When that result was itself
 * already only a preview (the tool call's output was saved elsewhere), the
 * size clause says so and the retrieval notice, which carries the omitted
 * count, follows verbatim. The pointer is the current or recorded retrieval
 * notice (locator and hint kept verbatim), otherwise the journal event, named
 * by the composition's `logPointer` when it supplies one.
 * @param input - call identity, recorded and current text, journal pointer.
 * @param formats - tool-owned formats; omitted ones are not recognized.
 * @returns the complete replacement text.
 */
export function renderToolResultStub(input: ToolResultStubInput, formats?: Readonly<ToolResultFormats>): string {
  const recorded = formats?.retrievalNotice?.(input.text)
  const current = input.currentText === undefined ? undefined : formats?.retrievalNotice?.(input.currentText)
  const body = recorded?.body ?? input.text
  const marker = outcomeMarkerFormat(formats, input.tool)?.(body)
  const size = { lines: lineCount(body), chars: codePointLength(body) }
  return modelText('compaction/pruned-tool-result-stub', {
    tool: input.tool,
    argument: describeCallArguments(input.argumentsJson),
    size: recorded === undefined
      ? modelText('compaction/pruned-tool-result-size', size)
      : modelText('compaction/pruned-tool-result-preview-size', size),
    outcome: marker === undefined || marker.length === 0 ? '' : modelText('compaction/pruned-tool-result-outcome', { marker }),
    pointer: current?.notice ?? recorded?.notice ?? input.logPointer
      ?? modelText('compaction/pruned-tool-result-log-pointer', { seq: input.seq }),
  })
}

/**
 * Render the canonical marker left where a loaded skill body was pruned.
 * @param name - skill name, as the model would pass it to the skill tool.
 * @returns the marker text.
 */
export function renderSkillRemovedMarker(name: string): string {
  return modelText('compaction/skill-removed', { name })
}

/** The marker's literal pieces around each `{{name}}`, read from the asset itself. */
const MARKER_SENTINEL = '\u0000'
const MARKER_PATTERN = (() => {
  const pieces = renderSkillRemovedMarker(MARKER_SENTINEL).split(MARKER_SENTINEL)
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The first occurrence captures the name; every later one must repeat it.
  const source = pieces.map(escape).reduce((pattern, piece, index) => (
    index === 0 ? piece : `${pattern}${index === 1 ? '([^"\\n]+)' : '\\1'}${piece}`
  ), '')
  return source
})()

/**
 * Find every skill named by a pruned-skill marker in a text. The matcher is
 * built from the prompt asset, so editing the marker's wording cannot leave a
 * stale parser behind (compaction checkpoints reuse this to list removed skills).
 * @param text - any model-visible text.
 * @returns the named skills in order of appearance, without duplicates.
 */
export function removedSkillNames(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(new RegExp(MARKER_PATTERN, 'g'))) {
    const name = match[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}
