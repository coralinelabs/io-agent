/**
 * The model-facing `grep` tool: search file contents with a ripgrep regular
 * expression. Execution spawns the packaged ripgrep binary
 * (`@vscode/ripgrep`) directly through the subprocess seam with a plain argv
 * vector using a fixed line-oriented `rg --json` command so file path, line
 * number, and line text parse without colon-splitting ambiguity — this module
 * owns the model-facing schema, argument validation, argv construction,
 * `--json` record parsing, per-line preview retention, match retention,
 * grouping, and formatting; process concerns stay behind `ctx.subprocess`.
 *
 * @module io-agent/tool-fs-search/grep
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { GenericCallView, SearchResultView, ToolResult } from "../../tools/index.ts"
import type { RetainedItems } from "../../util/output-retention/index.ts"
import type { SpillRef } from "../../output/spill/index.ts"
import type { GrepMatch, RetainedGrep } from './search-core.ts'
import { SearchError, previewLine, retainGrepWithContext, runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { grepSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * Default cap on flat matches retained inline by one `grep` call (the
 * `grepMaxMatches` config), matching Claude Code's default `GrepTool`
 * `head_limit`.
 */
export const GREP_MAX_MATCHES = 250

/**
 * Default cap in bytes on one matched-line preview (the `grepMaxLineBytes`
 * config); the cut preserves UTF-8 boundaries.
 */
export const GREP_MAX_LINE_BYTES = 2000

/**
 * Default cap on the `context` argument (the `grepMaxContext` config): lines
 * shown before and after each match.
 */
export const GREP_MAX_CONTEXT = 10

/**
 * Default cap on the rendered rows one `grep` call with context retains inline
 * (the `grepMaxContextRows` config): match rows plus context rows. Matches past
 * it go to the formatted spill file like matches past the match cap.
 */
export const GREP_MAX_CONTEXT_ROWS = 200

/**
 * Default budget, in rendered bytes (`Line N: ` rows over matches and their
 * context lines), that one `grep` call with context retains inline (the
 * `grepMaxContextBytes` config). Matches past it go to the formatted spill file
 * like matches past the row cap. At 200 rows of 2,000-byte previews the row cap
 * alone let about 400 KB inline; broad context greps of 8-10K characters were the
 * largest replayed items on the bench.
 */
export const GREP_MAX_CONTEXT_BYTES = 6144

/** Resolved grep-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GrepToolCaps {
  /** Max flat matches retained inline; later matches go to the formatted spill file. */
  maxMatches: number
  /** Max bytes retained per matched-line preview. */
  maxLineBytes: number
  /** Largest accepted `context` argument (lines before and after each match). */
  maxContext?: number
  /** Max rendered rows (matches plus context lines) retained inline for a call with context. */
  maxContextRows?: number
  /** Max rendered bytes (matches plus context lines) retained inline for a call with context. */
  maxContextBytes?: number
  /** Max bytes of serialized `presentationMeta`; trailing file groups drop past it. */
  maxMetaBytes: number
  /** Cap on the complete raw `rg` stdout the tool will parse. */
  rawOutputMaxBytes: number
  /** Terminate-escalation grace period (ms) for the search process. */
  graceMs: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

/** Validated `grep` arguments. */
export interface GrepInput {
  pattern: string
  path?: string
  include?: string
  /** Lines of context before and after each match; 0 or absent means none. */
  context?: number
}

/** The raw `grep` arguments after schema validation. */
export interface GrepArgs {
  pattern: string
  path?: string
  include?: string
  context?: number
}

/** The canonical `grep` value: every match, plus every context line when context was requested. */
export interface GrepValue {
  matches: GrepMatch[]
  /** Present only for a call with context, so a call without it keeps its exact value. */
  context?: GrepMatch[]
}

