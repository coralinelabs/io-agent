/** Audited V2 migration admission and V4 payload validation, independent of installed core Session types. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount, sessionFormatSafeInteger } from "../format/index.ts"
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from "../format/index.ts"
import { assertSystemContent } from './system-content.ts'
import { assertRecordedContent } from '../../model/llm/content-validation.ts'
import { ENVELOPE_TYPES } from './event-types.ts'

/** Audited surface event names; all other admitted events are log-only. */
export const SURFACE_TYPES: ReadonlySet<string> = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * Require a JSON object at the durable input boundary.
 * @param value - decoded value.
 * @param label - diagnostic subject.
 * @returns the narrowed object.
 */
export function record(value: SessionFormatJsonValue | undefined, label: string): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(label + ' must be an object')
  return value
}

/**
 * Reject missing and unaudited members rather than guessing whether they contain coordinates.
 * @param value - decoded record.
 * @param required - required member names.
 * @param optional - additional admitted names.
 * @param label - diagnostic subject.
 */
export function keys(value: SessionFormatJsonObject, required: readonly string[], optional: readonly string[], label: string): void {
  const missing = required.find(key => !Object.hasOwn(value, key))
  const unexpected = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))
  if (missing !== undefined) throw new SessionFormatError(label + ' lacks required field ' + missing)
  if (unexpected !== undefined) throw new SessionFormatError(label + ' has unexpected field ' + unexpected)
}

/**
 * Recognize stable generated repair IDs without interpreting their historical suffix as a current coordinate.
 * @param id - durable message identity.
 * @param callId - advertised tool identity.
 * @returns whether the identity has the canonical historical repair form.
 */
export function isRepairIdentity(id: SessionFormatJsonValue | undefined, callId: SessionFormatJsonValue | undefined): callId is string {
  if (typeof callId !== 'string') return false
  const prefix = 'interrupted-tool-result-' + callId + '-'
  if (typeof id !== 'string' || !id.startsWith(prefix)) return false
  const suffix = id.slice(prefix.length)
  return /^(0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix))
}

/**
 * Reject V4 structural payload violations even beyond a recoverable physical-row failure.
 * @param value - raw physical row; ordinary rows retain the frozen decoder's recovery policy.
 */
export function assertV4StructuralRow(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const row = value as SessionFormatJsonObject
  if (row['type'] === 'request/header') {
    const data = record(row['data'], 'request/header data')
    if (Object.hasOwn(record(data['header'], 'request header'), 'system')) {
      throw new SessionFormatUnsupportedMigrationError('format v4 request/header rejects retired header.system')
    }
  } else if (row['type'] === 'system/message') {
    const data = record(row['data'], 'system/message data')
    assertSystem(data)
  }
}

function assertSystem(data: SessionFormatJsonObject): void {
  keys(data, ['turn', 'step', 'message'], [], 'system/message data')
  for (const coordinate of ['turn', 'step']) {
    if (sessionFormatCount(data[coordinate], coordinate) === 0) throw new SessionFormatError(coordinate + ' must be positive')
  }
  const message = record(data['message'], 'system message')
  keys(message, ['id', 'role', 'source', 'content'], [], 'system message')
  if (typeof message['id'] !== 'string' || message['id'].length === 0 || message['role'] !== 'system') {
    throw new SessionFormatError('system message requires an id and system role')
  }
  const source = record(message['source'], 'system source')
  if (source['kind'] !== 'plugin' || typeof source['plugin'] !== 'string' || source['plugin'].length === 0) {
    throw new SessionFormatError('system message requires plugin source')
  }
  assertSystemContent(message)
}

/**
 * Validate one canonical V4 event without interpreting plugin-owned payloads or log relationships.
 * Unclassified metadata is deferred to vocabulary-aware restoration; unknown required types must not become recoverable corruption.
 * @param event - decoded logical event.
 * @param knownEventTypes - additional installed event types whose envelopes are interpreted.
 */
