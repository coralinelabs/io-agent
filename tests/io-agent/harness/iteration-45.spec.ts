/** Regressions that exercise the real HTTP boundary, tools, persistence and disposal. */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import { createIoAgent } from "../../../src/index.ts"
import { fixture, stream, tool } from './fixture.ts'

const results = (events: readonly import("../../../src/library/session/journal/index.ts").SessionEvent[]) => events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError === true)

describe('guidance before mutation', () => {
  it('blocks both same-step writes, delivers nested guidance, and permits the informed retry', async () => {
    let workspace = ''
    const f = await fixture(async (q, res, i) => {
      if (i === 0) {
        expect(JSON.stringify(q.messages)).not.toContain('NESTED_RULE_45')
        stream(res, [{ tool_calls: [0, 1].map(n => ({ index: n, id: 'first-' + n, type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ file_path: `nested/file${n}.txt`, content: 'uninformed' }),
        } })) }], 'tool_calls')
      } else if (i === 1) {
        expect(JSON.stringify(q.messages)).toContain('NESTED_RULE_45')
        await expect(readFile(join(workspace, 'nested/file0.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(join(workspace, 'nested/file1.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        tool(res, 'write', { file_path: 'nested/file0.txt', content: 'informed' }, 'retry')
      } else stream(res, [{ content: 'Done.' }])
    })
    workspace = f.workspace
    await mkdir(join(workspace, '.git'))
    await mkdir(join(workspace, 'nested'))
    await writeFile(join(workspace, 'nested/AGENTS.md'), 'NESTED_RULE_45: write informed content.\n')
    const run = await (await f.app.createSession()).run('Write the nested files.')
    expect(results(run.events)).toEqual([true, true, false])
    expect(await readFile(join(workspace, 'nested/file0.txt'), 'utf8')).toBe('informed')
    expect(f.requests).toHaveLength(3)
  }, 30000)

  it('keeps a bypassing allow-listener from skipping instruction preparation', async () => {
    const { app, workspace } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'write', { file_path: 'no-bypass.txt', content: 'no' }) : stream(res, [{ content: 'Denied.' }]), {
      configure: (ctx) => { ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true }) },
    })
    const run = await (await app.createSession()).run('Attempt an unprepared write.')
    expect(results(run.events)).toEqual([true])
    await expect(readFile(join(workspace, 'no-bypass.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('loads AGENTS.override.md as an additive local overlay before the initial request', async () => {
    const { app, workspace, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]))
    await writeFile(join(workspace, 'AGENTS.md'), 'BASE_RULE_45\n')
    await writeFile(join(workspace, 'AGENTS.override.md'), 'OVERLAY_RULE_45\n')
    await (await app.createSession()).run('Inspect the applicable guidance.')
    const text = JSON.stringify(requests[0]!.messages)
    expect(text).toContain('BASE_RULE_45'); expect(text).toContain('OVERLAY_RULE_45')
    expect(text.indexOf('BASE_RULE_45')).toBeLessThan(text.indexOf('OVERLAY_RULE_45'))
  }, 30000)
})

describe('owned lifecycle and workspace identity', () => {
  it('closes an in-flight stream, drains run durability, and stops subscriptions immediately', async () => {
    let reached!: () => void
    const ready = new Promise<void>((r) => { reached = r })
    const { app } = await fixture((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); reached()
    })
    const session = await app.createSession(), notifications: unknown[] = []
    session.subscribe((e) => { notifications.push(e) })
    const running = session.run('Wait for shutdown.')
    await ready
    const closing = session.close(), atClose = notifications.length
    const result = await running
    await closing
    expect(result.stopReason?.kind).toBe('aborted')
    expect(notifications).toHaveLength(atClose)
    expect(() => session.events()).toThrow('closed')
    const resumed = await app.resumeSession(session.id)
    expect((await resumed.events()).filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
    expect((await resumed.events()).slice(0, result.events.at(-1)!.seq + 1)).toEqual(expect.arrayContaining([...result.events]))
  }, 30000)

  it('cancels a noncooperative host question and rejects its late answer', async () => {
    let reached!: () => void, answer!: (value: { answers: { id: string; selected: string[] }[] }) => void
    const ready = new Promise<void>((r) => { reached = r })
    const { app, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'ask_user_question', { questions: [{ id: 'choice', question: 'Which?', options: [{ label: 'one' }] }] })
      : stream(res, [{ content: 'Must not resume from a late answer.' }]), {
      onQuestion: () => { reached(); return new Promise((resolve) => { answer = resolve }) },
    })
    const session = await app.createSession(), running = session.run('Ask then wait.')
    await ready
    const closing = app.close()
    expect((await running).stopReason?.kind).toBe('aborted')
    await closing
    answer({ answers: [{ id: 'choice', selected: ['one'] }] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests).toHaveLength(1)
  }, 30000)

  it('checks workspace ownership under the write lock, before interrupted-turn recovery appends', async () => {
    let ctx!: Context
    const { app, workspace, stateDirectory, baseURL } = await fixture((_q, res) => stream(res, [{ content: 'Seed.' }]), {
      configure: (context) => { ctx = context },
    })
    const seed = await app.createSession()
    await seed.run('Produce a log prefix.')
    const sourceEvents = await seed.events()
    const id = SessionId('interrupted-other-workspace')
    const header = { ...ctx.agents.get(SessionId(seed.id))!.session.header, id }
    const h = await ctx.sessionPersistence.create(header)
    // This prefix has a durable open turn/step; a successful resume repairs it.
    const events = sourceEvents.slice(0, sourceEvents.findIndex(e => e.type === 'assistant/message'))
    expect(events.some(e => e.type === 'step/start')).toBe(true)
    await h.append(events); await h.close()
    const otherWorkspace = join(workspace, 'other'); await mkdir(otherWorkspace)
    const other = await createIoAgent({ workspace: otherWorkspace, stateDirectory,
      model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 },
      sandbox: 'danger-full-access',
    })
    try { await expect(other.resumeSession(String(id))).rejects.toThrow('workspace does not match') }
    finally { await other.close() }
    const stored = await ctx.sessionPersistence.open(id, 'read')
    try { expect((await stored.read()).events).toEqual(events) } finally { await stored.close() }
    const recovered = await app.resumeSession(String(id))
    expect((await recovered.events()).length).toBeGreaterThan(events.length)
    expect((await recovered.events()).some(e => e.type === 'turn/end')).toBe(true)
  }, 30000)
})
