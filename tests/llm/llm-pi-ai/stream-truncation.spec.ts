/**
 * Output exhaustion as pi-ai reports it. Meta's endpoint never streams
 * `length`: an exhausted Chat Completions stream ends with no usage record,
 * possibly an empty `stop` or a tool call with empty or cut arguments.
 */
import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent, ToolCall, Usage } from '@earendil-works/pi-ai'
import { EMPTY_RESPONSE_CODE } from "../../../src/library/model/llm/index.ts"
import type { StreamChunk } from "../../../src/library/model/llm/index.ts"
import { argumentsTruncated, budgetExhausted, toStreamChunks, usageReported } from "../../../src/library/model/pi-ai/stream.ts"

function usage(input = 0, output = 0): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: 'assistant', content: [], api: 'openai-completions', provider: 'pluto', model: 'served',
    usage: usage(), stopReason: 'stop', timestamp: 0, ...overrides }
}

async function collect(events: AssistantMessageEvent[], usageExpected: boolean, maxTokens = 4096): Promise<StreamChunk[]> {
  async function* feed(): AsyncGenerator<AssistantMessageEvent> { for (const event of events) yield event }
  const out: StreamChunk[] = []
  for await (const chunk of toStreamChunks(feed(), 32768, undefined, 'served', { usageExpected, maxTokens })) out.push(chunk)
  return out
}

/** One streamed tool call whose raw argument text is `raw`, as pi-ai emits it (parsed arguments at the end). */
function toolCallEvents(raw: string, parsed: Record<string, unknown>, done: AssistantMessage): AssistantMessageEvent[] {
  const call: ToolCall = { type: 'toolCall', id: 'call_1', name: 'write', arguments: parsed }
  const partial = assistant({ content: [call] })
  const mid = Math.floor(raw.length / 2)
  return [
    { type: 'start', partial },
    { type: 'toolcall_start', contentIndex: 0, partial },
    ...raw.length === 0 ? [] : [
      { type: 'toolcall_delta' as const, contentIndex: 0, delta: raw.slice(0, mid), partial },
      { type: 'toolcall_delta' as const, contentIndex: 0, delta: raw.slice(mid), partial },
    ],
    { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial },
    { type: 'done', reason: done.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: { ...done, content: [call] } },
  ]
}

const finishOf = (chunks: StreamChunk[]) => chunks.find(chunk => chunk.type === 'finish')
const usageOf = (chunks: StreamChunk[]) => chunks.find(chunk => chunk.type === 'usage')

describe('argumentsTruncated', () => {
  it.each([
    ['{"file_path":"a.txt","content":"par', true],
    ['{"file_path":"a.txt","content":"x"', true],
    ['{"items":[1,2', true],
    ['{"a":"escaped \\" quote', true],
    ['{"a":"x"}', false],
    ['{"a":1,}', false],
    ['{"a":"raw\nnewline"}', false],
    ['', false],
    ['   ', false],
    ['{"a":1}}', false],
  ])('%j → %s', (raw, expected) => {
    expect(argumentsTruncated(raw)).toBe(expected)
  })
})

describe('usageReported', () => {
  it('is false only when every count is zero', () => {
    expect(usageReported(usage())).toBe(false)
    expect(usageReported(usage(0, 1))).toBe(true)
    expect(usageReported({ ...usage(), cacheRead: 5 })).toBe(true)
    expect(usageReported({ ...usage(), totalTokens: 3 })).toBe(true)
  })
})

describe('budgetExhausted', () => {
  it('attributes a cut to the budget only without usage or with output at the ceiling', () => {
    expect(budgetExhausted(usage(), 4096)).toBe(true)
    expect(budgetExhausted(usage(100, 4096), 4096)).toBe(true)
    expect(budgetExhausted(usage(100, 5000), 4096)).toBe(true)
    expect(budgetExhausted(usage(100, 50), 4096)).toBe(false)
    expect(budgetExhausted(usage(100, 50), undefined)).toBe(false)
  })
})

const CUT = '{"file_path":"notes.txt","content":"1\\n2\\n3'
const cutCall = (done: AssistantMessage) => toolCallEvents(CUT, { file_path: 'notes.txt', content: '1\n2\n3' }, done)
const callOf = (chunks: StreamChunk[]) => chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')

