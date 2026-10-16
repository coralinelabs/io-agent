import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import LlmRuntime, { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from "../../../src/library/model/llm/index.ts"
import SessionStore, { SessionId, type SessionEvent } from "../../../src/library/session/journal/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime, { defineContentToolFixture } from "../../../src/library/tools/index.ts"
import AgentRegistry, { type Agent } from "../../../src/library/runtime/agents/index.ts"
import AgentLoop from "../../../src/plugins/runtime.ts"
import PlanModeController from "../../../src/library/tasks/plan-mode/index.ts"
import { MockAdapter, textResponse, toolCallResponse } from "../../core/agent-loop/mock-adapter.ts"

const PLAN_CONFIG = { section: 'Test plan mode instructions.' }

/**
 * Full-loop integration: a scripted mock model drives the REAL plan-mode plugin
 * through the agent loop — the pending-intent flush at the step boundary, the
 * assembly the soft layer shapes (the exit tool + the `plan:mode` runtime
 * context), and the appended runtime-context snapshot that carries every mode
 * transition while the `system/message` head stays untouched.
 * Only the model is mocked; the loop, the session log, and the plugin are
 * real.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PlanModeController, PLAN_CONFIG)
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const name of ['read', 'write']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Read the plan unit that backs the service in this full composition. */
function planActive(ctx: Context, agent: Agent): boolean {
  const state = ctx.sessionProjections.stateOf(agent.session, 'plan')
  if (state === undefined) throw new Error('plan projection is not registered')
  return state.active
}

/** Join the text blocks of one message. */
function textOf(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Text of the session's current system node: the `system/message` at surface node 0. */
function systemText(agent: Agent): string {
  const head = agent.session.deriveMessages()[0]
  if (head?.role !== 'system') throw new Error('surface node 0 is not a system message')
  return textOf(head)
}

/** Text of the leading system message of one loop-built request. */
function requestSystem(options: GenerateOptions | undefined): string {
  const head = options?.messages[0]
  if (head?.role !== 'system') throw new Error('the request does not lead with a system message')
  return textOf(head)
}

/** Plugin source of the loop-owned runtime-context snapshot messages. */
const SNAPSHOT_SOURCE = '@deepseek-ai/dsh-system-prompt'

type UserMessageEvent = Extract<SessionEvent, { type: 'user/message' }>

/** Logged user messages contributed by one plugin, in log order. */
function pluginMessages(log: readonly SessionEvent[], plugin: string): UserMessageEvent[] {
  return log.filter((event): event is UserMessageEvent => event.type === 'user/message'
    && event.data.source.kind === 'plugin' && event.data.source.plugin === plugin)
}

/** Every user-role text of one loop-built request, in order. */
function requestUserTexts(options: GenerateOptions | undefined): string[] {
  return (options?.messages ?? []).filter(message => message.role === 'user').map(textOf)
}

/** Assert a request keeps the previous request's messages as an unchanged prefix. */
function expectAppendOnly(previous: GenerateOptions | undefined, next: GenerateOptions | undefined): void {
  const before = previous?.messages ?? []
  expect(next?.messages.length).toBeGreaterThan(before.length)
  expect(next?.messages.slice(0, before.length)).toEqual(before)
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('plan mode through the agent loop', () => {
  it('a pre-turn set() puts the guidance in the FIRST snapshot, and a non-shell call is guidance-constrained only', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'write', {}, 'Writing during plan.'),
      textResponse('Noted in the plan.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-plan-seed'), { provider: 'mock', model: 'mock' })
    // Selected while idle: the mode commits immediately, before the first assembly.
    ctx.planMode.set(agent, true)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'explore the repo' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    const planMode = findEvent(log, 'plan/mode')
    const header = findEvent(log, 'request/header')
    const systemNode = findEvent(log, 'system/message')
    expect(planMode.seq).toBeLessThan(header.seq)
    expect(header.data.reason).toBe('initial')
    expect(header.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    // The system node never carries the guidance: it is appended once and the
    // plan text rides in the first runtime-context snapshot after the prompt.
    expect(systemNode.surfaceOp).toBe('append')
    expect(log.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(agent.session.surface.nodes[0]).toBe(systemNode.seq)
    expect(systemText(agent)).not.toContain(PLAN_CONFIG.section)
    expect(requestSystem(adapter.requests[0])).not.toContain(PLAN_CONFIG.section)
    const snapshots = pluginMessages(log, SNAPSHOT_SOURCE)
    expect(snapshots).toHaveLength(1)
    expect(textOf(snapshots[0]!.data)).toContain(PLAN_CONFIG.section)
    expect(requestUserTexts(adapter.requests[0])).toEqual(['explore the repo', textOf(snapshots[0]!.data)])

    // No tool gate: the write RUNS — plan restrains by the section's
    // guidance alone (enforcement lives on the independent sandbox/approval
    // axes). The mode itself stays plan throughout.
    const result = findEvent(log, 'tool/result')
    expect(result.data.message.isError).toBe(false)
    expect(planActive(ctx, agent)).toBe(true)
    // Nothing narrates before the first step: the snapshot states the mode.
    expect(pluginMessages(log, 'plan-mode')).toHaveLength(0)
    expect(log.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
  })

  it('a user flip between turns lands at the boundary: one notice and an appended snapshot, with the system head and tool schemas unchanged', async () => {
    const adapter = new MockAdapter([
      textResponse('First turn, default mode.'),
      textResponse('Second turn, plan mode.'),
      textResponse('Third turn, default mode again.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-plan-flip'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(planActive(ctx, agent)).toBe(false)
    const first = findEvent(agent.session.snapshotEvents(), 'request/header')
    expect(first.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    const firstSystem = findEvent(agent.session.snapshotEvents(), 'system/message')
    expect(systemText(agent)).not.toContain(PLAN_CONFIG.section)
    // No active context before the flip: the first request carries no snapshot.
    expect(pluginMessages(agent.session.snapshotEvents(), SNAPSHOT_SOURCE)).toHaveLength(0)

    ctx.planMode.set(agent, true)
    // An idle set() queues nothing: the next turn starts from an idle agent.
    expect(agent.inbox.nextStep).toHaveLength(0)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'now plan' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    let log = agent.session.snapshotEvents()
    expect(planActive(ctx, agent)).toBe(true)
    const notices = pluginMessages(log, 'plan-mode')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.data.content).toEqual([
      { type: 'text', text: 'The user switched this session to plan mode.' },
    ])
    // The guidance is appended after the prompt as a snapshot, then the notice;
    // the system node is never replaced and no new request series starts.
    const prompt = log.find(event => event.type === 'user/message' && textOf(event.data) === 'now plan')
    const snapshots = pluginMessages(log, SNAPSHOT_SOURCE)
    expect(snapshots).toHaveLength(1)
    expect(textOf(snapshots[0]!.data)).toContain(PLAN_CONFIG.section)
    expect(prompt!.seq).toBeLessThan(snapshots[0]!.seq)
    expect(snapshots[0]!.seq).toBeLessThan(notices[0]!.seq)
    expect(log.filter(event => event.type === 'system/message').map(event => event.seq)).toEqual([firstSystem.seq])
    expect(agent.session.surface.nodes[0]).toBe(firstSystem.seq)
    expect(systemText(agent)).not.toContain(PLAN_CONFIG.section)
    expect(requestSystem(adapter.requests[1])).toBe(requestSystem(adapter.requests[0]))
    expect(adapter.requests[1]?.tools).toEqual(adapter.requests[0]?.tools)
    expectAppendOnly(adapter.requests[0], adapter.requests[1])

    ctx.planMode.set(agent, false)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'back to work' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    log = agent.session.snapshotEvents()
    expect(planActive(ctx, agent)).toBe(false)
    expect(pluginMessages(log, 'plan-mode').map(event => textOf(event.data))).toEqual([
      'The user switched this session to plan mode.',
      'The user switched this session back to the default mode.',
    ])
    // Leaving replaces the snapshot text (full-snapshot rule) without touching the head.
    const latest = pluginMessages(log, SNAPSHOT_SOURCE)
    expect(latest).toHaveLength(2)
    expect(textOf(latest[1]!.data)).not.toContain(PLAN_CONFIG.section)
    expect(log.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(requestSystem(adapter.requests[2])).toBe(requestSystem(adapter.requests[0]))
    expect(adapter.requests[2]?.tools).toEqual(adapter.requests[0]?.tools)
    expectAppendOnly(adapter.requests[1], adapter.requests[2])
    expect(log.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
  })

  it('a mode flip at error settlement waits until the step after a same-step retry', async () => {
    const failedRequest = [{
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'temporarily unavailable', code: 'SERVER', status: 503 } },
    }] satisfies StreamChunk[]
    const adapter = new MockAdapter([
      failedRequest,
      textResponse('Recovered with the original step assembly.'),
      textResponse('Entered plan mode on the next step.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-plan-retry-flip'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      ctx.planMode.set(agent, true)
      return { kind: 'retry' }
    })

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan after the transient failure' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    // The retry reuses the admitted step: neither request carries plan guidance.
    for (const request of adapter.requests) {
      expect(requestSystem(request)).not.toContain(PLAN_CONFIG.section)
      expect(requestUserTexts(request).join('\n')).not.toContain(PLAN_CONFIG.section)
    }
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages)
    expect(adapter.requests[1]?.tools).toEqual(adapter.requests[0]?.tools)
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)

    const nextIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue with the plan' }], source: { kind: 'user' } }))
    await nextIdle

    expect(adapter.requests).toHaveLength(3)
    expect(requestSystem(adapter.requests[2])).toBe(requestSystem(adapter.requests[0]))
    expect(requestUserTexts(adapter.requests[2]).join('\n')).toContain(PLAN_CONFIG.section)
    expect(adapter.requests[2]?.tools).toEqual(adapter.requests[0]?.tools)
    expectAppendOnly(adapter.requests[1], adapter.requests[2])
    const log = agent.session.snapshotEvents()
    const planMode = findEvent(log, 'plan/mode')
    const firstEnd = log.find(event => event.type === 'step/end'
      && event.data.turn === 1 && event.data.step === 1)
    const nextStart = log.find(event => event.type === 'step/start'
      && event.data.turn === 2 && event.data.step === 1)
    expect(firstEnd?.seq).toBeLessThan(planMode.seq)
    expect(planMode.seq).toBeLessThan(nextStart?.seq ?? 0)
    expect(log.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(systemText(agent)).not.toContain(PLAN_CONFIG.section)
    const [snapshot] = pluginMessages(log, SNAPSHOT_SOURCE)
    expect(textOf(snapshot!.data)).toContain(PLAN_CONFIG.section)
    expect(nextStart?.seq).toBeLessThan(snapshot!.seq)
    const notices = pluginMessages(log, 'plan-mode')
    expect(notices.map(event => event.data.content)).toEqual([
      [{ type: 'text', text: 'The user switched this session to plan mode.' }],
    ])
    expect(snapshot!.seq).toBeLessThan(notices[0]!.seq)
    expect(log.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
  })
})
