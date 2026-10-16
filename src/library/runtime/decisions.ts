/** Coding-loop decisions; storage and transport interfaces live in the library. */
import type { TurnEndReason } from '../session/journal/index.ts'
import type { AdmittedRequest } from '../model/request.ts'
export type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>
export type PreparedStep = { kind: 'reject' } | ({ kind: 'enter' } & AdmittedRequest)
