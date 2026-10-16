import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog, SessionFormatEventCollector } from "../../../src/library/session/format/index.ts"
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from "../../../src/library/session/format/index.ts"
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from "../../../src/library/session/format-v4/index.ts"

const header: SessionFormatHeader = {
  version: 2, id: 'canonical-envelopes', createdAt: 1, isSeeded: false, delegationDepth: 0,
}

function event(
  type: string,
  seq: number,
  data: SessionFormatJsonValue,
  optional: SessionFormatJsonObject = {},
): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...optional }
}

function user(seq: number, optional: SessionFormatJsonObject = { surfaceOp: 'append' }): SessionFormatEvent {
  return event('user/message', seq, {
    id: `user-${seq}`, role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
  }, optional)
}

function opening(): SessionFormatEvent[] {
  return [event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 })]
}

function artifact(events: readonly SessionFormatEvent[]): SessionFormatArtifact {
  return { header: { ...header, version: 4 }, inheritedEventCount: 0, events }
}

function restore(value: SessionFormatArtifact): SessionFormatArtifact {
  return restoreReleasedV4Artifact(value, new Set())
}

function toolLog(isError: boolean, error?: SessionFormatJsonValue): SessionFormatEvent[] {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    event('assistant/message', 2, {
      turn: 1, step: 1, stream: [],
      message: {
        id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }],
      },
    }, { surfaceOp: 'append' }),
    event('tool/call', 3, { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' }),
    event('tool/result', 4, {
      turn: 1, step: 1,
      message: {
        toolCallId: 'call',
        isError,
        id: 'tool', role: 'tool', source: { kind: 'tool', callId: 'call' },
        content: [{ type: 'text', text: 'result' }],
      },
      ...(error === undefined ? {} : { error }),
    }, { surfaceOp: 'append', sourceEventSeqs: [3] }),
    event('step/end', 5, { turn: 1, step: 1 }),
    event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('canonical V2 to V4 envelopes', () => {

  it.each([
    ['V2 fields', { op: 'replace', start: 0, end: 0 }],
    ['mixed fields', { op: 'replace', start: 0, endSeq: 0 }],
    ['both generations', { op: 'replace', start: 0, end: 0, startSeq: 0, endSeq: 0 }],
    ['empty object', {}],
    ['missing end', { op: 'replace', startSeq: 0 }],
    ['extra field', { op: 'replace', startSeq: 0, endSeq: 0, extra: true }],
  ] satisfies [string, SessionFormatJsonValue][])(
    'requires canonical replacement fields on native V4: %s', (_name, surfaceOp) => {
      expect(() => restore(artifact([user(0), user(1, { surfaceOp, sourceEventSeqs: [0] })])))
        .toThrow(/exact replace fields/)
    },
  )
})

describe('native V4 event admission', () => {
  const mode: string = 'native V4'
  const admit = (events: readonly SessionFormatEvent[]) => restore(artifact(events))

  it.each(['user/message', 'assistant/message', 'tool/result'])('requires a surface marker on %s', (type) => {
    expect(() => admit([event(type, 0, {})])).toThrow(mode === 'migration' ? /requires surfaceOp/ : /requires a surfaceOp/)
  })

  it.each(['feedback/record', 'assistant/attempt'])(
    'forbids surface metadata on log-only %s', (type) => {
      const variants: SessionFormatJsonObject[] = [{ surfaceOp: 'append' }, { sourceEventSeqs: [] }]
      for (const metadata of variants) {
        expect(() => admit([event(type, 0, {}, metadata)])).toThrow(/unexpected field/)
      }
    },
  )

  it.each([
    ['empty array', []], ['nonempty array', [0]], ['null', null], ['boolean', false],
  ] satisfies [string, SessionFormatJsonValue][])('forbids assistant sourceEventSeqs: %s', (_name, sourceEventSeqs) => {
    const events = toolLog(false)
    events[2] = { ...events[2]!, sourceEventSeqs }
    expect(() => admit(events)).toThrow(mode === 'migration' ? /chunk references/ : /cannot carry sourceEventSeqs/)
  })

  it.each([
    ['empty', []], ['scalar', 0], ['null', null], ['negative', [-1]], ['fractional', [0.5]],
    ['unsafe integer', [Number.MAX_SAFE_INTEGER + 1]], ['current', [3]], ['future', [4]], ['duplicate', [0, 0]],
  ] satisfies [string, SessionFormatJsonValue][])(
    'refuses invalid source-event references: %s', (_name, sourceEventSeqs) => {
      expect(() => admit([...opening(), user(2), user(3, { surfaceOp: 'append', sourceEventSeqs })]))
        .toThrow(/sourceEventSeqs/)
    },
  )

  it.each(['type', 'seq', 'time', 'data'])('requires logical envelope member %s', (key) => {
    const malformed = Object.fromEntries(Object.entries(user(0)).filter(([member]) => member !== key))
    const diagnostic = mode === 'migration' && key === 'type' ? /unclassified event undefined/
      : mode === 'migration' && key === 'seq' ? /source events must be dense/ : /lacks required field/
    expect(() => admit([malformed as SessionFormatEvent])).toThrow(diagnostic)
  })

  it.each([
    ['non-string type', { type: false, seq: 0, time: 1, data: {} }, /type must be a string/],
    ['false ignorable marker', { ...user(0), ignorable: false }, /ignorable must be true/],
    ['null ignorable marker', { ...user(0), ignorable: null }, /ignorable must be true/],
  ] satisfies [string, SessionFormatJsonObject, RegExp][])('rejects invalid envelope values: %s', (_name, malformed, message) => {
    expect(() => admit([malformed as SessionFormatEvent])).toThrow(mode === 'migration' && _name === 'non-string type' ? /unclassified event false/ : message)
  })

  it('rejects a successful tool result carrying error metadata', () => {
    expect(() => admit(toolLog(false, { name: 'ReadError', code: 'READ_FAILED' })))
      .toThrow(/error metadata for a non-error tool result/)
  })

  it.each([undefined, { name: 'ReadError', code: 'READ_FAILED' }])(
    'preserves failed tool results without inventing or deleting error metadata: %j', (error) => {
      const events = toolLog(true, error)
      const target = admit(events)
      const result = target.events.find(item => item.type === 'tool/result')!
      expect(result.data).toBe(events[4]?.data)
      expect(result.seq).toBe(mode === 'migration' ? 5 : 4)
      expect(result['sourceEventSeqs']).toEqual(mode === 'migration' ? [4] : [3])
      expect((result.data as SessionFormatJsonObject)['error']).toBe(error)
      expect(restore(target)).toBe(target)
    },
  )
})

describe('native V4 opaque event preservation', () => {
  it.each(['external/future', 'tool/code-dispatch-start', 'tool/code-dispatch'])(
    'preserves arbitrary data and surface metadata on ignorable %s', (type) => {
      for (const data of [null, false, ['opaque'], { nested: { sourceEventSeqs: [900], surfaceOp: null } }]) {
        for (const metadata of [
          { sourceEventSeqs: null, surfaceOp: false },
          { sourceEventSeqs: [900, 900], surfaceOp: { future: ['opaque'] } },
        ]) {
          const source = event(type, 0, data, { ignorable: true, ...metadata })
          const value = artifact([source])
          const before = JSON.stringify(value)
          expect(restore(value)).toBe(value)
          expect(JSON.stringify(value)).toBe(before)
        }
      }
    },
  )

  it.each(['external/future', 'tool/code-dispatch-start', 'tool/code-dispatch'])(
    'round-trips ignorable %s with physical source-event ranges and arbitrary data', (type) => {
      for (const data of [null, false, ['opaque'], { nested: { sourceEventSeqs: null } }]) {
        const source = event(type, 1, data, { ignorable: true, sourceEventSeqs: [0], surfaceOp: { future: ['opaque'] } })
        const row = releasedV4SessionFormatCodec.encodeEvent(source)
        const decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 4 }, 'strict')
        const output = new SessionFormatEventCollector()
        const first = event('feedback/record', 0, { text: 'prior' })
        decoder.decodeRow(first, output)
        decoder.decodeRow(row, output)
        expect(decoder.finish(output)).toBe(0)
        expect(output.values).toEqual([first, source])
      }
    },
  )

  it.each(['system/message', 'user/message', 'assistant/message', 'tool/result'])(
    'requires exact replacement envelope fields on %s', (type) => {
      const data = type === 'system/message'
        ? { turn: 1, step: 1, message: { id: 'system', role: 'system', content: [], source: { kind: 'plugin', plugin: 'context' } } }
        : {}
      for (const surfaceOp of [
        { op: 'replace', start: 0, end: 0 },
        { op: 'replace', startSeq: 0, endSeq: 0, extra: true },
      ]) {
        expect(() => releasedV4SessionFormatCodec.encodeEvent(event(type, 1, data, { surfaceOp })))
          .toThrow(/exact replace fields/)
      }
    },
  )

  it.each(['', 'prompt', null, false, [], {}])('hard-refuses native header.system %j after corruption', (system) => {
    const row = event('request/header', 2, { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, system } })
    for (const recovery of ['strict', 'recoverable'] as const) {
      const decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 4 }, recovery)
      const output = new SessionFormatEventCollector()
      if (recovery === 'recoverable') decoder.decodeRow(null, output)
      expect(() => { decoder.decodeRow(row, output) }).toThrow(/header.system/)
      expect(() => releasedV4SessionFormatCodec.encodeEvent(row)).toThrow(/header.system/)
    }
  })
})

