/**
 * Model-visible messages owned by continuable-subagent orchestration.
 *
 * @module io-agent/subagent/continuation-messages
 */

import { modelText } from "../../context/text/index.ts"
import type { Agent } from "../../runtime/agents/index.ts"
import { boundContextSummary, createUserMessage } from "../../model/llm/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { SessionId } from "../../session/journal/index.ts"
import type { ActivationTerminal } from './lifecycle.ts'
import type { SubagentResult } from './types.ts'

/** Durable attribution for one model-authored message between adjacent Agents. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}

/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module "../../model/llm/index.ts" {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/** Build durable attribution for one adjacent-Agent message. */
function agentMessageSource(sender: Agent): AgentMessageSource {
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: sender.id,
  }
}

/**
 * Build the model-visible and durable representation of one adjacent-Agent message.
 * @param sender - exact live Agent that authored the message.
 * @param content - model-visible message blocks supplied by the sender.
 * @returns the durable user-message representation delivered to the recipient.
 */
export function createAgentMessage(
  sender: Agent,
  content: ContentBlock[],
): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text' as const, text: modelText('runtime/subagent-continuation-messages/text-01', { value_1: String(sender.id) }) },
      ...content,
    ],
    source: agentMessageSource(sender),
  })
}

/**
 * Append adjacent-Agent return guidance to a continuable child's initial task.
 * @param parentId - durable parent session id named in the guidance.
 * @param prompt - initial model-visible task blocks.
 * @returns task blocks followed by the continuable return guidance.
 */
export function withContinuableReturnGuidance(
  parentId: SessionId,
  prompt: ContentBlock[],
): ContentBlock[] {
  const encodedParentId = JSON.stringify(parentId)
  return [
    ...prompt,
    {
      type: 'text',
      text: modelText('runtime/subagent-continuation-messages/text-02', { value_1: String(encodedParentId), value_2: String(encodedParentId) }),
    },
  ]
}

/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary.
 * @param childId - the durable child the parent knows by id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @returns the model-facing opening line of the settlement notice.
 */
function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason']): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return modelText('runtime/subagent-continuation-messages/text-03', { value_1: String(subject) })
    case 'aborted':
      return modelText('foundation/subagent-continuation-messages/text-01', { value_1: String(subject) })
    case 'max-tokens':
      return modelText('foundation/subagent-continuation-messages/text-02', { value_1: String(subject) })
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // the child had claimed, so the parent must not treat the task as done.
    case 'refusal':
      return modelText('foundation/subagent-continuation-messages/text-03', { value_1: String(subject) })
    case 'error':
      return modelText('foundation/subagent-continuation-messages/text-04', { value_1: String(subject) })
    /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
     * needs a backend that adds a variant; an unnameable ending is reported as unfinished
     * rather than silently as success. */
    default:
      return modelText('foundation/subagent-continuation-messages/text-05', { value_1: String(subject), value_2: String(String(stopReason)) })
  }
}

/**
 * Build the runtime-owned settlement notice from the child's nonempty closing text.
 * @param childId - durable child session id named in the notice.
 * @param terminal - recorded terminal state for the settled Activation.
 * @returns the durable user-message representation delivered to the parent.
 */
export function createSettlementMessage(
  childId: SessionId,
  terminal: ActivationTerminal,
): ReturnType<typeof createUserMessage> {
  const summary = settlementSummary(childId, terminal.stopReason)
  // Parent providers receive this notice as a user message and may reject
  // nontext assistant blocks. Keep this conversion local so SDK/UI consumers
  // retain the complete child output.
  const closingText = (terminal.output ?? []).flatMap(block =>
    block.type === 'text' && block.text.length > 0 ? [block] : [],
  )
  return createUserMessage({
    content: [
      { type: 'text' as const, text: summary },
      ...closingText.length === 0
        ? [{ type: 'text' as const, text: modelText('runtime/subagent-continuation-messages/text-04') }]
        : [{ type: 'text' as const, text: modelText('runtime/subagent-continuation-messages/text-05') }, ...closingText],
    ],
    source: {
      kind: 'subagent-settled' as const,
      form: 'notice' as const,
      summary: boundContextSummary(summary),
      senderSessionId: childId,
    },
  })
}
