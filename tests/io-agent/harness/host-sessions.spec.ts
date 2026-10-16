/** Session management for a chat list: summaries, rename, delete and full-text search. */
import { describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SEQ_BLOCK } from "../../../src/library/host/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import { stream, tool } from './fixture.ts'
import { hostFixture, pending, run, turn } from './host-fixture.ts'
import { sandboxUsable } from '../../support/sandbox-usable.ts'

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.map(entry => join(entry.parentPath, entry.name))
}

describe('host sessions', () => {
  it('summarizes root sessions with title, times, preview and live status', async () => {
    const hold = Promise.withResolvers<undefined>()
    const f = await hostFixture(async (request, response) => {
      const text = JSON.stringify(request.messages)
      if (text.includes('Plan the garden layout')) stream(response, [{ content: 'Start with   the raised\nbeds.' }])
      else if (text.includes('Ask me something')) tool(response, 'ask_user_question', { questions: [{ id: 'q', question: 'Which bed?', options: [{ label: 'north' }] }] })
      else { await hold.promise; stream(response, [{ content: 'Slow reply.' }]) }
    })
    const garden = await f.host.createSession('garden-session')
    const empty = await f.host.createSession('empty-session')
    await run(f.host, turn(garden, 'Plan the garden layout for spring.'))
    let summaries = await f.host.listSessions()
    expect(summaries.map(row => row.id)).toEqual([garden, empty])
    const row = summaries[0]!
    expect(row).toMatchObject({ id: garden, title: 'Plan the garden layout for', preview: 'Start with the raised beds.', status: 'idle' })
    expect(row.updated_at).toBeGreaterThanOrEqual(row.created_at)
    expect(summaries[1]).toMatchObject({ id: empty, title: null, preview: '', status: 'idle' })
    const slow = await f.host.createSession('slow-session')
    const receipt = await f.host.submit(turn(slow, 'Take your time.'))
    await expect.poll(async () => (await f.host.listSessions()).find(entry => entry.id === slow)?.status).toBe('working')
    hold.resolve(undefined)
    await f.host.settled(slow, receipt.activity_id!)
    const asking = await f.host.createSession('asking-session')
    await f.host.submit(turn(asking, 'Ask me something.'))
    await pending(f.host, asking, 'question')
    summaries = await f.host.listSessions()
    expect(summaries.find(entry => entry.id === asking)?.status).toBe('needs_you')
    expect(summaries[0]?.id).toBe(asking)
    await f.host.cancel(asking)
  }, 30000)

  it('renames with a pinned user title that survives restart and later turns', async () => {
    const f = await hostFixture((_request, response) => { stream(response, [{ content: 'Noted.' }]) })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'First prompt names the chat.'))
    expect(await f.host.renameSession(id, '  Garden   plans ')).toBe('Garden plans')
    await expect(f.host.renameSession(id, '   ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await run(f.host, turn(id, 'Another prompt must not rename it.', 'second-turn-01'))
    await f.host.close()
    const reopened = await f.open()
    expect((await reopened.listSessions())[0]).toMatchObject({ id, title: 'Garden plans' })
    expect(await reopened.renameSession(id, 'Closed sessions rename too')).toBe('Closed sessions rename too')
    expect((await reopened.listSessions())[0]?.title).toBe('Closed sessions rename too')
  }, 30000)

  // its bash runs confined: it needs a confinement backend
  it.skipIf(!sandboxUsable)('deletes a working session with its delegated child, and deletes all', async () => {
    let childId: string | undefined
    const stalled = Promise.withResolvers<undefined>()
    const f = await hostFixture((request, response, index) => {
      const text = JSON.stringify(request.messages)
      if (text.includes('Delegate first')) {
        if (index === 0) tool(response, 'subagent', { description: 'Inspect', prompt: 'Report back.', run_in_background: false }, 'child')
        else if (index === 2) tool(response, 'bash', { command: "head -c 60000 /dev/zero | tr '\\0' a", description: 'Print a large output' }, 'large')
        else stream(response, [{ content: 'Done.' }])
      } else if (text.includes('Keep working')) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); stalled.resolve(undefined) }
      else stream(response, [{ content: 'Kept.' }])
    }, { configure: (context) => {
      context.on('agent/created', ({ agent }) => { if (agent.session.header.parentSession !== undefined) childId = String(agent.id) })
    } })
    const parent = await f.host.createSession('parent-session')
    await run(f.host, turn(parent, 'Delegate first.'))
    expect(childId).toBeDefined()
    const working = await f.host.createSession('working-session')
    const kept = await f.host.createSession('kept-session')
    await run(f.host, turn(kept, 'Keep this one.'))
    const receipt = await f.host.submit(turn(working, 'Keep working until deleted.'))
    await stalled.promise
    const persisted = async () => (await f.context().sessionPersistence.list()).map(row => String(row.header.id)).sort()
    expect(await persisted()).toEqual([childId!, kept, parent, working].sort())
    const spilled = async () => (await files(join(f.stateDirectory, 'spill'))).filter(path => /session-[0-9a-f]+\/./.test(path))
    expect(await spilled()).not.toEqual([])
    await f.host.deleteSession(working)
    expect(receipt.activity_id).toBeDefined()
    await f.host.deleteSession(parent)
    expect(await persisted()).toEqual([kept])
    expect((await files(f.stateDirectory)).filter(path => path.includes(parent) || path.includes(working) || path.includes(childId!))).toEqual([])
    expect(await spilled()).toEqual([])
    expect((await f.host.listSessions()).map(row => row.id)).toEqual([kept])
    await expect(f.host.history(parent)).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    await expect(f.host.resumeSession(working)).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    await expect(f.host.deleteSession(parent)).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    expect(() => f.host.readSession(working)).toThrow(expect.objectContaining({ code: 'UNKNOWN_SESSION' }))
    await f.host.createSession('another-session')
    const all = await f.host.deleteAllSessions()
    expect({ deleted: [...all.deleted].sort(), failed: all.failed }).toEqual({ deleted: ['another-session', kept], failed: [] })
    expect(await f.host.listSessions()).toEqual([])
    expect(await persisted()).toEqual([])
  }, 30000)

  it('searches user inputs and replies over the full-text index and forgets deleted sessions', async () => {
    const f = await hostFixture((request, response) => {
      const text = JSON.stringify(request.messages)
      stream(response, [{ content: text.includes('zucchini') ? 'Zucchini needs full sun.' : 'Tomatoes need stakes.' }])
    }, { recall: { fullText: true } })
    const squash = await f.host.createSession('squash-session')
    const tomato = await f.host.createSession('tomato-session')
    await run(f.host, turn(squash, 'Where should the zucchini go?'))
    await run(f.host, turn(tomato, 'How do I support tomatoes?'))
    const hits = await f.host.search('zucchini')
    expect(hits.map(hit => hit.session_id)).toEqual([squash])
    const hit = hits[0]!
    expect(hit.excerpt.toLowerCase()).toContain('zucchini')
    const history = await f.host.history(squash)
    const matched = history.events.filter(event => event.seq <= hit.seq && event.seq > hit.seq - SEQ_BLOCK)
    expect(matched.some(event => (event.type === 'turn' && event.input.text.includes('zucchini'))
      || (event.type === 'message' && event.text.includes('Zucchini')))).toBe(true)
    expect((await f.host.search('stakes')).map(row => row.session_id)).toEqual([tomato])
    await expect(f.host.search('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await f.host.deleteSession(squash)
    expect(await f.host.search('zucchini')).toEqual([])
  }, 30000)

  it('refuses search without the full-text index', async () => {
    const f = await hostFixture((_request, response) => { stream(response, [{ content: 'Plain.' }]) })
    await expect(f.host.search('anything')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  }, 30000)

  it('deletes stored sessions together, and none of them while a writer owns any', async () => {
    const f = await hostFixture((_request, response) => { stream(response, [{ content: 'Stored.' }]) })
    const id = await f.host.createSession('stored-session')
    const other = await f.host.createSession('other-session')
    await run(f.host, turn(id, 'Store something.'))
    await run(f.host, turn(other, 'Store something else.', 'other-turn-01'))
    await f.host.closeSession(other)
    const persistence = f.context().sessionPersistence
    await expect(persistence.delete([SessionId(other), SessionId(id)])).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    expect(await persistence.stat(SessionId(other))).toBeDefined()
    await f.host.closeSession(id)
    expect(await persistence.delete([SessionId(id), SessionId(other), SessionId('never-stored')])).toEqual([id, other])
    expect(await persistence.delete([SessionId(id)])).toEqual([])
    expect(await persistence.stat(SessionId(id))).toBeUndefined()
    expect(await persistence.stat(SessionId(other))).toBeUndefined()
  }, 30000)
})
