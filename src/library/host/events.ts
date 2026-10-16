/**
 * Projection of the durable journal into HostEvents, shared by live delivery and history so both
 * carry the same events at the same journal-anchored sequence numbers.
 */
import type { ContentBlock, MessageId, TokenUsage } from "../model/llm/index.ts"
import type { SessionEvent, TurnEndReason } from "../session/journal/index.ts"
import type { FileDiff, FileLocation, FileView, ToolCallView, ToolDefinition, ToolResultView } from "../tools/index.ts"
import type { ImageAttachmentRef } from "../context/attachments/attachment/index.ts"
import type { HostDiff, HostEndReason, HostEventBody, HostFileView, HostInput, HostLocation, HostToolKind } from './types.ts'
import type { LlmRetryEventData } from '../model/retry/types.ts'
import type { JsonValue } from '../util/values/index.ts'

declare module "../session/journal/types.ts" {
  interface SessionEventMap {
    /**
     * A host admitted one user prompt under its own idempotency key. Log-only: it names the
     * following `user/message` with `messageId` and never enters the model surface.
     */
    'host/turn': { turnId: string; messageId: MessageId; digest: string; model?: string; metadata?: JsonValue }
    /** A delegated retry observed by its owning root; log-only and never a root model retry. */
    'host/child-retry': { sessionId: string; sourceSeq: number; retry: LlmRetryEventData }
    /** Idempotent steering admission in the same journal as the agent inbox. */
    'host/steer': { steerId?: string; turnId?: string; activityId?: string; messageId: MessageId; digest: string; metadata?: JsonValue }
  }
}

/** Sequence numbers reserved per journal event; `seq / SEQ_BLOCK` is a journal event count. */
export const SEQ_BLOCK = 1_048_576
/** Most events one journal event projects to (a failed turn end: `error` then `end`). */
export const MAX_PROJECTED = 4

/**
 * The cursor that follows every event projected from the first `count` journal events and precedes
 * every live event emitted while the journal held exactly `count` events.
 * @param count - durable journal event count.
 * @returns the journal-anchored cursor.
 */
export function journalCursor(count: number): number { return count * SEQ_BLOCK }

/**
 * Sequence number of one event projected from a journal event.
 * @param journalSeq - the source event's journal seq.
 * @param index - position among that event's projections.
 * @param total - number of projections of that event.
 * @returns a seq in the top of the source event's block, ending at `journalCursor(journalSeq + 1)`.
 */
export function projectedSeq(journalSeq: number, index: number, total: number): number {
  return journalCursor(journalSeq + 1) - total + 1 + index
}

/** What a projection needs from the runtime: tool presenters and stored image locations. */
export interface ProjectionRuntime {
  tool(name: string): Pick<ToolDefinition, 'presentCall' | 'presentResult'> | undefined
  imagePath(ref: ImageAttachmentRef): string | undefined
}

/** A projected body plus the submitted turn it belongs to. */
export type Projected = HostEventBody & { turn_id?: string }

const DETAIL_MAX = 1000
const OUTPUT_MAX = 4000
const SUMMARY_MAX = 200
const DIFF_MAX = 32000
const VIEW_TITLE_MAX = 200
const VIEW_RANGES_MAX = 32
const VIEW_FOLDS_MAX = 64

/** Fold over one session's journal in order; one instance per session and delivery path. */
export class JournalProjection {
  private turnId: string | undefined
  private readonly hostTurns = new Map<string, { id: string; metadata?: JsonValue }>()
  private readonly hostSteers = new Map<string, { metadata?: JsonValue }>()
  private firstStep: number | null | undefined
  private step: number | undefined
  private opened = false
  private readonly calls = new Map<string, { name: string; args: unknown; view: ToolCallView | undefined }>()

  constructor(private readonly runtime: ProjectionRuntime) {}

  /** The submitted turn now running, for live events between journal events. */
  get currentTurn(): string | undefined { return this.turnId }

