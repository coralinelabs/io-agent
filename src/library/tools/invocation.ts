/** One invocation pipeline for native, worker and nested tools.
 * Scope/availability stay in the registry. This module owns only in-flight execution.
 */
import { modelText } from "../context/text/index.ts"
import type { Context } from '../runtime/vendor/cordis/index.ts'
import { type Scoped, type ScopeKey } from '../runtime/scope/index.ts'
import type { ContentBlock } from '../model/llm/index.ts'
import type { UserMessage } from '../session/journal/index.ts'
import { assertNever, deepFreeze, type JsonValue } from '../util/values/index.ts'
import { snapshotJsonValue } from '../util/values/index.ts'
import { validateJsonSchemaValue } from './json-schema.ts'
import { RUN_CODE_NAME } from './ptc.ts'
import { ToolNotFoundError, ToolOutputError, projectionError, snapshotProjection, snapshotToolValue } from './contracts.ts'
import type { ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionResult, ToolExecutionToken, ToolRunContext,
  MutableToolRunContext, ScheduledToolPreparation, ScheduledToolDispatch, ToolRuntimeScheduler, PreToolDecision,
  PostToolDecision, ToolExecutionSuccess, ToolBatchCommit } from './contracts.ts'
import { createExecutionToken, toolErrorResult, toolAbortedResult, toolAbortedBeforeDispatchResult, errorMessage,
  failureMessageFromContent, materializePresentation, isAborted, fuseToolSignals } from './outcome.ts'
import type { ToolRuntime } from './index.ts'
import { changedTool, type ToolBinding } from './binding.ts'
interface InvocationHost {
  carrier(scope?: ScopeKey): Scoped<ToolRuntime>
  capture(name: string, scope?: ScopeKey): ToolBinding | undefined
  current(binding: ToolBinding, exec: ToolExecution): boolean
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined
  resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined
  collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean
  guardReason(exec: ToolExecution): string | undefined
}
/** Approval decision plus whether the approval channel reported cancellation. */
interface ToolAskResolution {
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  readonly approvalCancelled: boolean
}

/** Caller cancellation and dispatch state kept outside the around-wrapper view. */
interface InvocationState {
  readonly callerSignal: AbortSignal
  readonly deferredContexts: UserMessage[]
  readonly finalizeContent: ToolDefinition['finalizeContent']
  readonly binding: ToolBinding | undefined
  bodyInvoked: boolean
  concludesTurn: boolean
  /** Repeated around-wrapper next() calls observe one body, never replay it. */
  dispatch?: Promise<ToolExecutionResult>
}


export class ToolInvocation {
  constructor(private readonly ctx: Context, private readonly host: InvocationHost) {}


  /** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
  readonly scheduler: ToolRuntimeScheduler = {
    prepare: exec => this.prepareScheduledExecution(exec),
    dispatch: exec => this.dispatchScheduledExecution(exec),
    finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
    finish: (exec, result) => this.finishScheduledExecution(exec, result),
    committed: batch => this.notifyBatchCommitted(batch),
  }

  /**
   * Run `tools/batch-committed` listeners one after another for the batch's
   * agent scope. Each listener is contained: a failure is logged and the next
   * listener still runs, because the step's results are already durable and a
   * batch-level policy must never turn a completed step into a failure.
   */
  private async notifyBatchCommitted(batch: ToolBatchCommit): Promise<void> {
    const callbacks = this.ctx.events.dispatch('serial', [
      this.host.carrier(batch.agent), 'tools/batch-committed', batch,
    ])
    for (const callback of callbacks) {
      if (batch.signal.aborted) return
      try {
        await callback(batch)
      } catch (error: unknown) {
        this.ctx.logger.warn(`tools: batch-committed listener failed for turn ${batch.turn} step ${batch.step}: ${errorMessage(error)}`)
      }
    }
  }

  /** One owner for all per-invocation authority, effects and cancellation. */
  private readonly executions = new WeakMap<ToolExecution, InvocationState>()

  private state(exec: ToolExecution): InvocationState {
    const state = this.executions.get(exec)
    if (state === undefined) throw new Error(modelText('foundation/tools-index/text-21'))
    return state
  }

