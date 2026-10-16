/**
 * Installed native format catalog. Direct imports keep validation independent of mounted plugins.
 */

import { KNOWN_SESSION_EVENT_TYPES } from "../journal/index.ts"
import { createSessionFormatCatalog } from "../format/index.ts"
import { validateInstalledCurrentSessionArtifact, validateInstalledCurrentSessionHeader } from './current.ts'
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from "../format-v4/index.ts"

/** Physical codec dispatch and complete adjacent chain, independent of mounted plugins. */
export const sessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 4,
  oldestVersion: 4,
  codecs: [releasedV4SessionFormatCodec],
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: [],
  restoreCurrent(artifact) {
    const restored = restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
    validateInstalledCurrentSessionArtifact(restored)
    return restored
  },
  restoreTransformedCurrent(artifact) {
    return restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
  },
  restoreCurrentHeader(header) {
    assertReleasedV4Header(header)
    validateInstalledCurrentSessionHeader(header)
    return header
  },
})
