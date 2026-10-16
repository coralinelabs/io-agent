import { afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgentOptions, IoAgent } from "../../../src/index.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
export function onFixtureCleanup(fn: () => Promise<unknown>): void { cleanup.push(fn) }
export type Request = {
  model: string
  messages: { role: string; content: unknown; tool_calls?: unknown[] }[]
  tools?: { function: { name: string } }[]
  [key: string]: unknown
}
type RouterFixture = { headers: IncomingHttpHeaders[]; requests: Request[]; paths: string[]; workspace: string; stateDirectory: string; baseURL: string }
type Reply = (request: Request, response: ServerResponse, index: number) => void | Promise<void>
/** OpenAI chat-completions usage object; the default reports a fixed 100-token prompt. */
export type Usage = Record<string, unknown>
const DEFAULT_USAGE: Usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
/**
 * `usage` is the reported usage object, or a prompt token count (raise it to
 * put the session under context pressure) with 10 completion tokens. `null`
 * sends no usage chunk at all, which is how Meta's endpoint ends a stream
 * whose output budget ran out.
 */
export function stream(response: ServerResponse, deltas: Record<string, unknown>[], finish = 'stop', usage: Usage | number | null = DEFAULT_USAGE): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): void => {
    response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  }
  chunk({ role: 'assistant' })
  for (const delta of deltas) chunk(delta)
  chunk({}, finish)
  if (usage === null) {
    response.end('data: [DONE]\n\n')
    return
  }
  response.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [],
    usage: typeof usage === 'number' ? { prompt_tokens: usage, completion_tokens: 10, total_tokens: usage + 10 } : usage })
    + '\n\ndata: [DONE]\n\n')
}
export function tool(response: ServerResponse, name: string, args: object, id = 'call_1', usage?: Usage | number): void {
  const json = JSON.stringify(args), mid = Math.floor(json.length / 2)
  stream(response, [
    { reasoning: 'Need to inspect the workspace.' },
    { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: json.slice(0, mid) } }] },
    { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] },
  ], 'tool_calls', usage)
}
/** Several tool calls in one assistant message (a parallel batch). */
export function tools(response: ServerResponse, calls: readonly (readonly [name: string, args: object, id: string])[], usage?: Usage): void {
  stream(response, [
    { reasoning: 'Need to inspect the workspace.' },
    ...calls.map(([name, args, id], index) => ({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })),
  ], 'tool_calls', usage)
}
/** One output item of a scripted Responses reply. */
export type ResponsesItem =
  | { type: 'reasoning'; id: string; encrypted: string; summary?: string }
  /** Readable reasoning as vLLM streams it: `reasoning_text` deltas, then the text as content, no encrypted content. */
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'function_call'; id: string; callId: string; name: string; arguments: string; namespace?: string }
  | { type: 'message'; id: string; text: string }
/** Responses API usage object; the default reports a fixed 100-token prompt. */
export const RESPONSES_USAGE: Usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 110 }
/**
 * Stream one reply on the Responses protocol, framed like Meta's endpoint
 * (`event:` + `data:` lines, `[DONE]` last): `response.created`, then per item
 * `output_item.added`, its deltas and `output_item.done`, then
 * `response.completed`, or `response.incomplete` with `max_output_tokens`
 * when `incomplete` is set (the cut item's `output_item.done` is never sent).
 */
