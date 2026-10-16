/** Pure recall rendering over one session cut, plus the optional full-text mapping. */
import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from "../../../src/library/model/llm/index.ts"
import type { ContentBlock } from "../../../src/library/model/llm/index.ts"
import SessionStore, { SessionId, SessionSeq } from "../../../src/library/session/journal/index.ts"
import type { SessionEvent } from "../../../src/library/session/journal/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import SqliteSessionQueryEngine from "../../../src/library/session/query/query-sqlite/index.ts"
import { compactCheckpointSource } from "../../../src/library/context/compaction/compaction/checkpoint.ts"
import { CompactionId } from "../../../src/library/context/compaction/compaction/brand.ts"
import {
  parseRecallRequest,
  RECALL_LIMITS,
  renderRecallEvent,
  renderRecallHits,
  renderRecallRange,
  searchRecallLiteral,
  splitRecallQuery,
} from "../../../src/library/session/tool-recall/index.ts"

const id = SessionId('recall')
const BIG = 'NEEDLE_ALPHA start\n' + 'x'.repeat(20_000) + '\nNEEDLE_OMEGA end'

function user(seq: number, text: string, extra: Partial<SessionEvent<'user/message'>> = {}): SessionEvent {
  return { type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), ...extra } as SessionEvent
}
function assistant(seq: number, content: ContentBlock[]): SessionEvent {
  return { type: 'assistant/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }) } }
}
function call(seq: number, callId: string, name: string, args: string): SessionEvent {
  return { type: 'tool/call', seq: SessionSeq(seq), time: seq, data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: args } }
}
function result(seq: number, callId: string, text: string, cite: number): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: SessionSeq(seq), time: seq,
    data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false }) },
    surfaceOp: 'append', sourceEventSeqs: [SessionSeq(cite)] }
}
/** The pruner's shape: the same message with only its content replaced, shadowing the original. */
function pruned(seq: number, original: SessionEvent<'tool/result'>, text: string): SessionEvent {
  return { type: 'tool/result', seq: SessionSeq(seq), time: seq,
    data: { ...original.data, message: { ...original.data.message, content: [{ type: 'text', text }] } },
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] }
}

