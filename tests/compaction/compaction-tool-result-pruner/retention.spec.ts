import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createMessage, createToolResultMessage, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { ContentBlock } from "../../../src/library/model/llm/index.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import Projections from "../../../src/library/session/projection/index.ts"
import TokenMeter from "../../../src/library/model/token-meter/index.ts"
import Pruner, { resolveConfig } from "../../../src/library/context/compaction/tool-result-pruner/index.ts"
import type { PruneRetentionPolicy } from "../../../src/library/context/compaction/tool-result-pruner/index.ts"

function prune(retention?: PruneRetentionPolicy): Pruner {
  const ctx = new Context(); new Projections(ctx); new TokenMeter(ctx)
  return new Pruner(ctx, { thresholdChars: 50, headChars: 4, tailChars: 3, ...(retention === undefined ? {} : { retention }) })
}
function group(session: Session, turn: number, count = 1, isError = false, media = false): number[] {
  session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
  const calls = Array.from({ length: count }, (_, i) => ({ type: 'tool-call' as const, id: ToolCallId(`t${turn}c${i}`), name: 'bash', arguments: '{}' }))
  session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant', content: calls,
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  const sequences = calls.map(call => {
    session.append('tool/call', { turn, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    const content: ContentBlock[] = [{ type: 'text', text: `turn${turn}:` + 'X'.repeat(150) }]
    if (media) content.push({ type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never,
      mediaType: 'image/png', bytes: 1, width: 1, height: 1 } })
    return session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: call.id, content, isError }) }, { surfaceOp: 'append' }).seq
  })
  session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return sequences
}

describe('reference-derived selective retention over dsh durable history', () => {
  it('protects entire recent parallel groups rather than the last N individual results', () => {
    const session = Session.create(SessionId('groups'))
    const old = group(session, 1, 2); group(session, 2, 3); group(session, 3, 4)
    const result = prune({ keepRecentToolGroups: 2 }).pruneSession(session)
    expect(result.pruned.map(r => r.originalSeq)).toEqual(old)
    expect(result.charsRemoved).toBeGreaterThan(0)
  })
  it('retains failure evidence and media even when they are old', () => {
    const session = Session.create(SessionId('evidence'))
    group(session, 1, 1, true); group(session, 2, 1, false, true)
    const eligible = group(session, 3); group(session, 4)
    const result = prune({ keepRecentToolGroups: 1, preserveErrors: true, preserveMedia: true }).pruneSession(session)
    expect(result.pruned.map(r => r.originalSeq)).toEqual(eligible)
  })
  it('performs no durable writes when savings are below the configured floor', () => {
    const session = Session.create(SessionId('floor')); group(session, 1)
    const before = session.snapshotEvents()
    expect(prune({ minimumSavingsChars: 10000 }).pruneSession(session)).toEqual({ pruned: [], charsRemoved: 0 })
    expect(session.snapshotEvents()).toEqual(before)
  })
  it('counts the savings across the whole planned batch', () => {
    const session = Session.create(SessionId('batch')); group(session, 1, 2)
    const result = prune({ minimumSavingsChars: 200 }).pruneSession(session)
    expect(result.pruned).toHaveLength(2); expect(result.charsRemoved).toBeGreaterThanOrEqual(200)
  })
  it('uses surface order after a replacement, not the newest durable sequence number', () => {
    const session = Session.create(SessionId('order'))
    group(session, 1); const second = group(session, 2)
    prune({ keepRecentToolGroups: 1 }).pruneSession(session) // Old result now has the newest seq.
    group(session, 3)
    const result = prune({ keepRecentToolGroups: 1 }).pruneSession(session)
    expect(result.pruned.map(r => r.originalSeq)).toEqual(second)
  })
  it('preserves the original log and dsh shadow-pricing/replacement adjacency on replay', () => {
    const session = Session.create(SessionId('replay'))
    const [original] = group(session, 1); group(session, 2)
    const before = session.snapshotEvents()[original!]!
    const result = prune({ keepRecentToolGroups: 1 }).pruneSession(session)
    const events = session.snapshotEvents()
    expect(events[original!]).toEqual(before)
    expect(events[result.pruned[0]!.replacementSeq - 1]!.type).toBe('compaction/prune')
    const restored = Session.create(SessionId('replay-copy'), events)
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
    expect(prune({ keepRecentToolGroups: 1 }).pruneSession(restored).pruned).toHaveLength(0)
  })
  it('keeps unconfigured dsh behavior and permits explicit disabling of protection', () => {
    const session = Session.create(SessionId('legacy')); group(session, 1, 1, true, true)
    expect(prune().pruneSession(session).pruned).toHaveLength(1)
    expect(resolveConfig({ retention: {} })).toEqual(resolveConfig())
  })
  it('snapshots and freezes supplied policy', () => {
    const policy = { keepRecentToolGroups: 3 }; const config = resolveConfig({ retention: policy }); policy.keepRecentToolGroups = 99
    expect(config.retention?.keepRecentToolGroups).toBe(3)
    expect(Object.isFrozen(config.retention)).toBe(true)
  })
  it.each([null, [], { keepRecentToolGroups: -1 }, { keepRecentToolGroups: 1.1 }, { minimumSavingsChars: Infinity },
    { preserveErrors: 'yes' }, { preserveMedia: 0 }, { unknown: true }])('rejects invalid retention %j', retention => {
    expect(() => resolveConfig({ retention: retention as PruneRetentionPolicy })).toThrow()
  })
})
