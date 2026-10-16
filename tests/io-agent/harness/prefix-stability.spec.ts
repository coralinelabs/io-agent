/**
 * Prompt-prefix stability on the default runtime path: the
 * real router connection, HTTP/SSE provider fixture, journal and plugins.
 * Plan mode is covered for idle switches, a switch inside an open turn and
 * the `exit_plan_mode` approval boundary.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createIoAgent } from '../../../src/index.ts'
import type { IoAgent, IoAgentOptions } from '../../../src/index.ts'
import { modelText } from '../../../src/library/context/text/index.ts'
import { renderContextSnapshot } from '../../../src/library/context/assembly/index.ts'
import * as McpClient from '../../../src/library/mcp/mcp-client/index.ts'
import { onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'

type Overrides = Partial<Omit<IoAgentOptions, 'model'>> & { model?: Partial<IoAgentOptions['model']> }

/** The shared router fixture with the connection fields merged rather than replaced. */
async function fixture(reply: (request: Request, response: ServerResponse, index: number) => void | Promise<void>,
  overrides: Overrides = {}): Promise<Awaited<ReturnType<typeof routerFixture>> & { app: IoAgent }> {
  const router = await routerFixture(reply)
  const { model, ...rest } = overrides
  const app = await createIoAgent({ workspace: router.workspace, stateDirectory: router.stateDirectory,
    sandbox: 'danger-full-access', approval: 'never', ...rest,
    model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, ...model } })
  onFixtureCleanup(() => app.close())
  return { ...router, app }
}

const markerFree = (request: Request): boolean => !JSON.stringify(request).includes('cache_control')

describe('explicit prompt-cache settings on the router connection', () => {
  it('ignores an ambient PI_CACHE_RETENTION: no retention field and never the raw session id as a key', async () => {
    const saved = process.env.PI_CACHE_RETENTION
    process.env.PI_CACHE_RETENTION = 'long'
    try {
      for (const promptCacheKey of [false, true]) {
        const { app, requests } = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]), { model: { promptCacheKey } })
        const id = `raw-session-id-${String(promptCacheKey)}`
        await (await app.createSession({ id })).run('Say done.')
        expect(requests).toHaveLength(1)
        const [request] = requests as [Request]
        expect(request).not.toHaveProperty('prompt_cache_retention')
        expect(markerFree(request)).toBe(true)
        expect(JSON.stringify(request)).not.toContain(id)
        if (promptCacheKey) expect(request.prompt_cache_key).toMatch(/^pluto-[0-9a-f]{40}$/)
        else expect(request).not.toHaveProperty('prompt_cache_key')
        await app.close()
      }
    } finally {
      if (saved === undefined) delete process.env.PI_CACHE_RETENTION
      else process.env.PI_CACHE_RETENTION = saved
    }
  }, 30000)

  it('marks the system prompt, last tool and last message only when the connection opts in', async () => {
    const { app, requests } = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]),
      { model: { cacheControlFormat: 'anthropic' } })
    await (await app.createSession()).run('Say done.')
    const [request] = requests as [Request]
    const system = request.messages[0]!
    expect(system.role).toBe('system')
    expect(system.content).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral' } }])
    expect(request.tools!.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect((request.tools!.slice(0, -1) as object[]).every(entry => !('cache_control' in entry))).toBe(true)
    const last = request.messages.at(-1)!
    const parts = last.content as { type: string; cache_control?: unknown }[]
    expect(parts.findLast(part => part.type === 'text')?.cache_control).toEqual({ type: 'ephemeral' })
    // Exactly three markers: system, last tool, last conversation message.
    expect(JSON.stringify(request).match(/"cache_control"/g)).toHaveLength(3)
    expect(request).not.toHaveProperty('prompt_cache_retention')
  }, 30000)

  it('sends long retention with the hashed session key, and no key or markers when caching is off', async () => {
    const long = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]),
      { model: { cacheControlFormat: 'anthropic', cacheRetention: 'long' } })
    const id = 'raw-long-retention-session'
    await (await long.app.createSession({ id })).run('Say done.')
    const [request] = long.requests as [Request]
    expect(request.prompt_cache_retention).toBe('24h')
    expect(request.prompt_cache_key).toMatch(/^pluto-[0-9a-f]{40}$/)
    expect(JSON.stringify(request)).not.toContain(id)
    expect(request.tools!.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral', ttl: '1h' } })

    const none = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]),
      { model: { cacheControlFormat: 'anthropic', cacheRetention: 'none' } })
    await (await none.app.createSession()).run('Say done.')
    const [off] = none.requests as [Request]
    expect(off).not.toHaveProperty('prompt_cache_key')
    expect(off).not.toHaveProperty('prompt_cache_retention')
    expect(markerFree(off)).toBe(true)
  }, 30000)
})