/** A read of a large file, later pruned in place, then a recall search of it. */
function prunedLog(): SessionEvent[] {
  const original = result(3, 'c1', BIG, 2)
  return [
    user(0, 'Please read big.txt'),
    assistant(1, [{ type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"file_path":"big.txt"}' }]),
    call(2, 'c1', 'read', '{"file_path":"big.txt"}'),
    original,
    assistant(4, [{ type: 'text', text: 'Done reading.' }]),
    pruned(5, original, '[pruned]'),
    user(6, 'NEEDLE_ALPHA mentioned in runtime context', {
      data: createUserMessage({ content: [{ type: 'text', text: 'NEEDLE_ALPHA in runtime context' }],
        source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] } }),
    }),
    assistant(7, [{ type: 'tool-call', id: ToolCallId('c2'), name: 'recall', arguments: '{"query":"NEEDLE_ALPHA"}' }]),
    call(8, 'c2', 'recall', '{"query":"NEEDLE_ALPHA"}'),
    result(9, 'c2', '1 of 1 matches: NEEDLE_ALPHA', 8),
    { type: 'request/header', seq: SessionSeq(10), time: 10, data: { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' } },
  ]
}

describe('recall request parsing', () => {
  it('accepts exactly one mode and clamps the match limit', () => {
    expect(parseRecallRequest({ seq: 3 })).toEqual({ mode: 'event', seq: 3, offset: 0 })
    expect(parseRecallRequest({ from: 2 })).toEqual({ mode: 'range', from: 2 })
    expect(parseRecallRequest({ query: 'x', limit: 500 })).toEqual({ mode: 'search', query: 'x', limit: RECALL_LIMITS.maxMatches })
    expect(parseRecallRequest({ seq: 1, query: '  ' })).toEqual({ mode: 'event', seq: 1, offset: 0 })
    // A modifier of another mode is ignored rather than refused.
    expect(parseRecallRequest({ seq: 4, limit: 10 })).toEqual({ mode: 'event', seq: 4, offset: 0 })
    expect(parseRecallRequest({ query: 'x', offset: 0 })).toEqual({ mode: 'search', query: 'x', limit: RECALL_LIMITS.defaultMatches })
    for (const bad of [{}, { seq: 1, from: 0 }, { offset: 3 }, { limit: 3 }, { query: 'x', to: 3 }]) {
      expect(() => parseRecallRequest(bad)).toThrow(/exactly one of/)
    }
  })

  it('keeps quoted phrases whole and caps the term count', () => {
    expect(splitRecallQuery('"exact phrase" word Word')).toEqual(['exact phrase', 'word'])
    expect(splitRecallQuery('a b c d e f g h i j')).toHaveLength(RECALL_LIMITS.maxTerms)
    expect(() => splitRecallQuery(' "" ')).toThrow(/no words/)
  })
})

describe('recall rendering', () => {
  it('pages one event and points a pruned copy at its full original', () => {
    const events = prunedLog()
    const first = renderRecallEvent(id, events, 3)
    expect(first.split('\n')[0]).toBe('#3 tool/result read [removed from context]')
    expect(first).toContain('characters 0 to 16000 of')
    expect(first).toContain('NEEDLE_ALPHA start')
    expect(first).not.toContain('NEEDLE_OMEGA')
    const next = /continue with recall seq=3 offset=(\d+)/.exec(first)
    expect(next?.[1]).toBe(String(RECALL_LIMITS.eventPagePoints))
    const rest = renderRecallEvent(id, events, 3, Number(next![1]))
    expect(rest).toContain('NEEDLE_OMEGA end')
    expect(rest).not.toContain('continue with recall')

    const copy = renderRecallEvent(id, events, 5)
    expect(copy).toContain('#5 tool/result read [in context]')
    expect(copy).toContain('shortened copy of #3; recall seq=3 has the full text')
  })

  it('refuses structural records, absent events and offsets past the end', () => {
    const events = prunedLog()
    expect(() => renderRecallEvent(id, events, 10)).toThrow(/#10 is a request\/header record with no readable text/)
    expect(() => renderRecallEvent(id, events, 11)).toThrow(/no event #11; its events run from #0 to #10/)
    expect(() => renderRecallEvent(id, events, -1)).toThrow(/no event #-1/)
    expect(() => renderRecallEvent(id, events, 0, 999)).toThrow(/past the end of event #0/)
  })

  it('lists a range within its budget and continues where it stopped', () => {
    const events = prunedLog()
    const listing = renderRecallRange(id, events, 0, 5)
    expect(listing.split('\n')[0]).toBe('#0 user/message [in context]: Please read big.txt')
    expect(listing).toContain('#3 tool/result read [removed from context]: NEEDLE_ALPHA start')
    expect(listing).toMatch(/\(\+\d+ characters\)/)
    expect(listing).not.toContain('#10')
    const long = Array.from({ length: 80 }, (_, i) => user(i, `message ${i} ${'y'.repeat(400)}`))
    const cut = renderRecallRange(id, long)
    expect(cut.length).toBeLessThanOrEqual(RECALL_LIMITS.rangeBudgetChars + 100)
    const more = /continue with recall from=(\d+) to=79/.exec(cut)
    expect(Number(more?.[1])).toBeGreaterThan(0)
    expect(renderRecallRange(id, long, Number(more![1]), 79).split('\n')[0]).toContain(`#${more![1]} user/message`)
    expect(() => renderRecallRange(id, events, 20, 30)).toThrow(/from 0 to 10/)
    expect(() => renderRecallRange(id, events, 5, 2)).toThrow(/must not be after/)
  })

  it('searches every term newest first without finding itself or runtime context', () => {
    const events = prunedLog()
    const hits = searchRecallLiteral(id, events, 'needle_alpha', 10)
    // The pruned original is found; the recall call, its result and the snapshot are not.
    expect(hits.split('\n')).toEqual([
      '1 of 1 matches, newest first:',
      '#3 tool/result read [removed from context]: NEEDLE_ALPHA start ' + 'x'.repeat(RECALL_LIMITS.snippetRadius - 7) + '…',
      'Read a match in full with recall seq=<number>.',
    ])
    expect(searchRecallLiteral(id, events, 'NEEDLE_ALPHA "start" absent', 10)).toBe('No earlier event matches "NEEDLE_ALPHA \\"start\\" absent".')
    expect(searchRecallLiteral(id, events, 'read big.txt', 10)).toMatch(/^3 of 3 matches, newest first:\n#2 tool\/call read/)
  })

  it('attributes results to their own step\'s call when a provider reuses call ids across steps', () => {
    // The recall call of step 2 reuses the id `c1` of step 1's read.
    const atStep2 = <T extends SessionEvent>(event: T): T => ({ ...event, data: { ...event.data, step: 2 } }) as T
    const events: SessionEvent[] = [
      user(0, 'Please read big.txt'),
      assistant(1, [{ type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"file_path":"big.txt"}' }]),
      call(2, 'c1', 'read', '{"file_path":"big.txt"}'),
      result(3, 'c1', BIG, 2),
      atStep2(assistant(4, [{ type: 'tool-call', id: ToolCallId('c1'), name: 'recall', arguments: '{"query":"NEEDLE_ALPHA"}' }])),
      atStep2(call(5, 'c1', 'recall', '{"query":"NEEDLE_ALPHA"}')),
      atStep2(result(6, 'c1', '1 of 1 matches: NEEDLE_ALPHA', 5)),
    ]
    expect(renderRecallEvent(id, events, 3, 0).split('\n')[0]).toBe('#3 tool/result read [in context]')
    // The read is still searchable; only recall's own call and result are left out.
    expect(searchRecallLiteral(id, events, 'needle_alpha', 10).split('\n').slice(0, 2)).toEqual([
      '1 of 1 matches, newest first:',
      '#3 tool/result read [in context]: NEEDLE_ALPHA start ' + 'x'.repeat(RECALL_LIMITS.snippetRadius - 7) + '…',
    ])
  })

  it('names the condensed range of a compaction checkpoint', () => {
    const events: SessionEvent[] = [
      user(0, 'first request'),
      assistant(1, [{ type: 'text', text: 'first answer' }]),
      call(2, 'c9', 'bash', '{"command":"ls"}'),
      user(3, '## Current Work\ncondensed', {
        data: createUserMessage({ content: [{ type: 'text', text: '## Current Work\ncondensed' }],
          source: compactCheckpointSource(CompactionId('cmp-1')) }),
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
        sourceEventSeqs: [SessionSeq(0), SessionSeq(1), SessionSeq(2)],
      }),
    ]
    const checkpoint = renderRecallEvent(id, events, 3)
    expect(checkpoint).toContain('summary of #0 to #1; recall from=0 to=1 lists them')
    expect(renderRecallEvent(id, events, 0)).toContain('#0 user/message [removed from context]')
  })
})

describe('recall output within a byte budget', () => {
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
  /** Every page of one event from offset 0, following each continuation pointer. */
  function pages(events: readonly SessionEvent[], seq: number, maxOutputBytes: number): string[] {
    const out: string[] = []
    let offset = 0
    for (;;) {
      const page = renderRecallEvent(id, events, seq, offset, { maxOutputBytes })
      out.push(page)
      const next = /continue with recall seq=\d+ offset=(\d+)\]$/.exec(page)
      if (next === null) return out
      offset = Number(next[1])
    }
  }
  /** The text of one page: after the blank line, before the continuation. */
  const bodyOf = (page: string): string => page.slice(page.indexOf('\n\n') + 2).replace(/\n\[\d+ more characters; continue with recall seq=\d+ offset=\d+\]$/, '')

  it.each([
    ['4-byte emoji', '😀'.repeat(16_000)],
    ['3-byte CJK', '汉字'.repeat(8_000)],
    ['mixed widths', 'aé汉😀'.repeat(4_000)],
  ])('pages %s within the budget, in code points, and reassembles it exactly', (_label, text) => {
    const events = [user(0, 'x'), result(1, 'c1', text, 0)]
    // Without a budget the page is 16,000 code points, over an 8,000-byte threshold.
    expect(bytes(renderRecallEvent(id, events, 1))).toBeGreaterThan(8_000)
    const all = pages(events, 1, 8_000)
    expect(all.length).toBeGreaterThan(1)
    for (const page of all) expect(bytes(page)).toBeLessThanOrEqual(8_000)
    expect(all.map(bodyOf).join('')).toBe(text)
    // Offsets and totals count code points, not bytes or UTF-16 units.
    const total = Array.from(text).length
    expect(all[0]).toMatch(new RegExp(`characters 0 to \\d+ of ${total}\\n`))
    const [, end] = /characters 0 to (\d+) of/.exec(all[0]!)!
    expect(Array.from(bodyOf(all[0]!)).length).toBe(Number(end))
  })

  it('keeps the unbounded 16,000-code-point page when no budget is given, and pages ASCII to the budget', () => {
    const events = prunedLog()
    expect(renderRecallEvent(id, events, 3)).toContain('characters 0 to 16000 of')
    const all = pages(events, 3, 8_000)
    for (const page of all) expect(bytes(page)).toBeLessThanOrEqual(8_000)
    expect(all.map(bodyOf).join('')).toBe(BIG)
    // A text within the budget is one page with no page line.
    expect(renderRecallEvent(id, events, 0, 0, { maxOutputBytes: 8_000 })).toBe('#0 user/message [in context]\n\nPlease read big.txt')
    // At least one code point per page, whatever the budget.
    expect(bodyOf(renderRecallEvent(id, [user(0, '😀😀')], 0, 0, { maxOutputBytes: 1 }))).toBe('😀')
  })

  it('bounds a range listing and a search listing by bytes, with the cut stated', () => {
    const wide = Array.from({ length: 60 }, (_, i) => user(i, `NEEDLE message ${i} ${'汉'.repeat(400)}`))
    const listing = renderRecallRange(id, wide, undefined, undefined, { maxOutputBytes: 8_000 })
    expect(bytes(listing)).toBeLessThanOrEqual(8_000)
    const more = /\[more events follow; continue with recall from=(\d+) to=59\]$/.exec(listing)
    expect(Number(more?.[1])).toBeGreaterThan(1)
    // Unbounded, the same range fills the 12,000-character budget: far more bytes.
    expect(bytes(renderRecallRange(id, wide))).toBeGreaterThan(20_000)

    const hits = searchRecallLiteral(id, wide, 'NEEDLE', 30, { maxOutputBytes: 4_000 })
    expect(bytes(hits)).toBeLessThanOrEqual(4_000)
    const [, shown, count] = /^(\d+) of (\d+) matches, newest first:/.exec(hits)!
    expect(Number(count)).toBe(60)
    expect(Number(shown)).toBeLessThan(30)
    expect(hits.split('\n')).toHaveLength(Number(shown) + 2)
    expect(bytes(searchRecallLiteral(id, wide, 'NEEDLE', 30))).toBeGreaterThan(4_000)
  })
})

describe('recall full-text mapping', () => {
  it('renders FTS5 hits with the literal format and drops recall self-matches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    const events = prunedLog()
    ctx.sessions.create(id, { seed: events, meta: { createdAt: 1 } })
    const page = await ctx.sessionQuery.searchEvents({ sessionId: id, query: 'NEEDLE_ALPHA', limit: 20 })
    // The index finds the recall call's own traces too; the renderer must drop them.
    expect(page.items.map(item => item.seq).sort((a, b) => a - b)).toEqual(expect.arrayContaining([SessionSeq(3), SessionSeq(9)]))
    const rendered = renderRecallHits(id, events, page.items, 'NEEDLE_ALPHA', 10)
    expect(rendered.split('\n')[0]).toBe('1 best matches:')
    expect(rendered).toContain('#3 tool/result read [removed from context]: NEEDLE_ALPHA start')
    expect(rendered).not.toMatch(/#(6|7|8|9) /)
    await ctx.fiber.dispose()
  })

  it('shows fewer ranked hits within a byte budget', () => {
    const wide = Array.from({ length: 20 }, (_, i) => user(i, `NEEDLE message ${i} ${'汉'.repeat(400)}`))
    const hits = wide.map(event => ({ seq: event.seq, surface: 'current' as const, snippet: `NEEDLE ${'汉'.repeat(200)}` }))
    const unbounded = renderRecallHits(id, wide, hits, 'NEEDLE', 20)
    expect(unbounded.split('\n')[0]).toBe('20 best matches:')
    const bounded = renderRecallHits(id, wide, hits, 'NEEDLE', 20, { maxOutputBytes: 3_000 })
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(3_000)
    const shown = Number(/^(\d+) best matches:/.exec(bounded)![1])
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(20)
    expect(bounded.split('\n')).toHaveLength(shown + 2)
  })
})
