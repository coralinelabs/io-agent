/**
 * Plan mode is logged per-agent collaboration state: while active, the
 * deployment-owned guidance is part of the runtime-context snapshot (the
 * `plan:mode` context, a user-role message appended when the snapshot text
 * changes), and `exit_plan_mode` presents the completed plan for user review,
 * while the `/plan off` command lets a user leave directly. Sandbox mode and
 * approval policy enforce restrictions independently and do not read or write
 * plan state.
 *
 * The guidance is never a system-prompt section: a toggle would rewrite the
 * system head and invalidate the provider's cached prompt prefix. Appending
 * the snapshot keeps the system prompt, tool catalog and earlier history
 * byte-identical across mode changes.
 *
 * The `plan` projection folds the session log, so resume and fork restore the
 * state. User selections remain pending until the next accepted in-turn
 * pre-step. The service includes the selected state in the proposed step
 * assembly, then appends `plan/mode` from `agent/pre-step` only when the step
 * is accepted. Same-step request retries reuse their assembly. A user switch
 * is narrated by a one-line notice at the first accepted pre-step whose mode
 * differs from the mode in force at the last `step/start`.
 *
 * The exit tool remains registered while plan mode is inactive, so entering
 * or leaving plan mode changes only the runtime-context snapshot, not the
 * request tool catalog or the system prompt.
 *
 * @module io-agent/plan-mode
 */

import { modelText } from "../../context/text/index.ts"
import { Context, Service } from "../../runtime/vendor/cordis/index.ts"
import { brandString } from "../../util/brand/index.ts"
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, PreStepDecision } from "../../runtime/agents/index.ts"
import { createUserMessage } from "../../model/llm/index.ts"
import type { Session, UserMessage } from "../../session/journal/index.ts"
import { defineTool } from "../../tools/index.ts"
import { UserQuestionError } from "../../interaction/user-questions/index.ts"
import type { CommandDefinitionId, CommandId } from "../../interaction/commands/index.ts"
import type {} from "../../session/projection/index.ts"
import type { ProjectionDefinition } from "../../session/projection/index.ts"
import type { PlanProjection, PlanUnitState } from './types.ts'
export type * from './types.ts'

declare module "../../session/journal/types.ts" {
  interface SessionEventMap {
    /**
     * Whether plan mode is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `plan/mode` wins; a log with none folds to
     * inactive through the projection unit's fold.
     */
    'plan/mode': { active: boolean }
  }
}

declare module "../../runtime/vendor/cordis/index.ts" {
  interface Context {
    planMode: PlanModeController
  }
}

/**
 * The model-facing exit tool's name. It stays registered while plan mode is
 * inactive so the request tool catalog is stable across transitions.
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** Deployment-owned plan guidance. */
export interface PlanModeConfig {
  /** Guidance rendered as the `plan:mode` runtime-context entry while plan mode is active. */
  section: string
}

/** The review question's id, echoed in the answer this tool reads. */
const REVIEW_ID = 'plan-review'

/** The review question's approve option label. */
const APPROVE_LABEL = 'Approve'

/** The review question's keep-planning option label. */
const KEEP_PLANNING_LABEL = 'Keep planning'

const EXIT_DESCRIPTION
  = modelText('runtime/plan-mode-index/text-01')

/** The plan's first markdown heading (any level), or `undefined` when it has none. */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * Validate deployment-owned plan guidance. Missing, blank, non-string, or
 * unknown fields fail at plugin load rather than being ignored.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig>).section
  if (typeof section !== 'string') {
    throw new Error('PlanModeConfig needs a string `section`')
  }
  if (section.trim() === '') {
    throw new Error('PlanModeConfig needs a non-empty `section`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error(modelText('runtime/plan-mode-index/text-02', { value_1: String(unknown.join(', ')) }))
  }
  return { section }
}

const planUnitStateSchema: ZodType<PlanUnitState> = zod.object({
  active: zod.boolean(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    commandId: zod.string() as unknown as ZodType<CommandId>,
    wanted: zod.boolean(),
  }).strict().nullable(),
  activeAtLastStep: zod.boolean().nullable(),
}).strict()

/** Wire payload schema of the `plan` projection. */
const planProjectionSchema: ZodType<PlanProjection> = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
})

