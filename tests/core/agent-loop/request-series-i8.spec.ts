/**
 * A request series starts only when history the previous
 * request SENT was rewritten. Replacing a result appended after that request
 * (the spill policy's per-step budget, before the next send) is no break; a
 * replacement of an already-sent result still is.
 */

import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import LlmRuntime, { createUserMessage } from "../../../src/library/model/llm/index.ts"
import type { GenerateOptions } from "../../../src/library/model/llm/index.ts"
import SessionStore, { SessionId } from "../../../src/library/session/journal/index.ts"
import type { Session, SessionEvent, ToolResultMessage } from "../../../src/library/session/journal/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime, { defineContentToolFixture } from "../../../src/library/tools/index.ts"
import type { ToolBatchCommit } from "../../../src/library/tools/index.ts"
import AgentRegistry, { type Agent } from "../../../src/library/runtime/agents/index.ts"
import AgentLoop from "../../../src/plugins/runtime.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import { appendToolResultReplacement } from "../../../src/library/context/compaction/compaction/replace.ts"
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `FULL ${String(args.text)}` }] } }))
  return ctx
}

async function run(ctx: Context, id: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle
  return agent
}

function replace(session: Session, event: SessionEvent<'tool/result'>, text: string): void {
  const original = session.deriveEventMessage(event) as ToolResultMessage
  appendToolResultReplacement(session, event, original, [{ type: 'text', text }], 1)
}

const reasons = (agent: Agent): string[] => agent.session.snapshotEvents().flatMap(event => event.type === 'request/header' ? [event.data.reason] : [])
const sentText = (request: GenerateOptions | undefined): string => JSON.stringify(request?.messages)

describe('request series after tool-result replacements', () => {
  it('does not start a series when a committed batch rewrites its own unsent results', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'one' }), toolCallResponse('c2', 'echo', { text: 'two' }), textResponse('done')])
    const ctx = await harness(adapter)
    const batches: ToolBatchCommit[] = []
    ctx.on('tools/batch-committed', async (batch) => {
      batches.push(batch)
      for (const { event } of batch.results) replace(batch.agent.session, event, `BUDGETED ${event.data.message.source.callId}`)
    })
    const agent = await run(ctx, 'unsent-replacement')
    expect(batches.map(batch => [batch.turn, batch.step, batch.results.map(result => result.name)])).toEqual([[1, 1, ['echo']], [1, 2, ['echo']]])
    expect(sentText(adapter.requests[1])).toContain('BUDGETED c1')
    expect(sentText(adapter.requests[1])).not.toContain('FULL one')
    expect(reasons(agent)).toEqual(['initial'])
    // Journal order within a step: the full append, then the shadow price and replacement, then step/end.
    const types = agent.session.snapshotEvents().map(event => event.type)
    const firstEnd = types.indexOf('step/end')
    expect(types.slice(firstEnd - 3, firstEnd + 1)).toEqual(['tool/result', 'compaction/prune', 'tool/result', 'step/end'])
  })

  it('still starts a series when an already-sent result is rewritten', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'one' }), toolCallResponse('c2', 'echo', { text: 'two' }), textResponse('done')])
    const ctx = await harness(adapter)
    let first: SessionEvent<'tool/result'> | undefined
    ctx.on('tools/batch-committed', async (batch) => {
      if (batch.step === 1) first = batch.results[0]!.event
      else if (first !== undefined) replace(batch.agent.session, first, 'REWRITTEN AFTER SEND')
    })
    const agent = await run(ctx, 'sent-replacement')
    expect(sentText(adapter.requests[1])).toContain('FULL one')
    expect(sentText(adapter.requests[2])).toContain('REWRITTEN AFTER SEND')
    expect(reasons(agent)).toEqual(['initial', 'series'])
  })
})
