import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '../../../src/library/session/journal/index.ts'
import { RecordWriter } from '../../../src/library/execution/jobs/background/records.ts'
import { spawnDurable } from '../../../src/library/execution/process/durable/index.ts'
import { hostFixture, run, turn } from './host-fixture.ts'
import { stream, tool } from './fixture.ts'
import { processOutcome } from '../../../src/library/execution/shell/tool-bash/background.ts'
import { mountMcpServer } from '../../../src/library/host/index.ts'
import { Config as McpConfig } from '../../../src/library/mcp/mcp-client/index.ts'

describe.skipIf(process.platform !== 'linux')('durable POSIX regressions', () => {

it('dynamic host MCP mounts have no guessed deadline and preserve explicit deadlines', async () => {
  let resolved: any
  const context = { plugin(_plugin: unknown, config: any) {
    resolved = McpConfig(config)
    return { await: async () => {}, dispose: async () => {} }
  }, tools: { schemas: () => [] } }
  await mountMcpServer(context as any, { transport: 'streamable-http', serverName: 'test', url: 'http://127.0.0.1:1/mcp' }).ready
  expect(resolved.toolCallTimeoutMs).toBe(2 ** 31 - 1)
  await mountMcpServer(context as any, { transport: 'streamable-http', serverName: 'test', url: 'http://127.0.0.1:1/mcp', toolCallTimeoutMs: 123 }).ready
  expect(resolved.toolCallTimeoutMs).toBe(123)
})

it('reserves watcher capacity before concurrent file baseline reads', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]), { background: { maxWatchersPerSession: 1 } })
  const id = await f.host.createSession('watch-limit')
  const agent = f.context().agents.get(SessionId(id))!
  const records = await Promise.allSettled(['a', 'b'].map(path => f.context().background.arm(agent, { path, minutes: 60 })))
  expect(records.map(record => record.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.context().background.watchersOf(new Set([id]))).toHaveLength(1)
})

it('does not expose a promoted job id until its record is durable', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]), { sandbox: 'danger-full-access' })
  const id = await f.host.createSession('promotion-race')
  const agent = f.context().agents.get(SessionId(id))!
  const bg = f.context().background
  const slot = await bg.prepare(agent, 'sleep 60', { maxBytes: { stdout: 65536, stderr: 65536 }, maxFileBytes: 65536 })
  const proc = await f.context().shell.start(f.context().shell.resolve({ command: 'sleep 60', durable: slot.launch }))
  const gate = Promise.withResolvers<void>()
  const original = RecordWriter.prototype.write
  const delayed = vi.spyOn(RecordWriter.prototype, 'write').mockImplementation(function(path, record) {
    return gate.promise.then(() => original.call(this, path, record))
  })
  try {
    let exposed = false
    const promotion = bg.continueAsJob(slot, agent, proc, processOutcome, () => '').then(id => { exposed = true; return id })
    await Promise.resolve()
    expect(exposed).toBe(false)
    expect(JSON.parse(await readFile(join(slot.launch.directory, 'record.json'), 'utf8')).phase).toBe('foreground')
    gate.resolve()
    expect(await promotion).toBe('bash-1')
    expect(JSON.parse(await readFile(join(slot.launch.directory, 'record.json'), 'utf8')).phase).toBe('running')
  } finally {
    gate.resolve()
    delayed.mockRestore()
    await proc.durable!.terminate(10)
    await expect.poll(() => bg.jobsOf(new Set([id]))[0]?.phase).toBe('finished')
    await (bg as any).writer.drain()
    await expect.poll(() => f.requests.length).toBeGreaterThan(0)
  }
})

