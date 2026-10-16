import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgentOptions, IoAgent } from "../../../src/index.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
type Request = {
  model: string
  messages: { role: string; content: unknown; tool_calls?: unknown[] }[]
  tools?: { function: { name: string } }[]
  [key: string]: unknown
}
type Reply = (request: Request, response: ServerResponse, index: number) => void | Promise<void>
function stream(response: ServerResponse, deltas: Record<string, unknown>[], finish = 'stop'): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): void => {
    response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  }
  chunk({ role: 'assistant' })
  for (const delta of deltas) chunk(delta)
  chunk({}, finish)
  response.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\ndata: [DONE]\n\n')
}
function tool(response: ServerResponse, name: string, args: object, id = 'call_1'): void {
  const json = JSON.stringify(args), mid = Math.floor(json.length / 2)
  stream(response, [
    { reasoning: 'Need to inspect the workspace.' },
    { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: json.slice(0, mid) } }] },
    { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] },
  ], 'tool_calls')
}
async function fixture(reply: Reply, overrides: Partial<Omit<IoAgentOptions, 'model'>> & { model?: Partial<IoAgentOptions['model']> } = {}): Promise<{
  app: IoAgent
  requests: Request[]
  workspace: string
  stateDirectory: string
  baseURL: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'io-agent-headless-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), stateDirectory = join(root, 'state')
  await mkdir(workspace)
  const requests: Request[] = []
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== '/v1/chat/completions') throw new Error('unexpected endpoint ' + req.url)
      // Decode once: a multi-byte character can straddle two body chunks.
      const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk as Buffer)
      const raw = Buffer.concat(parts).toString('utf8')
      const request = JSON.parse(raw) as Request
      requests.push(request)
      await reply(request, res, requests.length - 1)
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing loopback port')
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  const { model: modelOverrides, ...hostOverrides } = overrides
  const app = await createIoAgent({ workspace, stateDirectory, sandbox: 'danger-full-access', approval: 'never',
    model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, ...modelOverrides }, ...hostOverrides })
  cleanup.push(() => app.close())
  return { app, requests, workspace, stateDirectory, baseURL }
}

