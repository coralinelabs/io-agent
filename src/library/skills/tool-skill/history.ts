/**
 * Recognize skill loads in durable history, for consumers that condense it
 * (compaction checkpoints). The loader owns every format read here: rendered
 * `<skill_content>` bodies and `/name` injections, so a consumer never
 * re-derives them from prompt templates. Only a rendered body is a load, so
 * "unchanged" replies and fork reports need no format of their own.
 *
 * Durable history records tool names, not definitions, so a result is
 * attributed to the loader by its call name and a body whose rendered name
 * matches the request.
 *
 * @module io-agent/tool-skill/history
 */

import type { Message } from "../../model/llm/index.ts"
import { skillContentName } from "../skill/index.ts"

/** Model-facing name of the skill loader tool. */
export const SKILL_TOOL_NAME = 'skill'

/** A successful tool result read from durable history, with the call that produced it. */
export interface HistoryToolResult {
  /** Name and raw JSON arguments of the paired call, when that call is known. */
  readonly call?: { readonly name: string; readonly arguments: string }
  /** The result's text as the context shows it now, blocks joined. */
  readonly text: string
  /** Whether another producer (a pruner) rewrote the result in place. */
  readonly rewritten: boolean
  /** The text the call recorded before any rewrite, when the consumer could read it back. */
  readonly recordedText?: string
}

/**
 * Name the skill whose instructions a successful loader result put into the
 * context: a rendered body for the requested skill, as the call recorded it,
 * whatever another producer (a pruner) later rewrote it to. An "unchanged"
 * reply or a fork report, stubbed or not, loaded nothing into this context.
 * A rewritten result whose recorded text is unknown is judged by what it
 * shows now, so a stub or marker without its original counts as no load.
 * @param result - a successful tool result and its call.
 * @returns the loaded skill's name, or `undefined` when the result is not such a load.
 */
export function loadedSkillName(result: HistoryToolResult): string | undefined {
  if (result.call?.name !== SKILL_TOOL_NAME) return undefined
  const requested = requestedSkill(result.call.arguments)
  const rendered = skillContentName(result.recordedText ?? result.text)
  if (rendered === undefined) return undefined
  return requested === undefined || rendered === requested ? rendered : undefined
}

/**
 * Name the skill whose instructions a user-explicit `/name` invocation
 * injected. A fork invocation injects a pointer, not instructions.
 * @param message - a surface message.
 * @returns the injected skill's name, or `undefined` when the message is not such an injection.
 */
export function injectedSkillName(message: Message): string | undefined {
  if (message.source.kind !== 'skill-invocation') return undefined
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  return skillContentName(text) === undefined ? undefined : message.source.name
}

function requestedSkill(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as unknown
    const name = typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : undefined
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}