it('keeps a rejected pre-step notice pending and delivers it once after reopening', async () => {
  let reject = true
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]), { configure(ctx) {
    ctx.on('agent/pre-step', async (_event, next) => { if (reject) throw new Error('instruction assembly failed'); return next() })
  } })
  const id = await f.host.createSession('pre-step-failure')
  const agent = f.context().agents.get(SessionId(id))!
  const record = await f.context().background.arm(agent, { minutes: 0.001 })
  const path = join(f.stateDirectory, 'background/watchers', `${record.token}.json`)
  await expect.poll(() => agent.status).toBe('idle')
  await expect.poll(async () => JSON.parse(await readFile(path, 'utf8')).notice).toBe('pending')
  const events = (await f.context().sessionQuery.readSession(SessionId(id))).events
  expect(events.filter(e => e.type === 'user/message')).toHaveLength(0)
  expect(f.requests).toHaveLength(0)
  await f.host.close()
  reject = false
  await f.open()
  await expect.poll(async () => JSON.parse(await readFile(path, 'utf8')).notice).toBe('read')
  expect(f.requests).toHaveLength(1)
  const recovered = (await f.context().sessionQuery.readSession(SessionId(id))).events
  expect(recovered.filter(e => e.type === 'user/message' && e.data.source?.kind === 'plugin' && e.data.source.plugin === 'tool-watch')).toHaveLength(1)
})

// Regression cases reproduced on e68fa72; the rejected-flush case was already fixed by HR-5.
it('leaves a notice pending when the journal barrier rejects (HR-5)', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]))
  const id = await f.host.createSession('flush-failure')
  const agent = f.context().agents.get(SessionId(id))!
  const background = f.context().background as any
  const record = await background.arm(agent, { minutes: 60 })
  const entry = background.watchers.get(record.token)
  entry.record.notice = 'pending'
  const flush = vi.spyOn(f.context().sessionPersistence, 'flush').mockRejectedValueOnce(new Error('EIO: journal sync failed'))
  await background.confirmRead(entry)
  await background.writer.drain()
  expect(flush).toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(f.stateDirectory, 'background/watchers', `${record.token}.json`), 'utf8')).notice).toBe('pending')
  flush.mockRestore()
})

it('rejects and rolls back watcher admission when the durable record write fails', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]))
  const id = await f.host.createSession('write-failure')
  const agent = f.context().agents.get(SessionId(id))!
  const write = vi.spyOn(RecordWriter.prototype, 'write').mockRejectedValue(new Error('ENOSPC'))
  try {
    await expect(f.context().background.arm(agent, { minutes: 60 })).rejects.toThrow('ENOSPC')
    expect(f.context().background.watchersOf(new Set([id]))).toEqual([])
  } finally { write.mockRestore() }
})

it('retains running ownership after the wrapper exits until all marked descendants end', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'io-review-descendant-'))
  const handle = spawnDurable({ argv: ['sh', '-c', 'setsid sh -c "sleep 60" >/dev/null 2>&1 &'], cwd: directory,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } },
  { directory, marker: `review-${Date.now()}` })
  try {
    await expect.poll(async () => readFile(join(directory, 'exit'), 'utf8').catch(() => '')).toBe('0\n')
    handle.durable!.check()
    expect(handle.durable!.running).toBe(true)
    expect(handle.durable!.hasMembers()).toBe(true)
    await handle.durable!.terminate(10)
    await handle.done
    expect(handle.durable!.hasMembers()).toBe(false)
  } finally {
    await handle.durable!.terminate(10)
    handle.durable!.release()
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects prepare and explicit job admission without spawning when storage is full', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]))
  const id = await f.host.createSession('admission-failure')
  const agent = f.context().agents.get(SessionId(id))!
  const bg = f.context().background
  const start = vi.fn()
  const write = vi.spyOn(RecordWriter.prototype, 'write').mockRejectedValue(new Error('ENOSPC'))
  const bounds = { maxBytes: { stdout: 1024, stderr: 1024 }, maxFileBytes: 1024 }
  try {
    await expect(bg.prepare(agent, 'never spawn', bounds)).rejects.toThrow('ENOSPC')
    await expect(bg.startJob({ owner: agent, label: 'never spawn', ...bounds, start, outcome: processOutcome, render: () => '' })).rejects.toThrow('ENOSPC')
    expect(start).not.toHaveBeenCalled()
    expect(bg.jobsOf(new Set([id]))).toEqual([])
  } finally { write.mockRestore() }
})

