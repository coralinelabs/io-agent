/** Host lifecycle guarantees: search shows only visible text, deletes are fenced and complete, sessions idle out, summaries persist. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { HostEvent, HostFileChange } from "../../../src/library/host/index.ts"
import { SEQ_BLOCK } from "../../../src/library/host/index.ts"
import { stream, tool } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}
const reply = (text: string) => (_request: unknown, response: Parameters<typeof stream>[0]) => { stream(response, [{ content: text }]) }

describe('host lifecycle', () => {
  it('never matches the hidden context block in search', async () => {
    const f = await hostFixture(reply('It is a phrase.'), { recall: { fullText: true } })
    const hidden = await f.host.createSession('hidden-context')
    await run(f.host, { ...turn(hidden, 'Explain the selection.'), context: 'Selected text: quixotic zebra lemma' })
    expect(JSON.stringify(f.requests[0]!.messages)).toContain('quixotic zebra lemma')
    expect(await f.host.search('zebra')).toEqual([])
    const [hit] = await f.host.search('selection')
    expect(hit).toMatchObject({ session_id: hidden })
    expect(hit!.excerpt).toContain('Explain the selection.')
    const history = await f.host.history(hidden)
    expect(history.events.some(event => event.seq <= hit!.seq && event.seq > hit!.seq - SEQ_BLOCK && event.type === 'turn')).toBe(true)
  }, 30000)

  it('answers a retried turn after a restart with a cursor whose events are history, and a racing retry after admission', async () => {
    const f = await hostFixture(reply('Done.'))
    const id = await f.host.createSession('retried-turn')
    const body = turn(id, 'Do the thing.')
    const { receipt } = await run(f.host, body)
    await f.host.close()
    const replacement = await f.open()
    const retry = await replacement.submit(body)
    expect(retry).toMatchObject({ duplicate: true, turn_id: body.turn_id })
    expect(retry.after).toBeLessThanOrEqual(receipt.after)
    // The turn's events are no longer retained live; the cursor says so instead of waiting for new ones.
    expect(() => replacement.readSession(id, retry.after)).toThrow(expect.objectContaining({ code: 'REPLAY_GAP' }))
    expect((await replacement.history(id)).events.filter(event => event.seq > retry.after).map(event => event.type))
      .toEqual(['turn', 'message', 'usage', 'end'])
  }, 30000)

  it('answers a retry that races admission only after admission settles', async () => {
    const f = await hostFixture(reply('Seen.'), { model: { input: ['text', 'image'] } })
    const attachments = f.context().attachments
    const admit = attachments.admitPromptContent.bind(attachments)
    const gates: PromiseWithResolvers<void>[] = []
    attachments.admitPromptContent = async (parts) => {
      const gate = Promise.withResolvers<void>()
      gates.push(gate)
      await gate.promise
      return admit(parts)
    }
    const png = (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer()).toString('base64')
    const id = await f.host.createSession('racing-retry')
    const body = { session_id: id, turn_id: 'image-turn-01', prompt: [{ type: 'text', text: 'Look.' }, { type: 'image', media_type: 'image/png', data: png }] }
    const first = f.host.submit(body)
    await expect.poll(() => gates.length).toBe(1)
    let answered = false
    const second = f.host.submit(body).finally(() => { answered = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(answered).toBe(false)
    gates[0]!.reject(new Error('attachment store unavailable'))
    await expect(first).rejects.toThrow('attachment store unavailable')
    // The first admission failed, so the retry is admitted itself.
    await expect.poll(() => gates.length).toBe(2)
    gates[1]!.resolve()
    const admitted = await second
    expect(admitted).toMatchObject({ duplicate: false, turn_id: 'image-turn-01' })
    await f.host.settled(id, admitted.activity_id!)
    const third = f.host.submit(body)
    expect(await third).toMatchObject({ duplicate: true, after: admitted.after, activity_id: admitted.activity_id })
  }, 30000)

  it('fences a delete against a concurrent resume and deletes all past a failure', async () => {
    const f = await hostFixture(reply('Stored.'))
    const persisted = async () => (await f.context().sessionPersistence.list()).map(row => String(row.header.id)).sort()
    const raced = await f.host.createSession('raced-session')
    await run(f.host, turn(raced, 'Store it.'))
    await f.host.closeSession(raced)
    const [deleted, resumed] = await Promise.allSettled([f.host.deleteSession(raced), f.host.resumeSession(raced)])
    expect(deleted.status).toBe('fulfilled')
    expect(resumed).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_BUSY' } })
    expect(await persisted()).toEqual([])
    const kept = await f.host.createSession('admitting-session')
    const gone = await f.host.createSession('deletable')
    await run(f.host, turn(gone, 'Delete it.', 'turn-deletable-1'))
    // A submission held in admission owns its session's operation, so deleting that one fails.
    const attachments = f.context().attachments
    const gate = Promise.withResolvers<void>()
    const admit = attachments.admitPromptContent.bind(attachments)
    attachments.admitPromptContent = async (parts) => { await gate.promise; return admit(parts) }
    const admitting = f.host.submit({ session_id: kept, turn_id: 'held-turn-01', prompt: [{ type: 'text', text: 'Held.' }] })
    const result = await f.host.deleteAllSessions()
    expect(result.deleted).toEqual([gone])
    expect(result.failed).toEqual([{ session_id: kept, error: expect.objectContaining({ code: 'SESSION_BUSY' }) }])
    gate.resolve()
    await f.host.settled(kept, (await admitting).activity_id!)
    expect(await persisted()).toEqual([kept])
  }, 30000)

  it('leaves no conversation text, image or index row of a deleted session behind', async () => {
    const f = await hostFixture((request, response) => {
      stream(response, [{ content: JSON.stringify(request.messages).includes('zqxwvyk') ? 'The zqxwvyk swatch is green.' : 'Noted.' }])
    }, { recall: { fullText: true }, model: { input: ['text', 'image'] } })
    const png = (await sharp({ create: { width: 3, height: 3, channels: 3, background: '#00aa00' } }).png().toBuffer()).toString('base64')
    const doomed = await f.host.createSession('private-session')
    await run(f.host, { session_id: doomed, turn_id: 'private-turn-1',
      prompt: [{ type: 'text', text: 'Describe zqxwvyk.' }, { type: 'image', media_type: 'image/png', data: png }] })
    const kept = await f.host.createSession('kept-session')
    await run(f.host, turn(kept, 'Something unrelated.'))
    // Closed sessions are indexed on disk.
    await f.host.closeSession(doomed)
    expect(await f.host.search('zqxwvyk')).toHaveLength(1)
    const stored = async () => [...await files(join(f.stateDirectory, 'attachments')), ...await files(join(f.stateDirectory, 'cache', 'attachments'))]
    expect(await stored()).not.toEqual([])
    const index = join(f.stateDirectory, 'session-index.sqlite')
    const indexBytes = async () => Buffer.concat(await Promise.all([index, `${index}-wal`].map(path => readFile(path).catch(() => Buffer.alloc(0)))))
    expect((await indexBytes()).includes('zqxwvyk')).toBe(true)
    await f.host.deleteSession(doomed)
    expect(await stored()).toEqual([])
    expect((await indexBytes()).includes('zqxwvyk')).toBe(false)
    expect(await f.host.search('zqxwvyk')).toEqual([])
    expect((await f.host.listSessions()).map(row => row.id)).toEqual([kept])
    expect(JSON.stringify(await Promise.all((await files(f.stateDirectory)).map(path => readFile(path, 'latin1'))))).not.toContain('zqxwvyk')
  }, 30000)

  it('releases an idle unwatched session and keeps cursors from before the release meaningful', async () => {
    const f = await hostFixture(reply('Idle soon.'), {}, { idleReleaseMs: 100 })
    const id = await f.host.createSession('idle-session')
    await run(f.host, turn(id, 'First.'))
    const seen = f.host.readSession(id).last_seq
    await expect.poll(() => f.host.owns(id), { timeout: 5000 }).toBe(false)
    await f.host.resumeSession(id)
    expect(f.host.readSession(id, seen).events).toEqual([])
    const abort = new AbortController()
    const events: HostEvent[] = []
    const watching = (async () => { for await (const event of f.host.watchSession(id, seen, abort.signal)) events.push(event) })().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(f.host.owns(id)).toBe(true)
    const second = await f.host.submit(turn(id, 'Second.', 'second-turn-01'))
    await f.host.settled(id, second.activity_id!)
    await expect.poll(() => events.some(event => event.type === 'activity' && event.state === 'settled')).toBe(true)
    expect(events.map(event => event.type).filter(type => type !== 'text' && type !== 'reasoning'))
      .toEqual(['activity', 'turn', 'message', 'usage', 'end', 'activity'])
    abort.abort()
    await watching
    await expect.poll(() => f.host.owns(id), { timeout: 5000 }).toBe(false)
    await f.host.resumeSession(id)
    const last = events.at(-1)!.seq
    expect(f.host.readSession(id, last).events).toEqual([])
    // A live cursor in the current journal block that this opening has not reached came from a lost opening: read history.
    const reached = f.host.readSession(id).last_seq
    expect(reached).toBeGreaterThanOrEqual(last)
    expect(() => f.host.readSession(id, reached + 1)).toThrow(expect.objectContaining({ code: 'REPLAY_GAP' }))
    expect(() => f.host.readSession(id, reached + SEQ_BLOCK)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }))
  }, 30000)

  it('keeps an idle session open while its background job runs, and releases it once the job settled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-idle-job-'))
    const sentinel = join(dir, 'release')
    let calls = 0
    const f = await hostFixture((_request, response) => {
      calls += 1
      if (calls === 1) tool(response, 'bash', { command: `while [ ! -f ${JSON.stringify(sentinel)} ]; do sleep 0.02; done; echo released`,
        description: 'Wait for the release', run_in_background: true })
      else stream(response, [{ content: calls === 2 ? 'Started.' : 'It finished.' }])
    }, { sandbox: 'danger-full-access' }, { idleReleaseMs: 100 })
    try {
      const id = await f.host.createSession('idle-with-job')
      await run(f.host, turn(id, 'Start it.'))
      // Released, the session would take its job down with it, and the wake it owes the agent.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(f.host.owns(id)).toBe(true)
      expect(calls).toBe(2)
      await writeFile(sentinel, '')
      await expect.poll(() => calls, { timeout: 5000 }).toBe(3)
      const history = await f.host.history(id)
      expect(history.events.some(event => event.type === 'tool_end')).toBe(true)
      await expect.poll(() => f.host.owns(id), { timeout: 5000 }).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('lists unchanged closed sessions after a restart without reading their journals', async () => {
    const f = await hostFixture((request, response) => { stream(response, [{ content: `Reply ${String(request.messages.length)}.` }]) })
    const a = await f.host.createSession('summary-a')
    const b = await f.host.createSession('summary-b')
    await run(f.host, turn(a, 'Alpha question.'))
    await run(f.host, turn(b, 'Beta question.'))
    const before = await f.host.listSessions()
    await f.host.close()
    const replacement = await f.open()
    const observe = vi.spyOn(f.context().sessionQuery, 'observeSession')
    expect(await replacement.listSessions()).toEqual(before)
    expect(observe).not.toHaveBeenCalled()
    await replacement.resumeSession(a)
    observe.mockClear()
    await run(replacement, turn(a, 'Alpha follow-up.', 'alpha-turn-2'))
    const [latest] = await replacement.listSessions()
    expect(latest).toMatchObject({ id: a, preview: expect.stringMatching(/^Reply \d+\.$/) })
    expect(latest!.updated_at).toBeGreaterThanOrEqual(before.find(row => row.id === a)!.updated_at)
    expect(observe).not.toHaveBeenCalled()
  }, 30000)

  it('reports a file change no session makes without a session id', async () => {
    const seen: HostFileChange[] = []
    const f = await hostFixture(reply('Unused.'), {}, { onFileChange: (change) => { seen.push(change) } })
    const target = await f.context().fs.resolve(join(f.workspace, 'outside.txt'), { cwd: f.workspace })
    await f.context().serial('fs/before-change', target, undefined)
    expect(seen).toEqual([{ change_id: expect.any(String), call_id: '', tool: '', paths: [f.context().fs.processPath(target)] }])
  }, 30000)
})