  /**
   * Project one journal event; at most {@link MAX_PROJECTED} bodies, a pure function of the fold.
   * @param event - the next journal event of this session.
   * @returns projected bodies in order.
   */
  project(event: SessionEvent): Projected[] {
    switch (event.type) {
      case 'question/state':
        return [{ type: 'question_state', question: event.data }]
      case 'host/turn':
        this.hostTurns.set(event.data.messageId, { id: event.data.turnId, ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }) })
        return []
      case 'host/steer':
        this.hostSteers.set(event.data.messageId, { ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }) })
        return []
      case 'turn/start':
        this.firstStep = null
        this.opened = false
        return []
      case 'step/start':
        if (this.firstStep === null) this.firstStep = event.data.step
        this.step = event.data.step
        return []
      case 'user/message': {
        if (event.surfaceOp !== 'append' || event.data.source.kind !== 'user') return []
        const admitted = this.hostTurns.get(event.data.id)
        const steered = this.hostSteers.get(event.data.id)
        const turnId = admitted?.id
        this.hostTurns.delete(event.data.id)
        this.hostSteers.delete(event.data.id)
        const input = this.input(event.data.content)
        if (turnId !== undefined || (steered === undefined && !this.opened && this.step === this.firstStep)) {
          this.opened = true
          if (turnId !== undefined) this.turnId = turnId
          return [this.tag({ type: 'turn', input, ...(admitted?.metadata === undefined ? {} : { metadata: admitted.metadata }) })]
        }
        return [this.tag({ type: 'steered', input, ...(steered?.metadata === undefined ? {} : { metadata: steered.metadata }) })]
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') return []
        const out: Projected[] = []
        const text = joined(event.data.message.content, 'text')
        const reasoning = joined(event.data.message.content, 'reasoning')
        if (text !== '' || reasoning !== '') {
          out.push(this.tag({ type: 'message', text, reasoning, ...(event.data.interrupted === true ? { interrupted: true as const } : {}) }))
        }
        if (event.data.usage !== undefined) out.push(this.tag(usage(event.data.usage)))
        return out
      }
      case 'tool/call': {
        const args = parseArguments(event.data.arguments)
        const view = present(() => this.runtime.tool(event.data.name)?.presentCall?.(args))
        this.calls.set(String(event.data.callId), { name: event.data.name, args, view })
        return [this.tag(toolStart(String(event.data.callId), event.data.name, view))]
      }
      case 'tool/result': {
        if (event.surfaceOp !== 'append') return []
        const block = event.data.message
        const callId = String(block.toolCallId)
        const call = this.calls.get(callId)
        this.calls.delete(callId)
        const name = call?.name ?? 'tool'
        const result = { content: block.content, isError: block.isError === true, ...(event.data.meta === undefined ? {} : { meta: event.data.meta }) }
        const view = present(() => this.runtime.tool(name)?.presentResult?.(call?.args, result))
        return [this.tag(toolEnd(callId, name, call?.view, result, view))]
      }
      case 'llm/retry': {
        const retry = event.data
        return [this.tag({ type: 'retry', attempt: retry.retry, ...(retry.mode === 'normal' ? { max_attempts: retry.maxRetries } : {}),
          delay_ms: retry.delayMs, code: retry.failure.code, message: cut(retry.failure.message, SUMMARY_MAX) })]
      }
      case 'host/child-retry': {
        const { sessionId, sourceSeq, retry } = event.data
        // A background child can retry during a different root turn: do not misattribute it.
        return [{ type: 'retry', child_session_id: sessionId, child_seq: sourceSeq,
          attempt: retry.retry, ...(retry.mode === 'normal' ? { max_attempts: retry.maxRetries } : {}),
          delay_ms: retry.delayMs, code: retry.failure.code, message: cut(retry.failure.message, SUMMARY_MAX) }]
      }
      case 'background/job': {
        const job = event.data
        const ended = job.status === 'completed' ? 'finished' : job.status ?? 'finished'
        return [this.tag({ type: 'job', job_id: job.job, event: job.event === 'started' ? 'started' : ended, label: cut(job.label, DETAIL_MAX),
          ...(job.event === 'ended' && job.detail !== undefined && job.detail !== '' ? { detail: cut(job.detail, SUMMARY_MAX) } : {}),
          ...(job.event === 'ended' && job.exitCode !== undefined ? { exit_code: job.exitCode } : {}), at: job.at })]
      }
      case 'background/watch': {
        const watch = event.data
        return [this.tag({ type: 'watcher', watch_id: watch.watcher, event: watch.event, waits_for: cut(watch.description, DETAIL_MAX),
          deadline: watch.deadline, ...(watch.result === undefined ? {} : { result: cut(watch.result, DETAIL_MAX) }), at: watch.at })]
      }
      case 'turn/end': {
        const out: Projected[] = []
        const reason = event.data.reason
        if (reason.kind === 'error') out.push(this.tag({ type: 'error', code: reason.error.code, message: reason.error.message }))
        out.push(this.tag({ type: 'end', reason: endReason(reason) }))
        this.turnId = undefined
        this.firstStep = undefined
        this.step = undefined
        this.opened = false
        this.calls.clear()
        return out
      }
      default:
        return []
    }
  }

  private tag(body: HostEventBody): Projected {
    return this.turnId === undefined ? body : { ...body, turn_id: this.turnId }
  }

  private input(content: readonly ContentBlock[]): HostInput {
    const images = content.flatMap(block => block.type !== 'image' ? [] : [image(block.attachment, this.runtime.imagePath(block.attachment))])
    return { text: joined(content, 'text', '\n\n'), images }
  }
}

