/** Package-owned goal-round prompt invariants. @module io-agent/goal-round-driver/invariant */

import { modelText } from "../../context/text/index.ts"
import { isDeepStrictEqual } from 'node:util'
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { foldGoal, type FoldedGoal, type GoalMessageSource, type GoalView } from "../goal/index.ts"
import type { InvariantFailure, InvariantInstaller } from "../../runtime/invariants/index.ts"
import type { Session, SessionEvent } from "../../session/journal/index.ts"
import { renderGoalRoundPrompt } from './prompt.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-goal-round-driver'

/** Cordis companion plugin name. */
export const name = 'goal-round-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Attribute strict goal-fold failures to this companion's reconstruction. */
function foldChecked(events: readonly SessionEvent[], fail: InvariantFailure): FoldedGoal {
  try {
    return foldGoal(events)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict goal decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    return fail(modelText('runtime/goal-round-driver-invariant/text-01', { value_1: String(message) }))
  }
}

/** Recreate the live-shaped view consumed by the package's pure prompt renderer. */
function goalView(folded: FoldedGoal, source: GoalMessageSource, fail: InvariantFailure): GoalView {
  const goal = folded.goal
  if (goal === undefined || folded.createdAt === undefined || folded.updatedAt === undefined
    || goal.phase !== 'active' || goal.id !== source.goalId || goal.revision !== source.revision
    || source.round !== folded.roundsStarted + 1 || source.round > goal.maxGoalRounds) {
    return fail(modelText('runtime/goal-round-driver-invariant/text-02', { value_1: String(source.round) }))
  }
  return {
    ...goal,
    roundsStarted: folded.roundsStarted,
    createdAt: folded.createdAt,
    updatedAt: folded.updatedAt,
    activation: 'armed',
  }
}

/** Validate one package-owned continuation message against its durable prefix. */
function validateEvent(
  prior: readonly SessionEvent[],
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (event.type !== 'user/message') return
  const source = event.data.source
  if (source.kind !== 'goal' || source.round <= 0) return
  const expected = renderGoalRoundPrompt(goalView(foldChecked(prior, fail), source, fail), source.round)
  if (!isDeepStrictEqual(event.data.content, expected)) {
    fail(modelText('runtime/goal-round-driver-invariant/text-03', { value_1: String(source.round) }))
  }
}

/** Check existing sessions and every candidate event before Session publishes it. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    const prior: SessionEvent[] = []
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) {
      validateEvent(prior, event, fail)
      prior.push(event)
    }
  }
  /* jscpd:ignore-start -- package companions share dispatch and registration plumbing */
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    validateEvent(session.snapshotEvents(), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the goal-round-driver invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
