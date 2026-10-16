/**
 * Model-facing `job_output`, `job_list`, and `job_kill` tools over
 * `ctx.jobs`. Loading the plugin attaches the controller required by
 * producers. It also delivers unreported completions to the owning agent:
 * injected into a busy owner's next step, or opening a turn on an idle one
 * under the default `wakeup` delivery, bounded per owner. An owner left idle
 * with its jobs still running is woken again after `checkInMs` to look at them.
 * @module io-agent/tool-jobs
 */

import { modelText } from "../../../context/text/index.ts"
import type { Context } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import { boundContextSummary, createUserMessage, freezeMessage, type ContentBlock, type UserMessage } from "../../../model/llm/index.ts"
import { TextRetainer } from "../../../util/output-retention/index.ts"
import { defineTool } from "../../../tools/index.ts"
import type { GenericCallView, ToolDefinition, ToolExecution } from "../../../tools/index.ts"
import { JobId } from "../jobs/index.ts"
import type { JobSnapshot } from "../jobs/index.ts"
import { noticeMessageId } from "../jobs/notice.ts"
import type { Agent } from "../../../runtime/agents/index.ts"
import { MAX_TIMER_DELAY_MS } from "../../../util/timeout/index.ts"

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * How an unreported completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** Configures bounded `job_output` waits and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when `job_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice waits for the owner's check-in (`checkInMs`; injected when check-ins
   * are off), reset by any user-authored input (default 3). Bounds the pace of
   * the self-exciting chain where a woken turn starts the job whose completion
   * wakes it again.
   */
  maxConsecutiveWakes?: number
  /**
   * Under `wakeup` delivery, how long an owner may stay idle while jobs it owns
   * are still running before a check-in opens a turn naming them (default 30
   * min, `0` for none). It repeats while they run and the owner stays idle.
   * Check-ins are paced by this period, so they leave the completion wake
   * budget alone; completions past that budget wake the owner with them.
   */
  checkInMs?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1).default(3),
  checkInMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(1_800_000),
})

/** Task state safe for model-authored programs; ownership/bookkeeping fields are omitted. */
export interface PublicJobSnapshot {
  id: string
  kind: string
  label: string
  status: JobSnapshot['status']
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** Shared schema for job-control outputs. */
const PUBLIC_JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

/** Remove job ownership and notification bookkeeping from a registry snapshot. */
function publicJob(snapshot: JobSnapshot): PublicJobSnapshot {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    startedAt: snapshot.startedAt,
    ...snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {},
  }
}

/**
 * Render generic status with optional producer detail.
 * @param snapshot - job state to render.
 * @returns a bracketed status line.
 */
export function statusLine(snapshot: Pick<JobSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * One-line account of a settled job for the `notice` form's collapsed row.
 * @param snapshot - the settled job.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(snapshot: JobSnapshot): string {
  return boundContextSummary(`${snapshot.kind} ${snapshot.label} ${statusLine(snapshot)}`)
}

function fitCompletionNotice(snapshot: JobSnapshot): string {
  const prefix = `background job ${snapshot.id}`
  const detail = ` (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}`
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = snapshot.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  const actionBytes = encoder.encode(action).byteLength
  if (actionBytes >= maxBytes) return retainTail(action, maxBytes)
  return `${retainHead(prefix, maxBytes - actionBytes)}${action}`
}

/**
 * The check-in for an owner whose jobs outlasted its idleness.
 * @param running - the owner's still-running jobs.
 * @returns the notice text naming each of them.
 */
function checkInNotice(running: readonly JobSnapshot[]): string {
  const jobs = running.map(snapshot => boundContextSummary(`${snapshot.id} (${snapshot.kind}: ${snapshot.label})`)).join(', ')
  return modelText('runtime/tool-jobs-index/text-12', { jobs })
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_kill') return undefined
  const jobId = (exec.arguments as { job_id?: unknown } | null | undefined)?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  return ctx.jobs.list(exec.agent).find(snapshot => snapshot.id === jobId)?.outputLimitBytes
}

/** Validate the non-empty constraint that ParameterSchemaSpec cannot express. */
function validateJobId(value: string): JobId {
  if (value.length === 0) {
    throw new Error(modelText('foundation/tool-jobs-index/text-01', { value_1: String(JSON.stringify(value)) }))
  }
  return JobId(value)
}

/** Pending presentation shared by the three generic job controls. */
function presentJobCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes ?? 3

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(modelText('runtime/tool-jobs-index/text-01', { value_1: String(waitDefault), value_2: String(waitCap) }))
  }
  // A budget is a count of turns. `Infinity` would leave the runaway chain this
  // field exists to bound unbounded, and a fraction never names a turn at all.
  if (!Number.isSafeInteger(wakeBudget)) {
    throw new Error(modelText('runtime/tool-jobs-index/text-02', { value_1: String(wakeBudget) }))
  }
  // Nothing spends the budget under quiet delivery, so nothing needs to refill it.
  if (delivery === 'wakeup') {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeJobContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'job_output' && !result.isError) {
      // This definition owns and schema-validates the canonical value. Preserve
      // its output/status split only while policy left the default rendering intact.
      const value = result.value as unknown as { text: string; job: PublicJobSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.job)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // Producers may start work only while a controller is attached.
  ctx.jobs.attachController('tool-jobs')

  // Check-ins: an owner that went idle with its own jobs still running is
  // woken after `checkInMs`, and again after each idle period while they run.
  // The same timer carries completions the wake budget held back, so a chain
  // of woken turns slows to one turn per period instead of falling silent.
  const checkInMs = config.checkInMs ?? 1_800_000
  const idleWakes = new Map<Agent, { timer?: ReturnType<typeof setTimeout>; held: UserMessage[] }>()
  const running = (agent: Agent): JobSnapshot[] => ctx.jobs.list(agent)
    .filter(snapshot => snapshot.ownerSession === agent.session.id && snapshot.status === 'running')
  const disarm = (agent: Agent): UserMessage[] => {
    const state = idleWakes.get(agent)
    idleWakes.delete(agent)
    clearTimeout(state?.timer)
    if (state?.timer !== undefined) ctx.get('background')?.noteCheckIn(String(agent.id), undefined)
    return state?.held ?? []
  }
  /** Arm the idle owner's wake, once, if it holds completions or has jobs still running. */
  const arm = (agent: Agent): void => {
    const state = idleWakes.get(agent) ?? { held: [] }
    if (state.timer !== undefined || (state.held.length === 0 && running(agent).length === 0)) return
    idleWakes.set(agent, state)
    state.timer = setTimeout(() => {
      const held = disarm(agent)
      const jobs = running(agent)
      const messages = [...held, ...jobs.length === 0 ? [] : [createUserMessage({
        content: [{ type: 'text', text: checkInNotice(jobs) }],
        source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: boundContextSummary(`check-in: ${jobs.map(job => job.id).join(', ')}`) },
      })]]
      const last = messages.pop()
      if (last === undefined) return
      for (const message of messages) agent.inject(message)
      // A busy owner reads them at its next step; an idle one is woken by the last.
      if (agent.status === 'idle') agent.followup(last)
      else agent.inject(last)
    }, checkInMs)
    state.timer.unref?.()
    // Hosts list the pending wake beside the session's watchers.
    ctx.get('background')?.noteCheckIn(String(agent.id), Date.now() + checkInMs)
  }
  if (delivery === 'wakeup' && checkInMs > 0) {
    ctx.on('agent/status', ({ agent, status }) => {
      // Held completions go to a turn that is starting anyway; an idle owner re-arms.
      const held = disarm(agent)
      for (const message of held) agent.inject(message)
      if (status === 'idle') arm(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => { disarm(agent) })
    // An agent reopened after a restart starts idle, so no idle transition arms its check-in: arm it once it is
    // attached, while its adopted jobs still run.
    ctx.on('agent/created', ({ agent }) => {
      setImmediate(() => { if (agent.status === 'idle') arm(agent) })
      return undefined
    })
    ctx.effect(() => () => {
      for (const agent of [...idleWakes.keys()]) disarm(agent)
    }, 'tool-jobs.check-ins')
  }

  // Cross-call guidance follows the filesystem sections and precedes product sections.
  ctx.systemPrompt.section({
    name: 'tool:jobs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: modelText('runtime/tool-jobs-index/text-03'),
  })

  // Use the exact lifecycle owner; reusable ids could resolve to a replacement.
  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so jobs settling together cost one step. An
  // idle owner is woken instead, because an unclaimed notice is a completion
  // the model never learns about. Either way, disposal before the claim
  // discards it with the owner, and teardown settlements arrive `reported`.
  //
  // The registry routes each settlement to the listeners its owner's scope
  // chain reaches, so a mount under one preset never sees another preset's
  // agents; this listener owns delivery, not the choice of whom to deliver to.
  ctx.jobs.onJobDone((snapshot, owner) => {
    if (owner === undefined) return
    // A watcher waiting for this job reports its end itself (a durable job's end is claimed
    // before it settles here), so the agent hears about it once.
    if (snapshot.key === undefined && ctx.get('background')?.claimJobEnd(String(owner.id), snapshot.id, statusLine(snapshot)) === true) return
    if (snapshot.reported) return
    const content: ContentBlock[] = [{ type: 'text', text: fitCompletionNotice(snapshot) }]
    const source = { kind: 'plugin' as const, plugin: 'tool-jobs', form: 'notice' as const, summary: completionSummary(snapshot) }
    // A job that outlives the process has one notice identity, so a notice re-sent after a
    // restart is recognizably the same one; it is never queued twice.
    let message: UserMessage
    if (snapshot.key === undefined) message = createUserMessage({ content, source })
    else {
      const id = noticeMessageId(snapshot.key)
      if ([...owner.inbox.nextTurn, ...owner.inbox.nextStep].some(pending => pending.id === id)) return
      message = freezeMessage({ role: 'user', id, content, source })
    }
    const spent = spentWakes.get(owner) ?? 0
    if (delivery === 'wakeup' && owner.status === 'idle' && spent < wakeBudget) {
      spentWakes.set(owner, spent + 1)
      owner.followup(message)
      return
    }
    // Past the budget an idle owner is still woken, at the check-in pace.
    if (delivery === 'wakeup' && owner.status === 'idle' && checkInMs > 0) {
      const state = idleWakes.get(owner) ?? { held: [] }
      idleWakes.set(owner, state)
      state.held.push(message)
      arm(owner)
      return
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: modelText('runtime/tool-jobs-index/text-04'),
    // A timed-out wait returns job state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      job_id: { type: 'string', required: true, description: modelText('runtime/tool-jobs-index/text-05') },
      wait: { type: 'boolean', description: modelText('runtime/tool-jobs-index/text-06') },
      timeout_ms: { type: 'number', description: modelText('runtime/tool-jobs-index/text-07') },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.job)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      if (args.wait === true) {
        const timeout = Math.min(args.timeout_ms ?? waitDefault, waitCap)
        await ctx.jobs.wait(id, timeout, exec.agent, exec.signal)
      }
      const read = ctx.jobs.read(id, exec.agent)
      return { text: read.lossy ? modelText('jobs/output-gap') + '\n' + read.text : read.text, job: publicJob(read.snapshot) }
    },
    presentCall: args => presentJobCall(`Read output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_list',
    description: modelText('runtime/tool-jobs-index/text-08'),
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_JOB_SCHEMA },
      render: (_args, jobs) => [{
        type: 'text',
        text: jobs.length === 0
          ? '(no background jobs)'
          : jobs.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const jobs = ctx.jobs.list(exec.agent)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentJobCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: modelText('runtime/tool-jobs-index/text-09'),
    parameters: {
      job_id: { type: 'string', required: true, description: modelText('runtime/tool-jobs-index/text-10') },
      reason: { type: 'string', description: modelText('runtime/tool-jobs-index/text-11') },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `job ${value.job.id} had already finished ${statusLine(value.job)}`
          : `requested cancellation of job ${value.job.id}`,
      }],
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      // Durable cancellation is acknowledged only after its intent is on disk.
      if (exec.agent !== undefined) await ctx.get('background')?.kill(String(exec.agent.id), id, args.reason)
      const result = ctx.jobs.kill(id, exec.agent, args.reason)
      // A snapshot describes current state without consuming pending output.
      const snapshot = publicJob(ctx.jobs.get(id, exec.agent))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job: snapshot,
      })
    },
    presentCall: args => presentJobCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))
}
