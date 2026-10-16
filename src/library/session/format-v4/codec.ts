/** V4 framing with hard structural admission and recoverable canonical event validation. */

import { SessionFormatError, isSessionFormatJsonObject } from "../format/index.ts"
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
} from "../format/index.ts"
import { nativeFraming } from './framing.ts'
import { assertReleasedV4Header, assertV4EventAdmission } from './validation.ts'
import { assertV4Event, assertV4StructuralRow } from './payload.ts'

/** V4 codec validates structural rows before recovery and logical envelopes after source-event range decoding. */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    return { ...nativeFraming.decodeHeader(value), version: 4 }
  },
  createDecoder(value, recovery) {
    const decoder = nativeFraming.createDecoder(value, recovery)
    let issue: SessionFormatError | undefined
    let acceptedInheritedCut: number | undefined
    return {
      header: { ...decoder.header, version: 4 },
      decodeRow(row, context) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent(event) {
            assertV4EventAdmission(event)
            if (issue === undefined) {
              try {
                assertV4Event(event)
              } catch (error: unknown) {
                // The frozen event validator reports every decoded JSON violation as SessionFormatError.
                const invalid = error as SessionFormatError
                if (recovery === 'strict') throw invalid
                issue = invalid
              }
            }
            if (issue !== undefined) {
              if (event.type === 'turn/end') throw issue
              return
            }
            if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
              && event.data['inherited'] === true) acceptedInheritedCut = event.seq
            context.emitEvent(event)
          },
        })
      },
      finish(context) {
        if (issue === undefined) return decoder.finish(context)
        if (decoder.header.isSeeded && acceptedInheritedCut === undefined) {
          throw new SessionFormatError('format v4 seeded Session lacks an accepted inherited end-seed marker')
        }
        if (!decoder.header.isSeeded && acceptedInheritedCut !== undefined) {
          throw new SessionFormatError('format v4 unseeded Session contains an inherited end-seed marker')
        }
        return acceptedInheritedCut ?? 0
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    return {
      ...nativeFraming.encodeHeader(header, inheritedEventCount),
      version: 4,
    }
  },
  encodeEvent(event) {
    assertV4EventAdmission(event)
    assertV4Event(event)
    return nativeFraming.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate owned V4 admission rules before a scanner or codec can discard a recoverable tail.
 * This checks only identified structural payloads; physical source-event ranges still belong to decoding.
 * @param row - parsed physical row, before envelope or compressed-range decoding.
 */
export function assertV4RowAdmission(row: unknown): void {
  assertV4StructuralRow(row)
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) assertV4EventAdmission(row as SessionFormatEvent)
}