/**
 * Map a tool's declared presentation to the host kind vocabulary.
 * @param view - the call-time view, when the tool declares one.
 * @returns the host tool kind.
 */
export function toolKind(view: ToolCallView | undefined): HostToolKind {
  if (view === undefined) return 'other'
  if (view.card === 'terminal') return 'command'
  if (view.card === 'diff') return view.diffs.some(diff => diff.oldText !== null) ? 'edit' : 'write'
  switch (view.kind) {
    case undefined: return 'other'
    case 'execute': return 'command'
    case 'delete':
    case 'move': return 'write'
    default: return view.kind
  }
}

/**
 * A streaming call's preview, from the tool's call presentation over its arguments so far; only a change to files
 * (a diff card naming each file) previews.
 * @param callId - the call being written.
 * @param name - its tool.
 * @param view - the tool's call-time view of the arguments so far.
 * @returns the live body, or undefined.
 */
export function toolPreview(callId: string, name: string, view: ToolCallView | undefined): HostEventBody | undefined {
  if (view?.card !== 'diff' || !view.diffs.length || view.diffs.some(diff => typeof diff.path !== 'string' || !diff.path || typeof diff.newText !== 'string')) return undefined
  return { type: 'tool_preview', call_id: callId, tool: name, kind: toolKind(view), title: view.title ?? name, diffs: view.diffs.map(boundDiff), locations: locations(view) }
}

function toolStart(callId: string, name: string, view: ToolCallView | undefined): Projected {
  const detail = view?.card === 'terminal' ? view.description
    : view?.card === 'generic' && view.rawInput !== undefined ? preview(view.rawInput) : undefined
  return { type: 'tool_start', call_id: callId, tool: name, kind: toolKind(view), title: view?.title ?? name,
    ...(detail === undefined || detail === '' ? {} : { detail: cut(detail, DETAIL_MAX) }), locations: locations(view) }
}

