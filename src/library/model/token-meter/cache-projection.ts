/**
 * Pure folds for prompt-cache accounting (`promptCache`) and compaction
 * activity (`compactionActivity`).
 *
 * Both units read only durable facts that the default runtime already
 * journals: provider usage on `assistant/message` / `assistant/attempt`
 * (cache counts are carried even when zero), the `request/header` series
 * reasons logged by the request builder, the surface replacements and their
 * shadow-price metering events, `image/offload`, and the `compaction/*`
 * lifecycle. Nothing here is model-visible and no event is added: the rates
 * are a replayable fold, identical live, on resume, and offline over a JSONL
 * log. The module stays client-importable: its runtime imports are the
 * node-free leaves `llm/assistant-stream.ts`, `journal/surface.ts` and
 * `metrics.ts` (plus zod), never the `llm` or `journal` barrels.
 *
 * Request identity mirrors `tokenUsage` exactly, so the prompt sums reconcile
 * with it: one slot per `(turn, step)`, replaced by a later sample for the
 * same step unless `llm/retry-started` closes the slot first. Samples whose
 * prompt is 0 (a failed attempt that reported empty usage) are not requests.
 *
 * @module io-agent/token-meter/cache-projection
 */

import { z } from 'zod'
import { lastAssistantStreamChunk } from "../llm/assistant-stream.ts"
import type { TokenUsage } from "../llm/index.ts"
import type {} from "../retry/types.ts"
import { isReplacementSurfaceEvent } from "../../session/journal/surface.ts"
import type { RequestHeaderReason, SessionEvent } from "../../session/journal/index.ts"
// Type-only: the `compaction/*` and `image/offload` SessionEventMap merges.
import type {} from "../../context/compaction/compaction/index.ts"
import type {} from "../../context/compaction/image-offload/projection.ts"
import type { ProjectionDefinition } from "../../session/projection/index.ts"
import type {
  CompactionActivityProjection,
  PrefixBreak,
  PrefixBreakCause,
  PromptCacheBucket,
  PromptCacheProjection,
} from './projection.ts'
import { cacheReadOf } from './metrics.ts'

/** Every break cause, in the order `causes` arrays are sorted. */
export const PREFIX_BREAK_CAUSES = [
  'system',
  'tools',
  'route',
  'reasoning',
  'prune',
  'compaction',
  'image-offload',
  'surface',
] as const satisfies readonly PrefixBreakCause[]

/** How many recent breaks the projection keeps. */
export const RECENT_PREFIX_BREAKS = 32

/**
 * A steady request is an unexplained miss when it reads less than this share
 * of the previous main request's prompt (the prefix it extends) from cache.
 */
const MISS_RATIO = 0.5

const count = z.number().int().nonnegative()
const causeSchema = z.enum(PREFIX_BREAK_CAUSES)

const bucketSchema: z.ZodType<PromptCacheBucket> = z.object({
  requests: count,
  promptTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
}).strict()

const breakSchema: z.ZodType<PrefixBreak> = z.object({
  requestIndex: count,
  seq: count,
  turn: count,
  step: count,
  reason: z.enum(['resume', 'change', 'series']),
  causes: z.array(causeSchema),
}).strict()

const byCauseSchema = z.object({
  system: count,
  tools: count,
  route: count,
  reasoning: count,
  prune: count,
  compaction: count,
  'image-offload': count,
  surface: count,
}).strict()

const promptCacheViewSchema: z.ZodType<PromptCacheProjection> = z.object({
  all: bucketSchema,
  warm: bucketSchema,
  steady: bucketSchema,
  compaction: bucketSchema,
  unreportedRequests: count,
  unexplainedMisses: count,
  resumes: count,
  last: z.object({
    requestIndex: count,
    seq: count,
    promptTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
  }).strict().nullable(),
  breaks: z.object({
    total: count,
    byCause: byCauseSchema,
    recent: z.array(breakSchema).max(RECENT_PREFIX_BREAKS),
  }).strict(),
}).strict()

/** Prompt-side counts of one reported sample. */
const sampleSchema = z.object({
  promptTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
}).strict()

/**
 * The prompt-cache unit's state. `stats` is the public view and is kept by
 * reference across internal-only transitions, so the change feed publishes
 * only real accounting changes.
 */
