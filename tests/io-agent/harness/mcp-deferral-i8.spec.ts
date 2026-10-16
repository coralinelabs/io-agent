/** MCP tool schemas behind fixed on-demand bridges on the default runtime. */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fixture, onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'
import { createIoAgent } from '../../../src/index.ts'
import type { IoAgentOptions } from '../../../src/index.ts'

const small = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))
const many = fileURLToPath(new URL('./fixtures/mcp-many-i8.mjs', import.meta.url))
const BRIDGES = ['tool_call', 'tool_describe', 'tool_search']

const names = (request: Request): string[] => request.tools!.map(t => t.function.name)
const manyServer = (log?: string): NonNullable<IoAgentOptions['mcp']> =>
  [{ transport: 'stdio', serverName: 'many', command: process.execPath, args: [many, '30', ...log === undefined ? [] : [log]], reconnect: { enabled: false } }]
const text = (content: unknown): string => typeof content === 'string' ? content : JSON.stringify(content)

describe('MCP tool deferral', () => {
  it('leaves a small MCP server byte-identical to mcpToolSearch: false', async () => {
    const boot = async (overrides: Partial<IoAgentOptions>): Promise<{ tools: string; messages: string }> => {
      const { app, workspace, stateDirectory, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), {
        mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [small, 'normal'], reconnect: { enabled: false } }],
        ...overrides,
      })
      await (await app.createSession()).run('Say done.')
      const scrub = (value: string): string => value.replaceAll(workspace, '<workspace>').replaceAll(stateDirectory, '<state>')
      return { tools: JSON.stringify(requests[0]!.tools), messages: scrub(JSON.stringify(requests[0]!.messages)) }
    }
    const deferred = await boot({})
    const eager = await boot({ mcpToolSearch: false })
    expect(deferred.tools).toBe(eager.tools)
    expect(deferred.messages).toBe(eager.messages)
    expect(deferred.tools).toContain('mcp__fixture__echo')
    for (const bridge of BRIDGES) expect(deferred.tools).not.toContain(`"${bridge}"`)
  }, 60000)

  it('serves 30 MCP tools through fixed bridges with the normal approval pipeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-mcp-defer-')), log = join(dir, 'calls.jsonl')
    try {
      const approvals: string[] = []
      const { app, requests } = await fixture((_q, res, i) => {
        if (i === 0) return tool(res, 'tool_search', { query: 'echo 07' }, 'search')
        if (i === 1) return tool(res, 'tool_describe', { names: ['mcp__many__echo_07'] }, 'describe')
        if (i === 2) return tool(res, 'tool_call', { name: 'mcp__many__echo_07', arguments: { text: 'DEFERRED_EVIDENCE' } }, 'call')
        if (i === 3) return tool(res, 'tool_call', { name: 'read', arguments: {} }, 'misroute')
        return stream(res, [{ content: 'Echoed.' }])
      }, {
        approval: 'ask',
        onApproval: async (request) => { approvals.push(request.toolName); return 'allowed-once' },
        mcp: [{ transport: 'stdio', serverName: 'many', command: process.execPath, args: [many, '30', log], reconnect: { enabled: false } }],
        configure: (ctx) => {
          ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'mcp__many__echo_07' ? { kind: 'ask' } : next(), { prepend: true })
        },
      })
      const session = await app.createSession()
      const result = await session.run('Echo DEFERRED_EVIDENCE through echo_07.')

      // One fixed tool list for the whole session: bridges in, MCP schemas out.
      expect(requests).toHaveLength(5)
      for (const request of requests) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(requests[0]!.tools))
      for (const bridge of BRIDGES) expect(names(requests[0]!)).toContain(bridge)
      expect(names(requests[0]!).some(name => name.startsWith('mcp__'))).toBe(false)
      expect(names(requests[0]!)).toContain('read')
      // The catalog travels in the runtime-context snapshot, never in the system prompt.
      const system = requests[0]!.messages.filter(m => m.role === 'system').map(m => text(m.content)).join('\n')
      expect(system).not.toContain('mcp__many__echo_07')
      expect(system).not.toContain('available on demand')
      const snapshot = requests[0]!.messages.filter(m => m.role === 'user').map(m => text(m.content)).find(t => t.includes('available on demand'))
      expect(snapshot).toContain('- many (30): mcp__many__echo_00, mcp__many__echo_01')
      expect(snapshot).toContain('mcp__many__echo_29')

      const results = new Map(result.events.filter(e => e.type === 'tool/result')
        .map(e => [e.data.message.toolCallId as string, e.data.message]))
      const body = (id: string): string => JSON.stringify(results.get(id)?.content)
      expect(results.get('search')?.isError).not.toBe(true)
      expect(body('search')).toMatch(/1 of 1 on-demand tools match \\"echo 07\\":\\n- mcp__many__echo_07 \(many\): Echo the given text/)
      expect(body('describe')).toContain('Parameters (JSON Schema)')
      expect(body('describe')).toContain('The text to echo back verbatim')
      expect(results.get('call')?.isError).not.toBe(true)
      expect(body('call')).toContain('echo_07: DEFERRED_EVIDENCE')
      expect(results.get('misroute')?.isError).toBe(true)
      expect(body('misroute')).toContain('`read` is already in your tool list')

      // Approval ran under the underlying tool's name, exactly once.
      expect(approvals).toEqual(['mcp__many__echo_07'])
      const asked = (await session.events()).filter(e => e.type === 'approval/asked')
      expect(asked.map(e => e.data.toolName)).toEqual(['mcp__many__echo_07'])
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { name: string; arguments: { text: string } })
      expect(calls).toEqual([{ method: 'tools/call', name: 'echo_07', arguments: { text: 'DEFERRED_EVIDENCE' } }])
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 60000)

  it('keeps a latched session byte-identical after resume under raised thresholds', async () => {
    const { requests, workspace, stateDirectory, baseURL } = await routerFixture((_q, res) => stream(res, [{ content: 'Done.' }]))
    const boot = (mcpToolSearch?: IoAgentOptions['mcpToolSearch']) => createIoAgent({ workspace, stateDirectory,
      sandbox: 'danger-full-access', approval: 'never', model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 },
      mcp: manyServer(), ...mcpToolSearch === undefined ? {} : { mcpToolSearch } })
    const first = await boot()
    try { await (await first.createSession({ id: 'latched' })).run('Say done.') } finally { await first.close() }
    // 30 tools no longer cross the thresholds, but the session's logged header already presented the bridges.
    const second = await boot({ maxEagerTools: 64, maxEagerSchemaBytes: 1 << 20 })
    onFixtureCleanup(() => second.close())
    await (await second.resumeSession('latched')).run('Say done again.')
    await (await second.createSession({ id: 'fresh' })).run('Say done.')

    expect(requests).toHaveLength(3)
    const [before, resumed, fresh] = requests as [Request, Request, Request]
    expect(JSON.stringify(resumed.tools)).toBe(JSON.stringify(before.tools))
    for (const bridge of BRIDGES) expect(names(resumed)).toContain(bridge)
    // The whole earlier request, catalog snapshot included, is still the resumed request's prefix.
    expect(JSON.stringify(resumed.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
    const snapshots = resumed.messages.filter(m => m.role === 'user').map(m => text(m.content)).filter(t => t.includes('available on demand'))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toContain('mcp__many__echo_29')
    // A new session under the raised thresholds presents all 30 schemas eagerly.
    expect(names(fresh).filter(name => name.startsWith('mcp__many__'))).toHaveLength(30)
    for (const bridge of BRIDGES) expect(names(fresh)).not.toContain(bridge)
  }, 60000)

  it('reads a bridge name in subagent allowed_tools as the parent\'s on-demand tools', async () => {
    const { app, requests } = await fixture((_q, res, i) => {
      if (i === 0) return tool(res, 'subagent', { description: 'Echo check', prompt: 'Report CHILD_EVIDENCE.', run_in_background: false,
        allowed_tools: ['read', 'tool_search', 'tool_call'] }, 'delegate')
      return stream(res, [{ content: i === 1 ? 'CHILD_EVIDENCE' : 'Parent done.' }])
    }, { mcp: manyServer() })
    const result = await (await app.createSession()).run('Delegate an echo check.')

    const delegated = result.events.find(e => e.type === 'tool/result' && e.data.message.source.callId === 'delegate')
    expect(delegated?.type === 'tool/result' && delegated.data.message.isError).not.toBe(true)
    expect(requests).toHaveLength(3)
    const child = requests[1]!
    expect(names(child)).toContain('read')
    for (const bridge of BRIDGES) expect(names(child)).toContain(bridge)
    expect(names(child)).not.toContain('bash')
    expect(names(child).some(name => name.startsWith('mcp__'))).toBe(false)
    const catalog = child.messages.filter(m => m.role === 'user').map(m => text(m.content)).find(t => t.includes('available on demand'))
    expect(catalog).toContain('mcp__many__echo_29')
    expect(JSON.stringify(requests[2]!.messages)).toContain('CHILD_EVIDENCE')
  }, 60000)

  it('keeps every schema eager above the threshold when mcpToolSearch is false', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), {
      mcpToolSearch: false,
      mcp: [{ transport: 'stdio', serverName: 'many', command: process.execPath, args: [many, '30'], reconnect: { enabled: false } }],
    })
    await (await app.createSession()).run('Say done.')
    expect(names(requests[0]!).filter(name => name.startsWith('mcp__many__'))).toHaveLength(30)
    for (const bridge of BRIDGES) expect(names(requests[0]!)).not.toContain(bridge)
  }, 60000)
})
