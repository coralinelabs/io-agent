/** Pin the retry controller separately from the actual HTTP integration fixtures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import BasicCompaction from "../../../src/library/context/compaction/basic/index.ts"
import type { SummarizationInput, SummaryResult } from "../../../src/library/context/compaction/basic/index.ts"
import { createAssistantMessage, createToolResultMessage, LlmError, ToolCallId } from "../../../src/library/model/llm/index.ts"
import IoAgentCompaction from "../../../src/library/context/compaction/policy.ts"

type Summarizer = { summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> }
const input = (oldSize: number): SummarizationInput => ({ messages: ['old', 'recent'].flatMap(id => [
  createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId(id), name: 'read', arguments: '{}' }], source: { provider: 'p', model: 'm' } }),
  createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: 'x'.repeat(id === 'old' ? oldSize : 64) }], isError: false }),
]) })
function subject() {
  const append = vi.fn(), agent = { session: { append } } as unknown as Agent
  const engine = Object.create(IoAgentCompaction.prototype) as Summarizer
  const original = vi.spyOn(BasicCompaction.prototype as unknown as Summarizer, 'summarize')
  return { append, agent, engine, original }
}
afterEach(() => { vi.restoreAllMocks() })
describe('bounded compaction retry ownership', () => {
  it('allows two smaller retries at most and never alters original evidence', async () => {
    const { append, agent, engine, original } = subject()
    const error = new LlmError('body rejected', 'PAYLOAD_TOO_LARGE', { status: 413 })
    original.mockRejectedValue(error)
    const request = input(20000), before = JSON.stringify(request)
    await expect(engine.summarize(request, agent)).rejects.toBe(error)
    expect(original).toHaveBeenCalledTimes(3); expect(append).toHaveBeenCalledTimes(2)
    expect(append.mock.calls.map(c => c[1].attempt)).toEqual([1, 2])
    for (const call of append.mock.calls) expect(call[1].bytesAfter).toBeLessThan(call[1].bytesBefore)
    expect(JSON.stringify(request)).toBe(before)
    expect(original.mock.calls[2]![0].messages.map(m => m.id)).toEqual(request.messages.map(m => m.id))
  })
  it('does not repeat an unchanged payload when reduction cannot help', async () => {
    const { append, agent, engine, original } = subject()
    original.mockRejectedValue(new LlmError('too large', 'HTTP_413'))
    await expect(engine.summarize(input(50), agent)).rejects.toThrow()
    expect(original).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled()
  })
  it.each([new LlmError('authentication', 'AUTH', { status: 401 }), new Error('request entity too large')])('does not disguise non-payload failure %s', async error => {
    const { append, agent, engine, original } = subject()
    original.mockRejectedValue(error)
    await expect(engine.summarize(input(20000), agent)).rejects.toBe(error)
    expect(original).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled()
  })
  it('honors cancellation before another attempt or recovery event', async () => {
    const { append, agent, engine, original } = subject(), controller = new AbortController()
    original.mockImplementation(async () => { controller.abort(); throw new LlmError('too large', 'HTTP_413') })
    await expect(engine.summarize(input(20000), agent, controller.signal)).rejects.toThrow()
    expect(original).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled()
  })
})
