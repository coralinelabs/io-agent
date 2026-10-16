/**
 * Skill tool availability: whether a session is offered the
 * skill tools is decided once, when its agent is created, from its logged
 * request header or else a complete discovery with no skill. Library tests over
 * the real registry, filesystem provider, tool registry and agent scopes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createUserMessage, ToolCallId, type UserMessage } from "../../../src/library/model/llm/index.ts"
import { createScope, type Scope } from "../../../src/library/runtime/scope/index.ts"
import { SESSION_FORMAT_VERSION, Session, SessionId } from "../../../src/library/session/journal/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime from "../../../src/library/tools/index.ts"
import AgentRegistry, { agentEvents, type Agent } from "../../../src/library/runtime/agents/index.ts"
import SkillRegistry from "../../../src/library/skills/skill/index.ts"
import * as SkillFileSystem from "../../../src/library/skills/filesystem/index.ts"
import * as toolSkill from "../../../src/library/skills/tool-skill/index.ts"
import { mountSkillAvailability } from "../../../src/library/skills/tool-skill/availability.ts"
import { unsupportedInbox } from "../../support/test-support/agent-loop-testkit/src/index.ts"

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const SKILL_TOOLS = ['skill', 'skill_list', 'skill_read']

async function setup(): Promise<{ ctx: Context; home: string; warnings: string[] }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-availability-'))
  tempDirs.push(home)
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { customSkillDirs: [join(home, '.dsh/skills'), join(home, '.agents/skills')], watch: false })
  await ctx.plugin(toolSkill, { progressive: true, catalogMaxEntries: 100, catalogMaxBytes: 12288, maxSkillBytes: 65536, catalogDescriptionMaxLength: 120 })
  mountSkillAvailability(ctx)
  return { ctx, home, warnings }
}

/** A live-shaped agent whose own context is its tool scope, so `agent.ctx.tools.restrict` scopes to it. */
async function agentIn(ctx: Context, cwd: string, session?: Session): Promise<{ agent: Agent; scope: Scope }> {
  const id = SessionId(`availability-${String(Math.random()).slice(2)}`)
  const agent = {
    id,
    options: {},
    session: session ?? Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false }),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('unused') },
    cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  ;(agent as { ctx: Context }).ctx = scope.ctx
  return { agent, scope }
}

async function created(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/created', { source: 'startup', ...signal === undefined ? {} : { signal } })
}

const visible = (ctx: Context, agent: Agent): string[] => SKILL_TOOLS.filter(name => ctx.tools.get(name, agent) !== undefined)

/** A session whose log already carries a request header with the given tool names (a resumed or seeded session). */
function sessionWithHeader(cwd: string, tools: string[]): Session {
  const id = SessionId(`header-${tools.join('-') || 'none'}`)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
  session.append('request/header', {
    header: { config: { provider: 'p', model: 'm' }, tools: tools.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) },
    reason: 'initial',
  })
  return session
}

async function preStep(ctx: Context, agent: Agent, messages: UserMessage[]) {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }))
}

