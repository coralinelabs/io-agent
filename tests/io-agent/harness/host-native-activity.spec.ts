/** Native background work stays observable and controllable after its submitted activity settles. */
import { expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { createUserMessage } from "../../../src/library/model/llm/index.ts"
import type { ActivityView, HostOptions } from "../../../src/library/host/index.ts"
import type { IoAgentOptions } from "../../../src/index.ts"
import { stream, tool } from './fixture.ts'
import type { routerFixture } from './fixture.ts'
import { current, hostFixture, journal, pending, run, settledView, turn } from './host-fixture.ts'

const questions = [{ id: 'after-job', question: 'Continue after background completion?', options: [{ label: 'Continue' }, { label: 'Stop' }] }]
const background = { command: 'while [ ! -f release-job ]; do sleep 0.02; done; printf BACKGROUND_COMPLETE', description: 'Wait for the test-owned release file', run_in_background: true }
type Reply = Parameters<typeof routerFixture>[0]

function fixture(reply: Reply, engine: Partial<IoAgentOptions> = {}, delivery: Partial<Omit<HostOptions, 'ioAgent'>> = {}) {
  return hostFixture(reply, { sandbox: 'danger-full-access', ...engine }, delivery)
}
async function backgroundFixture(reply: Reply, engine: Partial<IoAgentOptions> = {}, delivery: Partial<Omit<HostOptions, 'ioAgent'>> = {}) {
  const f = await fixture((request, response, index) => {
    if (index === 0) tool(response, 'bash', background, 'background-start')
    else if (index === 1) stream(response, [{ content: 'Initial submitted work settled.' }])
    else return reply(request, response, index)
  }, engine, delivery)
  const id = await f.host.createSession()
  const submission = turn(id, 'Start a background job and react after it finishes.', 'initial-background-01')
  const { receipt, activity } = await run(f.host, submission)
  expect(activity.end).toBe('done')
  expect(f.requests).toHaveLength(2)
  await expect.poll(() => f.host.readSession(id).busy).toBe(false)
  return { ...f, id, submission, receipt, release: () => writeFile(join(f.workspace, 'release-job'), 'go') }
}
function answer(activity: ActivityView, requestId: string) {
  return { session_id: activity.session_id, activity_id: activity.activity_id,
    request_id: requestId, kind: 'question', answer: { answers: [{ id: 'after-job', selected: ['Continue'] }] } }
}
function rootCapture() {
  const holder: { agent?: Agent } = {}
  return { holder, configure: (context: Parameters<NonNullable<IoAgentOptions['configure']>>[0]) => {
    context.on('agent/created', ({ agent }) => { if (agent.session.header.parentSession === undefined) holder.agent = agent })
  } }
}

it('observes a post-result bash completion and answers its separate activity across observer reconnects', async () => {
  const f = await backgroundFixture((_request, response, index) => {
    if (index === 2) tool(response, 'ask_user_question', { questions }, 'woken-question')
    else stream(response, [{ content: 'The autonomous continuation finished.' }])
  })
  const original = f.host.readActivity(f.id, f.receipt.activity_id!)
  const before = f.host.readSession(f.id).last_seq
  await f.release()
  const { activity, request } = await pending(f.host, f.id, 'question')
  expect(activity.turn_id).toBeUndefined()
  expect(activity.activity_id).not.toBe(original.activity_id)
  expect(f.host.readActivity(f.id, original.activity_id)).toEqual(original)
  expect(await f.host.submit(f.submission)).toMatchObject({ turn_id: f.submission.turn_id, duplicate: true })
  expect(f.requests).toHaveLength(3)
  const disconnected = new AbortController(); disconnected.abort()
  await expect(f.host.watchSession(f.id, before, disconnected.signal).next()).rejects.toThrow()
  const observer = f.host.watchSession(f.id, before)
  const replay = await observer.next(); await observer.return()
  expect(replay.done).toBe(false)
  expect(f.host.readSession(f.id, before).events.some(event => event.type === 'interaction' && event.activity_id === activity.activity_id)).toBe(true)
  expect(f.requests[2]!.tools?.some(entry => entry.function.name === 'ask_user_question')).toBe(true)
  expect(() => f.host.reply({ ...answer(activity, request.request_id), activity_id: original.activity_id })).toThrow(expect.objectContaining({ code: 'REQUEST_CLOSED' }))
  const reply = answer(activity, request.request_id)
  expect(f.host.reply(reply)).toEqual(f.host.reply(reply))
  expect(() => f.host.reply({ ...reply, answer: { answers: [{ id: 'after-job', selected: ['Stop'] }] } })).toThrow(expect.objectContaining({ code: 'ANSWER_CONFLICT' }))
  await settledView(f.host, activity)
  expect(() => f.host.reply({ ...reply, request_id: 'no-such-request' })).toThrow()
  expect(f.requests).toHaveLength(4)
  expect(JSON.stringify(f.requests[3]!.messages)).toContain('Continue')
  expect(f.host.readActivity(f.id, original.activity_id)).toEqual(original)
  expect((await journal(f.context(), f.id)).filter(event => event.type === 'turn/end')).toHaveLength(2)
}, 30000)

it.each(['allowed-once', 'rejected'] as const)('routes an autonomous approval with exact current arguments (%s)', async (decision) => {
  const mutation = { action: 'put', key: 'autonomous-note', value: 'VALUE_FROM_CURRENT_ACTION', revision: 0 }
  const f = await backgroundFixture((_request, response, index) => {
    if (index === 2) tool(response, 'memory', mutation, 'autonomous-memory')
    else stream(response, [{ content: 'The explicit memory decision was applied.' }])
  })
  await f.release()
  const { activity, request } = await pending(f.host, f.id, 'approval')
  if (request.kind !== 'approval') throw new Error('missing approval')
  expect(request.agent_id).toBe(f.id)
  expect(request.toolName).toBe('memory'); expect(request.callId).toBe('autonomous-memory')
  expect(request.arguments).toEqual(mutation)
  ;(request.arguments as { value: string }).value = 'DISPLAY_MUTATION'
  expect((await pending(f.host, f.id, 'approval')).request).toMatchObject({ arguments: mutation })
  const reply = { session_id: f.id, activity_id: activity.activity_id, request_id: request.request_id, kind: 'approval', decision }
  expect(f.host.reply(reply)).toEqual(f.host.reply(reply))
  expect(() => f.host.reply({ ...reply, decision: decision === 'rejected' ? 'allowed-once' : 'rejected' })).toThrow()
  await settledView(f.host, activity)
  const events = await journal(f.context(), f.id)
  expect(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual([decision])
  expect(events.filter(event => event.type === 'tool/result').at(-1)?.data.message.isError === true).toBe(decision === 'rejected')
  expect(JSON.stringify(f.requests)).not.toContain('DISPLAY_MUTATION')
  expect(f.requests).toHaveLength(4)
}, 30000)

it('rejects submit and maintenance during native inference, and only its current identity can cancel it', async () => {
  const reached = Promise.withResolvers<undefined>()
  let response: ServerResponse | undefined
  const f = await backgroundFixture((_request, res) => { response = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); reached.resolve(undefined) })
  await f.release(); await reached.promise
  const activity = await current(f.host, f.id)
  expect(f.host.readSession(f.id).busy).toBe(true)
  await expect(f.host.submit(turn(f.id, 'Busy user submission.', 'busy-user-submission'))).rejects.toMatchObject({ code: 'SESSION_BUSY' })
  await expect(f.host.compact(f.id)).rejects.toMatchObject({ code: 'SESSION_BUSY' })
  await expect(f.host.verify(f.id)).rejects.toMatchObject({ code: 'SESSION_BUSY' })
  expect(await f.host.cancel(f.id, f.receipt.activity_id)).toMatchObject({ status: 'settled', end: 'done' })
  expect(response?.destroyed).toBe(false)
  expect(f.host.readActivity(f.id, activity.activity_id).status).toBe('running')
  expect(await f.host.cancel(f.id, activity.activity_id)).toMatchObject({ status: 'settled', end: 'cancelled' })
  expect(f.host.readSession(f.id).busy).toBe(false)
  expect(await f.host.cancel(f.id)).toBeUndefined()
  expect(f.requests).toHaveLength(3)
  expect((await journal(f.context(), f.id)).filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
}, 30000)

it('cancels an autonomous foreground tool before its delayed filesystem mutation', async () => {
  const f = await backgroundFixture((_request, response) => { tool(response, 'bash', {
    command: 'printf ready > active-tool; sleep 30; printf bad > must-not-exist', description: 'Wait for explicit activity cancellation', timeout_ms: 40000,
  }, 'autonomous-bash') })
  await f.release()
  await expect.poll(() => readFile(join(f.workspace, 'active-tool'), 'utf8').catch(() => ''), { timeout: 5000 }).toBe('ready')
  const activity = await current(f.host, f.id)
  await f.host.cancel(f.id, f.receipt.activity_id)
  expect(f.host.readActivity(f.id, activity.activity_id).status).toBe('running')
  await f.host.cancel(f.id, activity.activity_id)
  await expect(readFile(join(f.workspace, 'must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.requests).toHaveLength(3)
  expect((await journal(f.context(), f.id)).filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
}, 30000)

it('withdraws an autonomous question on cancellation and rejects a late answer without inference', async () => {
  const f = await backgroundFixture((_request, response) => { tool(response, 'ask_user_question', { questions }, 'cancel-question') })
  await f.release(); const { activity, request } = await pending(f.host, f.id, 'question')
  await f.host.cancel(f.id, activity.activity_id)
  expect(f.host.readActivity(f.id, activity.activity_id).pending_requests).toEqual([])
  expect(() => f.host.reply(answer(activity, request.request_id))).toThrow()
  expect(f.host.readSession(f.id).events.some(event => event.type === 'interaction_closed' && event.request_id === request.request_id && event.reason === 'cancelled')).toBe(true)
  expect(f.requests).toHaveLength(3)
}, 30000)

it('exposes a later autonomous control despite replay and activity-identity eviction', async () => {
  const f = await backgroundFixture((_request, response, index) => {
    if (index === 2) tool(response, 'ask_user_question', { questions }, 'evicted-question')
    else stream(response, [{ content: 'Finished after eviction.' }])
  }, {}, { maxReplayEvents: 2, maxActivities: 1 })
  await f.release()
  const { activity, request } = await pending(f.host, f.id, 'question')
  const page = f.host.readSession(f.id)
  expect(page.events.length).toBeLessThanOrEqual(2)
  expect(() => f.host.readSession(f.id, f.receipt.after)).toThrow(expect.objectContaining({ code: 'REPLAY_GAP' }))
  expect(() => f.host.readActivity(f.id, f.receipt.activity_id!)).toThrow(expect.objectContaining({ code: 'UNKNOWN_ACTIVITY' }))
  expect(page.activity?.pending_requests).toHaveLength(1)
  expect(f.host.readActivity(f.id, activity.activity_id).pending_requests).toHaveLength(1)
  f.host.reply(answer(activity, request.request_id))
  await settledView(f.host, activity)
  expect(f.requests).toHaveLength(4)
}, 30000)

it('lets native background completion queue once during an already active user activity', async () => {
  const root = rootCapture()
  let activeResponse: ServerResponse | undefined
  const reached = Promise.withResolvers<undefined>()
  const f = await backgroundFixture((_request, response, index) => {
    if (index === 2) { activeResponse = response; reached.resolve(undefined) }
    else stream(response, [{ content: 'Processed the one native job notification.' }])
  }, { configure: root.configure })
  const receipt = await f.host.submit(turn(f.id, 'User work is currently active.', 'active-user-interval'))
  await reached.promise
  const activity = await current(f.host, f.id)
  expect(activity.activity_id).toBe(receipt.activity_id)
  expect(activity.turn_id).toBe('active-user-interval')
  await f.release()
  await expect.poll(() => root.holder.agent?.inbox.nextStep.length, { timeout: 5000 }).toBe(1)
  expect(f.requests).toHaveLength(3)
  if (activeResponse === undefined) throw new Error('missing active response')
  stream(activeResponse, [{ content: 'The user request finished.' }])
  expect((await f.host.settled(f.id, receipt.activity_id!)).end).toBe('done')
  expect(f.requests).toHaveLength(4)
  const events = await journal(f.context(), f.id)
  expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)
  expect(f.host.readSession(f.id).events.filter(event => event.type === 'activity' && event.state === 'started')).toHaveLength(2)
}, 30000)

it('keeps background child restrictions and observes its parent wake after parent settlement', async () => {
  let childResponse: ServerResponse | undefined
  let parentRequests = 0, childRequests = 0
  let outside = ''
  const f = await fixture((request, response) => {
    const child = !request.tools?.some(entry => entry.function.name === 'ask_user_question')
    if (child) {
      childRequests++
      if (childRequests === 1) { childResponse = response; return }
      if (childRequests === 2) tool(response, 'memory', { action: 'put', key: 'child-note', value: 'FORBIDDEN_CHILD_NOTE', revision: 0 }, 'child-memory')
      else if (childRequests === 3) tool(response, 'write', { file_path: outside, content: 'FORBIDDEN_CHILD_WRITE', sandbox_permissions: 'danger-full-access', justification: 'Request a sibling write' }, 'child-write')
      else stream(response, [{ content: 'The restricted child finished.' }])
      return
    }
    parentRequests++
    if (parentRequests === 1) tool(response, 'subagent', { description: 'Inspect', prompt: 'Inspect in the background.', run_in_background: true }, 'background-child')
    else if (parentRequests === 2) stream(response, [{ content: 'Parent submitted interval settled.' }])
    else if (parentRequests === 3) tool(response, 'ask_user_question', { questions }, 'parent-wake-question')
    else stream(response, [{ content: 'Parent continuation finished.' }])
  }, { sandbox: 'workspace-write', memory: { writePolicy: 'allow' } })
  outside = join(f.workspace, '..', 'child-outside')
  const id = await f.host.createSession()
  await run(f.host, turn(id, 'Delegate in the background.', 'background-child-parent'))
  expect(parentRequests).toBe(2)
  await expect.poll(() => childResponse !== undefined).toBe(true)
  if (childResponse === undefined) throw new Error('missing child request')
  tool(childResponse, 'ask_user_question', { questions }, 'forbidden-child-question')
  const { activity, request } = await pending(f.host, id, 'question')
  expect(request.agent_id).toBe(id)
  expect(activity.turn_id).toBeUndefined()
  expect(childRequests).toBe(4)
  const children = f.requests.filter(row => !row.tools?.some(entry => entry.function.name === 'ask_user_question'))
  expect(JSON.stringify(children[1]!.messages)).toContain('ask_user_question')
  expect(JSON.stringify(children[2]!.messages)).toContain('cannot')
  expect(JSON.stringify(children[3]!.messages)).toContain('rejected escalating')
  await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.host.readSession(id).events.filter(event => event.type === 'interaction')).toHaveLength(1)
  f.host.reply(answer(activity, request.request_id)); await settledView(f.host, activity)
  expect(parentRequests).toBe(4)
  expect(f.requests).toHaveLength(8)
}, 30000)

it('observes native inbox followups and never lets a stale settled activity cancel later work', async () => {
  const root = rootCapture()
  const f = await fixture((_request, response, index) => {
    if (index === 0) stream(response, [{ content: 'Original work done.' }])
    else tool(response, 'ask_user_question', { questions }, 'inbox-question')
  }, { configure: root.configure }, { maxActivities: 2 })
  const id = await f.host.createSession()
  const { receipt } = await run(f.host, turn(id, 'Finish the original work.', 'native-inbox-original'))
  if (root.holder.agent === undefined) throw new Error('missing root')
  root.holder.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native injected followup asks the human.' }], source: { kind: 'user' } }))
  const { activity, request } = await pending(f.host, id, 'question')
  expect(activity.activity_id).not.toBe(receipt.activity_id)
  expect(activity.turn_id).toBeUndefined()
  await f.host.cancel(id, receipt.activity_id)
  expect(f.host.readActivity(id, activity.activity_id).pending_requests).toHaveLength(1)
  await f.host.cancel(id, activity.activity_id)
  expect(() => f.host.reply(answer(activity, request.request_id))).toThrow()
  expect(f.requests).toHaveLength(2)
}, 30000)

it('closes an autonomous pending approval and drains persistence without fabricating permission', async () => {
  const f = await backgroundFixture((_request, response) => { tool(response, 'memory', { action: 'put', key: 'closed-autonomous', value: 'NOT_AUTHORIZED', revision: 0 }, 'close-approval') })
  await f.release(); const { activity, request } = await pending(f.host, f.id, 'approval')
  await f.host.close()
  expect(() => f.host.reply({ session_id: f.id, activity_id: activity.activity_id, request_id: request.request_id, kind: 'approval', decision: 'allowed-once' })).toThrow()
  const replacement = await f.open()
  await replacement.resumeSession(f.id)
  const events = await journal(f.context(), f.id)
  expect(events.filter(event => event.type === 'approval/decided').every(event => event.data.outcome !== 'allowed-once')).toBe(true)
  expect(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
  expect(f.requests).toHaveLength(3)
}, 30000)

it('evicts settled activity identities without evicting the current control or retargeting stale cancellation', async () => {
  const root = rootCapture()
  const f = await fixture((_request, response, index) => {
    if (index === 0) stream(response, [{ content: 'Initial interval complete.' }])
    else tool(response, 'ask_user_question', { questions }, 'capacity-question')
  }, { configure: root.configure }, { maxActivities: 1 })
  const id = await f.host.createSession()
  const { receipt } = await run(f.host, turn(id, 'Finish the original interval.', 'activity-capacity-original'))
  if (root.holder.agent === undefined) throw new Error('missing root')
  root.holder.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native followup after capacity is full.' }], source: { kind: 'user' } }))
  const { activity, request } = await pending(f.host, id, 'question')
  expect(() => f.host.readActivity(id, receipt.activity_id!)).toThrow(expect.objectContaining({ code: 'UNKNOWN_ACTIVITY' }))
  await expect(f.host.cancel(id, receipt.activity_id)).rejects.toMatchObject({ code: 'UNKNOWN_ACTIVITY' })
  expect(f.host.readActivity(id, activity.activity_id).pending_requests).toHaveLength(1)
  await f.host.cancel(id, activity.activity_id)
  expect(() => f.host.reply(answer(activity, request.request_id))).toThrow()
  expect(f.requests).toHaveLength(2)
}, 30000)

it('times out an unanswered autonomous question and releases its callback before rejecting a late answer', async () => {
  const f = await backgroundFixture((_request, response, index) => {
    if (index === 2) tool(response, 'ask_user_question', { questions }, 'timeout-question')
    else stream(response, [{ content: 'The unavailable answer remains unresolved.' }])
  }, {}, { interactionTimeoutMs: 250 })
  await f.release(); const { activity, request } = await pending(f.host, f.id, 'question')
  await settledView(f.host, activity)
  expect(f.host.readActivity(f.id, activity.activity_id).pending_requests).toEqual([])
  expect(f.host.readSession(f.id).events.some(event => event.type === 'interaction_closed'
    && event.request_id === request.request_id && event.reason === 'timeout')).toBe(true)
  expect(() => f.host.reply(answer(activity, request.request_id))).toThrow()
  expect(f.requests).toHaveLength(4)
  expect((await journal(f.context(), f.id)).filter(event => event.type === 'tool/result').at(-1)?.data.message.isError).toBe(true)
}, 30000)

it('drains close at native followup admission before another provider request can begin', async () => {
  const root = rootCapture()
  const f = await fixture((_request, response) => { stream(response, [{ content: 'Initial submitted interval complete.' }]) }, { configure: root.configure })
  const id = await f.host.createSession()
  await run(f.host, turn(id, 'Finish before the native followup.', 'close-admission-original'))
  if (root.holder.agent === undefined) throw new Error('missing root')
  root.holder.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native work admitted just before shutdown.' }], source: { kind: 'user' } }))
  await f.host.close()
  expect(f.requests).toHaveLength(1)
  const replacement = await f.open()
  await replacement.resumeSession(id)
  const events = await journal(f.context(), id)
  expect(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
  expect(replacement.readSession(id).busy).toBe(false)
  expect(replacement.readSession(id).activity?.pending_requests ?? []).toEqual([])
  expect(f.requests).toHaveLength(1)
}, 30000)

it('keeps queued native controls from cancelling the verification that currently owns maintenance', async () => {
  const root = rootCapture()
  let reviewResponse: ServerResponse | undefined
  const reviewing = Promise.withResolvers<undefined>()
  const f = await fixture((_request, response, index) => {
    if (index === 0) stream(response, [{ content: 'Initial evidence recorded.' }])
    else if (index === 1) { reviewResponse = response; reviewing.resolve(undefined) }
    else if (index === 2) tool(response, 'ask_user_question', { questions }, 'after-maintenance-question')
    else stream(response, [{ content: 'The queued native continuation received its answer.' }])
  }, { configure: root.configure })
  const id = await f.host.createSession()
  await run(f.host, turn(id, 'Record evidence for review.', 'before-native-maintenance'))
  const review = f.host.verify(id).then(value => ({ value }), (error: unknown) => ({ error }))
  await reviewing.promise
  if (root.holder.agent === undefined || reviewResponse === undefined) throw new Error('missing native maintenance owner')
  expect(f.requests[1]!.tools).toBeUndefined()
  root.holder.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native followup while verification owns maintenance.' }], source: { kind: 'user' } }))
  expect(root.holder.agent.status).toBe('idle')
  expect(root.holder.agent.inbox.nextTurn).toHaveLength(1)
  const queued = await current(f.host, id)
  expect(queued.turn_id).toBeUndefined()
  expect(f.host.readSession(id).busy).toBe(true)
  await expect(f.host.submit(turn(id, 'Must not enter maintenance.', 'must-not-enter-maintenance'))).rejects.toMatchObject({ code: 'SESSION_BUSY' })
  await expect(f.host.cancel(id, queued.activity_id)).rejects.toMatchObject({ code: 'SESSION_BUSY' })
  expect(reviewResponse.destroyed).toBe(false)
  expect(f.requests).toHaveLength(2)
  stream(reviewResponse, [{ content: JSON.stringify({ status: 'passed', summary: 'The recorded evidence was reviewed.', findings: [] }) }])
  expect(await review).toMatchObject({ value: { status: 'unknown', findings: [],
    summary: 'The session changed during verification; this is not a current completion verdict.' } })
  const { activity, request } = await pending(f.host, id, 'question')
  expect(activity.activity_id).toBe(queued.activity_id)
  f.host.reply(answer(activity, request.request_id))
  await settledView(f.host, activity)
  expect(f.requests).toHaveLength(4)
  expect((await journal(f.context(), id)).filter(event => event.type === 'turn/end')).toHaveLength(2)
}, 30000)
