import { freezeMessage, MessageId } from "../../../src/library/model/llm/index.ts"
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { Session, SessionId, SessionLogOffset, SessionSeq } from "../../../src/library/session/journal/index.ts"
import type { SessionEvent } from "../../../src/library/session/journal/index.ts"
import { SessionFormatUnsupportedError } from "../../../src/library/session/persistence/index.ts"
import type { SessionHandle } from "../../../src/library/session/persistence/index.ts"
import JsonlSessionPersistence from "../../../src/library/session/persistence-jsonl/index.ts"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from "../../../src/library/session/persistence-jsonl/format.ts"

const id = SessionId('v2-system-migration')
const config = { provider: 'mock', model: 'mock' }
let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v2-system-migration-'))
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

function request(system?: string) {
  return {
    type: 'request/header',
    data: { header: { config, ...(system === undefined ? {} : { system }) }, reason: 'change' },
  }
}

function user(text: string) {
  return {
    type: 'user/message', surfaceOp: 'append',
    data: { id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

async function writeV2(rows: readonly object[], seeded = false): Promise<string> {
  const path = generationLogPath(root, undefined, id, 2, 'none')
  await mkdir(dirname(path), { recursive: true })
  const header = {
    type: 'session', version: 2, id, createdAt: 1, isSeeded: seeded, delegationDepth: 0,
    ...(seeded ? { parentSession: 'parent' } : {}),
  }
  await writeFile(path, [header, ...rows.map((row, seq) => ({ ...row, seq, time: seq + 10 }))]
    .map(row => JSON.stringify(row)).join('\n') + '\n')
  return path
}

async function observeFile(path: string) {
  const identity = await stat(path, { bigint: true })
  return {
    bytes: await readFile(path), dev: identity.dev, ino: identity.ino,
    size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs,
  }
}

async function restore(handle: SessionHandle): Promise<Session> {
  const read = await handle.read()
  return Session.fromRestore(id, read.events, handle.header, handle.inheritedEventCount, read.eventState)
}

function messages(session: Session) {
  return session.deriveMessages().map(({ role, content }) => ({ role, content }))
}

function prompt(text: string) {
  return { role: 'system', content: [{ type: 'text', text }] }
}
const human = { role: 'user', content: [{ type: 'text' as const, text: 'question' }] }

function assertRequestHistory(events: readonly SessionEvent[], handle: SessionHandle) {
  const requests = events.filter(event => event.type === 'request/header')
  expect(requests).toHaveLength(3)
  const projected = requests.map((event) => {
    expect(event.data.header).toEqual({ config })
    const prefix = Session.fromRestore(id, events.slice(0, event.seq + 1), handle.header, SessionLogOffset(0), 'shared-frozen')
    return messages(prefix)
  })
  expect(projected).toEqual([[prompt('initial'), human], [prompt('changed'), human], [human]])
}

describe('V2 system prompts through current Session and JSONL persistence', () => {

  it('persists native V4 system appends after the protected head without converting them to user messages', async () => {
    const ctx = await mount()
    const session = Session.create(id)
    const writer = await ctx.sessionPersistence.create(session.header)
    try {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('system/message', {
        turn: 1, step: 1,
        message: freezeMessage({ role: 'system', id: MessageId('head'), content: [{ type: 'text', text: 'head prompt' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }),
      }, { surfaceOp: 'append' })
      session.append('user/message', freezeMessage({ role: 'user', id: MessageId('question'), content: human.content, source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('system/message', {
        turn: 1, step: 1,
        message: freezeMessage({ role: 'system', id: MessageId('context'), content: [{ type: 'text', text: 'tail context' }], source: { kind: 'plugin', plugin: 'context-plugin' } }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await writer.append(session.snapshotEvents())
      await writer.flush()
    } finally {
      await writer.close()
    }
    const reopened = await mount()
    const reader = await reopened.sessionPersistence.open(id, 'read')
    try {
      expect((await reader.read()).events).toEqual(session.snapshotEvents())
      const restored = await restore(reader)
      expect(restored.surface.nodes).toEqual([2, 3, 4])
      expect(messages(restored)).toEqual([prompt('head prompt'), human, prompt('tail context')])
      expect(restored.deriveMessages().map(message => message.id)).toEqual(['head', 'question', 'context'])
    } finally {
      await reader.close()
    }
  })
})
