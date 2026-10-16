/** Package-owned durable workflow-record invariants. @module io-agent/tool-workflow/invariant */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type { Session, SessionEvent } from "../../session/journal/index.ts"
import type { InvariantFailure, InvariantInstaller } from "../../runtime/invariants/index.ts"
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-workflow'

/** Cordis companion plugin name. */
export const name = 'tool-workflow-invariant'
/** Services required to validate existing and newly appended Session logs. */
export const inject = ['invariants']

interface RunTrace {
  ended: boolean
  readonly members: Map<number, boolean>
}

type WorkflowTrace = Map<string, RunTrace>

/** Whether this package owns the candidate Session event. */
function isWorkflowRecordEvent(event: SessionEvent): boolean {
  return event.type.startsWith('tool-workflow/')
}

/** Require a durable opaque identity to be a non-empty string. */
function stringId(value: unknown, label: string, fail: InvariantFailure): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

/** Require one workflow member's 1-based sequence identity. */
function memberSeq(value: unknown, fail: InvariantFailure): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('tool-workflow member seq must be a positive safe integer')
  }
  return value as number
}

/** Read one plain payload field without trusting restored plugin data. */
function recordOf(event: SessionEvent, fail: InvariantFailure): Record<string, unknown> {
  const data: unknown = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${event.type} data must be a JSON object`)
  }
  return data as Record<string, unknown>
}

/** Copy only the run one candidate can mutate; other committed states stay shared. */
function cloneTraceForEvent(
  source: WorkflowTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): WorkflowTrace {
  const trace = new Map(source)
  if (event.type === 'tool-workflow/run-start') return trace
  const data = recordOf(event, fail)
  const runId = stringId(data.runId, `${event.type} runId`, fail)
  const run = source.get(runId)
  if (run !== undefined) {
    trace.set(runId, { ended: run.ended, members: new Map(run.members) })
  }
  return trace
}

/** Require the named run to exist and remain open. */
function openRun(trace: WorkflowTrace, runId: string, eventType: string, fail: InvariantFailure): RunTrace {
  const run = trace.get(runId)
  if (run === undefined) fail(modelText('runtime/tool-workflow-invariant/text-01', { value_1: String(eventType), value_2: String(runId) }))
  if (run.ended) fail(modelText('runtime/tool-workflow-invariant/text-02', { value_1: String(eventType), value_2: String(runId) }))
  return run
}

/** Advance the workflow-record fold with one relevant Session event. */
function applyEvent(trace: WorkflowTrace, event: SessionEvent, fail: InvariantFailure): void {
  const data = recordOf(event, fail)
  const runId = stringId(data.runId, `${event.type} runId`, fail)

  switch (event.type) {
    case 'tool-workflow/run-start': {
      if (typeof data.name !== 'string' || data.name.length === 0) {
        fail('tool-workflow/run-start name must be a non-empty string')
      }
      if (trace.has(runId)) fail(`tool-workflow/run-start repeats run ${runId}`)
      trace.set(runId, { ended: false, members: new Map() })
      return
    }
    case 'tool-workflow/agent-start': {
      const run = openRun(trace, runId, event.type, fail)
      const seq = memberSeq(data.seq, fail)
      if (typeof data.label !== 'string') fail('tool-workflow/agent-start label must be a string')
      if (data.phase !== undefined && typeof data.phase !== 'string') {
        fail('tool-workflow/agent-start phase must be a string when present')
      }
      stringId(data.childId, 'tool-workflow/agent-start childId', fail)
      if (run.members.has(seq)) fail(modelText('runtime/tool-workflow-invariant/text-03', { value_1: String(seq), value_2: String(runId) }))
      run.members.set(seq, false)
      return
    }
    case 'tool-workflow/agent-end': {
      const run = openRun(trace, runId, event.type, fail)
      const seq = memberSeq(data.seq, fail)
      if (data.outcome !== 'completed' && data.outcome !== 'failed' && data.outcome !== 'cancelled') {
        fail(`tool-workflow/agent-end outcome ${String(data.outcome)} is invalid`)
      }
      const ended = run.members.get(seq)
      if (ended === undefined) fail(modelText('runtime/tool-workflow-invariant/text-04', { value_1: String(seq), value_2: String(runId) }))
      if (ended) fail(modelText('runtime/tool-workflow-invariant/text-05', { value_1: String(seq), value_2: String(runId) }))
      run.members.set(seq, true)
      return
    }
    case 'tool-workflow/run-end': {
      const run = openRun(trace, runId, event.type, fail)
      if (data.stopReason !== 'completed' && data.stopReason !== 'cancelled' && data.stopReason !== 'error') {
        fail(`tool-workflow/run-end stopReason ${String(data.stopReason)} is invalid`)
      }
      const openMembers = [...run.members].filter(([, ended]) => !ended).map(([seq]) => seq)
      if (openMembers.length > 0) {
        fail(modelText('runtime/tool-workflow-invariant/text-06', { value_1: String(openMembers.join(', ')), value_2: String(runId) }))
      }
      run.ended = true
      run.members.clear()
      return
    }
    default:
      fail(`unknown tool-workflow event type ${event.type}`)
  }
}

/** Install an independent incremental fold over every attached Session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, WorkflowTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: WorkflowTrace }>()

  const seed = (session: Session): WorkflowTrace => {
    const trace: WorkflowTrace = new Map()
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents().filter(isWorkflowRecordEvent)) applyEvent(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  ctx.sessions.list().forEach(seed)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isWorkflowRecordEvent(event)) return
    // session/event dispatch follows list() or session/created seeding.
    const trace = cloneTraceForEvent(traces.get(session) as WorkflowTrace, event, fail)
    applyEvent(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!isWorkflowRecordEvent(event)) return
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact session/event callback arguments. */
    if (candidate === undefined || candidate.session !== session) {
      return fail(modelText('runtime/tool-workflow-invariant/text-07'))
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