function toolEnd(callId: string, name: string, call: ToolCallView | undefined,
  result: { content: ContentBlock[]; isError: boolean }, view: ToolResultView | undefined): Projected {
  const raw = joined(result.content, 'text')
  const output = view?.card === 'terminal' ? view.output ?? ''
    : view?.card === 'generic' && view.content !== undefined ? joined(view.content, 'text') : raw
  const diffs = view?.card === 'diff' ? view.diffs.map(boundDiff) : undefined
  const exit = view?.card === 'terminal' && view.exitCode !== undefined ? { exit_code: view.exitCode } : {}
  return { type: 'tool_end', call_id: callId, tool: name, kind: toolKind(call), ok: !result.isError,
    title: view?.title ?? call?.title ?? name, summary: cut(firstLine(output === '' ? raw : output), SUMMARY_MAX),
    ...(output === '' ? {} : { output: cut(output, OUTPUT_MAX) }), ...exit,
    ...(view?.card === 'generic' && view.image !== undefined ? { image: view.image } : {}),
    ...(view?.card === 'generic' && view.show !== undefined ? { show: fileView(view.show) } : {}),
    ...(diffs === undefined || diffs.length === 0 ? {} : { diffs }), locations: locations(call) }
}

function locations(view: ToolCallView | undefined): HostLocation[] {
  if (view === undefined || view.card === 'terminal') return []
  const listed: FileLocation[] = view.locations ?? (view.card === 'diff' ? view.diffs.map(diff => ({ path: diff.path })) : [])
  return listed.map(location => location.line === undefined ? { path: location.path } : { path: location.path, line: location.line })
}

/** A tool's file view, bounded: a cut label, at most 32 focus regions and 64 folds, positions that are positive integers. */
function fileView(view: FileView): HostFileView {
  const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
  const position = (value: { line: number; column: number } | undefined) => value !== undefined && whole(value.line) && whole(value.column)
  const ranges = view.ranges?.filter(range => position(range.start) && position(range.end)).slice(0, VIEW_RANGES_MAX)
    .map(({ start, end }) => ({ start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column } }))
  const folds = view.folds?.filter(fold => whole(fold.start) && whole(fold.end) && fold.end >= fold.start).slice(0, VIEW_FOLDS_MAX)
    .map(({ start, end }) => ({ start, end }))
  return { path: view.path, ...(typeof view.revision === 'string' && view.revision.length <= 128 ? { revision: view.revision } : {}),
    ...(view.title === undefined || view.title === '' ? {} : { title: cut(view.title, VIEW_TITLE_MAX) }),
    ...(ranges?.length ? { ranges } : {}), ...(folds?.length ? { folds } : {}) }
}

function boundDiff(diff: FileDiff): HostDiff {
  const truncated = diff.newText.length > DIFF_MAX || (diff.oldText?.length ?? 0) > DIFF_MAX
  return { path: diff.path, old: diff.oldText === null ? null : cut(diff.oldText, DIFF_MAX), new: cut(diff.newText, DIFF_MAX),
    ...(truncated ? { truncated: true as const } : {}) }
}

function usage(value: TokenUsage): HostEventBody {
  const cached = value.cacheReadTokens ?? 0
  return { type: 'usage', input: value.inputTokens + cached + (value.cacheWriteTokens ?? 0), cached, output: value.outputTokens,
    ...(value.reasoningTokens === undefined ? {} : { reasoning: value.reasoningTokens }) }
}

function endReason(reason: TurnEndReason): HostEndReason {
  switch (reason.kind) {
    case 'completed': return 'done'
    case 'aborted': return 'cancelled'
    case 'max-tokens': return 'max_tokens'
    case 'interrupted': return 'interrupted'
    case 'blocked': return 'blocked'
    default: return 'error'
  }
}

function image(ref: ImageAttachmentRef, path: string | undefined): HostInput['images'][number] {
  return { media_type: ref.mediaType, width: ref.width, height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }), ...(path === undefined ? {} : { path }) }
}

function joined(content: readonly ContentBlock[], type: 'text' | 'reasoning', separator = ''): string {
  return content.flatMap(block => block.type === type ? [block.text] : []).join(separator)
}

function parseArguments(raw: string): unknown {
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

/** Presenters are pure but tool-owned; a throwing presenter falls back to the generic rendering. */
function present<T>(call: () => T | undefined): T | undefined {
  try { return call() } catch { return undefined }
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' } catch { return '' }
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
