/** Native V4 system-head validation with a private view for frozen non-system relationships. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError } from "../format/index.ts"
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from "../format/index.ts"
import { assertHeader, restoreEnvelope } from './envelopes.ts'
import { assertV4Event, isRepairIdentity, record, SURFACE_TYPES } from './payload.ts'

/**
 * Validate native v4 logical metadata.
 * @param header - decoded v4 Session header.
 */
export function assertReleasedV4Header(header: SessionFormatHeader): void {
  if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  assertHeader(header)
}

/**
 * Validate system ownership, protected-head operations, ordinary relationships, and inherited cut.
 * The private relationship view never escapes; the returned artifact and its messages are unchanged.
 * @param artifact - detached v4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV4Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  let step: { turn: unknown; step: unknown } | undefined
  let head: number | undefined
  let hasSurface = false
  const events = artifact.events.map((event): SessionFormatEvent => {
    assertV4EventAdmission(event)
    assertV4Event(event, knownEventTypes)
    const system = event.type === 'system/message'
    if (event.type === 'step/start') {
      const data = record(event.data, event.type)
      step = { turn: data['turn'], step: data['step'] }
    } else if (event.type === 'step/end' || event.type === 'turn/end') step = undefined
    if (system) {
      const data = record(event.data, 'system/message')
      if (step === undefined || step.turn !== data['turn'] || step.step !== data['step']) {
        throw new SessionFormatError('system/message does not match an open step')
      }
      const operation = event['surfaceOp']
      if (hasSurface && head === undefined) throw new SessionFormatError('system/message requires a protected first surface head')
      if (operation === 'append') {
        if (!hasSurface) head = event.seq
      } else {
        const replace = record(operation, 'system replacement')
        if (replace['startSeq'] === head || replace['endSeq'] === head) {
          if (replace['startSeq'] !== head || replace['endSeq'] !== head) {
            throw new SessionFormatError('system/message must replace exactly the current system head')
          }
          head = event.seq
        }
      }
    } else if (SURFACE_TYPES.has(event.type) && event['surfaceOp'] !== 'append') {
      const replace = record(event['surfaceOp'], 'surface replacement')
      if (replace['startSeq'] === head || replace['endSeq'] === head) throw new SessionFormatError('surface replacement cannot shadow the protected system head')
    }
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      const data = record(event.data, event.type)
      const seqs = data['shadowedSeqs']
      if (Array.isArray(seqs) && seqs.some(seq => seq === head)) {
        throw new SessionFormatError('compaction cannot shadow the protected system head')
      }
    }
    if (SURFACE_TYPES.has(event.type)) hasSurface = true
    const projected = relationshipEvent(event)
    if (!SURFACE_TYPES.has(event.type) || event['surfaceOp'] === 'append') return projected
    const replacement = event['surfaceOp'] as { readonly startSeq: number; readonly endSeq: number }
    // Only the frozen relationship view uses released endpoint names.
    return { ...projected, surfaceOp: { op: 'replace', start: replacement.startSeq, end: replacement.endSeq } }
  })
  restoreEnvelope({ ...artifact, events }, knownEventTypes)
  return artifact
}

/**
 * Refuse required predecessor PTC tags without interpreting native extension payloads.
 * @param event - event envelope whose type and ignorable admission markers are available.
 */
export function assertV4EventAdmission(event: SessionFormatEvent): void {
  if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
    && event['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(
      'format v4 contains unknown event type ' + JSON.stringify(event.type) + ' at seq ' + String(event.seq),
    )
  }
}

function relationshipEvent(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'tool/ptc-dispatch-start':
      return { ...event, type: 'tool/code-dispatch-start' }
    case 'tool/ptc-dispatch':
      return { ...event, type: 'tool/code-dispatch' }
    case 'tool/code-dispatch-start':
    case 'tool/code-dispatch':
      assertV4EventAdmission(event)
      // Obsolete ignorable events do not participate in released PTC lifecycle validation.
      return { ...event, type: 'v4/opaque-released-event' }
  }
  if (event.type === 'system/message') {
    const message = record(record(event.data, 'system data')['message'], 'system message')
    // The frozen validator needs a surface-eligible event, not a model-visible substitute.
    return { ...event, type: 'user/message', data: { ...message, role: 'user' } }
  }
  if (event.type !== 'tool/result') return event
  const data = record(event.data, 'tool result')
  if (data['error'] === undefined) return event
  const error = record(data['error'], 'tool error')
  if (error['code'] !== 'TOOL_NOT_STARTED') return event
  const message = record(data['message'], 'tool message')
  const source = record(message['source'], 'tool source')
  const callId = source['callId']
  const id = message['id']
  if (!isRepairIdentity(id, callId)) return event
  const prefix = 'interrupted-tool-result-' + callId + '-'
  // Message identity survives promotion; only this private frozen repair check uses target seq.
  return { ...event, data: { ...data, message: { ...message, id: `${prefix}${event.seq}` } } }
}
