/**
 * The model-visible notice that follows a response cut off at its output
 * limit. The loop decides whether to continue; this module only builds the
 * message it appends.
 * @module io-agent/runtime/output-limit
 */

import { modelText } from '../context/text/index.ts'
import { createUserMessage } from '../model/llm/index.ts'
import type { UserMessage } from '../session/journal/index.ts'

/** Plugin id recorded as the notice's source; journals hold it, so it keeps its name from before io-agent. */
export const OUTPUT_LIMIT_NOTICE_PLUGIN = 'pluto/loop'

/**
 * Build the notice appended after a `max-tokens` step: none of the cut
 * response's tool calls ran, and the next step should be smaller. It carries
 * no number, because the adapter may have clamped the requested budget.
 * @returns a fresh user message for the next step.
 */
export function outputLimitNotice(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: modelText('control/output-limit') }],
    source: { kind: 'plugin', plugin: OUTPUT_LIMIT_NOTICE_PLUGIN, form: 'notice', summary: 'output limit' },
  })
}
