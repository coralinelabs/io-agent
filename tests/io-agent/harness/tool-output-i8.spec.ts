/**
 * Tool-output budgets on the DEFAULT runtime path: a real io-agent runtime
 * (real bash, real skills, real journal and spill store) behind the HTTP/SSE
 * provider fixture. Window-scaled threshold, small preview and per-step budget;
 * one-line stubs; the skill-removed marker and reload; pruning once the prompt
 * cache is presumed cold; the spill sweep under a group-writable umask.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import type { SessionEvent } from "../../../src/library/session/journal/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { fixture, onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'
import { toolOutputBudget } from "../../../src/library/output/policy/budget.ts"
import { hasSpillNotice, spillNoticeOf } from "../../../src/library/output/policy/notice.ts"

/** The fixture routes a 32,768-token window: 19,660 bytes per result, 39,321 per step, 4,000-byte preview. */
const BUDGET = toolOutputBudget(32_768)

/** Text of every tool message in one request, in order. */
function toolContents(request: Request | undefined): string[] {
  return (request?.messages ?? []).filter(message => message.role === 'tool').map(message =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
}

/** One streamed response carrying several tool calls. */
function tools(response: ServerResponse, calls: { name: string; args: object }[]): void {
  stream(response, calls.map((call, index) => ({ tool_calls: [{ index, id: `call_${index + 1}`, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] })), 'tool_calls')
}

function spillPath(text: string): string {
  const notice = spillNoticeOf(text)
  const match = /Full formatted result stored at: (.+?)\. /.exec(notice ?? '')
  if (match?.[1] === undefined) throw new Error(`no spill locator in ${text.slice(-300)}`)
  return match[1]
}

describe('tool output budgets on the default runtime path', () => {
  it('spills a large bash result to a small head/tail preview and keeps read whole', async () => {
    const { app, requests, workspace } = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'bash', { command: 'seq 1 6000', description: 'Print numbers' })
      // An explicit limit reads past io-agent's 16 KB default window, up to the 50 KB cap.
      else if (index === 1) tool(response, 'read', { file_path: 'big.txt', limit: 2000 }, 'call_2')
      else stream(response, [{ content: 'Done.' }])
    })
    const line = 'r'.repeat(49) + '\n'
    await writeFile(join(workspace, 'big.txt'), line.repeat(600))
    const result = await (await app.createSession()).run('Print numbers, then read big.txt.')
    expect(result.stopReason).toEqual({ kind: 'completed' })

    const [spilled] = toolContents(requests[1])
    expect(spilled).toBeDefined()
    expect(hasSpillNotice(spilled!)).toBe(true)
    expect(spilled!.startsWith('1\n2\n3\n')).toBe(true)
    expect(spilled).toContain('5999\n6000\n\n\n(')
    expect(spilled).toContain('Full formatted result stored at:')
    const notice = spillNoticeOf(spilled!)!
    // Preview (4,000 bytes) + separator + notice: far below the per-result threshold.
    expect(Buffer.byteLength(spilled!)).toBeLessThanOrEqual(BUDGET.previewBytes + 2 + Buffer.byteLength(notice))
    const full = await readFile(spillPath(spilled!), 'utf8')
    expect(full).toBe(Array.from({ length: 6000 }, (_, i) => `${i + 1}\n`).join(''))

    const read = toolContents(requests[2])[1]
    expect(read).toBeDefined()
    expect(Buffer.byteLength(read!)).toBeGreaterThan(BUDGET.maxInlineBytes)
    expect(hasSpillNotice(read!)).toBe(false)
    expect(read!.split('r'.repeat(49)).length - 1).toBe(600)
  }, 60000)

  it('spills only the largest result of a step over the per-step budget, before it is sent', async () => {
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) {
        tools(response, [
          { name: 'bash', args: { command: 'yes a | head -c 11000', description: 'Print a' } },
          { name: 'bash', args: { command: 'yes b | head -c 13000', description: 'Print b' } },
          { name: 'bash', args: { command: 'yes c | head -c 17000', description: 'Print c' } },
        ])
      } else stream(response, [{ content: 'Done.' }])
    })
    const session = await app.createSession({ id: 'step-budget' })
    const result = await session.run('Produce three outputs.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(11_000 + 13_000 + 17_000).toBeGreaterThan(BUDGET.stepBudgetBytes)

    const sent = toolContents(requests[1])
    expect(sent).toHaveLength(3)
    expect(sent[0]).toBe('a\n'.repeat(5_500))
    expect(sent[1]).toBe('b\n'.repeat(6_500))
    expect(hasSpillNotice(sent[2]!)).toBe(true)
    expect(Buffer.byteLength(sent[2]!)).toBeLessThan(5_000)

    const events = await session.events()
    const appended = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
    expect(appended.map(event => event.type === 'tool/result'
      ? Buffer.byteLength(JSON.stringify(event.data.message.content)) > 11_000 : false)).toEqual([true, true, true])
    const types = events.map(event => event.type)
    const replaceAt = events.findIndex(event => event.type === 'tool/result' && event.surfaceOp !== 'append')
    expect(replaceAt).toBeGreaterThan(0)
    expect(types[replaceAt - 1]).toBe('compaction/prune')
    expect(types.slice(replaceAt + 1)).toContain('step/end')
    expect(types.indexOf('step/end')).toBeGreaterThan(replaceAt)
    // The rewrite happened before the first send, so no request series was declared.
    expect(events.flatMap(event => event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial'])
    // Nor does io-agent's prefix-break telemetry report one, even at a later header (a resume).
    expect(result.metrics.promptCache.breaks.total).toBe(0)
    await session.close()
    const resumed = await app.resumeSession('step-budget')
    const next = await resumed.run('Again.')
    expect(next.metrics.promptCache).toMatchObject({ resumes: 1, breaks: { total: 0, recent: [] } })
    expect((await resumed.events()).flatMap(event => event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial', 'resume'])
  }, 60000)
})

describe('idle prune with stubs and skill markers on the default runtime path', () => {
  afterEach(() => { vi.useRealTimers() })

  const DEMO_BODY = 'DEMO_SKILL_BODY\n' + 'Follow this demo procedure step by step.\n'.repeat(75)

  /**
   * One run loads the demo skill, prints `seq 1 6000` (over the fixture's
   * per-result threshold, so it is spilled when recorded) and ten 3,000-byte
   * outputs; a second run follows after `idleMinutes`. `reused` gives every
   * call the id `call_1`, as some OpenAI-compatible servers do. `recall: false`
   * composes io-agent without the recall tool.
   */
  async function scenario(idleMinutes: number, ids: 'distinct' | 'reused' = 'distinct',
    options: { recall?: false } = {}): Promise<{ requests: Request[]; events: readonly SessionEvent[] }> {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const id = (distinct: string): string => ids === 'reused' ? 'call_1' : distinct
    const { app, requests, workspace } = await fixture((request, response, index) => {
      if (index === 0) tool(response, 'skill', { name: 'demo' }, id('call_skill'))
      else if (index === 1) tool(response, 'bash', { command: 'seq 1 6000', description: 'Print numbers' }, id('call_bash_1'))
      else if (index <= 11) tool(response, 'bash', { command: `yes ${index} | head -c 3000`, description: 'Print output' }, id(`call_bash_${index}`))
      else if (index === 12) stream(response, [{ content: 'First task done.' }])
      else if (index === 13) tool(response, 'skill', { name: 'demo' }, id('call_reload'))
      else {
        // Follow the recall pointer of the `yes 2` stub, when the idle prune left one.
        const pointer = /yes 2 \| head -c 3000[^\]]*recall seq=(\d+) returns it\./.exec(JSON.stringify(request.messages))
        if (index === 14 && pointer !== null) tool(response, 'recall', { seq: Number(pointer[1]) }, id('call_recall'))
        else stream(response, [{ content: 'Second task done.' }])
      }
    }, { skills: { watch: false }, ...options })
    const directory = join(workspace, '.agents/skills/demo')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: demo\ndescription: Demo procedure.\n---\n${DEMO_BODY}`)
    const session = await app.createSession({ id: `idle-${idleMinutes}-${ids}${options.recall === false ? '-norecall' : ''}` })
    await session.run('Load the demo skill, then produce eleven outputs.')
    expect(requests).toHaveLength(13)
    vi.setSystemTime(Date.now() + idleMinutes * 60_000)
    await session.run('Continue with the demo procedure.')
    return { requests, events: await session.events() }
  }

  it.each(['distinct', 'reused'] as const)(
    'C-7/H-2/H-3 (%s call ids): after an idle hour, results older than 5 groups become stubs, the skill a marker, and reloading returns the body',
    async ids => {
      const { requests, events } = await scenario(61, ids)
      const cold = JSON.stringify(requests[13]!.messages)
      expect(cold).not.toContain('DEMO_SKILL_BODY')
      const contents = toolContents(requests[13])
      // The skill result is the skill-removed marker, never a stub of the call that reused its id.
      expect(contents[0]).toMatch(/^\[Skill "demo" was pruned from context/)
      const stubs = contents.filter(content => content.startsWith('[Pruned older bash result'))
      expect(stubs).toHaveLength(6)
      // The spilled result was only a preview when recorded: the stub says so and keeps the spill notice.
      expect(stubs[0]).toContain('Call: command="seq 1 6000", description="Print numbers". The result\'s inline preview had ')
      expect(stubs[0]).toMatch(/ \(Omitted \d+ bytes\. Full formatted result stored at: .+\)\]$/)
      // No spill notice: the stub names the recall call that returns the full result (recall is on by default).
      for (let index = 2; index <= 6; index += 1) {
        expect(stubs[index - 1]).toContain(`Call: command="yes ${index} | head -c 3000", description="Print output". The result had 1500 lines (3000 characters). `)
        expect(stubs[index - 1]).toMatch(/The full result is kept in the session log; recall seq=\d+ returns it\.\]$/)
      }
      // The newest five tool groups stay verbatim.
      for (let index = 7; index <= 11; index += 1) expect(contents).toContain(`${index}\n`.repeat(3000 / (String(index).length + 1)))
      expect(events.some(event => event.type === 'compaction/summary')).toBe(false)

      // Reloading after the marker returns the full body, not the "unchanged" note.
      const reloaded = toolContents(requests[14]).at(-1)
      expect(reloaded).toContain('DEMO_SKILL_BODY')
      expect(reloaded).not.toContain('is unchanged')

      // The stub's pointer works: recall returns the pruned output in full, from the event the stub named.
      const seq = /recall seq=(\d+) returns it/.exec(stubs[1]!)![1]
      const recalled = toolContents(requests[15]).at(-1)
      expect(recalled).toContain(`#${seq} tool/result bash`)
      expect(recalled).toContain('2\n'.repeat(1500))
      expect(requests).toHaveLength(16)
    }, 90000)

  it('without recall: a stub names the journal event that holds the full result, and no recall call', async () => {
    const { requests, events } = await scenario(61, 'distinct', { recall: false })
    expect(requests.every(request => !(request.tools ?? []).some(tool => tool.function.name === 'recall'))).toBe(true)
    const stubs = toolContents(requests[13]).filter(content => content.startsWith('[Pruned older bash result'))
    expect(stubs).toHaveLength(6)
    for (let index = 2; index <= 6; index += 1) {
      // The generic pointer names the original append, which holds the recorded 3,000 characters.
      const original = events.find(event => event.type === 'tool/result' && event.surfaceOp === 'append'
        && event.data.message.source.callId === `call_bash_${index}`)
      expect(original).toBeDefined()
      expect(stubs[index - 1]).toContain(`Call: command="yes ${index} | head -c 3000", description="Print output". The result had 1500 lines (3000 characters). `)
      expect(stubs[index - 1]!.endsWith(`The full result is kept in the session log as event ${original!.seq}.]`)).toBe(true)
      expect(stubs[index - 1]).not.toContain('recall seq=')
    }
    // Nothing to follow: the reload is answered and the turn ends.
    expect(requests).toHaveLength(15)
  }, 90000)

  it('the read an "unchanged" notice points at stays whole through the idle prune while the notice is recent', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const { app, requests, workspace } = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'read', { file_path: 'notes.txt' }, 'call_read_1')
      else if (index <= 5) tool(response, 'bash', { command: `yes ${index} | head -c 3000`, description: 'Print output' }, `call_bash_${index}`)
      else if (index === 6) tool(response, 'read', { file_path: 'notes.txt' }, 'call_read_2')
      else stream(response, [{ content: `Done ${index}.` }])
    })
    await writeFile(join(workspace, 'notes.txt'), Array.from({ length: 60 }, (_, n) => `NOTE-LINE-${n + 1}: keep the release checklist current.\n`).join(''))
    const session = await app.createSession({ id: 'reread-idle' })
    await session.run('Read notes.txt, produce five outputs, then read notes.txt again.')
    expect(toolContents(requests[7]).at(-1)).toMatch(/^Unchanged: /)
    vi.setSystemTime(Date.now() + 61 * 60_000)
    await session.run('Continue.')

    const after = toolContents(requests[8])
    // The idle prune ran: the oldest output, five groups old, is a stub.
    expect(after[1]).toMatch(/^\[Pruned older bash result to save context\. Call: command="yes 1 \| head -c 3000"/)
    // The first read is six groups old and over 2,048 characters, but the newest group's notice stands for it.
    expect(after[0]).toContain('NOTE-LINE-30: keep the release checklist current.')
    expect(after.at(-1)).toMatch(/^Unchanged: /)
  }, 90000)

  it('a 24-hour cache retention defers the idle prune to a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const router = await routerFixture((_request, response, index) => {
      if (index <= 6) tool(response, 'bash', { command: `yes ${index} | head -c 3000`, description: 'Print output' }, `call_bash_${index}`)
      else stream(response, [{ content: `Done ${index}.` }])
    })
    const app = await createIoAgent({ workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access',
      approval: 'never', model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, cacheRetention: 'long' } })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    await session.run('Produce seven outputs.')
    expect(router.requests[1]).toMatchObject({ prompt_cache_retention: '24h' })
    const pruned = async (): Promise<boolean> => (await session.events()).some(event => event.type === 'compaction/prune')
    // An hour idle: the provider still holds the prefix, so history is not rewritten.
    vi.setSystemTime(Date.now() + 61 * 60_000)
    await session.run('Continue.')
    expect(await pruned()).toBe(false)
    // More than the 1,440-minute lifetime: the faked clock ticks in 20 ms steps, so exactly a day
    // later can read as an idle time equal to the lifetime, which is not past it.
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 + 60_000)
    await session.run('Continue again.')
    expect(await pruned()).toBe(true)
  }, 90000)

  it('without an idle gap nothing is pruned below pressure', async () => {
    const { requests, events } = await scenario(0)
    expect(JSON.stringify(requests[13]!.messages)).toContain('DEMO_SKILL_BODY')
    expect(events.some(event => event.type === 'compaction/prune')).toBe(false)
    expect(toolContents(requests[14]).at(-1)).toContain('is unchanged')
  }, 90000)
})

