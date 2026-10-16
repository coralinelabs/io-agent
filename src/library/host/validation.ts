/** Strict host-wire parsing and canonical request digests. */
import { createHash } from 'node:crypto'
import type { HostErrorCode, HostPromptBlock, InteractionReply, QuestionAnswer, QuestionRequest, SteerSubmission, TurnSubmission } from './types.ts'
import { snapshotJsonValue } from '../util/values/index.ts'
import type { JsonValue } from '../util/values/index.ts'

/** Named host failures; consumers must not infer success from a transport acknowledgement. */
export class HostError extends Error {
  /** Retained replay bounds allow rediscovery after an explicitly reported gap. */
  readonly details: Readonly<{ first_seq: number; last_seq: number }> | undefined
  constructor(readonly code: HostErrorCode, message: string,
    options?: ErrorOptions & { details?: { first_seq: number; last_seq: number } }) {
    super(message, options)
    this.name = 'HostError'
    this.details = options?.details === undefined ? undefined : Object.freeze({ ...options.details })
  }
}

const TEXT_MAX_BYTES = 131072
const METADATA_MAX_BYTES = 262144
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Validate an exact JSON object.
 * @param value Wire value.
 * @param required Required keys.
 * @param optional Allowed optional keys.
 * @returns Narrowed fields.
 */
export function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostError('INVALID_REQUEST', 'expected a JSON object')
  const row = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new HostError('INVALID_REQUEST', 'unexpected or missing request fields')
  }
  return row
}

/**
 * Validate an opaque identity.
 * @param value Wire identity.
 * @param field Diagnostic field.
 * @param minimum Minimum characters.
 * @returns Validated identifier.
 */
export function identifier(value: unknown, field: string, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HostError('INVALID_REQUEST', `${field} must be ${String(minimum)}-128 URL-safe characters`)
  }
  return value
}

/** A bounded journal key, never used as a filesystem path; permits namespaced client IDs. */
export function turnKey(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > maximum || !/^[A-Za-z0-9_:-]+$/.test(value)) {
    throw new HostError('INVALID_REQUEST', `${field} must be 8-${String(maximum)} letters, digits, underscores, colons or hyphens`)
  }
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > TEXT_MAX_BYTES) {
    throw new HostError('INVALID_REQUEST', `${field} must be nonblank text within ${String(TEXT_MAX_BYTES)} UTF-8 bytes`)
  }
  return value
}

/**
 * Parse prompt text or content blocks. Image bytes are validated when the attachment store admits them.
 * @param value Wire prompt.
 * @returns Canonical prompt.
 */
export function prompt(value: unknown): string | HostPromptBlock[] {
  if (typeof value === 'string') return text(value, 'prompt')
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new HostError('INVALID_REQUEST', 'prompt must be text or 1-64 content blocks')
  let bytes = 0
  let meaningful = false
  const blocks = value.map((item): HostPromptBlock => {
    const kind = (item as { type?: unknown } | null)?.type
    if (kind === 'text') {
      const row = record(item, ['type', 'text'])
      if (typeof row.text !== 'string') throw new HostError('INVALID_REQUEST', 'text blocks carry a string')
      bytes += Buffer.byteLength(row.text)
      if (row.text.trim() !== '') meaningful = true
      return { type: 'text', text: row.text }
    }
    if (kind === 'image') {
      const row = record(item, ['type', 'media_type', 'data'], ['name'])
      if (typeof row.media_type !== 'string' || !IMAGE_TYPES.has(row.media_type) || typeof row.data !== 'string' || row.data === ''
        || (Object.hasOwn(row, 'name') && (typeof row.name !== 'string' || row.name === '' || row.name.length > 255))) {
        throw new HostError('INVALID_REQUEST', 'image blocks carry a supported media_type, base64 data and an optional name')
      }
      meaningful = true
      return { type: 'image', media_type: row.media_type as Extract<HostPromptBlock, { type: 'image' }>['media_type'], data: row.data,
        ...(row.name === undefined ? {} : { name: row.name as string }) }
    }
    throw new HostError('INVALID_REQUEST', 'content blocks are text or image')
  })
  if (!meaningful || bytes > TEXT_MAX_BYTES) throw new HostError('INVALID_REQUEST', `prompt needs nonblank text or an image, with at most ${String(TEXT_MAX_BYTES)} text bytes`)
  return blocks
}

/**
 * The bounded context and detached JSON annotation shared by turns and steering.
 * @param row Parsed wire object.
 * @returns Validated optional fields.
 */
function annotation(row: Record<string, unknown>): { metadata?: JsonValue; context?: string } {
  let metadata: JsonValue | undefined
  if (Object.hasOwn(row, 'metadata')) {
    try { metadata = snapshotJsonValue(row.metadata) as JsonValue | undefined } catch { throw new HostError('INVALID_REQUEST', 'metadata must be lossless JSON') }
    if (metadata === undefined || Buffer.byteLength(JSON.stringify(metadata)) > METADATA_MAX_BYTES) throw new HostError('INVALID_REQUEST', `metadata must be lossless JSON within ${String(METADATA_MAX_BYTES)} bytes`)
  }
  return { ...(row.context === undefined ? {} : { context: text(row.context, 'context') }), ...(metadata === undefined ? {} : { metadata }) }
}

/** Parse a new user turn with bounded context and a detached opaque annotation. */
export function submission(value: unknown): TurnSubmission {
  const row = record(value, ['session_id', 'turn_id', 'prompt'], ['context', 'metadata'])
  return { session_id: identifier(row.session_id, 'session_id'), turn_id: turnKey(row.turn_id, 'turn_id'), prompt: prompt(row.prompt), ...annotation(row) }
}

