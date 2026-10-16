/** Model-visible continuation prompt for one same-session goal round. */

import { modelText } from "../../context/text/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { GoalView } from "../goal/index.ts"

/**
 * Render the complete goal-round instruction retained in session history.
 * @param goal - exact active goal revision being admitted.
 * @param round - next positive round number.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderGoalRoundPrompt(goal: GoalView, round: number): ContentBlock[] {
  return [{
    type: 'text',
    text: modelText('runtime/goal-round-driver-prompt/text-01', { value_1: String(JSON.stringify(goal.objective)), value_2: String(round), value_3: String(goal.maxGoalRounds) }),
  }]
}