describe('stubs in a child agent that cannot see recall (default runtime path)', () => {
  const isSummaryRequest = (request: Request): boolean =>
    JSON.stringify(request.messages.at(-1)?.content).includes('compaction engine')
  const names = (request: Request): string[] => (request.tools ?? []).map(entry => entry.function.name)

  it('a subagent whose allowed_tools omit recall gets the generic session-log pointer under pressure', async () => {
    const parent: Request[] = []
    const child: Request[] = []
    const summaries: Request[] = []
    const agents: Agent[] = []
    let context!: Context
    const router = await routerFixture(async (request, res) => {
      if (isSummaryRequest(request)) {
        summaries.push(request)
        return stream(res, [{ content: '## Current Work\n- CHILD-SUMMARY' }])
      }
      if (parent.length === 0 || request.prompt_cache_key === parent[0]!.prompt_cache_key) {
        const index = parent.push(request) - 1
        if (index === 0) return tool(res, 'subagent', { description: 'Build check', prompt: 'CHILD-TASK: build, inspect the sources, then read the service log.',
          run_in_background: false, allowed_tools: ['bash', 'read'] }, 'delegate')
        return stream(res, [{ content: 'Parent done.' }])
      }
      const index = child.push(request) - 1
      if (index === 0) return tool(res, 'bash', { command: 'cat logs/build.log; exit 2', description: 'Build' }, 'call_build')
      if (index <= 5) return tool(res, 'read', { file_path: `src/f${index}.ts` }, `call_read_${index}`)
      if (index === 6) {
        // Size one read so the child's surface crosses its threshold after the pass stubs the build log.
        const agent = agents.find(candidate => candidate.session.id !== agents[0]!.session.id)!
        const tokens = context.tokenMeter.measure(agent.session).totalTokens
        const threshold = context.compaction.thresholdTokens(agent)
        const need = (threshold ?? 0) - tokens + 1500
        if (need < 3200 || need * 4 > 60_000) throw new Error(`cannot size the crossing read: ${tokens} of ${String(threshold)} tokens`)
        const line = 'service=api status=ok elapsed=12ms message="request handled without retry"\n'
        await writeFile(join(router.workspace, 'logs/big.log'), line.repeat(Math.ceil(need * 4 / line.length)))
        // An explicit limit reads past io-agent's 16 KB default window, up to the 50 KB cap.
        return tool(res, 'read', { file_path: 'logs/big.log', limit: 2000 }, 'call_big')
      }
      stream(res, [{ content: 'CHILD-DONE' }])
    })
    const app = await createIoAgent({
      workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 20000, maxTokens: 2048 },
      configure: (ctx) => {
        context = ctx
        ctx.on('agent/created', ({ agent }) => { agents.push(agent) })
      },
    })
    onFixtureCleanup(() => app.close())
    const lines = Array.from({ length: 90 }, (_, n) => `compiling module ${n + 1} of 90 ... ok`)
    await mkdir(join(router.workspace, 'logs'))
    await writeFile(join(router.workspace, 'logs/build.log'), `${lines.join('\n')}\nsrc/app/math.ts(12,5): error TS2322\n`)
    await mkdir(join(router.workspace, 'src'))
    for (let n = 1; n <= 5; n++) {
      await writeFile(join(router.workspace, `src/f${n}.ts`),
        Array.from({ length: 40 }, (_, i) => `export const value${n}_${i} = ${i} // pad\n`).join(''))
    }
    const result = await (await app.createSession()).run('Delegate the build check.')
    expect(result.text).toBe('Parent done.')
    expect(names(parent[0]!)).toContain('recall')
    expect(child.length).toBeGreaterThan(7)
    for (const request of child) expect(names(request)).not.toContain('recall')
    expect(summaries).toHaveLength(1)

    // The pressure pass stubbed the child's build log with the generic pointer to its original append.
    const agent = agents.find(candidate => candidate.session.id !== agents[0]!.session.id)!
    // oxlint-disable-next-line typescript/no-deprecated -- the child session is only reachable through its journal here.
    const events = agent.session.snapshotEvents()
    const original = events.find(event => event.type === 'tool/result' && event.surfaceOp === 'append'
      && event.data.message.source.callId === 'call_build')
    const stub = events.find(event => event.type === 'tool/result' && event.surfaceOp !== 'append'
      && JSON.stringify(event.data.message.content).includes('[Pruned older bash result'))
    expect(original).toBeDefined()
    expect(stub?.type).toBe('tool/result')
    const stubText = stub?.type === 'tool/result'
      ? stub.data.message.content.map(part => part.type === 'text' ? part.text : '').join('') : ''
    expect(stubText.endsWith(`The full result is kept in the session log as event ${original!.seq}.]`)).toBe(true)
    expect(stubText).not.toContain('recall seq=')
    // Nor does the child's checkpoint point at recall.
    const checkpoint = child.map(request => JSON.stringify(request.messages)).find(text => text.includes('<compacted-summary>'))
    expect(checkpoint).toContain('CHILD-SUMMARY')
    expect(checkpoint).not.toContain('## Session Log')
    expect(checkpoint).not.toContain('recall from=')
  }, 90000)
})

