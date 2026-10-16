/**
 * The globally named `send_message` and `interrupt_agent` tools: thin
 * model-facing adapters over `ctx.subagents.sendMessage()` and
 * `ctx.subagents.interrupt()`. They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — and they live apart from the provider-bound
 * `io-agent/tool-subagent` instances so multiple delegation tools share
 * one control API.
 * @module io-agent/tool-subagent-control
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { brandString } from "../../util/brand/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { SessionId } from "../../session/journal/index.ts"
import type {} from "../subagent/index.ts"
import { markAdjacentAgentSendMessageTool } from "../subagent/internal.ts"

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents']

/**
 * Register the `send_message` and `interrupt_agent` tools.
 * @param ctx - context carrying the tool registry and subagent service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(markAdjacentAgentSendMessageTool(defineTool({
    name: 'send_message',
    description:
      modelText('runtime/tool-subagent-control-index/text-01'),
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: modelText('runtime/tool-subagent-control-index/text-02'),
      },
      message: {
        type: 'string',
        required: true,
        description: modelText('runtime/tool-subagent-control-index/text-03'),
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: modelText('runtime/tool-subagent-control-index/text-04', { value_1: String(args.agent_id) }),
      }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) {
        throw new Error(modelText('foundation/tool-subagent-control-index/text-01'))
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.sendMessage(
        sender,
        brandString<SessionId>(args.agent_id),
        message,
        { signal: exec.signal },
      )
      return { messageId }
    },
  })))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      modelText('runtime/tool-subagent-control-index/text-05'),
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: modelText('runtime/tool-subagent-control-index/text-06'),
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: modelText('runtime/tool-subagent-control-index/text-07', { value_1: String(args.agent_id) }),
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error(modelText('runtime/tool-subagent-control-index/text-08'))
      }
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(brandString<SessionId>(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
