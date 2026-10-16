/**
 * Background work that outlives a turn, a host and a restart: durable commands and watchers over the real host,
 * loop, persistence and processes, with a scripted model. "Restart" closes the host and opens another over the
 * same state, as a service restart does; the durable processes keep running meanwhile.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'
import { RecordWriter } from "../../../src/library/execution/jobs/background/records.ts"
import { pendingBackgroundWork } from "../../../src/library/host/index.ts"
import { spawnDurable } from "../../../src/library/execution/process/durable/index.ts"
import type { JobOutcome } from "../../../src/library/execution/jobs/jobs/index.ts"

/** Every message text of a request, one entry per message. */
function texts(request: Request | undefined): string[] {
  return (request?.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
}
/** How many messages of a request match: a notice that entered the conversation twice matches twice. */
function occurrences(request: Request | undefined, pattern: RegExp): number {
  return texts(request).filter(text => pattern.test(text)).length
}
const JOB_1_DONE = /background job bash-1 \(bash: .*\) finished/

async function jobDirectories(state: string): Promise<string[]> {
  const base = join(state, 'background', 'jobs')
  return (await readdir(base).catch(() => [])).map(name => join(base, name))
}
async function launchPid(directory: string): Promise<number> {
  await expect.poll(() => existsSync(join(directory, 'launch.json')), { timeout: 5000 }).toBe(true)
  return (JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8')) as { pid: number }).pid
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
/** Live pids whose environment carries a job's marker. */
async function marked(token: string): Promise<number[]> {
  const found: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
      if (/^\d+ \(.*\) Z/.test(stat)) continue
      if ((await readFile(`/proc/${entry}/environ`, 'utf8')).split('\0').includes(`IO_AGENT_BACKGROUND_JOB=${token}`)) found.push(Number(entry))
    } catch { /* gone */ }
  }
  return found
}
function agentOf(context: Context, id: string): Agent {
  const agent = context.agents.get(SessionId(id))
  if (agent === undefined) throw new Error(`no live agent for ${id}`)
  return agent
}
/** Replies with the scripted tool calls in order, then plain text for every later request. */
function script(calls: readonly [name: string, args: object][]) {
  return (_request: Request, response: ServerResponse, index: number): void => {
    const call = calls[index]
    if (call !== undefined) tool(response, call[0], call[1], `call_${String(index)}`)
    else stream(response, [{ content: `Reply ${String(index)}.` }])
  }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(process.platform !== 'linux')('background work across restarts', () => {
  it('a background command outlives its host, ends while none runs, and its end reaches the agent exactly once', async () => {
    const f = await hostFixture(script([['bash', { command: 'while [ ! -f go ]; do sleep 0.05; done; echo out-$((40+2))',
      description: 'Wait for go', run_in_background: true }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('outlives')
    await run(f.host, turn(id, 'Start it.'))
    const [directory] = await jobDirectories(f.stateDirectory)
    const pid = await launchPid(directory!)
    await f.host.close()
    // The host is gone; the command is not.
    expect(alive(pid)).toBe(true)
    await writeFile(join(f.workspace, 'go'), '')
    await expect.poll(() => existsSync(join(directory!, 'exit')), { timeout: 5000 }).toBe(true)
    // A new host reopens the session that is owed the notice without any client asking.
    const second = await f.open()
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    expect(occurrences(f.requests[2], JOB_1_DONE)).toBe(1)
    await expect.poll(async () => (await second.background(id)).jobs[0]?.notice_pending, { timeout: 5000 }).toBeUndefined()
    // Taken in: neither this host nor the next sends it again.
    await second.close()
    await f.open()
    await sleep(500)
    expect(f.requests).toHaveLength(3)
  }, 30000)

  it('tells a host that has not opened yet whether background work waits on disk', async () => {
    const f = await hostFixture(script([['bash', { command: 'while [ ! -f go ]; do sleep 0.05; done', description: 'Wait', run_in_background: true }]]),
      { sandbox: 'danger-full-access' })
    expect(await pendingBackgroundWork(f.stateDirectory)).toBe(false)
    const id = await f.host.createSession('pending-on-disk')
    await run(f.host, turn(id, 'Start it.'))
    await f.host.close()
    expect(await pendingBackgroundWork(f.stateDirectory)).toBe(true)
    await writeFile(join(f.workspace, 'go'), '')
    const second = await f.open()
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    await expect.poll(async () => (await second.background(id)).jobs[0]?.notice_pending, { timeout: 5000 }).toBeUndefined()
    await second.close()
    // Ended and taken in: nothing waits any more, though the job stays listed for a while.
    expect(await pendingBackgroundWork(f.stateDirectory)).toBe(false)
  }, 30000)

  it('adopts a running job after a restart under its old id and delivers its end when it comes', async () => {
    const f = await hostFixture(script([['bash', { command: 'while [ ! -f go ]; do sleep 0.05; done; echo adopted',
      description: 'Wait for go', run_in_background: true }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('adopted')
    await run(f.host, turn(id, 'Start it.'))
    await f.host.close()
    const second = await f.open()
    await second.resumeSession(id)
    expect((await second.background(id)).jobs).toMatchObject([{ job_id: 'bash-1', state: 'running', durable: true }])
    expect(f.context().jobs.list(agentOf(f.context(), id)).map(job => job.id)).toEqual(['bash-1'])
    await writeFile(join(f.workspace, 'go'), '')
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    expect(occurrences(f.requests[2], JOB_1_DONE)).toBe(1)
    expect(texts(f.requests[2]).join('\n')).toContain('exit code: 0')
  }, 30000)

  it('reports a job whose process vanished without an exit status while no host ran as lost', async () => {
    const f = await hostFixture(script([['bash', { command: 'sleep 60', description: 'Sleep', run_in_background: true }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('lost')
    await run(f.host, turn(id, 'Start it.'))
    const [directory] = await jobDirectories(f.stateDirectory)
    const pid = await launchPid(directory!)
    await f.host.close()
    // The whole group dies hard, the wrapper with it: nothing records how it ended.
    process.kill(-pid, 'SIGKILL')
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false)
    await f.open()
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    expect(texts(f.requests[2]).join('\n')).toMatch(/background job bash-1 \(bash: sleep 60\) finished \[status: failed, the process ended while the service was down and left no exit status\]/)
  }, 30000)

  it('finishes a kill that a restart interrupted, and tells the agent', async () => {
    const f = await hostFixture(script([]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('interrupted-kill')
    await run(f.host, turn(id, 'Hello.'))
    await f.host.close()
    // What a service that died mid-kill leaves: the record says stopping, the stubborn process still runs.
    const token = randomUUID()
    const directory = join(f.stateDirectory, 'background', 'jobs', token)
    await mkdir(directory, { recursive: true })
    const bounds = { maxBytes: { stdout: 65536, stderr: 65536 }, maxFileBytes: 64 * 1024 * 1024 }
    spawnDurable({ argv: ['sh', '-c', 'trap "" TERM; while :; do sleep 0.05; done'], cwd: f.workspace, graceMs: 200,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536, spill: { maxBytes: bounds.maxFileBytes } }, stderr: { maxBytes: 65536, spill: { maxBytes: bounds.maxFileBytes } } } },
    { directory, marker: token }).durable.release()
    await writeFile(join(directory, 'record.json'), JSON.stringify({ version: 1, token, session: id, jobId: 'bash-1', label: 'stubborn', phase: 'stopping',
      startedAt: Date.now(), cursor: { stdout: 0, stderr: 0 }, ...bounds, journaled: {}, stopReason: 'stopped by the user' }))
    expect((await marked(token)).length).toBeGreaterThan(0)
    await f.open()
    await expect.poll(async () => (await marked(token)).length, { timeout: 15000 }).toBe(0)
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(2)
    expect(texts(f.requests[1]).join('\n')).toContain('background job bash-1 (bash: stubborn) finished [status: killed, stopped by the user]')
  }, 30000)

  it('stopping a job from the host takes its group, a member that ignores SIGTERM and a descendant that left the group, and tells the agent', async () => {
    const command = `sh -c 'trap "" TERM; while :; do sleep 0.1; done' & setsid sh -c 'trap "" TERM; while :; do sleep 0.1; done' & wait`
    const f = await hostFixture(script([['bash', { command, description: 'Stubborn', run_in_background: true }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('stubborn')
    await run(f.host, turn(id, 'Start it.'))
    const [directory] = await jobDirectories(f.stateDirectory)
    const token = directory!.split('/').pop()!
    await expect.poll(async () => (await marked(token)).length, { timeout: 5000 }).toBeGreaterThanOrEqual(3)
    expect(await f.host.killJob(id, 'bash-1')).toBe('requested')
    await expect.poll(async () => (await marked(token)).length, { timeout: 15000 }).toBe(0)
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    expect(texts(f.requests[2]).join('\n')).toMatch(/background job bash-1 \(bash: .*\) finished \[status: killed, stopped by the user\]/)
    expect(await f.host.killJob(id, 'bash-1')).toBe('already_finished')
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('watchers', () => {
  it('wakes the agent at the deadline of a watcher whose condition never comes, once', async () => {
    const f = await hostFixture(script([['watch', { path: 'never-there', minutes: 0.01, note: 'check the build' }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('deadline')
    await run(f.host, turn(id, 'Watch it.'))
    expect(texts(f.requests[1]).join('\n')).toMatch(/Armed watch-1: wakes you when .*never-there appears, changes or is removed, or at .* at the latest\./)
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    const notice = texts(f.requests[2]).filter(text => text.includes('Watcher watch-1'))
    expect(notice).toHaveLength(1)
    expect(notice[0]).toMatch(/Watcher watch-1 reached its deadline: .*never-there does not exist\.\nNote: check the build/)
    await sleep(300)
    expect(f.requests).toHaveLength(3)
    expect((await f.host.background(id)).watchers).toMatchObject([{ watch_id: 'watch-1', state: 'expired', condition: 'file' }])
  }, 30000)

  it('re-arms a time watcher after a restart and fires it once, late, when its moment passed meanwhile', async () => {
    const f = await hostFixture(script([['watch', { minutes: 0.02 }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('late')
    await run(f.host, turn(id, 'Wake me soon.'))
    await f.host.close()
    await sleep(1500)
    expect(f.requests).toHaveLength(2)
    const second = await f.open()
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    expect(occurrences(f.requests[2], /Watcher watch-1 fired: the time .* was reached\./)).toBe(1)
    await expect.poll(async () => (await second.background(id)).watchers[0]?.notice_pending, { timeout: 5000 }).toBeUndefined()
    await second.close()
    await f.open()
    await sleep(500)
    expect(f.requests).toHaveLength(3)
  }, 30000)

  it('reports a job end through the watcher waiting for it, not twice', async () => {
    const f = await hostFixture(script([
      ['bash', { command: 'while [ ! -f go ]; do sleep 0.05; done; exit 3', description: 'Wait', run_in_background: true }],
      ['watch', { job_id: 'bash-1', minutes: 5 }],
    ]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('job-watch')
    await run(f.host, turn(id, 'Start and watch it.'))
    await writeFile(join(f.workspace, 'go'), '')
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(4)
    const last = f.requests[3]
    expect(occurrences(last, /Watcher watch-1 fired: bash-1 finished \[status: completed, exit code: 3\]\./)).toBe(1)
    expect(occurrences(last, JOB_1_DONE)).toBe(0)
    await sleep(300)
    expect(f.requests).toHaveLength(4)
  }, 30000)

  it('finds a matching output line inside a flood larger than any read window', async () => {
    const flood = (char: string): string => `head -c 12000000 /dev/zero | tr '\\0' ${char}; echo`
    const command = `while [ ! -f go ]; do sleep 0.05; done; ${flood('x')}; echo READY-$((6*7)); ${flood('y')}; sleep 60`
    const f = await hostFixture(script([
      ['bash', { command, description: 'Flood', run_in_background: true }],
      ['watch', { job_id: 'bash-1', pattern: '^READY-[0-9]+$', minutes: 5 }],
    ]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('flood')
    await run(f.host, turn(id, 'Start and watch it.'))
    await writeFile(join(f.workspace, 'go'), '')
    await expect.poll(() => f.requests.length, { timeout: 15000 }).toBe(4)
    expect(occurrences(f.requests[3], /Watcher watch-1 fired: bash-1 printed: READY-42\./)).toBe(1)
    await f.host.killJob(id, 'bash-1')
  }, 30000)

  it('matches an output pattern off the host\'s thread: a slow pattern on a long line never stalls the host', async () => {
    // `.*error.*` backtracks quadratically on a long line without "error": seconds on one 80 KB line.
    const command = `while [ ! -f go ]; do sleep 0.05; done; head -c 80000 /dev/zero | tr '\\0' a; echo; echo an-error-here; sleep 60`
    const f = await hostFixture(script([
      ['bash', { command, description: 'Long line', run_in_background: true }],
      ['watch', { job_id: 'bash-1', pattern: '.*error.*', minutes: 5 }],
    ]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('slow-pattern')
    await run(f.host, turn(id, 'Start and watch it.'))
    let stall = 0, last = Date.now()
    const beat = setInterval(() => { const now = Date.now(); stall = Math.max(stall, now - last); last = now }, 10)
    try {
      await writeFile(join(f.workspace, 'go'), '')
      await expect.poll(() => f.requests.length, { timeout: 20000 }).toBe(4)
    } finally {
      clearInterval(beat)
    }
    expect(occurrences(f.requests[3], /Watcher watch-1 fired: bash-1 printed: an-error-here\./)).toBe(1)
    expect(stall).toBeLessThan(500)
    await f.host.killJob(id, 'bash-1')
  }, 30000)

  it('reports the end of delegated work (a job with no durable key) through the watcher waiting for it, not twice', async () => {
    const f = await hostFixture(script([]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('keyless-watch')
    await run(f.host, turn(id, 'Hello.'))
    const agent = agentOf(f.context(), id)
    const done = Promise.withResolvers<JobOutcome>()
    const job = f.context().jobs.start({ kind: 'subagent', label: 'Research', owner: agent,
      run: () => ({ cancel: () => { done.resolve({ status: 'killed' }) }, done: done.promise }) })
    expect(String(job)).toBe('subagent-1')
    await f.context().background.arm(agent, { job_id: 'subagent-1', minutes: 5 })
    done.resolve({ status: 'completed', output: 'Found it.' })
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(2)
    await sleep(500)
    expect(f.requests).toHaveLength(2)
    expect(occurrences(f.requests[1], /Watcher watch-1 fired: subagent-1 finished \[status: completed\]\./)).toBe(1)
    expect(occurrences(f.requests[1], /background job subagent-1 \(subagent: Research\) finished/)).toBe(0)
  }, 30000)

  it('reads the rest of the output when the job ends before an output watcher matched, and reports the end once', async () => {
    const f = await hostFixture(script([
      ['bash', { command: 'while [ ! -f go ]; do sleep 0.05; done; echo one; printf two; exit 4', description: 'Wait', run_in_background: true }],
      ['watch', { job_id: 'bash-1', pattern: '^never$', minutes: 5 }],
    ]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('output-ended')
    await run(f.host, turn(id, 'Start and watch it.'))
    await writeFile(join(f.workspace, 'go'), '')
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(4)
    expect(occurrences(f.requests[3], /Watcher watch-1 fired: bash-1 finished without a matching line \[status: completed, exit code: 4\]\./)).toBe(1)
    expect(occurrences(f.requests[3], JOB_1_DONE)).toBe(0)
    await sleep(300)
    expect(f.requests).toHaveLength(4)
  }, 30000)

  it('stops a pattern that would never finish at the watcher\'s deadline, and the host keeps serving meanwhile', async () => {
    const command = `while [ ! -f go ]; do sleep 0.05; done; printf '${'a'.repeat(60)}b\\n'; sleep 60`
    const f = await hostFixture(script([
      ['bash', { command, description: 'Pathological line', run_in_background: true }],
      ['watch', { job_id: 'bash-1', pattern: '^(a+)+$', minutes: 0.05 }],
    ]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('endless-pattern')
    await run(f.host, turn(id, 'Start and watch it.'))
    let stall = 0, last = Date.now()
    const beat = setInterval(() => { const now = Date.now(); stall = Math.max(stall, now - last); last = now }, 10)
    try {
      await writeFile(join(f.workspace, 'go'), '')
      await expect.poll(() => f.requests.length, { timeout: 15000 }).toBe(4)
    } finally {
      clearInterval(beat)
    }
    expect(occurrences(f.requests[3], /Watcher watch-1 reached its deadline: bash-1 has printed no matching line\./)).toBe(1)
    expect(stall).toBeLessThan(500)
    await f.host.killJob(id, 'bash-1')
  }, 30000)

  it('wakes once per watcher when many fire together, and holds the per-session limit', async () => {
    const f = await hostFixture(script([]), { sandbox: 'danger-full-access', background: { maxWatchersPerSession: 12 } })
    const id = await f.host.createSession('many')
    await run(f.host, turn(id, 'Hello.'))
    const agent = agentOf(f.context(), id)
    for (let index = 0; index < 12; index += 1) await f.context().background.arm(agent, { minutes: 0.02 })
    await expect(f.context().background.arm(agent, { minutes: 1 })).rejects.toThrow('This session already has 12 armed watchers; cancel one first.')
    await expect.poll(() => occurrences(f.requests.at(-1), /Watcher watch-\d+ fired/), { timeout: 15000 }).toBe(12)
    const final = f.requests.at(-1)
    for (let index = 1; index <= 12; index += 1) expect(occurrences(final, new RegExp(`Watcher watch-${String(index)} fired`))).toBe(1)
    // A time watcher reaches its moment: it fires, never "expires", however its last check fell.
    expect((await f.host.background(id)).watchers.every(watcher => watcher.state === 'fired')).toBe(true)
    await expect.poll(async () => (await f.host.background(id)).watchers.filter(watcher => watcher.notice_pending === undefined).length,
      { timeout: 5000 }).toBe(12)
  }, 30000)

  it('notices a forward clock jump at the next recheck and waits through a backward one', async () => {
    const f = await hostFixture(script([]), { sandbox: 'danger-full-access', background: { recheckMs: 50 } })
    const id = await f.host.createSession('clock')
    await run(f.host, turn(id, 'Hello.'))
    const agent = agentOf(f.context(), id)
    const real = Date.now.bind(Date)
    const backward = vi.spyOn(Date, 'now').mockImplementation(() => real() - 3_600_000)
    try {
      await f.context().background.arm(agent, { minutes: 30 })
      await sleep(300)
      expect((await f.host.background(id)).watchers[0]).toMatchObject({ state: 'armed' })
    } finally {
      backward.mockRestore()
    }
    // Back to the real clock, the watcher's moment (30 minutes after an hour ago) has passed.
    await expect.poll(() => f.requests.length, { timeout: 5000 }).toBe(2)
    const notice = texts(f.requests[1]).find(text => text.includes('Watcher watch-1'))
    expect(notice).toMatch(/Watcher watch-1 fired: the time .* was reached\.\nIt was due at .*, 30 minutes before it could be delivered\./)
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('watch tools', () => {
  it('arms, lists and cancels through the tools, and refuses unclear requests in plain words', async () => {
    const f = await hostFixture(script([
      ['watch', { minutes: 30, note: 'look again' }],
      ['watch_list', {}],
      ['watch_cancel', { watch_id: 'watch-1' }],
      ['watch_cancel', { watch_id: 'watch-1' }],
      ['watch', { url: 'ftp://example.invalid/' }],
    ]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('tools')
    await run(f.host, turn(id, 'Use the watch tools.'))
    const result = (index: number): string => texts(f.requests[index]).at(-1) ?? ''
    expect(result(1)).toMatch(/^Armed watch-1: wakes you at \d{4}-\d\d-\d\dT[^ ]+Z\.$/)
    expect(result(2)).toMatch(/^watch-1 armed: the time .*Z; deadline .*Z$/)
    expect(result(3)).toBe('Cancelled watch-1.')
    expect(result(4)).toBe('watch-1 is no longer armed (cancelled).')
    expect(result(5)).toContain('url must be an http or https URL.')
    const agent = agentOf(f.context(), id)
    const refuse = (request: object, text: string) => expect(f.context().background.arm(agent, request)).rejects.toThrow(text)
    await refuse({}, 'Give one condition (job_id, optionally with pattern; pid; path; or url), or only at or minutes to wake at a time.')
    await refuse({ path: 'a', url: 'http://localhost/' }, 'Give one condition')
    await refuse({ minutes: 1, at: new Date().toISOString() }, 'Give at or minutes, not both.')
    await refuse({ pattern: 'x' }, 'pattern needs job_id.')
    await refuse({ minutes: -1 }, 'minutes must be a positive number.')
    await refuse({ at: 'tomorrow-ish' }, 'at must be an ISO 8601 time.')
    await refuse({ minutes: 60 * 24 * 8 }, 'The deadline must be within 7 days.')
    await refuse({ job_id: 'bash-7' }, 'Unknown job bash-7.')
    await refuse({ pid: 2 ** 22 + 12345 }, `No running process has pid ${String(2 ** 22 + 12345)}.`)
    // A delegated agent's work ends with it: it cannot set watchers.
    expect(f.context().background.serves({ session: { header: { parentSession: 'root' } } } as unknown as Agent)).toBe(false)
    expect(f.context().background.serves(agent)).toBe(true)
  }, 30000)

  it('offers the watch tools to the main session only, not to a delegated agent', async () => {
    let parent = 0
    const tools: { child?: string[]; root?: string[] } = {}
    const f = await hostFixture((request, response) => {
      const names = (request.tools ?? []).map(entry => entry.function.name)
      // Only the main session can ask its person; a delegated agent is never offered that tool.
      if (!names.includes('ask_user_question')) {
        tools.child ??= names
        stream(response, [{ content: 'Child done.' }])
        return
      }
      tools.root ??= names
      parent += 1
      if (parent === 1) tool(response, 'subagent', { description: 'Inspect', prompt: 'Look around.' }, 'child-call')
      else stream(response, [{ content: 'Parent done.' }])
    }, { sandbox: 'danger-full-access' }, { interactionTimeoutMs: 10000 })
    const id = await f.host.createSession('delegated')
    await run(f.host, turn(id, 'Delegate.'))
    expect(tools.root).toEqual(expect.arrayContaining(['watch', 'watch_list', 'watch_cancel']))
    // The delegation runs on its own after the call returns.
    await expect.poll(() => tools.child, { timeout: 10000 }).toBeDefined()
    expect(tools.child).not.toContain('watch')
    expect(tools.child).not.toContain('watch_list')
    expect(tools.child).not.toContain('watch_cancel')
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('exactly-once delivery', () => {
  it('does not send a notice again that the journal shows was taken in when its record lagged behind', async () => {
    const f = await hostFixture(script([['bash', { command: 'echo quick', description: 'Quick', run_in_background: true }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('lagged')
    await run(f.host, turn(id, 'Start it.'))
    await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
    await expect.poll(async () => (await f.host.background(id)).jobs[0]?.notice_pending, { timeout: 5000 }).toBeUndefined()
    await f.host.close()
    // The process stopped after the step took the notice in but before its record said so.
    const [directory] = await jobDirectories(f.stateDirectory)
    const record = JSON.parse(await readFile(join(directory!, 'record.json'), 'utf8')) as Record<string, unknown>
    expect(record.notice).toBe('read')
    await writeFile(join(directory!, 'record.json'), JSON.stringify({ ...record, notice: 'pending' }))
    const second = await f.open()
    await second.resumeSession(id)
    await sleep(500)
    expect(f.requests).toHaveLength(3)
    expect((await second.background(id)).jobs[0]?.notice_pending).toBeUndefined()
  }, 30000)

  it('does not deliver a watcher twice when its record is slow to land while its session reopens', async () => {
    let slowDisk = false
    const f = await hostFixture(script([['watch', { minutes: 0.02 }]]), { sandbox: 'danger-full-access', configure: (context) => {
      // A slow disk: the journal takes long to flush, so a taken-in notice stays owed for a while.
      const persistence = context.sessionPersistence
      const flush = persistence.flush.bind(persistence)
      persistence.flush = async () => { if (slowDisk) await sleep(1500); await flush() }
    } })
    const id = await f.host.createSession('slow-disk')
    await run(f.host, turn(id, 'Wake me soon.'))
    await f.host.close()
    await sleep(1500)
    // The fired watcher's own record lands after the reopened session already got its notice.
    const write = RecordWriter.prototype.write
    const slow = vi.spyOn(RecordWriter.prototype, 'write').mockImplementation(function (this: RecordWriter, path: string, record: object) {
      const fired = path.includes('/watchers/') && (record as { state?: string }).state === 'fired'
      return fired ? sleep(500).then(() => write.call(this, path, record)) : write.call(this, path, record)
    })
    slowDisk = true
    try {
      await f.open()
      await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
      await sleep(2500)
      expect(f.requests).toHaveLength(3)
      expect(occurrences(f.requests[2], /Watcher watch-1 fired/)).toBe(1)
    } finally {
      slowDisk = false
      slow.mockRestore()
    }
  }, 30000)

  it('keeps a notice owed when the journal holding the step that took it in could not be written', async () => {
    let failing = false
    const f = await hostFixture(script([['bash', { command: 'while [ ! -f go ]; do sleep 0.05; done; echo done', description: 'Wait', run_in_background: true }]]),
      { sandbox: 'danger-full-access', configure: (context) => {
        const persistence = context.sessionPersistence
        const flush = persistence.flush.bind(persistence)
        persistence.flush = async () => { if (failing) throw new Error('no space left on device'); await flush() }
      } })
    const id = await f.host.createSession('flush-failed')
    await run(f.host, turn(id, 'Start it.'))
    failing = true
    try {
      await writeFile(join(f.workspace, 'go'), '')
      await expect.poll(() => f.requests.length, { timeout: 10000 }).toBe(3)
      expect(occurrences(f.requests[2], JOB_1_DONE)).toBe(1)
      await sleep(500)
      // Not known to be on disk: still owed, so the next opening asks the journal.
      expect((await f.host.background(id)).jobs[0]?.notice_pending).toBe(true)
    } finally {
      failing = false
    }
  }, 30000)

  it('keeps a notice a cancel cleared from the inbox for the next turn, without waking the stopped agent', async () => {
    let calls = 0
    const f = await hostFixture((_request, response) => {
      calls += 1
      if (calls === 1) tool(response, 'bash', { command: 'sleep 0.3; echo early', description: 'Quick job', run_in_background: true }, 'call_a')
      else if (calls === 2) tool(response, 'bash', { command: 'sleep 30', description: 'Long step' }, 'call_b')
      else stream(response, [{ content: `Reply ${String(calls)}.` }])
    }, { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('cancelled')
    const receipt = await f.host.submit(turn(id, 'Go.'))
    const agent = await vi.waitFor(() => agentOf(f.context(), id))
    // The job ends during the long step: its notice waits in the inbox for the next step.
    await expect.poll(() => agent.inbox.nextStep.some(message => texts({ messages: [{ role: 'user', content: message.content }] } as Request)
      .some(text => JOB_1_DONE.test(text))), { timeout: 10000 }).toBe(true)
    await f.host.cancel(id, receipt.activity_id)
    await sleep(500)
    expect(calls).toBe(2)
    await run(f.host, turn(id, 'Next.', 'turn-application-02'))
    expect(occurrences(f.requests[2], JOB_1_DONE)).toBe(1)
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('host view of background work', () => {
  it('lists jobs, watchers and wake-ups, journals their lifecycle, flags the session and stops it all on delete', async () => {
    const f = await hostFixture(script([
      ['bash', { command: 'sleep 60', description: 'Sleep', run_in_background: true }],
      ['watch', { job_id: 'bash-1', minutes: 30, note: 'n' }],
    ]), { sandbox: 'danger-full-access' })
    const changes: { session_id: string; item: string }[] = []
    const observer = new AbortController()
    const watching = (async () => {
      try { for await (const change of f.host.watchBackground(observer.signal)) changes.push(change) } catch { /* aborted */ }
    })()
    const id = await f.host.createSession('listed')
    await run(f.host, turn(id, 'Start and watch it.'))
    const view = await f.host.background(id)
    expect(view).toMatchObject({ session_id: id, active: true,
      jobs: [{ job_id: 'bash-1', kind: 'bash', label: 'sleep 60', state: 'running', durable: true }],
      watchers: [{ watch_id: 'watch-1', condition: 'job', state: 'armed', waits_for: 'bash-1 finishes', note: 'n' }] })
    expect(view.wakeups[0]).toMatchObject({ kind: 'watcher', watch_id: 'watch-1' })
    expect((await f.host.listSessions()).find(row => row.id === id)?.background).toBe(true)
    expect(f.host.readSession(id).background).toBe(true)
    const history = await f.host.history(id)
    expect(history.events.filter(event => event.type === 'job' || event.type === 'watcher').map(event => event.type === 'job'
      ? `${event.job_id} ${event.event}` : event.type === 'watcher' ? `${event.watch_id} ${event.event}` : '')).toEqual(['bash-1 started', 'watch-1 armed'])
    expect(changes.some(change => change.session_id === id && change.item === 'job')).toBe(true)
    expect(changes.some(change => change.session_id === id && change.item === 'watcher')).toBe(true)
    // The output a viewer reads does not move the agent's own position.
    expect(await f.host.readJobOutput(id, 'bash-1')).toMatchObject({ text: '', next: 0 })
    await expect(f.host.readJobOutput(id, 'bash-9')).rejects.toMatchObject({ code: 'UNKNOWN_JOB' })
    await expect(f.host.cancelWatcher(id, 'watch-9')).rejects.toMatchObject({ code: 'UNKNOWN_WATCHER' })
    const [directory] = await jobDirectories(f.stateDirectory)
    const token = directory!.split('/').pop()!
    await f.host.deleteSession(id)
    expect(await marked(token)).toEqual([])
    expect(await jobDirectories(f.stateDirectory)).toEqual([])
    // The job's end, seen as it was stopped, is owed to nobody: the session is gone.
    expect(f.context().background.owedSessions()).toEqual([])
    observer.abort()
    await watching
  }, 30000)

  it('keeps one abort listener for a background observer however many changes it sees', async () => {
    const f = await hostFixture(script([]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('observer')
    await run(f.host, turn(id, 'Hello.'))
    const agent = agentOf(f.context(), id)
    // The observer's stop signal is the composite of the host's closing and the caller's signal.
    const any = AbortSignal.any.bind(AbortSignal)
    let stop: AbortSignal | undefined
    const spy = vi.spyOn(AbortSignal, 'any').mockImplementation((signals) => { const made = any(signals); stop ??= made; return made })
    const observer = new AbortController()
    const changes = f.host.watchBackground(observer.signal)
    const first = changes.next()
    spy.mockRestore()
    let seen = 0
    const consuming = (async () => {
      for (let result = await first; result.done !== true; result = await changes.next()) seen += 1
    })()
    for (let index = 1; index <= 15; index += 1) {
      await f.context().background.arm(agent, { minutes: 30 })
      await f.host.cancelWatcher(id, `watch-${String(index)}`)
      await sleep(5)
    }
    await expect.poll(() => seen, { timeout: 5000 }).toBe(30)
    expect(stop).toBeDefined()
    expect(getEventListeners(stop!, 'abort').length).toBeLessThanOrEqual(1)
    observer.abort()
    await consuming.catch(() => undefined)
  }, 30000)

  it('leaves nothing behind for a deleted session whose watcher was in the middle of a check', async () => {
    const answered = Promise.withResolvers<void>()
    // The URL answers after the session is gone: the check that asked is still waiting when it is deleted.
    const server = createServer((_request, response) => { setTimeout(() => { response.writeHead(200).end('up'); answered.resolve() }, 1500) })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
      const f = await hostFixture(script([['watch', { url, minutes: 5, note: 'private note' }]]), { sandbox: 'danger-full-access' })
      const id = await f.host.createSession('deleted-mid-check')
      await run(f.host, turn(id, 'Watch it.'))
      await sleep(300)
      await f.host.deleteSession(id)
      const watchers = join(f.stateDirectory, 'background', 'watchers')
      expect(await readdir(watchers).catch(() => [])).toEqual([])
      await answered.promise
      await sleep(500)
      expect(await readdir(watchers).catch(() => [])).toEqual([])
      expect(f.requests).toHaveLength(2)
      await f.host.close()
      expect(await pendingBackgroundWork(f.stateDirectory)).toBe(false)
    } finally {
      server.close()
    }
  }, 30000)

  it('shows a wait on a failing model endpoint as retry events, in history as live', async () => {
    let calls = 0
    const f = await hostFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'overloaded' } }))
        return
      }
      stream(response, [{ content: 'Back.' }])
    })
    const id = await f.host.createSession('retry-visible')
    const { receipt } = await run(f.host, turn(id, 'Hello.'))
    const live = f.host.readSession(id, receipt.after).events.filter(event => event.type === 'retry')
    const history = (await f.host.history(id)).events.filter(event => event.type === 'retry')
    expect(history).toMatchObject([{ type: 'retry', attempt: 1, max_attempts: 30, code: 'SERVER', delay_ms: expect.any(Number) }])
    // Live delivery names the activity; otherwise it is the same event at the same seq.
    expect(live.map(({ activity_id: _activity, ...event }) => event)).toEqual(history)
  }, 30000)

  it('cancels a watcher from the host without waking the agent', async () => {
    const f = await hostFixture(script([['watch', { minutes: 0.02 }]]), { sandbox: 'danger-full-access' })
    const id = await f.host.createSession('host-cancel')
    await run(f.host, turn(id, 'Wake me.'))
    expect(await f.host.cancelWatcher(id, 'watch-1')).toMatchObject({ watch_id: 'watch-1', state: 'cancelled' })
    await sleep(1800)
    expect(f.requests).toHaveLength(2)
    const history = await f.host.history(id)
    expect(history.events.filter(event => event.type === 'watcher').map(event => event.type === 'watcher' ? event.event : '')).toEqual(['armed', 'cancelled'])
  }, 30000)
})
