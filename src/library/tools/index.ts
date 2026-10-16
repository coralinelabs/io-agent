/**
 * Scoped tool registration and model presentation. Execution has one shared
 * pipeline in invocation.ts; wire contracts and canonical outcomes live separately.
 * Derived registry lifecycle retains io-agent compatibility.
 */

import { modelText } from "../context/text/index.ts"
import { Context, Service } from "../runtime/vendor/cordis/index.ts"
import z from "../runtime/vendor/schemastery/index.ts"
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeTarget } from "../runtime/scope/index.ts"
import type { ScopeKey, ScopeLayer, Scoped } from "../runtime/scope/index.ts"
import type { ContentBlock, ToolSchema } from "../model/llm/index.ts"
import { snapshotJsonValue } from "../util/values/index.ts"
import type { PromptSection, ToolProviderResult } from "../context/assembly/index.ts"
import type { PtcRuntime } from "../execution/workers/ptc-runtime/index.ts"
import type {} from "../execution/sandbox/sandbox-policy/index.ts"
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime — see `serviceAsk`.
import type {} from "../interaction/user-approval/index.ts"
import { assertSupportedJsonSchema } from './json-schema.ts'
import { createRunCodeTool, RUN_CODE_NAME } from './ptc.ts'
import type { PtcSdkLanguage } from './ptc.ts'
import { renderToolsSdk } from './ts-types.ts'
import type { ToolSdkSchema } from './ts-types.ts'
import { renderToolsSdkPy } from './py-types.ts'
import { modelText as contextText } from "../context/text/index.ts"
import type { Agent } from "../runtime/agents/index.ts"
import {
  createDeferralBridges,
  DEFERRAL_BRIDGE_NAMES,
  isDeferralBridge,
  planDeferral,
  renderDeferredCatalog,
  resolveDeferralConfig,
  TOOL_SEARCH_NAME,
} from './deferral.ts'
import type { DeferralConfig, DeferralPlan } from './deferral.ts'

/**
 * Language → SDK-section renderer. The registry looks up the loaded
 * `ctx.ptcRuntime.language` in this table when assembling the `tools:sdk`
 * section under a non-native mode; a runtime whose language is not a key
 * fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
 * new backend language is three parallel edits — a {@link PtcSdkLanguage}
 * member, an entry here, and a `RUN_CODE_FLAVORS` entry in `ptc.ts` for
 * its `run_code` schema strings — plus the renderer function this table points
 * at. The `satisfies` clause pins this table's key set to that union, which
 * the flavor table is checked against too, so any of the three left out is a
 * typecheck failure. What no check reaches is the prose that names the values
 * instead of deriving them: the `PtcRuntime.language` JSDoc and the
 * {@link Config.mode} JSDoc.
 */
/**
 * The model-facing statement of the `ptc` collapse. Names the consequence
 * (the call fails) and the route (inside the program), because a rule the
 * model can only discover by being denied is one it corrects too late.
 */
const PTC_ONLY_INSTRUCTION = modelText('foundation/tools-index/text-01', { value_1: String(RUN_CODE_NAME) })

const SDK_RENDERERS: Record<string, (schemas: ToolSdkSchema[]) => string> = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy,
} satisfies Record<PtcSdkLanguage, (schemas: ToolSdkSchema[]) => string>

export {
  defineTool,
  valueSchemaSpecToJsonSchema,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
  ToolArgsError,
  type ValueSchemaAnnotations,
  type StringValueSchemaSpec,
  type NumberValueSchemaSpec,
  type IntegerValueSchemaSpec,
  type BooleanValueSchemaSpec,
  type NullValueSchemaSpec,
  type ArrayValueSchemaSpec,
  type ObjectValueSchemaSpec,
  type JsonValueSchemaSpec,
  type OneOfValueSchemaSpec,
  type ValueSchemaSpec,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type ParameterJsonSchema,
  type InferValue,
  type InferArgs,
  type DefineToolOptions,
} from './schema.ts'

export {
  assertSupportedJsonSchema,
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  JsonSchemaError,
  type JsonSchemaNode,
  type ObjectJsonSchema,
  type JsonSchemaType,
  type JsonSchemaScalar,
} from './json-schema.ts'

export type { PtcDispatchEventData, PtcDispatchStartEventData } from './types.ts'

