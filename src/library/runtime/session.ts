/** Owned headless session; the original dsh Agent remains the sole execution state machine. */
import type { ContinuedQuestion } from '../interaction/continued/index.ts'
import type {} from '../interaction/continued/index.ts'
import type { Context } from "./vendor/cordis/index.ts"
import type { AgentHandle, AssistantStreamFrame, AgentStatus } from "./agents/index.ts"
import { createUserMessage } from "../model/llm/index.ts"
import type { ContentBlock, MessageId } from "../model/llm/index.ts"
import type { SessionEvent, TurnEndReason } from "../session/journal/index.ts"
import type { CompactionResult } from "../context/compaction/compaction/index.ts"
import { MODEL_CONTEXT_REVISION } from "../context/text/index.ts"
import type { ResolvedConnection } from "../model/connection.ts"
import type { RequestInspection, RequestReceipt } from "../model/inspection.ts"
import { freezeSnapshot } from "../model/inspection.ts"
import { verifyCompletion } from "../context/verification.ts"
import type { VerificationResult } from "../context/verification.ts"
import { sessionMetrics } from "../model/token-meter/metrics.ts"
import type { SessionMetrics } from "../model/token-meter/metrics.ts"
// Type-only: the `ctx.tokenMeter` and `ctx.sessionProjections` Context merges.
import type {} from "../model/token-meter/index.ts"
import type {} from "../session/projection/index.ts"

export type Prompt = string | ContentBlock[]
export interface RunResult {
  sessionId: string
  modelContextRevision: string
  messageId: MessageId
  /** Last turn outcome; not coerced to success on max-tokens, cancellation, or error. */
  stopReason: TurnEndReason | undefined
  text: string
  events: readonly SessionEvent[]
  /** Token, prompt-cache and context metrics at the same cut as `events`. */
  metrics: SessionMetrics
}
export type IoAgentEvent =
  | { type: 'event'; sessionId: string; event: SessionEvent }
  | { type: 'stream'; sessionId: string; frame: AssistantStreamFrame }
  | { type: 'status'; sessionId: string; status: AgentStatus }

/** Run `read` now and return a thunk that yields its value or rethrows its failure later. */
function settle<T>(read: () => T): () => T {
  try {
    const value = read()
    return () => value
  } catch (error) {
    return () => { throw error }
  }
}

export class IoAgentSession implements AsyncDisposable {
  private closeTask: Promise<void> | undefined
  private running = false
  private readonly closing = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly subscriptions = new Set<() => void>()

  constructor(private readonly context: Context, private readonly handle: AgentHandle,
    private readonly connection: ResolvedConnection, private readonly inspection: RequestInspection,
    private readonly released: () => void) {}

  get id(): string { return String(this.handle.agent.id) }
  get status(): AgentStatus { this.assertOpen(); return this.handle.agent.status }

  /** Native queued input remains busy even when it does not wake an idle agent. */
  get pendingInput(): boolean {
    this.assertOpen()
    const { inbox } = this.handle.agent
    return inbox.nextTurn.length > 0 || inbox.nextStep.length > 0
  }

  /** Running or queued native work, including an outstanding run's persistence drain; callers separately own maintenance exclusion. */
  get busy(): boolean {
    this.assertOpen()
    return this.running || this.handle.agent.status !== 'idle' || this.pendingInput
  }

  /**
   * Drain accepted persistence writes without awaiting native execution or background jobs.
   * @returns The persistence barrier; close drains this admitted operation.
   */
  flush(): Promise<void> {
    this.assertOpen()
    return this.operation(() => this.context.sessionPersistence.flush())
  }

