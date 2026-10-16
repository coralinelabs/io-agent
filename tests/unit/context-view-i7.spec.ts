import { describe, expect, it, vi } from 'vitest'
import { Context } from '../../src/library/runtime/vendor/cordis/index.ts'
import { createUserMessage, createToolResultMessage, ToolCallId } from '../../src/library/model/llm/index.ts'
import { Session, SessionId, SessionSeq, deriveEventMessage, type SessionMessageProjection } from '../../src/library/session/journal/index.ts'
import { deepFreeze } from '../../src/library/util/values/index.ts'
import { hasVisibleDisclosure, visibleMessages, visibleUserMessages, visibleAuthoredUserMessages } from '../../src/library/context/visibility.ts'
import { RuntimeContextProjection } from '../../src/library/context/projection.ts'

declare module '../../src/library/session/journal/types.ts' {
  interface SessionEventMap {
    'i7/context-project': { seq: SessionSeq; text: string }
    'i7/context-note': { note: string }
  }
}
const projection: SessionMessageProjection<'i7/context-project'> = {
  type: 'i7/context-project', project(event, context) {
    const original = deriveEventMessage(context.events[event.data.seq - context.baseSeq]!, context.messages)!
    const content = original.content.map(block => block.type === 'tool-result'
      ? { ...block, content: [{ type: 'text' as const, text: event.data.text }] }
      : { type: 'text' as const, text: event.data.text })
    return new Map([[event.data.seq, deepFreeze({ ...original, content })]])
  },
}
function make(definitions: SessionMessageProjection[] = [projection]) {
  const s = Session.create(SessionId('i7-context'), undefined, undefined, undefined, definitions)
  s.append('turn/start', { turn: 1 }); s.append('step/start', { turn: 1, step: 1 }); return s
}
function disclosure(s: Session, text: string) {
  const callId = ToolCallId('c' + s.seq)
  const call = s.append('tool/call', { turn: 1, step: 1, callId, name: 'skill', arguments: '{}' })
  return s.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}
describe('shared, projected model context', () => {
  it('does not mistake unprojected historical content for a current disclosure', () => {
    const s = make(), event = disclosure(s, 'FULL_ORIGINAL')
    expect(hasVisibleDisclosure(s, 'skill', 'FULL_ORIGINAL')).toBe(true)
    s.append('i7/context-project', { seq: event.seq, text: 'SHORT_REPLACEMENT' })
    expect(s.surface.replaceGeneration).toBe(0)
    expect(hasVisibleDisclosure(s, 'skill', 'FULL_ORIGINAL')).toBe(false)
    expect(hasVisibleDisclosure(s, 'skill', 'SHORT_REPLACEMENT')).toBe(true)
    expect(JSON.stringify(s.eventAt(event.seq))).toContain('FULL_ORIGINAL')
  })
  it('restores the same projection/disclosure facts from the journal', () => {
    const s = make(), event = disclosure(s, 'FULL')
    s.append('i7/context-project', { seq: event.seq, text: 'REDACTED' })
    const restored = Session.create(SessionId('i7-restored'), s.snapshotEvents(), undefined, undefined, [projection])
    expect(hasVisibleDisclosure(restored, 'skill', 'FULL')).toBe(false)
    expect(hasVisibleDisclosure(restored, 'skill', 'REDACTED')).toBe(true)
  })
  it('interprets only appended surface nodes, and no nodes for telemetry/log events', () => {
    const s = make()
    for (let i = 0; i < 50; i++) disclosure(s, 'large'.repeat(200) + i)
    const derive = vi.spyOn(s, 'deriveEventMessage')
    const first = visibleMessages(s); expect(derive).toHaveBeenCalledTimes(50)
    s.append('i7/context-note', { note: 'not model context' })
    expect(visibleMessages(s)).toBe(first); expect(derive).toHaveBeenCalledTimes(50)
    disclosure(s, 'additional')
    expect(visibleMessages(s)).toHaveLength(51); expect(derive).toHaveBeenCalledTimes(51)
    expect(first).toHaveLength(50); expect(Object.isFrozen(first)).toBe(true)
  })
  it('does not keep using cached views after a used projection is unregistered', () => {
    const definitions: SessionMessageProjection[] = [projection], s = make(definitions)
    const event = disclosure(s, 'before'); s.append('i7/context-project', { seq: event.seq, text: 'after' })
    expect(hasVisibleDisclosure(s, 'skill', 'after')).toBe(true)
    definitions.length = 0
    expect(() => visibleMessages(s)).toThrow(/removed or replaced/)
  })
  it('projects user instructions without treating quoted user text as tool evidence', () => {
    const s = make()
    const event = s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    s.append('i7/context-project', { seq: event.seq, text: 'actual context' })
    expect(visibleUserMessages(s)[0]?.content).toEqual([{ type: 'text', text: 'actual context' }])
    expect(hasVisibleDisclosure(s, 'skill', 'actual context')).toBe(false)
  })
  it('does not treat retained source metadata as proof that projected-away instructions remain visible', () => {
    const s = make()
    const event = s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ORIGINAL_RULES' }], source: { kind: 'plugin', plugin: 'fixture-instructions' } }), { surfaceOp: 'append' })
    expect(visibleAuthoredUserMessages(s)).toHaveLength(1)
    s.append('i7/context-project', { seq: event.seq, text: 'SUMMARY_WITHOUT_RULES' })
    expect(visibleUserMessages(s)).toHaveLength(1)
    expect(visibleAuthoredUserMessages(s)).toHaveLength(0)
  })
  it('reissues runtime context when a projection replaces its earlier full text', async () => {
    const s = make(), ctx = new Context()
    const event = s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'POLICY' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }), { surfaceOp: 'append' })
    const runtime = new RuntimeContextProjection(ctx, s)
    expect(runtime.project('POLICY', [])).toBeUndefined()
    s.append('i7/context-project', { seq: event.seq, text: 'policy removed' })
    expect(runtime.project('POLICY', [])?.content).toEqual([{ type: 'text', text: 'POLICY' }])
    await ctx.fiber.dispose()
  })
  it('remembers that a removed snapshot existed after restoration, and emits clearing context', async () => {
    const s = make(), ctx = new Context()
    const event = s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prior' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }), { surfaceOp: 'append' })
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
    expect(new RuntimeContextProjection(ctx, s).project('', [])).toBeDefined()
    await ctx.fiber.dispose()
  })
})
