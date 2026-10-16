/** Optional product agents share io's child ownership, never its main model route. */
import type { Context } from '../runtime/vendor/cordis/index.ts'
import type { Agent } from '../runtime/agents/index.ts'
import type { Fiber } from '../runtime/vendor/cordis/index.ts'
import type { Config as CodexConfig } from '../agents/subagent-codex/index.ts'
import type { Config as ClaudeCodeConfig } from '../agents/subagent-claude-code/index.ts'
import { snapshotJsonValue } from '../util/values/index.ts'
import { modelText } from '../context/text/index.ts'
import * as ToolSubagent from '../agents/tool-subagent/index.ts'

/** External runtimes enforce their own tools, credentials, and native policy. This is not io sandbox inheritance. */
export type ExternalAgentOptions = ({
  kind: 'codex'
} & CodexConfig | {
  kind: 'claude-code'
} & ClaudeCodeConfig) & {
  /** A deliberate host opt-in to independent native permissions, not a model-selected capability. */
  executionPolicy: 'native'
  /** Stable advertised tool name. Defaults to subagent_codex or subagent_claude_code. */
  toolName?: string
}

export interface ExternalAgentMount {
  readonly providerName: string
  readonly toolName: string
  /** Withdraw future calls; already-published runs retain their original lifecycle ownership. */
  dispose(): Promise<void>
}

const reservations = new WeakMap<Context, Set<string>>()

/** Register a complete external provider plus its model-facing tool; imports are lazy and fail explicitly. */
export async function mountExternalAgent(ctx: Context, options: ExternalAgentOptions): Promise<ExternalAgentMount> {
  const owned = snapshotJsonValue(options)
  if (owned === undefined) throw new TypeError('External agent configuration must be lossless JSON')
  options = owned as ExternalAgentOptions
  if (options.executionPolicy !== 'native') throw new TypeError('External agents require executionPolicy: native')
  if (options.kind !== 'codex' && options.kind !== 'claude-code') throw new TypeError('Unknown external agent kind')
  const providerName = options.providerName ?? options.kind
  const toolName = options.toolName ?? `subagent_${options.kind.replaceAll('-', '_')}`
  if (!/^[a-zA-Z][\w-]{0,127}$/.test(toolName)) throw new TypeError('Invalid external agent tool name')
  const reserved = reservations.get(ctx.root) ?? new Set<string>()
  reservations.set(ctx.root, reserved)
  const keys = [`provider:${providerName}`, `tool:${toolName}`]
  if (keys.some(key => reserved.has(key))) throw new Error('External agent mount is already owned')
  for (const key of keys) reserved.add(key)
  const restrictions = new Map<Agent, () => void>()
  const fibers: Fiber[] = []
  let disposeTask: Promise<void> | undefined
  let accepting = true
  const guard = ctx.tools.guard(exec => exec.name === toolName &&
    (!accepting || exec.agent?.session.header.parentSession !== undefined)
    ? modelText('integrations/external-root-only') : undefined)
  const restrict = (agent: Agent): void => {
    if (agent.session.header.parentSession === undefined || restrictions.has(agent) || ctx.tools.get(toolName) === undefined) return
    restrictions.set(agent, () => {}) // tools/change is synchronous and reentrant.
    try { restrictions.set(agent, agent.ctx.tools.restrict({ deny: [toolName] })) }
    catch (error) { restrictions.delete(agent); throw error }
  }
  const disposeHook = ctx.on('agent/created', async ({ agent }) => { restrict(agent) })
  const disposeChanged = ctx.on('tools/change', () => { for (const agent of ctx.agents.list()) restrict(agent) })
  const disposeAgent = ctx.on('agent/disposed', ({ agent }) => { restrictions.delete(agent) })
  const dispose = (): Promise<void> => disposeTask ??= (async () => {
    accepting = false
    disposeHook()
    disposeChanged()
    disposeAgent()
    const errors: unknown[] = []
    for (const fiber of [...fibers].reverse()) {
      try { await fiber.dispose() } catch (error) { errors.push(error) }
    }
    for (const release of restrictions.values()) release()
    restrictions.clear()
    guard()
    for (const key of keys) reserved.delete(key)
    if (errors.length) throw new AggregateError(errors, 'External agent cleanup failed')
  })()
  try {
    if (ctx.tools.get(toolName) !== undefined) throw new Error(`Tool already registered: ${toolName}`)
    if (ctx.subagents.getProvider(providerName) !== undefined) throw new Error(`Provider already registered: ${providerName}`)
    for (const agent of ctx.agents.list()) restrict(agent)
    const { executionPolicy: _policy, toolName: _tool, kind: _kind, ...config } = options
    const provider = options.kind === 'codex'
      ? ctx.plugin(await import('../agents/subagent-codex/index.ts'), { ...config, providerName } as CodexConfig)
      : ctx.plugin(await import('../agents/subagent-claude-code/index.ts'), { ...config, providerName } as ClaudeCodeConfig)
    fibers.push(provider)
    await provider.await()
    const tool = ctx.plugin(ToolSubagent, {
      provider: providerName, toolName, maxDepth: 'provider-managed',
      backgroundMode: 'one-shot', enableRunInBackground: true,
    })
    fibers.push(tool)
    await tool.await()
    ctx.effect(() => () => dispose())
    return { providerName, toolName, dispose }
  } catch (error) {
    try { await dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'External agent startup failed') }
    throw error
  }
}

export { mountLanguageServers } from './code-intelligence.ts'
export type { LanguageServerOptions, LanguageServerMount, LspProvider, LspQueryRequest, LspQueryResult } from './code-intelligence.ts'
