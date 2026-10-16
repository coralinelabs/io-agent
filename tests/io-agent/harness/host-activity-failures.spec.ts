/** Native execution continues through delivery faults; cancellation still owns its captured persistence barrier. */
import { expect, it, vi } from 'vitest'
import { createUserMessage } from "../../../src/library/model/llm/index.ts"
import { SessionId } from "../../../src/library/session/journal/index.ts"
import { stream, tool } from './fixture.ts'
import type { routerFixture } from './fixture.ts'
import { hostFixture, journal, turn } from './host-fixture.ts'

async function fixture(reply: Parameters<typeof routerFixture>[0]) {
  const f = await hostFixture(reply, { sandbox: 'danger-full-access', approval: 'never' })
  const id = await f.host.createSession()
  return { ...f, id }
}
function submit(f: Awaited<ReturnType<typeof fixture>>) {
  return f.host.submit(turn(f.id, 'Exercise the native activity.', 'fault-boundary-submission'))
}

it('keeps autonomous controls discoverable when the session delivery projection fails', async () => {
  const questions = [{ id: 'delivery-question', question: 'Continue after delivery failure?', options: [{ label: 'Continue' }] }]
  const f = await fixture((_request, response, index) => {
    if (index === 1) tool(response, 'ask_user_question', { questions })
    else stream(response, [{ content: 'Native work completed.' }])
  })
  const receipt = await submit(f)
  await f.host.settled(f.id, receipt.activity_id!)
  await expect.poll(() => f.host.readSession(f.id).busy).toBe(false)
  const stringify = JSON.stringify
  let injected = false
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown, ...rest: unknown[]) => {
    // Fail one delivery envelope, without changing any native event or model input.
    if (!injected && typeof value === 'object' && value !== null && 'v' in value && 'seq' in value && 'session_id' in value) {
      injected = true
      throw new TypeError('Injected delivery projection failure')
    }
    return (stringify as (...args: unknown[]) => string)(value, ...rest)
  })
  try {
    const agent = f.context().agents.get(SessionId(f.id))
    if (agent === undefined) throw new Error('missing native agent')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native followup needs a human answer.' }], source: { kind: 'plugin', plugin: 'activity-fault-fixture' } }))
    await expect.poll(() => f.host.readSession(f.id).activity?.pending_requests.length).toBe(1)
    const view = f.host.readSession(f.id)
    expect(injected).toBe(true)
    expect(view.delivery_error?.code).toBe('TRANSPORT_ERROR')
    expect(() => f.host.readSession(f.id, view.last_seq)).toThrow(expect.objectContaining({ code: 'TRANSPORT_ERROR' }))
    const activity = view.activity
    const request = activity?.pending_requests[0]
    if (activity === undefined || request?.kind !== 'question') throw new Error('missing autonomous question')
    expect(activity.turn_id).toBeUndefined()
    expect(f.host.readActivity(f.id, activity.activity_id).pending_requests).toHaveLength(1)
    f.host.reply({ session_id: f.id, activity_id: activity.activity_id, request_id: request.request_id, kind: 'question',
      answer: { answers: [{ id: 'delivery-question', selected: ['Continue'] }] } })
    await expect.poll(() => f.host.readActivity(f.id, activity.activity_id).status).toBe('settled')
    expect(f.requests).toHaveLength(3)
    expect((await journal(f.context(), f.id)).filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect((await f.host.history(f.id)).events.filter(event => event.type === 'end')).toHaveLength(2)
  } finally { spy.mockRestore() }
}, 30000)

it('rejects activity cancellation when its captured persistence barrier fails', async () => {
  const entered = Promise.withResolvers<undefined>()
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); entered.resolve(undefined)
  })
  const receipt = await submit(f)
  await entered.promise
  const activityId = receipt.activity_id!
  const spy = vi.spyOn(f.context().sessionPersistence, 'flush').mockRejectedValueOnce(new Error('Injected persistence barrier failure'))
  try {
    await expect(f.host.cancel(f.id, activityId)).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
    expect(f.host.readActivity(f.id, activityId)).toMatchObject({ status: 'settled', end: 'cancelled', error: { code: 'TRANSPORT_ERROR' } })
    expect(f.host.readSession(f.id).events.some(event => event.type === 'activity' && event.state === 'failed' && event.activity_id === activityId)).toBe(true)
    await expect(f.host.cancel(f.id, activityId)).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
    await expect(f.host.settled(f.id, activityId)).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
    expect(f.requests).toHaveLength(1)
  } finally { spy.mockRestore() }
}, 30000)

it('awaits the retired activity barrier before cancellation acknowledges', async () => {
  const f = await fixture((_request, response) => { stream(response, [{ content: 'The native interval finished.' }]) })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const flush = f.context().sessionPersistence.flush.bind(f.context().sessionPersistence)
  // Admission now crosses its own persistence barrier; hold the later activity barrier.
  const spy = vi.spyOn(f.context().sessionPersistence, 'flush').mockImplementationOnce(flush).mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    await flush()
  })
  const receipt = await submit(f)
  let cancellation: Promise<unknown> | undefined
  try {
    await entered.promise
    expect(f.host.readSession(f.id).activity).toBeUndefined()
    expect(f.host.readActivity(f.id, receipt.activity_id!).status).toBe('settling')
    expect(f.host.readSession(f.id).busy).toBe(true)
    await expect(f.host.submit(turn(f.id, 'Too early.', 'while-settling'))).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    let acknowledged = false
    cancellation = f.host.cancel(f.id, receipt.activity_id).then(() => { acknowledged = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(acknowledged, 'cancel must not acknowledge before the captured activity barrier').toBe(false)
    release.resolve(undefined)
    await cancellation
    expect(f.host.readActivity(f.id, receipt.activity_id!)).toMatchObject({ status: 'settled', end: 'done' })
    expect(f.host.readSession(f.id).busy).toBe(false)
    expect(f.requests).toHaveLength(1)
  } finally { release.resolve(undefined); await cancellation; spy.mockRestore() }
}, 30000)
