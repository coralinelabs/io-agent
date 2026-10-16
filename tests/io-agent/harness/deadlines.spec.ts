/** The default runtime gives no call a guessed deadline: only a transport's own failure ends one. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { MAX_TIMER_DELAY_MS } from "../../../src/library/util/timeout/index.ts"
import { fixture, stream, tool } from './fixture.ts'
import { hostFixture } from './host-fixture.ts'

const server = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))

afterEach(() => { vi.restoreAllMocks() })

describe('default runtime deadlines', () => {
  it('gives search, fetch and shell calls no guessed deadline; a long command moves to the background at 60 s', async () => {
    let context: Context | undefined
    await fixture((_q, res) => { stream(res, [{ content: 'Nothing to do.' }]) }, { configure: (ctx) => { context = ctx } })
    for (const name of ['grep', 'glob', 'web_fetch']) expect(context!.tools.get(name)?.timeoutMs, name).toBe(MAX_TIMER_DELAY_MS)
    const providers = (context!.web as unknown as { fetchProviders: Map<string, { limits: { timeoutMs: number } }> }).fetchProviders
    expect([...providers.values()].map(provider => provider.limits.timeoutMs)).toEqual([MAX_TIMER_DELAY_MS])
    expect((context!.shell as unknown as { config: object }).config).toMatchObject({ timeoutMs: 60000, maxTimeoutMs: MAX_TIMER_DELAY_MS })
  })

  it('gives an MCP tool call no deadline unless its server config names one', async () => {
    const callTool = vi.spyOn(Client.prototype, 'callTool')
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-mcp-deadline-'))
    try {
      for (const [config, expected] of [[{}, MAX_TIMER_DELAY_MS], [{ toolCallTimeoutMs: 1234 }, 1234]] as const) {
        callTool.mockClear()
        const { app } = await fixture((_q, res, i) => i === 0
          ? tool(res, 'mcp__fixture__echo', { text: 'DEADLINE_PROBE' }, 'mcp-0')
          : stream(res, [{ content: 'Called.' }]), {
          mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [server, 'normal', join(dir, 'events.jsonl')],
            reconnect: { enabled: false }, ...config }],
        })
        await (await app.createSession()).run('Call the tool.')
        expect(callTool).toHaveBeenCalledOnce()
        expect(callTool.mock.calls[0]![1]).toMatchObject({ timeout: expected })
        await app.close()
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 30000)

  it('lets a host question wait for its answer by default', async () => {
    const f = await hostFixture((_q, res) => { stream(res, [{ content: 'Nothing to do.' }]) }, {}, { interactionTimeoutMs: undefined })
    expect((f.host as unknown as { limits: { interactionTimeoutMs: number } }).limits.interactionTimeoutMs).toBe(2147483647)
  })
})