/** Projection of logged plan selections and committed mode. */
export const planProjectionDefinition = {
  key: 'plan',
  stateVersion: 4,
  stateSchema: planUnitStateSchema,
  init: () => ({ active: false, wanted: null, running: null, activeAtLastStep: null }),
  apply: (state, event) => {
    if (event.type === 'command/run' && event.data.name === 'plan') {
      if (event.data.args === undefined) return state
      const wanted = event.data.args.trim() !== 'off'
      return { ...state, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
      const wanted = event.data.kind === 'success' && state.running.wanted !== state.active
        ? state.running.wanted
        : null
      return { ...state, wanted, running: null }
    }
    if (event.type === 'plan/mode') {
      return { ...state, active: event.data.active, wanted: null }
    }
    // What the model was last told: the mode in force when a step started.
    // Pre-step appends a selected `plan/mode` before its `step/start`.
    if (event.type === 'step/start') {
      return state.activeAtLastStep === state.active ? state : { ...state, activeAtLastStep: state.active }
    }
    return state
  },
  wire: {
    viewSchema: planProjectionSchema,
    view: (state) => {
      const wanted = state.running?.wanted ?? state.wanted
      return { active: state.active, pending: wanted !== null && wanted !== state.active }
    },
  },
} satisfies ProjectionDefinition<'plan', PlanUnitState>

/**
 * `ctx.planMode`: owns logged plan state, applies and narrates selected state at step start,
 * the `plan:mode` runtime context, the `/plan` command, and the stable exit tool.
 * Client carriers expose the projection's cropped `{ active, pending }` view.
 */
export class PlanModeController extends Service {
  static inject = ['tools', 'systemPrompt', 'sessionProjections']

  /** Validated deployment-owned guidance. */
  private readonly section: string

  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections and false for the exit tool, whose
   * result already narrates the transition.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    this.section = resolveConfig(config).section
    let disposed = false
    // Pre-step is outside Session.append publication, so it can append the
    // log-only mode event inside an open turn without re-entering the session.
    // A failed append remains pending for a later accepted in-turn pre-step,
    // and policy cannot block the step. The notice is derived here, from the
    // log, for both pending selections and between-turn commits, so an idle
    // set() leaves no queued input behind.
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const session = agent.session
      const pending = this.pendingIntents.get(session)
      const target = pending?.active ?? this.loggedActive(session)
      const narrate = pending?.narrate ?? true
      const told = this.planState(session).activeAtLastStep ?? undefined
      try {
        this.onBoundary(session)
      } catch (error) {
        ctx.logger.warn(modelText('runtime/plan-mode-index/text-03'), error)
        return decision
      }
      // Nothing is narrated before the first step: the snapshot states the mode.
      return narrate && told !== undefined && told !== target
        ? { ...decision, messages: [...decision.messages, this.notice(target)] }
        : decision
    })
    ctx.effect(() => () => { disposed = true }, 'dsh-plan-mode: close service lifetime')

    // Runtime context, not a system section: toggling must not rewrite the
    // cached system prompt. The snapshot re-emits after compaction.
    ctx.systemPrompt.context({
      name: 'plan:mode',
      order: ctx.systemPrompt.getContextOrder('PLAN_MODE'),
      text: (context) => {
        if (context.agent === undefined) return ''
        const pending = this.pendingIntents.get(context.agent.session)
        return (pending?.active ?? this.loggedActive(context.agent.session)) ? this.section : ''
      },
    })

    ctx.sessionProjections.register(planProjectionDefinition)

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-plan-mode'),
        name: 'plan',
        description: modelText('runtime/plan-mode-index/text-04'),
        input: { hint: '[off|message]', attachments: true },
        handler: ({ agent, rawInput, attachments }) => {
          const message = rawInput.trim()
          if (message === 'off' && attachments.length > 0) {
            return { kind: 'error', text: modelText('runtime/plan-mode-index/text-05') }
          }
          if (message === 'off') {
            switch (this.set(agent, false)) {
              case 'committed':
                return { kind: 'success', text: modelText('runtime/plan-mode-index/text-06') }
              case 'queued':
                return { kind: 'success', text: modelText('runtime/plan-mode-index/text-07') }
              case 'cancelled':
                return { kind: 'success', text: modelText('runtime/plan-mode-index/text-08') }
              case 'noop':
                // Repeat the queued wording while an exit still awaits the
                // next accepted pre-step; only a truly inactive session reads
                // idempotent.
                return this.loggedActive(agent.session)
                  ? { kind: 'success', text: modelText('runtime/plan-mode-index/text-09') }
                  : { kind: 'success', text: modelText('runtime/plan-mode-index/text-10') }
            }
          }
          const outcome = this.set(agent, true)
          if (message !== '' || attachments.length > 0) {
            agent.steer(createUserMessage({
              content: [
                ...attachments,
                ...(message === '' ? [] : [{ type: 'text' as const, text: message }]),
              ],
              source: { kind: 'user' },
            }))
          }
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? 'Plan mode on. Use /plan off to leave.'
              : modelText('runtime/plan-mode-index/text-11'),
          }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      parameters: {
        plan: { type: 'string', required: true, description: modelText('runtime/plan-mode-index/text-12') },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', const: true, required: true },
          },
        },
        render: () => [{ type: 'text', text: modelText('runtime/plan-mode-index/text-13') }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
        if (!this.loggedActive(agent.session)) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
        }
        if (!/^#\s+\S/.test(args.plan.trim())) {
          throw new Error(modelText('runtime/plan-mode-index/text-14', { value_1: String(EXIT_PLAN_MODE) }))
        }
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) {
          throw new Error(modelText('runtime/plan-mode-index/text-15'))
        }
        const answer = await interaction.ask({
          questions: [{
            id: REVIEW_ID,
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: args.plan,
            options: [
              { label: APPROVE_LABEL, description: modelText('runtime/plan-mode-index/text-16') },
              { label: KEEP_PLANNING_LABEL, description: modelText('runtime/plan-mode-index/text-17') },
            ],
            // Presentation only: a capable UI renders the plan as a review
            // decision instead of a generic question, and answers with one of
            // the labels above either way.
            intent: { kind: 'plan-review', approve: APPROVE_LABEL, callId: exec.callId },
          }],
          agent,
          signal: exec.signal,
        }).catch((cause: unknown) => {
          // A dismissed review is not a failed one: the user took the turn back
          // to say something the two options do not cover. Say so, because the
          // generic channel message names ask_user_question, which the model
          // never called. An abort (turn cancel, provider teardown) keeps its
          // own message — there is no user to wait for.
          if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
            throw new Error(modelText('runtime/plan-mode-index/text-18'))
          }
          throw cause
        })
        // A review may outlive this plugin fiber. Without its pre-step listener,
        // an approved selection could never be appended, so fail and keep planning.
        if (disposed) {
          throw new Error(modelText('runtime/plan-mode-index/text-19'))
        }
        const reviewItems = answer.answers.filter(entry => entry.id === REVIEW_ID)
        const item = reviewItems.length === 1 ? reviewItems[0] : undefined
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = item?.custom ?? ''
          throw new Error(feedback === ''
            ? modelText('runtime/plan-mode-index/text-20')
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // Keep plan guidance for the rest of this assistant tool batch. The
        // silent selection is appended at the next accepted in-turn pre-step,
        // before its request assembly.
        this.pendingIntents.set(agent.session, { active: false, narrate: false })
        return { approved: true }
      },
      presentCall: args => ({
        card: 'generic',
        title: firstHeading(args.plan) ?? 'Plan',
        kind: 'plan',
        content: [{ type: 'text', text: args.plan }],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'Plan review',
        content: result.content,
      }),
    }))
  }

  private loggedActive(session: Session): boolean {
    return this.planState(session).active
  }

  private hasOpenTurn(session: Session): boolean {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined) throw new Error('plan-mode requires the turnBoundary session projection')
    return state.openTurnStartSeq !== null
  }

  /** Read the required plan projection state or fail at the first service access. */
  private planState(session: Session): PlanUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'plan')
    if (state === undefined) throw new Error('plan-mode requires the plan session projection')
    return state
  }

  /**
   * Read the logged plan state and any selected state awaiting the next
   * accepted in-turn pre-step.
   *
   * @param agent The agent to read.
   * @returns Current logged state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.loggedActive(agent.session)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether plan mode should be active. Between turns the method
   * appends the change immediately because no in-turn pre-step will run until
   * another prompt starts a turn; the switch notice then joins that turn's
   * first accepted step, and nothing is queued in the inbox, so the session
   * stays idle for `run()`. The open-turn fold is the idle signal:
   * agent status stays `running` through post-turn checkpointing, when no
   * further in-turn pre-step runs. During an open turn the selection remains
   * pending until the next accepted in-turn pre-step. Repeated selection of
   * the current or already-pending state is a no-op.
   *
   * @param agent The agent to switch.
   * @param active Whether plan mode should be active.
   * @returns what happened: `committed` (logged now), `queued` (awaiting the
   * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
   * was cleared; the logged state already matches), or `noop` (already in that
   * state).
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? this.loggedActive(session)
    if (active === target) return 'noop'
    if (this.hasOpenTurn(session)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return this.loggedActive(session) === active ? 'cancelled' : 'queued'
    }
    // No open turn: commit now. Delete only after append succeeds so a
    // failed durable write leaves the selection retryable, not dropped.
    if (active === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('plan/mode', { active })
    this.pendingIntents.delete(session)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('plan/mode', { active: target })
    // Delete only after append succeeds so a later accepted in-turn pre-step
    // can retry a failed durable write.
    this.pendingIntents.delete(session)
  }

  /** The one-sentence user-switch notice for the mode now in force. */
  private notice(target: boolean): UserMessage {
    const text = target
      ? 'The user switched this session to plan mode.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The narration is already one sentence, so it is its own summary.
      source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice', summary: text },
    })
  }
}

export default PlanModeController