type IoAgentContext = Parameters<NonNullable<IoAgentOptions['configure']>>[0]
type RootAgent = Parameters<IoAgentContext['planMode']['set']>[0]

/** Flatten one wire message's text, whichever content shape pi-ai used. */
function wireText(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  return Array.isArray(message.content)
    ? (message.content as { type?: string; text?: string }[]).map(part => part.type === 'text' ? part.text ?? '' : '').join('')
    : ''
}

const SNAPSHOT = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const PLAN_GUIDANCE = modelText('system/plan-mode')
const PLAN_ON = 'The user switched this session to plan mode.'
const PLAN_OFF = 'The user switched this session back to the default mode.'

/** Every request after the first keeps the previous request's tools, system head and messages byte-for-byte. */
function expectPrefixKept(requests: readonly Request[]): void {
  for (let i = 1; i < requests.length; i++) {
    const previous = requests[i - 1]!, next = requests[i]!
    expect(next.tools).toEqual(requests[0]!.tools)
    expect(next.messages[0]).toEqual(requests[0]!.messages[0])
    expect(next.messages.length).toBeGreaterThan(previous.messages.length)
    expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
  }
}

/** The runtime-context snapshots among one request's user messages, in order. */
function snapshots(request: Request): string[] {
  return request.messages.filter(message => message.role === 'user').map(wireText).filter(text => text.startsWith(SNAPSHOT))
}

/** Capture the root agent and the runtime context through the public configure hook. */
function capture(): { configure: (context: IoAgentContext) => void; ctx: () => IoAgentContext; agent: () => RootAgent } {
  let ctx: IoAgentContext | undefined, agent: RootAgent | undefined
  return {
    configure: (context) => {
      ctx = context
      context.on('agent/created', ({ agent: created }) => { if (created.session.header.parentSession === undefined) agent ??= created })
    },
    ctx: () => ctx!,
    agent: () => agent!,
  }
}

