/**
 * When the model last answered this session: the input to the cold-cache
 * prune. A durable projection, not in-memory state, so a
 * resumed session (the common cold case) still knows how long it was idle.
 *
 * @module io-agent/compaction-basic/idle
 */

import { z } from 'zod'
import type { ProjectionDefinition } from "../../../session/projection/index.ts"

/** Host-only state: epoch milliseconds of the newest model response or failed attempt, if any. */
export interface ModelActivityState {
  readonly lastResponseAt: number | null
}

declare module "../../../session/projection/types.ts" {
  interface SessionProjectionStateMap {
    /** When a provider last served this session (compaction-basic's cold-cache input). */
    modelActivity: ModelActivityState
  }
}

const modelActivityStateSchema: z.ZodType<ModelActivityState> = z.object({
  lastResponseAt: z.number().int().nonnegative().nullable(),
}).strict()

/**
 * Fold the `time` of every `assistant/message` and `assistant/attempt`: each
 * is a request the provider answered (or failed after reading), so it is the
 * last moment the provider could have warmed its prompt cache for this session.
 */
export const modelActivityProjectionDefinition = {
  key: 'modelActivity',
  stateVersion: 1,
  stateSchema: modelActivityStateSchema,
  init: () => ({ lastResponseAt: null }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    return state.lastResponseAt === event.time ? state : { lastResponseAt: event.time }
  },
} satisfies ProjectionDefinition<'modelActivity', ModelActivityState>

/**
 * How long the session has been without a model response.
 * @param state - the session's model-activity state, when the unit is registered.
 * @param now - current epoch milliseconds.
 * @returns idle milliseconds, or `undefined` before the first response.
 */
export function idleMillis(state: ModelActivityState | undefined, now: number): number | undefined {
  if (state?.lastResponseAt === null || state === undefined) return undefined
  return Math.max(0, now - state.lastResponseAt)
}
