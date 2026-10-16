/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module io-agent/loop
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from "./library/runtime/agents/index.ts"
import { agentEvents, assembleContextFor } from "./library/runtime/agents/index.ts"
import {
  LlmError,
  errorChain,
} from "./library/model/llm/index.ts"
import type { Scope } from "./library/runtime/scope/index.ts"
import { createScope } from "./library/runtime/scope/index.ts"
import type { Session, SessionId, TurnEndReason, UserMessage } from "./library/session/journal/index.ts"
import { joinContextSections, renderContextSections } from "./library/context/assembly/index.ts"
import type {} from "./library/session/projection/index.ts"
import type { Context } from "./library/runtime/vendor/cordis/index.ts"
import { ReactLoopInbox } from "./library/runtime/inbox.ts"
import { RuntimeContextProjection } from "./library/context/projection.ts"
import { RequestBuilder } from './library/model/request.ts'
import { ResponseReceiver } from './library/model/response.ts'
import { executeToolCalls } from './library/tools/execute.ts'
import { ToolCallRecovery } from './library/session/journal/repair.ts'
import { outputLimitNotice } from './library/runtime/output-limit.ts'
import type { RequestErrorAction } from './library/runtime/agents/index.ts'
import type { StepEndReason } from './library/runtime/decisions.ts' 
import type { PreparedStep } from './library/runtime/decisions.ts'

function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      throw new Error(`Unknown cancellation cause: ${String((cause as { kind: string }).kind)}`)
  }
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  private readonly runtimeContext: RuntimeContextProjection
  private readonly requests: RequestBuilder
  private readonly responses: ResponseReceiver

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch)
    /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.requests = new RequestBuilder(loopCtx, this, this.dispatch)
    this.responses = new ResponseReceiver(loopCtx, this, this.dispatch)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    // The snapshot is projected in the waterfall's default, after listeners
    // such as pressure compaction have run: a compaction that condensed the
    // retained snapshot must not leave this step's request without one.
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => {
        const context = this.runtimeContext.project(joinContextSections(sections), sections)
        return Promise.resolve<PreStepDecision>({
          kind: 'enter',
          messages: context === undefined ? claimed : [...claimed, context],
        })
      },
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    return { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    // Consecutive cut-off steps continued in this turn (output-limit recovery).
    let outputLimitRecoveries = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        let continueCutOff = false
        const recovery = new ToolCallRecovery()
        const stopRecovery = this.loopCtx.on('session/event', (session, event) => {
          if (session === this.session) recovery.observe(event)
        })
        try {
          const stepEnd = await this.step(decision, turn, step, signal)
          // A response cut off at its output limit ran none of its tool calls.
          // Within the configured bound the turn continues at the same budget
          // with a notice asking for a smaller step, instead of ending.
          continueCutOff = stepEnd?.kind === 'max-tokens'
            && outputLimitRecoveries < this.loopCtx.agentLoop.config.outputLimitRecoveries
          if (stepEnd?.kind !== 'max-tokens') outputLimitRecoveries = 0
          // max-tokens is sticky: once an unrecovered step hits the ceiling,
          // later steps that complete normally must not downgrade the turn outcome.
          if (!continueCutOff && (turnEnds === null || turnEnds.kind !== 'max-tokens')) turnEnds = stepEnd
        } finally {
          try {
            // Also close complete calls from output-truncated responses: they were
            // advertised but deliberately not dispatched. Never retry them here.
            for (const event of recovery.results()) {
              this.session.append('tool/result', event.data, {
                surfaceOp: 'append',
                ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
              })
            }
          } finally { stopRecovery() }
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (continueCutOff) {
          outputLimitRecoveries++
          // A durable inbox splice, like a tool's additional context: the next
          // step claims it as its user message, so history stays append-only.
          this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [outputLimitNotice()])
          target = 'next-step'
          continue
        }
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: abortedCancelCause(signal)! }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>, turn: number, step: number,
    signal: AbortSignal): Promise<StepEndReason | null> {
    let firstAttempt = true
    let replaceGeneration = this.session.surface.replaceGeneration
    while (true) {
      signal.throwIfAborted()
      const { request, preparedCall } = await this.requests.prepare(decision, firstAttempt, turn, step, signal)
      firstAttempt = false // accepted input is journaled once, even if the model request retries
      const response = await this.responses.receive(request, preparedCall, turn, step, signal)
      if (response.kind === 'failure') {
        const action = await this.dispatch.waterfall('agent/request-error', {
          turn, step, provider: request.provider, failure: response.failure,
          retryPolicy: preparedCall?.retryPolicy, signal,
        }, () => Promise.resolve<RequestErrorAction>(undefined))
        signal.throwIfAborted()
        if (action?.kind === 'retry') {
          // Recovery that replaced surface nodes (overflow compaction) may have
          // condensed this step's runtime-context snapshot; restore it before
          // the retried attempt. Unchanged surfaces keep the attempt identical.
          if (this.session.surface.replaceGeneration !== replaceGeneration) {
            replaceGeneration = this.session.surface.replaceGeneration
            const sections = renderContextSections(decision.assembly)
            const context = this.runtimeContext.project(joinContextSections(sections), sections)
            if (context !== undefined) this.session.append('user/message', context, { surfaceOp: 'append' })
          }
          continue
        }
        throw new LlmError(response.failure.message, response.failure.code, response.failure)
      }
      // A truncated response never dispatches a potentially incomplete call.
      if (response.finish.kind === 'max-tokens') return { kind: 'max-tokens' }
      const calls = response.message.content.filter(block => block.type === 'tool-call')
      if (calls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(this.loopCtx, turn, step, calls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]))
      return concluded ? { kind: 'completed' } : null
    }
  }
}
