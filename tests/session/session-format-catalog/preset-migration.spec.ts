/** Every historical entry generation migrates all preset selections before projection or fork. */

import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from "../../../src/library/session/format-catalog/index.ts"

describe('catalog preset migration', () => {

  it('does not reinterpret a native v4 custom preset named code', () => {
    const header = {
      type: 'session', version: 4, id: 'native', createdAt: 1, isSeeded: false,
      delegationDepth: 0, agentPreset: 'code',
    }
    const row = { type: 'agent-preset/selected', seq: 0, time: 1, data: { agentPreset: 'code' } }
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    restore.decodeRow(row)
    expect(restore.finish()).toMatchObject({ header: { agentPreset: 'code' }, events: [row] })
  })
})
