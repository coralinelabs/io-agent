/** Validate the actual auxiliary request, not just the standalone prompt file. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import LlmRuntime, { LlmAdapter, createSystemMessage, createUserMessage } from "../../../src/library/model/llm/index.ts"
import type { GenerateOptions, StreamChunk } from "../../../src/library/model/llm/index.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { modelText } from "../../../src/library/context/text/index.ts"
import { summarizeWithLlm, frameSummary } from "../../../src/library/context/compaction/basic/summarizer.ts"

class RecordingAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'checkpoint from fixture' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function requestFixture() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const session = Session.create(SessionId('model-context-contract'))
  const owner = { session, options: { provider: 'fixture', model: 'fixture-model' } } as Agent
  const messages = [createSystemMessage('SYSTEM: keep the original prefix', 'fixture'),
    createUserMessage({ content: [{ type: 'text', text: 'Do not read .env. Cancel the earlier deployment; verify tests only.' }], source: { kind: 'user' } })]
  const tools = [{ name: 'read', description: 'Original description', parameters: { type: 'object' } }]
  const signal = new AbortController().signal
  const result = await summarizeWithLlm(ctx, { summarizationProvider: '', summarizationModel: '', maxTokens: 2048 },
    { messages, tools }, owner, signal)
  const request = adapter.requests[0]!
  const last = request.messages.at(-1)!.content[0]!
  expect(last.type).toBe('text')
  const instruction = last.type === 'text' ? last.text : ''
  return { request, adapter, messages, tools, signal, result, instruction }
}

describe('io-agent reference-derived compaction continuity policy', () => {
  it('delivers the edited catalog asset as one final user message', async () => {
    const { request, instruction, adapter, messages } = await requestFixture()
    expect(adapter.requests).toHaveLength(1)
    expect(request.messages).toHaveLength(messages.length + 1)
    expect(request.messages.at(-1)!.role).toBe('user')
    expect(instruction).toBe(modelText('compaction/summarize', {
      summary_open_tag: modelText('compaction/summary-open'),
    }))
    expect(instruction).toContain('still-applicable privacy, permission, credential-handling, and destructive-operation restrictions')
    expect(instruction).toContain('Preserve the restriction, not secret values.')
    expect(instruction).toContain('completed, cancelled, or superseded work')
    expect(instruction).toContain('do not reactivate obsolete tasks')
    expect(instruction).toContain('identifiers and last observed states')
    expect(instruction).toContain('do not imply that an unobserved operation finished successfully')
  })
  it('retains the cache-reusable prefix, actual tool schema, target, purpose, and cancellation signal', async () => {
    const { request, messages, tools, signal } = await requestFixture()
    expect(request.messages.slice(0, -1)).toEqual(messages)
    expect(request.tools).toEqual(tools)
    expect(request).toMatchObject({ provider: 'fixture', model: 'fixture-model', maxTokens: 2048, purpose: 'compaction' })
    expect(request.signal).toBe(signal)
    expect(request).not.toHaveProperty('system')
  })
  it('does not transplant incompatible reference-only framing or clear a running environment', async () => {
    const { result, instruction } = await requestFixture()
    const framed = frameSummary(result.summary)
    expect(framed[0]).toEqual({ type: 'text', text: modelText('compaction/checkpoint-preamble') + '\n\n' + modelText('compaction/summary-open') })
    expect(framed.at(-1)).toEqual({ type: 'text', text: modelText('compaction/summary-close') })
    expect(instruction).toContain('## Pending Jobs')
    expect(instruction).toContain('## Current Work')
    expect(instruction).toContain('## Next Step')
    expect(instruction).toContain('do not call any tool')
    const allText = JSON.stringify(framed)
    expect(allText).not.toContain('wait for a new user message')
    expect(allText).not.toContain('REPL VM state has been cleared')
  })
})
