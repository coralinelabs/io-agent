/**
 * MCP servers a host connects while its engine runs. `IoAgentOptions.mcp` connects trusted servers before any
 * session exists; a host whose servers come and go (a person connects one from a settings page) mounts each
 * from its `configure()` hook instead, and disposes it when it goes. A server that connects after a session's
 * first request appends its tools after that session's tool list (mcp-client/server-context.ts).
 *
 * @module io-agent/host
 */

import { MAX_TIMER_DELAY_MS } from "../util/timeout/index.ts"
import type { Context } from "../runtime/vendor/cordis/index.ts"
import * as McpClient from "../mcp/mcp-client/index.ts"
import type { McpServerOptions } from "../runtime/options.ts"

/** One MCP server mounted on a running engine. */
export interface McpServerMount {
  /**
   * Settles once the first connection and tool listing finished, with the error when they failed. A server
   * that failed stays disconnected (mount it again to retry); one that connected reconnects on its own.
   */
  readonly ready: Promise<{ error?: unknown }>
  /** The server's tools as the model is offered them now (`mcp__<serverName>__<tool>`). */
  tools(): string[]
  /** Disconnect and withdraw its tools; settles once they are gone. Repeated calls share one disposal. */
  dispose(): Promise<void>
}

/**
 * Connect one MCP server to the engine of `context`, the context a host's `configure()` hook receives.
 * A `serverName` already mounted fails this mount's `ready` and leaves the other in place.
 * @param context Engine context from `configure()`.
 * @param server The server, as `IoAgentOptions.mcp` takes one; a stdio server needs its own `cwd`.
 * @returns The mount: its startup outcome, its live tools and its disposal.
 */
export function mountMcpServer(context: Context, server: McpServerOptions): McpServerMount {
  const fiber = context.plugin(McpClient, { ...server, toolCallTimeoutMs: server.toolCallTimeoutMs ?? MAX_TIMER_DELAY_MS, failOnStartupError: true })
  const prefix = `mcp__${server.serverName}__`
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= fiber.dispose().catch((error: unknown) => {
    context.logger.warn(`mcp-client(${server.serverName}): disposal failed: ${String(error)}`)
  })
  // A failed startup is rolled back by the plugin; disposing the fiber as well removes it from the registry.
  const ready = fiber.await().then(() => ({}), async (error: unknown) => { await dispose(); return { error } })
  return {
    ready,
    tools: () => context.tools.schemas().map(tool => tool.name).filter(name => name.startsWith(prefix)),
    dispose,
  }
}
