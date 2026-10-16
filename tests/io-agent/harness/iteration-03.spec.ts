/** Actual local HTTP/SSE integration; no claims of live-model task quality. */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import type { ModelRequestSnapshot } from "../../../src/index.ts"
import { fixture, stream, tool } from './fixture.ts'

const verdict = (status = 'passed') => JSON.stringify({ status, summary: 'Reviewed the recorded evidence.', findings: [] })
const systems = (messages: { role: string; content: unknown }[]) => JSON.stringify(messages.filter(m => m.role === 'system'))

describe('inspectable requests across the complete headless runtime', () => {
  it('awaits a detached observer, includes tool schemas, and exposes metadata-only receipts', async () => {
    let observed: ModelRequestSnapshot | undefined
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>((r) => { release = r }), ready = new Promise<void>((r) => { reached = r })
    // Memory writes are advertised only where they can be granted, so this runtime allows them.
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), {
      memory: { writePolicy: 'allow' },
      onModelRequest: async (snapshot) => { observed = snapshot; reached(); await gate },
    })
    const session = await app.createSession(), running = session.run('Inspect the assembled request.')
    await ready
    expect(requests).toHaveLength(0)
    expect(observed!.tools.some(t => t.name === 'memory')).toBe(true)
    expect(Object.isFrozen(observed!.messages)).toBe(true)
    expect(() => { (observed!.messages as unknown[]).push('wrong') }).toThrow()
    release(); await running
    const receipts = session.requests()
    expect(receipts).toHaveLength(1); expect(receipts[0]!.id).toBe(observed!.id)
    expect(receipts[0]).not.toHaveProperty('messages'); expect(Object.isFrozen(receipts[0])).toBe(true)
  }, 30000)
  it('does not send inference after a vetoing model observer', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Should not run.' }]), {
      onModelRequest: () => { throw new Error('audit-veto') },
    })
    const result = await (await app.createSession()).run('Vetoed.')
    expect(result.stopReason?.kind).toBe('error'); expect(requests).toHaveLength(0)
  }, 30000)
  it('cancels while an observer is noncooperative without sending a model request', async () => {
    let reached!: () => void
    const ready = new Promise<void>((r) => { reached = r })
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'No.' }]), {
      onModelRequest: async () => { reached(); await new Promise(() => {}) },
    })
    const session = await app.createSession(), controller = new AbortController()
    const pending = session.run('Cancel in audit.', { signal: controller.signal })
    await ready; controller.abort(); const result = await pending
    expect(result.stopReason?.kind).toBe('aborted'); expect(requests).toHaveLength(0)
  }, 30000)
  it('observes primary, child, and compaction calls with the same context revision', async () => {
    const seen: ModelRequestSnapshot[] = []
    const { app } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'subagent', { description: 'Inspect', prompt: 'Inspect this task.', run_in_background: false })
      : stream(res, [{ content: i < 4 ? 'Evidence '.repeat(700) : '## Current Work\nRetain restrictions and pending work.' }]), { onModelRequest: (s) => { seen.push(s) } })
    const session = await app.createSession(); await session.run('Delegate this inspection. ' + 'detail '.repeat(300))
    await session.run('Continue ' + 'context '.repeat(300)); await session.compact()
    expect(new Set(seen.map(s => s.sessionId)).size).toBeGreaterThan(1)
    expect(seen.some(s => s.purpose === 'compaction')).toBe(true)
    expect(new Set(seen.map(s => s.modelContextRevision)).size).toBe(1)
  }, 30000)
})

