/**
 * Model-facing UTF-8 read. It performs one provider stat for type, routing, and observed version,
 * streams large or size-unknown files, renders a bounded window, then emits the observation.
 * @module io-agent/tool-fs/src/read
 */

import { isAbsolute, resolve } from 'node:path'
import { modelText } from "../../context/text/index.ts"
import { visibleToolResultsNewestFirst } from "../../context/visibility.ts"
import type { VisibleToolResult } from "../../context/visibility.ts"
import type { Session, SessionSeq } from "../../session/journal/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { GenericCallView, ReadResultView, ToolExecution, ToolExecutionResult, ToolResult } from "../../tools/index.ts"
import type {} from "../fs/index.ts"
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta, type FsReadMeta } from './read-render.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000

/**
 * Default streaming threshold (the `readStreamMinSize` config): files at or
 * above this size stream; smaller files read whole into memory.
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Resolved read-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
  /**
   * Bytes returned by a read without `limit` (the default window); defaults to
   * {@link maxBytes}. A smaller window keeps an orientation read of a large file
   * from replaying the whole file on every later request.
   */
  defaultMaxBytes?: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize: number
  /** Answer a repeated top-level read whose identical result is still visible with a short notice. */
  unchangedNotice?: boolean
}

/** Rendered reads below this many UTF-8 bytes are always returned in full. */
export const UNCHANGED_NOTICE_MIN_BYTES = 1024

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(modelText('tools/read/positive-integer', { name }))
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns the validated input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }, maxLimit: number): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error(modelText('tools/read/path-required'))
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(modelText('tools/read/limit-exceeded', { limit: maxLimit }))
  return { filePath: args.file_path, offset, limit }
}

/**
 * The byte cap one read applies: the default window without `limit`, else the full cap.
 * @param args - the read arguments.
 * @param caps - the resolved read caps.
 * @returns the byte cap, and the default window when it is the binding one.
 */
export function readByteCap(args: { limit?: number }, caps: Pick<ReadToolCaps, 'maxBytes' | 'defaultMaxBytes'>): { maxBytes: number; defaultWindowBytes?: number } {
  const window = caps.defaultMaxBytes
  if (args.limit !== undefined || window === undefined || window >= caps.maxBytes) return { maxBytes: caps.maxBytes }
  return { maxBytes: window, defaultWindowBytes: window }
}

/**
 * Render one read window as its canonical model-facing envelope.
 * @param args - the read arguments (their `limit` decides whether a short window was byte-capped).
 * @param value - the structured window the read produced.
 * @param maxLimit - the configured line cap.
 * @param defaultWindowBytes - the default window a read without `limit` stops at, when smaller than the full cap.
 * @returns the envelope text `output.render` returns as the single content block.
 */
export function renderReadText(
  args: { file_path: string; offset?: number; limit?: number },
  value: Pick<FsReadMeta, 'path' | 'offset' | 'lines' | 'totalLines'>,
  maxLimit: number,
  defaultWindowBytes?: number,
): string {
  const input = parseReadArgs(args, maxLimit)
  const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
  const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
  const window = args.limit === undefined ? defaultWindowBytes : undefined
  return formatReadOutput(value.path, {
    offset: value.offset,
    lines: value.lines,
    totalLines: value.totalLines,
    ...truncatedByBytes ? { truncatedByBytes: true, ...window === undefined ? {} : { defaultWindowBytes: window } } : {},
  })
}

function isReadArguments(args: unknown): args is { file_path: string; offset?: number; limit?: number } {
  return typeof args === 'object' && args !== null && 'file_path' in args && typeof args.file_path === 'string'
}