const promptCacheStateSchema = z.object({
  stats: promptCacheViewSchema,
  /** Main-request slots opened so far; the next slot's `requestIndex`. */
  requests: count,
  /** The newest request slot; `sample: null` records an unreported sample. */
  slot: z.object({
    turn: count,
    step: count,
    index: count,
    sample: sampleSchema.nullable(),
    /** The sample was the session's first reported request (excluded from `warm`). */
    first: z.boolean(),
    /** The request opened a recorded break or a loop instance (excluded from `steady`). */
    opened: z.boolean(),
    /**
     * Prompt of the newest reported main request before this slot opened:
     * the cacheable prefix a steady request extends. `null` for the first.
     */
    base: count.nullable(),
  }).strict().nullable(),
  /** Turn and step of the newest `step/start`. */
  step: z.object({ turn: count, step: count }).strict().nullable(),
  /** Causes seen since the previous request header, sorted and unique. */
  pending: z.array(causeSchema),
  /**
   * Seq of the newest main assistant response (`assistant/message` or
   * `assistant/attempt`). A surface node appended after it was in no request
   * sent so far, so rewriting it before the next send breaks no prefix.
   */
  responded: count,
  /** The previous event was a shadow-price metering event whose replacement is next. */
  metered: z.boolean(),
  /** Prefix-relevant keys of the newest logged request header. */
  header: z.object({
    tools: count,
    provider: z.string(),
    model: z.string(),
    reasoning: z.string().nullable(),
  }).strict().nullable(),
  /** The next reported sample opens a break or a loop instance. */
  opens: z.boolean(),
}).strict()

type PromptCacheState = z.infer<typeof promptCacheStateSchema>
type Sample = z.infer<typeof sampleSchema>

const compactionActivityViewSchema: z.ZodType<CompactionActivityProjection> = z.object({
  summaries: count,
  failedSummaries: count,
  prunedResults: count,
  peakPromptTokens: count,
  lastSummary: z.object({ seq: count, promptTokensBefore: count.nullable() }).strict().nullable(),
}).strict()

const compactionActivityStateSchema = z.object({
  stats: compactionActivityViewSchema,
  /** Prompt of the newest main-request sample. */
  lastPromptTokens: count.nullable(),
}).strict()

type CompactionActivityState = z.infer<typeof compactionActivityStateSchema>

