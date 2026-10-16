import { isAbsolute } from 'node:path'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
  sessionFormatSafeInteger,
} from "../format/index.ts"
import type {
  SessionFormatArtifact,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from "../format/index.ts"
import { assertArtifactRelationships } from './relationships.ts'
import { ENVELOPE_TYPES } from './event-types.ts'

const HEADER_REQUIRED = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const SURFACE_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'] as const
const LOG_OPTIONAL = ['ignorable'] as const
const RELATIONSHIP_EXTENSIONS = {
  stepEvents: new Set(['assistant/attempt']),
  preservedSourceTitleRequestText: true,
} as const

/**
 * Validate the exact logical header written by native v4.
 * @param header - decoded native-v4 Session header.
 * @throws {SessionFormatError} when the header is not an exact native-v4 value.
 */
export function assertHeader(header: SessionFormatHeader): void {
  const record = jsonRecord(header, 'format v4 header')
  exactKeys(record, HEADER_REQUIRED, HEADER_OPTIONAL, 'format v4 header')
  if (record['version'] !== 4) throw new SessionFormatError('expected format v4 header')
  if (typeof record['id'] !== 'string') throw new SessionFormatError('format v4 header id must be a string')
  sessionFormatCount(record['createdAt'], 'format v4 header createdAt')
  sessionFormatCount(record['delegationDepth'], 'format v4 header delegationDepth')
  if (typeof record['isSeeded'] !== 'boolean') throw new SessionFormatError('format v4 header isSeeded must be boolean')
  if (record['cwd'] !== undefined && (typeof record['cwd'] !== 'string' || !isAbsolute(record['cwd']))) {
    throw new SessionFormatError('format v4 header cwd must be absolute')
  }
  for (const key of ['parentSession', 'agentPreset'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new SessionFormatError(`format v4 header ${key} must be a string`)
    }
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    throw new SessionFormatError('format v4 header origin must be "subagent"')
  }
}

function validateArtifact(
  artifact: SessionFormatArtifact,
  knownEventTypes?: ReadonlySet<string>,
): void {
  assertHeader(artifact.header)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v4 inherited event count')
  if (cut > artifact.events.length) throw new SessionFormatError('format v4 inherited event count exceeds its events')
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError('unseeded format v4 Session has inherited events')
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    const record = jsonRecord(event, `format v4 event ${index}`)
    const type = record['type']
    if (typeof type !== 'string') throw new SessionFormatError(`format v4 event ${index} type must be a string`)
    const disposition = ENVELOPE_TYPES.has(type) ? true : undefined
    const installed = knownEventTypes?.has(type) === true
    const ignorableUnknown = disposition === undefined && record['ignorable'] === true
    if (disposition === undefined && !installed && !ignorableUnknown) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v4 contains unknown event type ${JSON.stringify(type)} at seq ${index}`,
      )
    }
    const surface = disposition !== undefined && SURFACE_TYPES.has(type)
    const optional = disposition === undefined
      ? SURFACE_OPTIONAL
      : surface ? SURFACE_OPTIONAL : LOG_OPTIONAL
    exactKeys(record, EVENT_REQUIRED, optional, `format v4 event ${index}`)
    if (record['seq'] !== index) throw new SessionFormatError(`format v4 event ${index} is not dense`)
    sessionFormatSafeInteger(record['time'], `format v4 event ${index} time`)
    if (record['ignorable'] !== undefined && record['ignorable'] !== true) {
      throw new SessionFormatError(`format v4 event ${index} ignorable must be true when present`)
    }
    if (type === 'session/end-seed') {
      const data = jsonRecord(event.data, `session/end-seed ${index} data`)
      if (data['inherited'] === true) lastInheritedMarker = index
    }
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError('format v4 seeded header disagrees with its last inherited end-seed marker')
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError('format v4 unseeded Session contains an inherited end-seed marker')
  }
  assertArtifactRelationships(artifact, RELATIONSHIP_EXTENSIONS)
}

/**
 * Require one native-v4 value to be a JSON object.
 * @param value - value to narrow.
 * @param label - diagnostic subject.
 * @returns the narrowed object.
 */
export function jsonRecord(
  value: SessionFormatJsonValue | undefined,
  label: string,
): SessionFormatJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionFormatError(`${label} must be an object`)
  }
  return value as SessionFormatJsonObject
}

/**
 * Require one native-v4 object to contain exactly the admitted keys.
 * @param value - object to inspect.
 * @param required - keys that must be present.
 * @param optional - additional keys that may be present.
 * @param label - diagnostic subject.
 */
export function exactKeys(
  value: SessionFormatJsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.find(key => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new SessionFormatError(`${label} lacks required field ${missing}`)
  const unexpected = Object.keys(value).find(key => !allowed.has(key))
  if (unexpected !== undefined) throw new SessionFormatError(`${label} has unexpected field ${unexpected}`)
}

/**
 * Restore and validate one decoded native-v4 artifact.
 * @param artifact - detached vocabulary-restored artifact.
 * @param knownEventTypes - event types understood by the installed current Session package.
 * @returns the same validated artifact.
 */
export function restoreEnvelope(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  validateArtifact(artifact, knownEventTypes)
  return artifact
}