describe('durable curated project memory', () => {
  it('is available by default but fails closed when the host answers nothing', async () => {
    const { app, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'memory', { action: 'put', key: 'build', value: 'pnpm test', revision: 0 })
      : i === 1 ? tool(res, 'memory', { action: 'list' }, 'list') : stream(res, [{ content: 'Denied.' }]),
    { approval: 'ask', onApproval: () => Promise.resolve('unavailable') })
    const result = await (await app.createSession()).run('Store a project note.')
    expect(requests[0]!.tools!.some(t => t.function.name === 'memory')).toBe(true)
    const results = result.events.filter(e => e.type === 'tool/result').map(e => e.data.message)
    expect(results.map(r => r.isError === true)).toEqual([true, false])
    expect(result.events.filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).toEqual(['unavailable'])
    const listed = JSON.stringify(results[1])
    expect(listed).toContain('\\"revision\\":0')
    expect(listed).not.toContain('pnpm test')
  }, 30000)
  it('is read-only without an approval answerer, since no write could be granted', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Nothing to store.' }]), { approval: 'ask' })
    await (await app.createSession()).run('Store a project note.')
    expect(requests[0]!.tools!.some(t => t.function.name === 'memory')).toBe(false)
  }, 30000)
  it('asks the embedding host before committing a note', async () => {
    let asks = 0
    const { app } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'memory', { action: 'put', key: 'build', value: 'pnpm test', revision: 0 }) : stream(res, [{ content: 'Stored.' }]), {
      approval: 'ask', onApproval: async (r) => { expect(r.toolName).toBe('memory'); asks++; return 'allowed-once' },
    })
    const result = await (await app.createSession()).run('Remember the build command.')
    expect(asks).toBe(1); expect(result.events.filter(e => e.type === 'tool/result').every(e => e.data.message.isError !== true)).toBe(true)
  }, 30000)
  it('keeps the current-session snapshot stable, persists state, and refreshes on a new session', async () => {
    const note = 'MEMORY_NEW_SESSION_ONLY_389'
    const { app, requests, workspace, stateDirectory, baseURL } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'memory', { action: 'put', key: 'build', value: note, revision: 0 }) : stream(res, [{ content: 'Done.' }]), { memory: { writePolicy: 'allow' } })
    const old = await app.createSession({ id: 'memory-old' }); await old.run('Store a useful note.')
    expect(systems(requests[0]!.messages)).not.toContain(note)
    expect(systems(requests[1]!.messages)).not.toContain(note)
    const fresh = await app.createSession({ id: 'memory-new' }); await fresh.run('Use the new snapshot.')
    expect(systems(requests[2]!.messages)).toContain(note)
    await app.close()
    const reopened = await createIoAgent({ workspace, stateDirectory, model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 }, sandbox: 'danger-full-access' })
    try {
      const resumed = await reopened.resumeSession('memory-old'); await resumed.run('Resume original snapshot.')
      expect(systems(requests.at(-1)!.messages)).not.toContain(note)
      const newest = await reopened.createSession(); await newest.run('New after restart.')
      expect(systems(requests.at(-1)!.messages)).toContain(note)
    } finally { await reopened.close() }
  }, 30000)
  it('rejects a stale revision rather than overwriting a later note', async () => {
    const { app, requests } = await fixture((_q, res, i) => i < 2
      ? tool(res, 'memory', { action: 'put', key: 'build', value: i === 0 ? 'FIRST' : 'STALE', revision: 0 }, 'm' + i)
      : i === 2 ? tool(res, 'memory', { action: 'list' }, 'list') : stream(res, [{ content: 'Conflict retained.' }]), { memory: { writePolicy: 'allow' } })
    const result = await (await app.createSession()).run('Test revisions.')
    const outputs = result.events.filter(e => e.type === 'tool/result')
    expect(outputs.map(e => e.data.message.isError === true)).toEqual([false, true, false])
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('FIRST')
  }, 30000)
  it('denies child memory mutations even with autonomous parent writes enabled', async () => {
    const { app, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'subagent', { description: 'Inspect', prompt: 'Inspect and suggest a note.', run_in_background: false })
      : i === 1 ? tool(res, 'memory', { action: 'put', key: 'child', value: 'unapproved', revision: 0 })
        : stream(res, [{ content: 'No note committed.' }]), { memory: { writePolicy: 'allow' } })
    await (await app.createSession()).run('Delegate inspection.')
    expect(JSON.stringify(requests[2]!.messages)).toMatch(/child|subagent/i)
    expect(JSON.stringify(requests[2]!.messages)).toContain('cannot')
  }, 30000)
  it('can remove memory entirely without losing coding tools', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), { memory: false })
    await (await app.createSession()).run('No persistent memory.')
    expect(requests[0]!.tools!.some(t => t.function.name === 'memory')).toBe(false)
    expect(requests[0]!.tools!.some(t => t.function.name === 'edit')).toBe(true)
  }, 30000)
})

