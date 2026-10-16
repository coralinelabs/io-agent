/**
 * Three shared tools adapt model arguments to scoped resource operations.
 *
 * @module io-agent/mcp-resources
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { defineTool, type ToolExecution } from "../../tools/index.ts"
import type { JsonValue } from "../../util/values/index.ts"
import type { McpResourceRequest } from './index.ts'
import { renderResourceResult } from './render.ts'

type RequestResource = (server: string, request: McpResourceRequest, exec: ToolExecution) => Promise<JsonValue>

const listParameters = {
  server: { type: 'string', required: true, description: modelText('foundation/mcp-resources-tools/text-01') },
  cursor: { type: 'string', description: modelText('foundation/mcp-resources-tools/text-02') },
} as const

const output = {
  schema: { type: 'json' } as const,
  render: (args: { server: string }, value: JsonValue) => renderResourceResult(args.server, value),
}

/**
 * Register resource operations in the consumer's tool scope.
 * @param ctx - context owning the tool registrations.
 * @param request - caller-aware resource operation.
 * @returns the effect disposer that removes all three tools synchronously.
 */
export function registerResourceTools(ctx: Context, request: RequestResource): () => void {
  const dispose = ctx.effect(function* () {
    yield ctx.tools.register(defineTool({
      name: 'list_mcp_resources',
      description: modelText('foundation/mcp-resources-tools/text-03'),
      parameters: listParameters,
      output,
      execute: (args, exec) => request(args.server, {
        method: 'resources/list', ...args.cursor === undefined ? {} : { cursor: args.cursor },
      }, exec),
    }))
    yield ctx.tools.register(defineTool({
      name: 'list_mcp_resource_templates',
      description: modelText('foundation/mcp-resources-tools/text-04'),
      parameters: listParameters,
      output,
      execute: (args, exec) => request(args.server, {
        method: 'resources/templates/list', ...args.cursor === undefined ? {} : { cursor: args.cursor },
      }, exec),
    }))
    yield ctx.tools.register(defineTool({
      name: 'read_mcp_resource',
      description: modelText('foundation/mcp-resources-tools/text-05'),
      parameters: {
        server: listParameters.server,
        uri: { type: 'string', required: true, description: modelText('foundation/mcp-resources-tools/text-06') },
      },
      output,
      execute: (args, exec) => request(args.server, { method: 'resources/read', uri: args.uri }, exec),
    }))
  }, 'mcpResources.resourceTools')
  // oxlint-disable-next-line typescript/no-misused-promises -- all collected tool disposers are synchronous
  return dispose
}
