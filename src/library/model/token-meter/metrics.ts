/**
 * Pure prompt-cache and context-occupancy metrics over token-meter projections.
 *
 * Hit rates are derived from the integer projections at read time and never
 * stored. A rate is `null` when its group holds no prompt tokens with a
 * reported or provable cache-read count. Unreported cache usage is excluded
 * from rate denominators and counted separately; an explicit zero remains a
 * measured 0%. The pi-ai patch preserves this distinction at the wire boundary.
 *
 * @module io-agent/token-meter/metrics
 */

import type { TokenUsage } from "../llm/index.ts"
import { deepFreeze } from "../../util/values/index.ts"
import type {
  CompactionActivityProjection,
  ContextPressureProjection,
  PromptCacheBucket,
  PromptCacheProjection,
  TokenUsageProjection,
} from './projection.ts'

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Cache-read count of one usage sample.
 *
 * Journals written before the adapter kept zero cache counts omitted a zero
 * `cacheReadTokens` (and a zero `cacheWriteTokens`). `totalTokens` is exact
 * (input + output + cache reads + cache writes), so a sample without a read
 * count whose total equals input + output + cache writes proves the read was
 * 0; such a sample is a measured 0, not an unreported one. A provider's absent
 * cache fields are marked with `cacheReported: false` instead, which no
 * total overrides.
 * @param usage - one request's provider usage as journaled.
 * @returns the read count; 0 when the exact total proves it; `undefined` when
 *   the count is marked unreported, absent and unprovable, or malformed.
 */
export function cacheReadOf(usage: TokenUsage): number | undefined {
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } =
    usage as Partial<Record<keyof TokenUsage, unknown>>
  // The explicit marker outranks counters normalized by an adapter, too.
  // A synthetic zero (or contradictory positive count) is not a provider measurement.
  if (usage.cacheReported === false) return undefined
  if (cacheReadTokens !== undefined) return isCount(cacheReadTokens) ? cacheReadTokens : undefined
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(totalTokens)) return undefined
  const write = cacheWriteTokens ?? 0
  if (!isCount(write)) return undefined
  return totalTokens === inputTokens + outputTokens + write ? 0 : undefined
}

/**
 * Prompt-cache hit of one request: `cacheRead / (input + cacheRead + cacheWrite)`.
 * The usage counts are disjoint, so the denominator is the whole prompt.
 * @param usage - one request's provider usage.
 * @returns the hit ratio in [0, 1], or `undefined` when the request reported
 *   no provable cache-read count (see {@link cacheReadOf}), no prompt, or a
 *   malformed count.
 */
export function promptCacheHit(usage: TokenUsage): number | undefined {
  const { inputTokens, cacheWriteTokens } = usage
  const cacheReadTokens = cacheReadOf(usage)
  if (!isCount(inputTokens) || cacheReadTokens === undefined) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  const prompt = inputTokens + cacheReadTokens + (cacheWriteTokens ?? 0)
  return !isCount(prompt) || prompt === 0 ? undefined : cacheReadTokens / prompt
}

/**
 * Aggregate hit rate of one request group: Σ cache reads / Σ prompt tokens.
 * @param bucket - one prompt-cache group.
 * @returns the ratio, or `null` when the group has no prompt tokens.
 */
export function bucketHitRate(bucket: PromptCacheBucket): number | null {
  return bucket.promptTokens > 0 ? bucket.cacheReadTokens / bucket.promptTokens : null
}

/** {@link PromptCacheProjection} with its derived rates. */
export interface PromptCacheMetrics extends PromptCacheProjection {
  /**
   * Σ cached / Σ prompt over every main request with a cache-read count.
   * `null` when these requests contribute no prompt tokens. A provider that
   * sends no cache fields contributes to `unreportedRequests`, not this rate.
   */
  hitRate: number | null
  /** The same, excluding the session's first (cold) request. */
  warmHitRate: number | null
  /** The same, also excluding requests that opened a recorded break or a resume. */
  steadyHitRate: number | null
  /** Hit rate of the newest reported main request. */
  lastHitRate: number | null
  /** Hit rate of the summariser's auxiliary requests. */
  compactionHitRate: number | null
}

