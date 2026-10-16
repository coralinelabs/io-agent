/** Isolated skills use the ordinary delegated tool path, including its approval hooks,
 * child-route selection, depth limit, cancellation, persistence and quiescent disposal.
 * This module never creates an Agent or maintains its own execution loop.
 */
import type { Context } from '../runtime/vendor/cordis/index.ts'
import type { ToolRunContext } from '../tools/index.ts'
import type { SkillDefinition } from './skill/index.ts'
import { renderSkillContent } from './skill/index.ts'
import { ToolCallId } from '../model/llm/index.ts'
import { modelText } from '../context/text/index.ts'

export async function runSkillFork(ctx: Context, skill: SkillDefinition, exec: ToolRunContext, argumentsText: string): Promise<{ runId: string; result: string }> {
  if (exec.agent === undefined || ctx.tools.get('subagent', exec.agent) === undefined) {
    throw new Error(modelText('skills/fork-unavailable'))
  }
  const delegated = await ctx.tools.execute({
    callId: ToolCallId(`${exec.callId}:skill-fork`), rootCallId: exec.rootCallId, parent: exec.token,
    name: 'subagent', agent: exec.agent, signal: exec.signal,
    arguments: { description: modelText('skills/fork-label', { name: skill.name }), prompt: renderSkillContent(skill) + (argumentsText ? '\n\n' + modelText('skills/fork-arguments', { arguments_text: argumentsText }) : ''), run_in_background: false,
      ...(skill.execution?.allowedTools === undefined ? {} : { allowed_tools: [...skill.execution.allowedTools] }) },
  })
  for (const context of delegated.additionalContexts ?? []) exec.deferContext(context)
  if (delegated.isError) throw new Error(delegated.error.message)
  const value = delegated.value
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'foreground' || typeof value.runId !== 'string') {
    throw new Error(modelText('skills/fork-invalid-result'))
  }
  // Keep the established text-oriented subagent result contract. Full child history,
  // including non-text artifacts, remains available through its durable run identity.
  return { runId: value.runId, result: delegated.content.filter(b => b.type === 'text').map(b => b.text).join('\n') }
}
