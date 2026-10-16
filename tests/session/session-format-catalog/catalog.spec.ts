import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent } from "../../../src/library/session/format/index.ts"
import { sessionFormatCatalog } from "../../../src/library/session/format-catalog/index.ts"
import { currentSessionMessageProjections } from "../../../src/library/session/format-catalog/message-projections.ts"
import { MESSAGE_PROJECTION_EVENT_TYPES } from "../../../src/library/session/journal/known-event-types.ts"
import { validateInstalledCurrentSessionArtifact } from "../../../src/library/session/format-catalog/current.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import { createUserMessage } from "../../../src/library/model/llm/index.ts"

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('first-party Session format catalog', () => {
  it('supplies every required current message interpreter and validates its durable references', () => {
    expect(currentSessionMessageProjections.map(projection => projection.type).sort())
      .toEqual([...MESSAGE_PROJECTION_EVENT_TYPES].sort())
    const session = Session.create(SessionId('projection-catalog'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'no image' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const artifact = {
      header: { ...session.header, delegationDepth: 0 }, inheritedEventCount: 0,
      events: [...session.snapshotEvents() as unknown as SessionFormatEvent[], { type: 'image/offload', seq: 1, time: 0, data: { targets: [{ seq: 0, imageIndexes: [0] }] } }],
    }
    expect(() => { validateInstalledCurrentSessionArtifact(artifact) }).toThrow(/image index 0 does not exist/)
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: 4, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const restore = (rows: readonly unknown[]) => {
      const current = sessionFormatCatalog.createRestore(header, {
        recovery: 'strict', validation: 'current',
      })
      for (const row of rows) current.decodeRow(row)
      return current.finish()
    }
    const extended = restore([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(extended.events).toEqual([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])

    expect(() => restore([{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])).toThrow(/unknown event type/)

    const extension = restore([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(extension.events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })

  it.each(['current', 'transformed'] as const)('rejects native v4 obsolete required tags with %s validation and retains ignorable tags', (validation) => {
    const header = deepFreeze({ type: 'session', version: 4, id: 'native-ptc', createdAt: 1, isSeeded: false, delegationDepth: 0 })
    for (const type of ['tool/code-dispatch-start', 'tool/code-dispatch']) {
      const required = deepFreeze({ type, seq: 0, time: 1, data: null })
      const rejected = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation })
      expect(() => { rejected.decodeRow(required) }).toThrow(/unknown event type/)
      const ignorable = deepFreeze({ ...required, ignorable: true, data: { text: 'tools-code-mode', source: { kind: 'plugin', plugin: 'tools-code-mode' } } })
      const accepted = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation })
      accepted.decodeRow(ignorable)
      expect(accepted.finish().events).toEqual([ignorable])
    }
  })
})
