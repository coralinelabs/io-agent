/** The default library, real router transport and durable journal: questions outlive turns. */
import { describe, expect, it, vi } from 'vitest'
import { createIoAgent } from '../../../src/index.ts'
import { fixture, routerFixture, stream, tool, onFixtureCleanup } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'

const questions = [{ id: 'format', question: 'Which format?', options: [{ label: 'pdf' }, { label: 'markdown' }] }]
const answer = { answers: [{ id: 'format', selected: ['markdown'] }] }
const reply = (_request: unknown, response: Parameters<typeof stream>[0], i: number) => {
  if (i === 0) tool(response, 'ask_user_question', { mode: 'continue', questions })
  else stream(response, [{ content: i === 1 ? 'Continuing independent work.' : 'Using the answer.' }])
}

describe('continued clarification', () => {
  it('returns pending without a responder, continues the turn, then admits one answer after settlement', async () => {
    const { app, requests } = await fixture(reply)
    const session = await app.createSession()
    const first = await session.run('Prepare facts while asking about format.')
    expect(first.text).toBe('Continuing independent work.')
    expect(requests).toHaveLength(2)
    const [pending] = session.pendingQuestions()
    expect(pending).toMatchObject({ sessionId: session.id, status: 'pending', questions })
    expect(first.events.find(e => e.type === 'question/state')?.data).toEqual(pending)
    expect(first.events.filter(e => e.type === 'tool/result').map(e => e.data.message)).toMatchObject([
      { role: 'tool', isError: false, content: [{ type: 'text', text: JSON.stringify({ request_id: pending!.id, pending: true }) }] },
    ])
    const results = await Promise.all([session.answerQuestion(pending!.id, answer), session.answerQuestion(pending!.id, answer)])
    expect(results[0]).toEqual(results[1])
    await session.whenIdle()
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2]!.messages)).toContain('markdown')
    expect(session.pendingQuestions()).toEqual([])
    await session.answerQuestion(pending!.id, answer)
    await session.whenIdle()
    expect(requests).toHaveLength(3)
    await expect(session.answerQuestion(pending!.id, { answers: [{ id: 'format', selected: ['pdf'] }] })).rejects.toThrow()
    const events = await session.events()
    expect(events.filter(e => e.type === 'question/state')).toHaveLength(2)
    expect(events.filter(e => e.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted)
      .filter(m => String(m.id) === `question-answer-${pending!.id}`)).toHaveLength(1)
  }, 30000)

  it('keeps pending questions through closing and reopening the whole runtime', async () => {
    const f = await routerFixture(reply)
    const options = { workspace: f.workspace, stateDirectory: f.stateDirectory, sandbox: 'danger-full-access' as const,
      approval: 'never' as const, model: { api: 'chat-completions' as const, baseURL: f.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 } }
    const first = await createIoAgent(options); onFixtureCleanup(() => first.close())
    const session = await first.createSession({ id: 'question-restart' })
    await session.run('Ask then continue.')
    const [question] = session.pendingQuestions()
    await first.close()
    const second = await createIoAgent(options); onFixtureCleanup(() => second.close())
    const reopened = await second.resumeSession(session.id)
    expect(reopened.pendingQuestions()).toEqual([question])
    expect(f.requests).toHaveLength(2)
    await reopened.answerQuestion(question!.id, answer)
    await reopened.whenIdle()
    expect(f.requests).toHaveLength(3)
    await second.close()
    const third = await createIoAgent(options); onFixtureCleanup(() => third.close())
    const final = await third.resumeSession(session.id)
    await final.whenIdle()
    expect(final.pendingQuestions()).toEqual([])
    await final.answerQuestion(question!.id, answer)
    await final.whenIdle()
    expect(f.requests).toHaveLength(3)
  }, 30000)

  it('rejects invalid answers, supports dismissal, and cannot answer a foreign session request', async () => {
    const { app, requests } = await fixture(reply)
    const session = await app.createSession(), other = await app.createSession()
    await session.run('Ask and work.')
    const [q] = session.pendingQuestions()
    for (const invalid of [null, { answers: [] }, { answers: [{ id: 'format', selected: ['other'] }] },
      { answers: [{ id: 'format', selected: ['pdf', 'markdown'] }] },
      { answers: [{ id: 'format', selected: ['pdf'], custom: 'instead' }] }]) {
      await expect(session.answerQuestion(q!.id, invalid)).rejects.toThrow()
    }
    await expect(other.answerQuestion(q!.id, answer)).rejects.toThrow()
    expect(session.pendingQuestions()).toHaveLength(1)
    await session.dismissQuestion(q!.id); await session.dismissQuestion(q!.id)
    expect(session.pendingQuestions()).toEqual([])
    await expect(session.answerQuestion(q!.id, answer)).rejects.toThrow()
    expect(requests).toHaveLength(2)
  }, 30000)

  it('does not call the blocking callback when continued mode was explicitly selected', async () => {
    const onQuestion = vi.fn(async () => answer)
    const { app } = await fixture(reply, { onQuestion })
    const s = await app.createSession(); await s.run('Ask but do not wait.')
    expect(onQuestion).not.toHaveBeenCalled(); expect(s.pendingQuestions()).toHaveLength(1)
  }, 30000)

  it('host observation and controls do not require the initiating activity to remain live', async () => {
    const f = await hostFixture(reply)
    const id = await f.host.createSession()
    const { receipt } = await run(f.host, turn(id, 'Ask about format while continuing work.'))
    const [q] = f.host.pendingQuestions(id)
    expect(q).toMatchObject({ sessionId: id, status: 'pending' })
    expect(f.host.readSession(id, receipt.after).events.some(e => e.type === 'question_state')).toBe(true)
    await f.host.answerQuestion(id, q!.id, answer)
    await vi.waitFor(() => expect(f.requests).toHaveLength(3))
    await vi.waitFor(() => expect(f.host.readSession(id).busy).toBe(false))
    expect(f.host.pendingQuestions(id)).toEqual([])
    await f.host.answerQuestion(id, q!.id, answer)
    expect(f.requests).toHaveLength(3)
  }, 30000)
})