describe('plan mode keeps the cached prompt prefix', () => {
  it('keeps tools and the system message byte-identical and history append-only across plan-mode toggles', async () => {
    const seen = capture()
    const { app, requests, workspace } = await fixture((_req, res, index) => index === 0
      ? tool(res, 'read', { file_path: 'notes.txt' })
      : stream(res, [{ content: `Reply ${index}.` }]), { configure: seen.configure })
    await writeFile(join(workspace, 'notes.txt'), 'alpha\nbeta\n')
    const session = await app.createSession()
    await session.run('Read notes.txt.')
    expect(seen.ctx().planMode.set(seen.agent(), true)).toBe('committed')
    // An idle toggle leaves the session idle: run() is accepted immediately.
    expect(session.busy).toBe(false)
    await session.run('Plan a third line.')
    await session.run('Name one risk.')
    expect(seen.ctx().planMode.set(seen.agent(), false)).toBe('committed')
    expect(session.busy).toBe(false)
    await session.run('Done?')
    expect(requests).toHaveLength(5)

    expectPrefixKept(requests)
    for (const request of requests) expect(wireText(request.messages[0]!)).not.toContain(PLAN_GUIDANCE)
    // Default mode first: the snapshot carries sandbox/approval policy only.
    expect(snapshots(requests[1]!).every(text => !text.includes(PLAN_GUIDANCE))).toBe(true)
    // The toggle appends (after the previous reply and the prompt) a snapshot
    // with the guidance, then one notice.
    const planTail = requests[2]!.messages.slice(requests[1]!.messages.length).map(wireText)
    expect(planTail).toEqual(['Reply 1.', 'Plan a third line.', expect.stringContaining(PLAN_GUIDANCE), PLAN_ON])
    expect(planTail[2]!.startsWith(SNAPSHOT)).toBe(true)
    // Unchanged mode: nothing new beyond the prompt and the model's reply.
    const steadyTail = requests[3]!.messages.slice(requests[2]!.messages.length).map(wireText)
    expect(steadyTail.at(-1)).toBe('Name one risk.')
    expect(steadyTail.some(text => text.startsWith(SNAPSHOT) || text === PLAN_ON)).toBe(false)
    // Leaving appends a snapshot without the guidance, then one notice.
    const last = requests[4]!
    expect(snapshots(last).at(-1)).not.toContain(PLAN_GUIDANCE)
    const texts = last.messages.map(wireText)
    expect(texts.filter(text => text === PLAN_ON)).toHaveLength(1)
    expect(texts.filter(text => text === PLAN_OFF)).toHaveLength(1)
    expect(texts.at(-1)).toBe(PLAN_OFF)

    const events = await session.events()
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'plan/mode').map(event => event.data.active)).toEqual([true, false])
  }, 30000)

  it('re-emits the plan guidance after compaction under the same system head', async () => {
    const seen = capture()
    const compacting = (req: Request): boolean => JSON.stringify(req.messages.at(-1)?.content).includes('compaction engine')
    const { app, requests } = await fixture((req, res, index) => {
      stream(res, [{ content: compacting(req) ? '## Current Work\nPlan the change.' : index < 2 ? 'A'.repeat(2500) : `Reply ${index}.` }])
    }, { configure: seen.configure })
    const session = await app.createSession()
    await session.run('First task: ' + 'input '.repeat(300))
    seen.ctx().planMode.set(seen.agent(), true)
    await session.run('Second task: plan it.')
    expect(await session.compact()).not.toBeNull()
    await session.run('Continue planning.')
    expect(requests.some(compacting)).toBe(true)
    const agentRequests = requests.filter(request => !compacting(request))
    const last = agentRequests.at(-1)!
    expect(last.tools).toEqual(agentRequests[0]!.tools)
    expect(last.messages[0]).toEqual(agentRequests[0]!.messages[0])
    expect(wireText(last.messages[0]!)).not.toContain(PLAN_GUIDANCE)
    const texts = last.messages.map(wireText)
    const summary = texts.findIndex(text => text.includes('Plan the change.'))
    const guidance = texts.findLastIndex(text => text.startsWith(SNAPSHOT) && text.includes(PLAN_GUIDANCE))
    expect(summary).toBeGreaterThan(0)
    expect(guidance).toBeGreaterThan(summary)
    const events = await session.events()
    const heads = events.filter(event => event.type === 'system/message')
    expect(heads.every(event => !wireText(event.data.message).includes(PLAN_GUIDANCE))).toBe(true)
  }, 30000)

  it('leaves plan mode on an approved exit_plan_mode with a snapshot after the tool result and no switch notice', async () => {
    const seen = capture()
    const asked: string[] = []
    const { app, requests } = await fixture((_req, res, index) => index === 1
      ? tool(res, 'exit_plan_mode', { plan: '# Plan\n\n1. Add a third line.' }, 'exit-plan')
      : stream(res, [{ content: `Reply ${index}.` }]), {
      configure: seen.configure,
      onQuestion: async (request) => {
        asked.push(...request.questions.map(question => question.id))
        return { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
      },
    })
    const session = await app.createSession()
    await session.run('Look around.')
    expect(seen.ctx().planMode.set(seen.agent(), true)).toBe('committed')
    await session.run('Plan a third line, then ask for review.')
    await session.run('Go ahead.')
    expect(requests).toHaveLength(4)
    expect(asked).toEqual(['plan-review'])

    expectPrefixKept(requests)
    const tail = (index: number): Request['messages'] => requests[index]!.messages.slice(requests[index - 1]!.messages.length)
    expect(tail(1).map(wireText)).toEqual(['Reply 0.', 'Plan a third line, then ask for review.',
      expect.stringContaining(PLAN_GUIDANCE), PLAN_ON])
    // Approval: the call, its result, then a snapshot without the guidance.
    // The tool result narrates the transition, so no notice follows.
    const approved = tail(2)
    expect(approved.map(message => message.role)).toEqual(['assistant', 'tool', 'user'])
    expect(wireText(approved[2]!).startsWith(SNAPSHOT)).toBe(true)
    expect(wireText(approved[2]!)).not.toContain(PLAN_GUIDANCE)
    // The next turn has nothing to narrate: the mode the model was told is in force.
    expect(tail(3).map(wireText)).toEqual(['Reply 2.', 'Go ahead.'])
    const texts = requests[3]!.messages.map(wireText)
    expect(texts.filter(text => text === PLAN_ON)).toHaveLength(1)
    expect(texts.filter(text => text === PLAN_OFF)).toHaveLength(0)
    expect(snapshots(requests[3]!).at(-1)).not.toContain(PLAN_GUIDANCE)

    const events = await session.events()
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'plan/mode').map(event => event.data.active)).toEqual([true, false])
  }, 30000)

  it('applies a switch made while a turn is open after the tool result, then narrates it once', async () => {
    const seen = capture()
    const outcomes: string[] = []
    const { app, requests, workspace } = await fixture((_req, res, index) => {
      if (index === 0) {
        // The turn is open while its first request is in flight.
        outcomes.push(seen.ctx().planMode.set(seen.agent(), true))
        tool(res, 'read', { file_path: 'notes.txt' })
      } else stream(res, [{ content: `Reply ${index}.` }])
    }, { configure: seen.configure })
    await writeFile(join(workspace, 'notes.txt'), 'alpha\nbeta\n')
    const session = await app.createSession()
    await session.run('Read notes.txt.')
    await session.run('Continue.')
    expect(outcomes).toEqual(['queued'])
    expect(requests).toHaveLength(3)

    expectPrefixKept(requests)
    const switched = requests[1]!.messages.slice(requests[0]!.messages.length)
    expect(switched.map(message => message.role)).toEqual(['assistant', 'tool', 'user', 'user'])
    expect(wireText(switched[1]!)).toContain('alpha')
    expect(wireText(switched[2]!).startsWith(SNAPSHOT)).toBe(true)
    expect(wireText(switched[2]!)).toContain(PLAN_GUIDANCE)
    expect(wireText(switched[3]!)).toBe(PLAN_ON)
    // Unchanged mode on the next turn: only the reply and the prompt.
    expect(requests[2]!.messages.slice(requests[1]!.messages.length).map(wireText)).toEqual(['Reply 1.', 'Continue.'])

    const events = await session.events()
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'plan/mode').map(event => event.data.active)).toEqual([true])
  }, 30000)
})

