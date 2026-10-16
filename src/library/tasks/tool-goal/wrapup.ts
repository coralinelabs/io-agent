/** Model-visible wrap-up instruction for a terminal autonomous goal update. */

import { modelText } from "../../context/text/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"

const GROUNDING =
  modelText('runtime/tool-goal-wrapup/text-01')

/**
 * Render the closing-message instruction injected after an autonomous goal
 * round reports `complete` or `blocked`, replacing the former hard turn stop
 * so the model still addresses the user once before the turn ends.
 * @param objective - the terminal goal's objective, echoed for grounding.
 * @param blockedReason - the validated report for `blocked`; omitted for `complete`.
 * @returns a fresh one-block context for `ToolRunContext.deferContext()`.
 */
export function renderWrapupContext(objective: string, blockedReason?: string): ContentBlock[] {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  const text = blockedReason === undefined
    ? modelText('runtime/tool-goal-wrapup/text-02', { value_1: String(heading), value_2: String(GROUNDING) })
    : modelText('runtime/tool-goal-wrapup/text-03', { value_1: String(heading), value_2: String(JSON.stringify(blockedReason)), value_3: String(GROUNDING) })
  return [{ type: 'text', text }]
}
