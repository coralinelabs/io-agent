/** Bounded host controls exercised through the native tool and callback paths. */
import { expect, it } from 'vitest'
import { HostError } from "../../../src/library/host/index.ts"
import type { QuestionRequest } from "../../../src/library/host/index.ts"
import type { IoAgentOptions } from "../../../src/index.ts"
import { stream, tool } from './fixture.ts'
import { hostFixture, turn } from './host-fixture.ts'

type Configure = NonNullable<IoAgentOptions['configure']>
async function fixture(configure: Configure, maxReplayBytes = 16777216) {
  const f = await hostFixture((_request, response, index) => {
    if (index === 0) tool(response, 'read', { file_path: 'missing.txt' }, 'native-read')
    else stream(response, [{ content: 'The host controls settled.' }])
  }, { configure }, { maxReplayBytes })
  const id = await f.host.createSession()
  const receipt = await f.host.submit(turn(id, 'Read the file and handle the human interaction.', 'adverse-turn-001'))
  return { ...f, id, receipt }
}
function pendingRequests(f: Awaited<ReturnType<typeof fixture>>) {
  return f.host.readActivity(f.id, f.receipt.activity_id!).pending_requests
}

it('bounds aggregate open questions and releases their capacity after accepting a response', async () => {
  const rejected: unknown[] = []
  let thirdStarted = false
  const questions = [{ id: 'selection', question: 'Choose one.', detail: 'x'.repeat(520), options: [{ label: 'one' }] }]
  const f = await fixture((context) => {
    context.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'read') return next()
      const ask = () => context.userQuestions.ask({ questions,
        ...(exec.agent === undefined ? {} : { agent: exec.agent }), signal: exec.signal })
      const first = ask()
      await ask().catch((error: unknown) => { rejected.push(error) })
      await first
      thirdStarted = true
      await ask()
      return next()
    })
  }, 1000)
  await expect.poll(() => rejected.length).toBe(1)
  expect(rejected[0]).toMatchObject({ code: 'CAPACITY' })
  const initial = pendingRequests(f)
  expect(initial).toHaveLength(1)
  const question = initial[0]
  if (question === undefined) throw new Error('missing first request')
  const answer = { session_id: f.id, request_id: question.request_id, kind: 'question',
    answer: { answers: [{ id: 'selection', selected: ['one'] }] } }
  f.host.reply(answer)
  await expect.poll(() => thirdStarted && pendingRequests(f).length === 1).toBe(true)
  const third = pendingRequests(f)[0]
  if (third === undefined) throw new Error('missing replacement request')
  expect(third.request_id).not.toBe(question.request_id)
  expect(f.host.reply(answer)).toEqual({ accepted: true })
  expect(() => f.host.reply({ ...answer, answer: { answers: [{ id: 'selection', selected: [], custom: 'different' }] } })).toThrow(HostError)
  f.host.reply({ ...answer, request_id: third.request_id })
  expect((await f.host.settled(f.id, f.receipt.activity_id!)).end).toBe('done')
  expect(pendingRequests(f)).toEqual([])
  expect(f.requests).toHaveLength(2)
}, 30000)

const unanswerable: { name: string; questions: QuestionRequest['questions'] }[] = [
  { name: 'too many questions', questions: Array.from({ length: 129 }, (_, index) => ({ id: String(index), question: 'Choose.' })) },
  { name: 'duplicate question identity', questions: [{ id: 'same', question: 'First?' }, { id: 'same', question: 'Second?' }] },
  { name: 'empty question identity', questions: [{ id: '', question: 'Choose.' }] },
  { name: 'oversized question identity', questions: [{ id: 'x'.repeat(1025), question: 'Choose.' }] },
  { name: 'cumulative oversized identities', questions: Array.from({ length: 128 }, (_, index) => ({ id: String(index).padStart(1024, 'x'), question: 'Choose.' })) },
  { name: 'multibyte oversized identities', questions: Array.from({ length: 48 }, (_, index) => ({ id: String(index).padStart(1024, '界'), question: 'Choose.' })) },
  { name: 'oversized choice label', questions: [{ id: 'q', question: 'Choose.', options: [{ label: 'x'.repeat(32769) }] }] },
  { name: 'ambiguous choice label', questions: [{ id: 'q', question: 'Choose.', options: [{ label: 'same' }, { label: 'same' }] }] },
  { name: 'too many choices', questions: [{ id: 'q', question: 'Choose.', options: Array.from({ length: 129 }, (_, index) => ({ label: String(index) })) }] },
]
it.each(unanswerable)('fails $name before advertising a control that cannot receive an answer', async ({ questions }) => {
  let rejected: unknown
  const f = await fixture((context) => {
    context.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'read') return next()
      await context.userQuestions.ask({ questions, ...(exec.agent === undefined ? {} : { agent: exec.agent }), signal: exec.signal })
        .catch((error: unknown) => { rejected = error })
      return next()
    })
  })
  await f.host.settled(f.id, f.receipt.activity_id!)
  expect(rejected).toMatchObject({ code: 'INVALID_REQUEST' })
  expect(pendingRequests(f)).toEqual([])
  expect(f.host.readSession(f.id, f.receipt.after).events.filter(event => event.type === 'interaction')).toEqual([])
  expect(f.requests).toHaveLength(2)
}, 30000)
