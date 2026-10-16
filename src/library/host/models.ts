/** Trusted session model selection; immutable adapters and the existing agent-scoped selection seam. */
import type { Context } from '../runtime/vendor/cordis/index.ts'
import { installModelSelection } from '../runtime/agents/index.ts'
import type { Agent, ModelSelectionRef } from '../runtime/agents/index.ts'
import { resolveConnection, AGENT_ROUTES } from '../model/connection.ts'
import type { ModelConnection, ResolvedConnection } from '../model/connection.ts'
import { registerConnection } from '../../plugins/router.ts'
import { applyReadImageTool } from '../filesystem/tool-fs/read-image.ts'
import { digest, HostError } from './validation.ts'

/** Normalize semantic routing without persisting or hashing transport credentials. */
export function modelIdentity(input: ModelConnection): string {
  const connection = resolveConnection(input)
  const { headers: _headers, ...profile } = connection.profile
  return digest({ profile, ttl: connection.promptCacheTtlMs })
}

/**
 * The model a session's route serves: its identity without what one turn may carry differently, its reasoning
 * effort and routing metadata (Max-Q). Turns that change only those keep the session's route, so the agent sees no
 * model change and the provider's cached prefix holds.
 */
export function endpointIdentity(input: ModelConnection): string {
  const connection = resolveConnection(input)
  const { headers: _headers, requestMetadata: _metadata, reasoning: _reasoning, ...profile } = connection.profile
  return digest({ profile, ttl: connection.promptCacheTtlMs })
}

export class HostModels {
  private readonly selected = new Map<string, ModelConnection>()
  private readonly refs = new WeakMap<Agent, ModelSelectionRef>()
  private readonly connections = new Map<string, { input: ModelConnection; identity: string; resolved: ResolvedConnection; dispose(): void }>()
  private readonly replayRoutes: string[] = [...AGENT_ROUTES]
  private readonly imageRestrictions = new WeakMap<Agent, () => void>()
  constructor(private readonly context: Context, private readonly initial: ModelConnection, private readonly capacity: number) {
    if (context.tools.get('read_image') === undefined) applyReadImageTool(context)
  }

  current(id: string): ModelConnection { return this.selected.get(id) ?? this.initial }

  /** Whether a connection is known for the session: one of its turns here chose it, or {@link recall} recorded it. */
  chosen(id: string): boolean { return this.selected.has(id) }

  /** Record the connection a session chose before this process (its embedder's answer); a choice made here wins. */
  recall(id: string, input: ModelConnection): void { if (!this.selected.has(id)) this.selected.set(id, input) }

  /** Called only after the host reserved an idle session and checked turn idempotency. */
  select(agent: Agent, input: ModelConnection): ResolvedConnection {
    const id = String(agent.id)
    const identity = modelIdentity(input)
    const key = `${id}:${endpointIdentity(input)}`
    let entry = this.connections.get(key)
    const resolve = (holder: { input: ModelConnection }): ResolvedConnection => resolveConnection({ ...holder.input, apiKey: async () => {
      const source = holder.input.apiKey
      return source === undefined ? 'EMPTY' : typeof source === 'function' ? await source() : source
    } })
    if (entry === undefined) {
      if (this.connections.size >= this.capacity) throw new HostError('CAPACITY', 'model connection capacity reached; release idle sessions')
      const holder = { input }
      const resolved = resolve(holder)
      resolved.route = `${resolved.route}-${digest(key).slice(0, 24)}`
      this.replayRoutes.push(resolved.route)
      entry = Object.assign(holder, { identity, resolved, dispose: registerConnection(this.context, resolved, this.replayRoutes) })
      this.connections.set(key, entry)
    } else if (entry.identity !== identity) {
      // Only the effort or the routing metadata changed: the same route, registered again with them. The session is
      // idle here (the host reserved it), so no request of its is in flight on the adapter being replaced.
      entry.input = input
      entry.dispose()
      const resolved = resolve(entry)
      resolved.route = entry.resolved.route
      entry.resolved = resolved
      entry.identity = identity
      entry.dispose = registerConnection(this.context, resolved, this.replayRoutes)
    } else entry.input = input
    this.selected.set(id, input)
    let ref = this.refs.get(agent)
    if (ref === undefined) {
      ref = { current: undefined, assembled: undefined }
      installModelSelection(agent.ctx, ref)
      this.refs.set(agent, ref)
    }
    // An uncapped connection names no maxTokens for the agents, so their requests carry no output cap.
    ref.current = { provider: entry.resolved.route, model: entry.resolved.model,
      ...entry.resolved.profile.outputCap === false ? {} : { maxTokens: entry.resolved.maxTokens } }
    // Hide the globally available capability for this session's text-only selection;
    // execution independently checks the actual request's route.
    this.imageRestrictions.get(agent)?.()
    this.imageRestrictions.delete(agent)
    if (!input.input?.includes('image')) this.imageRestrictions.set(agent, agent.ctx.tools.restrict({ deny: ['read_image'] }))
    return entry.resolved
  }

  /**
   * Run a delegated child whose recorded route is gone on its root's current connection. A child keeps the
   * connection it was created with while that registration lives; a restart drops every registration, and the
   * child's persisted provider would then name a route nothing serves, so a cold-resumed child made no request
   * at all. The root's selection is the host's current trusted connection for the session: nothing is rebuilt
   * from persisted state.
   * @returns false when the root has selected no connection in this process.
   */
  follow(root: Agent, child: Agent): boolean {
    const current = this.refs.get(root)?.current
    if (current === undefined) return false
    installModelSelection(child.ctx, { current: { ...current }, assembled: undefined })
    return true
  }

  /** Root disposal has drained its children before adapters are released. */
  release(id: string): void {
    for (const [key, entry] of this.connections) if (key.startsWith(`${id}:`)) {
      entry.dispose()
      this.connections.delete(key)
      const index = this.replayRoutes.indexOf(entry.resolved.route)
      if (index >= 0) this.replayRoutes.splice(index, 1)
    }
  }

  forget(id: string): void { this.release(id); this.selected.delete(id) }
}