export { CodeRunFailedError, RUN_CODE_NAME } from './ptc.ts'
export {
  DEFERRAL_BRIDGE_NAMES,
  DEFERRED_CATALOG_MAX_BYTES,
  planDeferral,
  renderDeferredCatalog,
  searchDeferredTools,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_SEARCH_NAME,
  wireSchemaBytes,
  type DeferralConfig,
  type DeferralPlan,
} from './deferral.ts'
export { jsonSchemaToTs, renderToolsSdk } from './ts-types.ts'
export { jsonSchemaToPy, renderToolsSdkPy } from './py-types.ts'
export { defineContentToolFixture, type ContentToolFixtureOptions } from './testing.ts'

// The render-intent vocabulary a tool declares via `presentCall`/`presentResult`
// lives in its own UI-facing module; re-export it so `io-agent/tools`
// stays the single public API for tool producers and UI adapters.
export type {
  ToolCallKind,
  FileLocation,
  FileDiff,
  ReadFileLine,
  FileView,
  ToolCallView,
  GenericCallView,
  TerminalCallView,
  DiffCallView,
  ToolResultView,
  GenericResultView,
  TerminalResultView,
  DiffResultView,
  SearchResultView,
  SearchMatchesResultView,
  SearchPathsResultView,
  SearchFileMatches,
  SearchLineMatch,
  ReadResultView,
  WebResultView,
  WebSearchResultView,
  WebFetchResultView,
  WebSource,
} from './presentation.ts'

declare module "../runtime/vendor/cordis/index.ts" {
  interface Context {
    tools: ToolRuntime
  }

