/**
 * The opt-in Responses transport on the DEFAULT runtime path: a real io-agent
 * runtime behind an HTTP/SSE fixture that speaks `/v1/responses` framed like
 * Meta's endpoint (two encrypted reasoning items per response, `fc_` ids,
 * composite `rs_x:rs_y` reasoning ids). Encrypted reasoning must be replayed
 * by value across steps and across a resume, dropped with a warning when the
 * model or protocol changes, and never sent as `effort: 'none'`.
 */
import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgent, IoAgentOptions } from "../../../src/index.ts"
import type { Message as LogMessage } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { derivePromptCacheKey } from "../../../src/library/model/pi-ai/prompt-cache-key.ts"
import { modelText } from "../../../src/library/context/text/index.ts"
import { onFixtureCleanup, responses, routerFixture, stream } from './fixture.ts'
import type { Request, ResponsesItem } from './fixture.ts'

type Item = Record<string, unknown>
type Reply = (request: Request, response: ServerResponse, index: number) => void | Promise<void>

const inputOf = (request: Request | undefined): Item[] => (request?.['input'] as Item[] | undefined) ?? []
const reasoningOf = (request: Request | undefined): Item[] => inputOf(request).filter(item => item['type'] === 'reasoning')
const R = (n: number): ResponsesItem => ({ type: 'reasoning', id: `rs_resp${n}:rs_${n}`, encrypted: `ENC-${n}-${'x'.repeat(40)}` })
const byValue = (n: number): Item => ({ type: 'reasoning', summary: [], encrypted_content: `ENC-${n}-${'x'.repeat(40)}` })

/** Boot io-agent on the Responses route against a scripted fixture; `model` merges over the fixture route. */
async function responsesFixture(reply: Reply, model: Partial<IoAgentOptions['model']> = {},
  host: Partial<Omit<IoAgentOptions, 'model'>> = {}) {
  const router = await routerFixture(reply)
  const warnings: LogMessage[] = []
  const boot = async (connection: Partial<IoAgentOptions['model']>): Promise<IoAgent> => {
    const app = await createIoAgent({ workspace: router.workspace, stateDirectory: router.stateDirectory,
      sandbox: 'danger-full-access', approval: 'never', ...host,
      model: { baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, api: 'responses', ...connection },
      configure: (ctx) => {
        // Warnings sit below the default export level, so collect them explicitly.
        ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { if (message.type === 'warn') warnings.push(message) } })
      } })
    onFixtureCleanup(() => app.close())
    return app
  }
  return { ...router, app: await boot(model), boot, warnings }
}

const degraded = (warnings: LogMessage[]): string[] => warnings
  .filter(message => String(message.args[0]).includes('Model history replay degraded'))
  .map(message => JSON.stringify(message.args[1]))