describe('read-only completion verification', () => {
  it('reviews the current evidence using no tools without changing the transcript or completion state', async () => {
    const seen: ModelRequestSnapshot[] = []
    const { app, requests } = await fixture((_q, res, i) => stream(res, [{ content: i === 0 ? 'Work completed.' : verdict() }]), { onModelRequest: (s) => { seen.push(s) } })
    const session = await app.createSession(); await session.run('Complete a task.')
    const before = await session.events(); const result = await session.verify()
    expect(result.status).toBe('passed'); expect(result.throughSeq).toBe(before.length)
    expect(await session.events()).toEqual(before)
    expect(requests.at(-1)!.tools ?? []).toHaveLength(0)
    expect(seen.at(-1)!.purpose).toBe('verification'); expect(seen.at(-1)!.maxTokens).toBe(2048)
    expect(session.requests().at(-1)!.purpose).toBe('verification')
  }, 30000)
  it.each(['not json', 'empty', 'truncated', 'tool', 'transport'])('never calls %s a successful verification', async (mode) => {
    const { app, workspace } = await fixture((_q, res, i) => {
      if (i === 0) return stream(res, [{ content: 'Work completed.' }])
      if (mode === 'transport') { res.writeHead(401); res.end('Unauthorized'); return }
      if (mode === 'tool') return tool(res, 'write', { file_path: 'should-not-exist', content: 'no' })
      stream(res, [{ content: mode === 'not json' ? mode : mode === 'empty' ? ' ' : verdict() }], mode === 'truncated' ? 'length' : 'stop')
    })
    const session = await app.createSession(); await session.run('Task.')
    expect((await session.verify()).status).toBe('unknown')
    await expect(readFile(join(workspace, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)
  it('propagates cancellation instead of converting it to a verdict', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]))
    const session = await app.createSession(), controller = new AbortController(); controller.abort()
    await expect(session.verify({ signal: controller.signal })).rejects.toThrow()
    expect(requests).toHaveLength(0)
  }, 30000)
})

describe('compaction request-size recovery over real HTTP', () => {
  it('reduces only the auxiliary payload, records the adjustment, and preserves original evidence', async () => {
    const { defineContentToolFixture } = await import("../../../src/library/tools/index.ts")
    const evidence = 'ORIGINAL_EVIDENCE_' + 'x'.repeat(15000)
    let summaryAttempts = 0, modelCalls = 0
    const summaries: ModelRequestSnapshot[] = []
    const { app, requests } = await fixture((req, res) => {
      if (JSON.stringify(req.messages.at(-1)?.content).includes('compaction engine')) {
        if (++summaryAttempts === 1) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'request entity too large', type: 'invalid_request_error', code: 'payload_too_large' } })); return }
        return stream(res, [{ content: '## Current Work\nKeep the current request and recorded verification evidence.' }])
      }
      const i = modelCalls++
      if (i < 4) return tool(res, 'evidence_probe', { round: i }, `evidence-${i}`)
      stream(res, [{ content: 'Completed inspection. ' + 'tail '.repeat(600) }])
    }, {
      onModelRequest: (s) => { if (s.purpose === 'compaction') summaries.push(s) },
      configure: (ctx) => { ctx.tools.register(defineContentToolFixture({ name: 'evidence_probe', description: 'Return fixture evidence', parameters: { round: { type: 'number' } }, async execute() { return [{ type: 'text', text: evidence }] } })) },
    })
    const session = await app.createSession({ id: 'payload-recovery' })
    await session.run('Inspect several distinct steps and retain their evidence.')
    await session.run('Retain the active task while preparing a checkpoint. ' + 'recent '.repeat(1200))
    const result = await session.compact()
    expect(result).not.toBeNull(); expect(summaryAttempts).toBe(2)
    expect(summaries).toHaveLength(2); expect(summaries[1]!.contextBytes).toBeLessThan(summaries[0]!.contextBytes)
    expect(summaries[1]!.messages.slice(0, -1).map(m => m.id)).toEqual(summaries[0]!.messages.slice(0, -1).map(m => m.id))
    expect(summaries[1]!.messages.at(-1)!.content).toEqual(summaries[0]!.messages.at(-1)!.content)
    const records = (await session.events()).filter(e => e.type === 'pluto/compaction-recovery')
    expect(records).toHaveLength(1); expect(records[0]!.data.bytesAfter).toBeLessThan(records[0]!.data.bytesBefore)
    expect(JSON.stringify(await session.events())).toContain(evidence)
    const beforeRequests = requests.length
    await session.close()
    const resumed = await app.resumeSession('payload-recovery')
    expect((await resumed.events()).some(e => e.type === 'pluto/compaction-recovery')).toBe(true)
    expect(requests).toHaveLength(beforeRequests)
  }, 30000)
})

