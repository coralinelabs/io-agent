import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIoAgent } from '../../../src/index.ts'
import SessionQuery from '../../../src/library/session/query/query/index.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fixture, onFixtureCleanup, responses, routerFixture, stream, tool } from './fixture.ts'

const mcpServer = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))

afterEach(() => vi.unstubAllEnvs())
const reply = (_request: unknown, response: Parameters<typeof stream>[0]): void => stream(response, [{ content: 'Done.' }])

describe('default router composition and exact history (real HTTP fixture)', () => {
  it('uses the direct query engine and mounts no provider directory, native extensions, or credential store', async () => {
    const { app, requests } = await fixture(reply, { configure(ctx) {
      expect(ctx.get('credentials')).toBeUndefined()
      expect(ctx.get('deepseekLlmApiExtensions')).toBeUndefined()
      expect(ctx.sessionQuery).toBeInstanceOf(SessionQuery)
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['pluto'])
    } })
    const session = await app.createSession({ id: 'router-default' })
    expect((await session.run('Say done.')).stopReason?.kind).toBe('completed')
    expect(requests).toHaveLength(1)
  }, 30000)

  it('never forwards an unrelated ambient key to an anonymous endpoint', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-ambient-key')
    const { app, headers } = await fixture(reply)
    await (await app.createSession()).run('Say done.')
    expect(headers.map(header => header.authorization)).toEqual(['Bearer EMPTY'])
  }, 30000)

  it('takes the key from the host function on every request, with no credential store or environment lookup', async () => {
    const server = await routerFixture(reply)
    vi.stubEnv('OPENAI_API_KEY', 'wrong-ambient-key')
    let key = '  first-key  '
    const app = await createIoAgent({ ...server, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096,
        apiKey: () => key } })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    expect((await session.run('First.')).stopReason?.kind).toBe('completed')
    key = 'second-key'
    expect((await session.run('Second.')).stopReason?.kind).toBe('completed')
    expect(server.headers.map(header => header.authorization)).toEqual(['Bearer first-key', 'Bearer second-key'])
  }, 30000)

  it('sends a key given by value on the default Responses route', async () => {
    const server = await routerFixture((_request, response) => responses(response, [{ type: 'message', id: 'msg_1', text: 'Done.' }]))
    const app = await createIoAgent({ ...server, sandbox: 'danger-full-access', approval: 'never',
      model: { baseURL: server.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, apiKey: 'value-key' } })
    onFixtureCleanup(() => app.close())
    expect((await (await app.createSession()).run('Say done.')).text).toBe('Done.')
    expect(server.paths).toEqual(['/v1/responses'])
    expect(server.headers.map(header => header.authorization)).toEqual(['Bearer value-key'])
  }, 30000)

  it.each([undefined, '', 'bad\nkey'])('refuses an invalid key from the host function before HTTP dispatch (%s)', async value => {
    const server = await routerFixture(reply)
    vi.stubEnv('OPENAI_API_KEY', 'not-an-authorized-fallback')
    const app = await createIoAgent({ ...server, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096,
        apiKey: () => value as string } })
    onFixtureCleanup(() => app.close())
    const result = await (await app.createSession()).run('Do not send this with a different credential.')
    expect(result.stopReason?.kind).toBe('error')
    expect(server.requests).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain('not-an-authorized-fallback')
  }, 30000)

  it('withholds a function-supplied key from MCP servers started before the first model request', async () => {
    const key = 'sk-getter-held-0123456789'
    vi.stubEnv('ROUTER_CRED', key)
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-mcp-env-'))
    onFixtureCleanup(() => rm(dir, { recursive: true, force: true }))
    const log = join(dir, 'server.jsonl')
    const server = await routerFixture(reply)
    const app = await createIoAgent({ ...server, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, apiKey: () => key },
      mcp: [{ transport: 'stdio', serverName: 'env', command: process.execPath, args: [mcpServer, 'env', log], reconnect: { enabled: false } }] })
    onFixtureCleanup(() => app.close())
    const env = JSON.parse(await readFile(`${log}.env.json`, 'utf8')) as Record<string, string>
    expect(server.requests).toHaveLength(0)
    expect(env.PATH).toBeDefined()
    expect(JSON.stringify(env)).not.toContain(key)
  }, 30000)

  it('keeps the model key out of a tool child environment, whatever variable the host inherited it in', async () => {
    const key = 'sk-held-in-memory-0123456789'
    // Neither name is credential-shaped, so only the value identifies the key.
    vi.stubEnv('ROUTER_CRED', key)
    vi.stubEnv('ROUTER_URL', `https://user:${key}@router.example/v1`)
    vi.stubEnv('HOST_VISIBLE_MARKER', 'marker-visible')
    const server = await routerFixture((_request, response, index) => index === 0
      ? tool(response, 'bash', { command: 'env', description: 'Print the environment' })
      : stream(response, [{ content: 'Done.' }]))
    const app = await createIoAgent({ ...server, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, apiKey: key } })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    expect((await session.run('Print the environment.')).stopReason?.kind).toBe('completed')
    const output = JSON.stringify((await session.events()).filter(event => event.type === 'tool/result'))
    expect(output).toContain('marker-visible')
    expect(output).not.toContain(key)
    expect(server.headers[0]?.authorization).toBe(`Bearer ${key}`)
  }, 30000)
})
