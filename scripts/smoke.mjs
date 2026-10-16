/** Plain-Node built-library check; deterministic local router, no external model or credentials. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIoAgent } from '../dist/index.js'

const root = await mkdtemp(join(tmpdir(), 'io-agent-built-'))
const workspace = join(root, 'workspace'), stateDirectory = join(root, 'state')
await mkdir(workspace)
await writeFile(join(workspace, 'file.txt'), '\uFEFFone\r\ntwo\nthree\r\nfour')
let requests = 0, app
const server = createServer((req, res) => {
  void (async () => {
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw)
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(body.model, 'fixture')
    const i = requests++
    const instruction = i === 0 ? { name: 'read', arguments: { file_path: 'file.txt' } }
      : i === 1 ? { name: 'edit', arguments: { file_path: 'file.txt', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'three', new_string: 'THREE' }] } }
      // A workflow script runs in the built Node PTC child, the path a source checkout never takes.
      : i === 2 ? { name: 'workflow', arguments: { script: 'return 6 * 7', meta: { name: 'smoke', description: 'Multiply in the child' } } } : null
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    emit({ role: 'assistant' })
    if (instruction) {
      assert(body.tools.some(t => t.function.name === instruction.name))
      emit({ tool_calls: [{ index: 0, id: `call-${i}`, type: 'function', function: { name: instruction.name, arguments: JSON.stringify(instruction.arguments) } }] })
      emit({}, 'tool_calls')
    } else { emit({ content: i === 3 ? 'Changes committed.' : 'Resumed.' }); emit({}, 'stop') }
    res.write('data: ' + JSON.stringify({ id: 'smoke', choices: [], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })().catch(error => { res.destroy(error) })
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const options = { workspace, stateDirectory, sandbox: 'danger-full-access', approval: 'never',
    model: { api: 'chat-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', contextWindow: 32768, maxTokens: 4096 } }
  // Explicitly unconfined test workspace: this does NOT qualify native confinement.
  app = await createIoAgent(options)
  const session = await app.createSession({ id: 'built-smoke' })
  const result = await session.run('Read and edit the first and third words atomically.')
  assert.equal(result.stopReason?.kind, 'completed')
  assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), '\uFEFFONE\r\ntwo\nTHREE\r\nfour')
  const outputs = result.events.filter(e => e.type === 'tool/result')
  assert.equal(outputs.length, 3)
  assert(outputs.every(e => e.data.message.role === 'tool' && e.data.message.isError === false), JSON.stringify(outputs.at(-1)?.data.message.content))
  assert.match(JSON.stringify(outputs[2].data.message.content), /42/)
  await app.close(); app = await createIoAgent(options)
  const resumed = await app.resumeSession('built-smoke')
  assert.equal((await resumed.run('Confirm the resumed session.')).text, 'Resumed.')
  assert.equal(requests, 5)
  console.log(JSON.stringify({ passed: true, requests, checks: ['real tool calls', 'atomic edits', 'built PTC workflow', 'BOM and mixed newlines', 'durable reopen', 'plain Node'] }))
} finally {
  await app?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
