import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '../../src/library/session/journal/index.ts'
import { createUserMessage, createToolResultMessage, ToolCallId } from '../../src/library/model/llm/index.ts'
import { hasVisibleDisclosure, visibleToolResultsNewestFirst } from '../../src/library/context/visibility.ts'
const session = () => { const s = Session.create(SessionId('visible')); s.append('turn/start', { turn: 1 }); s.append('step/start', { turn: 1, step: 1 }); return s }
function result(s: Session, body: string, error = false, name = 'skill') {
  const id = ToolCallId('call-' + s.seq)
  const call = s.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
  return s.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id, isError: error, content: [{ type: 'text', text: body }] }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }) as SessionEvent<'tool/result'>
}
/** A content-only rewrite that cites the replaced result, as the pruner appends it. */
function replaceContent(s: Session, event: SessionEvent<'tool/result'>, text: string): SessionEvent<'tool/result'> {
  return s.append('tool/result', { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text }] } },
    { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] }) as SessionEvent<'tool/result'>
}
describe('disclosure follows the authoritative request surface', () => {
  it('recognizes successful content but not a same-length changed body', () => {
    const s = session(); result(s, 'BODY_A')
    expect(hasVisibleDisclosure(s, 'skill', 'BODY_A')).toBe(true)
    expect(hasVisibleDisclosure(s, 'skill', 'BODY_B')).toBe(false)
    expect(hasVisibleDisclosure(s, 'other', 'BODY_A')).toBe(false)
  })
  it('invalidates after pruning, even if the historical event remains persisted', () => {
    const s = session(); const original = result(s, 'FULL_BODY')
    expect(hasVisibleDisclosure(s, 'skill', 'FULL_BODY')).toBe(true)
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'The body was summarized.' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
    expect(s.eventAt(original.seq)).toEqual(original)
    expect(hasVisibleDisclosure(s, 'skill', 'FULL_BODY')).toBe(false)
    result(s, 'FULL_BODY'); expect(hasVisibleDisclosure(s, 'skill', 'FULL_BODY')).toBe(true)
  })
  it('does not accept errors, quoted user text, or a different session as evidence', () => {
    const s = session(); result(s, 'body', true)
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'body' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(hasVisibleDisclosure(s, 'skill', 'body')).toBe(false)
    const other = session(); result(other, 'body')
    expect(hasVisibleDisclosure(other, 'skill', 'body')).toBe(true)
    expect(hasVisibleDisclosure(s, 'skill', 'body')).toBe(false)
  })
  it('lists visible results of one tool newest first, attributing replacements to their call', () => {
    const s = session()
    const first = result(s, 'FIRST', false, 'read'); result(s, 'OTHER_TOOL'); const second = result(s, 'SECOND', false, 'read')
    expect([...visibleToolResultsNewestFirst(s, 'read')].map(seen => [seen.seq, seen.original])).toEqual([[second.seq, true], [first.seq, true]])
    // A pruned replacement cites the result it replaces; it is still attributed to the read.
    const again = replaceContent(s, replaceContent(s, first, 'FIR…'), 'F…')
    const seen = [...visibleToolResultsNewestFirst(s, 'read')]
    expect(seen.map(entry => [entry.seq, entry.original])).toEqual([[second.seq, true], [again.seq, false]])
    expect(seen[0]!.shows('SECOND')).toBe(true)
    expect(seen[1]!.shows('FIRST')).toBe(false)
    expect(seen[1]!.shows('F…')).toBe(true)
    // The owning call is exposed through the replacements, so callers can read its arguments.
    expect(seen[1]!.call.seq).toBe(first.sourceEventSeqs?.[0])
    expect(seen[1]!.call.data.name).toBe('read')
  })
  it('shows neither error text nor quoted user text, and forgets summarized results', () => {
    const s = session(); const failed = result(s, 'ERROR_BODY', true, 'read')
    const quoted = s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'OK_BODY' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const ok = result(s, 'OK_BODY', false, 'read')
    const seen = [...visibleToolResultsNewestFirst(s, 'read')]
    expect(seen.map(entry => entry.seq)).toEqual([ok.seq, failed.seq])
    expect(seen[1]!.shows('ERROR_BODY')).toBe(false)
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary.' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: failed.seq, endSeq: ok.seq }, sourceEventSeqs: [failed.seq, quoted.seq, ok.seq] })
    expect([...visibleToolResultsNewestFirst(s, 'read')]).toEqual([])
  })
})