describe('native V4 physical admission', () => {
  const physicalHeader = { type: 'session', ...header, version: 4 }
  const catalog = createSessionFormatCatalog({
    currentVersion: 4, oldestVersion: 4,
    codecs: [releasedV4SessionFormatCodec],
    migrations: [],
    currentEncoder: releasedV4SessionFormatCodec,
    restoreCurrentHeader(value) { assertReleasedV4Header(value); return value },
    restoreCurrent: restore,
    restoreTransformedCurrent: restore,
  })
  const invalidRows: [string, SessionFormatEvent, RegExp][] = [
    ['missing surface marker', user(1, {}), /requires a surfaceOp/],
    ['old replacement', user(1, { surfaceOp: { op: 'replace', start: 0, end: 0 } }), /exact replace fields/],
    ['current replacement start', user(1, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 0 } }), /replacement endpoints must reference earlier events/],
    ['future replacement start', user(1, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 0 } }), /replacement endpoints must reference earlier events/],
    ['current replacement end', user(1, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }), /replacement endpoints must reference earlier events/],
    ['future replacement end', user(1, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 } }), /replacement endpoints must reference earlier events/],
    ['empty header optional', event('request/header', 1, {
      reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, tools: [] },
    }), /empty optional header fields/],
    ['contradictory tool result', { ...toolLog(false, { code: 'FAILED' })[4]!, seq: 1, sourceEventSeqs: [0] }, /non-error tool result/],
  ]

  it.each(invalidRows)('rejects %s through strict decoding and encoding', (_name, invalid, message) => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('turn/start', 0, { turn: 1 }), output)
    expect(() => { decoder.decodeRow(invalid, output) }).toThrow(message)
    expect(() => releasedV4SessionFormatCodec.encodeEvent(invalid)).toThrow(message)
  })

  it.each(invalidRows)('rejects %s even when native catalog validation is transformed', (_name, invalid, message) => {
    const reader = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'transformed' })
    reader.decodeRow(event('turn/start', 0, { turn: 1 }))
    expect(() => { reader.decodeRow(invalid) }).toThrow(message)
  })

  it.each(invalidRows)('discards an incomplete invalid tail containing %s', (_name, invalid) => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    const opening = event('turn/start', 0, { turn: 1 })
    decoder.decodeRow(opening, output)
    decoder.decodeRow(invalid, output)
    decoder.decodeRow(user(2), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([opening])
  })

  it.each(invalidRows)('refuses a later commit after %s', (_name, invalid, message) => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('turn/start', 0, { turn: 1 }), output)
    decoder.decodeRow(invalid, output)
    expect(() => { decoder.decodeRow(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }), output) })
      .toThrow(message)
  })

  it('retains the accepted seeded cut before a discarded invalid marker', () => {
    const decoder = releasedV4SessionFormatCodec.createDecoder({ ...physicalHeader, isSeeded: true }, 'recoverable')
    const output = new SessionFormatEventCollector()
    const first = event('external/event', 0, {}, { ignorable: true })
    const marker = event('session/end-seed', 1, { inherited: true })
    decoder.decodeRow(first, output)
    decoder.decodeRow(marker, output)
    decoder.decodeRow(event('session/end-seed', 2, { inherited: true }, { surfaceOp: 'append' }), output)
    decoder.decodeRow(user(3), output)
    expect(decoder.finish(output)).toBe(1)
    expect(output.values).toEqual([first, marker])
  })

  it('rejects a seeded log whose only inherited marker was discarded', () => {
    const decoder = releasedV4SessionFormatCodec.createDecoder({ ...physicalHeader, isSeeded: true }, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('session/end-seed', 0, { inherited: true }, { surfaceOp: 'append' }), output)
    expect(() => decoder.finish(output)).toThrow(/lacks an accepted inherited end-seed marker/)
    expect(output.values).toEqual([])
  })

  it('ignores a discarded inherited marker in an unseeded semantic tail', () => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    const first = event('external/event', 0, {}, { ignorable: true })
    decoder.decodeRow(first, output)
    decoder.decodeRow(user(1, {}), output)
    decoder.decodeRow(event('session/end-seed', 2, { inherited: true }), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([first])
  })

  it.each([0, 1])('rejects an accepted inherited marker at seq %s in an unseeded log with a discarded tail', (seq) => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    if (seq === 1) decoder.decodeRow(event('external/event', 0, {}, { ignorable: true }), output)
    decoder.decodeRow(event('session/end-seed', seq, { inherited: true }), output)
    decoder.decodeRow(user(seq + 1, {}), output)
    expect(() => decoder.finish(output)).toThrow(/unseeded Session contains an inherited end-seed marker/)
  })

  it('preserves ordinary untagged markers during recovery', () => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    const marker = event('session/end-seed', 0, {})
    decoder.decodeRow(marker, output)
    decoder.decodeRow(user(1, {}), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([marker])
  })

  it('preserves a canonical native artifact through transformed catalog decoding', () => {
    const reader = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'transformed' })
    const source = toolLog(false)
    for (const item of source) reader.decodeRow(releasedV4SessionFormatCodec.encodeEvent(item))
    expect(reader.finish()).toEqual(artifact(source))
  })
})

describe('V4 full artifact relationships', () => {
  it.each([{ surfaceOp: 'append' }, { sourceEventSeqs: [] }])('defers unclassified required metadata %j until vocabulary-aware restoration', (metadata) => {
    const required = event('future/required', 0, {}, metadata)
    const output = new SessionFormatEventCollector()
    const decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 4 }, 'recoverable')
    decoder.decodeRow(required, output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([required])
    expect(() => restore(artifact(output.values))).toThrow(/unknown event type/)
    expect(() => restoreReleasedV4Artifact(artifact(output.values), new Set(['future/required'])))
      .toThrow(/unexpected field/)
  })

  it('admits installed required extension payloads without surface metadata', () => {
    const required = event('future/required', 0, { extension: true })
    const value = artifact([required])
    expect(restoreReleasedV4Artifact(value, new Set(['future/required']))).toBe(value)
  })
})
