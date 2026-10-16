/**
 * Service Definition for the spill storage capability seam (`ctx.spillStore`): an abstract service defining WHAT a
 * spill backend does — persist oversized text and return a model-facing
 * locator plus retrieval guidance — without saying HOW. Implementations
 * subclass {@link SpillStore} and register as the `spillStore` service;
 * `io-agent/spill-local` (host filesystem) is the first.
 *
 * The Service Definition is deliberately minimal: `saveText` and nothing else. It owns NO
 * retention policy (that is `io-agent/output-retention`), NO tool-result
 * replacement (that is `io-agent/spill-policy`), and NO retrieval or
 * search API. The backend supplies the locator and retrieval hint appropriate
 * for its storage substrate.
 *
 * @module io-agent/spill
 */

import { Context, Service } from "../../runtime/vendor/cordis/index.ts"
import type { SaveTextSpill, SpillRef } from './types.ts'

export { SpillLocator } from './types.ts'
export type { SaveTextSpill, SpillOwner, SpillRef, SpillSource } from './types.ts'

declare module "../../runtime/vendor/cordis/index.ts" {
  interface Context {
    spillStore: SpillStore
  }
}

/**
 * Abstract spill storage service. Subclass, implement {@link saveText}, and load
 * the subclass as a plugin — it registers as `ctx.spillStore` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link saveText} persists the FULL `content` verbatim and returns an opaque
 *   locator, exact byte length, and model-facing retrieval guidance.
 * - Storage is scoped by the request's {@link SaveTextSpill.owner} session; the
 *   backend chooses a private (not world-readable) location and a collision-free
 *   name derived from — never equal to — the caller's `suggestedName`.
 * - `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend
 *   unavailable); the caller decides how to degrade (the spill policy treats a
 *   rejection as best-effort and keeps the inline result).
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * Persist `input.content` to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>

  /**
   * Remove every artifact spilled for one session, for a deleted session.
   * Backends that keep no per-session artifacts keep this no-op.
   * @param sessionId - the owning session.
   * @returns resolution once the artifacts are gone.
   */
  forget(sessionId: string): Promise<void> {
    void sessionId
    return Promise.resolve()
  }
}

export default SpillStore