export function assertV4Event(event: SessionFormatEvent, knownEventTypes?: ReadonlySet<string>): void {
  const value = record(event, 'format v4 event')
  const subject = `format v4 ${event.type} at seq ${event.seq}`
  const obsolete = event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch'
  const known = !obsolete && (SURFACE_TYPES.has(event.type)
    || ENVELOPE_TYPES.has(event.type)
    || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
    || event.type === 'feedback/message-put' || event.type === 'feedback/message-delete'
    || knownEventTypes?.has(event.type) === true)
  const opaque = !known
  keys(value, ['type', 'seq', 'time', 'data'],
    SURFACE_TYPES.has(event.type) || opaque ? ['ignorable', 'surfaceOp', 'sourceEventSeqs'] : ['ignorable'], subject)
  if (typeof event.type !== 'string') throw new SessionFormatError(`${subject} type must be a string`)
  sessionFormatCount(event.seq, `${subject} seq`)
  sessionFormatSafeInteger(event.time, `${subject} time`)
  if (Object.hasOwn(value, 'ignorable') && value['ignorable'] !== true) {
    throw new SessionFormatError(`${subject} ignorable must be true when present`)
  }
  if (SURFACE_TYPES.has(event.type)) {
    const operation = value['surfaceOp']
    if (operation === undefined) throw new SessionFormatError(`${subject} requires a surfaceOp marker`)
    if (operation !== 'append') {
      const replace = record(operation, `${subject} surfaceOp`)
      if (Object.keys(replace).length !== 3 || replace['op'] !== 'replace'
        || !Object.hasOwn(replace, 'startSeq') || !Object.hasOwn(replace, 'endSeq')) {
        throw new SessionFormatError(`${subject} requires exact replace fields op/startSeq/endSeq`)
      }
      for (const key of ['startSeq', 'endSeq']) {
        if (sessionFormatCount(replace[key], `${subject} surfaceOp ${key}`) >= event.seq) {
          throw new SessionFormatError(`${subject} replacement endpoints must reference earlier events`)
        }
      }
    }
    const sources = value['sourceEventSeqs']
    if (event.type === 'assistant/message' && sources !== undefined) {
      throw new SessionFormatError(`${subject} embeds its stream and cannot carry sourceEventSeqs`)
    }
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length === 0) {
        throw new SessionFormatError(`${subject} sourceEventSeqs must be a non-empty array`)
      }
      const seen = new Set<number>()
      for (const source of sources) {
        const seq = sessionFormatCount(source, `${subject} sourceEventSeqs member`)
        if (seq >= event.seq || seen.has(seq)) throw new SessionFormatError(`${subject} sourceEventSeqs must be unique earlier seqs`)
        seen.add(seq)
      }
    }
  }
  assertV4StructuralRow(event)
  assertCanonicalPayload(event)
  try { assertRecordedContent(event.type, event.data, `${subject} data`) } catch (error) {
    throw new SessionFormatError(error instanceof Error ? error.message : String(error))
  }
}

function assertCanonicalPayload(event: SessionFormatEvent): void {
  const subject = `format v4 ${event.type} at seq ${event.seq}`
  if (event.type === 'request/header') {
    const data = record(event.data, `${subject} data`)
    const header = record(data['header'], `${subject} header`)
    if (Array.isArray(header['tools']) && header['tools'].length === 0
      || isSessionFormatJsonObject(header['adapterDefaults']) && Object.keys(header['adapterDefaults']).length === 0) {
      throw new SessionFormatError(`${subject} empty optional header fields must be omitted`)
    }
  }
  if (event.type !== 'tool/result') return
  const data = record(event.data, `${subject} data`)
  if (data['error'] === undefined) return
  const message = record(data['message'], `${subject} message`)
  if (message['role'] !== 'tool' || message['isError'] !== true) {
    throw new SessionFormatError(`${subject} carries error metadata for a non-error tool result`)
  }
}

