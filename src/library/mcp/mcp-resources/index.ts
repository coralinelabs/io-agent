/**
 * Scoped MCP resource providers and the shared model-facing resource tools.
 *
 * @module io-agent/mcp-resources
 */

import { modelText } from "../../context/text/index.ts"
import { Service, type Context } from "../../runtime/vendor/cordis/index.ts"
import { createScope, NamedEntries, ScopedLayers, scopeOf, type ScopeKey, type ScopeLayer } from "../../runtime/scope/index.ts"
import type { JsonValue } from "../../util/values/index.ts"
import type { ToolExecution } from "../../tools/index.ts"
import type { AssembleContext } from "../../context/assembly/index.ts"
import type {} from "../../runtime/agents/index.ts"
import { sessionPinnedSection } from "../../context/projection.ts"
import { registerResourceTools } from './tools.ts'

declare module "../../runtime/vendor/cordis/index.ts" {
  interface Context {
    mcpResources: McpResourceRuntime
  }
}

/** Name of the system section and the runtime context that list the resource servers. */
const RESOURCE_SERVERS = 'mcp-resource-servers'

/** One supported resource operation, with server-owned cursors and URIs. */
export type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }

/** One configured server's resource access, owned by its MCP connection plugin. */
export interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}

class ResourceLayer implements ScopeLayer {
  readonly servers = new NamedEntries<McpResourceProvider>(name =>
    new Error(modelText('foundation/mcp-resources-index/text-01', { value_1: String(name) })))
  disposeTools: (() => void | Promise<void>) | undefined

  isEmpty(): boolean {
    return this.servers.isEmpty()
  }
}

/** Scoped resource access plus three tools shared by configured MCP servers. */
export class McpResourceRuntime extends Service {
  /** Tool registry required by the resource consumer. */
  static inject = ['tools']

  private readonly layers = new ScopedLayers(() => new ResourceLayer(), () => undefined)
  /** Shared tool registrations outlive any one server's registering context. */
  private readonly selfCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'mcpResources')
    this.selfCtx = ctx

    // The list a session's system prompt shows is the one recorded when that prompt was built;
    // a server registered or removed later is stated as runtime context instead.
    const live = ({ scope }: AssembleContext): string[] => [...this.layers.merge(scope, layer => layer.servers).keys()].sort()
    const liveSection = (context: AssembleContext): string => {
      const names = live(context)
      return names.length === 0 ? '' : modelText('mcp/resource-servers', { servers: JSON.stringify(names) })
    }
    const shown = (context: AssembleContext): string =>
      sessionPinnedSection(context.agent?.session, RESOURCE_SERVERS, () => liveSection(context))
    ctx.inject(['systemPrompt'], (inner) => {
      inner.systemPrompt.section({
        name: RESOURCE_SERVERS,
        order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
        interpolate: false,
        text: shown,
      })
      inner.systemPrompt.context({
        name: RESOURCE_SERVERS,
        order: inner.systemPrompt.getContextOrder('MCP_SERVER_UPDATES'),
        interpolate: false,
        text: (context) => {
          if (liveSection(context) === shown(context)) return ''
          const names = live(context)
          return names.length === 0
            ? modelText('mcp/resource-servers-withdrawn')
            : modelText('mcp/resource-servers-updated', { servers: JSON.stringify(names) })
        },
      })
    })
  }

  /**
   * Register one server and expose resource tools while that scope has providers.
   * @param server - configured server name, unique in this scope.
   * @param provider - connection-owned resource operations.
   * @returns the effect disposer for this exact registration.
   */
  register(server: string, provider: McpResourceProvider): () => void {
    const ctx = this.ctx
    const scope = scopeOf(ctx)
    const dispose = ctx.effect(function* (this: McpResourceRuntime) {
      let disposal: void | Promise<void>
      // Tools disappear synchronously; Cordis owns any pending scoped-fiber teardown.
      yield () => disposal
      yield this.layers.effect(ctx, (layer) => {
        const first = layer.servers.isEmpty()
        const remove = layer.servers.insert(server, provider)
        try {
          if (first) layer.disposeTools = this.registerTools(scope)
        } catch (error) {
          remove()
          throw error
        }
        return () => {
          remove()
          // oxlint-disable-next-line typescript/no-non-null-assertion -- successful provider registration owns the shared tools
          if (layer.servers.isEmpty()) disposal = layer.disposeTools!()
        }
      }, { label: `mcpResources.provider(${server})` })
    }.bind(this), `mcpResources.register(${server})`)
    // oxlint-disable-next-line typescript/no-misused-promises -- visibility cleanup is synchronous; Cordis retains pending fiber disposal
    return dispose
  }

  /** Own one scope's tools independently of its configured server plugins. */
  private registerTools(scope: ScopeKey | undefined): () => void | Promise<void> {
    const ctx = this.selfCtx
    return ctx.effect(function* (this: McpResourceRuntime) {
      let toolCtx = ctx
      if (scope !== undefined) {
        const owned = createScope(ctx, scope)
        yield owned.rawDispose
        toolCtx = owned.ctx
      }
      yield registerResourceTools(toolCtx, (server, request, exec) => this.request(server, request, exec))
    }.bind(this), 'mcpResources.tools')
  }

  /** Resolve the caller-visible server before starting any network operation. */
  private request(server: string, request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue> {
    const provider = this.layers.merge(exec.agent, layer => layer.servers).get(server)
    if (!provider) throw new Error(modelText('foundation/mcp-resources-index/text-02', { value_1: String(server) }))
    return provider.request(request, exec)
  }
}

export default McpResourceRuntime
