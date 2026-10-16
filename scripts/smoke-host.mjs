/**
 * Built `./host` export check, loaded the way a consumer loads it: through the package name and its
 * `exports` map (Node's self-reference), never a dist path. A deterministic loopback endpoint speaks
 * the default Responses wire with vLLM-style readable reasoning; no external model or credentials.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost, HostError, HOST_EVENT_VERSION, SEQ_BLOCK, journalCursor } from '@coralinelabs/io-agent/host'
import { createIoAgent, createPluto } from '@coralinelabs/io-agent'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
// The packed file list carries the export's code and types.
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageRoot, encoding: 'utf8' }))
const shipped = new Set(packed.files.map(file => file.path))
for (const path of ['dist/library/host/index.js', 'dist/library/host/index.d.ts', 'dist/index.js', 'dist/index.d.ts']) assert(shipped.has(path), `packed files lack ${path}`)
assert.equal(typeof createIoAgent, 'function')
assert.equal(typeof createPluto, 'function') // the one-release alias embedders built against Pluto still import
assert.equal(HOST_EVENT_VERSION, 1)
assert.equal(journalCursor(2), 2 * SEQ_BLOCK)

const root = await mkdtemp(join(tmpdir(), 'io-agent-built-host-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
const bodies = []
const server = createServer((req, res) => {
  void (async () => {
    let raw = ''; for await (const part of req) raw += part
    assert.equal(req.url, '/v1/responses')
    bodies.push(JSON.parse(raw))
    const round = bodies.length
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let sequence = 0
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
    send('response.created', { response: { id: `resp_${round}`, object: 'response', status: 'in_progress', output: [], usage: null } })
    const reasoning = { id: `rs_${round}`, type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: `Round ${round} thinking.` }], encrypted_content: null, status: 'completed' }
    send('response.output_item.added', { output_index: 0, item: { ...reasoning, content: null, status: 'in_progress' } })
    send('response.reasoning_text.delta', { output_index: 0, item_id: reasoning.id, content_index: 0, delta: `Round ${round} thinking.` })
    send('response.output_item.done', { output_index: 0, item: reasoning })
    const message = { id: `msg_${round}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Reply ${round}.`, annotations: [] }] }
    send('response.output_item.added', { output_index: 1, item: { ...message, content: [], status: 'in_progress' } })
    send('response.output_text.delta', { output_index: 1, item_id: message.id, content_index: 0, delta: `Reply ${round}.` })
    send('response.output_item.done', { output_index: 1, item: message })
    send('response.completed', { response: { id: `resp_${round}`, object: 'response', status: 'completed', output: [reasoning, message],
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 132 } } })
    res.end('data: [DONE]\n\n')
  })().catch(error => { res.destroy(error) })
})
let host
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  host = await createHost({ ioAgent: { workspace, stateDirectory: join(root, 'state'), sandbox: 'workspace-write', approval: 'never', skills: false,
    recall: { fullText: true }, model: { baseURL: `http://127.0.0.1:${port}/v1`, model: 'fixture', contextWindow: 32768, maxTokens: 4096, reasoningReplay: 'plain' } } })
  const id = await host.createSession()
  for (const [index, prompt] of ['First question.', 'Second question.'].entries()) {
    const receipt = await host.submit({ session_id: id, turn_id: `built-turn-${index}`, prompt })
    await host.settled(id, receipt.activity_id)
  }
  // Round 2 carried round 1's reasoning by value, as readable text.
  assert.deepEqual(bodies[1].input.find(item => item.type === 'reasoning'), { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'Round 1 thinking.' }] })
  const history = await host.history(id)
  assert.deepEqual(history.events.map(event => event.type), ['turn', 'message', 'usage', 'end', 'turn', 'message', 'usage', 'end'])
  assert.deepEqual(history.events.filter(event => event.type === 'usage').map(({ input, output, reasoning }) => ({ input, output, reasoning })),
    [{ input: 120, output: 12, reasoning: 5 }, { input: 120, output: 12, reasoning: 5 }])
  assert.equal((await host.listSessions())[0].preview, 'Reply 2.')
  assert.equal((await host.search('Second'))[0].session_id, id)
  await assert.rejects(host.submit({ session_id: id, turn_id: 'built-turn-0', prompt: 'Different.' }), error => error instanceof HostError && error.code === 'TURN_CONFLICT')
  await host.deleteSession(id)
  assert.deepEqual(await host.listSessions(), [])
  console.log(JSON.stringify({ passed: true, requests: bodies.length, checks: ['exports map', 'packed files', 'Responses default', 'plain reasoning replay', 'history', 'summary', 'search', 'delete'] }))
} finally {
  await host?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
