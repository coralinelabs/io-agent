import { describe, expect, it } from 'vitest'
import { assertRecordedContent } from '../../../src/library/model/llm/content-validation.ts'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from "../../../src/library/session/format/index.ts"
import { sessionFormatCatalog } from "../../../src/library/session/format-catalog/index.ts"

const header = { version: 2, id: 'content-admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const text = { type: 'text', text: 'input' }
const future = { type: 'future-content', seq: 987, content: [{ type: 'text', text: 'opaque' }] }
const user = { id: 'user', role: 'user', source: { kind: 'user' }, content: [text] }
const model = { kind: 'model', provider: 'mock', model: 'mock' }
const dispatch = { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {} }
function event(type: string, data: SessionFormatJsonObject, surface = false): SessionFormatEvent {
  return { type, seq: 0, time: 1, data, ...(surface ? { surfaceOp: 'append' } : {}) }
}
const opening = [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }), event('user/message', user, true)]
const closing = [event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
function assistant(type: string, stream: SessionFormatJsonValue, content: SessionFormatJsonValue = [text]): SessionFormatEvent {
  return event(type, { turn: 1, step: 1, stream, ...(type === 'assistant/message' ? { message: { id: 'assistant', role: 'assistant', source: model, content } } : {}) }, type === 'assistant/message')
}
const messageCarriers = [
  { type: 'user/message', path: 'data.content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('user/message', { ...user, id: 'second', content }, true)] },
  { type: 'assistant/message', path: 'data.message.content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: model, content } }, true)] },
  { type: 'tool/result', path: 'data.message.content', seq: 5, rows: (content: SessionFormatJsonValue) => [
    event('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'assistant', role: 'assistant', source: model, content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }] } }, true),
    event('tool/call', { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' }),
    event('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'tool', source: { kind: 'tool', callId: 'call' }, toolCallId: 'call', isError: false, content } }, true),
  ] },
  { type: 'agent/inbox/spliced', path: 'data.inserted[0].content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ ...user, id: 'inbox', content }] })] },
  { type: 'session/title-llm-request', path: 'data.messages[0].content', seq: 3, rows: (content: SessionFormatJsonValue) => [event('session/title-llm-request', { titleProvider: 'mock', messageSeqs: [2], route: { provider: 'mock', model: 'mock' }, system: 'title', maxTokens: 987, messages: [{ ...user, id: 'title', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' }, content }] })] },
]
const carriers = [
  ...messageCarriers,
  { type: 'team/message/queued', path: 'data.message.content', seq: 3, rows: (content: SessionFormatJsonValue) => [
    event('team/message/queued', { version: 1, teamId: 'team', message: { id: 'queued', senderId: 'lead', senderName: 'lead', targetId: 'worker', delivery: 'quiet', content } }),
  ] },
  ...['summary', 'rawOutput'].map(field => ({ type: 'compaction/summary', path: 'data.' + field, seq: 4, rows: (content: SessionFormatJsonValue) => [
    event('compaction/start', { compactionId: 'compact', turn: 1 }),
    event('compaction/summary', { compactionId: 'compact', provider: 'mock', model: 'mock', summary: [text], [field]: content, shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 987 }),
    event('compaction/end', { compactionId: 'compact', turn: 1 }),
  ] })),
  { type: 'tool/ptc-dispatch', path: 'data.content', seq: 4, rows: (content: SessionFormatJsonValue) => [
    event('tool/ptc-dispatch-start', dispatch), event('tool/ptc-dispatch', { ...dispatch, content, isError: false }),
  ] },
]

const admitted = [
  text,
  { type: 'reasoning', text: '' },
  { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 987, width: 1, height: 2, name: '', originalDimensions: { width: 3, height: 4 } } },
  { type: 'file', attachment: { attachmentId: 'file', name: '', bytes: 987 } },
  { type: 'tool-call', id: 'opaque-call', name: 'read', arguments: '{"type":"future-content","seq":987}' },
]
const malformed = [
  { block: { type: 'text', text: 12 }, kind: 'text' },
  { block: { type: 'reasoning', text: 'ok', extra: true }, kind: 'reasoning' },
  { block: { type: 'image', attachment: {} }, kind: 'image' },
  { block: { type: 'file', attachment: { attachmentId: 'file', name: 'file', bytes: -1 } }, kind: 'file' },
  { block: { type: 'tool-call', id: '', name: 'read', arguments: '{}' }, kind: 'tool-call' },
  { block: { type: 'tool-result', toolCallId: '', content: [] }, kind: 'tool-result' },
  { block: { type: 'tool-result', toolCallId: 'call', content: null }, kind: 'tool-result' },
] satisfies { block: SessionFormatJsonObject; kind: string }[]

function catalog(rows: readonly SessionFormatEvent[], version: 4, validation: 'current' | 'transformed' = 'current') {
  const physical = version === 4 ? { type: 'session', ...header, version } : { type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0 }
  const reader = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation })
  for (const [seq, row] of rows.entries()) reader.decodeRow({ ...row, seq })
  return reader.finish()
}

describe('native V4 content admission', () => {

  it.each(['current', 'transformed'] as const)('keeps native V4 extension acceptance in content and raw stream records (%s)', (validation) => {
    const base = { events: [...opening, ...closing] }
    const body = base.events.slice(0, -2)
    const extensionRows = [
      event('user/message', { ...user, id: 'extension', content: [future] }, true),
      ...carriers.find(carrier => carrier.type === 'team/message/queued')!.rows([future]),
      assistant('assistant/message', [{ type: 'chunk', time: 987, chunk: { type: 'block-end', index: 987, block: future } }]),
      assistant('assistant/attempt', [{ type: 'chunk', time: 987, chunk: { type: 'block-start', index: 987, blockType: 'future-content' } }]),
    ]
    const output = catalog([...body, ...extensionRows, ...closing], 4, validation)
    expect(output.events.slice(body.length, -2).map(row => row.data)).toEqual(extensionRows.map(row => row.data))
  })

  for (const carrier of carriers) {
    it(`${carrier.type} ${carrier.path} preserves valid native blocks and opaque extensions`, () => {
      // Shape admission and transcript relationships are distinct contracts.
      for (const row of carrier.rows([...admitted, future])) expect(() => assertRecordedContent(row.type, row.data, 'data')).not.toThrow()
      const content = carrier.type === 'session/title-llm-request' ? [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n' + JSON.stringify([{seq: 2, text: 'input'}]) }]
        : [...admitted.filter(block => carrier.type !== 'assistant/message' || block.type !== 'tool-call'), future]
      const rows = [...opening, ...carrier.rows(content), ...closing]
      for (const mode of ['current', 'transformed'] as const) {
        const restored = catalog(rows, 4, mode)
        expect(restored.events.map(row => row.data)).toEqual(rows.map(row => row.data))
      }
    })
    for (const [index, { block }] of malformed.entries()) {
      it(`${carrier.type} ${carrier.path} rejects malformed known block ${index} in both admission modes`, () => {
        const rows = carrier.rows([block])
        expect(() => rows.forEach(row => assertRecordedContent(row.type, row.data, 'data'))).toThrow()
        for (const mode of ['current', 'transformed'] as const) {
          expect(() => catalog([...opening, ...rows, ...closing], 4, mode)).toThrow()
        }
      })
    }
    it(`${carrier.type} ${carrier.path} requires an array of objects with a nonempty type`, () => {
      for (const content of [null, {}, [null], [{}], [{type: ''}]]) {
        expect(() => catalog([...opening, ...carrier.rows(content), ...closing], 4)).toThrow()
      }
    })
  }

  for (const type of ['assistant/message', 'assistant/attempt']) {
    it(`${type} validates completed known blocks in the raw stream, not only final content`, () => {
      for (const { block } of malformed) {
        const stream = [{ type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block } }]
        for (const mode of ['current', 'transformed'] as const) {
          expect(() => catalog([...opening, assistant(type, stream), ...closing], 4, mode)).toThrow()
        }
      }
    })
    it(`${type} rejects malformed starts without interpreting future block types`, () => {
      for (const blockType of [null, '', 'tool-result']) {
        const stream = [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType } }]
        expect(() => catalog([...opening, assistant(type, stream), ...closing], 4)).toThrow()
      }
    })
  }
})
