import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import AgentLoop from "../../../src/plugins/runtime.ts"
import { mountAgentLoopTestDependencies } from "../../support/test-support/agent-loop-testkit/src/index.ts"
import InvariantRegistry from "../../../src/library/runtime/invariants/index.ts"
import * as SessionInvariant from "../../../src/library/session/journal/invariant.ts"
import * as AgentInvariant from "../../../src/library/runtime/agents/invariant.ts"
import * as AgentLoopInvariant from "../../../src/library/runtime/engine-invariant.ts"
import SubagentRuntime from "../../../src/library/agents/subagent/index.ts"
import * as spawn from "../../../src/library/agents/spawn-in-process/index.ts"
import { STRUCTURED_OUTPUT_TOOL } from "../../../src/library/agents/in-process-driver/index.ts"
import { MockAdapter, textResponse, toolCallResponse } from "../../core/agent-loop/mock-adapter.ts"
import PtcWorkflowEngine from "../../../src/library/workflow/workflow-ptc/index.ts"
import { mountPtcRuntime } from './setup.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

async function setup(script: Script) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await mountPtcRuntime(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(PtcWorkflowEngine, {})
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

describe('dsh-workflow-ptc over the real in-process stack', () => {
  it('runs a two-stage workflow: a plain child, then a schema child through the structured runtime', async () => {
    const { ctx, parent } = await setup([
      textResponse('the file list is a.ts'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { verdict: 'real', confidence: 0.9 }),
    ])
    const childIds: string[] = []
    ctx.on('workflow/agent-start', (_info, agent) => {
      // The workflow bridge must await asynchronous provider start: an observer
      // sees the real spawn child already published, never a reserved id.
      expect(ctx.agents.get(agent.childId)).toBeDefined()
      childIds.push(agent.childId)
    })
    const run = ctx.workflowEngine.start({
      meta: { name: 'integration', description: 'plain + structured children' },
      script: `phase('Read')
const prose = await agent('read the repo')
phase('Judge')
const judged = await agent('judge: ' + prose, {
  schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['real', 'bogus'] }, confidence: { type: 'number' } }, required: ['verdict'] },
})
return { prose, verdict: judged.verdict, confidence: judged.confidence }`,
      parent,
    })
    const result = await run.result
    expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
    expect(result.value).toEqual({ prose: 'the file list is a.ts', verdict: 'real', confidence: 0.9 })
    expect(result.agentsStarted).toBe(2)
    await run.dispose()
    // Both children were disposed to quiescence — no live child agents remain.
    expect(childIds.length).toBe(2)
    for (const childId of childIds) {
      expect(ctx.agents.get(SessionId(childId))).toBeUndefined()
    }
  })

  it('a child that fails against its schema (nudges exhausted) reaches the script as null', async () => {
    const { ctx, parent } = await setup([
      textResponse('prose only'),
      textResponse('still prose after the nudge'),
    ])
    const run = ctx.workflowEngine.start({
      meta: { name: 'null-path', description: 'schema failure maps to null' },
      script: `const judged = await agent('judge it', { schema: { type: 'object', properties: { v: { type: 'string' } } } })
return { got: judged === null ? 'null' : 'value' }`,
      parent,
    })
    const result = await run.result
    expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
    expect(result.value).toEqual({ got: 'null' })
    await run.dispose()
  })

  it('keeps real children visible to start observers after a progress burst', async () => {
    const { ctx, parent } = await setup([textResponse('child complete')])
    const logs: string[] = []
    const visible: boolean[] = []
    ctx.on('workflow/log', (_info, message) => { logs.push(message) })
    ctx.on('workflow/agent-start', (_info, child) => { visible.push(ctx.agents.get(child.childId) !== undefined) })
    const run = ctx.workflowEngine.start({
      meta: { name: 'progress-burst', description: 'ordered progress and child visibility' },
      script: 'for (let index = 0; index < 200; index++) log(String(index)); return await agent("finish")',
      parent,
    })
    try {
      await expect(run.result).resolves.toMatchObject({ value: 'child complete', stopReason: 'completed', agentsStarted: 1 })
      expect(logs).toEqual(Array.from({ length: 200 }, (_, index) => String(index)))
      expect(visible).toEqual([true])
    } finally {
      await run.dispose()
    }
  })
})
