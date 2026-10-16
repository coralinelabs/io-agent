/**
 * Basic replay-aware compaction backend.
 *
 * @module io-agent/compaction-basic
 */

import { createHash } from 'node:crypto'
import { Context } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import { CompactionEngine, ManualCompactionError } from "../compaction/index.ts"
import { recordedToolResult } from "../compaction/replace.ts"
import type { CompactionAgentContext, CompactionResult, CompactionTrigger } from "../compaction/index.ts"
import type { Session, SessionSeq } from "../../../session/journal/index.ts"
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from "../../../model/llm/index.ts"
import type { LlmCallConfig } from "../../../model/llm/index.ts"
import type { TokenMeasurement } from "../../../model/token-meter/index.ts"
import { assertNever } from "../../../util/values/index.ts"
import type { Agent, PreStepDecision } from "../../../runtime/agents/index.ts"
import type { CommandId } from "../../../interaction/commands/brand.ts"
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type { PrunedEntry, PruneRetentionPolicy, ToolResultPruner } from "../tool-result-pruner/index.ts"
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  buildSummarizationInput,
  CompactionNoShrinkError,
  compactSurfaceRegion,
  firstCompactableIndex,
  selectCompactableRange,
} from './region.ts'
import { frameSummary, summarizeWithLlm } from './summarizer.ts'
import { idleMillis, modelActivityProjectionDefinition } from './idle.ts'
import { buildCheckpointAppendix, condensedSpanStart, withLogPointer } from './checkpoint-record.ts'
import type { CheckpointAppendix } from './checkpoint-record.ts'
import { visibleMessages } from "../../visibility.ts"
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
export type { SummarizationInput, SummaryResult } from './summarizer.ts'
export { idleMillis, modelActivityProjectionDefinition } from './idle.ts'
export type { ModelActivityState } from './idle.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedCheckpointConfig,
  ResolvedConfig,
  ResolvedCompactSpec,
} from './types.ts'

export type { CheckpointAppendix } from './checkpoint-record.ts'
export type {
  BasicCompactionConfig,
  CheckpointConfig,
  CheckpointLogPointer,
  CheckpointRange,
  CheckpointReaders,
  CheckpointToolResult,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCheckpointConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Inclusive surface span selected for one compaction. */
type SurfaceRange = { readonly start: SessionSeq; readonly end: SessionSeq }

/** Priced nodes of one selected span. */
function spanNodes(measurement: TokenMeasurement, range: SurfaceRange): TokenMeasurement['nodes'] {
  return measurement.nodes.slice(
    measurement.nodes.findIndex(node => node.seq === range.start),
    measurement.nodes.findIndex(node => node.seq === range.end) + 1,
  )
}

/** Route price of one selected span, the figure a replacement must stay under. */
function spanTokens(measurement: TokenMeasurement, range: SurfaceRange): number {
  return spanNodes(measurement, range).reduce((total, node) => total + node.tokens, 0)
}

/** Each rewritten surface node mapped to the node it shadowed. */
/**
 * Where a pressure prune aims: halfway from the retained tail to the threshold. A rewrite of sent results breaks the
 * prompt cache from its first rewritten node, so a prune that lands just under the threshold buys only a few steps
 * before the next break; landing here buys a long append-only stretch per break.
 */
export const PRUNE_WATERMARK_FRACTION = 0.5

/**
 * The deeper passes a pressure prune tries, in order, while the session stays above the watermark. They reach further
 * into old content only: the recent tool groups the configuration keeps verbatim stay verbatim, while old results
 * smaller than the configured stub size become stubs too (only where the stub is smaller), and old skill bodies age
 * out with the other old results. Pressure that comes from recent work alone is still the summary's to relieve.
 */
function deeperRetention(configured: Readonly<PruneRetentionPolicy> | undefined): PruneRetentionPolicy[] {
  const stubMin = configured?.stubMinChars
  const recent = configured?.keepRecentToolGroups ?? 0
  const skills = configured?.keepRecentSkillToolGroups
  const tighter = (value: number | undefined, deeper: number): number => Math.min(value ?? deeper, deeper)
  return [512, 0].map(chars => ({
    stubMinChars: tighter(stubMin, chars),
    keepRecentSkillToolGroups: tighter(skills, Math.max(recent, configured?.stubAfterToolGroups ?? recent)),
  }))
}

/**
 * Prune under pressure until the session is at or under the watermark: the configured pass first, then the deeper
 * ones, all landing before the next request, so the cache breaks once. A summary still follows when pruning cannot
 * clear the threshold.
 */
function pruneBelowWatermark(
  prune: ToolResultPruner, session: Session, measure: () => TokenMeasurement, spec: ResolvedCompactSpec,
): PressurePrune {
  const watermarkTokens = Math.floor(Math.min(spec.thresholdTokens, spec.retainTokens + (spec.thresholdTokens - spec.retainTokens) * PRUNE_WATERMARK_FRACTION))
  const beforeTokens = measure().totalTokens
  const pruned: PrunedEntry[] = [...prune.pruneSession(session).pruned]
  let passes = 1
  let charsRemoved = pruned.reduce((total, entry) => total + entry.charsBefore - entry.charsAfter, 0)
  for (const overrides of deeperRetention(prune.config.retention)) {
    if (measure().totalTokens <= watermarkTokens) break
    const pass = prune.pruneSession(session, overrides)
    pruned.push(...pass.pruned)
    charsRemoved += pass.charsRemoved
    passes += 1
  }
  return { pruned, beforeTokens, afterTokens: measure().totalTokens, thresholdTokens: spec.thresholdTokens, watermarkTokens, passes, charsRemoved }
}

/** What one pressure prune did, for the log: an observation only, never part of a request. */
interface PressurePrune {
  readonly pruned: readonly PrunedEntry[]
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly thresholdTokens: number
  readonly watermarkTokens: number
  readonly passes: number
  readonly charsRemoved: number
}

function shadowedBy(pruned: readonly PrunedEntry[]): ReadonlyMap<SessionSeq, SessionSeq> {
  return new Map(pruned.map(entry => [entry.replacementSeq, entry.originalSeq]))
}

/** Keep unrelated log appends and retained-tail growth out of failed-input identity. */
function pressureInputKey(
  input: SummarizationInput,
  sourceTokens: number,
  spec: ResolvedCompactSpec,
  appendix: CheckpointAppendix,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ input, sourceTokens, spec, framing: frameSummary([], appendix.blocks) }))
    .digest('hex')
}