  /**
   * Execute through pre-policy, guards, around-dispatch, post-policy,
   * definition-owned content finalization, and final notification. Tool and
   * listener failures resolve as materialized error results; an invisible tool
   * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
   * snapshot final observers receive. Cancellation
   * arriving after entry and before final result materialization skips a
   * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
   * successful started outcome with `ABORTED`; already-started work is still
   * drained and may retain a tool-owned structured error.
   * @param exec - the typed same-process call input. The registry assigns its
   *   correlation token before policy begins.
   * @returns the materialized final result.
   */
  async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    return this.prepareExecution(exec, prepared => this.completeScheduledExecution(prepared))
  }

  private async completeScheduledExecution(prepared: ScheduledToolPreparation): Promise<ToolExecutionResult> {
    switch (prepared.kind) {
      case 'dispatch': {
        const dispatched = await this.dispatchScheduledExecution(prepared.exec)
        return dispatched.kind === 'post-result'
          ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result)
          : this.finishScheduledExecution(prepared.exec, dispatched.result)
      }
      case 'post-result':
        return await this.finalizeScheduledExecution(prepared.exec, prepared.result)
      case 'final-result':
        return this.finishScheduledExecution(prepared.exec, prepared.result)
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(prepared, 'scheduled tool preparation')
    }
  }

  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    const deferredContexts: UserMessage[] = []
    const token = createExecutionToken()
    const callId = exec.callId
    const rootCallId = exec.rootCallId ?? callId
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    // Distinguish a mode-collapsed call (visible in the scope, denied only by
    // the `ptc` collapse) from a genuinely unknown tool. A collapsed call is
    // deterministically denied, so it terminates BEFORE the extensible policy
    // pipeline: pre-execute listeners, approval `ask`, and guards must never
    // observe — or worse, approve — a call that can only fail. An unknown tool
    // keeps the historical dispatch-stage `UNKNOWN_TOOL` path so policy
    // listeners still see every name that reaches the registry.
    const visible = this.host.get(name, agent)
    const collapsed = visible !== undefined && this.host.collapses(name, agent, parent !== undefined)
    const owner = this
    const base = {
      token,
      callId,
      rootCallId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      ...parent !== undefined ? { parent } : {},
      ...exec.schema !== undefined ? { schema: exec.schema } : {},
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      concludeTurn(): void {
        owner.state(this as unknown as ToolExecution).concludesTurn = true
      },
    }
    // Capture the finalizer BEFORE argument materialization: the
    // `finalizeContent` contract snapshots the callback when the call starts,
    // and an arguments getter can replace or clear the registered callback
    // during `snapshotJsonValue`. The collapse only decides whether the
    // CAPTURED callback is retained: the pre-dispatch abort path keeps it
    // (the cancellation contract routes aborted results through it — a getter
    // that aborts mid-materialization before an invalid-args failure lands in
    // the same retained path), while the `UNKNOWN_TOOL` denial and the
    // invalid-args failure of a NON-ABORTED collapsed call drop it (the call
    // could never execute).
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    const finalizerFor = (): ToolDefinition['finalizeContent'] | undefined =>
      collapsed && !signal.aborted ? undefined : capturedFinalizer
    try {
      const binding = this.host.capture(name, agent)
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError(modelText('foundation/tools-index/text-20'))
      }
      const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
      this.executions.set(execution, {
        binding, deferredContexts, finalizeContent: finalizerFor(),
        callerSignal: signal, bodyInvoked: false, concludesTurn: false,
      })
      if (collapsed) {
        // The collapse denies the call before the policy pipeline, but a
        // pre-dispatch abort still keeps the established cancellation
        // contract: `prepare`'s caller-cancellation check is skipped for
        // final-results, so honor the abort here instead of surfacing
        // `UNKNOWN_TOOL` on an already-cancelled call.
        if (signal.aborted) {
          return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() }
        }
        // The name IS visible here, so the denial carries the route the model
        // must take instead. Without it the model reads a bare `unknown tool`
        // for a tool the prompt just declared and concludes the deployment is
        // broken rather than correcting itself.
        return {
          kind: 'final-result',
          exec: execution,
          result: toolErrorResult(new ToolNotFoundError(
            name,
            `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`,
          )),
        }
      }
      return { kind: 'ready', exec: execution }
    } catch (error: unknown) {
      const execution: MutableToolRunContext = { ...base, arguments: undefined }
      this.executions.set(execution, {
        binding: undefined, deferredContexts, finalizeContent: finalizerFor(),
        callerSignal: signal, bodyInvoked: false, concludesTurn: false,
      })
      return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
    }
  }

  /**
   * Run the ordered pre-execute and monotonic guard stages for the scheduler.
   * @param input - the caller-supplied execution input.
   * @returns the prepared execution plus the next scheduler stage.
   * @internal
   */
  private async prepareScheduledExecution(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    return this.prepareExecution(input, prepared => prepared)
  }

  private async prepareExecution<T>(
    input: ToolExecutionInput,
    next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>,
  ): Promise<T> {
    const created = this.createExecution(input)
    if (created.kind !== 'ready') return next(created)
    const exec = created.exec
    if (this.callerCancelled(exec)) {
      return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
    }
    try {
      const carrier = this.host.carrier(exec.agent)
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      const askResolution = gate.kind === 'ask'
        ? await this.serviceAsk(exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      if (decision.kind === 'cancel') {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      const denialReason = decision.kind === 'allow' ? this.host.guardReason(exec) : decision.reason
      const denialInfo = decision.kind === 'deny' ? decision.info : undefined
      if (denialReason !== undefined) {
        return await next({
          kind: 'post-result',
          exec,
          result: this.materializeFinalResult({
            content: [{ type: 'text', text: modelText('foundation/tools-index/text-33', { value_1: String(denialReason) }) }],
            isError: true,
            error: { message: denialReason, ...denialInfo === undefined ? {} : { info: denialInfo } },
          }),
        })
      }
      if (this.callerCancelled(exec)) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      return await next({ kind: 'dispatch', exec })
    } catch (error: unknown) {
      return next({ kind: 'final-result', exec, result: toolErrorResult(error) })
    }
  }

  /** Whether the original caller signal is currently aborted. */
  private callerCancelled(exec: ToolRunContext): boolean {
    const state = this.state(exec)
    return state.callerSignal.aborted
  }

  /** Canonical cancellation outcome selected by whether the tool body started. */
  private cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
    const state = this.state(exec)
    return state.bodyInvoked
      ? toolAbortedResult(prior)
      : toolAbortedBeforeDispatchResult(prior)
  }

  /**
   * Dispatch the registered body with the original caller signal fused back
   * into any around-wrapper replacement. Cancellation never abandons the body:
   * a started promise reaches quiescence before its outcome becomes `ABORTED`.
   */
  private dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> {
    const state = this.state(exec)
    if (state.dispatch !== undefined) return state.dispatch
    // Publish the promise before entering tool code, including synchronous
    // re-entry through a wrapper. Retrying effects requires a NEW invocation
    // with its own admission and permission checks.
    const dispatched = Promise.withResolvers<ToolExecutionResult>()
    state.dispatch = dispatched.promise
    void this.invokeBody(exec, state).then(dispatched.resolve, error => dispatched.resolve(toolErrorResult(error)))
    return state.dispatch
  }

  private async invokeBody(exec: MutableToolRunContext, state: InvocationState): Promise<ToolExecutionResult> {
    const wrapperSignal = exec.signal
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
    const signal = fused.signal

    if (isAborted(signal)) {
      fused.dispose()
      return toolAbortedBeforeDispatchResult()
    }
    exec.signal = signal
    try {
      const binding = this.state(exec).binding
      if (binding === undefined) throw new ToolNotFoundError(exec.name)
      if (!this.host.current(binding, exec)) throw changedTool(exec, true)
      const tool = binding.definition
      state.bodyInvoked = true
      const returned = await tool.execute(exec.arguments, exec)
      const result = this.createSuccessResult(exec, tool, returned)
      return isAborted(signal)
        ? toolAbortedResult(result)
        : result
    } catch (error: unknown) {
      return toolErrorResult(error)
    } finally {
      fused.dispose()
      exec.signal = wrapperSignal
    }
  }

  /**
   * Run around-dispatch and the tool body. Tool and unknown-tool failures still
   * receive post-execute; pipeline failures are already final.
   * @param exec - the prepared execution.
   * @returns whether the result still needs post-execute.
   * @internal
   */
  private async dispatchScheduledExecution(exec: ToolRunContext): Promise<ScheduledToolDispatch> {
    try {
      const mutableExec = exec as MutableToolRunContext
      const carrier = this.host.carrier(exec.agent)
      const result = await this.ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
      const normalized = this.normalizeDispatchResult(exec, result)
      const { deferredContexts } = this.state(exec)
      const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
        ? normalized
        : this.markCanonical(exec, {
          ...normalized,
          additionalContexts: [
            ...deferredContexts,
            ...normalized.additionalContexts ?? [],
          ],
        })
      return {
        kind: 'post-result',
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
          ? this.cancellationResult(exec, resultWithDeferredContexts)
          : resultWithDeferredContexts,
      }
    } catch (error: unknown) {
      return { kind: 'final-result', result: toolErrorResult(error) }
    }
  }

  /**
   * Run ordered post-execute, then apply definition-owned content finalization,
   * materialize, and notify the final outcome.
   * @param exec - the prepared execution.
   * @param result - dispatch/pre result that still needs post-execute.
   * @returns the materialized final result.
   * @internal
   */
  private async finalizeScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    try {
      const postResult = await this.postExecute(exec, result)
      return this.finishScheduledExecution(
        exec,
        this.callerCancelled(exec) && !postResult.isError
          ? this.cancellationResult(exec, postResult)
          : postResult,
      )
    } catch (error: unknown) {
      return this.finishScheduledExecution(exec, toolErrorResult(error))
    }
  }

  /**
   * Materialize the candidate, apply definition-owned content finalization,
   * then materialize and notify the authoritative result.
   * @param exec - the prepared execution.
   * @param result - final result.
   * @returns the materialized final result.
   * @internal
   */
  private finishScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    let materializedResult: ToolExecutionResult
    try {
      materializedResult = this.materializeFinalResult(result)
    } catch (error: unknown) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error))
    }
    let finalResult: ToolExecutionResult
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult))
    } catch (error: unknown) {
      finalResult = this.materializeFinalResult(toolErrorResult(error))
    }
    this.notifyResult(exec, finalResult)
    return finalResult
  }

  /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
  private applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    const { finalizeContent } = this.state(exec)
    if (finalizeContent === undefined) return result
    const content = finalizeContent(exec, result)
    return content === undefined ? result : { ...result, content }
  }

  /** Notify observers without exposing a mutation or error channel into the outcome. */
  private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    // Freeze the registry's live object before observers receive its readonly
    // WeakMap-keyable view.
    Object.freeze(exec)
    const { name: toolName, callId } = exec
    const reportFailure = (error: unknown): void => {
      this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`)
    }
    const callbacks = this.ctx.events.dispatch('emit', [
      this.host.carrier(exec.agent), 'tools/result', exec, result,
    ])
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(exec, result)
        void Promise.resolve(returned).catch(reportFailure)
      } catch (error: unknown) {
        reportFailure(error)
      }
    }
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam. The
   * seam is consumed opportunistically with `ctx.get('approval')` — a
   * deployment that composes no ApprovalService keeps the historical degrade
   * to deny, and an unmount mid-session degrades the same way on the next ask.
   * An agent-less execution also degrades: without an agent there is no
   * session to audit to and no UI to route to. Otherwise the outcome maps
   * one-to-one — `allowed-once` proceeds; the three non-grants deny with
   * distinct reasons so the model can tell a human "no" from an absent
   * approval channel.
   */
  private async serviceAsk(
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<ToolAskResolution> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      return {
        decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
        approvalCancelled: false,
      }
    }
    if (exec.agent === undefined) {
      return {
        decision: { kind: 'deny', reason: modelText('foundation/tools-index/text-25', { value_1: String(exec.name) }) },
        approvalCancelled: false,
      }
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      case 'rejected': return {
        decision: { kind: 'deny', reason: modelText('foundation/tools-index/text-26', { value_1: String(exec.name) }) },
        approvalCancelled: false,
      }
      case 'cancelled': return {
        decision: { kind: 'deny', reason: modelText('foundation/tools-index/text-27', { value_1: String(exec.name) }) },
        approvalCancelled: true,
      }
      case 'unavailable': return {
        decision: { kind: 'deny', reason: modelText('foundation/tools-index/text-28', { value_1: String(exec.name) }) },
        approvalCancelled: false,
      }
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /**
   * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
   * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
   * `content` when given), `block` turns it into an `isError` whose content is
   * the corrective `feedback`. Either decision may attach `additionalContexts`,
   * which are ferried on the returned result for the loop's active-batch FIFO.
   * Context deferred by the tool body survives an accepted result but is
   * discarded when the outer call is blocked; a block exposes only context the
   * blocking decision explicitly supplied.
   * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
   */
  private async postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    const decision = await this.ctx.waterfall(
      this.host.carrier(exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const decisionContexts = decision.additionalContexts ?? []
    if (decision.kind === 'block') {
      const message = failureMessageFromContent(decision.feedback)
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
      })
    }
    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
      throw new TypeError(modelText('foundation/tools-index/text-29'))
    }
    const additionalContexts = [
      ...result.additionalContexts ?? [],
      ...decisionContexts,
    ]
    if (Object.hasOwn(decision, 'value')) {
      if (result.isError) {
        throw new TypeError(modelText('foundation/tools-index/text-30'))
      }
      const tool = this.replacementDefinition(exec)
      const replaced = this.createSuccessResult(exec, tool, decision.value)
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
      })
    }
    // A default accept is not a new outcome. Preserve the owned snapshot rather
    // than repeatedly copying a multi-megabyte result through no-op hooks.
    if (decision.content === undefined && decisionContexts.length === 0) return result
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== undefined ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }

  /** A policy replacement is a new value: require the same still-live authority.
   * An already-canonical body result remains valid after deregistration.
   */
  private replacementDefinition(exec: ToolExecution): ToolDefinition {
    if (this.host.resolveExecution(exec.name, exec.agent, exec.parent !== undefined) === undefined) throw new ToolNotFoundError(exec.name)
    const binding = this.state(exec).binding
    if (binding === undefined) throw new ToolNotFoundError(exec.name)
    if (!this.host.current(binding, exec)) throw changedTool(exec)
    return binding.definition
  }

  /** Registry-normalized results and the exact dispatch that validated each value. */
  private readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  /** Mark one registry-normalized result as canonical only for its owning dispatch. */
  private markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T {
    this.canonicalResults.set(result, exec.token)
    return result
  }

  /** Snapshot, validate, render, and optionally project one successful body value. */
  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
    const value = deepFreeze(snapshotToolValue(tool.name, candidate))
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
    let rendered: ContentBlock[]
    try {
      rendered = tool.output.render(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'render', error)
    }
    const content = snapshotProjection(tool.name, 'render', rendered)
    let meta: JsonValue | undefined
    if (exec.parent === undefined && tool.output.presentationMeta !== undefined) {
      let projected: JsonValue
      try {
        projected = tool.output.presentationMeta(exec.arguments, value)
      } catch (error: unknown) {
        throw projectionError(tool.name, 'presentationMeta', error)
      }
      meta = snapshotProjection(tool.name, 'presentationMeta', projected)
    }
    const { concludesTurn } = this.state(exec)
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== undefined ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }) as ToolExecutionSuccess)
  }

  /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
  private normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    if (this.canonicalResults.get(result) === exec.token) return result
    if (result.isError) {
      return this.markCanonical(exec, {
        isError: true,
        error: result.error,
        content: result.content,
        ...result.meta !== undefined ? { meta: result.meta } : {},
        ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
      })
    }
    const tool = this.replacementDefinition(exec)
    const normalized = this.createSuccessResult(exec, tool, result.value)
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }

  /** Proven detached/frozen presentations, not arbitrary frozen user objects. */
  private readonly materializedResults = new WeakSet<ToolExecutionResult>()

  /** Materialize a new candidate once. Canonical no-op passes retain identity. */
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    if (this.materializedResults.has(result)) return result
    const presentation = {
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    }
    if (result.isError) {
      const owned = materializePresentation({ isError: true as const, error: result.error, ...presentation })
      this.materializedResults.add(owned)
      return owned
    }
    const detached = materializePresentation({
      isError: false as const,
      ...presentation,
      ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
    })
    const owned = deepFreeze({ ...detached, value: result.value })
    this.materializedResults.add(owned)
    return owned
  }
}
