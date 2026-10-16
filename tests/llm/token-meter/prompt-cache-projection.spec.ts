// promptCache / compactionActivity projections: hit-rate buckets, request
// identity shared with tokenUsage, and prefix-break causes read from the log.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { TokenUsage, ToolSchema } from "../../../src/library/model/llm/index.ts"
import SessionStore from "../../../src/library/session/journal/index.ts"
import type { Session } from "../../../src/library/session/journal/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import TokenMeter from "../../../src/library/model/token-meter/index.ts"
import { promptCacheHit, sessionMetrics } from "../../../src/library/model/token-meter/metrics.ts"
import type { PromptCacheProjection } from "../../../src/library/model/token-meter/projection.ts"
import ToolResultPruner from "../../../src/library/context/compaction/tool-result-pruner/index.ts"
import { CompactionId } from "../../../src/library/context/compaction/compaction/index.ts"
import { RetryId } from "../../../src/library/model/retry/index.ts"

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const CONFIG = { provider: 'test', model: 'test-model' }
const TOOLS: ToolSchema[] = [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }]
const MORE_TOOLS: ToolSchema[] = [...TOOLS, { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }]
const usage = (input: number, read?: number, write?: number): TokenUsage => ({
  inputTokens: input, outputTokens: 5,
  ...read === undefined ? {} : { cacheReadTokens: read },
  ...write === undefined ? {} : { cacheWriteTokens: write },
})
/** Usage as older adapters journaled it: zero cache counts omitted, exact total kept. */
const legacyUsage = (input: number, read: number): TokenUsage => ({
  inputTokens: input, outputTokens: 5, totalTokens: input + 5 + read, ...read > 0 ? { cacheReadTokens: read } : {},
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolResultPruner, { thresholdChars: 200, headChars: 50, tailChars: 50,
    retention: { keepRecentToolGroups: 0, preserveErrors: true, preserveMedia: true, minimumSavingsChars: 0 } })
  return { ctx, session: ctx.sessions.create() }
}

function attempt(session: Session, turn: number, step: number, sample: TokenUsage, error = false): void {
  session.append('assistant/attempt', { turn, step, stream: [
    { type: 'chunk', time: 0, chunk: { type: 'usage', usage: sample } },
    ...error ? [{ type: 'chunk' as const, time: 1, chunk: { type: 'finish' as const,
      reason: { kind: 'error' as const, failure: { code: 'RATE_LIMIT', message: 'busy', status: 429 } } } }] : [],
  ] })
}

