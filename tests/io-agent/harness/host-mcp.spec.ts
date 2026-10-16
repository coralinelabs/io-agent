/** MCP servers a host mounts and drops while its engine runs, over the real loop and a real HTTP MCP endpoint. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { mountMcpServer } from "../../../src/library/host/index.ts"
import { onFixtureCleanup, stream, tool } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'

/**
 * A Streamable HTTP MCP endpoint with one `ping` tool, answering JSON (no SSE stream), as many remote servers
 * do; it keeps the Authorization header of every request and the tools it ran.
 */
async function startHttpMcpFixture() {
  const authorization: (string | undefined)[] = [], calls: string[] = []
  const answer = (message: { method: string; params?: { protocolVersion?: string; name?: string } }): unknown => {
    switch (message.method) {
      case 'initialize': return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1.0.0' } }
      case 'tools/list': return { tools: [{ name: 'ping', description: 'Replies pong.', inputSchema: { type: 'object', properties: {} } }] }
      case 'tools/call': calls.push(message.params?.name ?? ''); return { content: [{ type: 'text', text: 'pong' }] }
      case 'ping': return {}
      default: return undefined
    }
  }
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization)
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string } | { id?: number; method: string }[]
      const replies = (Array.isArray(body) ? body : [body]).filter(message => message.id !== undefined).map((message) => {
        const result = answer(message)
        return result === undefined ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } }
          : { jsonrpc: '2.0', id: message.id, result }
      })
      if (!replies.length) { response.writeHead(202).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, authorization, calls,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

describe('MCP servers mounted through the host', () => {
  it('offers a mounted server to the next turn, with its headers, and withdraws it on disposal', async () => {
    const mcp = await startHttpMcpFixture()
    onFixtureCleanup(() => mcp.close())
    const f = await hostFixture((request, response, index) => {
      if (index === 0) {
        expect(JSON.stringify(request.tools)).toContain('mcp__fixture__ping')
        tool(response, 'mcp__fixture__ping', {}, 'ping-1')
      } else stream(response, [{ content: 'It answered pong.' }])
    }, { approval: 'never', sandbox: 'danger-full-access' })
    const id = await f.host.createSession('mcp-mount')
    const mount = mountMcpServer(f.context(), { transport: 'streamable-http', serverName: 'fixture', url: mcp.url,
      headers: { Authorization: 'Bearer fixture-token' } })
    expect(await mount.ready).toEqual({})
    expect(mount.tools()).toEqual(['mcp__fixture__ping'])
    expect(mcp.authorization).toContain('Bearer fixture-token')

    const { activity } = await run(f.host, turn(id, 'Ping the server.'))
    expect(activity.end).toBe('done')
    expect(mcp.calls).toEqual(['ping'])

    await mount.dispose()
    expect(mount.tools()).toEqual([])
    expect(f.context().tools.get('mcp__fixture__ping')).toBeUndefined()
    // a second disposal is the same one
    await mount.dispose()
  }, 30000)

  it('reports a server that refuses the connection, leaves nothing behind, and frees its name', async () => {
    // a server that refuses every request, as one does a missing or wrong token
    const gate = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
    })
    await new Promise<void>(resolve => gate.listen(0, '127.0.0.1', resolve))
    onFixtureCleanup(() => new Promise<void>(resolve => { gate.closeAllConnections(); gate.close(() => resolve()) }))
    const mcp = await startHttpMcpFixture()
    onFixtureCleanup(() => mcp.close())

    const f = await hostFixture(() => { throw new Error('no model call expected') })
    const refused = mountMcpServer(f.context(), { transport: 'streamable-http', serverName: 'gated',
      url: `http://127.0.0.1:${(gate.address() as AddressInfo).port}/mcp`, startupTimeoutMs: 10000 })
    expect((await refused.ready).error).toBeDefined()
    expect(refused.tools()).toEqual([])
    // the name is free again: the same name mounts a server that answers
    const accepted = mountMcpServer(f.context(), { transport: 'streamable-http', serverName: 'gated', url: mcp.url })
    expect(await accepted.ready).toEqual({})
    expect(accepted.tools()).toEqual(['mcp__gated__ping'])
    await refused.dispose()
    expect(accepted.tools()).toEqual(['mcp__gated__ping'])
    await accepted.dispose()
  }, 30000)

  it('refuses a second mount under a name already mounted and keeps the first', async () => {
    const mcp = await startHttpMcpFixture()
    onFixtureCleanup(() => mcp.close())
    const f = await hostFixture(() => { throw new Error('no model call expected') })
    const first = mountMcpServer(f.context(), { transport: 'streamable-http', serverName: 'twice', url: mcp.url })
    expect(await first.ready).toEqual({})
    const second = mountMcpServer(f.context(), { transport: 'streamable-http', serverName: 'twice', url: mcp.url })
    expect((await second.ready).error).toBeDefined()
    expect(first.tools()).toEqual(['mcp__twice__ping'])
    await first.dispose()
  }, 30000)
})
