/** Recovery across the answer-record / inbox-admission boundary on the real runtime. */
import { describe, expect, it, vi } from 'vitest'
import { createIoAgent, type IoAgentOptions } from '../../../src/index.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'
import { routerFixture, onFixtureCleanup, stream, tool } from './fixture.ts'

const questions = [{ id: 'format', question: 'Which format?', options: [{ label: 'markdown' }] }]
const answer = { answers: [{ id: 'format', selected: ['markdown'] }] }

async function setup() {
  let ctx!: Context
  const f = await routerFixture((_q, r, index) => {
    if (index === 0) tool(r, 'ask_user_question', { mode: 'continue', questions })
    else stream(r, [{ content: index === 1 ? 'Independent work finished.' : 'Answer received once.' }])
  })
  const options: IoAgentOptions = { workspace: f.workspace, stateDirectory: f.stateDirectory,
    sandbox: 'danger-full-access', approval: 'never',
    model: { api: 'chat-completions', baseURL: f.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 },
    configure(context) { ctx = context },
  }
  const app = await createIoAgent(options); onFixtureCleanup(() => app.close())
  const session = await app.createSession()
  await session.run('Ask for format and continue independent work.')
  const [question] = session.pendingQuestions()
  const owner = ctx.agents.get(SessionId(session.id))!
  return { ...f, app, options, session, owner, question: question! }
}

describe('continued question interrupted admission', () => {
  it('a rejected admission stays recoverable by the identical answer, without appending another answer record', async () => {
    const f = await setup()
    const stop = vi.spyOn(f.owner, 'steer').mockImplementationOnce(() => { throw new Error('ADMISSION_INTERRUPTED') })
    await expect(f.session.answerQuestion(f.question.id, answer)).rejects.toThrow('ADMISSION_INTERRUPTED')
    expect(f.requests).toHaveLength(2)
    stop.mockRestore()
    await f.session.answerQuestion(f.question.id, answer)
    await f.session.whenIdle()
    expect(f.requests).toHaveLength(3)
    await f.session.answerQuestion(f.question.id, answer)
    await f.session.whenIdle()
    expect(f.requests).toHaveLength(3)
    const events = await f.session.events()
    expect(events.filter(e => e.type === 'question/state' && e.data.status === 'answered')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted)
      .filter(m => String(m.id) === `question-answer-${f.question.id}`)).toHaveLength(1)
  }, 30000)

  it('reopening repairs a durable answer whose inbox insertion never occurred, then does not redeliver it', async () => {
    const f = await setup()
    const stop = vi.spyOn(f.owner, 'steer').mockImplementationOnce(() => { throw new Error('ADMISSION_INTERRUPTED') })
    await expect(f.session.answerQuestion(f.question.id, answer)).rejects.toThrow('ADMISSION_INTERRUPTED')
    stop.mockRestore()
    await f.session.flush()
    await f.app.close()
    const second = await createIoAgent(f.options); onFixtureCleanup(() => second.close())
    const reopened = await second.resumeSession(f.session.id)
    await reopened.whenIdle()
    expect(f.requests).toHaveLength(3)
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('markdown')
    expect(reopened.pendingQuestions()).toEqual([])
    await second.close()
    const third = await createIoAgent(f.options); onFixtureCleanup(() => third.close())
    const final = await third.resumeSession(f.session.id)
    await final.whenIdle()
    await final.answerQuestion(f.question.id, answer)
    await final.whenIdle()
    expect(f.requests).toHaveLength(3)
  }, 30000)
})