describe('opt-in Responses transport on the default runtime path', () => {
  it("sends store:false, reasoning {medium, auto}, encrypted reasoning, one hashed key, and never 'none' or a raw session id", async () => {
    const f = await responsesFixture((_request, response) => responses(response, [R(1), R(2), { type: 'message', id: 'msg_1', text: 'Hello.' }]))
    const session = await f.app.createSession({ id: 'resp-wire-session' })
    const result = await session.run('Say hello.')
    await session.run('Again.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('Hello.')
    expect(f.paths).toEqual(['/v1/responses', '/v1/responses'])
    const key = derivePromptCacheKey(session.id)
    for (const request of f.requests) {
      expect(request).toMatchObject({ model: 'fixture-model', stream: true, store: false, max_output_tokens: 4096,
        reasoning: { effort: 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'], prompt_cache_key: key })
      expect(request).not.toHaveProperty('reasoning_effort')
      expect(request).not.toHaveProperty('messages')
    }
    expect(JSON.stringify(f.requests)).not.toContain('"none"')
    for (const [index, headers] of f.headers.entries()) {
      expect(headers).not.toHaveProperty('session_id')
      expect(headers).not.toHaveProperty('x-client-request-id')
      expect(JSON.stringify(headers)).not.toContain(session.id)
      expect(JSON.stringify(f.requests[index])).not.toContain(session.id)
    }
  }, 30000)

  it('replays encrypted reasoning by value across steps: no ids, byte-identical encrypted content', async () => {
    const f = await responsesFixture((_request, response, index) => index === 0
      ? responses(response, [R(1), R(2), { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'write',
        arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) }])
      : responses(response, [R(3), { type: 'message', id: 'msg_2', text: 'Wrote a.txt.' }]))
    const session = await f.app.createSession()
    const result = await session.run('Write a.txt.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(await readFile(join(f.workspace, 'a.txt'), 'utf8')).toBe('x\n')
    const input = inputOf(f.requests[1])
    const replayed = input.slice(-4)
    expect(replayed).toEqual([
      byValue(1),
      byValue(2),
      { type: 'function_call', call_id: 'call_1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) },
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ])
    // Step 2 extends step 1's input item for item.
    expect(input.slice(0, inputOf(f.requests[0]).length)).toEqual(inputOf(f.requests[0]))
  }, 30000)

  it('replays every earlier reasoning item after a resume, extending the pre-close request', async () => {
    const script: ResponsesItem[][] = [
      [R(1), R(2), { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) }],
      [R(3), { type: 'message', id: 'msg_2', text: 'Wrote a.txt.' }],
      [R(4), { type: 'message', id: 'msg_3', text: 'It holds x.' }],
    ]
    const f = await responsesFixture((_request, response, index) => responses(response, script[index]!))
    const session = await f.app.createSession({ id: 'resp-resume' })
    await session.run('Write a.txt.')
    await session.close()
    const resumed = await f.app.resumeSession('resp-resume')
    const result = await resumed.run('What does a.txt hold?')
    expect(result.text).toBe('It holds x.')
    expect(reasoningOf(f.requests[2])).toEqual([byValue(1), byValue(2), byValue(3)])
    // The first request after the resume extends the last one before the close.
    expect(inputOf(f.requests[2]).slice(0, inputOf(f.requests[1]).length)).toEqual(inputOf(f.requests[1]))
  }, 30000)

  it('drops encrypted reasoning with a logged warning when a resume changes the model', async () => {
    const script: ResponsesItem[][] = [
      [R(1), R(2), { type: 'message', id: 'msg_1', text: 'First.' }],
      [R(3), { type: 'message', id: 'msg_2', text: 'Second.' }],
    ]
    const f = await responsesFixture((_request, response, index) => responses(response, script[index]!))
    const session = await f.app.createSession({ id: 'resp-model-change' })
    await session.run('First.')
    await f.app.close()
    const other = await f.boot({ model: 'other-model' })
    const resumed = await other.resumeSession('resp-model-change')
    const result = await resumed.run('Second.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(f.requests[1]).toMatchObject({ model: 'other-model' })
    expect(reasoningOf(f.requests[1])).toEqual([])
    expect(degraded(f.warnings)).toEqual([expect.stringContaining(
      'encrypted reasoning from openai-responses/fixture-model cannot be replayed to openai-responses/other-model; 2 item(s) dropped')])
  }, 30000)

  it('drops encrypted reasoning with a logged warning when a resume switches to Chat Completions', async () => {
    const f = await responsesFixture((_request, response, index) => index === 0
      ? responses(response, [R(1), R(2), { type: 'message', id: 'msg_1', text: 'First.' }])
      : stream(response, [{ content: 'Second.' }]))
    const session = await f.app.createSession({ id: 'resp-api-change' })
    await session.run('First.')
    await f.app.close()
    const chat = await f.boot({ api: 'chat-completions' })
    const resumed = await chat.resumeSession('resp-api-change')
    const result = await resumed.run('Second.')
    expect(result.text).toBe('Second.')
    expect(f.paths).toEqual(['/v1/responses', '/v1/chat/completions'])
    expect(JSON.stringify(f.requests[1])).not.toContain('ENC-')
    expect(f.requests[1]).toMatchObject({ reasoning_effort: 'medium' })
    expect(degraded(f.warnings)).toEqual([expect.stringContaining(
      'encrypted reasoning from openai-responses/fixture-model cannot be replayed to openai-completions/fixture-model; 2 item(s) dropped')])
    // The protocol names the journaled route, so the switch is a declared prefix break, not an unexplained miss.
    expect(result.metrics.promptCache).toMatchObject({ unexplainedMisses: 0, breaks: { total: 1, byCause: { route: 1 } } })
    const headers = (await resumed.events()).filter(e => e.type === 'request/header')
    expect(headers.map(e => [e.data.reason, e.data.header.config.provider])).toEqual([['initial', 'pluto-responses'], ['resume', 'pluto']])
  }, 30000)

  it('runs the compaction summariser on the same route, replaying the session by value', async () => {
    const f = await responsesFixture((_request, response, index) => index < 2
      ? responses(response, [R(index + 1), { type: 'message', id: `msg_${index}`, text: 'A'.repeat(2500) }])
      : responses(response, [R(9), { type: 'message', id: 'msg_s', text: '## Current Work\nRetain the active task.' }]))
    const session = await f.app.createSession()
    await session.run('First task: ' + 'input '.repeat(300))
    await session.run('Second task: continue while retaining the restrictions.')
    const result = await session.compact()
    expect(result).not.toBeNull()
    expect(f.paths).toEqual(['/v1/responses', '/v1/responses', '/v1/responses'])
    const summariser = f.requests[2]!
    expect(JSON.stringify(inputOf(summariser))).toContain('compaction engine')
    // It replays the preceding main request item for item, reasoning included.
    expect(inputOf(summariser).slice(0, inputOf(f.requests[1]).length)).toEqual(inputOf(f.requests[1]))
    expect(reasoningOf(summariser)).toEqual([byValue(1)])
    expect(summariser).toMatchObject({ reasoning: { effort: 'medium' }, prompt_cache_key: f.requests[0]!['prompt_cache_key'] })
    expect((await session.events()).some(e => e.type === 'compaction/summary')).toBe(true)
  }, 30000)

  it('sends no reasoning control at all with reasoningEffort false', async () => {
    const f = await responsesFixture((_request, response) => responses(response, [{ type: 'message', id: 'msg_1', text: 'Plain.' }]),
      { reasoningEffort: false })
    const result = await (await f.app.createSession()).run('Say plain.')
    expect(result.text).toBe('Plain.')
    expect(f.requests[0]).not.toHaveProperty('reasoning')
    expect(f.requests[0]).not.toHaveProperty('include')
    expect(f.requests[0]).toMatchObject({ store: false })
  }, 30000)

  it('recovers a response.incomplete (max_output_tokens) without replaying its orphaned reasoning or cut call', async () => {
    const f = await responsesFixture((_request, response, index) => {
      if (index === 0) {
        return responses(response, [R(1), R(2), { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'write',
          arguments: JSON.stringify({ file_path: 'a.txt', content: 'x'.repeat(40) }) }], { incomplete: true })
      }
      if (index === 1) {
        return responses(response, [R(3), { type: 'function_call', id: 'fc_2', callId: 'call_2', name: 'write',
          arguments: JSON.stringify({ file_path: 'a.txt', content: 'small\n' }) }])
      }
      return responses(response, [{ type: 'message', id: 'msg_3', text: 'Wrote a.txt.' }])
    })
    const session = await f.app.createSession()
    const result = await session.run('Write a.txt.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(await readFile(join(f.workspace, 'a.txt'), 'utf8')).toBe('small\n')
    expect((await session.events()).filter(e => e.type === 'tool/call')).toHaveLength(1)
    // The cut response left reasoning with no following item: it is not replayed, nor is the cut call.
    expect(reasoningOf(f.requests[1])).toEqual([])
    expect(JSON.stringify(inputOf(f.requests[1]))).not.toContain('call_1')
    expect(JSON.stringify(inputOf(f.requests[1]).at(-1))).toContain(modelText('control/output-limit'))
    expect(f.requests[1]!['max_output_tokens']).toBe(f.requests[0]!['max_output_tokens'])
    // The completed step's reasoning is replayed with its call.
    expect(reasoningOf(f.requests[2])).toEqual([byValue(3)])
  }, 30000)
})

/** vLLM-shaped reasoning: readable text, no encrypted content. */
const P = (n: number): ResponsesItem => ({ type: 'reasoning', id: `rs_plain${n}`, text: `Plan step ${n}: call the tool.` })
const plainByValue = (n: number): Item => ({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: `Plan step ${n}: call the tool.` }] })

describe('Responses by default, with plain reasoning replay for vLLM-style endpoints', () => {
  it('speaks the Responses protocol when the connection names no api', async () => {
    const f = await responsesFixture((_request, response) => responses(response, [{ type: 'message', id: 'msg_1', text: 'Hello.' }]),
      { api: undefined })
    const result = await (await f.app.createSession()).run('Say hello.')
    expect(result.text).toBe('Hello.')
    expect(f.paths).toEqual(['/v1/responses'])
    expect(f.requests[0]).toMatchObject({ store: false, reasoning: { effort: 'medium' } })
  }, 30000)

  it("replays readable reasoning by value in 'plain' mode: content, never encrypted content or an include", async () => {
    const script: ResponsesItem[][] = [
      [P(1), { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) }],
      [P(2), { type: 'message', id: 'msg_2', text: 'Wrote a.txt.' }],
      [P(3), { type: 'message', id: 'msg_3', text: 'It holds x.' }],
    ]
    const f = await responsesFixture((_request, response, index) => responses(response, script[index]!), { reasoningReplay: 'plain' })
    const session = await f.app.createSession({ id: 'resp-plain' })
    expect((await session.run('Write a.txt.')).stopReason).toEqual({ kind: 'completed' })
    expect(await readFile(join(f.workspace, 'a.txt'), 'utf8')).toBe('x\n')
    expect(inputOf(f.requests[1]).slice(-3)).toEqual([
      plainByValue(1),
      { type: 'function_call', call_id: 'call_1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) },
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ])
    // Resumed, the next request still carries every earlier reasoning item and extends the pre-close request.
    await session.close()
    const resumed = await f.app.resumeSession('resp-plain')
    expect((await resumed.run('What does a.txt hold?')).text).toBe('It holds x.')
    expect(reasoningOf(f.requests[2])).toEqual([plainByValue(1), plainByValue(2)])
    expect(inputOf(f.requests[2]).slice(0, inputOf(f.requests[1]).length)).toEqual(inputOf(f.requests[1]))
    for (const request of f.requests) {
      expect(request).not.toHaveProperty('include')
      expect(request).toMatchObject({ store: false, reasoning: { effort: 'medium' } })
      expect(JSON.stringify(request)).not.toContain('encrypted_content')
    }
  }, 30000)

  it("replays vLLM's readable reasoning as text in the default 'encrypted' mode with one warning, and no reasoning in 'none' mode", async () => {
    const script = (_request: Request, response: ServerResponse, index: number): void => index === 0
      ? responses(response, [P(1), { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) }])
      : index === 1
        ? responses(response, [P(2), { type: 'function_call', id: 'fc_2', callId: 'call_2', name: 'write', arguments: JSON.stringify({ file_path: 'b.txt', content: 'y\n' }) }])
        : responses(response, [R(3), { type: 'message', id: 'msg_3', text: 'Wrote both.' }])
    const encrypted = await responsesFixture(script)
    await (await encrypted.app.createSession()).run('Write a.txt and b.txt.')
    expect(reasoningOf(encrypted.requests[1])).toEqual([plainByValue(1)])
    expect(reasoningOf(encrypted.requests[2])).toEqual([plainByValue(1), plainByValue(2)])
    expect(encrypted.requests[1]).toMatchObject({ include: ['reasoning.encrypted_content'] })
    const fallbacks = encrypted.warnings.filter(message => String(message.args[0]).includes("Set reasoningReplay: 'plain'"))
    expect(fallbacks).toHaveLength(1)
    const none = await responsesFixture(script, { reasoningReplay: 'none' })
    const session = await none.app.createSession()
    await session.run('Write a.txt.')
    await session.run('Again.')
    expect(reasoningOf(none.requests[1])).toEqual([])
    expect(reasoningOf(none.requests[2])).toEqual([])
    for (const request of none.requests) expect(request).not.toHaveProperty('include')
  }, 30000)
})

describe('an endpoint without /responses on the default runtime path', () => {
  it("fails a 404 at once, without a retry, naming api 'chat-completions'", async () => {
    const f = await responsesFixture((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":{"message":"Not Found"}}')
    })
    const result = await (await f.app.createSession()).run('Say hello.')
    expect(result.stopReason).toMatchObject({ kind: 'error', error: { message: expect.stringContaining("api to 'chat-completions'") } })
    expect(f.paths).toEqual(['/v1/responses'])
  }, 30000)
})
