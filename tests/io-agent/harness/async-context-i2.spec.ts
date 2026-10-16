/** Cross-feature contracts: background work, compaction and late human input share one owner. */
import { describe, expect, it, vi } from 'vitest'
import { fixture, stream, tools, type Request } from './fixture.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'

const isSummaryRequest = (request: Request): boolean => JSON.stringify(request.messages.at(-1)?.content).includes('compaction engine')

const questions = [{ id: 'format', question: 'Which report format?', options: [{ label: 'markdown' }, { label: 'pdf' }] }]
const answer = { answers: [{ id: 'format', selected: ['markdown'] }] }

describe('asynchronous context continuity', () => {
  it('preserves late clarification through compaction while an owned workflow is still running', async () => {
    const child = Promise.withResolvers<void>()
    const summaryStarted = Promise.withResolvers<void>()
    const finishSummary = Promise.withResolvers<void>()
    let ctx!: Context
    let mainCalls = 0
    let summaryCalls = 0
    const f = await fixture(async (request, response) => {
      if (request.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('I2_INDEPENDENT_AUDIT_CHILD'))) {
        await child.promise
        stream(response, [{ content: 'INDEPENDENT_EVIDENCE_FINAL_42' }]); return
      }
      if (isSummaryRequest(request)) {
        summaryCalls++
        summaryStarted.resolve()
        await finishSummary.promise
        stream(response, [{ content: '## Primary Request and Intent\nPrepare the requested report. A formatting clarification and a background audit remain outstanding. Their current state must be checked rather than guessed.' }]); return
      }
      if (mainCalls++ === 0) {
        tools(response, [
          ['ask_user_question', { mode: 'continue', questions }, 'ask-format'],
          ['workflow', { meta: { name: 'audit', description: 'Independent report audit' },
            script: 'return await agent("I2_INDEPENDENT_AUDIT_CHILD")', run_in_background: true }, 'audit'],
        ])
      } else if (mainCalls === 2) {
        stream(response, [{ content: 'Collected evidence. ' + 'Intermediate working details, retained in the original journal. '.repeat(200) }])
      } else stream(response, [{ content: 'Used the available evidence without inventing the pending outcome.' }])
    }, { configure(context) { ctx = context } })
    const session = await f.app.createSession()
    try {
      await session.run('Prepare the report; ask about formatting and independently audit it.')
      const [question] = session.pendingQuestions()
      expect(question?.status).toBe('pending')
      const owner = ctx.agents.get(SessionId(session.id))!
      const job = ctx.jobs.list(owner).find(j => j.kind === 'workflow')!
      expect(job.status).toBe('running')
      await session.run('Retain the audit and formatting request; prepare the report outline meanwhile.')
      const compacting = session.compact()
      await summaryStarted.promise
      // This answer is new evidence, not part of the historical prefix being summarized.
      await session.answerQuestion(question!.id, answer)
      finishSummary.resolve()
      expect(await compacting).not.toBeNull()
      await session.whenIdle()
      expect(session.pendingQuestions()).toEqual([])
      expect(summaryCalls).toBe(1)
      const main = f.requests.filter(r => !isSummaryRequest(r)
        && !r.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('I2_INDEPENDENT_AUDIT_CHILD')))
      expect(JSON.stringify(main.at(-1)?.messages)).toContain('markdown')
      // Releasing the workflow must neither replay the question nor lose its completed result.
      child.resolve()
      await vi.waitFor(() => expect(ctx.jobs.get(job.id, owner).status).toBe('completed'))
      await session.whenIdle()
      expect(ctx.jobs.read(job.id, owner).text).toContain('INDEPENDENT_EVIDENCE_FINAL_42')
      const events = await session.events()
      expect(events.filter(e => e.type === 'question/state' && e.data.status === 'answered')).toHaveLength(1)
      expect(events.filter(e => e.type === 'tool-workflow/run-end')).toHaveLength(1)
      expect(events.filter(e => e.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted)
        .filter(m => String(m.id) === `question-answer-${question!.id}`)).toHaveLength(1)
      const calls = mainCalls
      await session.answerQuestion(question!.id, answer)
      await session.whenIdle()
      expect(mainCalls).toBe(calls)
    } finally {
      finishSummary.resolve(); child.resolve()
    }
  }, 30000)
})