declare module "../../session/projection/types.ts" {
  interface SessionProjectionStateMap {
    promptCache: PromptCacheState
    compactionActivity: CompactionActivityState
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const zeroBucket = (): PromptCacheBucket => ({ requests: 0, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

const zeroByCause = (): Record<PrefixBreakCause, number> => ({
  system: 0,
  tools: 0,
  route: 0,
  reasoning: 0,
  prune: 0,
  compaction: 0,
  'image-offload': 0,
  surface: 0,
})

/** The usage one durable Assistant settlement reports for its attempt, if any (as `tokenUsage` reads it). */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

/**
 * Classify one usage sample.
 * @param usage - provider usage as journaled.
 * @returns the reported prompt counts; `'unreported'` when the cache-read
 *   count is absent and not proven 0 by an exact total ({@link cacheReadOf},
 *   which covers journals written before zero counts were kept), or any count
 *   is malformed; `undefined` for an empty (prompt 0) sample, which is not a
 *   request.
 */
function classifySample(usage: TokenUsage): Sample | 'unreported' | undefined {
  const { inputTokens, cacheReadTokens: rawRead, cacheWriteTokens } = usage as Partial<Record<keyof TokenUsage, unknown>>
  if (!isCount(inputTokens)) return 'unreported'
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return 'unreported'
  const write = cacheWriteTokens ?? 0
  const cacheReadTokens = cacheReadOf(usage)
  if (cacheReadTokens === undefined) {
    return rawRead === undefined && inputTokens + write === 0 ? undefined : 'unreported'
  }
  const promptTokens = inputTokens + cacheReadTokens + write
  if (!Number.isSafeInteger(promptTokens)) return 'unreported'
  return promptTokens === 0 ? undefined : { promptTokens, cacheReadTokens, cacheWriteTokens: write }
}

/** Provider prompt of one sample (uncached input plus cache traffic), or undefined when not countable. */
function promptOf(usage: TokenUsage): number | undefined {
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = usage as Partial<Record<keyof TokenUsage, unknown>>
  if (!isCount(inputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  const prompt = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  return Number.isSafeInteger(prompt) ? prompt : undefined
}

const addSample = (bucket: PromptCacheBucket, sample: Sample, sign: 1 | -1): PromptCacheBucket => ({
  requests: bucket.requests + sign,
  promptTokens: bucket.promptTokens + sign * sample.promptTokens,
  cacheReadTokens: bucket.cacheReadTokens + sign * sample.cacheReadTokens,
  cacheWriteTokens: bucket.cacheWriteTokens + sign * sample.cacheWriteTokens,
})

const sameSample = (left: Sample | null, right: Sample | null): boolean =>
  left === null || right === null
    ? left === right
    : left.promptTokens === right.promptTokens
      && left.cacheReadTokens === right.cacheReadTokens
      && left.cacheWriteTokens === right.cacheWriteTokens

/** Which buckets and counters one slot contributes to. */
interface SlotContribution {
  sample: Sample | null
  warm: boolean
  steady: boolean
  miss: boolean
}

/**
 * One slot's contribution. A miss is measured against `base`, the prefix the
 * request extends, not against its own prompt: a full hit followed by a large
 * appended tool result is not a miss.
 */
function contributionOf(sample: Sample | null, first: boolean, opened: boolean, base: number | null): SlotContribution {
  const warm = sample !== null && !first
  const steady = warm && !opened
  return {
    sample,
    warm,
    steady,
    miss: steady && base !== null && sample.cacheReadTokens < base * MISS_RATIO,
  }
}

/** Apply (sign 1) or withdraw (sign -1) one slot's contribution. */
function applyContribution(
  stats: PromptCacheProjection,
  contribution: SlotContribution,
  sign: 1 | -1,
): PromptCacheProjection {
  const { sample } = contribution
  if (sample === null) return { ...stats, unreportedRequests: stats.unreportedRequests + sign }
  return {
    ...stats,
    all: addSample(stats.all, sample, sign),
    warm: contribution.warm ? addSample(stats.warm, sample, sign) : stats.warm,
    steady: contribution.steady ? addSample(stats.steady, sample, sign) : stats.steady,
    unexplainedMisses: stats.unexplainedMisses + (contribution.miss ? sign : 0),
  }
}

/**
 * 53-bit string hash (cyrb53). Pure and dependency-free so the fold stays
 * client-importable; used only to notice a tool-schema change between two
 * logged headers.
 */
function hashString(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** Sorted union of cause lists in {@link PREFIX_BREAK_CAUSES} order. */
function withCauses(current: readonly PrefixBreakCause[], added: readonly PrefixBreakCause[]): PrefixBreakCause[] {
  const set = new Set<PrefixBreakCause>([...current, ...added])
  return PREFIX_BREAK_CAUSES.filter(cause => set.has(cause))
}

/** Add one pending cause, keeping the same state reference when it is already pending. */
function pend(state: PromptCacheState, cause: PrefixBreakCause): PromptCacheState {
  return state.pending.includes(cause) ? state : { ...state, pending: withCauses(state.pending, [cause]) }
}

/** Prefix keys of one logged header, or `null` when the header is malformed. */
function headerKeys(header: unknown): PromptCacheState['header'] {
  if (typeof header !== 'object' || header === null) return null
  const { config, tools } = header as { config?: unknown; tools?: unknown }
  // Read the logged fields directly: the request builder logs canonical
  // headers, where an empty tool list is an absent field.
  const route = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>
  const text = (value: unknown): string => typeof value === 'string' ? value : ''
  return {
    tools: hashString(JSON.stringify(Array.isArray(tools) ? tools : [])),
    provider: text(route['provider']),
    model: text(route['model']),
    reasoning: typeof route['reasoningEffort'] === 'string' ? route['reasoningEffort'] : null,
  }
}

/**
 * Fold one `request/header`: classify the break it opens, if any, and store
 * its prefix keys.
 *
 * A break is recorded only from a durable cause: a pending surface cause or a
 * prefix-relevant header difference. A series start without one (a goal
 * round's `startsRequestSeries`, a `change` header whose difference is only a
 * sampling limit) appended to the surface, so the prompt still extends the
 * previous one byte for byte: it is not a break and the request stays steady.
 */
function foldHeader(state: PromptCacheState, event: SessionEvent<'request/header'>): PromptCacheState {
  const { reason } = event.data
  const keys = headerKeys(event.data.header)
  if (keys === null) return state
  const previous = state.header
  const differences: PrefixBreakCause[] = []
  if (previous !== null) {
    if (previous.tools !== keys.tools) differences.push('tools')
    if (previous.provider !== keys.provider || previous.model !== keys.model) differences.push('route')
    if (previous.reasoning !== keys.reasoning) differences.push('reasoning')
  }

  let stats = state.stats
  let causes: PrefixBreakCause[]
  let opens = state.opens
  const knownReason: RequestHeaderReason = reason
  switch (knownReason) {
    case 'initial':
      causes = []
      break
    case 'resume':
      // A new loop instance: the provider cache may still be warm, so it is a
      // break only when a recorded cause precedes it, but never steady.
      stats = { ...stats, resumes: stats.resumes + 1 }
      causes = withCauses(state.pending, differences)
      opens = true
      break
    case 'change':
    case 'series':
      causes = withCauses(state.pending, differences)
      break
    default: {
      // A new reason must extend this switch; at runtime an unknown reason
      // from a newer log is folded like `series`: a break only from a
      // recorded cause, reported with reason `series`.
      const unknown: never = knownReason
      void unknown
      causes = withCauses(state.pending, differences)
      break
    }
  }

  if (causes.length > 0) {
    opens = true
    const byCause = { ...stats.breaks.byCause }
    for (const cause of causes) byCause[cause] += 1
    const entry: PrefixBreak = {
      requestIndex: state.requests,
      seq: event.seq,
      turn: state.step?.turn ?? 0,
      step: state.step?.step ?? 0,
      reason: knownReason === 'resume' || knownReason === 'change' ? knownReason : 'series',
      causes,
    }
    stats = {
      ...stats,
      breaks: {
        total: stats.breaks.total + 1,
        byCause,
        recent: [...stats.breaks.recent, entry].slice(-RECENT_PREFIX_BREAKS),
      },
    }
  }
  return { ...state, stats, header: keys, pending: [], opens }
}

/** Fold one main-request usage sample into its `(turn, step)` slot. */
function foldSample(
  state: PromptCacheState,
  event: SessionEvent<'assistant/message' | 'assistant/attempt'>,
  usage: TokenUsage,
): PromptCacheState {
  const classified = classifySample(usage)
  if (classified === undefined) return state
  const sample = classified === 'unreported' ? null : classified
  const { turn, step } = event.data
  const previous = state.slot !== null && state.slot.turn === turn && state.slot.step === step
    ? state.slot
    : undefined
  if (previous !== undefined && sameSample(previous.sample, sample)) return state

  let stats = state.stats
  let requests = state.requests
  let opens = state.opens
  let index: number
  let opened: boolean
  let base: number | null
  if (previous !== undefined) {
    stats = applyContribution(stats, contributionOf(previous.sample, previous.first, previous.opened, previous.base), -1)
    index = previous.index
    opened = previous.opened
    base = previous.base
  } else {
    index = requests
    requests += 1
    opened = opens
    opens = false
    base = stats.last?.promptTokens ?? null
  }
  const first = sample !== null && stats.all.requests === 0
  stats = applyContribution(stats, contributionOf(sample, first, opened, base), 1)
  if (sample !== null) {
    stats = {
      ...stats,
      last: {
        requestIndex: index,
        seq: event.seq,
        promptTokens: sample.promptTokens,
        cacheReadTokens: sample.cacheReadTokens,
        cacheWriteTokens: sample.cacheWriteTokens,
      },
    }
  }
  return {
    ...state,
    stats,
    requests,
    opens,
    slot: { turn, step, index, sample, first, opened, base },
  }
}

/**
 * Token-meter's prompt-cache projection unit.
 *
 * Break classification reads the events since the previous request header:
 * a `system/message` replacement is `system`; `compaction/prune` and
 * `compaction/summary` (with the replacement adjacent to them) are `prune`
 * and `compaction`, except that a prune of results appended after the newest
 * main response (which no request has sent) is no cause; `image/offload` is
 * `image-offload`; any other surface
 * replacement is `surface`. The next `request/header` then records one break
 * from those causes plus its own header differences (`tools`, `route`,
 * `reasoning`). A series header with neither is not a break (see
 * {@link foldHeader}). Sampling limits (`maxTokens`, temperature, stop) do not
 * change the prompt prefix and are not breaks. In-history system appends are
 * appends, not breaks.
 */
export const promptCacheProjectionDefinition = {
  key: 'promptCache',
  // 2: `series` is no longer a cause, slots carry `base`, zero reads of older journals are proven from totals.
  // 3: `responded`: a prune of results no request has sent is not a cause.
  // 4: explicit unreported usage outranks adapter-normalized cache counters.
  stateVersion: 4,
  stateSchema: promptCacheStateSchema,
  init: () => ({
    stats: {
      all: zeroBucket(),
      warm: zeroBucket(),
      steady: zeroBucket(),
      compaction: zeroBucket(),
      unreportedRequests: 0,
      unexplainedMisses: 0,
      resumes: 0,
      last: null,
      breaks: { total: 0, byCause: zeroByCause(), recent: [] },
    },
    requests: 0,
    slot: null,
    step: null,
    pending: [],
    responded: 0,
    metered: false,
    header: null,
    opens: false,
  }),
  apply: (state, event) => {
    const afterMetering = state.metered
    const metering = event.type === 'compaction/prune' || event.type === 'compaction/summary'
    let next = afterMetering === metering ? state : { ...state, metered: metering }

    switch (event.type) {
      case 'step/start':
        next = { ...next, step: { turn: event.data.turn, step: event.data.step } }
        break
      case 'llm/retry-started':
        if (next.slot !== null && next.slot.turn === event.data.turn && next.slot.step === event.data.step) {
          next = { ...next, slot: null }
        }
        break
      case 'compaction/prune':
        // A rewrite of results no request has sent yet (the spill policy's
        // per-step budget, before the step's first send) extends the previous
        // prompt unchanged: the request builder starts no series for it either.
        if (event.data.shadowedSeqs.some(seq => seq <= next.responded)) next = pend(next, 'prune')
        break
      case 'compaction/summary': {
        next = pend(next, 'compaction')
        const usage = event.data.usage
        const sample = usage === undefined ? undefined : classifySample(usage)
        if (sample !== undefined && sample !== 'unreported') {
          next = { ...next, stats: { ...next.stats, compaction: addSample(next.stats.compaction, sample, 1) } }
        }
        break
      }
      case 'image/offload':
        next = pend(next, 'image-offload')
        break
      case 'request/header':
        next = foldHeader(next, event)
        break
      case 'assistant/message':
      case 'assistant/attempt': {
        const usage = usageOf(event)
        if (usage !== undefined) next = foldSample(next, event, usage)
        next = { ...next, responded: event.seq }
        break
      }
      default:
        break
    }

    if (isReplacementSurfaceEvent(event)) {
      if (event.type === 'system/message') next = pend(next, 'system')
      // A metered replacement's cause was recorded by its metering event.
      else if (!afterMetering) next = pend(next, 'surface')
    }
    return next
  },
  wire: { viewSchema: promptCacheViewSchema, view: state => state.stats },
} satisfies ProjectionDefinition<'promptCache', PromptCacheState>

/**
 * Token-meter's compaction-activity projection unit: how often the
 * session summarised, failed to, or pruned, and the largest provider prompt a
 * main request carried. The compaction threshold is configuration, not a
 * journaled fact, so occupancy is computed at read time by `sessionMetrics()`.
 */
export const compactionActivityProjectionDefinition = {
  key: 'compactionActivity',
  stateVersion: 1,
  stateSchema: compactionActivityStateSchema,
  init: () => ({
    stats: { summaries: 0, failedSummaries: 0, prunedResults: 0, peakPromptTokens: 0, lastSummary: null },
    lastPromptTokens: null,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'compaction/summary':
        return {
          ...state,
          stats: {
            ...state.stats,
            summaries: state.stats.summaries + 1,
            lastSummary: { seq: event.seq, promptTokensBefore: state.lastPromptTokens },
          },
        }
      case 'compaction/end':
        return event.data.error === undefined
          ? state
          : { ...state, stats: { ...state.stats, failedSummaries: state.stats.failedSummaries + 1 } }
      case 'compaction/prune':
        return { ...state, stats: { ...state.stats, prunedResults: state.stats.prunedResults + 1 } }
      case 'assistant/message':
      case 'assistant/attempt': {
        const usage = usageOf(event)
        const prompt = usage === undefined ? undefined : promptOf(usage)
        if (prompt === undefined || prompt === 0) return state
        const stats = prompt > state.stats.peakPromptTokens
          ? { ...state.stats, peakPromptTokens: prompt }
          : state.stats
        return prompt === state.lastPromptTokens && stats === state.stats
          ? state
          : { stats, lastPromptTokens: prompt }
      }
      default:
        return state
    }
  },
  wire: { viewSchema: compactionActivityViewSchema, view: state => state.stats },
} satisfies ProjectionDefinition<'compactionActivity', CompactionActivityState>
