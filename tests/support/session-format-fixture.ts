/** Synthetic adjacent formats for the existing storage migration tests, without retired readers. */
import { createSessionFormatCatalog, SessionFormatUnsupportedMigrationError } from '../../src/library/session/format/index.ts'
import type { SessionFormatArtifact, SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader } from '../../src/library/session/format/index.ts'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '../../src/library/session/format-v4/index.ts'
import { KNOWN_SESSION_EVENT_TYPES } from '../../src/library/session/journal/index.ts'

/** The same native framing at a synthetic version; only the header number changes. */
function codec(version: number): SessionFormatCodec & SessionFormatCurrentEncoder {
  const physical = (value: unknown) => ({ ...(value as object), version: 4 })
  const logical = (value: SessionFormatHeader) => ({ ...value, version })
  return {
    version,
    decodeHeader: value => logical(releasedV4SessionFormatCodec.decodeHeader(physical(value))),
    createDecoder(value, recovery) {
      const decoder = releasedV4SessionFormatCodec.createDecoder(physical(value), recovery)
      return { ...decoder, header: logical(decoder.header) }
    },
    encodeHeader: (header, cut) => ({ ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, cut), version }),
    encodeEvent: event => releasedV4SessionFormatCodec.encodeEvent(event),
  }
}

/** Identity migration with native validation: exercises publication, cancellation and revision races. */
export function syntheticCatalog(currentVersion = 4) {
  const restore = (artifact: SessionFormatArtifact) => {
    restoreReleasedV4Artifact({ ...artifact, header: { ...artifact.header, version: 4 } }, KNOWN_SESSION_EVENT_TYPES)
    return artifact
  }
  const current = codec(currentVersion)
  return createSessionFormatCatalog({
    oldestVersion: 2, currentVersion,
    codecs: Array.from({length: currentVersion - 1}, (_, index) => codec(index + 2)), currentEncoder: current,
    migrations: Array.from({length: currentVersion - 2}, (_, index) => ({
      name: `test-only-adjacent-format-${index}`, fromVersion: index + 2, toVersion: index + 3,
      migrateHeader: header => ({ ...header, version: index + 3 }),
      validateTargetHeader: header => { codec(index + 3).decodeHeader({ type: 'session', ...header }) },
      createStage({ sourceInheritedEventCount }) {
        return {
          transformEvent(event, output) {
            if (event.type.startsWith('external/')) throw new SessionFormatUnsupportedMigrationError(`unknown synthetic event type ${JSON.stringify(event.type)} at seq ${event.seq}`)
            output.emitEvent(event)
          },
          finish: () => sourceInheritedEventCount ?? 0,
        }
      },
    })),
    restoreCurrent: restore, restoreTransformedCurrent: restore,
    restoreCurrentHeader: header => { current.decodeHeader({ type: 'session', ...header }); return header },
  })
}