const MCP_SERVER = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
/** Process ids of every fixture server process the log saw start. */
async function startedPids(log: string): Promise<number[]> {
  return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number })
    .filter(entry => entry.event === 'start').map(entry => entry.pid)
}
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'io-agent-prefix-mcp-'))
  onFixtureCleanup(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const toolNames = (request: Request): string[] => (request.tools ?? []).map(entry => entry.function.name)

describe('MCP servers keep the cached prompt prefix', () => {
  it('connects before the first request: every request carries the same MCP tools and system head', async () => {
    const log = join(await scratch(), 'events.jsonl')
    const { app, requests } = await fixture((_req, res, index) => index === 0
      ? tool(res, 'mcp__fixture__echo', { text: 'MCP_PREFIX_ECHO' }, 'mcp-echo')
      : stream(res, [{ content: `Reply ${index}.` }]), {
      mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [MCP_SERVER, 'normal', log], reconnect: { enabled: false } }],
    })
    const session = await app.createSession()
    await session.run('Echo once.')
    await session.run('Again, without tools.')
    expect(requests).toHaveLength(3)
    expect(toolNames(requests[0]!)).toContain('mcp__fixture__echo')
    expect(wireText(requests[0]!.messages[0]!)).toContain('MCP_ATTRIBUTED_INSTRUCTION_45')
    expectPrefixKept(requests)
    const events = await session.events()
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
  }, 30000)

  it('keeps the first instructions in the system head and appends a superseding snapshot after a reconnect with new text', async () => {
    const log = join(await scratch(), 'events.jsonl')
    const seen = capture()
    const { app, requests } = await fixture((_req, res, index) => index === 0
      ? tool(res, 'mcp__fixture__exit', {}, 'mcp-exit')
      : stream(res, [{ content: `Reply ${index}.` }]), {
      configure: seen.configure,
      mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [MCP_SERVER, 'versioned', log],
        reconnect: { initialDelayMs: 10 } }],
    })
    const session = await app.createSession()
    await session.run('Stop the server.')
    // The server exits after its reply; wait until its replacement generation is published.
    await vi.waitFor(async () => {
      expect(renderContextSnapshot(await seen.ctx().systemPrompt.assemble())).toContain('MCP_INSTRUCTION_V2')
    }, { timeout: 10000, interval: 20 })
    await session.run('Continue.')
    expect(requests).toHaveLength(3)
    expect(toolNames(requests[0]!)).toEqual(expect.arrayContaining(['mcp__fixture__echo', 'mcp__fixture__exit']))
    expectPrefixKept(requests)
    const head = wireText(requests[0]!.messages[0]!)
    expect(head).toContain('MCP_INSTRUCTION_V1')
    expect(head).not.toContain('MCP_INSTRUCTION_V2')
    const update = modelText('mcp/server-instructions-updated', { name: 'fixture',
      instructions: modelText('mcp/server-instructions', { name: 'fixture', instructions: 'MCP_INSTRUCTION_V2' }) })
    const last = requests.at(-1)!
    expect(snapshots(last).at(-1)).toContain(update)
    expect(last.messages.filter(message => message.role === 'system')).toHaveLength(1)
    const events = await session.events()
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
  }, 30000)

  it('a late server with instructions but no tools extends the request byte for byte and records no break', async () => {
    const dir = await scratch()
    const seen = capture()
    const { app, requests, workspace } = await fixture((_req, res, index) => stream(res, [{ content: `Reply ${index}.` }]), {
      configure: seen.configure,
      mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [MCP_SERVER, 'normal', join(dir, 'a.jsonl')],
        reconnect: { enabled: false } }],
    })
    const session = await app.createSession()
    await session.run('First.')
    await seen.ctx().plugin(McpClient, { transport: 'stdio', serverName: 'quiet', command: process.execPath,
      args: [MCP_SERVER, 'no-tools', join(dir, 'b.jsonl')], cwd: workspace, failOnStartupError: true, reconnect: { enabled: false } }).await()
    const result = await session.run('Second.')
    expect(requests).toHaveLength(2)
    // The late server's first instructions must not rewrite the system head here.
    expectPrefixKept(requests)
    expect(wireText(requests[1]!.messages[0]!)).not.toContain('MCP_NO_TOOLS_INSTRUCTION')
    const snapshot = snapshots(requests[1]!).at(-1)
    expect(snapshot).toContain(modelText('mcp/server-instructions-updated', { name: 'quiet',
      instructions: modelText('mcp/server-instructions', { name: 'quiet', instructions: 'MCP_NO_TOOLS_INSTRUCTION' }) }))
    expect(snapshot).toContain(modelText('mcp/resource-servers-updated', { servers: JSON.stringify(['fixture', 'quiet']) }))
    expect(result.metrics.promptCache.breaks.total).toBe(0)
    const events = await session.events()
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
  }, 30000)

  it('late tools are appended, and a resumed session keeps the head it recorded while a new session shows the server', async () => {
    const dir = await scratch()
    const seen = capture()
    const router = await routerFixture((_req, res, index) => stream(res, [{ content: `Reply ${index}.` }]))
    const options = (extra: Overrides = {}): IoAgentOptions => ({ workspace: router.workspace, stateDirectory: router.stateDirectory,
      sandbox: 'danger-full-access', approval: 'never', ...extra,
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 } })
    const server = { transport: 'stdio' as const, serverName: 'fixture', command: process.execPath, args: [MCP_SERVER, 'normal', join(dir, 'events.jsonl')],
      reconnect: { enabled: false } }
    const first = await createIoAgent(options({ configure: seen.configure }))
    onFixtureCleanup(() => first.close())
    const session = await first.createSession({ id: 'late-resume' })
    await session.run('First.')
    await seen.ctx().plugin(McpClient, { ...server, cwd: router.workspace, failOnStartupError: true }).await()
    await session.run('Second.')
    const { requests } = router
    // The late tools follow the previous list; nothing moved.
    const before = toolNames(requests[0]!), after = toolNames(requests[1]!)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.slice(before.length)).toEqual(['list_mcp_resource_templates', 'list_mcp_resources', 'mcp__fixture__echo', 'read_mcp_resource'])
    expect(requests[1]!.messages[0]).toEqual(requests[0]!.messages[0])
    expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(requests[0]!.messages)
    await first.close()

    // A new process starts the server before any session; the resumed session keeps its recorded head and tool order.
    const second = await createIoAgent(options({ mcp: [server] }))
    onFixtureCleanup(() => second.close())
    const resumed = await second.resumeSession('late-resume')
    const result = await resumed.run('Third.')
    expect(requests[2]!.tools).toEqual(requests[1]!.tools)
    expect(requests[2]!.messages[0]).toEqual(requests[0]!.messages[0])
    expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual(requests[1]!.messages)
    expect(wireText(requests[2]!.messages[0]!)).not.toContain('MCP_ATTRIBUTED_INSTRUCTION_45')
    expect(result.metrics.promptCache.breaks.recent.map(entry => entry.causes)).toEqual([['tools']])
    expect(result.metrics.promptCache.breaks.byCause.system ?? 0).toBe(0)
    const fresh = await second.createSession()
    await fresh.run('Hello.')
    expect(wireText(requests[3]!.messages[0]!)).toContain('MCP_ATTRIBUTED_INSTRUCTION_45')
  }, 30000)

  it('a server whose text changed between processes keeps the recorded head and states the new text as context', async () => {
    const dir = await scratch()
    const router = await routerFixture((_req, res, index) => stream(res, [{ content: `Reply ${index}.` }]))
    const options = (): IoAgentOptions => ({ workspace: router.workspace, stateDirectory: router.stateDirectory,
      sandbox: 'danger-full-access', approval: 'never',
      // Each serving connection of the versioned server publishes the next version (V1, V2, ...).
      mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [MCP_SERVER, 'versioned', join(dir, 'events.jsonl')],
        reconnect: { enabled: false } }],
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 } })
    const first = await createIoAgent(options())
    onFixtureCleanup(() => first.close())
    await (await first.createSession({ id: 'versioned-resume' })).run('First.')
    await first.close()
    const second = await createIoAgent(options())
    onFixtureCleanup(() => second.close())
    const result = await (await second.resumeSession('versioned-resume')).run('Second.')
    const { requests } = router
    expect(wireText(requests[0]!.messages[0]!)).toContain('MCP_INSTRUCTION_V1')
    // The resumed head is not rewritten with V2 (that would be a `system` break).
    expect(requests[1]!.messages[0]).toEqual(requests[0]!.messages[0])
    expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(requests[0]!.messages)
    expect(snapshots(requests[1]!).at(-1)).toContain(modelText('mcp/server-instructions-updated', { name: 'fixture',
      instructions: modelText('mcp/server-instructions', { name: 'fixture', instructions: 'MCP_INSTRUCTION_V2' }) }))
    expect(result.metrics.promptCache.breaks.total).toBe(0)
    await (await second.createSession()).run('Hello.')
    expect(wireText(requests[2]!.messages[0]!)).toContain('MCP_INSTRUCTION_V2')
  }, 30000)

  it('bounds startup: a hanging server fails createIoAgent by name and is reaped, or is skipped when optional', async () => {
    const dir = await scratch()
    const fatal = join(dir, 'fatal.jsonl'), optional = join(dir, 'optional.jsonl')
    const reply = (_req: Request, res: ServerResponse): void => { stream(res, [{ content: 'No MCP tools.' }]) }
    await expect(fixture(reply, {
      mcp: [{ transport: 'stdio', serverName: 'hang', command: process.execPath, args: [MCP_SERVER, 'hang', fatal],
        startupTimeoutMs: 300, reconnect: { enabled: false } }],
    })).rejects.toThrow('startup did not finish within 300 ms (startupTimeoutMs)')
    const fatalPids = await startedPids(fatal)
    expect(fatalPids.length).toBeGreaterThan(0)
    expect(fatalPids.every(pid => !alive(pid))).toBe(true)

    const { app, requests } = await fixture(reply, {
      mcp: [{ transport: 'stdio', serverName: 'hang', command: process.execPath, args: [MCP_SERVER, 'hang', optional],
        startupTimeoutMs: 300, failOnStartupError: false, reconnect: { enabled: false } }],
    })
    await (await app.createSession()).run('Anything there?')
    expect(toolNames(requests[0]!).some(name => name.startsWith('mcp__'))).toBe(false)
    await app.close()
    const optionalPids = await startedPids(optional)
    expect(optionalPids.length).toBeGreaterThan(0)
    expect(optionalPids.every(pid => !alive(pid))).toBe(true)
  }, 30000)
})