describe('full headless runtime through an HTTP/SSE provider fixture (not live inference)', () => {
  it('boots without requesting a model, advertises the coding capabilities, streams and persists one turn', async () => {
    const { app, requests } = await fixture((_req, res) => stream(res, [{ reasoning: 'Thinking.' }, { content: 'Hello from io-agent.' }]))
    expect(requests).toHaveLength(0)
    const session = await app.createSession({ id: 'first' })
    const observed: string[] = []
    session.subscribe((e) => { observed.push(e.type) })
    const result = await session.run('Say hello.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('Hello from io-agent.')
    expect(result.modelContextRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(observed).toContain('stream')
    expect(observed).toContain('event')
    expect(requests).toHaveLength(1)
    // The default effort is explicit, in the standard OpenAI field only.
    expect(requests[0]).toMatchObject({ model: 'fixture-model', max_tokens: 4096, reasoning_effort: 'medium' })
    for (const field of ['chat_template_kwargs', 'thinking', 'reasoning']) expect(requests[0]).not.toHaveProperty(field)
    const tools = requests[0]!.tools!.map(t => t.function.name)
    for (const name of ['read', 'write', 'edit', 'bash', 'subagent', 'subagent_fork', 'todo_write']) expect(tools).toContain(name)
    expect(tools).toContain('ask_user_question') // Continued mode persists a question without a blocking responder.
    expect(tools).not.toContain('web_search')
    expect(await app.listSessions()).toHaveLength(1)
    expect((await session.events()).some(e => e.type === 'turn/end')).toBe(true)
  }, 30000)

  it('executes streamed tool arguments and resumes the same persisted history', async () => {
    const { app, requests, workspace } = await fixture((_req, res, index) => index === 0
      ? tool(res, 'write', { file_path: 'answer.txt', content: '42\n' }) : stream(res, [{ content: 'Verified.' }]))
    const session = await app.createSession({ id: 'write-resume' })
    const result = await session.run('Write answer.txt containing 42.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(await readFile(join(workspace, 'answer.txt'), 'utf8')).toBe('42\n')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.some(m => m.role === 'tool')).toBe(true)
    await session.close()
    const restored = await app.resumeSession('write-resume')
    const previous = (await restored.events()).length
    expect(previous).toBeGreaterThan(5)
    const followup = await restored.run('What did you write?')
    expect(followup.text).toBe('Verified.')
    expect(requests.at(-1)!.messages.some(m => m.role === 'tool')).toBe(true)
    expect((await restored.events()).length).toBeGreaterThan(previous)
  }, 30000)
  it('keeps foreground child-agent calls on the same router connection and returns their result', async () => {
    const { app, requests } = await fixture((_req, res, index) => {
      if (index === 0) tool(res, 'subagent', { description: 'Inspect task', prompt: 'Report CHILD_EVIDENCE.', run_in_background: false })
      else stream(res, [{ content: index === 1 ? 'CHILD_EVIDENCE' : 'Parent finished.' }])
    })
    const session = await app.createSession()
    const result = await session.run('Delegate a short inspection, then report back.')
    expect(result.text).toBe('Parent finished.')
    expect(requests).toHaveLength(3)
    expect(requests.every(r => r.model === 'fixture-model')).toBe(true)
    // Parent and child share the connection's effort, so the request head is the same.
    expect(requests.map(r => r.reasoning_effort)).toEqual(['medium', 'medium', 'medium'])
    expect(JSON.stringify(requests[2]!.messages)).toContain('CHILD_EVIDENCE')
    expect(result.events.filter(e => e.type === 'tool/result').every(e => e.data.message.isError !== true)).toBe(true)
  }, 30000)

  it('sends one stable prompt cache key per session, distinct for other sessions and child agents', async () => {
    const { app, requests } = await fixture((_req, res, index) => {
      if (index === 0) tool(res, 'subagent', { description: 'Inspect task', prompt: 'Report CHILD_EVIDENCE.', run_in_background: false })
      else stream(res, [{ content: index === 1 ? 'CHILD_EVIDENCE' : 'Done.' }])
    })
    const first = await app.createSession({ id: 'cache-first' })
    await first.run('Delegate a short inspection, then report back.')
    await first.run('Continue.')
    const second = await app.createSession({ id: 'cache-second' })
    await second.run('Say done.')
    const keys = requests.map(r => r.prompt_cache_key)
    expect(keys).toHaveLength(5)
    for (const key of keys) expect(key).toMatch(/^pluto-[0-9a-f]{40}$/)
    const [parent, child, parentAgain, parentFollowup, other] = keys
    expect(parentAgain).toBe(parent)
    expect(parentFollowup).toBe(parent)
    expect(child).not.toBe(parent)
    expect(other).not.toBe(parent)
    expect(JSON.stringify(requests)).not.toContain('cache-first')
  }, 30000)

  it('sends the configured reasoning effort and journals it as the adapter default', async () => {
    const { app, requests } = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]), { model: { reasoningEffort: 'low' } })
    const session = await app.createSession()
    await session.run('Say done.')
    await session.run('Say done again.')
    expect(requests.map(r => r.reasoning_effort)).toEqual(['low', 'low'])
    const headers = (await session.events()).filter(e => e.type === 'request/header')
    expect(headers).toHaveLength(1)
    expect(headers[0]!.data.header).toMatchObject({ config: { reasoningEffort: 'low' }, adapterDefaults: { reasoningEffort: true } })
  }, 30000)

  it("journals the default 'medium' effort and sends none at all with reasoningEffort false", async () => {
    const medium = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]))
    const mediumSession = await medium.app.createSession()
    await mediumSession.run('Say done.')
    const [mediumHeader] = (await mediumSession.events()).filter(e => e.type === 'request/header')
    expect(mediumHeader!.data.header).toMatchObject({ config: { reasoningEffort: 'medium' }, adapterDefaults: { reasoningEffort: true } })
    const off = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]), { model: { reasoningEffort: false } })
    const offSession = await off.app.createSession()
    await offSession.run('Say done.')
    expect(off.requests).toHaveLength(1)
    for (const field of ['reasoning_effort', 'reasoning', 'thinking', 'chat_template_kwargs']) expect(off.requests[0]).not.toHaveProperty(field)
    const [offHeader] = (await offSession.events()).filter(e => e.type === 'request/header')
    expect(offHeader!.data.header.config).not.toHaveProperty('reasoningEffort')
    expect(offHeader!.data.header.adapterDefaults?.reasoningEffort).toBeUndefined()
  }, 30000)

  it('omits the prompt cache key when the connection turns it off', async () => {
    const { app, requests } = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]), { model: { promptCacheKey: false } })
    const session = await app.createSession()
    await session.run('Say done.')
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toHaveProperty('prompt_cache_key')
  }, 30000)

  it('uses the same router connection and output budget for compaction', async () => {
    const { app, requests } = await fixture((_req, res, index) => stream(res, [{ content: index < 2 ? 'A'.repeat(2500) : '## Current Work\nRetain the active task.' }]))
    const session = await app.createSession()
    await session.run('First task: ' + 'input '.repeat(300))
    await session.run('Second task: continue while retaining the restrictions.')
    const before = requests.length
    const result = await session.compact()
    expect(result).not.toBeNull()
    expect(requests.length).toBeGreaterThan(before)
    expect(requests.every(r => r.model === 'fixture-model')).toBe(true)
    expect(requests.every(r => !Object.hasOwn(r, 'chat_template_kwargs'))).toBe(true)
    expect(requests.every(r => typeof r.max_tokens === 'number' && r.max_tokens <= 4096)).toBe(true)
    // The summariser keeps the session's effort, so its request head matches the main requests.
    expect(requests.every(r => r.reasoning_effort === 'medium')).toBe(true)
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('compaction engine')
    expect((await session.events()).some(e => e.type === 'compaction/summary')).toBe(true)
  }, 30000)

  it('propagates a human question through the host callback and back to the model', async () => {
    const asked: string[] = []
    const { app, requests } = await fixture((_req, res, index) => index === 0
      ? tool(res, 'ask_user_question', { questions: [{ id: 'choice', question: 'Which branch?', options: [{ label: 'main' }] }] })
      : stream(res, [{ content: 'Using main.' }]), {
      onQuestion: async (request) => { asked.push(request.questions[0]!.id); return { answers: [{ id: 'choice', selected: ['main'] }] } },
    })
    const result = await (await app.createSession()).run('Ask which branch to use.')
    expect(asked).toEqual(['choice']); expect(result.text).toBe('Using main.')
    expect(JSON.stringify(requests[1]!.messages)).toContain('selected')
  }, 30000)

  it('does not invent permission when an escalation has no approval handler', async () => {
    let outside = ''
    const { app, workspace, requests } = await fixture((_req, res, index) => index === 0
      ? tool(res, 'write', { file_path: outside, content: 'must not be written', sandbox_permissions: 'danger-full-access', justification: 'Testing explicit escalation' })
      : stream(res, [{ content: 'Permission unavailable.' }]), { sandbox: 'workspace-write', approval: 'ask' })
    outside = join(workspace, '..', 'outside.txt')
    const result = await (await app.createSession()).run('Try the outside write without a human handler.')
    await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.events.some(e => e.type === 'tool/result' && e.data.message.isError)).toBe(true)
    expect(requests).toHaveLength(2)
  }, 30000)

  it('explicitly cancels an in-flight stream and rejects competing run ownership', async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const { app } = await fixture((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); started()
    })
    const session = await app.createSession()
    const abort = new AbortController()
    const active = session.run('Wait for cancellation.', { signal: abort.signal })
    await ready
    await expect(session.run('Competing owner.')).rejects.toThrow('busy')
    abort.abort()
    const result = await active
    expect(result.stopReason?.kind).toBe('aborted')
    expect(session.status).toBe('idle')
  }, 30000)

  it('does not let a failing or disconnected observer cancel execution', async () => {
    const { app } = await fixture((_req, res) => stream(res, [{ content: 'Still complete.' }]))
    const session = await app.createSession()
    const errors: unknown[] = []
    const off = session.subscribe(async () => { throw new Error('view failed') }, (e) => { errors.push(e) })
    const result = await session.run('Proceed.')
    off(); off()
    expect(result.text).toBe('Still complete.'); expect(errors.length).toBeGreaterThan(0)
    expect((await session.run('Proceed again.')).stopReason).toEqual({ kind: 'completed' })
  }, 30000)

  it('rejects an already-aborted submission before it is admitted', async () => {
    const { app, requests } = await fixture((_req, res) => stream(res, [{ content: 'Unexpected.' }]))
    const session = await app.createSession()
    const before = (await session.events()).length
    const abort = new AbortController(); abort.abort(new Error('cancelled before admission'))
    await expect(session.run('Do not admit.', { signal: abort.signal })).rejects.toThrow('cancelled before admission')
    expect((await session.events()).length).toBe(before); expect(requests).toHaveLength(0)
  }, 30000)

  it('rejects duplicate owners, permits resume only after close, and shuts down idempotently', async () => {
    const { app } = await fixture((_req, res) => stream(res, [{ content: 'Done.' }]))
    const session = await app.createSession({ id: 'unique' })
    await expect(app.createSession({ id: 'unique' })).rejects.toThrow('already open')
    await expect(app.resumeSession('unique')).rejects.toThrow('already open')
    await session.run('Record some history.')
    await session.close(); await session.close()
    await expect(session.run('Closed.')).rejects.toThrow('closed')
    const resumed = await app.resumeSession('unique')
    expect((await resumed.events()).some(e => e.type === 'assistant/message')).toBe(true)
    await app.close(); await app.close()
    expect(() => app.createSession()).toThrow('closed')
  }, 30000)

  it('reports authentication failure as failure, without changing model or retrying a cloud route', async () => {
    const { app, requests } = await fixture((_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture unauthorized' } })) })
    const result = await (await app.createSession()).run('Must fail visibly.')
    expect(result.stopReason?.kind).toBe('error')
    expect(requests).toHaveLength(1)
    expect(result.text).toBe('')
  }, 30000)

  it('surfaces output exhaustion separately from successful completion', async () => {
    const { app, requests } = await fixture((_req, res) => stream(res, [{ content: 'Incomplete output.' }], 'length'))
    const result = await (await app.createSession()).run('A capped response.')
    expect(result.stopReason?.kind).toBe('max-tokens')
    // Two same-budget continuations, each asked for with the output-limit notice, before the turn ends max-tokens.
    expect(requests).toHaveLength(3)
    const notice = (request: Request | undefined): boolean => {
      const last = request?.messages.at(-1)
      return last?.role === 'user' && JSON.stringify(last.content).includes('reached the output token limit')
    }
    expect(requests.map(notice)).toEqual([false, true, true])
    expect(requests.map(r => r.max_tokens)).toEqual([4096, 4096, 4096])
  }, 30000)

  it('does not report durable completion if the final persistence barrier fails', async () => {
    let context!: Parameters<NonNullable<IoAgentOptions['configure']>>[0]
    const { app } = await fixture((_req, res) => stream(res, [{ content: 'Model says done.' }]), { configure: (ctx) => { context = ctx } })
    const session = await app.createSession()
    const original = context.sessionPersistence.flush.bind(context.sessionPersistence)
    context.sessionPersistence.flush = async () => { throw new Error('fixture disk failure') }
    try { await expect(session.run('Do work.')).rejects.toThrow('fixture disk failure') }
    finally { context.sessionPersistence.flush = original }
  }, 30000)

})