  /**
   * Read a persisted page captured at invocation; later appends are outside this page.
   * @param from - inclusive event offset.
   * @param limit - maximum events, from 1 through 1000; defaults to 1000.
   * @returns detached immutable events after the persistence barrier; close drains this read.
   */
  events(from = 0, limit = 1000): Promise<readonly SessionEvent[]> {
    this.assertOpen()
    if (!Number.isSafeInteger(from) || from < 0) throw new TypeError('event offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('event limit must be an integer from 1 through 1000')
    const through = Math.min(this.handle.agent.session.seq, from + limit)
    return this.operation(async () => {
      await this.context.sessionPersistence.flush()
      return this.readEvents(from, through)
    })
  }

  /** Observe before submitting input. Callback exceptions do not become agent/tool failures. */
  subscribe(listener: (event: IoAgentEvent) => void | Promise<void>, onError?: (error: unknown) => void): () => void {
    this.assertOpen()
    const failed = (error: unknown): void => { try { onError?.(error) } catch { /* Observers never own execution. */ } }
    const notify = (event: IoAgentEvent): void => {
      try { void Promise.resolve(listener(event)).catch(failed) } catch (error) { failed(error) }
    }
    const id = this.id
    const agent = this.handle.agent
    const dispose = [
      this.context.on('session/event', (session, event) => { if (session === agent.session) notify({ type: 'event', sessionId: id, event }) }),
      // Observe retirement before mounted status handlers can synchronously wake a replacement driver.
      this.context.on('agent/status', ({ agent: owner, status }) => { if (owner === agent) notify({ type: 'status', sessionId: id, status }) }, { prepend: true }),
      this.context.on('agent/assistant-stream', ({ agent: owner, frame }) => { if (owner === agent) notify({ type: 'stream', sessionId: id, frame }) }),
    ]
    const unsubscribe = (): void => { dispose.forEach(fn => fn()); this.subscriptions.delete(unsubscribe) }
    this.subscriptions.add(unsubscribe)
    return unsubscribe
  }

  /** Clarifications remain owned by this session after their initiating turn ends. */
  pendingQuestions(): ContinuedQuestion[] {
    this.assertOpen(); return this.context.continuedQuestions.pending(this.handle.agent)
  }

  /** Durable answer admission, not a promise that subsequent work has finished. */
  answerQuestion(id: string, answer: unknown): Promise<ContinuedQuestion> {
    this.assertOpen()
    return this.operation(async () => {
      const result = this.context.continuedQuestions.answer(this.handle.agent, id, answer)
      await this.context.sessionPersistence.flush()
      return result
    })
  }

  dismissQuestion(id: string): Promise<void> {
    this.assertOpen()
    return this.operation(async () => {
      this.context.continuedQuestions.dismiss(this.handle.agent, id)
      await this.context.sessionPersistence.flush()
    })
  }

  /** Queue ordinary work. The return value identifies admitted input, not completed work. */
  send(prompt: Prompt): MessageId {
    this.assertOpen()
    if (this.running) throw new Error('run() owns this session; use steer() or await its result before send()')
    const message = this.message(prompt)
    this.handle.agent.followup(message)
    return message.id
  }

  /** Steer the nearest step using the inherited durable inbox. */
  steer(prompt: Prompt): MessageId {
    this.assertOpen()
    const message = this.message(prompt)
    this.handle.agent.steer(message)
    return message.id
  }

  /** Cancel active work explicitly. Disconnecting an observer never calls this. */
  cancel(options: { keepInbox?: boolean } = {}): void {
    this.assertOpen()
    this.handle.agent.cancel({ kind: 'user' }, options)
  }

  whenIdle(): Promise<void> {
    return this.operation(async () => {
      this.assertOpen()
      await this.handle.agent.whenIdle()
      await this.context.sessionPersistence.flush()
    })
  }

  /** Run from idle through quiescence, including any accepted steering, then cross a persistence barrier. */
  run(prompt: Prompt, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    return this.operation(async () => {
      this.assertOpen()
      const agent = this.handle.agent
      if (this.running || agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
        throw new Error('session is busy; use steer() for ongoing work')
      }
      options.signal?.throwIfAborted()
      const message = this.message(prompt)
      const from = agent.session.seq
      const cancel = (): void => { agent.cancel({ kind: 'user' }) }
      this.running = true
      options.signal?.addEventListener('abort', cancel, { once: true })
      try {
        agent.followup(message)
        await agent.whenIdle()
        const through = agent.session.seq
        // Same cut as `through`; a failed read surfaces only after the persistence barrier.
        const metrics = settle(() => this.readMetrics())
        await this.context.sessionPersistence.flush()
        // This operation was admitted while open and is drained by close(). Do
        // not re-enter the public API after cancellation has marked us closed.
        const events = await this.readEvents(from, through)
        let stopReason: TurnEndReason | undefined
        let text = ''
        for (const event of events) {
          if (event.type === 'turn/end') stopReason = event.data.reason
          if (event.type === 'assistant/message') text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        }
        return { sessionId: this.id, modelContextRevision: MODEL_CONTEXT_REVISION, messageId: message.id, stopReason, text, events, metrics: metrics() }
      } finally {
        this.running = false
        options.signal?.removeEventListener('abort', cancel)
      }
    })
  }

  /** Same compactor and route used by automatic pressure handling; no separate auxiliary model default. */
  compact(signal: AbortSignal = new AbortController().signal): Promise<CompactionResult | null> {
    return this.operation(async () => {
      this.assertOpen()
      const result = await this.context.compaction.compactNow(this.handle.agent, AbortSignal.any([signal, this.closing.signal]))
      await this.context.sessionPersistence.flush()
      return result
    })
  }

  /** Metadata-only recent model observations, including auxiliary calls; not delivery receipts. */
  requests(): readonly RequestReceipt[] { this.assertOpen(); return this.inspection.list(this.id) }

  /**
   * Token, prompt-cache and context-occupancy metrics through the current journal tail.
   * Folded from durable events, so a resumed session reports the same values; subagent
   * sessions are not included. Synchronous and read-only.
   */
  metrics(): SessionMetrics { this.assertOpen(); return this.readMetrics() }

  /** One explicit, read-only review. No extra agent loop, tool execution, or automatic success on errors. */
  verify(options: { signal?: AbortSignal } = {}): Promise<VerificationResult> {
    return this.operation(async () => {
      this.assertOpen()
      if (this.running) throw new Error('run() owns this session')
      const signal = options.signal === undefined ? this.closing.signal : AbortSignal.any([options.signal, this.closing.signal])
      return verifyCompletion(this.context, this.handle.agent, this.connection, signal)
    })
  }

  close(): Promise<void> {
    this.closeTask ??= this.disposeOwned()
    return this.closeTask
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  private operation<T>(call: () => Promise<T>): Promise<T> {
    const task = call()
    this.operations.add(task)
    void task.then(() => this.operations.delete(task), () => this.operations.delete(task))
    return task
  }
  private readMetrics(): SessionMetrics {
    const agent = this.handle.agent
    const { asOfSeq, values } = this.context.sessionProjections.snapshot(agent.session,
      ['tokenUsage', 'contextPressure', 'promptCache', 'compactionActivity'])
    const { tokenUsage, contextPressure, promptCache, compactionActivity } = values
    if (tokenUsage === undefined || contextPressure === undefined || promptCache === undefined || compactionActivity === undefined) {
      throw new Error('session metrics require the token meter projections')
    }
    const thresholdTokens = this.context.compaction.thresholdTokens(agent)
    return sessionMetrics({ asOfSeq, tokenUsage, contextPressure, promptCache, compactionActivity,
      ...thresholdTokens === undefined ? {} : { thresholdTokens },
      measuredTokens: this.context.tokenMeter.measure(agent.session).totalTokens })
  }
  private async readEvents(from: number, through: number): Promise<readonly SessionEvent[]> {
    if (from >= through) return Object.freeze([])
    const reader = await this.context.sessionPersistence.open(this.handle.agent.id, 'read')
    try {
      const events: SessionEvent[] = []
      for (let offset = from; offset < through;) {
        const length = Math.min(1000, through - offset)
        const page = await reader.read(offset, length)
        if (page.events.length !== length) throw new Error('persisted session is shorter than its captured event range')
        events.push(...page.events)
        offset += length
      }
      return freezeSnapshot(events)
    } finally { await reader.close() }
  }
  private async disposeOwned(): Promise<void> {
    for (const dispose of this.subscriptions) dispose()
    this.closing.abort(new Error('session is closing'))
    this.handle.agent.cancel({ kind: 'user' })
    await Promise.allSettled([...this.operations])
    try { await this.handle.dispose() } finally { this.released() }
  }
  private assertOpen(): void {
    if (this.closeTask !== undefined || this.context.agents.get(this.handle.agent.id) !== this.handle.agent) {
      throw new Error('session is closed')
    }
  }
  private message(prompt: Prompt): ReturnType<typeof createUserMessage> {
    if (prompt.length === 0) throw new TypeError('prompt must not be empty')
    return createUserMessage({ content: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt, source: { kind: 'user' } })
  }
}
