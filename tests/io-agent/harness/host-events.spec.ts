/** The versioned HostEvent vocabulary: live delivery and durable history carry the same projected events. */
import { describe, expect, it } from 'vitest'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import sharp from 'sharp'
import { toolKind } from "../../../src/library/host/events.ts"
import { defineTool } from "../../../src/library/host/index.ts"
import type { HostEvent } from "../../../src/library/host/index.ts"
import { responses, stream, tool } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'

const LIVE_ONLY = new Set(['text', 'reasoning', 'interaction', 'interaction_closed', 'activity'])
const increasing = (events: readonly HostEvent[]) => events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)
/** One chat-completions chunk in the loopback fixture's framing. */
const chunk = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null) => {
  response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n')
}
const durable = (events: readonly HostEvent[]) => events.filter(event => !LIVE_ONLY.has(event.type))
  .map(({ activity_id: _activity, ...event }) => event)

describe('host events', () => {
  it('streams and replays readable reasoning on the default Responses wire with plain replay', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) {
        responses(response, [{ type: 'reasoning', id: 'rs_1', text: 'The notes file holds the answer.' },
          { type: 'function_call', id: 'fc_1', callId: 'read-notes', name: 'read', arguments: JSON.stringify({ file_path: 'notes.txt' }) }])
      } else responses(response, [{ type: 'reasoning', id: 'rs_2', text: 'It is missing; say so.' }, { type: 'message', id: 'msg_1', text: 'No notes yet.' }])
    }, { model: { api: undefined, reasoningReplay: 'plain' } })
    const id = await f.host.createSession()
    const { receipt, activity } = await run(f.host, turn(id, 'What do my notes say?'))
    expect(activity.end).toBe('done')
    expect(f.paths).toEqual(['/v1/responses', '/v1/responses'])
    const second = f.requests[1] as unknown as { input: Record<string, unknown>[]; include?: string[] }
    // Request 2 carries round 1's reasoning by value, as readable text, before its call.
    const replayed = second.input.findIndex(item => item.type === 'reasoning')
    expect(second.input[replayed]).toEqual({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'The notes file holds the answer.' }] })
    expect(second.input[replayed + 1]).toMatchObject({ type: 'function_call', call_id: 'read-notes' })
    expect(JSON.stringify(second)).not.toContain('encrypted_content')
    expect(second.include ?? []).not.toContain('reasoning.encrypted_content')
    const live = f.host.readSession(id, receipt.after).events
    expect(live.filter(event => event.type === 'reasoning').map(event => event.type === 'reasoning' && event.delta).join(''))
      .toBe('The notes file holds the answer.It is missing; say so.')
    const history = await f.host.history(id)
    expect(durable(live)).toEqual(history.events)
    expect(history.events.filter(event => event.type === 'message')).toMatchObject([
      { text: '', reasoning: 'The notes file holds the answer.' }, { text: 'No notes yet.', reasoning: 'It is missing; say so.' }])
    expect(history.events.find(event => event.type === 'usage')).toMatchObject({ input: 100, cached: 0, output: 10, reasoning: 4 })
  }, 30000)

  it('projects a turn once for live delivery and history, with images, a hidden context block, tools and usage', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'read', { file_path: 'notes.txt' }, 'read-notes')
      else stream(response, [{ reasoning: 'Weigh the picture.' }, { content: 'It is ' }, { content: 'red.' }])
    }, { model: { input: ['text', 'image'] } })
    const png = (await sharp({ create: { width: 4, height: 3, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64')
    const id = await f.host.createSession()
    const body = { session_id: id, turn_id: 'turn-with-image-01', context: 'HOST_CONTEXT_BLOCK: the viewer has notes.txt open.',
      prompt: [{ type: 'text', text: 'What colour is this?' }, { type: 'image', media_type: 'image/png', data: png, name: 'swatch.png' }] }
    const { receipt, activity } = await run(f.host, body)
    expect(activity).toMatchObject({ end: 'done', turn_id: 'turn-with-image-01', status: 'settled' })
    const first = JSON.stringify(f.requests[0]!.messages)
    expect(first).toContain('HOST_CONTEXT_BLOCK')
    expect(first).toContain('data:image/png;base64,')
    expect(first.indexOf('HOST_CONTEXT_BLOCK')).toBeLessThan(first.indexOf('What colour is this?'))
    const live = f.host.readSession(id, receipt.after).events
    const history = await f.host.history(id)
    expect(increasing(live)).toBe(true)
    expect(durable(live)).toEqual(history.events)
    expect(history.events.map(event => event.type)).toEqual(['turn', 'message', 'usage', 'tool_start', 'tool_end', 'message', 'usage', 'end'])
    const opened = history.events[0]
    if (opened?.type !== 'turn') throw new Error('missing turn')
    expect(opened.turn_id).toBe('turn-with-image-01')
    expect(opened.input.text).toBe('What colour is this?')
    expect(opened.input.images).toMatchObject([{ media_type: 'image/png', width: 4, height: 3, name: 'swatch.png' }])
    expect((await stat(opened.input.images[0]!.path!)).isFile()).toBe(true)
    expect(JSON.stringify(history.events)).not.toContain('HOST_CONTEXT_BLOCK')
    expect(history.events.find(event => event.type === 'tool_start')).toMatchObject({ call_id: 'read-notes', tool: 'read', kind: 'read', locations: [{ path: 'notes.txt' }] })
    expect(history.events.find(event => event.type === 'tool_end')).toMatchObject({ call_id: 'read-notes', kind: 'read', ok: false })
    expect(history.events.filter(event => event.type === 'message').at(-1)).toMatchObject({ text: 'It is red.', reasoning: 'Weigh the picture.' })
    expect(history.events.find(event => event.type === 'usage')).toEqual(expect.objectContaining({ input: 100, cached: 0, output: 10 }))
    expect(live.filter(event => event.type === 'text').map(event => event.type === 'text' && event.delta)).toEqual(['It is ', 'red.'])
    expect(live.filter(event => event.type === 'reasoning').map(event => event.type === 'reasoning' && event.delta).join('')).toContain('Weigh the picture.')
    expect(history.events.every(event => event.v === 1 && event.session_id === id && event.turn_id === 'turn-with-image-01')).toBe(true)
    expect(f.host.readSession(id, history.cursor).events.every(event => LIVE_ONLY.has(event.type))).toBe(true)
    await expect(f.host.submit({ ...body, turn_id: 'turn-with-bad-image', prompt: [{ type: 'image', media_type: 'image/png', data: 'bm90IGFuIGltYWdl' }] }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.submit({ ...body, turn_id: 'turn-without-input', prompt: [{ type: 'text', text: '  ' }] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }, 30000)

  it('joins history read mid-stream with the live tail from its cursor, without gaps or duplicates', async () => {
    const release = Promise.withResolvers<undefined>()
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) { tool(response, 'read', { file_path: 'missing.txt' }, 'first-look'); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      chunk(response, { role: 'assistant' })
      chunk(response, { content: 'Partial ' })
      chunk(response, { content: 'answer ' })
      await release.promise
      chunk(response, { content: 'completed.' })
      chunk(response, {}, 'stop')
      response.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\ndata: [DONE]\n\n')
    })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Answer slowly.'))
    await expect.poll(() => f.host.readSession(id, receipt.after).events.filter(event => event.type === 'text').length).toBe(2)
    const early = await f.host.history(id)
    const inFlight = f.host.readSession(id, early.cursor).events
    expect(inFlight.filter(event => event.type === 'text').map(event => event.type === 'text' && event.delta)).toEqual(['Partial ', 'answer '])
    expect(inFlight.every(event => LIVE_ONLY.has(event.type))).toBe(true)
    release.resolve(undefined)
    await f.host.settled(id, receipt.activity_id!)
    const late = await f.host.history(id)
    const tail = f.host.readSession(id, early.cursor).events
    expect(increasing(tail)).toBe(true)
    expect([...early.events, ...durable(tail)]).toEqual(late.events)
    expect(late.events.filter(event => event.type === 'message').at(-1)).toMatchObject({ text: 'Partial answer completed.' })
    expect(increasing(f.host.readSession(id, receipt.after).events)).toBe(true)
  }, 30000)

  it('delivers steering into running work as a steered input and refuses it while idle', async () => {
    const steered = Promise.withResolvers<undefined>()
    const f = await hostFixture(async (_request, response, index) => {
      if (index === 0) { await steered.promise; tool(response, 'read', { file_path: 'missing.txt' }, 'look') }
      else stream(response, [{ content: 'Checked the tests too.' }])
    })
    const id = await f.host.createSession()
    await expect(f.host.steer({ session_id: id, prompt: 'Too early.' })).rejects.toMatchObject({ code: 'SESSION_IDLE' })
    const receipt = await f.host.submit(turn(id, 'Look around.'))
    await expect.poll(() => f.requests.length).toBe(1)
    expect(await f.host.steer({ session_id: id, prompt: 'Also check the tests.' })).toEqual({ accepted: true })
    steered.resolve(undefined)
    expect((await f.host.settled(id, receipt.activity_id!)).end).toBe('done')
    expect(JSON.stringify(f.requests[1]!.messages)).toContain('Also check the tests.')
    const events = (await f.host.history(id)).events
    expect(events.map(event => event.type)).toEqual(['turn', 'message', 'usage', 'tool_start', 'tool_end', 'steered', 'message', 'usage', 'end'])
    expect(events.find(event => event.type === 'steered')).toMatchObject({ input: { text: 'Also check the tests.', images: [] }, turn_id: 'turn-application-01' })
    expect(durable(f.host.readSession(id, receipt.after).events)).toEqual(events)
  }, 30000)

  it('reports a failed model call as an error followed by its end', async () => {
    const f = await hostFixture((_request, response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'the fixture refuses this request', type: 'invalid_request_error' } }))
    })
    const id = await f.host.createSession()
    const { receipt, activity } = await run(f.host, turn(id, 'Fail please.'))
    expect(activity.end).toBe('error')
    const tail = durable(f.host.readSession(id, receipt.after).events).slice(-2)
    expect(tail.map(event => event.type)).toEqual(['error', 'end'])
    expect(tail[0]).toMatchObject({ message: expect.stringContaining('refuses') })
    expect(tail[1]).toMatchObject({ reason: 'error' })
  }, 30000)

  it('carries a tool\'s focused file view, bounded, the same live and in history', async () => {
    const position = (line: number, column = 1) => ({ line, column })
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'focus', {}, 'focus-call')
      else stream(response, [{ content: 'Shown.' }])
    }, { configure(ctx) {
      ctx.tools.register(defineTool({ name: 'focus', description: 'Focus a file.', parameters: {},
        output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'Requested.' }] },
        async execute() { return {} },
        presentResult: () => ({ card: 'generic', show: { path: 'src/app.ts', revision: 'r'.repeat(64), title: 'T'.repeat(300),
          ranges: [{ start: position(3), end: position(9, 2) }, { start: position(0), end: position(1) }, ...Array.from({ length: 40 }, (_, n) => ({ start: position(n + 1), end: position(n + 2) }))],
          folds: [{ start: 12, end: 40 }, { start: 9, end: 2 }, { start: 1.5, end: 3 }] } }),
      }))
    } })
    const id = await f.host.createSession()
    const { receipt } = await run(f.host, turn(id, 'Show me the app.'))
    const live = f.host.readSession(id, receipt.after).events.find(event => event.type === 'tool_end')
    const history = (await f.host.history(id)).events.find(event => event.type === 'tool_end')
    if (history?.type !== 'tool_end' || !history.show) throw new Error('missing file view')
    expect(live).toMatchObject({ show: history.show })
    // a cut label, malformed regions and folds dropped, at most 32 regions
    expect(history.show).toMatchObject({ path: 'src/app.ts', revision: 'r'.repeat(64), folds: [{ start: 12, end: 40 }] })
    expect(history.show.title).toHaveLength(200)
    expect(history.show.ranges).toHaveLength(32)
    expect(history.show.ranges![0]).toEqual({ start: position(3), end: position(9, 2) })
  }, 30000)

  it('maps declared tool presentations onto the host kind vocabulary', () => {
    expect(toolKind(undefined)).toBe('other')
    expect(toolKind({ card: 'terminal', title: 'ls' })).toBe('command')
    expect(toolKind({ card: 'diff', title: 'Write a', diffs: [{ path: 'a', oldText: null, newText: 'x' }] })).toBe('write')
    expect(toolKind({ card: 'diff', title: 'Edit a', diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] })).toBe('edit')
    expect(toolKind({ card: 'generic', title: 'Run', kind: 'execute' })).toBe('command')
    expect(toolKind({ card: 'generic', title: 'Remove', kind: 'delete' })).toBe('write')
    expect(toolKind({ card: 'generic', title: 'Anything' })).toBe('other')
    for (const kind of ['read', 'search', 'fetch', 'image', 'show', 'plan', 'delegate', 'question'] as const) {
      expect(toolKind({ card: 'generic', title: kind, kind })).toBe(kind)
    }
  })
})