describe('toStreamChunks output exhaustion', () => {
  it('finishes max-tokens when cut arguments come with output at the requested ceiling', async () => {
    const chunks = await collect(cutCall(assistant({ stopReason: 'toolUse', usage: usage(100, 4096) })), false)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'max-tokens' } })
    expect(usageOf(chunks)).toMatchObject({ usage: { inputTokens: 100, outputTokens: 4096 } })
  })

  it('finishes max-tokens when cut arguments come without usage, on any route', async () => {
    const chunks = await collect(cutCall(assistant({ stopReason: 'toolUse' })), false)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'max-tokens' } })
  })

  it('keeps a tool-calls finish for cut arguments under the ceiling, handing the tool layer the cut text, not a repaired object', async () => {
    const chunks = await collect(cutCall(assistant({ stopReason: 'toolUse', usage: usage(100, 50) })), false)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'tool-calls' } })
    expect(callOf(chunks)).toMatchObject({ block: { type: 'tool-call', name: 'write', arguments: CUT } })
    expect(() => JSON.parse(CUT)).toThrow()
    expect(usageOf(chunks)).toMatchObject({ usage: { inputTokens: 100, outputTokens: 50 } })
  })

  it('keeps complete arguments a tool-calls finish (retained)', async () => {
    const chunks = await collect(toolCallEvents('{"file_path":"a.txt","content":"x"}', { file_path: 'a.txt', content: 'x' },
      assistant({ stopReason: 'toolUse', usage: usage(100, 20) })), true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it("keeps closed malformed arguments on pi-ai's repair path (retained)", async () => {
    const chunks = await collect(toolCallEvents('{"a":1,}', {}, assistant({ stopReason: 'toolUse', usage: usage(100, 20) })), true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('reads a usage-less tool call with empty arguments as cut off when usage was expected (the endpoint signature)', async () => {
    const chunks = await collect(toolCallEvents('', {}, assistant({ stopReason: 'toolUse' })), true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'max-tokens' } })
    expect(usageOf(chunks)).toBeUndefined()
  })

  it('reads a usage-less reasoning-only stop as cut off, with no phantom zero usage chunk', async () => {
    const thought = assistant({ content: [{ type: 'thinking', thinking: 'Still weighing the two options' }] })
    const chunks = await collect([
      { type: 'thinking_start', contentIndex: 0, partial: thought },
      { type: 'thinking_delta', contentIndex: 0, delta: 'Still weighing the two options', partial: thought },
      { type: 'thinking_end', contentIndex: 0, content: 'Still weighing the two options', partial: thought },
      { type: 'done', reason: 'stop', message: thought },
    ], true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'max-tokens' } })
    expect(usageOf(chunks)).toBeUndefined()
  })

  it('keeps usage-less visible text and complete calls as they are, for an endpoint that ignores include_usage (retained)', async () => {
    const text = assistant({ content: [{ type: 'text', text: 'Done.' }] })
    const textChunks = await collect([{ type: 'done', reason: 'stop', message: text }], true)
    expect(finishOf(textChunks)).toMatchObject({ reason: { kind: 'stop' } })
    expect(usageOf(textChunks)).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } })
    const callChunks = await collect(toolCallEvents('{"file_path":"a.txt","content":"x"}', { file_path: 'a.txt', content: 'x' },
      assistant({ stopReason: 'toolUse' })), true)
    expect(finishOf(callChunks)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('reads an empty usage-less stop as cut off, not as an empty response, when usage was expected', async () => {
    const chunks = await collect([{ type: 'done', reason: 'stop', message: assistant() }], true)
    expect(chunks).toEqual([expect.objectContaining({ type: 'finish', reason: { kind: 'max-tokens' } })])
  })

  it('keeps a usage-less stop a stop when the route never asked for usage (retained)', async () => {
    const text = assistant({ content: [{ type: 'text', text: 'done' }] })
    const chunks = await collect([{ type: 'done', reason: 'stop', message: text }], false)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'stop' } })
    expect(usageOf(chunks)).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } })
  })

  it('keeps an empty stop that reported usage an EMPTY_RESPONSE error (retained)', async () => {
    const chunks = await collect([{ type: 'done', reason: 'stop', message: assistant({ usage: usage(100, 0) }) }], true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } } })
  })

  it('lets context overflow keep precedence over a missing usage record', async () => {
    const overflow = assistant({ stopReason: 'error', errorMessage: 'maximum context length exceeded' })
    const chunks = await collect([{ type: 'done', reason: 'stop', message: overflow }], true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })
  })

  it('maps a reported length to max-tokens as before (retained)', async () => {
    const chunks = await collect([{ type: 'done', reason: 'length', message: assistant({ stopReason: 'length',
      content: [{ type: 'text', text: 'cut' }], usage: usage(10, 5) }) }], true)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'max-tokens' } })
  })
})
