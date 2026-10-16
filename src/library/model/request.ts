/** Model-call envelopes and session-header bookkeeping; no turn or retry decisions. */
import type { Agent, AgentEventDispatch } from '../runtime/agents/index.ts'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from './llm/index.ts'
import { LlmError, markAgentLoopRequest } from './llm/index.ts'
import { deepFreeze } from '../util/values/index.ts'
import type { EpochHeader, RequestContext, SessionSeq } from '../session/journal/index.ts'
import { appendNewTools, canonicalHeader, headerEquals } from '../session/journal/index.ts'
import { renderPromptSections, type PromptAssembly } from '../context/assembly/index.ts'
import type { Context } from '../runtime/vendor/cordis/index.ts'
import { SystemPromptProjection } from '../context/projection.ts'
import type { UserMessage } from '../session/journal/index.ts'

/** Already-admitted request inputs. The library does not decide whether to enter a step. */
export interface AdmittedRequest { messages: UserMessage[]; startsRequestSeries?: true; assembly: PromptAssembly }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** One request builder per session; the loop decides when to call it. */
export class RequestBuilder {
  private requestHeaderLogged = false
  /** Surface nodes the previous request sent, in order. */
  private requestNodes: readonly SessionSeq[] = []
  /** Plugin message projections folded when the previous request was built. */
  private requestProjections = 0
  private readonly systemPrompt: SystemPromptProjection
  private readonly frozenMessages = new WeakSet<Message>()
  constructor(private readonly loopCtx: Context, private readonly agent: Agent,
    private readonly dispatch: AgentEventDispatch) {
    this.rememberRequestSurface()
    this.systemPrompt = new SystemPromptProjection(agent.session)
  }
  /** Snapshot what the request being built sends, for the next series test. */
  private rememberRequestSurface(): void {
    const { surface } = this.agent.session
    this.requestNodes = [...surface.nodes]
    this.requestProjections = surface.contentGeneration - surface.replaceGeneration
  }
  /**
   * Whether history the previous request sent was rewritten since, which starts
   * a new request series. A plugin projection counts (it may change any sent
   * message); a surface replacement counts only when the previous request's
   * nodes are no longer the current surface's prefix. Replacing results that
   * were appended after the previous request and never sent (the spill
   * policy's per-step budget) leaves the sent prefix intact and is no break.
   */
  private sentHistoryRewritten(): boolean {
    const { surface } = this.agent.session
    if (surface.contentGeneration - surface.replaceGeneration !== this.requestProjections) return true
    const nodes = surface.nodes
    if (nodes.length < this.requestNodes.length) return true
    return this.requestNodes.some((seq, index) => nodes[index] !== seq)
  }
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    const baseline = this.agent.session.requestHeader()
    return baseline !== undefined && !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }
  async prepare(decision: AdmittedRequest, firstAttempt: boolean,
    turn: number, step: number, signal: AbortSignal): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { config, preparedCall } = await this.prepareRequest(turn, step, signal)
    const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true
    // Tools added mid-session (a late MCP server) follow the previous request's list instead of
    // landing mid-list by name, so the cached prefix keeps every earlier schema.
    const tools = appendNewTools(this.agent.session.requestHeader()?.tools, decision.assembly.tools)
    const sections = renderPromptSections(decision.assembly)
    // kv100 keeps a sent system node only while the route that received it goes on: another model, or the same
    // model reading system messages differently, has lost that prefix already, so the current prompt goes in.
    const previous = this.agent.session.requestContext()
    const sameRoute = previous?.provider === config.provider && previous.model === config.model
      && previous.systemPromptUpdate === preparedCall?.systemPromptUpdate
    const commits = this.systemPrompt.project(sections.map(section => section.text).join('\n\n'), {
      inHistory: preparedCall?.systemPromptUpdate === 'in-history',
      startsSeries: startsRequestSeries || this.sentHistoryRewritten()
        || this.toolsChanged(tools),
      ...preparedCall?.kv100 === true && sameRoute ? { appendOnly: true } : {},
    }, sections)
    for (const { message, intent } of commits) this.agent.session.append('system/message', { turn, step, message }, intent)
    if (firstAttempt) for (const message of decision.messages) this.agent.session.append('user/message', message, { surfaceOp: 'append' })
    const request = this.buildRequest(config, preparedCall, tools, startsRequestSeries, signal)
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
  /** Resolve request config and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this.agent

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.agent.options.provider ?? '', model: this.agent.options.model ?? '' }
    const persistedReasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const reasoningEffort = this.agent.options.reasoningEffort ?? persistedReasoningEffort
    const maxTokens = this.agent.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.agent.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Log the resolved envelope and derive a frozen request from the admitted surface. */
  private buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    startsRequestSeries: boolean,
    signal: AbortSignal,
  ): GenerateOptions {
    const { session } = this.agent
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.agent.session.requestHeader()
    const startsSeries = startsRequestSeries || this.sentHistoryRewritten()
    if (!this.requestHeaderLogged) {
      this.agent.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.agent.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      })
    } else if (startsSeries) {
      this.agent.session.append('request/header', { header, reason: 'series' })
    }
    this.rememberRequestSurface()

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    deepFreeze(header)
    const boundaryMessages = session.deriveMessages()
    for (const message of boundaryMessages) {
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    Object.freeze(boundaryMessages)
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.agent.session.id,
      signal,
    }))
    return request
  }
}
