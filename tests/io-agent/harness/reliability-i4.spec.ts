/** Default composition: retry barriers, real MCP disconnects, bounded discovery. */
import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolDefinition } from '../../../src/library/tools/index.ts'
import { fixture, stream, tool } from './fixture.ts'

const mcpServer = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))

describe('default runtime reliability', () => {
  it('drains the retry scheduling checkpoint before proceeding on a real HTTP route', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    let phase = ''
    let entered = false
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) {
        response.writeHead(429, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Try again', type: 'rate_limit_error' } }))
      } else stream(response, [{ content: 'Recovered.' }])
    }, { configure(ctx) {
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'llm/retry') phase = 'scheduled'
        if (event.type === 'llm/retry-started') phase = 'started'
      })
      ctx.on('session/flush', () => {
        if (phase !== 'scheduled') return
        entered = true
        return gate.promise
      })
    } })
    const session = await app.createSession()
    const run = session.run('Recover from the transient error.')
    try {
      await vi.waitFor(() => { expect(entered).toBe(true) }, { timeout: 4000 })
      expect(requests).toHaveLength(1)
      gate.resolve()
      await run
      expect(requests).toHaveLength(2)
      const events = await session.events()
      expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
      expect(events.filter(event => event.type === 'llm/retry-started')).toHaveLength(1)
    } finally { gate.resolve(); await run }
  }, 15000)

  it('rejects a disconnected real MCP tool through deferred dispatch while preserving wire schemas', async () => {
    let log = ''
    const { app, requests } = await fixture(async (_request, response, index) => {
      if (index === 0) return tool(response, 'tool_call', { name: 'mcp__offline__exit', arguments: {} }, 'stop-server')
      if (index === 1) {
        await vi.waitFor(async () => {
          expect(await readFile(log, 'utf8')).toContain('"event":"exit"')
        })
        // The transport-owned close signal follows the recorded process exit.
        await new Promise(resolve => setTimeout(resolve, 30))
        return tool(response, 'tool_call', { name: 'mcp__offline__echo', arguments: { text: 'must-not-send' } }, 'stale-call')
      }
      return stream(response, [{ content: 'The connector is offline.' }])
    }, {
      mcpToolSearch: { maxEagerTools: 0, maxEagerSchemaBytes: 0 },
      configure: async (ctx) => {
        // Late installation uses the same public plugin entry as configured MCP servers.
        const { tmpdir } = await import('node:os')
        const { mkdtemp, rm } = await import('node:fs/promises')
        const { onFixtureCleanup } = await import('./fixture.ts')
        const directory = await mkdtemp(join(tmpdir(), 'io-i4-offline-'))
        log = join(directory, 'server.jsonl')
        onFixtureCleanup(() => rm(directory, { recursive: true, force: true }))
        const mcp = await import('../../../src/library/mcp/mcp-client/index.ts')
        await ctx.plugin(mcp, { transport: 'stdio', serverName: 'offline', command: process.execPath,
          args: [mcpServer, 'versioned', log], cwd: '', env: {}, toolCallTimeoutMs: 1000,
          failOnStartupError: true, reconnect: { enabled: false } })
      },
    })
    const result = await (await app.createSession()).run('Stop the connector, then attempt to call it.')
    expect(requests).toHaveLength(3)
    for (const request of requests) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(requests[0]!.tools))
    const stale = result.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'stale-call')
    expect(stale?.type).toBe('tool/result')
    if (stale?.type !== 'tool/result') throw new Error('missing stale tool result')
    expect(stale.data.message.isError).toBe(true)
    expect(JSON.stringify(stale.data.message.content)).toContain('disconnected')
    const calls = (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"event":"tools/call"'))
    expect(calls).toHaveLength(1)
  }, 15000)

  it('keeps discovery small on the provider wire while full schemas remain retrievable', async () => {
    const required = Array.from({ length: 160 }, (_, index) => `field_${index}_${'属性'.repeat(20)}`)
    const definition: ToolDefinition = {
      name: 'mcp__wide__inspect', description: 'Inspect a wide test schema.', deferral: { source: 'wide' },
      parameters: { type: 'object', properties: Object.fromEntries(required.map(name => [name, { type: 'string' }])), required },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => Promise.resolve('not invoked'),
    }
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) return tool(response, 'tool_search', { query: 'inspect' }, 'find-wide')
      return stream(response, [{ content: 'Discovered.' }])
    }, { mcpToolSearch: { maxEagerTools: 0, maxEagerSchemaBytes: 0 }, configure: (ctx) => { ctx.tools.register(definition) } })
    const result = await (await app.createSession()).run('Discover the inspection tool.')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools))
    const search = result.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'find-wide')
    if (search?.type !== 'tool/result') throw new Error('missing search result')
    const text = search.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192)
    expect(text).toContain('mcp__wide__inspect')
    expect(text).toContain('tool_describe')
    expect(JSON.stringify(requests[1]!.messages)).toContain('required (preview)')
  }, 15000)
})