describe('spill cleanup under a group-writable umask on the default runtime path', () => {
  it('creates a private state directory, so the startup sweep reclaims an expired spill file', async () => {
    if (process.platform === 'win32') return
    // `su` to a user with a user-private group applies umask 002 (pam_umask with USERGROUPS_ENAB).
    // A 0775 state directory made the sweep skip `<state>/spill` as replaceable by the group.
    const previous = process.umask(0o002)
    try {
      const { app, requests, stateDirectory, workspace, baseURL } = await fixture((_request, response, index) => {
        if (index === 0) tool(response, 'bash', { command: 'seq 1 6000', description: 'Print numbers' })
        else stream(response, [{ content: 'Done.' }])
      })
      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700)
      await (await app.createSession()).run('Print numbers.')
      const spilled = spillPath(toolContents(requests[1])[0]!)
      expect(spilled.startsWith(join(stateDirectory, 'spill'))).toBe(true)
      await app.close()
      const expired = (Date.now() - 31 * 24 * 60 * 60_000) / 1000
      await utimes(spilled, expired, expired)
      // The next runtime on the same state directory sweeps at startup; disposal awaits the sweep.
      const next = await createIoAgent({ workspace, stateDirectory, sandbox: 'danger-full-access', approval: 'never',
        model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 } })
      await next.close()
      expect(existsSync(spilled)).toBe(false)
    } finally {
      process.umask(previous)
    }
  }, 60000)
})