/**
 * Parse steering for a running session.
 * @param value Wire request.
 * @returns Canonical steering.
 */
export function steering(value: unknown): SteerSubmission {
  const row = record(value, ['session_id', 'prompt'], ['steer_id', 'turn_id', 'context', 'metadata'])
  return { session_id: identifier(row.session_id, 'session_id'), prompt: prompt(row.prompt),
    ...(row.steer_id === undefined ? {} : { steer_id: turnKey(row.steer_id, 'steer_id', 128) }),
    ...(row.turn_id === undefined ? {} : { turn_id: turnKey(row.turn_id, 'turn_id') }), ...annotation(row) }
}

/**
 * Parse a typed interaction response.
 * @param value Wire response.
 * @returns Canonical response with bounded text.
 */
export function reply(value: unknown): InteractionReply {
  const row = record(value, ['session_id', 'request_id', 'kind'], ['activity_id', 'answer', 'decision'])
  const identity = { session_id: identifier(row.session_id, 'session_id'), request_id: identifier(row.request_id, 'request_id'),
    ...(row.activity_id === undefined ? {} : { activity_id: identifier(row.activity_id, 'activity_id') }) }
  if (row.kind === 'approval' && !Object.hasOwn(row, 'answer') && typeof row.decision === 'string' && ['allowed-once', 'rejected', 'cancelled'].includes(row.decision)) {
    return { ...identity, kind: 'approval', decision: row.decision as 'allowed-once' | 'rejected' | 'cancelled' }
  }
  if (row.kind !== 'question' || Object.hasOwn(row, 'decision')) throw new HostError('INVALID_REQUEST', 'expected a typed question answer or approval decision')
  const answer = record(row.answer, ['answers'])
  if (!Array.isArray(answer.answers) || answer.answers.length === 0 || answer.answers.length > 128) throw new HostError('INVALID_ANSWER', 'answers must be a nonempty bounded array')
  const answers = answer.answers.map((value): QuestionAnswer['answers'][number] => {
    const item = record(value, ['id', 'selected'], ['custom'])
    if (typeof item.id !== 'string' || !item.id || item.id.length > 1024 || !Array.isArray(item.selected)
      || item.selected.length > 128 || item.selected.some(label => typeof label !== 'string' || Buffer.byteLength(label) > 32768)
      || (Object.hasOwn(item, 'custom') && (typeof item.custom !== 'string' || Buffer.byteLength(item.custom) > 32768))) {
      throw new HostError('INVALID_ANSWER', 'invalid question answer fields')
    }
    return { id: item.id, selected: item.selected as string[], ...(item.custom === undefined ? {} : { custom: item.custom as string }) }
  })
  if (Buffer.byteLength(JSON.stringify(answers)) > TEXT_MAX_BYTES) throw new HostError('INVALID_ANSWER', `answers exceed ${String(TEXT_MAX_BYTES)} UTF-8 bytes`)
  return { ...identity, kind: 'question', answer: { answers } }
}

/**
 * Check IDs, choices and selection multiplicity against the actual request.
 * @param answer Parsed answer.
 * @param questions Pending request questions.
 */
export function validateAnswers(answer: QuestionAnswer, questions: QuestionRequest['questions']): void {
  if (answer.answers.length !== questions.length || new Set(answer.answers.map(item => item.id)).size !== questions.length) {
    throw new HostError('INVALID_ANSWER', 'answer each question exactly once')
  }
  for (const item of answer.answers) {
    const question = questions.find(candidate => candidate.id === item.id)
    if (question === undefined || new Set(item.selected).size !== item.selected.length
      || item.selected.some(label => !question.options?.some(option => option.label === label))
      || (!question.multiSelect && (item.selected.length > 1 || (item.selected.length > 0 && !!item.custom?.trim())))
      || (item.selected.length === 0 && !item.custom?.trim())) {
      throw new HostError('INVALID_ANSWER', 'answer must use the requested choices or nonblank custom text')
    }
  }
}

/**
 * Refuse questions that the bounded answer wire format cannot represent without loss.
 * @param questions Native questions to expose to the application.
 */
export function validateQuestions(questions: QuestionRequest['questions']): void {
  if (questions.length === 0 || questions.length > 128 || new Set(questions.map(question => question.id)).size !== questions.length) {
    throw new HostError('INVALID_REQUEST', 'question count and identifiers must fit the response format')
  }
  const shortestAnswers: QuestionAnswer['answers'] = []
  for (const question of questions) {
    const options = question.options ?? []
    if (!question.id || question.id.length > 1024 || options.length > 128
      || new Set(options.map(option => option.label)).size !== options.length
      || options.some(option => Buffer.byteLength(option.label) > 32768)) {
      throw new HostError('INVALID_REQUEST', 'question identifiers and choices must be unambiguous and answerable')
    }
    let shortest: QuestionAnswer['answers'][number] = { id: question.id, selected: [], custom: 'x' }
    for (const option of options) {
      const selected = { id: question.id, selected: [option.label] }
      if (Buffer.byteLength(JSON.stringify(selected)) < Buffer.byteLength(JSON.stringify(shortest))) shortest = selected
    }
    shortestAnswers.push(shortest)
  }
  if (Buffer.byteLength(JSON.stringify(shortestAnswers)) > TEXT_MAX_BYTES) {
    throw new HostError('INVALID_REQUEST', 'even minimal answers exceed the bounded response format')
  }
}

/**
 * Hash a canonical parsed request without retaining its content.
 * @param value Canonical JSON value.
 * @returns SHA-256 identity.
 */
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
