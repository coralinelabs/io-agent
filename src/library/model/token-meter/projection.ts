/**
 * Pure client-safe token-projection vocabulary.
 *
 * @module io-agent/token-meter/projection
 */

import type { RequestHeaderReason } from "../../session/journal/types.ts"

/**
 * Durable cumulative provider usage for a complete session log.
 *
 * The four buckets are disjoint. In particular, reasoning tokens are already
 * included in `outputTokens` and are not accumulated again.
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Approximate context occupancy for a status display.
 *
 * The fields, when present, are deliberately NOT one atomic request
 * observation: each is a last-wins record of a different moment. Switching
 * models can therefore pair a fresh capacity with the previous route's
 * pressure until the next request reports usage. This is an intentional trade
 * — the value is a user-facing reference, not a billing or gating input. See
 * the token-meter README for the full rationale.
 */
export interface ContextPressureProjection {
  /**
   * Provider-reported prompt size of the most recent request: uncached input
   * plus cache reads and writes. Response output is excluded, so this does not
   * grow as the current turn streams. Absent until a provider reports usage.
   */
  pressureTokens?: number
  /**
   * What the NEXT request's prompt would cost: {@link pressureTokens} plus the
   * heuristic repricing of everything the surface gained or lost since that
   * sample. Only the delta is estimated, so the figure stays anchored to the
   * provider while still reacting the moment a compaction shadows a span —
   * which `pressureTokens` alone cannot do, since compaction reports no usage
   * of its own. Absent until a provider reports usage.
   */
  projectedTokens?: number
  /** Newest recorded route capacity; absent when no adapter advertised one. */
  contextWindow?: number
}

/**
 * Heuristic composition of the next request's context: what the prompt is
 * made of, not what it costs. All three figures use the meter's fixed
 * density estimate, so they will not sum to the provider-anchored
 * `projectedTokens`: the estimator systematically underprices CJK text and
 * JSON schemas, which is exactly the error the anchoring in
 * {@link ContextPressureProjection.projectedTokens} keeps out of the occupancy
 * figure. Present these as approximations of composition, never as a total.
 */
export interface ContextBreakdownProjection {
  /** Heuristic tokens of the last nonempty surviving system prompt in surface order; 0 when none exists. */
  systemTokens: number
  /** Heuristic tokens of the newest request envelope's tool schemas; 0 before any request. */
  toolsTokens: number
  /** Heuristic tokens of every other visible surface node, including superseded system prompts. */
  messageTokens: number
}

/**
 * Prompt-token totals of one group of model requests. Counts are the disjoint
 * provider buckets: `promptTokens` is uncached input plus cache reads plus
 * cache writes, so `cacheReadTokens / promptTokens` is the group's prompt-cache
 * hit rate.
 */
export interface PromptCacheBucket {
  /** Requests counted in this group. */
  requests: number
  /** Uncached input + cache reads + cache writes across those requests. */
  promptTokens: number
  /** Provider-reported cache reads across those requests. */
  cacheReadTokens: number
  /** Provider-reported cache writes across those requests. */
  cacheWriteTokens: number
}

/**
 * Why the harness's next request no longer extends the previous request's
 * prompt byte for byte. Each value names the durable fact the cause was read
 * from. A request series that starts without one of these facts (a goal
 * round, a sampling-limit change) still extends the previous prompt and is
 * not a break:
 * - `system`: a `system/message` replaced an earlier system node (head rewrite).
 * - `tools`: the logged request header's tool schemas changed.
 * - `route`: the header's provider or model changed.
 * - `reasoning`: the header's reasoning effort changed.
 * - `prune`: a `compaction/prune` replaced old tool results.
 * - `compaction`: a `compaction/summary` replaced a history span.
 * - `image-offload`: an `image/offload` re-projected earlier messages.
 * - `surface`: any other surface replacement.
 */
export type PrefixBreakCause =
  | 'system'
  | 'tools'
  | 'route'
  | 'reasoning'
  | 'prune'
  | 'compaction'
  | 'image-offload'
  | 'surface'

/** One recorded prefix break, keyed to the request that opened it. */
export interface PrefixBreak {
  /** Zero-based index of the main request that opened the break. */
  requestIndex: number
  /** Seq of the `request/header` event that recorded it. */
  seq: number
  /** Turn and step of that request. */
  turn: number
  step: number
  /**
   * The logged `request/header` reason (the series vocabulary of the request
   * builder); a header with a reason newer than this build reads as `series`.
   */
  reason: Exclude<RequestHeaderReason, 'initial'>
  /** Sorted, unique causes read from the events since the previous request. */
  causes: PrefixBreakCause[]
}

/**
 * Prompt-cache accounting folded from the durable log: provider usage of main
 * agent requests plus the breaks the harness itself recorded.
 *
 * Buckets nest: `all` holds every main request with a cache-read count,
 * `warm` drops the session's first such (cold) request, and `steady` further
 * drops every request that opened a recorded break or a new loop instance
 * (`resume`). `compaction` holds the summariser's auxiliary requests. Rates are
 * computed from these integers by `sessionMetrics()`, never stored.
 *
 * A provider that sends no cache fields is marked `cacheReported: false` and
 * counted in {@link PromptCacheProjection.unreportedRequests}, not as a 0% hit.
 */
export interface PromptCacheProjection {
  all: PromptCacheBucket
  warm: PromptCacheBucket
  steady: PromptCacheBucket
  compaction: PromptCacheBucket
  /**
   * Main requests whose usage carried a malformed count, was marked
   * `cacheReported: false` (the provider sent no cache fields), or carried no
   * cache-read count that an exact `totalTokens` proves to be 0 (adapters that
   * omit the count, and journals from before zero counts were kept whose
   * samples lack an exact total).
   */
  unreportedRequests: number
  /**
   * Steady requests that read less than half of the previous main request's
   * prompt (the prefix they extend) from the cache: a miss the harness did not
   * cause, such as provider routing or eviction. New content appended after a
   * fully cached prefix is not a miss. Against a provider that does not cache,
   * or does not report caching, every steady request counts.
   */
  unexplainedMisses: number
  /** Loop instances that resumed an existing request series. */
  resumes: number
  /** Newest main request that reported cache counts. */
  last: {
    requestIndex: number
    seq: number
    promptTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  } | null
  breaks: {
    total: number
    byCause: Record<PrefixBreakCause, number>
    /** The newest 32 breaks, oldest first. */
    recent: PrefixBreak[]
  }
}

/** Compaction work folded from the durable log. */
export interface CompactionActivityProjection {
  /** Successful summary compactions (`compaction/summary`). */
  summaries: number
  /** Compaction attempts that ended with an error (`compaction/end` with `error`). */
  failedSummaries: number
  /** Tool results replaced by model-free pruning (`compaction/prune`), including the spill policy's per-step budget replacements. */
  prunedResults: number
  /** Largest provider-reported prompt of a main request. */
  peakPromptTokens: number
  /** The newest summary, with the prompt size of the main request before it. */
  lastSummary: { seq: number; promptTokensBefore: number | null } | null
}

declare module "../../session/projection/types.ts" {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Newest request pressure paired with the newest known route capacity. */
    contextPressure: ContextPressureProjection
    /** Heuristic system/tools/message composition of the next request. */
    contextBreakdown: ContextBreakdownProjection
    /** Prompt-cache hit accounting and recorded prefix breaks. */
    promptCache: PromptCacheProjection
    /** Summary, failure and prune counts plus the peak request prompt. */
    compactionActivity: CompactionActivityProjection
  }
}
