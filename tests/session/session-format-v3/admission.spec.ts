import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from "../../../src/library/session/format/index.ts"
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from "../../../src/library/session/format/index.ts"
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from "../../../src/library/session/format-v4/index.ts"

const header = { version: 2, id: 'admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const user = { id: 'user', role: 'user', content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } }
const system = { turn: 1, step: 1, message: { ...user, role: 'system', source: { kind: 'plugin', plugin: 'context' } } }
function event(type: string, data: SessionFormatJsonValue, extra: SessionFormatJsonObject = {}): SessionFormatEvent {
  return { type, seq: 0, time: 1, data, ...extra }
}
const opening = [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 })]
function native(input: readonly SessionFormatEvent[]) {
  const artifact = { header: { ...header, version: 4 }, inheritedEventCount: 0, events: input.map((value, seq) => ({ ...value, seq })) }
  return restoreReleasedV4Artifact(artifact, new Set())
}

describe('durable V4 admission failures', () => {

  it('checks native metadata versions before applying released header validation', () => {
    expect(() =>{  assertReleasedV4Header(header) }).toThrow(/format v4 header/)
    expect(releasedV4SessionFormatCodec.decodeHeader({ type: 'session', ...header, version: 4 })).toEqual({ ...header, version: 4 })
  })

  it.each([0, -1, 1.5])('rejects invalid system step coordinates %s', (step) => {
    expect(() => releasedV4SessionFormatCodec.encodeEvent(event('system/message', { ...system, step }, { surfaceOp: 'append' }))).toThrow()
  })

  it('refuses appending system context after a history with no protected head', () => {
    expect(() => native([...opening, event('user/message', user, { surfaceOp: 'append' }), event('system/message', system, { surfaceOp: 'append' })])).toThrow(/protected first/)
  })

  it('rejects ordinary replacements that consume the protected head', () => {
    expect(() => native([...opening, event('system/message', system, { surfaceOp: 'append' }), event('user/message', user, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] })])).toThrow(/protected/)
  })
})

describe('tool result restoration', () => {
  const call = { type: 'tool-call', id: 'call', name: 'tool', arguments: '{}' }
  const assistant = event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [call] } }, { surfaceOp: 'append' })
  const started = event('tool/call', { turn: 1, step: 1, callId: 'call', name: 'tool', arguments: '{}' })
  const result = { turn: 1, step: 1, message: {
toolCallId: 'call',
isError: true, id: 'result', role: 'tool', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: 'result' }] } }
  it('rejects untagged repair identities in native restoration instead of projecting arbitrary IDs', () => {
    const repair = event('tool/result', { ...result, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } }, { surfaceOp: 'append' })
    expect(() => native([...opening, assistant, repair])).toThrow(/exact TOOL_NOT_STARTED/)
    const malformedSource = { ...result.message, source: { kind: 'tool', callId: 123 } }
    const malformed = event('tool/result', { ...result, message: malformedSource, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } }, { surfaceOp: 'append' })
    expect(() => native([...opening, assistant, malformed])).toThrow(/advertised tool/)
  })
})