function message(session: Session, turn: number, step: number, sample: TokenUsage, toolText?: string): void {
  const callId = ToolCallId(`call-${turn}-${step}`)
  session.append('assistant/message', {
    turn, step, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: sample } }], usage: sample,
    message: createMessage({ role: 'assistant', source: { kind: 'model', ...CONFIG },
      content: toolText === undefined ? [{ type: 'text', text: 'ok' }] : [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] }),
  }, { surfaceOp: 'append' })
  if (toolText !== undefined) {
    session.append('tool/call', { turn, step, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', { turn, step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: toolText }], isError: false }) }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step })
}

const header = (session: Session, reason: 'initial' | 'resume' | 'change' | 'series', tools = TOOLS, extra: object = {}): void => {
  session.append('request/header', { header: { config: { ...CONFIG, ...extra }, tools }, reason, ...reason === 'change' ? { startsSeries: true as const } : {} })
}

const cache = (ctx: Context, session: Session): PromptCacheProjection => {
  const value = ctx.sessionProjections.snapshot(session, ['promptCache']).values.promptCache
  if (value === undefined) throw new Error('promptCache projection is not registered')
  return value
}

describe('promptCache session projection', () => {
  it('buckets hits by request, excludes cold and break-opening requests, and records each break with its cause', async () => {
    const { ctx, session } = await harness()
    const changes: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => { if (key === 'promptCache') changes.push(value) })
    const system = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('rules', 'system') }, { surfaceOp: 'append' }).seq
    const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' }).seq
    expect(cache(ctx, session).last).toBeNull()

    // r0: the cold first request; a measured 0% is still a reported sample.
    session.append('step/start', { turn: 1, step: 1 })
    header(session, 'initial')
    message(session, 1, 1, usage(1000, 0, 0), 'x'.repeat(2000))
    // r1: a failed attempt with empty usage is not a request; the retry is.
    session.append('step/start', { turn: 1, step: 2 })
    attempt(session, 1, 2, usage(0, 0, 0), true)
    message(session, 1, 2, usage(100, 900, 0))
    // r2, r3: llm/retry-started closes the slot, so both attempts count (as tokenUsage does).
    session.append('step/start', { turn: 1, step: 3 })
    attempt(session, 1, 3, usage(50, 950), true)
    session.append('llm/retry-started', { retryId: RetryId('retry-1'), turn: 1, step: 3, retry: 1 })
    message(session, 1, 3, usage(60, 960, 20))
    const beforeStep = changes.length
    session.append('step/start', { turn: 1, step: 4 })
    expect(changes).toHaveLength(beforeStep) // internal-only transitions publish nothing
    // r4: a system head rewrite.
    session.append('system/message', { turn: 1, step: 4, message: createSystemMessage('rules v2', 'system') },
      { surfaceOp: { op: 'replace', startSeq: system, endSeq: system }, sourceEventSeqs: [system] })
    header(session, 'series')
    message(session, 1, 4, usage(800, 200, 0))
    // r5: pruning (real pruner: compaction/prune + adjacent tool/result replace); unreported usage.
    session.append('step/start', { turn: 1, step: 5 })
    expect(ctx.toolResultPruner.pruneSession(session).pruned).toHaveLength(1)
    header(session, 'series')
    message(session, 1, 5, usage(500))
    // r6: a tool-set change.
    session.append('step/start', { turn: 1, step: 6 })
    header(session, 'change', MORE_TOOLS)
    message(session, 1, 6, usage(1000, 0, 0))
    // r7: a sampling-only change is not a prefix break; an identical chunk + final usage counts once.
    session.append('step/start', { turn: 1, step: 7 })
    session.append('request/header', { header: { config: { ...CONFIG, maxTokens: 99 }, tools: MORE_TOOLS }, reason: 'change' })
    attempt(session, 1, 7, usage(10, 1100, 0))
    message(session, 1, 7, usage(10, 1100, 0))
    // r8: a steady request that missed: provider-side, unexplained by the harness.
    session.append('step/start', { turn: 1, step: 8 })
    message(session, 1, 8, usage(900, 200, 0))
    // r9: a summary compaction (metering event + adjacent replacement) with its own auxiliary usage.
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: 1 })
    session.append('compaction/summary', { compactionId: CompactionId('c1'), summary: [{ type: 'text', text: 'sum' }],
      shadowedRange: { start: user, end: user }, shadowedSeqs: [user], shadowedTokenCount: 3, provider: 'test', model: 'test-model',
      usage: usage(100, 1000, 0) })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: user, endSeq: user }, sourceEventSeqs: [user] })
    session.append('compaction/end', { compactionId: CompactionId('c1'), turn: 1 })
    session.append('step/start', { turn: 1, step: 9 })
    header(session, 'series', MORE_TOOLS, { maxTokens: 99 })
    message(session, 1, 9, usage(50, 500, 0))
    // r10: a new loop instance over the log: not a break, but not steady either.
    session.append('step/start', { turn: 2, step: 1 })
    header(session, 'resume', MORE_TOOLS, { maxTokens: 99 })
    message(session, 2, 1, usage(5, 1200, 0))

    const value = cache(ctx, session)
    expect(value.all).toEqual({ requests: 10, promptTokens: 1000 + 1000 + 1000 + 1040 + 1000 + 1000 + 1110 + 1100 + 550 + 1205,
      cacheReadTokens: 900 + 950 + 960 + 200 + 1100 + 200 + 500 + 1200, cacheWriteTokens: 20 })
    // warm drops r0; steady also drops r4, r6, r9 (breaks) and r10 (resume). r5 is unreported.
    expect(value.warm).toEqual({ requests: 9, promptTokens: value.all.promptTokens - 1000, cacheReadTokens: value.all.cacheReadTokens, cacheWriteTokens: 20 })
    expect(value.steady).toEqual({ requests: 5, promptTokens: 1000 + 1000 + 1040 + 1110 + 1100, cacheReadTokens: 900 + 950 + 960 + 1100 + 200, cacheWriteTokens: 20 })
    expect(value.compaction).toEqual({ requests: 1, promptTokens: 1100, cacheReadTokens: 1000, cacheWriteTokens: 0 })
    expect(value).toMatchObject({ unreportedRequests: 1, unexplainedMisses: 1, resumes: 1,
      last: { requestIndex: 10, promptTokens: 1205, cacheReadTokens: 1200, cacheWriteTokens: 0 } })
    expect(value.breaks.recent.map(({ requestIndex, reason, causes, turn, step }) => ({ requestIndex, reason, causes, turn, step }))).toEqual([
      { requestIndex: 4, reason: 'series', causes: ['system'], turn: 1, step: 4 },
      { requestIndex: 5, reason: 'series', causes: ['prune'], turn: 1, step: 5 },
      { requestIndex: 6, reason: 'change', causes: ['tools'], turn: 1, step: 6 },
      { requestIndex: 9, reason: 'series', causes: ['compaction'], turn: 1, step: 9 },
    ])
    expect(value.breaks.total).toBe(4)
    expect(value.breaks.byCause).toEqual({ system: 1, tools: 1, route: 0, reasoning: 0, prune: 1, compaction: 1, 'image-offload': 0, surface: 0 })

    // Same request identity as tokenUsage: every prompt token is accounted for once.
    const tokens = ctx.sessionProjections.snapshot(session, ['tokenUsage']).values.tokenUsage!
    expect(value.all.promptTokens + 500).toBe(tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens)
    expect(value.all.cacheReadTokens).toBe(tokens.cacheReadTokens)

    // Derived rates, and compaction activity.
    const activity = ctx.sessionProjections.snapshot(session, ['compactionActivity']).values.compactionActivity!
    expect(activity).toMatchObject({ summaries: 1, failedSummaries: 0, prunedResults: 1, peakPromptTokens: 1205,
      lastSummary: { promptTokensBefore: 1100 } })
    const metrics = sessionMetrics({ asOfSeq: session.seq - 1, tokenUsage: tokens, promptCache: value, compactionActivity: activity,
      contextPressure: {}, thresholdTokens: 2000, measuredTokens: 1500 })
    expect(metrics.promptCache.hitRate).toBeCloseTo(value.all.cacheReadTokens / value.all.promptTokens, 12)
    expect(metrics.promptCache.steadyHitRate).toBeCloseTo(value.steady.cacheReadTokens / value.steady.promptTokens, 12)
    expect(metrics.promptCache.lastHitRate).toBeCloseTo(1200 / 1205, 12)
    expect(metrics.context).toMatchObject({ thresholdTokens: 2000, tokens: 1500, occupancy: 0.75, peakOccupancy: 1205 / 2000,
      compactions: 1, prunedResults: 1, failedCompactions: 0 })
    expect(Object.isFrozen(metrics.promptCache.breaks.recent)).toBe(true)
  })

  it('does not record a break for a series start whose prompt still extends the previous one', async () => {
    const { ctx, session } = await harness()
    session.append('step/start', { turn: 1, step: 1 })
    header(session, 'initial')
    message(session, 1, 1, usage(1000, 0, 0))
    // A goal round: the request builder logs a cause-less `series` header.
    session.append('step/start', { turn: 2, step: 1 })
    header(session, 'series')
    message(session, 2, 1, usage(100, 960, 0))
    // A sampling-limit change coinciding with a series start: still no prefix fact.
    session.append('step/start', { turn: 3, step: 1 })
    session.append('request/header', { header: { config: { ...CONFIG, maxTokens: 64 }, tools: TOOLS }, reason: 'change', startsSeries: true })
    message(session, 3, 1, usage(100, 1024, 0))
    const value = cache(ctx, session)
    expect(value.breaks).toEqual({ total: 0, byCause: { system: 0, tools: 0, route: 0, reasoning: 0, prune: 0, compaction: 0, 'image-offload': 0, surface: 0 }, recent: [] })
    expect(value.steady).toEqual({ requests: 2, promptTokens: 1060 + 1124, cacheReadTokens: 960 + 1024, cacheWriteTokens: 0 })
  })

  it('does not count a prune of results no request has sent yet as a break cause', async () => {
    const { ctx, session } = await harness()
    session.append('step/start', { turn: 1, step: 1 })
    header(session, 'initial')
    // The tool result lands after the response; the spill policy's per-step budget rewrites it before any send.
    message(session, 1, 1, usage(1000, 0, 0), 'x'.repeat(2000))
    expect(ctx.toolResultPruner.pruneSession(session).pruned).toHaveLength(1)
    // A later header (here a resume) finds no recorded cause.
    session.append('step/start', { turn: 2, step: 1 })
    header(session, 'resume')
    message(session, 2, 1, usage(100, 960, 0), 'y'.repeat(2000))
    expect(cache(ctx, session).breaks.total).toBe(0)
    // Once a request has carried a result, rewriting it is a prune break.
    session.append('step/start', { turn: 2, step: 2 })
    message(session, 2, 2, usage(100, 1024, 0))
    expect(ctx.toolResultPruner.pruneSession(session).pruned).toHaveLength(1)
    session.append('step/start', { turn: 2, step: 3 })
    header(session, 'series')
    message(session, 2, 3, usage(100, 512, 0))
    expect(cache(ctx, session).breaks).toMatchObject({ total: 1, byCause: { prune: 1 }, recent: [{ reason: 'series', causes: ['prune'] }] })
  })

  it('measures an unexplained miss against the previous prompt, not against newly appended content', async () => {
    const { ctx, session } = await harness()
    session.append('step/start', { turn: 1, step: 1 })
    header(session, 'initial')
    message(session, 1, 1, usage(1000, 0, 0))
    // The whole 1000-token previous prompt is cached, then a 3000-token tool result is appended: 25%, not a miss.
    session.append('step/start', { turn: 1, step: 2 })
    message(session, 1, 2, usage(3000, 1000, 0))
    expect(cache(ctx, session)).toMatchObject({ unexplainedMisses: 0, steady: { requests: 1 } })
    // The provider dropped most of the 4000-token prefix it had: a miss.
    session.append('step/start', { turn: 1, step: 3 })
    message(session, 1, 3, usage(3900, 256, 0))
    expect(cache(ctx, session)).toMatchObject({ unexplainedMisses: 1, steady: { requests: 2 } })
  })

  it('reads an absent cache-read count as 0 only when an exact total proves it', async () => {
    const { ctx, session } = await harness()
    // Older journals omitted a zero cacheReadTokens; totalTokens is exact, so the zero is provable.
    expect(promptCacheHit(legacyUsage(10, 0))).toBe(0)
    expect(promptCacheHit(usage(10, 0, 0))).toBe(0)
    expect(promptCacheHit(usage(10))).toBeUndefined()
    // A provider that sent no cache field is marked; its exact total must not prove a zero.
    expect(promptCacheHit({ ...legacyUsage(10, 0), cacheReported: false })).toBeUndefined()
    const empty = sessionMetrics({ asOfSeq: -1, tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      promptCache: cache(ctx, session), compactionActivity: ctx.sessionProjections.snapshot(session).values.compactionActivity!, contextPressure: {} })
    expect(empty.promptCache.hitRate).toBeNull()
    expect(empty.context.occupancy).toBeNull()
    session.append('step/start', { turn: 1, step: 1 })
    header(session, 'initial')
    message(session, 1, 1, legacyUsage(1000, 0))
    session.append('step/start', { turn: 1, step: 2 })
    message(session, 1, 2, legacyUsage(40, 960))
    // An adapter that omits the count and the total is unreported, never a hit rate.
    session.append('step/start', { turn: 1, step: 3 })
    message(session, 1, 3, usage(10))
    const value = cache(ctx, session)
    expect(value).toMatchObject({ unreportedRequests: 1, all: { requests: 2, promptTokens: 2000, cacheReadTokens: 960 },
      warm: { requests: 1, promptTokens: 1000, cacheReadTokens: 960 }, last: { requestIndex: 1 } })
  })
})


describe('honest cache reporting', () => {
  it.each([0, 256])('an explicit unreported marker outranks a normalized cache counter (%i)', async (count) => {
    const { ctx, session } = await harness()
    const unreported = { ...usage(1000, count, 0), cacheReported: false as const }
    expect(promptCacheHit(unreported)).toBeUndefined()
    session.append('step/start', { turn: 1, step: 1 })
    header(session, 'initial')
    message(session, 1, 1, unreported)
    expect(cache(ctx, session)).toMatchObject({ unreportedRequests: 1, all: { requests: 0 }, last: null })
  })

  it('refuses unsafe prompt sums instead of exposing a ratio inconsistent with the projection', () => {
    expect(promptCacheHit({ ...usage(Number.MAX_SAFE_INTEGER, 1, 0), totalTokens: Number.MAX_SAFE_INTEGER })).toBeUndefined()
  })
})