  interface Events {
    /**
     * Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow;
     * `cancel` selects the canonical pre-dispatch cancellation result, and missing
     * approval support turns `ask` into denial. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * Scope-filtered dispatch (`io-agent/scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns
     * a normalized result; wrappers may change only `exec.signal`, while call
     * identity remains immutable. The registry re-fuses the original caller
     * signal before the body, so replacement cannot detach caller cancellation;
     * wrappers must still restore their signal and reach quiescence.
     * Scope-filtered dispatch (`io-agent/scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
     * @mode waterfall
     */
    'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * Accept, replace, enrich, or block a normalized dispatch result. `next()`
     * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
     * listeners must observe `exec.signal`; after they settle, caller
     * cancellation replaces only a successful accepted outcome with the code
     * selected by whether the tool body was invoked.
     * Scope-filtered dispatch (`io-agent/scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /**
     * Allow a listener to replace content in the DURABLE LOG COPY of one
     * `run_code` sub-dispatch outcome before the bridge appends its
     * `tool/ptc-dispatch` event. `next()` keeps the
     * content unchanged; a listener may return replacement blocks (e.g. the
     * spill policy's preview + locator for an oversized text result). Only the
     * logged copy is affected — the program already received the complete
     * value, and the model sees neither. A throwing listener is contained:
     * the bridge falls back to logging the original settled content.
     * Scope-filtered dispatch (`io-agent/scope`): agent-scoped listeners receive only that agent's dispatches.
     * @param dispatch - the parent execution, sub-call identity, and the settled content to log.
     * @mode waterfall
     */
    'tools/ptc-dispatch-log'(this: Scoped<ToolRuntime>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
    /**
     * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
     * Scope-filtered dispatch (`io-agent/scope`): keyed by `exec.agent`.
     * @param exec - the execution object that traversed the pipeline.
     * @param result - a deep-frozen snapshot of the final returned result.
     * @mode emit
     */
    'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
    /**
     * A model step's tool batch was committed: every result is appended to the
     * journal in model order, none has been sent to the model yet, and the step
     * has not ended. Dispatched once per non-empty batch, never after the step
     * was cancelled. Listeners run one after another; a listener that throws is
     * logged and the remaining listeners still run, so a batch-level policy can
     * never fail a completed step. A listener that rewrites results must do so
     * with durable surface replacements and must stop when `batch.signal` aborts.
     * Scope-filtered dispatch (`io-agent/scope`): keyed by `batch.agent`.
     * @param batch - the agent, turn, step, committed results and step signal.
     * @mode serial
     */
    'tools/batch-committed'(this: Scoped<ToolRuntime>, batch: ToolBatchCommit): Promise<void>
    /**
     * A tool was registered or unregistered, or a scoped restriction changed
     * (the available tool set changed — possibly for one scope only). An
     * UNFILTERED registry-subject notification, deliberately not scope-filtered
     * dispatch: a global change concerns every agent's next assembly, so a
     * scoped listener subscribing here sees every change, not just its own
     * scope's.
     * @mode emit
     */
    'tools/change'(): void
  }
}

export * from './contracts.ts'
import { TOOL_RUNTIME_SCHEDULER } from './contracts.ts'
import type { ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionResult, ToolRuntimeScheduler,
  ToolExecutionMode, PtcDispatchLog, PreToolDecision, PostToolDecision, ToolDispatchExecution, ToolBatchCommit } from './contracts.ts'
import { errorMessage } from './outcome.ts'
import { ToolInvocation } from './invocation.ts'
import { bindTool, type ToolBinding, type ToolRegistration } from './binding.ts'

/** How the registry presents its tools to the model (see {@link Config.mode}). */
export type ToolPresentationMode = 'native' | 'ptc' | 'both'

/** Plugin config: how the registered tools are presented to the model. */
export interface Config {
  /**
   * Model presentation. `native` (default) sends every visible schema; `ptc`
   * sends only `run_code` plus a generated SDK prompt and collapses the
   * executor to the same surface (a model-direct call may only name
   * `run_code`; `run_code` SDK sub-dispatches keep every visible tool); `both`
   * sends both forms. PTC mode requires a `ctx.ptcRuntime` whose `language`
   * has a registered SDK renderer (TypeScript or Python) and fail prompt
   * assembly when it is absent or has no renderer. Under `ptc`, native names
   * in `toolOrder` are invalid.
   */
  mode?: ToolPresentationMode
  /**
   * Concurrency cap for a `run_code` program's overlapping sub-calls
   * (default 10, the loop scheduler's own default). Sub-calls follow the
   * native scheduling contract — only calls whose tools classify
   * concurrency-safe overlap; exclusive calls form barriers — so `1`
   * restores strictly serial dispatch. Must be a positive integer.
   */
  maxParallelSubCalls?: number
  /**
   * On-demand presentation of definitions marked with `deferral` (MCP tools).
   * `false` (default) presents every visible schema. With thresholds, a
   * native-mode scope whose marked tools number more than `maxEagerTools` or
   * weigh more than `maxEagerSchemaBytes` of wire schema presents the fixed
   * `tool_search` / `tool_describe` / `tool_call` bridges instead of their
   * schemas, plus a bounded catalog in the runtime context. Once presented in
   * a session, the bridges stay (read from its logged request header), so the
   * tool list does not flap. Unmarked (core) tools always stay eager.
   */
  deferral?: false | DeferralConfig
}

/**
 * Per-scope filter over global tools. Restrictions intersect and do not affect
 * scoped registrations or the reserved PTC mode transport.
 */
export interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}

/** One restriction compiled at registration for repeated live-global lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One scope's complete registry view, derived in a single layer traversal. */
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and transport insertion. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  readonly registrations: ReadonlyMap<string, ToolRegistration>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

/** One scope's complete tool-registry contribution. */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolRegistration>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  readonly guards = new AnonymousEntries<ToolGuard>()
  /**
   * Presentation this scope's agent declared for itself, shadowing the
   * deployment default. One cell rather than an entry table: two answers to
   * "which form does the model see" is a contradiction, not a merge.
   */
  mode: ToolPresentationMode | undefined

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty()
      && this.mode === undefined
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

  /** First monotonic denial from this layer's live guard registrations. */
  guardReason(exec: ToolExecution): string | undefined {
    for (const guard of this.guards.values()) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value: number | undefined): number {
  const maxParallelSubCalls = value ?? 10
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) {
    throw new Error(modelText('foundation/tools-index/text-04'))
  }
  return maxParallelSubCalls
}

/**
 * Tool registry and execution pipeline. Scoped registrations shadow globals;
 * one visibility resolver feeds presentation, lookup, and dispatch.
 */
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'ptc', 'both'] as const).default('native'),
    maxParallelSubCalls: z.natural().min(1).default(10),
    deferral: z.union([z.const(false), z.object({
      maxEagerTools: z.natural().required(),
      maxEagerSchemaBytes: z.natural().required(),
    })]).default(false),
  })
  private readonly invocation = new ToolInvocation(this.ctx, {
    get: (name, scope) => this.get(name, scope),
    carrier: scope => scopeTarget(this, scope),
    capture: (name, scope) => {
      const entry = this.view(scope).registrations.get(name)
      return entry === undefined ? undefined : bindTool(entry)
    },
    current: (binding, exec) => this.bindingCurrent(binding, exec),
    resolveExecution: (name, scope, nested) => this.resolveExecution(name, scope, nested),
    collapses: (name, scope, nested) => this.collapses(name, scope, nested),
    guardReason: exec => this.guardReason(exec),
  })
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = this.invocation.scheduler

  private bindingCurrent(binding: ToolBinding, exec: ToolExecution): boolean {
    return !this.collapses(exec.name, exec.agent, exec.parent !== undefined)
      && this.view(exec.agent).registrations.get(exec.name)?.token === binding.token
  }

  private readonly layers = new ScopedLayers(
    scope => new ToolLayer(scope),
    () => { this.ctx.emit('tools/change') },
  )
  /** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
  private readonly defaultMode: ToolPresentationMode
  private readonly maxParallelSubCalls: number
  /**
   * Reserved presentation transport, kept outside the filterable registration
   * layers. Built on first need rather than at construction: which agents run
   * a PTC mode is no longer known when the service is constructed, and the
   * transport is stateless beyond its closures over `this`.
   */
  private ptcTransport: ToolDefinition | undefined
  private ptcRegistration: ToolRegistration | undefined
  /** Deferral thresholds; undefined keeps every visible schema eager. */
  private readonly deferralConfig: DeferralConfig | undefined
  /**
   * Reserved deferral bridges, kept outside the filterable layers like
   * `run_code` and built on first need. Stateless beyond their closures.
   */
  private deferralRegistrations: ReadonlyMap<string, ToolRegistration> | undefined

  private requireDeferralRegistrations(): ReadonlyMap<string, ToolRegistration> {
    this.deferralRegistrations ??= new Map(createDeferralBridges({
      deferral: agent => this.deferral(agent, agent),
      get: (name, agent) => this.get(name, agent),
      execute: input => this.execute(input),
    }).map(definition => [definition.name, { token: Symbol(definition.name), definition }]))
    return this.deferralRegistrations
  }

  private requirePtcRegistration(): ToolRegistration {
    return this.ptcRegistration ??= { token: Symbol(RUN_CODE_NAME), definition: this.requirePtcTransport() }
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // The schema already defaulted an omitted mode; the ?? narrows the
    // optional-input type for direct (non-Loader) construction in tests.
    this.defaultMode = config.mode ?? 'native'
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
    this.deferralConfig = resolveDeferralConfig(config.deferral)
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope, context.agent))
    if (this.defaultMode !== 'native') {
      ctx.systemPrompt.section(this.collapseSection())
      ctx.systemPrompt.section(this.sdkSection())
    }
    if (this.deferralConfig !== undefined) {
      // The SAME plan as the wire tool list, so the catalog and the schemas cannot drift.
      // Runtime context, not the system prompt: a catalog change appends a snapshot and never rewrites the prefix.
      ctx.systemPrompt.context({
        name: 'tools:deferred',
        order: ctx.systemPrompt.getContextOrder('DEFERRED_TOOLS'),
        text: (context) => {
          const plan = this.deferral(context.scope, context.agent)
          return plan.presented ? renderDeferredCatalog(plan.deferred) : ''
        },
      })
    }
  }

  /**
   * The deferral decision for one scope: which visible marked tools the model
   * reaches through the bridges. Presented only under a configured deferral, a
   * native presentation, and a count or schema-byte threshold crossed now or
   * already presented in this session's last logged request header.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param agent - the agent whose session latches a presentation, when any.
   * @returns the plan, never presented when deferral is off or the scope is not native.
   */
  deferral(scope?: ScopeKey, agent?: Agent): DeferralPlan {
    const view = this.view(scope)
    const candidates = [...view.visible.values()].filter(definition => !this.isBridgeEntry(view, definition.name))
    if (this.deferralConfig === undefined || this.modeFor(scope) !== 'native') {
      return { ...planDeferral(candidates, { maxEagerTools: Number.MAX_SAFE_INTEGER, maxEagerSchemaBytes: Number.MAX_SAFE_INTEGER }, false), presented: false }
    }
    const latched = agent?.session.requestHeader()?.tools?.some(tool => tool.name === TOOL_SEARCH_NAME) === true
    return planDeferral(candidates, this.deferralConfig, latched)
  }

  /** Whether a view's entry under this name is a reserved bridge rather than a registration. */
  private isBridgeEntry(view: ToolView, name: string): boolean {
    const bridge = this.deferralRegistrations?.get(name)
    return bridge !== undefined && view.registrations.get(name) === bridge
  }

  /**
   * The prompt statement of the `ptc` executor collapse, registered wherever
   * {@link sdkSection} is and rendering empty outside an effective `ptc`.
   *
   * Every tool contributes its own guidance section naming its tool, none of
   * them qualify how that tool is reached, and they all render before the SDK.
   * Without this the model reads a catalog of tools it is told to use and no
   * statement that only `run_code` may be called, so it emits a native call,
   * receives `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes
   * the deployment is inconsistent. Its order places the rule before that
   * guidance rather than after it.
   *
   * `both` renders empty: native calls do execute there, so the rule is false.
   * @returns the section registration.
   */
  private collapseSection(): PromptSection {
    return {
      name: 'tools:ptc-only',
      order: this.ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
      // The SAME predicate the executor denies by, so the prompt cannot state
      // a rule the registry does not enforce (see `collapses`).
      text: context => this.modeFor(context.scope) === 'ptc' ? PTC_ONLY_INSTRUCTION : '',
    }
  }

  /**
   * The generated-SDK prompt section, registered globally by a PTC mode
   * deployment and per scope by {@link presentAs}.
   *
   * The body regenerates from the CALLING scope, and renders empty for an
   * agent presenting natively — an agent that opted out under a PTC mode
   * deployment still sees the global registration, and an empty section is
   * dropped from the rendered prompt.
   * @returns the section registration.
   */
  private sdkSection(): PromptSection {
    return {
      name: 'tools:sdk',
      order: this.ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      interpolate: false,
      // Regenerate from the calling scope's visible tools in stable order.
      text: (context) => {
        const mode = this.modeFor(context.scope)
        if (mode === 'native') return ''
        const runtime = this.requirePtcRuntime(mode)
        // Own-property read: a language like `toString`/`constructor` would
        // otherwise resolve an inherited Object.prototype member as a renderer.
        const render = SDK_RENDERERS[runtime.language]
        /* v8 ignore next -- requirePtcRuntime rejects an unknown language before this runs. */
        if (render === undefined) throw new Error(modelText('foundation/tools-index/text-05', { value_1: String(runtime.language) }))
        return render(this.sdkSchemas(context.scope))
      },
    }
  }

  /**
   * The presentation one scope's agent sees: its own declaration, else the
   * deployment default.
   * @param scope - the calling agent, or undefined for the global view.
   * @returns the resolved presentation mode.
   */
  private modeFor(scope?: ScopeKey): ToolPresentationMode {
    // Nearest scope wins along the chain: a preset's standing declaration
    // covers every agent parented under it, and an agent's own (were one ever
    // declared) would override its preset's. The mode decides what the model
    // SEES, which is exactly the class of fact the chain inherits.
    const layers = this.layers.chainLayers(scope)
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const mode = layers[index]?.mode
      if (mode !== undefined) return mode
    }
    return this.defaultMode
  }

