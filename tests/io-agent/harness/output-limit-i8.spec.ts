/**
 * Output exhaustion on the DEFAULT runtime path: a real io-agent runtime
 * (real tools, journal and metrics) behind the HTTP/SSE provider fixture,
 * replaying the shapes Meta's endpoint sends when a response runs out of its
 * output budget. It never streams `length`: the stream ends with no usage
 * record, as an empty `stop` (bench request 822ee534, conan-18693) or as a
 * `write` call with empty arguments and finish `tool_calls` (b6cdf2cf,
 * openai-agents-python-1636). Other endpoints can cut arguments mid-JSON.
 * An endpoint that simply never reports usage must keep working.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'
import { canonicalUnits, comparePrefix, prefixCacheFixture } from './prefix-cache-fixture.ts'
import { modelText } from "../../../src/library/context/text/index.ts"

const NOTICE = modelText('control/output-limit')

/** Text of the last message of one request, when it is a user message. */
function lastUserText(request: Request | undefined): string | undefined {
  const last = request?.messages.at(-1)
  if (last?.role !== 'user') return undefined
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

describe('output exhaustion on the default runtime path', () => {
  it('drops an endpoint-shaped cut write (empty arguments, no usage), continues with a notice at the same budget, and extends the prefix', async () => {
    let fileBeforeRetry: boolean | undefined
    const f = await prefixCacheFixture((_request, response, index, usage) => {
      if (index === 0) {
        // Exactly the b6cdf2cf body: a write header, finish tool_calls, [DONE], no usage chunk.
        return stream(response, [{ tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'write', arguments: '' } }] }],
          'tool_calls', null)
      }
      if (index === 1) {
        fileBeforeRetry = existsSync(join(f.workspace, 'notes.txt'))
        return tool(response, 'write', { file_path: 'notes.txt', content: 'one\ntwo\n' }, 'call_small', usage)
      }
      return stream(response, [{ content: 'Written.' }], 'stop', usage)
    })
    const session = await f.app.createSession({ id: 'cut-write' })
    const result = await session.run('Write notes.txt with two lines.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('Written.')
    expect(f.requests).toHaveLength(3)
    // The cut call never reached the tool layer: no call, no "missing required property" result.
    const events = await session.events()
    const calls = events.filter(e => e.type === 'tool/call')
    expect(calls.map(e => JSON.stringify(e.data))).toEqual([expect.stringContaining('call_small')])
    expect(JSON.stringify(f.requests[1])).not.toContain('call_cut')
    expect(fileBeforeRetry).toBe(false)
    expect(await readFile(join(f.workspace, 'notes.txt'), 'utf8')).toBe('one\ntwo\n')
    // The notice is the only addition, at the same budget and effort, so request 2 extends request 1 byte for byte.
    expect(lastUserText(f.requests[1])).toContain(NOTICE)
    expect(f.requests[1]!.max_tokens).toBe(f.requests[0]!.max_tokens)
    expect(f.requests[1]!.reasoning_effort).toBe(f.requests[0]!.reasoning_effort)
    expect(comparePrefix(canonicalUnits(f.requests[0]!), canonicalUnits(f.requests[1]!)).extends).toBe(true)
    expect(canonicalUnits(f.requests[1]!)).toHaveLength(canonicalUnits(f.requests[0]!).length + 1)
    expect(events.some(e => e.type === 'llm/retry')).toBe(false)
    // The usage-less response is not folded as a 0%-cached request, so it is no phantom miss.
    expect(result.metrics.promptCache).toMatchObject({ unexplainedMisses: 0, all: { requests: 2 } })
    expect(result.metrics.promptCache.all.cacheReadTokens).toBe(f.rows[1]!.cachedTokens + f.rows[2]!.cachedTokens)
  }, 30000)

  it('never writes arguments cut mid-JSON by the output budget: output at max_tokens gets the output-limit notice', async () => {
    let fileBeforeRetry: boolean | undefined
    const { app, requests, workspace } = await fixture((request, response, index) => {
      if (index === 0) {
        return stream(response, [
          { tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'write', arguments: '{"file_path":"notes.txt","con' } }] },
          { tool_calls: [{ index: 0, function: { arguments: 'tent":"1\\n2\\n3' } }] },
        ], 'tool_calls', { prompt_tokens: 100, completion_tokens: request.max_tokens, total_tokens: 100 + Number(request.max_tokens) })
      }
      if (index === 1) {
        fileBeforeRetry = existsSync(join(workspace, 'notes.txt'))
        return tool(response, 'write', { file_path: 'notes.txt', content: '1\n2\n3\n4\n' }, 'call_small')
      }
      return stream(response, [{ content: 'Written.' }])
    })
    const session = await app.createSession()
    const result = await session.run('Write notes.txt with four lines.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(fileBeforeRetry).toBe(false)
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('1\n2\n3\n4\n')
    expect((await session.events()).filter(e => e.type === 'tool/call')).toHaveLength(1)
    expect(JSON.stringify(requests[1])).not.toContain('call_cut')
    expect(lastUserText(requests[1])).toContain(NOTICE)
  }, 30000)

  it('rejects arguments an endpoint left unclosed under the budget as malformed, without executing them or claiming the output limit', async () => {
    let fileBeforeRetry: boolean | undefined
    const { app, requests, workspace } = await fixture((_request, response, index) => {
      if (index === 0) {
        // Usage reported far below max_tokens and finish tool_calls: the endpoint's tool parser, not the budget, left the JSON open.
        return stream(response, [
          { tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'write', arguments: '{"file_path":"notes.txt","con' } }] },
          { tool_calls: [{ index: 0, function: { arguments: 'tent":"1\\n2\\n3' } }] },
        ], 'tool_calls')
      }
      if (index === 1) {
        fileBeforeRetry = existsSync(join(workspace, 'notes.txt'))
        return tool(response, 'write', { file_path: 'notes.txt', content: '1\n2\n3\n4\n' }, 'call_small')
      }
      return stream(response, [{ content: 'Written.' }])
    })
    const session = await app.createSession()
    const result = await session.run('Write notes.txt with four lines.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(fileBeforeRetry).toBe(false)
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('1\n2\n3\n4\n')
    const events = await session.events()
    // The cut call reached the tool layer only to be rejected: journaled with its error result, never run.
    const results = events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data))
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('call_cut')
    expect(results[0]).toContain('INVALID_ARGS')
    expect(JSON.stringify(requests[1])).toContain(`invalid arguments: ${modelText('foundation/tools-schema/unparsed-arguments')}`)
    expect(JSON.stringify(requests[1])).toContain('call_cut')
    // No false output-limit claim: the notice never appears and the turn never ends max-tokens.
    expect(JSON.stringify(requests)).not.toContain(NOTICE)
    expect(requests).toHaveLength(3)
  }, 30000)

  it('recovers an empty stop without usage with a notice instead of retrying the identical request', async () => {
    const { app, requests } = await fixture((_request, response, index) => index === 0
      // Exactly the 822ee534 body: an empty stop, [DONE], no usage chunk.
      ? stream(response, [], 'stop', null)
      : stream(response, [{ content: 'Recovered.' }]))
    const session = await app.createSession()
    const result = await session.run('Answer briefly.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('Recovered.')
    expect(requests).toHaveLength(2)
    expect(lastUserText(requests[1])).toContain(NOTICE)
    expect((await session.events()).some(e => e.type === 'llm/retry')).toBe(false)
  }, 30000)

  it('does not report a usage-less reasoning-only response as a completed (empty) answer', async () => {
    const { app, requests } = await fixture((_request, response, index) => index === 0
      ? stream(response, [{ reasoning: 'Comparing the two call sites before' }], 'stop', null)
      : stream(response, [{ content: 'The answer is 42.' }]))
    const session = await app.createSession()
    const result = await session.run('What is the answer?')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('The answer is 42.')
    expect(requests).toHaveLength(2)
    expect(lastUserText(requests[1])).toContain(NOTICE)
  }, 30000)

  it('keeps working unchanged against an endpoint that never reports usage (retained)', async () => {
    const { app, requests, workspace } = await fixture((_request, response, index) => index === 0
      ? stream(response, [{ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x\n' }) } }] }], 'tool_calls', null)
      : stream(response, [{ content: 'Wrote a.txt.' }], 'stop', null))
    const session = await app.createSession()
    const result = await session.run('Write a.txt.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('Wrote a.txt.')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('x\n')
    expect(requests).toHaveLength(2)
    expect(requests.some(request => lastUserText(request)?.includes(NOTICE) === true)).toBe(false)
  }, 30000)

  it('ends the turn max-tokens after three consecutive exhaustions, with exactly three requests', async () => {
    const { app, requests } = await fixture((_request, response) => stream(response, [], 'stop', null))
    const session = await app.createSession()
    const result = await session.run('Think hard.')
    expect(result.stopReason).toEqual({ kind: 'max-tokens' })
    expect(requests).toHaveLength(3)
    expect(requests.map(request => lastUserText(request)?.includes(NOTICE) === true)).toEqual([false, true, true])
    expect(requests.every(request => request.max_tokens === requests[0]!.max_tokens)).toBe(true)
  }, 30000)
})