/**
 * Reject an `include` that is not ONE positive glob filter: blank strings,
 * negated patterns (`!…`), and comma-separated lists. A comma inside a brace
 * group is fine — `*.{ts,tsx}` is one glob with alternation, not a list.
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error(modelText('foundation/tool-fs-search-grep/text-01'))
  if (include.startsWith('!')) throw new Error(modelText('runtime/tool-fs-search-grep/text-01'))
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error(modelText('runtime/tool-fs-search-grep/text-02'))
    }
  }
}

/**
 * Validate value constraints the schema DSL can't express: a non-EMPTY
 * `pattern` (whitespace is a legitimate regex), a non-blank `path` when given,
 * a single positive `include` glob ({@link GrepInput}), and an integer
 * `context` from 0 to `maxContext`. Throws a plain `Error` (an ordinary tool
 * argument error) otherwise.
 *
 * @param args - the schema-validated `grep` arguments.
 * @param maxContext - the largest accepted `context` (the `grepMaxContext` config).
 * @returns the accepted input, unchanged.
 */
export function parseGrepArgs(args: GrepArgs, maxContext = GREP_MAX_CONTEXT): GrepInput {
  if (args.pattern.length === 0) throw new Error(modelText('foundation/tool-fs-search-grep/text-02'))
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error(modelText('foundation/tool-fs-search-grep/text-03'))
  if (args.include !== undefined) validateInclude(args.include)
  if (args.context !== undefined && (!Number.isInteger(args.context) || args.context < 0 || args.context > maxContext)) {
    throw new Error(modelText('tools/grep/context-invalid', { max_context: maxContext }))
  }
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
    ...args.context !== undefined ? { context: args.context } : {},
  }
}

/** The context distance a call asked for: its `context` when a positive integer, else 0. */
function requestedContext(args: { context?: unknown }): number {
  const { context } = args
  return typeof context === 'number' && Number.isInteger(context) && context > 0 ? context : 0
}

/**
 * Build the fixed line-oriented `rg --json` argv for one `grep` call. Every
 * model-controlled value ({@link GrepInput.pattern}, {@link GrepInput.path},
 * {@link GrepInput.include}) is a plain argv element — no shell layer exists,
 * so no quoting applies; the pattern and include ride in `--flag=value` form
 * and the target behind `--`, so a leading-dash value can never be parsed as
 * a flag. A positive {@link GrepInput.context} adds `--context=N`; without
 * one the argv is exactly the context-free command.
 *
 * @param input - the validated arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.context !== undefined && input.context > 0) parts.push(`--context=${String(input.context)}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * The uniform malformed-output failure: raw `rg --json` is an internal
 * transport, so missing or invalid response fields cause a search failure, not a partial result.
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(modelText('foundation/tool-fs-search-grep/text-04', { value_1: String(detail) }), 'SEARCH_FAILED', cause !== undefined ? { cause } : undefined)
}

/**
 * Parse one `rg --json` NDJSON line into a match or a context line,
 * `undefined` for the framing record types (`begin`/`end`/`summary`). A line
 * that is not JSON, or a `match` or `context` record missing its path / line
 * number / line content, throws {@link SearchError} `SEARCH_FAILED`. A line
 * that is not valid UTF-8 (ripgrep sends base64 `bytes` instead of `text`)
 * yields a placeholder preview rather than failing the whole search.
 */
function parseRecord(line: string): { kind: 'match' | 'context'; row: GrepMatch } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformedRecord('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformedRecord('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  // Other record types (begin/end/summary — and any future type) are
  // transport framing, not results: skipped, not malformed.
  if (record.type !== 'match' && record.type !== 'context') return undefined
  const kind = record.type
  if (typeof record.data !== 'object' || record.data === null) throw malformedRecord(`a ${kind} record has no data`)
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null ? (data.path as { text?: unknown }).text : undefined
  if (typeof pathText !== 'string') throw malformedRecord(`a ${kind} record has no path text`)
  if (typeof data.line_number !== 'number') throw malformedRecord(`a ${kind} record has no line number`)
  if (typeof data.lines !== 'object' || data.lines === null) throw malformedRecord(`a ${kind} record has no line content`)
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string') {
    return { kind, row: { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, '') } }
  }
  if (typeof lines.bytes === 'string') {
    return { kind, row: { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)' } }
  }
  throw malformedRecord(`a ${kind} record has neither line text nor bytes`)
}

/**
 * Parse complete `rg --json` stdout into flat matches and context lines, each
 * in output order (ripgrep emits one file's records contiguously). Context
 * records are validated like match records.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @returns the flat matches and context lines; empty for output with no such records.
 */