describe('memory ownership and concurrent writers', () => {
  it('commits one of two stale concurrent mutations, never silently loses an update', async () => {
    const { app } = await fixture((req, res) => req.messages.some(m => m.role === 'tool')
      ? stream(res, [{ content: 'Result observed.' }])
      : tool(res, 'memory', { action: 'put', key: 'shared', value: JSON.stringify(req.messages.at(-1)!.content), revision: 0 }), { memory: { writePolicy: 'allow' } })
    const a = await app.createSession(), b = await app.createSession()
    const results = await Promise.all([a.run('FIRST'), b.run('SECOND')])
    const outputs = results.flatMap(r => r.events.filter(e => e.type === 'tool/result'))
    expect(outputs).toHaveLength(2)
    expect(outputs.filter(e => e.data.message.isError === true)).toHaveLength(1)
    expect(outputs.filter(e => e.data.message.isError !== true)).toHaveLength(1)
  }, 30000)
  it('rejects a second live owner without damaging the first owner or its lease', async () => {
    const { app, workspace, stateDirectory, baseURL } = await fixture((_q, res) => stream(res, [{ content: 'Still alive.' }]))
    await expect(createIoAgent({ workspace, stateDirectory, model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 } })).rejects.toThrow()
    expect((await (await app.createSession()).run('Continue.')).text).toBe('Still alive.')
  }, 30000)
})

describe('review ownership stays subordinate to human input', () => {
  it('does not apply an old passing verdict to a newly steered request', async () => {
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>((r) => { release = r }), ready = new Promise<void>((r) => { reached = r })
    const { app } = await fixture(async (_q, res, i) => {
      if (i === 1) { reached(); await gate; stream(res, [{ content: verdict() }]); return }
      stream(res, [{ content: 'Task result.' }])
    })
    const session = await app.createSession(); await session.run('Original request.')
    const pending = session.verify(); await ready
    session.steer('A new requirement replaces the old task.')
    release()
    const result = await pending
    expect(result.status).toBe('unknown'); expect(result.summary).toContain('changed')
    await session.whenIdle()
  }, 30000)
  it('cancels a review when its owning session closes', async () => {
    let reached!: () => void
    const ready = new Promise<void>((r) => { reached = r })
    const { app } = await fixture((_q, res, i) => {
      if (i === 0) { stream(res, [{ content: 'Done.' }]); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); reached()
    })
    const session = await app.createSession(); await session.run('A task.')
    const pending = session.verify().then(() => 'incorrectly-completed', () => 'cancelled')
    await ready; await session.close()
    expect(await pending).toBe('cancelled')
  }, 30000)
})
