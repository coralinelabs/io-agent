/**
 * Human-facing `/goal` command over the persisted same-session goal domain.
 * @module io-agent/command-goal
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { CommandDefinitionId } from "../../interaction/commands/brand.ts"
import type { CommandInvocation, CommandResult } from "../../interaction/commands/index.ts"
import { GoalError } from "../goal/index.ts"
import type { GoalPhase, GoalRef, GoalView } from "../goal/index.ts"
import { createUserMessage } from "../../model/llm/index.ts"

export const name = 'command-goal'
export const inject = ['commands', 'goals']

const USAGE = 'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'

type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/** Parse only the grammar owned by `/goal`; arbitrary other input is an objective. */
function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
}

/** Human label for one durable goal phase. */
function phaseLabel(phase: GoalPhase): string {
  switch (phase) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    case 'complete': return 'complete'
    /* v8 ignore next 2 -- GoalPhase is closed and every member is handled above */
    default: return assertNever(phase, 'goal phase')
  }
}

/** Commands that are meaningful from one exact live state. */
function commandHint(goal: GoalView): string {
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/goal edit <objective>, /goal pause, /goal clear'
      : '/goal edit <objective>, /goal resume, /goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return modelText('foundation/command-goal-index/text-01')
    case 'complete':
      return modelText('foundation/command-goal-index/text-02')
    /* v8 ignore next 2 -- the active branch and every non-active phase are handled above */
    default: return assertNever(goal.phase, 'goal phase')
  }
}

/** Render direct UI output without exposing compare-and-set internals. */
function renderGoal(title: string, goal: GoalView): CommandResult {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  /* v8 ignore next -- durable replay guarantees every blocked goal carries its validated reason */
  if (goal.phase === 'blocked' && reason === undefined) throw new TypeError('blocked goal is missing its reason')
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return {
    kind: 'success',
    text: [
      title,
      `Status: ${phaseLabel(goal.phase)}`,
      ...blocker,
      `Objective: ${goal.objective}`,
      `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
      `Activation: ${goal.activation}`,
      '',
      `Commands: ${commandHint(goal)}`,
    ].join('\n'),
  }
}

/** Exact current compare-and-set ref. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Direct error for an operation that requires a current goal. */
function missingGoal(action: string): CommandResult {
  return {
    kind: 'error',
    text: modelText('runtime/command-goal-index/text-01', { value_1: String(action), value_2: String(USAGE) }),
  }
}

/**
 * Submit the invocation's admitted composer attachments as one model-visible user
 * message ahead of the goal's next round. The attachments precede a fixed text
 * block naming their role, so a later goal round reads them from ordinary
 * session history without the goal domain storing attachment state.
 */
function submitObjectiveAttachments(invocation: CommandInvocation): void {
  if (invocation.attachments.length === 0) return
  invocation.agent.followup(createUserMessage({
    content: [...invocation.attachments, { type: 'text', text: modelText('runtime/command-goal-index/text-02') }],
    source: { kind: 'user' },
  }))
}

/** Execute one parsed human command through the domain that owns persistence. */
function executeGoalCommand(ctx: Context, invocation: CommandInvocation): CommandResult {
  const command = parseGoalCommand(invocation.rawInput)
  if (invocation.attachments.length > 0 && command.kind !== 'create' && command.kind !== 'edit') {
    return {
      kind: 'error',
      text: modelText('runtime/command-goal-index/text-03'),
    }
  }
  try {
    const current = ctx.goals.get(invocation.agent)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: modelText('runtime/command-goal-index/text-04', { value_1: String(USAGE) }) }
          : renderGoal('Goal', current)
      case 'invalid-edit':
        return { kind: 'error', text: modelText('runtime/command-goal-index/text-05', { value_1: String(USAGE) }) }
      case 'create': {
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: modelText('runtime/command-goal-index/text-06', { value_1: String(phaseLabel(current.phase)) }),
          }
        }
        const created = ctx.goals.create(invocation.agent, { objective: command.objective })
        submitObjectiveAttachments(invocation)
        return renderGoal('Goal created', created)
      }
      case 'edit': {
        if (current === undefined) return missingGoal('edit')
        if (current.phase === 'complete') {
          const replaced = ctx.goals.create(invocation.agent, { objective: command.objective })
          submitObjectiveAttachments(invocation)
          return renderGoal('Goal created', replaced)
        }
        const edited = ctx.goals.edit(invocation.agent, goalRef(current), { objective: command.objective })
        submitObjectiveAttachments(invocation)
        return renderGoal('Goal updated', edited)
      }
      case 'pause':
        if (current === undefined) return missingGoal('pause')
        return renderGoal('Goal paused', ctx.goals.pause(invocation.agent, goalRef(current)))
      case 'resume':
        if (current === undefined) return missingGoal('resume')
        return renderGoal('Goal resumed', ctx.goals.resume(invocation.agent, goalRef(current)))
      case 'clear':
        if (current === undefined) return { kind: 'success', text: modelText('runtime/command-goal-index/text-07') }
        ctx.goals.clear(invocation.agent, goalRef(current))
        return { kind: 'success', text: modelText('runtime/command-goal-index/text-08') }
      /* v8 ignore next 2 -- GoalCommand is closed and every member is handled above */
      default: return assertNever(command, 'goal command')
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) {
      return {
        kind: 'error',
        text: modelText('runtime/command-goal-index/text-09'),
      }
    }
    throw error
  }
}

/** Register the Codex-shaped `/goal` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'),
    name: 'goal',
    description: modelText('runtime/command-goal-index/text-10'),
    input: { hint: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true },
    handler: invocation => executeGoalCommand(ctx, invocation),
  })
}
