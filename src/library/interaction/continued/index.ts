/** Continued questions project the authoritative journal; replies enter its existing durable inbox. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { Context, Service } from '../../runtime/vendor/cordis/index.ts'
import type { Agent } from '../../runtime/agents/index.ts'
import { freezeMessage, MessageId } from '../../model/llm/index.ts'
import type { Session } from '../../session/journal/index.ts'
import type { ProjectionDefinition } from '../../session/projection/index.ts'
import { modelText } from '../../context/text/index.ts'
import { continuedQuestionSchema, questionsSchema, normalizeAnswer } from './types.ts'
import type { ContinuedQuestion } from './types.ts'
export type { ContinuedQuestion } from './types.ts'

interface State { sessionId: string; records: ContinuedQuestion[]; admitted: string[] }
declare module '../../session/projection/types.ts' { interface SessionProjectionStateMap { continuedQuestions: State } }
declare module '../../runtime/vendor/cordis/index.ts' { interface Context { continuedQuestions: ContinuedQuestions } }
const messageId = (id: string) => MessageId(`question-answer-${id}`)
const stateSchema = z.object({ sessionId: z.string(), records: z.array(continuedQuestionSchema), admitted: z.array(z.string()) }).strict()
const definition: ProjectionDefinition<'continuedQuestions'> = {
  key: 'continuedQuestions', stateVersion: 1, stateSchema,
  init: header => ({ sessionId: String(header.id), records: [], admitted: [] }),
  apply(state, event) {
    if (event.type === 'question/state') {
      const q = continuedQuestionSchema.parse(event.data)
      // A fork may inherit evidence, but not its parent's human controls.
      if (q.sessionId !== state.sessionId) return state
      const index = state.records.findIndex(r => r.id === q.id), old = state.records[index]
      if ((!old && q.status !== 'pending') || (old && (!isDeepStrictEqual(old.questions, q.questions)
        || old.status !== 'pending' || q.status === 'pending'))) throw new Error('invalid continued-question transition')
      if (q.answer !== undefined) normalizeAnswer(q.answer, q.questions)
      return { ...state, records: old ? state.records.with(index, q) : [...state.records, q] }
    }
    if (event.type === 'agent/inbox/spliced') {
      const added = event.data.inserted.map(m => String(m.id)).filter(id =>
        id.startsWith('question-answer-') && !state.admitted.includes(id))
      return added.length ? { ...state, admitted: [...state.admitted, ...added] } : state
    }
    return state
  },
}

export default class ContinuedQuestions extends Service {
  static inject = ['agents', 'sessionProjections']
  constructor(ctx: Context) {
    super(ctx, 'continuedQuestions')
    ctx.sessionProjections.register(definition)
    // Reopening never reasks or replays a tool. Only repair an answered record whose
    // inbox admission was not persisted before the interruption.
    ctx.on('agent/created', ({ agent }) => { if (ctx.agents.roots().includes(agent)) this.reconcile(agent) })
  }
  private state(session: Session): State {
    const state = this.ctx.sessionProjections.stateOf(session, 'continuedQuestions')
    if (state === undefined) throw new Error('continued question projection unavailable')
    return state
  }
  private live(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) {
      throw new Error(modelText('questions/root-only'))
    }
  }
  /** Detached unresolved records, reconstructed after reopening, independent of active turn. */
  pending(agent: Agent): ContinuedQuestion[] {
    this.live(agent)
    return structuredClone(this.state(agent.session).records.filter(r => r.status === 'pending'))
  }
  /** Caller keeps working; only creating the record is bound to this tool call's lifetime. */
  defer(agent: Agent, questions: unknown, signal?: AbortSignal): ContinuedQuestion {
    signal?.throwIfAborted(); this.live(agent)
    const parsed = questionsSchema.parse(questions)
    if (Buffer.byteLength(JSON.stringify(parsed)) > 131072) throw new Error(modelText('questions/too-large'))
    if (this.pending(agent).length >= 32) throw new Error(modelText('questions/too-many'))
    const question: ContinuedQuestion = { id: randomUUID(), sessionId: String(agent.id), questions: parsed, status: 'pending' }
    agent.session.append('question/state', question)
    return structuredClone(question)
  }
  /** First answer wins; equivalent retries repair admission but never create a second input. */
  answer(agent: Agent, id: string, input: unknown): ContinuedQuestion {
    this.live(agent)
    const old = this.state(agent.session).records.find(r => r.id === id)
    if (!old || old.status === 'dismissed') throw new Error(modelText('questions/closed'))
    const answer = normalizeAnswer(input, old.questions)
    if (old.status === 'answered') {
      if (!isDeepStrictEqual(answer, old.answer)) throw new Error(modelText('questions/conflict'))
      this.deliver(agent, old); return structuredClone(old)
    }
    const next: ContinuedQuestion = { ...old, status: 'answered', answer }
    agent.session.append('question/state', next)
    this.deliver(agent, next)
    return structuredClone(next)
  }
  /** Dismissing a clarification never authorizes a protected action and never cancels other work. */
  dismiss(agent: Agent, id: string): void {
    this.live(agent)
    const old = this.state(agent.session).records.find(r => r.id === id)
    if (!old) throw new Error(modelText('questions/closed'))
    if (old.status === 'dismissed') return
    if (old.status !== 'pending') throw new Error(modelText('questions/conflict'))
    agent.session.append('question/state', { ...old, status: 'dismissed' })
  }
  private deliver(agent: Agent, q: ContinuedQuestion): void {
    const id = messageId(q.id)
    if (this.state(agent.session).admitted.includes(id)) return
    // Enqueue synchronously after the answer record: native write order is the
    // recovery contract, not a promise that inference can run exactly once.
    agent.steer(freezeMessage({ id, role: 'user', source: { kind: 'plugin', plugin: 'continued-question', form: 'notice',
      summary: modelText('questions/answer-summary') }, content: [{ type: 'text',
      text: modelText('questions/answer-context', { request_id: q.id, questions: JSON.stringify(q.questions), answer: JSON.stringify(q.answer) }) }] }))
  }
  private reconcile(agent: Agent): void {
    for (const q of this.state(agent.session).records) if (q.status === 'answered') this.deliver(agent, q)
  }
}
