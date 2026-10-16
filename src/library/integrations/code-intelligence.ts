/** Optional code intelligence through trusted host-configured language servers. */
import type { Context, Fiber } from '../runtime/vendor/cordis/index.ts'
import type { Config as StdioConfig } from '../lsp/lsp-stdio/index.ts'
import type { Config as ToolConfig } from '../lsp/tool-lsp/index.ts'
import { snapshotJsonValue } from '../util/values/index.ts'
import Lsp from '../lsp/lsp/index.ts'
import * as Stdio from '../lsp/lsp-stdio/index.ts'
import * as Tool from '../lsp/tool-lsp/index.ts'

export type LanguageServerOptions = StdioConfig & {
  /** Language servers are trusted native processes, not sandboxed tool calls. */
  executionPolicy: 'native'
  tool?: ToolConfig
}
export interface LanguageServerMount {
  /** Withdraw navigation before draining processes; idempotently waits for teardown. */
  dispose(): Promise<void>
}
const mounts = new WeakSet<Context>()

/** Register one coherent set of servers and one model-facing navigation tool. */
export async function mountLanguageServers(ctx: Context, options: LanguageServerOptions): Promise<LanguageServerMount> {
  if (options.executionPolicy !== 'native') throw new TypeError('Language servers require executionPolicy: native')
  const owned = snapshotJsonValue(options) as LanguageServerOptions | undefined
  if (!owned) throw new TypeError('Language server options must be lossless JSON')
  if (mounts.has(ctx.root)) throw new Error('Language servers already mounted')
  if (ctx.tools.get('lsp') !== undefined || ctx.get('lsp') !== undefined) throw new Error('Language server capability is already owned')
  mounts.add(ctx.root)
  const fibers: Fiber[] = []
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const errors: unknown[] = []
    for (const fiber of [...fibers].reverse()) {
      try { await fiber.dispose() } catch (error) { errors.push(error) }
    }
    mounts.delete(ctx.root)
    if (errors.length) throw new AggregateError(errors, 'Language server disposal failed')
  })()
  try {
    const registry = ctx.plugin(Lsp)
    fibers.push(registry)
    await registry.await()
    const providers = ctx.plugin(Stdio, { servers: owned.servers })
    fibers.push(providers)
    await providers.await()
    const tool = ctx.plugin(Tool, owned.tool ?? {})
    fibers.push(tool)
    await tool.await()
    ctx.effect(() => () => dispose())
    return { dispose }
  } catch (error) {
    try { await dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Language server startup failed') }
    throw error
  }
}

export { Lsp }
export type { LspProvider, LspQueryRequest, LspQueryResult } from '../lsp/lsp/types.ts'
