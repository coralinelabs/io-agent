/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module io-agent/subagent
 */

import { HarnessError } from "../../model/llm/index.ts"

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