export function responses(response: ServerResponse, items: readonly ResponsesItem[],
  options: { usage?: Usage; incomplete?: boolean; id?: string } = {}): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let sequence = 0
  const send = (type: string, data: Record<string, unknown>): void => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
  }
  const id = options.id ?? 'resp_fixture'
  send('response.created', { response: { id, object: 'response', status: 'in_progress', output: [], usage: null } })
  const done: Record<string, unknown>[] = []
  items.forEach((item, index) => {
    const cut = options.incomplete === true && index === items.length - 1
    if (item.type === 'reasoning' && 'text' in item) {
      send('response.output_item.added', { output_index: index, item: { id: item.id, type: 'reasoning', summary: [], content: null, encrypted_content: null, status: 'in_progress' } })
      const mid = Math.floor(item.text.length / 2)
      for (const delta of [item.text.slice(0, mid), item.text.slice(mid)]) {
        if (delta.length > 0) send('response.reasoning_text.delta', { output_index: index, item_id: item.id, content_index: 0, delta })
      }
      const full = { id: item.id, type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: item.text }], encrypted_content: null, status: 'completed' }
      if (!cut) { send('response.output_item.done', { output_index: index, item: full }); done.push(full) }
    } else if (item.type === 'reasoning') {
      const summary = item.summary === undefined ? [] : [{ type: 'summary_text', text: item.summary }]
      send('response.output_item.added', { output_index: index, item: { id: item.id, type: 'reasoning', summary: [], status: 'in_progress' } })
      const full = { id: item.id, type: 'reasoning', summary, encrypted_content: item.encrypted, status: 'completed' }
      if (!cut) { send('response.output_item.done', { output_index: index, item: full }); done.push(full) }
    } else if (item.type === 'function_call') {
      const base = { id: item.id, type: 'function_call', call_id: item.callId, name: item.name,
        ...item.namespace === undefined ? {} : { namespace: item.namespace } }
      send('response.output_item.added', { output_index: index, item: { ...base, arguments: '', status: 'in_progress' } })
      const mid = Math.floor(item.arguments.length / 2)
      for (const delta of [item.arguments.slice(0, mid), item.arguments.slice(mid)]) {
        if (delta.length > 0) send('response.function_call_arguments.delta', { output_index: index, item_id: item.id, delta })
      }
      if (!cut) {
        send('response.function_call_arguments.done', { output_index: index, item_id: item.id, arguments: item.arguments })
        const full = { ...base, arguments: item.arguments, status: 'completed' }
        send('response.output_item.done', { output_index: index, item: full })
        done.push(full)
      }
    } else {
      send('response.output_item.added', { output_index: index, item: { id: item.id, type: 'message', role: 'assistant', content: [], status: 'in_progress' } })
      send('response.output_text.delta', { output_index: index, item_id: item.id, content_index: 0, delta: item.text })
      const full = { id: item.id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: item.text, annotations: [] }] }
      if (!cut) { send('response.output_item.done', { output_index: index, item: full }); done.push(full) }
    }
  })
  const usage = options.usage ?? RESPONSES_USAGE
  if (options.incomplete === true) {
    send('response.incomplete', { response: { id, object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: done, usage } })
  } else {
    send('response.completed', { response: { id, object: 'response', status: 'completed', incomplete_details: null, output: done, usage } })
  }
  response.end('data: [DONE]\n\n')
}
export async function routerFixture(reply: Reply): Promise<RouterFixture> {
  const root = await mkdtemp(join(tmpdir(), 'io-agent-headless-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), stateDirectory = join(root, 'state')
  await mkdir(workspace)
  const requests: Request[] = []
  const headers: IncomingHttpHeaders[] = []
  const paths: string[] = []
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.url !== '/v1/chat/completions' && req.url !== '/v1/responses') throw new Error(`unexpected endpoint ${String(req.url)}`)
        // Decode the whole body once: a chunk boundary can fall inside a multi-byte character.
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        const request = JSON.parse(raw) as Request
        requests.push(request)
        headers.push({ ...req.headers })
        paths.push(req.url)
        await reply(request, res, requests.length - 1)
      } catch (error) { res.writeHead(500); res.end(String(error)) }
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing loopback port')
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  return { headers, requests, paths, workspace, stateDirectory, baseURL }
}
export async function fixture(reply: Reply, overrides: Partial<IoAgentOptions> = {}): Promise<RouterFixture & { app: IoAgent }> {
  const { headers, requests, paths, workspace, stateDirectory, baseURL } = await routerFixture(reply)
  const app = await createIoAgent({ workspace, stateDirectory, sandbox: 'danger-full-access', approval: 'never',
    model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 }, ...overrides })
  cleanup.push(() => app.close())
  return { app, headers, requests, paths, workspace, stateDirectory, baseURL }
}