/**
 * A committed pressure compaction that leaves the context above this share of
 * the threshold bought too little room: compacting again at the next step would
 * condense the newest work over and over. Pressure compaction then waits
 * until the context has grown by a retained tail's worth.
 */
const INEFFECTIVE_SHARE = 0.8

/** Steps pressure compaction sits out after its 1st, 2nd and later consecutive failures. */
const FAILURE_BACKOFF_STEPS = [1, 3, 9] as const

/** Share of the context window the deterministic checkpoint sections may take, at about 4 bytes a token. */
const CHECKPOINT_WINDOW_SHARE = 0.05

/** User-section scales an overflow recovery tries when the full sections alone would not shrink the span. */
const OVERFLOW_USER_SCALES = [1, 0.5, 0.25, 0] as const

/**
 * Per-session brake on pressure compaction: consecutive failures and the steps
 * still to sit out, and, after an ineffective compaction, the size the context
 * must reach on the same surface generation before pressure compacts again.
 */
interface PressureBrake {
  failures: number
  skipSteps: number
  resume?: { readonly tokens: number; readonly generation: number }
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const checkpointBudgetSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
    headroomTokens: z.number().step(1).min(0),
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: z.number().step(1).min(0),
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    coldCachePruneAfterMs: z.number().step(1).min(1),
    checkpoint: z.object({
      userMessageBytes: checkpointBudgetSchema,
      firstUserMessageMaxBytes: checkpointBudgetSchema,
      userMessageMaxBytes: checkpointBudgetSchema,
      anchorBytes: checkpointBudgetSchema,
      maxSkills: checkpointBudgetSchema,
      maxTodoItems: checkpointBudgetSchema,
    }),
    checkpointReaders: z.object({
      skillLoad: z.function(),
      skillInjection: z.function(),
      todoList: z.function(),
    }),
    checkpointLogPointer: z.function(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly noShrinkPressureInputs = new WeakMap<Session, string>()
  private readonly pressureBrakes = new WeakMap<Session, PressureBrake>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Prune old tool results when the provider's prompt cache is presumed cold:
   * the session had no model response for longer than
   * `coldCachePruneAfterMs`. Rewriting history then costs no extra cache miss,
   * because the next request misses anyway. Model-free and never a summary;
   * pressure compaction still runs afterwards and measures the pruned surface.
   * @param agent - agent entering a step.
   * @returns the replacements the pass landed; empty when it did not run.
   */
  private pruneIfCold(agent: Agent): readonly PrunedEntry[] {
    const after = this.config.coldCachePruneAfterMs
    if (after === undefined) return []
    const prune = this.ctx.get('toolResultPruner')
    if (prune === undefined) return []
    const idle = idleMillis(this.ctx.sessionProjections.stateOf(agent.session, 'modelActivity'), Date.now())
    if (idle === undefined || idle <= after) return []
    assertNoActiveCompaction(agent.session, 'cold-cache tool-result prune')
    const result = prune.pruneSession(agent.session)
    if (result.pruned.length > 0) {
      this.ctx.logger.info(
        `tool-result prune (idle ${Math.floor(idle / 60_000)}m > cache TTL ${Math.floor(after / 60_000)}m): `
        + `rewrote ${result.pruned.length} results, ${result.charsRemoved} chars`,
      )
    }
    return result.pruned
  }

  /**
   * Whether a model-free prune may rewrite results a request has sent. Not on
   * a kv100 route, whose history is append-only by design so that a summary is
   * its one planned break, and not on a route whose mode is unknown: a failed
   * lookup is no permission to rewrite. Cancellation during the lookup throws.
   * @param agent - agent whose durably routed target is read.
   * @param signal - cancellation for the adapter-owned lookup.
   * @returns true only for a route known not to be kv100, or with no route yet (nothing sent).
   */
  private async mayRewriteSent(agent: Agent, signal?: AbortSignal): Promise<boolean> {
    const target = routedTarget(agent.session)
    if (target === undefined) return true
    try {
      return (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).kv100 !== true
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    // The idle fold is registered only when the cold-cache trigger is on.
    if (this.config.coldCachePruneAfterMs !== undefined) {
      ctx.sessionProjections.register(modelActivityProjectionDefinition)
    }
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        // Contained on its own: a failed idle prune must not skip pressure compaction.
        let coldPruned: readonly PrunedEntry[] = []
        try {
          // kv100 keeps what a request sent, cold cache or not, and so does a route whose mode is unknown.
          if (this.config.coldCachePruneAfterMs !== undefined && await this.mayRewriteSent(agent, signal)) {
            coldPruned = this.pruneIfCold(agent)
          }
        } catch (error: unknown) {
          // cancelled during the lookup: the step is over, as if it had been cancelled before it
          if (signal.aborted) return next()
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`cold-cache tool-result prune failed: ${message}; continuing the turn`)
        }
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal, coldPruned)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction. Pressure skips a previously rejected
   * no-shrink input until its selected evidence, replay framing, price, or
   * effective policy changes; transport errors and cancellation do not suppress
   * later attempts. Checkpoint framing alone can rule out an auxiliary call.
   *
   * A pressure summary replays each result a prune at this step boundary
   * rewrote (the idle prune, then this pass's own) as the last request sent
   * it: the summary keeps what the stubs dropped, and its call stays a byte
   * prefix of that request. Overflow recovery summarizes the pruned surface,
   * because the request it recovers from did not fit.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @param prunedAtStep - replacements a model-free prune already landed at this step boundary (the idle prune).
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
    prunedAtStep: readonly PrunedEntry[] = [],
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold. A kv100 route never
    // prunes: a summary, not a rewrite of sent results, is its one break.
    const prune = await this.mayRewriteSent(agent, signal) ? this.ctx.get('toolResultPruner') : undefined

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      // As under pressure: when the deterministic sections alone cannot fit
      // under the span's price, no summary can shrink it, so no auxiliary call
      // is spent on a replacement the shrink check would reject. A span that is
      // mostly user text (a large first prompt) is retried with fewer quoted
      // user words before the overflow is given up on.
      const tokens = spanTokens(measurement, range)
      for (const users of OVERFLOW_USER_SCALES) {
        const appendix = this.spanAppendix(agent.session, measurement, range, users)
        if (this.checkpointFloorTokens(agent.session, measurement, range, appendix) >= tokens) continue
        this.pressureBrakes.delete(agent.session)
        return this.compactRegion(range.start, range.end, agent, signal, undefined, users)
      }
      return null
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(policy, context.contextWindow, agent.session.requestHeader()?.config.maxTokens ?? 0)
    if (measurement.totalTokens < spec.thresholdTokens) return null
    // The thrash brake: sit out steps after failures, and after an ineffective
    // compaction wait for real growth on the same surface. Overflow recovery is
    // never braked: a request that does not fit is still recovered.
    const brake = this.pressureBrakes.get(agent.session)
    if (brake !== undefined && brake.skipSteps > 0) {
      brake.skipSteps -= 1
      return null
    }
    if (brake?.resume !== undefined && brake.resume.generation === agent.session.surface.replaceGeneration
      && measurement.totalTokens < brake.resume.tokens) return null
    try {
      const result = await this.compactUnderPressure(agent, spec, measurement, prune, prunedAtStep, signal)
      if (result !== null) this.recordPressureOutcome(agent.session, spec)
      return result
    } catch (error: unknown) {
      if (!signal.aborted) this.recordPressureFailure(agent.session)
      throw error
    }
  }

  /** Once pressure has qualified: prune, then summarize spans until below the threshold or out of attempts. */
  private async compactUnderPressure(
    agent: Agent,
    spec: ResolvedCompactSpec,
    initial: TokenMeasurement,
    prune: ToolResultPruner | undefined,
    prunedAtStep: readonly PrunedEntry[],
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const meter = this.ctx.tokenMeter
    let measurement = initial
    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    let pruned = prunedAtStep
    if (prune !== undefined) {
      const pass = pruneBelowWatermark(prune, agent.session, () => meter.measure(agent.session), spec)
      pruned = [...prunedAtStep, ...pass.pruned]
      measurement = meter.measure(agent.session)
      this.ctx.logger.info(
        `tool-result prune (pressure): ${pass.beforeTokens} -> ${pass.afterTokens} tokens `
        + `(threshold ${pass.thresholdTokens}, watermark ${pass.watermarkTokens}), ${pass.passes} passes, `
        + `rewrote ${pass.pruned.length} results, ${pass.charsRemoved} chars`,
      )
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null
    const replayed = shadowedBy(pruned)

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      signal.throwIfAborted()
      const selectedSeqs = spanNodes(measurement, range).map(node => node.seq)
      const sourceTokens = spanTokens(measurement, range)
      // The deterministic sections are part of every checkpoint, so a span too
      // small to hold them is skipped without an auxiliary call.
      const appendix = this.spanAppendix(agent.session, measurement, range)
      if (this.checkpointFloorTokens(agent.session, measurement, range, appendix) >= sourceTokens) return result
      const input = buildSummarizationInput(agent.session, selectedSeqs, replayed)
      const inputKey = pressureInputKey(input, sourceTokens, spec, appendix)
      if (this.noShrinkPressureInputs.get(agent.session) === inputKey) return result
      try {
        result = await this.compactRegion(range.start, range.end, agent, signal, replayed)
      } catch (error: unknown) {
        // A rejected replacement is distinct from failed inference, a changed
        // surface, cancellation, or a failed durable closing marker.
        if (error instanceof CompactionNoShrinkError && !signal.aborted) {
          this.noShrinkPressureInputs.set(
            agent.session,
            pressureInputKey(error.input, error.sourceTokens, spec, appendix),
          )
        }
        throw error
      }
      this.noShrinkPressureInputs.delete(agent.session)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * After a committed pressure compaction: the failure streak ends, and a
   * compaction that left the context near the threshold latches the brake until
   * the context grows by a retained tail on this surface generation.
   */
  private recordPressureOutcome(session: Session, spec: ResolvedCompactSpec): void {
    const after = this.ctx.tokenMeter.measure(session).totalTokens
    if (after < spec.thresholdTokens * INEFFECTIVE_SHARE) {
      this.pressureBrakes.delete(session)
      return
    }
    const resume = { tokens: after + Math.max(1, spec.retainTokens), generation: session.surface.replaceGeneration }
    this.pressureBrakes.set(session, { failures: 0, skipSteps: 0, resume })
    this.ctx.logger.info(`pressure compaction left ${after} tokens (threshold ${spec.thresholdTokens}); `
      + `the next waits for ${resume.tokens}`)
  }

  /** A failed pressure attempt: the next 1, 3, then 9 steps sit out pressure compaction. */
  private recordPressureFailure(session: Session): void {
    const brake = this.pressureBrakes.get(session) ?? { failures: 0, skipSteps: 0 }
    brake.failures += 1
    brake.skipSteps = FAILURE_BACKOFF_STEPS[Math.min(brake.failures, FAILURE_BACKOFF_STEPS.length) - 1]!
    this.pressureBrakes.set(session, brake)
  }

  /**
   * The pressure threshold the automatic trigger compares with, resolved
   * synchronously from the latest durable route and the capacity its request
   * logged (`request/context`). No model call, no side effect.
   * @param agent - agent whose latest routed request is read.
   * @returns the ratio threshold bounded by actual output reservation and input headroom, or
   *   `undefined` before the first request or when the policy cannot resolve.
   */
  override thresholdTokens(agent: CompactionAgentContext): number | undefined {
    try {
      const target = routedTarget(agent.session)
      if (target === undefined) return undefined
      const context = agent.session.requestContext()
      if (context?.provider !== target.provider || context.model !== target.model
        || context.contextWindow === undefined) return undefined
      return resolveCompactSpec(resolveTargetPolicy(this.config, target), context.contextWindow,
        agent.session.requestHeader()?.config.maxTokens ?? 0).thresholdTokens
    } catch {
      return undefined
    }
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @param replayed - nodes a prune rewrote at this step boundary, mapped to the nodes they shadowed; the summarizer replays those.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
    replayed?: ReadonlyMap<SessionSeq, SessionSeq>,
    users = 1,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(users),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface', ...replayed === undefined || replayed.size === 0 ? {} : { replayed } },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Build the deterministic checkpoint sections for one span of the current
   * surface with this engine's budgets, then the host's pointer to the full
   * condensed history (`checkpointLogPointer`) as the last section.
   * @param session - session whose visible surface is read.
   * @param shadowedSeqs - surface seqs the checkpoint would replace.
   * @param fromSurfaceStart - whether the span starts at the first compactable node.
   * @returns rendered sections and the carry-forward record.
   */
  protected checkpointAppendix(
    session: Session,
    shadowedSeqs: readonly SessionSeq[],
    fromSurfaceStart: boolean,
    users = 1,
  ): CheckpointAppendix {
    const pointer = this.config.checkpointLogPointer
    // A condensed checkpoint stands for the span it replaced, so the range
    // reaches back to the earliest original event, not to that checkpoint.
    const from = pointer === undefined ? undefined : condensedSpanStart(visibleMessages(session), new Set(shadowedSeqs))
    const range = from === undefined || shadowedSeqs.length === 0 ? undefined
      : { from, to: Math.max(...shadowedSeqs) }
    return withLogPointer(this.checkpointSections(session, shadowedSeqs, fromSurfaceStart, users),
      pointer === undefined || range === undefined ? undefined : pointer(range, session))
  }

  /**
   * The checkpoint byte budgets for this session's window: at most about
   * {@link CHECKPOINT_WINDOW_SHARE} of it, never more than the fixed budgets,
   * with the quoted user words further scaled by `users`.
   */
  private checkpointBudgets(session: Session, users: number): ResolvedCheckpointConfig {
    const base = this.config.checkpoint
    const window = session.requestContext()?.contextWindow
    const fixed = base.userMessageBytes + base.anchorBytes
    const room = window === undefined ? Infinity : window * 4 * CHECKPOINT_WINDOW_SHARE
    const scale = fixed <= room ? 1 : room / fixed
    if (scale === 1 && users === 1) return base
    return { ...base,
      userMessageBytes: Math.floor(base.userMessageBytes * scale * users),
      firstUserMessageMaxBytes: Math.floor(base.firstUserMessageMaxBytes * scale * users),
      userMessageMaxBytes: Math.floor(base.userMessageMaxBytes * scale * users),
      anchorBytes: Math.floor(base.anchorBytes * scale) }
  }

  /** The deterministic sections and record for one span. */
  private checkpointSections(
    session: Session,
    shadowedSeqs: readonly SessionSeq[],
    fromSurfaceStart: boolean,
    users: number,
  ): CheckpointAppendix {
    const cwd = session.header.cwd
    const config = this.checkpointBudgets(session, users)
    return buildCheckpointAppendix(visibleMessages(session), new Set(shadowedSeqs), {
      config,
      usersScaledOut: config.userMessageBytes === 0 && this.config.checkpoint.userMessageBytes > 0,
      readers: this.config.checkpointReaders,
      fromSurfaceStart,
      ...cwd === undefined ? {} : { cwd },
      recordedResult: (event) => {
        const recorded = recordedToolResult(session, event)
        return recorded === undefined ? undefined : session.deriveEventMessage(recorded) ?? undefined
      },
    })
  }

  /** Checkpoint sections for one selected span of the measured surface. */
  private spanAppendix(session: Session, measurement: TokenMeasurement, range: SurfaceRange, users = 1): CheckpointAppendix {
    return this.checkpointAppendix(
      session,
      spanNodes(measurement, range).map(node => node.seq),
      measurement.nodes.findIndex(node => node.seq === range.start) === firstCompactableIndex(session),
      users,
    )
  }

  /** Price of the smallest possible checkpoint for a span: its framing and deterministic sections. */
  private checkpointFloorTokens(
    session: Session,
    measurement: TokenMeasurement,
    range: SurfaceRange,
    appendix: CheckpointAppendix = this.spanAppendix(session, measurement, range),
  ): number {
    return this.ctx.tokenMeter.estimateMessage(createUserMessage({
      content: frameSummary([], appendix.blocks),
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    }))
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(users = 1): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      appendix: (session, shadowedSeqs, fromSurfaceStart) =>
        this.checkpointAppendix(session, shadowedSeqs, fromSurfaceStart, users),
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
