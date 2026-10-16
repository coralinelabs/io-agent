import { createUserMessage } from "../../../src/library/model/llm/index.ts"
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from "../../../src/library/session/journal/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import JsonlSessionPersistence from "../../../src/library/session/persistence-jsonl/index.ts"
import SessionTitleService, { foldSessionTitle } from "../../../src/library/session/title/index.ts"

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function appendPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const session = ctx.sessions.create(id)
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    session.append('turn/start', {
      turn: 1,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Persist this session title' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionTitle.refresh(session)
  } finally {
    await handle.close()
  }
}

async function expectPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    const { events } = await handle.read()
    expect(foldSessionTitle(events)).toMatchObject({
      title: 'Persist this session title',
      messageSeqs: [1],
      source: { kind: 'fallback' },
      eventSeq: 3,
    })
    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'turn/end',
      'session/title',
    ])
  } finally {
    await handle.close()
  }
}

describe('session title persistence round trips', () => {
  it('round-trips through a remounted JSONL backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-jsonl-'))
    roots.push(root)
    const id = SessionId('title-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendPersistedTitle(writer, id)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expectPersistedTitle(reader, id)
    await reader.fiber.dispose()
  })
})