describe('skill tool availability at agent creation', () => {
  it('hides all three tools and the catalog for a session that starts with no skill; a forced call is refused', async () => {
    const { ctx, home } = await setup()
    const { agent } = await agentIn(ctx, home)
    expect(visible(ctx, agent)).toEqual(SKILL_TOOLS)
    await created(ctx, agent)
    expect(visible(ctx, agent)).toEqual([])
    const forced = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('forced'), name: 'skill', arguments: { name: 'x' }, agent })
    expect(forced.isError).toBe(true)
    expect(forced.content).toEqual([{ type: 'text', text: 'Error: unknown tool "skill"' }])
    // A skill that appears later: the step that finds it was decided without it (no catalog), and the
    // tools are back for the next step, whose decision carries the catalog.
    ctx.skills.register({ name: 'late-skill', description: 'Late', source: 'runtime', content: 'Late body.' })
    const finding = await preStep(ctx, agent, [])
    expect(finding.kind === 'enter' && finding.messages.some(message => message.source.kind === 'skill-catalog')).toBe(false)
    expect(visible(ctx, agent)).toEqual(SKILL_TOOLS)
    const next = await preStep(ctx, agent, [])
    expect(next.kind === 'enter' && next.messages.some(message => message.source.kind === 'skill-catalog')).toBe(true)
    // Another agent created now sees it.
    const later = await agentIn(ctx, home)
    await created(ctx, later.agent)
    expect(visible(ctx, later.agent)).toEqual(SKILL_TOOLS)
  })

  it('keeps the tools when a skill exists at creation, and after it is removed', async () => {
    const { ctx, home } = await setup()
    const dispose = ctx.skills.register({ name: 'early-skill', description: 'Early', source: 'runtime', content: 'Early body.' })
    const { agent } = await agentIn(ctx, home)
    await created(ctx, agent)
    expect(visible(ctx, agent)).toEqual(SKILL_TOOLS)
    dispose()
    expect(visible(ctx, agent)).toEqual(SKILL_TOOLS)
  })

  it('keeps the tools when discovery is incomplete or fails, and logs the failure', async () => {
    const { ctx, home, warnings } = await setup()
    const disposeProvider = ctx.skills.registerProvider(() => ({
      name: 'flaky',
      list() { return Promise.reject(new Error('temporarily unavailable')) },
      get() { return Promise.resolve(undefined) },
    }))
    const incomplete = await agentIn(ctx, home)
    await created(ctx, incomplete.agent)
    expect(visible(ctx, incomplete.agent)).toEqual(SKILL_TOOLS)
    disposeProvider()
    const snapshot = ctx.skills.snapshot.bind(ctx.skills)
    ctx.skills.snapshot = () => Promise.reject(new Error('discovery exploded'))
    const failing = await agentIn(ctx, home)
    await created(ctx, failing.agent)
    expect(visible(ctx, failing.agent)).toEqual(SKILL_TOOLS)
    expect(warnings.some(warning => warning.includes('skill discovery failed at creation') && warning.includes('discovery exploded'))).toBe(true)
    ctx.skills.snapshot = snapshot
  })

  it('follows a logged request header over discovery, both ways', async () => {
    const { ctx, home } = await setup()
    // No skill exists, but the session sent the skill tools before: it keeps them.
    const withTools = await agentIn(ctx, home, sessionWithHeader(home, ['read', 'skill', 'skill_list', 'skill_read']))
    await created(ctx, withTools.agent)
    expect(visible(ctx, withTools.agent)).toEqual(SKILL_TOOLS)
    // A skill exists now, but the session sent no skill tool before: it stays without.
    ctx.skills.register({ name: 'some-skill', description: 'Some', source: 'runtime', content: 'Body.' })
    const without = await agentIn(ctx, home, sessionWithHeader(home, ['read']))
    await created(ctx, without.agent)
    expect(visible(ctx, without.agent)).toEqual([])
  })

  it('propagates an abort of agent creation', async () => {
    const { ctx, home } = await setup()
    const { agent } = await agentIn(ctx, home)
    const controller = new AbortController()
    controller.abort(new Error('creation cancelled'))
    await expect(created(ctx, agent, controller.signal)).rejects.toThrow()
  })

  it('leaves a fork-skill gesture as prose while the loader is hidden, and still injects an inline one', async () => {
    const { ctx, home } = await setup()
    const forking = await agentIn(ctx, home)
    const inlining = await agentIn(ctx, home)
    for (const { agent } of [forking, inlining]) {
      await created(ctx, agent)
      expect(visible(ctx, agent)).toEqual([])
    }
    ctx.skills.register({ name: 'fork-skill', description: 'Forked', source: 'runtime', content: 'Fork body.', execution: { context: 'fork' } })
    ctx.skills.register({ name: 'inline-skill', description: 'Inline', source: 'runtime', content: 'Inline body.' })
    const gesture = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    // Each agent's first step after the skills appear is still decided with the loader hidden.
    const fork = await preStep(ctx, forking.agent, [gesture('/fork-skill now')])
    expect(fork.kind === 'enter' && fork.messages.map(message => message.source.kind)).toEqual(['user'])
    const inline = await preStep(ctx, inlining.agent, [gesture('/inline-skill now')])
    expect(inline.kind === 'enter' && inline.messages.map(message => message.source.kind)).toEqual(['user', 'skill-invocation'])
    // With the loader visible again, the fork gesture is recognised as before.
    const offered = await preStep(ctx, forking.agent, [gesture('/fork-skill now')])
    expect(offered.kind === 'enter' && offered.messages.some(message => message.source.kind === 'skill-invocation')).toBe(true)
  })
})
