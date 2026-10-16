import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog } from "../../../src/library/session/format/index.ts"
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject } from "../../../src/library/session/format/index.ts"
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from "../../../src/library/session/format-v4/index.ts"

const header = { version: 4, id: 'canonical:code:session', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const config = { provider: 'mock', model: 'mock', stop: [] }
const catalog = createSessionFormatCatalog({
  currentVersion: 4, oldestVersion: 4,
  codecs: [releasedV4SessionFormatCodec],
  migrations: [],
  currentEncoder: releasedV4SessionFormatCodec,
  restoreCurrentHeader(value) { assertReleasedV4Header(value); return value },
  restoreCurrent: value => restoreReleasedV4Artifact(value, new Set()),
  restoreTransformedCurrent: value => restoreReleasedV4Artifact(value, new Set()),
})

function event(type: string, seq: number, data: SessionFormatEvent['data'], fields: SessionFormatJsonObject = {}): SessionFormatEvent {
  return { type, seq, time: seq - 20, data, ...fields }
}

function restore(events: readonly SessionFormatEvent[], sourceHeader = header): SessionFormatArtifact {
  const reader = catalog.createRestore({ type: 'session', ...sourceHeader }, { recovery: 'strict', validation: 'current' })
  for (const row of events) reader.decodeRow(row)
  return reader.finish()
}

function reopen(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const reader = catalog.createRestore(releasedV4SessionFormatCodec.encodeHeader(artifact.header, artifact.inheritedEventCount), {
    recovery: 'strict', validation: 'current',
  })
  for (const row of artifact.events) reader.decodeRow(releasedV4SessionFormatCodec.encodeEvent(row))
  return reader.finish()
}

const opening = [event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 })]
const message = {
  id: 'message:code:1', role: 'user', source: { kind: 'plugin', plugin: 'tools-code-mode' },
  content: [{ type: 'text', text: 'tools-code-mode tool/code-dispatch code 图片' }],
}
const dispatch = {
  rootCallId: 'root:code:1', parentCallId: 'root:code:1', subCallId: 'root:code:1:code:2',
  name: 'run_code', arguments: { code: 'return 3', source: { kind: 'plugin', plugin: 'tools-code-mode' }, start: 4, end: 6 },
}

function seededHistory(): SessionFormatEvent[] {
  return [
    event('agent-preset/selected', 0, { agentPreset: 'code' }),
    event('turn/start', 1, { turn: 1 }),
    event('step/start', 2, { turn: 1, step: 1 }),
    event('request/header', 3, { reason: 'initial', header: { config, system: 'seed prompt', tools: [], adapterDefaults: {} } }),
    event('user/message', 4, message, { surfaceOp: 'append' }),
    event('tool/code-dispatch-start', 5, dispatch),
    event('tool/code-dispatch', 6, { ...dispatch, isError: true, content: message.content }),
    event('step/end', 7, { turn: 1, step: 1 }),
    event('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
    event('session-log-deepseek/delivery-accepted', 9, { sessionId: 'parent', throughSeq: 8, sessionFormatVersion: 2 }),
    event('session/end-seed', 10, { inherited: true }),
    event('agent-preset/selected', 11, { agentPreset: 'standard' }),
    event('agent-preset/selected', 12, { agentPreset: 'code' }),
    event('turn/start', 13, { turn: 2 }),
    event('step/start', 14, { turn: 2, step: 1 }),
    event('request/header', 15, { reason: 'change', header: { config, system: 'local prompt', tools: [], adapterDefaults: {} } }),
    event('user/message', 16, { ...message, id: 'message:code:2' }, {
      surfaceOp: { op: 'replace', start: 4, end: 4 }, sourceEventSeqs: [4, 6],
    }),
    event('step/end', 17, { turn: 2, step: 1 }),
    event('turn/end', 18, { turn: 2, reason: { kind: 'completed' } }),
  ]
}

const seededHeader = { ...header, isSeeded: true, parentSession: 'parent', agentPreset: 'code' }

describe('canonical preservation across migration and native reload', () => {

  it('preserves native code presets, attribution and nested canonical-looking extension values', () => {
    const nativeHeader = { ...header, version: 4, agentPreset: 'code' }
    const extension = { tools: [], adapterDefaults: {}, system: '', surfaceOp: { op: 'replace', start: 90, end: 99 }, agentPreset: 'code' }
    const rows = [
      event('agent-preset/selected', 0, { agentPreset: 'code', extension }),
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('user/message', 3, { ...message, source: { ...message.source, extension } }, { surfaceOp: 'append' }),
      event('request/header', 4, { reason: 'initial', header: { config, extension } }),
    ]
    const before = JSON.stringify({ header: nativeHeader, rows })
    const target = restore(rows, nativeHeader)
    expect(target).toEqual({ header: nativeHeader, inheritedEventCount: 0, events: rows })
    expect(reopen(target)).toEqual(target)
    expect(JSON.stringify({ header: nativeHeader, rows })).toBe(before)
  })
})
