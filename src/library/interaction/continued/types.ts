/** Durable session-owned clarification. Never an approval or an activity callback. */
import { z } from 'zod'
import type { AskUserQuestionItem, AskUserQuestionAnswer } from '../user-questions/types.ts'

const option = z.object({ label: z.string().min(1).max(32768), description: z.string().max(32768).optional() }).strict()
export const questionsSchema = z.array(z.object({
  id: z.string().min(1).max(1024), question: z.string().min(1).max(32768),
  header: z.string().max(1024).optional(), detail: z.string().max(32768).optional(),
  options: z.array(option).max(128).optional(), multiSelect: z.boolean().optional(),
}).strict()).min(1).max(32).superRefine((questions, ctx) => {
  if (new Set(questions.map(q => q.id)).size !== questions.length) ctx.addIssue({ code: 'custom', message: 'duplicate question id' })
  for (const q of questions) if (new Set(q.options?.map(o => o.label)).size !== (q.options?.length ?? 0)) {
    ctx.addIssue({ code: 'custom', message: 'duplicate answer option' })
  }
}).transform((qs): AskUserQuestionItem[] => qs.map(q => ({
  id: q.id, question: q.question,
  ...(q.header === undefined ? {} : { header: q.header }), ...(q.detail === undefined ? {} : { detail: q.detail }),
  ...(q.multiSelect === undefined ? {} : { multiSelect: q.multiSelect }),
  ...(q.options === undefined ? {} : { options: q.options.map(o => ({ label: o.label, ...(o.description === undefined ? {} : { description: o.description }) })) }),
})))
export const answerSchema = z.object({ answers: z.array(z.object({
  id: z.string().min(1).max(1024), selected: z.array(z.string().max(32768)).max(128),
  custom: z.string().max(32768).optional(),
}).strict()).min(1).max(32) }).strict()

export interface ContinuedQuestion {
  readonly id: string
  readonly sessionId: string
  readonly questions: AskUserQuestionItem[]
  readonly status: 'pending' | 'answered' | 'dismissed'
  readonly answer?: AskUserQuestionAnswer
}
export const continuedQuestionSchema = z.object({
  id: z.string().uuid(), sessionId: z.string().min(1), questions: questionsSchema,
  status: z.enum(['pending', 'answered', 'dismissed']), answer: answerSchema.optional(),
}).strict().superRefine((q, ctx) => {
  if ((q.status === 'answered') !== (q.answer !== undefined)) ctx.addIssue({ code: 'custom', message: 'answer/status mismatch' })
}).transform((q): ContinuedQuestion => ({ id: q.id, sessionId: q.sessionId, questions: q.questions, status: q.status,
  ...(q.answer === undefined ? {} : { answer: normalizeAnswer(q.answer, q.questions) }),
}))

/** Validate and canonicalize an answer against its exact offered choices. */
export function normalizeAnswer(input: unknown, questions: readonly AskUserQuestionItem[]): AskUserQuestionAnswer {
  const answer = answerSchema.parse(input)
  if (answer.answers.length !== questions.length || new Set(answer.answers.map(a => a.id)).size !== questions.length) {
    throw new TypeError('answer every question exactly once')
  }
  return { answers: questions.map(q => {
    const a = answer.answers.find(a => a.id === q.id)
    if (!a || new Set(a.selected).size !== a.selected.length
      || a.selected.some(label => !q.options?.some(o => o.label === label))
      || (!q.multiSelect && (a.selected.length > 1 || (a.selected.length > 0 && !!a.custom?.trim())))
      || (a.selected.length === 0 && !a.custom?.trim())) throw new TypeError('answer must use the offered choices or nonblank custom text')
    const selected = q.options?.filter(o => a.selected.includes(o.label)).map(o => o.label) ?? []
    return { id: q.id, selected, ...(a.custom?.trim() ? { custom: a.custom.trim() } : {}) }
  }) }
}

declare module '../../session/journal/types.ts' {
  interface SessionEventMap { 'question/state': ContinuedQuestion }
}
