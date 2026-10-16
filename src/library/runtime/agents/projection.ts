import type { TurnBoundaryProjection } from './types.ts'
import type {} from "../../session/projection/index.ts"

declare module "../../session/projection/types.ts" {
  interface SessionProjectionStateMap {
    /** The agent session's open/last turn and step boundary facts (whole value). */
    turnBoundary: TurnBoundaryProjection
  }
}

export {}
