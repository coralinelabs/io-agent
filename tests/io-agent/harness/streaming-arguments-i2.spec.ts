/** Large fragmented calls must not repeatedly parse their ever-growing JSON prefix. */
import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { createIoAgent } from '../../../src/index.ts'
import { onFixtureCleanup, RESPONSES_USAGE, responses, routerFixture, stream } from './fixture.ts'

/** Use many real SSE events, not one fully buffered argument event. */
function fragmentedResponses(response: ServerResponse, raw: string): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let sequence = 0
  const send = (type: string, data: Record<string, unknown>): void => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
  }
  const base = { id: 'fc_fragmented', type: 'function_call', call_id: 'call_fragmented', name: 'write' }
  send('response.created', { response: { id: 'resp_fragmented', object: 'response', status: 'in_progress', output: [], usage: null } })
  send('response.output_item.added', { output_index: 0, item: { ...base, arguments: '', status: 'in_progress' } })
  for (let at = 0; at < raw.length; at += 257) {
    send('response.function_call_arguments.delta', { output_index: 0, item_id: base.id, delta: raw.slice(at, at + 257) })
  }
  send('response.function_call_arguments.done', { output_index: 0, item_id: base.id, arguments: raw })
  const item = { ...base, arguments: raw, status: 'completed' }
  send('response.output_item.done', { output_index: 0, item })
  send('response.completed', { response: { id: 'resp_fragmented', object: 'response', status: 'completed',
    output: [item], usage: RESPONSES_USAGE } })
  response.end('data: [DONE]\n\n')
}

describe('bounded parsing of streamed tool arguments', () => {
  for (const api of ['chat-completions', 'responses'] as const) {
    it(`${api}: hundreds of fragments retain exact Unicode/escapes and dispatch once with bounded parse work`, async () => {
      const file = `fragmented-${api}.txt`
      const content = 'Unicode µ😀; quote " slash \\ and newline\n'.repeat(1600)
      const raw = JSON.stringify({ file_path: file, content })
      const prefix = `{"file_path":"${file}","content":`
      const f = await routerFixture((_request, response, index) => {
        if (index === 0) {
          if (api === 'responses') fragmentedResponses(response, raw)
          else {
            const deltas: Record<string, unknown>[] = []
            for (let at = 0; at < raw.length; at += 257) {
              deltas.push({ tool_calls: [{ index: 0, ...(at === 0 ? { id: 'call_fragmented', type: 'function' } : {}),
                function: { ...(at === 0 ? { name: 'write' } : {}), arguments: raw.slice(at, at + 257) } }] })
            }
            stream(response, deltas, 'tool_calls')
          }
        } else if (api === 'responses') responses(response, [{ type: 'message', id: 'msg_done', text: 'Written.' }])
        else stream(response, [{ content: 'Written.' }])
      })
      let executions = 0
      const app = await createIoAgent({ workspace: f.workspace, stateDirectory: f.stateDirectory,
        sandbox: 'danger-full-access', approval: 'never',
        model: { api, baseURL: f.baseURL, model: 'fixture-model', contextWindow: 262144, maxTokens: 32768 },
        configure(ctx) { ctx.on('tools/pre-execute', (call, next) => { if (call.name === 'write') executions++; return next() }) },
      })
      onFixtureCleanup(() => app.close())
      const session = await app.createSession()
      const parse = JSON.parse
      let parsedCharacters = 0
      let parses = 0
      // Count work rather than wall-clock time. Only this call's standalone argument
      // JSON matches; HTTP envelopes, journal records and other tests are excluded.
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        if (typeof text === 'string' && text.startsWith(prefix)) { parsedCharacters += text.length; parses++ }
        return parse(text, reviver)
      })
      try {
        const result = await session.run('Write the supplied file exactly once.')
        expect(result.stopReason).toEqual({ kind: 'completed' })
        expect(result.text).toBe('Written.')
        expect(await readFile(join(f.workspace, file), 'utf8')).toBe(content)
        expect(executions).toBe(1)
        expect(f.requests).toHaveLength(2)
        const events = await session.events()
        const results = events.filter(e => e.type === 'tool/result').map(e => e.data.message)
        expect(results).toHaveLength(1)
        expect(results[0]!).toMatchObject({ role: 'tool', isError: false })
        console.info(JSON.stringify({ api, argumentCharacters: raw.length, fragments: Math.ceil(raw.length / 257), parses, parsedCharacters }))
        // Stream completion, validation, context metering and replay may each parse
        // the final arguments. Their work must not grow with the fragment count.
        expect(parsedCharacters).toBeLessThanOrEqual(raw.length * 12)
      } finally { spy.mockRestore() }
    }, 30000)
  }
})