  /**
   * The reserved `run_code` transport, built on first need.
   *
   * It never enters the global layer: per-agent restrictions must not remove
   * it, and a scoped registration must not shadow it. The visibility resolver
   * appends it after resolving the filterable global/scoped capability layers,
   * and only for scopes whose mode actually presents it.
   * @returns the shared transport definition.
   */
  private requirePtcTransport(): ToolDefinition {
    this.ptcTransport ??= createRunCodeTool(this, {
      requireRuntime: () => this.requirePtcRuntime(this.defaultMode),
      peekApprover: () => this.ctx.get('approval'),
      resolveSandboxPolicy: (exec) => {
        const policy = this.ctx.get('sandboxPolicy')
        if (policy === undefined) throw new Error(modelText('foundation/tools-index/text-06'))
        return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      },
      // The language-aware description/parameters getters read the runtime
      // without demanding one, so a native-default process can still project
      // the transport for an agent that chose code.
      peekRuntime: () => this.ctx.get('ptcRuntime'),
      maxParallel: this.maxParallelSubCalls,
      shapeDispatchLog: dispatch => this.shapeDispatchLog(dispatch),
    })
    return this.ptcTransport
  }

  /**
   * Present the calling scope's tools in `mode` instead of the deployment
   * default. Nearest scope on the chain wins, so a preset's standing
   * declaration covers every agent joined under it.
   *
   * Scoped only, and one declaration per scope: this is how an agent preset
   * composes PTC mode agents beside native ones in the same process, and a
   * process-global override would be the `mode` config field instead.
   * @param mode - the presentation the covered agents' models see.
   * @returns the exact disposer that restores the deployment default.
   */
  presentAs(mode: ToolPresentationMode): () => void {
    const ctx = this.ctx
    if (scopeOf(ctx) === undefined) {
      throw new Error(modelText('foundation/tools-index/text-07'))
    }
    const dispose = ctx.effect(function* (this: ToolRuntime) {
      yield this.layers.effect(
        ctx,
        (layer) => {
          if (layer.mode !== undefined) {
            throw new Error(modelText('foundation/tools-index/text-08', { value_1: String(mode), value_2: String(layer.mode) }))
          }
          layer.mode = mode
          return () => { layer.mode = undefined }
        },
        { label: 'tools.presentAs()' },
      )
      // The SDK and collapse sections are per scope for the same reason the
      // mode is. Under a deployment that already defaults to PTC mode this
      // shadows the global registration with an identical body, which costs
      // nothing and keeps one rule instead of a case analysis.
      if (mode !== 'native') {
        yield ctx.systemPrompt.section(this.collapseSection())
        yield ctx.systemPrompt.section(this.sdkSection())
      }
    }.bind(this), 'tools.presentAs()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous composite teardown
    return dispose
  }

  /**
   * Build one scope's wire schemas and names for prompt-order validation.
   * Restrictions do not make known tools invalid, but a mode collapse does.
   */
  private wireSchemas(scope?: ScopeKey, agent?: Agent): ToolProviderResult {
    const view = this.view(scope)
    const mode = this.modeFor(scope)
    if (mode === 'native') {
      const plan = this.deferralConfig === undefined ? undefined : this.deferral(scope, agent)
      if (plan?.presented === true) {
        // Deferred schemas leave the wire; the fixed bridges stand in for them.
        const deferred = new Set(plan.deferred.map(definition => definition.name))
        const schemas = [...view.visible.values()]
          .filter(definition => !deferred.has(definition.name))
          .map(definition => this.schemaOf(definition, false))
        return { schemas, knownNames: [...view.knownNames, ...DEFERRAL_BRIDGE_NAMES] }
      }
      // Below the threshold the list is byte-identical to a registry without deferral.
      const schemas = [...view.visible.values()]
        .filter(definition => !this.isBridgeEntry(view, definition.name))
        .map(definition => this.schemaOf(definition, false))
      return { schemas, knownNames: [...view.knownNames] }
    }
    // Validate the runtime language BEFORE projecting schemas: schemaOf reads
    // run_code's language-aware description/parameters getters, whose own
    // flavor-table guard would otherwise surface first. This keeps the
    // renderer-table rejection the canonical assembly-time error for a
    // language with no SDK renderer.
    this.requirePtcRuntime(mode)
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    if (mode === 'ptc') {
      return {
        schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
        knownNames: [RUN_CODE_NAME],
      }
    }
    return { schemas, knownNames: [...view.knownNames, RUN_CODE_NAME] }
  }

  /**
   * Resolve the PTC runtime or throw the actionable misconfiguration error.
   * Read at use time (assembly / run_code execution), NOT via static
   * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
   * behind it — hostage to a PTC runtime existing even under `mode:
   * 'native'`.
   *
   * Assembly and `run_code` execution read separately, so the language is not
   * bound to a request. Harmless while one published backend exists — both
   * reads return the same flavor — but a reload that swapped in a second
   * language between them would hand a program written against one SDK to the
   * other. Binding it is deferred until a second backend ships (the first
   * point it is testable).
   */
  private requirePtcRuntime(mode: ToolPresentationMode): PtcRuntime {
    const runtime = this.ctx.get('ptcRuntime')
    if (!runtime) {
      throw new Error(modelText('foundation/tools-index/text-09', { value_1: String(mode) }))
    }
    if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
      const known = Object.keys(SDK_RENDERERS).map(name => JSON.stringify(name)).join(', ')
      throw new Error(modelText('foundation/tools-index/text-10', { value_1: String(JSON.stringify(runtime.language)), value_2: String(known) }))
    }
    return runtime
  }

  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(modelText('foundation/tools-index/text-11', { value_1: String(name) }))
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(modelText('foundation/tools-index/text-12', { value_1: String(name) }))
    }
    // Reserved unconditionally: any agent may select a code mode for itself,
    // so a name free to take under the deployment default would become a
    // collision the moment a preset mounted.
    if (name === RUN_CODE_NAME) {
      throw new Error(modelText('foundation/tools-index/text-13', { value_1: String(RUN_CODE_NAME) }))
    }
    if (this.deferralConfig !== undefined && isDeferralBridge(name)) {
      throw new Error(contextText('tools/deferred/reserved-name', { name }))
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, { definition, token: Symbol(name) }),
      { label: 'tools.register()' },
    )
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error(modelText('foundation/tools-index/text-14'))
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error(modelText('foundation/tools-index/text-15'))
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(modelText('foundation/tools-index/text-16', { value_1: String(RUN_CODE_NAME) }))
    }
    const view = this.view(scope)
    const bridge = [...allow ?? [], ...deny ?? []].find(name => this.isBridgeEntry(view, name))
    if (bridge !== undefined) {
      // Fail closed, like run_code: a bridge this scope presents is presentation,
      // not a capability to grant. Where no bridge exists the name is simply unknown.
      throw new Error(contextText('tools/deferred/restrict-bridge', { name: bridge }))
    }
    const known = view.restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(modelText('foundation/tools-index/text-17', { value_1: String(unknown.length > 1 ? 's' : ''), value_2: String(unknown.map(n => `"${n}"`).join(', ')), value_3: String([...known].sort().join(', ') || '(none)') }))
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.guards.append(guard),
      { label: 'tools.guard()', notify: false },
    )
  }

  /** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
  private guardReason(exec: ToolExecution): string | undefined {
    const globalReason = this.layers.global.guardReason(exec)
    if (globalReason !== undefined) return globalReason
    if (exec.agent === undefined) return undefined
    for (const layer of this.layers.chainLayers(exec.agent)) {
      const reason = layer.guardReason(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  /**
   * Resolve every registry fact one scope needs in one layer traversal. The
   * visible map applies restrictions to the INHERITED surface, then the
   * scope's own registrations and the reserved presentation transport; the
   * other sets retain the pre-restriction facts needed by restriction and
   * prompt-order validation.
   *
   * A restriction filters what a scope inherits — the global layer and every
   * ancestor layer on its chain — and never what its OWN layer registers.
   * That exemption is what a per-child capability filter has to keep intact:
   * the delegation runtime registers a child's structured-output tool into the
   * child's own layer, and a filter naming the capabilities the child may use
   * must not strip the machinery it answers through.
   *
   * Reading the exempt set as "the global layer" instead of "not mine" held
   * only while every model-facing tool sat in the host composition. Once
   * presets moved them onto the agent plane they became an ANCESTOR
   * contribution, so a child's filter silently stopped constraining anything
   * it was given.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    // Scope-chain layers, farthest ancestor first, the exact scope last.
    const layers = this.layers.chainLayers(scope)
    // Chain-blind on purpose: this is the ONE layer whose registrations the
    // scope owns rather than inherits, and it is absent until the scope
    // contributes something.
    const own = this.layers.peek(scope)
    // Inherited surface, nearest ancestor last: a nearer scope's same-name
    // entry shadows a farther one, and the global layer is the farthest.
    const inherited = new Map<string, ToolRegistration>(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
    }
    const registrations = new Map<string, ToolRegistration>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, definition] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      // Restrictions intersect across the whole chain: any scope on it may
      // mask an inherited name for everything nested inside it.
      if (layers.every(layer => layer.admits(name))) registrations.set(name, definition)
    }
    // The scope's own registrations last, shadowing an inherited name and
    // outside the filter above.
    if (own !== undefined) {
      for (const [name, definition] of own.tools.entries()) {
        knownNames.add(name)
        registrations.set(name, definition)
      }
    }
    // Presentation infrastructure is resolved last and outside capability
    // filtering. Registration rejects this reserved name, so the insertion is
    // an invariant assertion as well as protection against future layer
    // changes. Per scope: a native agent must not find `run_code` in its
    // dispatch table because some other agent in the process presents it.
    if (this.modeFor(scope) !== 'native') {
      registrations.set(RUN_CODE_NAME, this.requirePtcRegistration())
    } else if (this.deferralConfig !== undefined
      && [...registrations.values()].some(entry => entry.definition.deferral !== undefined)) {
      // The bridges are dispatchable wherever a marked tool is visible; `wireSchemas`
      // presents them only above the threshold. Inserted after restriction filtering,
      // so restrictions apply to the underlying tools and never strip the bridges.
      for (const [name, entry] of this.requireDeferralRegistrations()) registrations.set(name, entry)
    }
    return { visible: new Map([...registrations].map(([name, entry]) => [name, entry.definition])), registrations, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.view(scope).visible.get(name)
  }

  /**
   * Resolve the definition that MAY EXECUTE for a call, applying the mode
   * collapse at the operation boundary that owns it. The registry view
   * (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `ptc`
   * may only name the reserved `run_code` transport, while a nested
   * sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
   * it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
   * through the executor, matching an absent definition.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
   * @returns the definition that may run, or undefined when the call must be rejected.
   */
  private resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined {
    const tool = this.get(name, scope)
    if (tool === undefined) return undefined
    if (this.collapses(name, scope, nested)) return undefined
    return tool
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
  }

  /** Project visible callable tools onto the generated PTC mode SDK contract. */
  private sdkSchemas(scope?: ScopeKey): ToolSdkSchema[] {
    return [...this.view(scope).visible.values()]
      .filter(definition => definition.name !== RUN_CODE_NAME)
      .map((definition): ToolSdkSchema => {
        const output = snapshotJsonValue(definition.output.schema)
        /* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
        if (output === undefined) {
          throw new Error(modelText('foundation/tools-index/text-18', { value_1: String(definition.name) }))
        }
        return {
          ...this.schemaOf(definition, true),
          output,
        }
      })
  }

  /** Project one definition onto the model-facing schema fields. */
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters } = definition
    const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
    if (detached === undefined) {
      throw new Error(modelText('foundation/tools-index/text-19', { value_1: String(name) }))
    }
    return {
      name,
      description,
      parameters: detached,
    }
  }

  /**
   * Classify a pending call through the caller's visible tool definition. Only
   * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
   * throwing classifiers are exclusive.
   * @param exec - call name, parsed arguments, and optional agent scope.
   * @returns the fail-closed scheduling mode.
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
    try {
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
  }

  /**
   * Run the `tools/ptc-dispatch-log` waterfall over one settled sub-dispatch
   * and return the content the bridge should log on `tool/ptc-dispatch`.
   * Contained: when a listener throws, the method logs the original settled
   * content; that failure must not fail the dispatch or omit the settle event. Private:
   * the ONE consumer is the `run_code` bridge this registry constructs, which
   * receives it as a capability parameter (the `requireRuntime` idiom) — the
   * waterfall, not this invoker, is the public extension point.
   */
  private async shapeDispatchLog(dispatch: PtcDispatchLog): Promise<ContentBlock[]> {
    try {
      return await this.ctx.waterfall(
        scopeTarget(this, dispatch.agent), 'tools/ptc-dispatch-log', dispatch,
        () => Promise.resolve(dispatch.content),
      )
    } catch (error: unknown) {
      this.ctx.logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`)
      return dispatch.content
    }
  }

  /**
   * Whether the `ptc` mode collapse denies a model-direct call: only the
   * reserved `run_code` transport may be named. Nested sub-dispatches (a
   * `parent` token set) bypass the collapse. One home for the
   * security-relevant predicate, shared by {@link resolveExecution} and
   * {@link createExecution} so the two can never drift apart.
   *
   * Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `ptc`
   * by an agent preset under a native deployment is the composition
   * `dsh-agent-tool-presentation` exists for, and reading the deployment default would
   * leave exactly that agent uncollapsed — announcing one surface while
   * executing another, which is the bypass this collapse closes.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope whose effective presentation mode applies.
   * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
   */
  private collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean {
    return !nested && this.modeFor(scope) === 'ptc' && name !== RUN_CODE_NAME
  }
  /** All transports enter the same invocation pipeline. */
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    return this.invocation.execute(exec)
  }

}

export default ToolRuntime
