/** Plan projection behavior. */

import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import AgentRegistry from "../../../src/library/runtime/agents/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import SessionStore from "../../../src/library/session/journal/index.ts"
import type { Session } from "../../../src/library/session/journal/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime from "../../../src/library/tools/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import UserQuestionService from "../../../src/library/interaction/user-questions/index.ts"
import { CommandId } from "../../../src/library/interaction/commands/brand.ts"
import PlanModeController from "../../../src/library/tasks/plan-mode/index.ts"

interface Bench {
  ctx: Context
  session: Session
  values(): Record<string, unknown>
}

async function harness(withPlanMode: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPlanMode) await ctx.plugin(PlanModeController, { section: 'plan policy' })
  const session = ctx.sessions.create()
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return {
    ctx,
    session,
    values: () => ctx.sessionProjections.snapshot(session).values,
  }
}

/** Append one logged /plan selection record (the executor's command/run shape). */
function runPlanCommand(session: Session, args: string, index: number): CommandId {
  const commandId = CommandId(`plan-proj-${String(index)}`)
  session.append('command/run', {
    commandId,
    name: 'plan',
    args,
    source: { kind: 'user' },
  })
  return commandId
}

/** Append the paired settlement for one projected plan command. */
function settlePlanCommand(session: Session, commandId: CommandId, kind: 'success' | 'error'): void {
  session.append('command/done', { commandId, kind })
}

/** Commit one plan/mode flip inside an open turn (the invariant's turn-enclosure rule). */
function commitPlanMode(session: Session, active: boolean, turn: number): void {
  session.append('turn/start', { turn })
  session.append('plan/mode', { active })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('plan projection unit', () => {
  it('serves inactive/not-pending for the empty log', async () => {
    const bench = await harness(true)
    expect(bench.values().plan).toEqual({ active: false, pending: false })
  })

  it('a logged /plan selection reads pending until plan/mode records it', async () => {
    const bench = await harness(true)
    const commandId = runPlanCommand(bench.session, '', 0)
    expect(bench.values().plan).toEqual({ active: false, pending: true })
    settlePlanCommand(bench.session, commandId, 'success')
    expect(bench.values().plan).toEqual({ active: false, pending: true })
    commitPlanMode(bench.session, true, 0)
    expect(bench.values().plan).toEqual({ active: true, pending: false })
  })

  it('drops a plan selection when its command settles with an error', async () => {
    const bench = await harness(true)
    commitPlanMode(bench.session, true, 0)
    const commandId = runPlanCommand(bench.session, 'off', 0)
    expect(bench.values().plan).toEqual({ active: true, pending: true })
    settlePlanCommand(bench.session, commandId, 'error')
    expect(bench.values().plan).toEqual({ active: true, pending: false })
  })

  it('folds `off` args and non-plan commands correctly, and a matching selection is not pending', async () => {
    const bench = await harness(true)
    commitPlanMode(bench.session, true, 0)
    // Another command's record never touches plan state.
    bench.session.append('command/run', {
      commandId: CommandId('other-1'), name: 'compact', args: '', source: { kind: 'user' },
    })
    expect(bench.values().plan).toEqual({ active: true, pending: false })
    // A command lifecycle with omitted input carries no plan selection.
    bench.session.append('command/run', {
      commandId: CommandId('plan-no-input'), name: 'plan', source: { kind: 'user' },
    })
    expect(bench.values().plan).toEqual({ active: true, pending: false })
    runPlanCommand(bench.session, ' off', 1)
    expect(bench.values().plan).toEqual({ active: true, pending: true })
    commitPlanMode(bench.session, false, 1)
    expect(bench.values().plan).toEqual({ active: false, pending: false })
    // Selecting the already-committed state folds to not-pending (net zero).
    runPlanCommand(bench.session, 'off', 2)
    expect(bench.values().plan).toEqual({ active: false, pending: false })
  })

  it('a /plan message-argument selection targets plan mode', async () => {
    const bench = await harness(true)
    runPlanCommand(bench.session, ' sketch the refactor first', 0)
    expect(bench.values().plan).toEqual({ active: false, pending: true })
  })

  it('freezes the active state at each step/start into activeAtLastStep, ignoring request headers', async () => {
    const bench = await harness(true)
    const told = (): boolean | null | undefined => bench.ctx.sessionProjections.stateOf(bench.session, 'plan')?.activeAtLastStep
    commitPlanMode(bench.session, true, 0)
    expect(bench.values().plan).toEqual({ active: true, pending: false })
    expect(told()).toBeNull()
    // A request header no longer records what the model was told: a toggle
    // does not start a new request series any more.
    bench.session.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'initial',
    })
    expect(told()).toBeNull()
    bench.session.append('step/start', { turn: 1, step: 1 })
    expect(bench.values().plan).toEqual({ active: true, pending: false })
    expect(told()).toBe(true)
    commitPlanMode(bench.session, false, 1)
    expect(bench.values().plan).toEqual({ active: false, pending: false })
    expect(told()).toBe(true)
    bench.session.append('step/start', { turn: 2, step: 1 })
    expect(bench.values().plan).toEqual({ active: false, pending: false })
    expect(told()).toBe(false)
    // An unchanged step start keeps the same fold state object.
    const before = bench.ctx.sessionProjections.stateOf(bench.session, 'plan')
    bench.session.append('step/start', { turn: 2, step: 2 })
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'plan')).toBe(before)
  })

  it('has no plan key when plan-mode is not composed', async () => {
    const bench = await harness(false)
    expect('plan' in bench.values()).toBe(false)
  })

  it('drops the key when the plan-mode fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    const fiber = await bench.ctx.plugin(PlanModeController, { section: 'plan policy' })
    expect(bench.values().plan).toEqual({ active: false, pending: false })
    await fiber.dispose()
    expect('plan' in bench.values()).toBe(false)
  })

  it('cold replay recovers pending from the log alone (a fresh registry refolds it)', async () => {
    const bench = await harness(true)
    runPlanCommand(bench.session, '', 0)
    // A second registry over the same log (the cold-read shape): no service
    // memory involved, the fold alone answers {active:false, pending:true}.
    const cold = await harness(true)
    for (const event of bench.session.snapshotEvents()) {
      if (event.type === 'command/run' || event.type === 'command/done' || event.type === 'plan/mode') {
        cold.session.append(event.type, event.data)
      }
    }
    expect(cold.values().plan).toEqual({ active: false, pending: true })
  })
})