it('rejects failed watcher cancellation and retries settlement before delivering a notice', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]))
  const id = await f.host.createSession('transition-failure')
  const agent = f.context().agents.get(SessionId(id))!
  const bg = f.context().background
  const record = await bg.arm(agent, { minutes: 60 })
  await (bg as any).writer.drain()
  const write = vi.spyOn(RecordWriter.prototype, 'write').mockRejectedValue(new Error('EIO'))
  try {
    await expect(bg.cancelWatcher(id, record.id)).rejects.toThrow('EIO')
    expect(bg.watchersOf(new Set([id]))[0]?.state).toBe('armed')
    const entry = (bg as any).watchers.get(record.token)
    ;(bg as any).flip(entry, 'fired', 'done')
    const settled = (bg as any).afterSettle(entry)
    await expect.poll(() => write.mock.calls.length).toBeGreaterThan(2)
    expect(f.requests).toHaveLength(0)
    expect(JSON.parse(await readFile(join(f.stateDirectory, 'background/watchers', `${record.token}.json`), 'utf8')).state).toBe('armed')
    write.mockRestore()
    await settled
    await expect.poll(() => f.requests.length).toBe(1)
  } finally { write.mockRestore() }
})

it('waits for a durable kill intent and rejects storage failure before signalling', async () => {
  const f = await hostFixture((_q, r) => stream(r, [{ content: 'ok' }]), { sandbox: 'danger-full-access' })
  const id = await f.host.createSession('kill-barrier')
  const agent = f.context().agents.get(SessionId(id))!
  const bg = f.context().background
  const slot = await bg.prepare(agent, 'sleep 60', { maxBytes: { stdout: 1024, stderr: 1024 }, maxFileBytes: 1024 })
  const proc = await f.context().shell.start(f.context().shell.resolve({ command: 'sleep 60', durable: slot.launch }))
  const job = await bg.continueAsJob(slot, agent, proc, processOutcome, () => '')
  await (bg as any).writer.drain()
  const gate = Promise.withResolvers<void>()
  const original = RecordWriter.prototype.write
  const write = vi.spyOn(RecordWriter.prototype, 'write').mockRejectedValueOnce(new Error('EIO'))
  try {
    await expect(f.host.killJob(id, job)).rejects.toThrow('EIO')
    expect(proc.durable!.running).toBe(true)
    expect(bg.jobsOf(new Set([id]))[0]?.phase).toBe('running')
    write.mockImplementation(function(path, record) { return gate.promise.then(() => original.call(this, path, record)) })
    let returned = false
    const killed = f.host.killJob(id, job).then(value => { returned = true; return value })
    await Promise.resolve()
    expect(returned).toBe(false)
    expect(proc.durable!.running).toBe(true)
    gate.resolve()
    expect(await killed).toBe('requested')
    await proc.done
  } finally {
    gate.resolve(); write.mockRestore()
    await proc.durable!.terminate(10)
  }
})


it.each(['cancel', 'storage failure'] as const)('cleans up a durable default-wait handoff on %s before admission', async failure => {
  const f = await hostFixture((_q, response, index) => {
    if (index === 0) tool(response, 'bash', { command: 'sleep 60', description: 'Sleep' })
    else stream(response, [{ content: 'ok' }])
  }, { sandbox: 'danger-full-access' })
  const id = await f.host.createSession('failed-handoff')
  const shell = f.context().shell
  const original = shell.run.bind(shell)
  let child: Awaited<ReturnType<typeof shell.run>>['detached']
  let write: ReturnType<typeof vi.spyOn> | undefined
  vi.spyOn(shell, 'run').mockImplementation(async spec => {
    const result = await original({ ...spec, timeoutMs: 50 })
    child = result.detached
    expect(child?.durable).toBeDefined()
    if (failure === 'cancel') void f.host.cancel(id).catch(() => {})
    else write = vi.spyOn(RecordWriter.prototype, 'write').mockRejectedValue(new Error('EIO: promotion failed'))
    return result
  })
  try {
    await run(f.host, turn(id, 'Run the command.'))
    expect(child?.durable?.hasMembers()).toBe(false)
    expect(f.context().background.jobsOf(new Set([id]))).toEqual([])
    expect(await readdir(join(f.stateDirectory, 'background/jobs'))).toEqual([])
    if (failure === 'storage failure') expect(JSON.stringify(f.requests)).toContain('EIO: promotion failed')
  } finally {
    write?.mockRestore()
    await child?.durable?.terminate(10)
  }
})

})