export function parseGrepRecords(stdout: string): { matches: GrepMatch[]; context: GrepMatch[] } {
  const matches: GrepMatch[] = []
  const context: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const record = parseRecord(line)
    if (record === undefined) continue
    if (record.kind === 'match') matches.push(record.row)
    else context.push(record.row)
  }
  return { matches, context }
}

/**
 * Parse complete `rg --json` stdout into flat matches, in output order (ripgrep
 * emits one file's matches contiguously). Context lines are not returned.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @returns the flat matches; empty for output with no match records.
 */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  return parseGrepRecords(stdout).matches
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/** Group rows by file in first-seen order. */
function groupByFile(rows: GrepMatch[]): Map<string, GrepMatch[]> {
  const byFile = new Map<string, GrepMatch[]>()
  for (const row of rows) {
    const group = byFile.get(row.path)
    if (group !== undefined) group.push(row)
    else byFile.set(row.path, [row])
  }
  return byFile
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body:
 * each file's display path, then one `Line N: <text>` row per match. With
 * `context` (a call that asked for context lines, even when none came back),
 * each file's matches and context lines are merged in line order, a context
 * line reads `Line N- <text>`, and a `--` line separates non-adjacent blocks.
 *
 * @param matches - the flat matches to render.
 * @param context - the context lines to merge in, or `undefined` for a call without context.
 * @returns the grouped body text.
 */
export function formatGrepMatches(matches: GrepMatch[], context?: GrepMatch[]): string {
  const sections: string[] = []
  if (context === undefined) {
    for (const [path, group] of groupByFile(matches)) {
      sections.push(`${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
    }
    return sections.join('\n\n')
  }
  const contextByFile = groupByFile(context)
  for (const [path, group] of groupByFile(matches)) {
    const rows = [
      ...group.map(row => ({ row, separator: ':' })),
      ...(contextByFile.get(path) ?? []).map(row => ({ row, separator: '-' })),
    ].sort((a, b) => a.row.lineNumber - b.row.lineNumber)
    const lines: string[] = []
    let previous: number | undefined
    for (const { row, separator } of rows) {
      if (previous !== undefined && row.lineNumber > previous + 1) lines.push('--')
      lines.push(`Line ${row.lineNumber}${separator} ${row.line}`)
      previous = row.lineNumber
    }
    sections.push(`${path}\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Format the model-facing `grep` result: a found-count header (matches only),
 * the retained matches grouped by file (with their context lines when the call
 * asked for context), then — when the result was capped — a footer carrying
 * either the formatted-spill recovery locator or the could-not-save
 * explanation. The omitted count is a budget fact: the search itself completed.
 *
 * @param retained - the retention outcome over every parsed match.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @param context - the retained context lines, or `undefined` for a call without context.
 * @returns the model-facing text.
 */
export function formatGrepOutput(retained: RetainedItems<GrepMatch>, spillRef: SpillRef | undefined, context?: GrepMatch[]): string {
  const header = retained.truncated
    ? `Found ${retained.kept} of ${retained.seen} matches`
    : `Found ${retained.seen} ${matchNoun(retained.seen)}`
  const body = formatGrepMatches(retained.items, context)
  if (!retained.truncated) return modelText('foundation/tool-fs-search-grep/text-05', { value_1: String(header), value_2: String(body) })
  const recovery = spillRef !== undefined
    ? `Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : modelText('runtime/tool-fs-search-grep/text-03')
  return modelText('foundation/tool-fs-search-grep/text-06', { value_1: String(header), value_2: String(body), value_3: String(recovery) })
}

/**
 * The single inline retention of one `grep` value, shared by the render, the
 * search card and the post-execute spill: the match cap, and for a call with
 * context also the rendered-row cap.
 *
 * @param value - the canonical `grep` value.
 * @param args - the call's arguments (their `context` sets the block width).
 * @param caps - the resolved caps.
 * @returns the retained matches and context lines.
 */
export function retainGrep(value: GrepValue, args: { context?: unknown }, caps: GrepToolCaps): RetainedGrep {
  const context = value.context === undefined ? 0 : requestedContext(args)
  return retainGrepWithContext(value.matches, value.context ?? [], context, {
    maxMatches: caps.maxMatches,
    maxRows: caps.maxContextRows ?? GREP_MAX_CONTEXT_ROWS,
    maxBytes: caps.maxContextBytes ?? GREP_MAX_CONTEXT_BYTES,
    maxLineBytes: caps.maxLineBytes,
  })
}

/** Format one already-retained result for the Native surface. */
function formatRetainedGrep(retained: RetainedGrep, withContext: boolean, spillRef?: SpillRef): string {
  if (retained.matches.seen === 0) return modelText('foundation/tool-fs-search-grep/text-07')
  return formatGrepOutput(retained.matches, spillRef, withContext ? retained.context : undefined)
}

/**
 * Pending-call presentation: a search card titled by the pattern (and target /
 * include filter).
 *
 * @param args - the raw tool arguments; `pattern`, `path`, and `include` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGrepCall(args: { pattern: string; path?: string; include?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined ? ` (${args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (matches grouped by file, with the truncation signal). A UI
 * without a search card falls back to the raw `tool/result` content, so the view
 * carries no result text of its own. Malformed or absent metadata (an obsolete or
 * hand-edited replayed log) falls back to the generic card.
 *
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the projected metadata.
 * @returns the search card view, or `undefined` for the generic fallback.
 */
export function presentGrepResult(
  _args: { pattern: string; path?: string; include?: string },
  result: ToolResult,
): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'matches') return undefined
  return view
}

/**
 * Register the `grep` tool and its scope-aware system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param caps - the deployment's resolved grep caps (plugin config after defaulting).
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps): void {
  const maxContext = caps.maxContext ?? GREP_MAX_CONTEXT
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : modelText('runtime/tool-fs-search-grep/text-04'),
  })

  const tool = defineTool({
    name: 'grep',
    description: modelText('runtime/tool-fs-search-grep/text-05', { value_1: String(caps.maxMatches), max_context: maxContext }),
    parameters: {
      pattern: { type: 'string', required: true, description: modelText('runtime/tool-fs-search-grep/text-06') },
      path: { type: 'string', description: modelText('runtime/tool-fs-search-grep/text-07') },
      include: { type: 'string', description: modelText('runtime/tool-fs-search-grep/text-08') },
      context: { type: 'integer', description: modelText('tools/grep/context', { max_context: maxContext }) },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
          context: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatRetainedGrep(retainGrep(value, args, caps), withContext(value, args)),
      }],
      presentationMeta: (args, value) => grepSearchMeta(retainGrep(value, args, caps).matches, caps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args, maxContext)
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      const contextRequested = input.context !== undefined && input.context > 0
      if (run.noMatches) return contextRequested ? { matches: [], context: [] } : { matches: [] }

      const relative = (raw: GrepMatch): GrepMatch => ({
        path: toWorkdirRelative(raw.path, run.workdir),
        lineNumber: raw.lineNumber,
        line: raw.line,
      })
      const records = parseGrepRecords(run.stdout)
      const matches = records.matches.map(relative)
      return contextRequested ? { matches, context: records.context.map(relative) } : { matches }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as GrepValue | undefined
    if (value === undefined) return decision
    const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as { context?: unknown } : {}
    const retained = retainGrep(value, args, caps)
    if (!retained.matches.truncated) return decision
    const contextMode = withContext(value, args)
    // The spill artifact holds the COMPLETE result: preview each line, but keep
    // every match and context line (no inline cap), so the recovery file is the full search.
    const preview = (row: GrepMatch): GrepMatch => ({ ...row, line: previewLine(row.line, caps.maxLineBytes) })
    const matches = value.matches
    const spillRef = await trySaveFormattedResult(
      ctx,
      exec,
      'grep-results.txt',
      `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(matches.map(preview), contextMode ? (value.context ?? []).map(preview) : undefined)}`,
    )
    return {
      kind: 'accept',
      content: [{
        type: 'text',
        text: formatRetainedGrep(retained, contextMode, spillRef),
      }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}

/** Whether a result renders in the context format: the call asked for context and its value carries context lines. */
function withContext(value: GrepValue, args: { context?: unknown }): boolean {
  return value.context !== undefined && requestedContext(args) > 0
}
