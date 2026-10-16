/** Host API fixtures over the real io-agent loop, tools and persistence with a scripted loopback model. */
import { expect } from 'vitest'
import { createHost } from "../../../src/library/host/index.ts"
import type { ActivityView, Host, HostOptions, InteractionRequest, TurnReceipt } from "../../../src/library/host/index.ts"
import type { ModelConnection, IoAgentOptions } from "../../../src/index.ts"
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import type { SessionEvent } from "../../../src/library/session/journal/index.ts"
import { onFixtureCleanup, routerFixture } from './fixture.ts'

export type HostFixture = Awaited<ReturnType<typeof hostFixture>>

/**
 * Boot a host over a scripted endpoint: chat completions unless `ioAgent.model.api` says otherwise
 * (`api: undefined` selects the default wire, Responses).
 * @param reply Scripted model replies.
 * @param engine Engine overrides.
 * @param delivery Host overrides.
 * @returns Router evidence, the host, its options, and the engine context of the most recent host.
 */
export async function hostFixture(reply: Parameters<typeof routerFixture>[0],
  engine: Partial<Omit<IoAgentOptions, 'model'>> & { model?: Partial<ModelConnection> } = {}, delivery: Partial<Omit<HostOptions, 'ioAgent'>> = {}) {
  const router = await routerFixture(reply)
  const holder: { context?: Context } = {}
  const { configure, model, ...rest } = engine
  const options: HostOptions = { ioAgent: {
    workspace: router.workspace, stateDirectory: router.stateDirectory,
    model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, ...model },
    sandbox: 'workspace-write', approval: 'ask', skills: { watch: false }, ...rest,
    configure: async (context) => { holder.context = context; await configure?.(context) },
  }, interactionTimeoutMs: 10000, ...delivery }
  const open = async (): Promise<Host> => {
    const host = await createHost(options)
    onFixtureCleanup(() => host.close())
    return host
  }
  const host = await open()
  const context = (): Context => {
    if (holder.context === undefined) throw new Error('missing engine context')
    return holder.context
  }
  return { ...router, host, options, open, context }
}

/**
 * One submission body.
 * @param id Session id.
 * @param text Prompt text.
 * @param turnId Client turn id.
 * @returns Wire submission.
 */
export function turn(id: string, text: string, turnId = 'turn-application-01') {
  return { session_id: id, turn_id: turnId, prompt: text }
}

/**
 * Submit and wait for the started activity to settle.
 * @param host Host.
 * @param body Submission.
 * @returns Receipt and the settled activity.
 */
export async function run(host: Host, body: unknown): Promise<{ receipt: TurnReceipt; activity: ActivityView }> {
  const receipt = await host.submit(body)
  if (receipt.activity_id === undefined) throw new Error('submission started no activity')
  return { receipt, activity: await host.settled(receipt.session_id, receipt.activity_id) }
}

/**
 * Durable journal events of one session, open or not.
 * @param context Engine context.
 * @param id Session id.
 * @returns Events in order.
 */
export async function journal(context: Context, id: string): Promise<SessionEvent[]> {
  return (await context.sessionQuery.readSession(SessionId(id))).events
}

/**
 * Wait for the current activity to be running.
 * @param host Host.
 * @param id Session id.
 * @returns The running activity.
 */
export async function current(host: Host, id: string): Promise<ActivityView> {
  await expect.poll(() => host.readSession(id).activity?.status, { timeout: 5000 }).toBe('running')
  const activity = host.readSession(id).activity
  if (activity === undefined) throw new Error('missing current activity')
  return activity
}

/**
 * Wait for a pending interaction of a kind on the current activity.
 * @param host Host.
 * @param id Session id.
 * @param kind Interaction kind.
 * @returns The activity and its request.
 */
export async function pending(host: Host, id: string, kind: InteractionRequest['kind']): Promise<{ activity: ActivityView; request: InteractionRequest }> {
  await expect.poll(() => host.readSession(id).activity?.pending_requests.some(request => request.kind === kind), { timeout: 5000 }).toBe(true)
  const activity = await current(host, id)
  const request = activity.pending_requests.find(item => item.kind === kind)
  if (request === undefined) throw new Error('interaction disappeared')
  return { activity, request }
}

/**
 * Wait until an activity settled.
 * @param host Host.
 * @param activity Activity.
 */
export async function settledView(host: Host, activity: ActivityView): Promise<void> {
  await expect.poll(() => host.readActivity(activity.session_id, activity.activity_id).status, { timeout: 5000 }).toBe('settled')
}