/** The `file_path` a journaled read call named, or `undefined` when its arguments do not parse. */
function calledFilePath(call: { data: { arguments: string } }): string | undefined {
  try {
    const args: unknown = JSON.parse(call.data.arguments)
    return isReadArguments(args) ? args.file_path.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Replace a top-level read's content with the `tools/read/unchanged` notice when
 * the newest visible read of the same file overlapping this window is the
 * unreplaced original and shows exactly this rendered text. A newer visible read
 * of the file that shows something else ends the search with full content: one
 * with no lines (an empty file, an offset past the end), another line count, or
 * no readable window at all (a failed read, or a replacement without `meta`)
 * whose call named this file. Any other outcome (nested or agentless reads,
 * small or policy-modified content, a newer read of different content, a pruned
 * or compacted earlier result) also keeps the full content.
 * @param exec - the finished execution.
 * @param result - the normalized outcome.
 * @param maxLimit - the configured line cap.
 * @returns the notice content, or `undefined` to keep the full content.
 */
function unchangedReadContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>, maxLimit: number, defaultWindowBytes?: number): ContentBlock[] | undefined {
  if (result.isError || exec.parent !== undefined || exec.agent === undefined || !isReadArguments(exec.arguments)) return undefined
  const value = readMetaFromMeta(result.value)
  const notice = value === undefined ? undefined : unchangedNotice(value)
  if (value === undefined || notice === undefined) return undefined
  const only = result.content.length === 1 ? result.content[0] : undefined
  if (only?.type !== 'text') return undefined
  const rendered = renderReadText(exec.arguments, value, maxLimit, defaultWindowBytes)
  // A post-execute policy that changed the content owns it; never replace that.
  if (only.text !== rendered || Buffer.byteLength(rendered, 'utf8') < UNCHANGED_NOTICE_MIN_BYTES) return undefined
  const session = exec.agent.session
  const seen = newestOverlappingRead(visibleToolResultsNewestFirst(session, 'read'), value, notice,
    fileMatcher(session.header.cwd, exec.arguments.file_path.trim(), value.path))
  // The newest overlapping read decides, so a revert to older content is re-sent in full.
  return seen !== undefined && seen.original && seen.shows(rendered) ? [{ type: 'text', text: notice }] : undefined
}

type ReadWindow = Pick<FsReadMeta, 'path' | 'offset' | 'lines' | 'totalLines'>

/** The `tools/read/unchanged` notice for one read window, or `undefined` for a window without lines. */
function unchangedNotice(value: ReadWindow): string | undefined {
  const last = value.lines.at(-1)?.number
  if (last === undefined) return undefined
  return modelText('tools/read/unchanged', { path: value.path, range: `${String(value.offset)}-${String(last)} of ${String(value.totalLines)}` })
}

/** Whether a path a read call named is the file `requested` resolved to. */
function fileMatcher(cwd: string | undefined, requested: string, resolvedPath: string): (named: string | undefined) => boolean {
  const lexical = (path: string): string => cwd === undefined || isAbsolute(path) ? path : resolve(cwd, path)
  return named => named !== undefined
    && (named === requested || lexical(named) === lexical(requested) || lexical(named) === resolvedPath)
}

/**
 * The newest of `earlier` (visible reads, newest first) overlapping `value`'s
 * window of the same file: the read a re-read of that window is compared
 * with. `undefined` when there is none, or when a newer view of the file ends
 * the search: one with no lines, another line count, or no readable window
 * whose call named this file. An earlier `notice` for this window defers to
 * the read it matched.
 */
function newestOverlappingRead(
  earlier: Iterable<VisibleToolResult>,
  value: ReadWindow,
  notice: string,
  namesThisFile: (named: string | undefined) => boolean,
): VisibleToolResult | undefined {
  const last = value.lines.at(-1)?.number ?? value.offset
  for (const seen of earlier) {
    const meta = seen.event.data.meta
    const seenPath = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && typeof meta.path === 'string' ? meta.path : undefined
    if (seenPath === undefined) {
      // No window to compare: when its call named this file, it is the model's newest view of it.
      if (namesThisFile(calledFilePath(seen.call))) return undefined
      continue
    }
    if (seenPath !== value.path) continue
    const window = readMetaFromMeta(meta)
    const seenLast = window?.lines.at(-1)?.number
    // The newest view of this file was empty, malformed or of another length.
    if (window === undefined || seenLast === undefined || window.totalLines !== value.totalLines) return undefined
    if (window.offset > last || value.offset > seenLast) continue
    if (seen.shows(notice)) continue
    return seen
  }
  return undefined
}

/**
 * Every visible "unchanged" notice mapped to the earlier read it points the
 * model at, found by the same search that issued it. The tool-result pruner
 * keeps such a read verbatim while its notice is recent, so a notice in the recent window never stands for pruned content.
 * @param session - session whose visible reads are scanned.
 * @returns notice result seq → the seq of the read it points at.
 */
export function unchangedReadPointers(session: Session): ReadonlyMap<SessionSeq, SessionSeq> {
  const reads = [...visibleToolResultsNewestFirst(session, 'read')]
  const pointers = new Map<SessionSeq, SessionSeq>()
  for (const [index, read] of reads.entries()) {
    const value = readMetaFromMeta(read.event.data.meta)
    const notice = value === undefined ? undefined : unchangedNotice(value)
    if (value === undefined || notice === undefined || !read.shows(notice)) continue
    const matcher = fileMatcher(session.header.cwd, calledFilePath(read.call) ?? value.path, value.path)
    const target = newestOverlappingRead(reads.slice(index + 1), value, notice, matcher)
    if (target !== undefined) pointers.set(read.seq, target.seq)
  }
  return pointers
}

/**
 * Register the `read` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps (plugin config after defaulting).
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  // The default window applies only when it is smaller than the full cap.
  const defaultWindowBytes = readByteCap({}, caps).defaultWindowBytes
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    // With grep visible the guidance adds grep-then-window reading.
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : ctx.tools.get('grep', scope) === undefined
        ? modelText('tools/read/guidance')
        : `${modelText('tools/read/guidance')} ${modelText('tools/read/window-first')}`,
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: modelText('tools/read/description-01'),
    parameters: {
      file_path: { type: 'string', required: true, description: modelText('tools/read/description-02') },
      offset: { type: 'number', description: modelText('tools/read/description-03') },
      limit: { type: 'number', description: defaultWindowBytes === undefined
        ? modelText('tools/read/description-04', { limit: caps.limit })
        : modelText('tools/read/description-05', { limit: caps.limit, default_bytes: defaultWindowBytes }) },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderReadText(args, value, caps.limit, defaultWindowBytes) }],
      // Project the structured window into persisted `meta` so a UI's read card
      // survives replay: the raw canonical output object is not on the wire, only
      // the model-facing text, from which the line/lang data cannot be recovered.
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(({ number, text }) => ({ number, text })),
          totalLines: value.totalLines,
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    // Observation races fail closed because guarded mutations re-check the version in-lock.
    isConcurrencySafe: () => true,
    // Runs at the ordered commit, after post-execute policy: an earlier read in the
    // same batch is already journaled, and value/meta keep the full window.
    finalizeContent(exec, result) {
      if (caps.unchangedNotice !== true) return undefined
      try {
        return unchangedReadContent(exec, result, caps.limit, defaultWindowBytes)
      } catch {
        // The finalizer contract is total: any doubt keeps the full content.
        return undefined
      }
    },
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      // One stat: absence observation OR type check + size routing + present version.
      // A concurrent write can only make a later guarded mutation fail stale and require reread.
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)

      // Stream when the file is large OR size is unknown, so a size-less backend
      // never buffers an arbitrarily large file.
      const chunks = info.size === undefined || info.size >= caps.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : [await ctx.fs.readText(target, exec.signal)]
      const window = await buildWindow(
        chunks,
        { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: readByteCap(args, caps).maxBytes },
        target.displayPath,
      )

      const outcome = {
        path: target.displayPath,
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
      }
      // Record the present observation (a no-op when no policy plugin listens). The
      // read already succeeded; an fs/observed listener is contractually a
      // synchronous, side-effect-only recorder.
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // Result-time display: a `read` card carrying the structured line window a
    // capable UI renders as a line-numbered, syntax-highlighted view. The
    // structured data is narrowed from the persisted `meta` (replay-safe); the
    // envelope-stripped model-facing text rides along as `content` so a UI without
    // the read capability still shows the file text. A malformed or absent meta,
    // or a result whose text is not the read envelope, declines to `undefined`
    // (the generic fallback), never throwing on replay of obsolete logged output.
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // Group 1 always captures (possibly empty) when the envelope matches.
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    // Pure display: a generic card titled by the file with the read window appended (`Read
    // foo.txt (5 - 8)`), `read` kind (icon), and a follow-along location whose line is the
    // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
    // the title bare instead of smuggling config into this pure presenter.
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}