/** Context occupancy against the compaction threshold, plus compaction counts. */
export interface ContextMetrics {
  /** Newest advertised route capacity. */
  contextWindow?: number
  /** Request pressure at which automatic compaction starts, when resolvable. */
  thresholdTokens?: number
  /**
   * Current request pressure: the quantity the compaction trigger compares
   * with `thresholdTokens` (the token meter's measurement when the caller
   * supplies it, otherwise the projected next-request prompt).
   */
  tokens: number
  /** `tokens / thresholdTokens`; `null` without a threshold. */
  occupancy: number | null
  /** Largest provider-reported prompt of a main request. */
  peakPromptTokens: number
  /**
   * `peakPromptTokens / thresholdTokens`. Provider prompts are measured after
   * pruning or compaction already ran, so a pressure session peaks just below 1.
   */
  peakOccupancy: number | null
  /** Successful summary compactions. */
  compactions: number
  /** Compaction attempts that ended with an error. */
  failedCompactions: number
  /** Tool results replaced by model-free pruning, including the spill policy's per-step budget replacements. */
  prunedResults: number
}

/** One consistent read of a session's token, prompt-cache and context metrics. */
export interface SessionMetrics {
  /** Seq of the last journal event the values reflect; -1 for an empty log. */
  asOfSeq: number
  /** Cumulative provider usage (disjoint buckets). */
  tokens: TokenUsageProjection
  promptCache: PromptCacheMetrics
  context: ContextMetrics
}

/** Projection values and read-time facts combined by {@link sessionMetrics}. */
export interface SessionMetricsInput {
  asOfSeq: number
  tokenUsage: TokenUsageProjection
  contextPressure: ContextPressureProjection
  promptCache: PromptCacheProjection
  compactionActivity: CompactionActivityProjection
  /** Compaction threshold resolved from configuration; not journaled. */
  thresholdTokens?: number
  /** The token meter's current measurement; defaults to the projected next-request prompt. */
  measuredTokens?: number
}

const ratio = (numerator: number, denominator: number | undefined): number | null =>
  denominator === undefined || denominator <= 0 ? null : numerator / denominator

/**
 * Combine projection values into public session metrics.
 * @param input - the projection values of one read cut plus read-time facts.
 * @returns a deeply frozen metrics object.
 */
export function sessionMetrics(input: SessionMetricsInput): SessionMetrics {
  const { promptCache, compactionActivity, contextPressure, thresholdTokens } = input
  const last = promptCache.last
  const tokens = input.measuredTokens ?? contextPressure.projectedTokens ?? contextPressure.pressureTokens ?? 0
  const metrics: SessionMetrics = {
    asOfSeq: input.asOfSeq,
    tokens: structuredClone(input.tokenUsage),
    promptCache: {
      ...structuredClone(promptCache),
      hitRate: bucketHitRate(promptCache.all),
      warmHitRate: bucketHitRate(promptCache.warm),
      steadyHitRate: bucketHitRate(promptCache.steady),
      lastHitRate: last === null ? null : ratio(last.cacheReadTokens, last.promptTokens),
      compactionHitRate: bucketHitRate(promptCache.compaction),
    },
    context: {
      ...contextPressure.contextWindow === undefined ? {} : { contextWindow: contextPressure.contextWindow },
      ...thresholdTokens === undefined ? {} : { thresholdTokens },
      tokens,
      occupancy: ratio(tokens, thresholdTokens),
      peakPromptTokens: compactionActivity.peakPromptTokens,
      peakOccupancy: ratio(compactionActivity.peakPromptTokens, thresholdTokens),
      compactions: compactionActivity.summaries,
      failedCompactions: compactionActivity.failedSummaries,
      prunedResults: compactionActivity.prunedResults,
    },
  }
  return deepFreeze(metrics)
}
