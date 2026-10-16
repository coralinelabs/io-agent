import { describe, expect, it } from 'vitest'
import { toByValueResponsesInput } from "../../../src/library/model/pi-ai/responses-replay.ts"

const reasoning = (n: number, extra: Record<string, unknown> = {}) => ({
  type: 'reasoning', id: `rs_a:rs_${n}`, status: 'completed', summary: [], encrypted_content: `ENC-${n}`, ...extra,
})
const call = (n: number) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'read', arguments: '{"file_path":"a"}' })
const output = (n: number) => ({ type: 'function_call_output', call_id: `call_${n}`, output: 'content' })
const message = (text: string) => ({ type: 'message', role: 'assistant', id: 'msg_1', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] })
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] })
const system = { role: 'system', content: 'You are Pluto.' }

describe('toByValueResponsesInput', () => {
  it('sends reasoning as type, summary and encrypted content only, and calls and messages without ids', () => {
    const payload = { model: 'm', store: false, input: [system, user('go'), reasoning(1), reasoning(2), call(1), output(1),
      reasoning(3, { summary: [{ type: 'summary_text', text: 'Checked a.' }] }), message('Done.')] }
    expect(toByValueResponsesInput(payload)).toEqual({ model: 'm', store: false, input: [
      system, user('go'),
      { type: 'reasoning', summary: [], encrypted_content: 'ENC-1' },
      { type: 'reasoning', summary: [], encrypted_content: 'ENC-2' },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' },
      output(1),
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked a.' }], encrypted_content: 'ENC-3' },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] },
    ] })
  })

  it('drops reasoning that cannot be replayed: no encrypted content', () => {
    const payload = { input: [user('go'), reasoning(1, { encrypted_content: undefined }), reasoning(2, { encrypted_content: '' }), call(1), output(1)] }
    expect(toByValueResponsesInput(payload)).toEqual({ input: [user('go'),
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' }, output(1)] })
  })

  it('drops a reasoning run with no following assistant item (a cut-off response whose calls were discarded)', () => {
    const notice = user('Your previous response reached the output token limit.')
    const payload = { input: [user('go'), reasoning(1), reasoning(2), notice, reasoning(3), call(3), output(3), reasoning(4)] }
    expect(toByValueResponsesInput(payload)).toEqual({ input: [user('go'), notice,
      { type: 'reasoning', summary: [], encrypted_content: 'ENC-3' },
      { type: 'function_call', call_id: 'call_3', name: 'read', arguments: '{"file_path":"a"}' }, output(3)] })
  })

  it('defaults a missing summary to an empty list', () => {
    const payload = { input: [reasoning(1, { summary: undefined }), message('x')] }
    expect((toByValueResponsesInput(payload) as { input: unknown[] }).input[0]).toEqual({ type: 'reasoning', summary: [], encrypted_content: 'ENC-1' })
  })

  it('is deterministic and does not mutate its input', () => {
    const payload = { input: [system, user('go'), reasoning(1), call(1), output(1)] }
    const before = JSON.stringify(payload)
    const first = JSON.stringify(toByValueResponsesInput(payload))
    expect(JSON.stringify(toByValueResponsesInput(structuredClone(payload)))).toBe(first)
    expect(JSON.stringify(payload)).toBe(before)
  })

  it.each([null, 'text', [], { model: 'm' }, { input: 'text' }])('passes through a payload without an input list: %j', (payload) => {
    expect(toByValueResponsesInput(payload)).toBe(payload)
  })
})

describe("toByValueResponsesInput in 'plain' and 'none' modes", () => {
  /** A reasoning item as vLLM returns it: readable content, encrypted_content null. */
  const plain = (n: number, extra: Record<string, unknown> = {}) => ({
    type: 'reasoning', id: `rs_${n}`, status: 'completed', summary: [], encrypted_content: null,
    content: [{ type: 'reasoning_text', text: `thought ${n}` }], ...extra,
  })
  const include = ['reasoning.encrypted_content']

  it('sends reasoning as type, summary and reasoning_text content, never encrypted content, and asks for none', () => {
    const payload = { model: 'm', include, input: [system, user('go'), plain(1), call(1), output(1), plain(2, { encrypted_content: 'ENC-2' }), message('Done.')] }
    expect(toByValueResponsesInput(payload, 'plain')).toEqual({ model: 'm', input: [
      system, user('go'),
      { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thought 1' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' },
      output(1),
      { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thought 2' }] },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] },
    ] })
  })

  it('keeps a summary-only item and other include entries, and drops an item with no reasoning text', () => {
    const summarized = plain(1, { content: undefined, summary: [{ type: 'summary_text', text: 'Checked a.' }] })
    const empty = plain(2, { content: [{ type: 'reasoning_text', text: '' }] })
    const noise = plain(3, { content: [{ type: 'other', text: 'x' }, { type: 'reasoning_text', text: 'kept', extra: 1 }] })
    const payload = { include: [...include, 'message.output_text.logprobs'], input: [summarized, call(1), output(1), empty, call(2), output(2), noise, message('x')] }
    expect(toByValueResponsesInput(payload, 'plain')).toEqual({ include: ['message.output_text.logprobs'], input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked a.' }], content: [] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' }, output(1),
      { type: 'function_call', call_id: 'call_2', name: 'read', arguments: '{"file_path":"a"}' }, output(2),
      { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'kept' }] },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'x', annotations: [] }] },
    ] })
  })

  it("drops every reasoning item and the encrypted include in 'none' mode", () => {
    const payload = { include, input: [user('go'), reasoning(1), plain(2), call(1), output(1)] }
    expect(toByValueResponsesInput(payload, 'none')).toEqual({ input: [user('go'),
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' }, output(1)] })
  })

  it("replays vLLM's readable reasoning as text under the default 'encrypted' mode, reports it, and keeps the include", () => {
    let reported = 0
    const summaryOnly = plain(2, { content: undefined, summary: [{ type: 'summary_text', text: 'Checked a.' }] })
    const payload = { include, input: [user('go'), plain(1), call(1), output(1), summaryOnly, reasoning(3), call(2), output(2)] }
    expect(toByValueResponsesInput(payload, 'encrypted', () => { reported += 1 })).toEqual({ include, input: [user('go'),
      { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thought 1' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' }, output(1),
      // No readable text and no encrypted content: nothing the endpoint could take back.
      { type: 'reasoning', summary: [], encrypted_content: 'ENC-3' },
      { type: 'function_call', call_id: 'call_2', name: 'read', arguments: '{"file_path":"a"}' }, output(2)] })
    expect(reported).toBe(1)
    expect(toByValueResponsesInput({ input: [user('go'), plain(1), call(1), output(1)] })).toMatchObject({ input: [user('go'),
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thought 1' }] }, { type: 'function_call' }, output(1)] })
  })
})
