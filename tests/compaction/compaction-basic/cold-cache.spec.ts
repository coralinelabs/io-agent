/**
 * Prune old tool results at a step boundary when
 * the session has had no model response for longer than the prompt-cache
 * lifetime. Prune only, never a summary; unset or fresh sessions stay untouched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import LlmRuntime, { createMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { LlmResolvedModelInfo, StreamChunk } from "../../../src/library/model/llm/index.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import TokenMeter from "../../../src/library/model/token-meter/index.ts"
import BasicCompactionEngine, { idleMillis } from "../../../src/library/context/compaction/basic/index.ts"
import ToolResultPruner from "../../../src/library/context/compaction/tool-result-pruner/index.ts"
import { agentEvents, type Agent } from "../../../src/library/runtime/agents/index.ts"

const MODEL = 'cold-model'
const HOUR = 60 * 60_000
const T0 = Date.UTC(2026, 8, 24, 9, 0, 0)

class WideAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A route on a kv100 connection: what a request sent is never rewritten. */
class Kv100WideAdapter extends WideAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), kv100: true }
  }
}

function harness(coldCachePruneAfterMs?: number, kv100 = false): { ctx: Context; engine: BasicCompactionEngine } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], kv100 ? new Kv100WideAdapter() : new WideAdapter())
  void new ToolResultPruner(ctx, { thresholdChars: 200, headChars: 40, tailChars: 20,
    retention: { keepRecentToolGroups: 1, minimumSavingsChars: 0 } })
  const engine = new BasicCompactionEngine(ctx, coldCachePruneAfterMs === undefined ? {} : { coldCachePruneAfterMs })
  return { ctx, engine }
}

/** Three closed turns, each a bash call with a large result and the model's answer. */
function history(id: string): Session {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `task ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    const callId = ToolCallId(`c${turn}`)
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"yes"}' }],
      source: { kind: 'model', provider: MODEL, model: MODEL } }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{"command":"yes"}' })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'y\n'.repeat(500) }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

function preStep(ctx: Context, session: Session): Promise<unknown> {
  const owner = { session, options: { provider: MODEL, model: MODEL } } as Agent
  return agentEvents(ctx, owner).waterfall('agent/pre-step', { messages: [], turn: 4, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

const types = (session: Session): string[] => session.snapshotEvents().map(event => event.type)

describe('cold-cache tool-result prune', () => {
  afterEach(() => { vi.useRealTimers() })

  it('prunes old results once the session was idle longer than the cache lifetime, without summarizing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx } = harness(HOUR)
    const session = history('cold')
    const source = history('cold-src')
    vi.setSystemTime(T0 + HOUR + 60_000)
    await preStep(ctx, session)
    expect(types(session).filter(type => type === 'compaction/prune')).toHaveLength(2)
    expect(types(session)).not.toContain('compaction/summary')
    expect(types(session)).not.toContain('compaction/start')
    // A resumed copy folds the same last-response time from the journal.
    expect(idleMillis(ctx.sessionProjections.stateOf(Session.create(SessionId('cold-copy'), source.snapshotEvents()), 'modelActivity'),
      Date.now())).toBe(HOUR + 60_000)
  })

  it('never idle-prunes a kv100 route, however long the session was idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx } = harness(HOUR, true)
    const session = history('kv100')
    const before = session.snapshotEvents()
    vi.setSystemTime(T0 + 30 * 24 * HOUR)
    await preStep(ctx, session)
    expect(session.snapshotEvents()).toEqual(before)
  })

  // Codex's review probes on b3faff2 (harness #230), inverted: an unknown mode is no permission to rewrite.
  it('does not prune when the kv100 route\'s metadata lookup fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx } = harness(HOUR, true)
    const session = history('kv100-lookup-failed')
    const before = session.snapshotEvents()
    vi.setSystemTime(T0 + 30 * 24 * HOUR)
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockRejectedValueOnce(new Error('temporary model metadata outage'))
    await preStep(ctx, session)
    expect(session.snapshotEvents()).toEqual(before)
    vi.restoreAllMocks()
  })

  it('ends the step without pruning when cancelled during the lookup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx } = harness(HOUR, true)
    const session = history('kv100-lookup-cancelled')
    const before = session.snapshotEvents()
    const controller = new AbortController()
    vi.setSystemTime(T0 + 30 * 24 * HOUR)
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled during metadata lookup'))
      throw controller.signal.reason
    })
    const owner = { session, options: { provider: MODEL, model: MODEL } } as Agent
    await agentEvents(ctx, owner).waterfall('agent/pre-step', { messages: [], turn: 4, step: 1, signal: controller.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(controller.signal.aborted).toBe(true)
    expect(session.snapshotEvents()).toEqual(before)
    vi.restoreAllMocks()
  })

  it('leaves a session untouched while its cache is presumed warm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx } = harness(HOUR)
    const session = history('warm')
    const before = session.snapshotEvents()
    vi.setSystemTime(T0 + HOUR)
    await preStep(ctx, session)
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('never idle-prunes when the trigger is unset, and registers no idle fold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx } = harness()
    const session = history('unset')
    const before = session.snapshotEvents()
    vi.setSystemTime(T0 + 30 * 24 * HOUR)
    await preStep(ctx, session)
    expect(session.snapshotEvents()).toEqual(before)
    expect(ctx.sessionProjections.stateOf(session, 'modelActivity')).toBeUndefined()
  })

  it('skips a session that has not had a model response yet', async () => {
    const { ctx } = harness(1)
    const session = Session.create(SessionId('fresh'))
    session.append('turn/start', { turn: 1 })
    await preStep(ctx, session)
    expect(types(session)).toEqual(['turn/start'])
  })

  it.each([0, -1, 1.5])('rejects coldCachePruneAfterMs %s', (value) => {
    expect(() => harness(value)).toThrow(/coldCachePruneAfterMs/)
  })
})
