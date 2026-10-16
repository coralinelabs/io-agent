/**
 * Publish connection-owned MCP resources and literal server instructions.
 *
 * Instructions reach the model in two parts so a change never rewrites a
 * session's cached system prompt: the system section carries the text the
 * session's prompt recorded when it was built, and a
 * runtime-context entry states any difference from it — first instructions
 * of a server that connected after the prompt was built, new text after a
 * reconnect or in a later process, or text withdrawn when the supervisor
 * gives up.
 *
 * A session's first prompt shows the instructions the server first
 * published in this process (pinned). A prompt recorded before a server
 * connected shows none for it; its instructions arrive as runtime context,
 * and its tools are appended after the session's tool list. A prompt
 * committed without a record and an assembly without an agent
 * keep the per-process pin.
 *
 * @module io-agent/mcp-client
 */

import { modelText } from "../../context/text/index.ts"
import { sessionPinnedSection } from "../../context/projection.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type { McpResourceProvider } from "../mcp-resources/index.ts"
import type { AssembleContext } from "../../context/assembly/index.ts"
import type {} from "../../runtime/agents/index.ts"

/** Connection-owned values used by the resource and prompt consumers. */
export interface ServerContext {
  /** Resource access through the current connection generation. */
  resources: McpResourceProvider
  /**
   * Read the live generation's attributed instructions.
   * @returns literal prompt text, or an empty string when no server instructions are active.
   */
  instructions(): string
  /**
   * Read the first attributed instructions this connection published, for the
   * session-constant system prompt.
   * @returns literal prompt text, or an empty string before the first
   * successful connection or when the server first published none.
   */
  pinnedInstructions(): string
}

/**
 * The runtime-context statement of how the live instructions differ from the
 * ones the system prompt shows.
 * @param server - configured server identity.
 * @param live - the live generation's instructions.
 * @param shown - the instructions the session's system prompt shows for this server.
 * @returns literal text, or '' when the system prompt is still accurate.
 */
export function instructionUpdate(server: string, live: string, shown: string): string {
  if (live === shown) return ''
  return live === ''
    ? modelText('mcp/server-instructions-withdrawn', { name: server })
    : modelText('mcp/server-instructions-updated', { name: server, instructions: live })
}

/**
 * Contribute server context to the services enabled by this composition.
 * @param ctx - server plugin's registration scope and effect owner.
 * @param server - configured server identity.
 * @param connection - live resource operations and pinned/live instruction snapshots.
 */
export function registerServerContext(ctx: Context, server: string, connection: ServerContext): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources)
  })
  const name = `mcp:${server}`
  const shown = (context: AssembleContext): string =>
    sessionPinnedSection(context.agent?.session, name, () => connection.pinnedInstructions())
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name,
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: shown,
    })
    inner.systemPrompt.context({
      name,
      order: inner.systemPrompt.getContextOrder('MCP_SERVER_UPDATES'),
      interpolate: false,
      text: context => instructionUpdate(server, connection.instructions(), shown(context)),
    })
  })
}
