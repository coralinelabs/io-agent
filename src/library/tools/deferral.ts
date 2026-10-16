/**
 * MCP tool-schema deferral.
 *
 * Definitions marked with {@link ToolDefinition.deferral} (MCP tools) may be
 * presented on demand. When a scope's marked tools exceed a count or
 * schema-byte threshold, their schemas leave the wire tool list and three
 * fixed bridges take their place: `tool_search`, `tool_describe` and
 * `tool_call`. The bridges' wording is static, so the tool list stays
 * byte-identical while MCP servers connect, reconnect or change their tools;
 * the bounded catalog of on-demand names travels in the runtime context.
 *
 * `tool_call` is a composite: it dispatches the underlying tool through the
 * registry's normal `execute` with `parent` set, so pre-execute policy,
 * approval, guards, timeouts and post-execute run under the underlying
 * tool's name, exactly as for an eagerly presented call. Observers of
 * model-issued calls that skip nested dispatches (the repeat-call reminder,
 * checkpoint flushing) see the outer `tool_call` instead, as for any composite.
 *
 * @module io-agent/tools/deferral
 */

import { modelText } from "../context/text/index.ts"
import { canonicalJson } from "../context/stable-schema.ts"
import { HarnessError } from "../model/llm/index.ts"
import type { ContentBlock, ToolCallId } from "../model/llm/index.ts"
import type { Agent } from "../runtime/agents/index.ts"
import { brandString } from "../util/brand/index.ts"
import type { JsonValue } from "../util/values/index.ts"
import { defineTool } from './schema.ts'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult, ToolFailure } from './contracts.ts'

export const TOOL_SEARCH_NAME = 'tool_search'
export const TOOL_DESCRIBE_NAME = 'tool_describe'
export const TOOL_CALL_NAME = 'tool_call'
/** The reserved bridge names, in presentation order. */
export const DEFERRAL_BRIDGE_NAMES: readonly string[] = Object.freeze([TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME])

/** Byte cap of the on-demand catalog in the runtime context. */
export const DEFERRED_CATALOG_MAX_BYTES = 4096
/** Matches `tool_search` returns without a `limit`. */
export const TOOL_SEARCH_DEFAULT_LIMIT = 8
/** Largest accepted `tool_search` limit. */
export const TOOL_SEARCH_MAX_LIMIT = 25
/** Maximum UTF-8 bytes in one discovery summary; full schemas remain available through describe. */
export const TOOL_SEARCH_MAX_BYTES = 8192
/** Most names one `tool_describe` call accepts. */
export const TOOL_DESCRIBE_MAX_NAMES = 10
/** Code points of each description in a `tool_search` listing. */
const SEARCH_DESCRIPTION_POINTS = 160

/** When marked tools are deferred: above either threshold (strictly), or once presented for this session. */
export interface DeferralConfig {
  /** Most marked tools a scope presents eagerly; `0` always defers when any exist. */
  readonly maxEagerTools: number
  /** Most wire-schema bytes of marked tools a scope presents eagerly. */
  readonly maxEagerSchemaBytes: number
}

/** One scope's deferral decision, computed from its visible definitions. */
export interface DeferralPlan {
  /** Whether the bridges replace the marked schemas on the wire. */
  readonly presented: boolean
  /** Visible marked definitions, sorted by name (deferred only when {@link presented}). */
  readonly deferred: readonly ToolDefinition[]
  /** Visible unmarked definitions (never deferred). */
  readonly eager: readonly ToolDefinition[]
  /** Wire-schema bytes of the marked definitions. */
  readonly schemaBytes: number
}

/**
 * Validate a deferral configuration at the owning boundary.
 * @param value - `false`/omitted (disabled) or the thresholds.
 * @returns the thresholds, or `undefined` when deferral is disabled.
 */
export function resolveDeferralConfig(value: false | DeferralConfig | undefined): DeferralConfig | undefined {
  if (value === undefined || value === false) return undefined
  for (const key of ['maxEagerTools', 'maxEagerSchemaBytes'] as const) {
    const limit = value[key]
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError(`tool deferral ${key} must be a non-negative safe integer`)
  }
  return { maxEagerTools: value.maxEagerTools, maxEagerSchemaBytes: value.maxEagerSchemaBytes }
}

/** Whether a definition is one of the reserved bridges. */
export function isDeferralBridge(name: string): boolean {
  return DEFERRAL_BRIDGE_NAMES.includes(name)
}

/** Bytes one definition would occupy in the wire tool list. */
export function wireSchemaBytes(definition: ToolDefinition): number {
  const { name, description, parameters } = definition
  return Buffer.byteLength(JSON.stringify({ name, description, parameters }))
}

/**
 * Decide whether a scope's marked tools are deferred.
 * @param visible - the scope's visible definitions (bridges excluded).
 * @param config - thresholds.
 * @param latched - whether this session's last request already presented the bridges.
 * @returns the plan; the latch keeps the tool list fixed when the count later drops.
 */
export function planDeferral(visible: Iterable<ToolDefinition>, config: DeferralConfig, latched: boolean): DeferralPlan {
  const deferred: ToolDefinition[] = []
  const eager: ToolDefinition[] = []
  let schemaBytes = 0
  for (const definition of visible) {
    if (isDeferralBridge(definition.name)) continue
    if (definition.deferral === undefined) { eager.push(definition); continue }
    deferred.push(definition)
    schemaBytes += wireSchemaBytes(definition)
  }
  deferred.sort((a, b) => compareNames(a.name, b.name))
  const presented = deferred.length > 0
    && (deferred.length > config.maxEagerTools || schemaBytes > config.maxEagerSchemaBytes || latched)
  return { presented, deferred, eager, schemaBytes }
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The source label of a marked definition; braces never reach interpolated context. */
function sourceOf(definition: ToolDefinition): string {
  return (definition.deferral?.source ?? '').replace(/[{}]/gu, '')
}

/** Group marked definitions by source, sources and names sorted. */
function bySource(deferred: readonly ToolDefinition[]): [string, string[]][] {
  const groups = new Map<string, string[]>()
  for (const definition of deferred) {
    const source = sourceOf(definition)
    groups.set(source, [...groups.get(source) ?? [], definition.name])
  }
  return [...groups.entries()]
    .map(([source, names]): [string, string[]] => [source, names.sort(compareNames)])
    .sort((a, b) => compareNames(a[0], b[0]))
}

/**
 * Render the runtime-context catalog of on-demand tools within a byte budget.
 * Each source lists its full tool names; when the whole catalog is over budget,
 * the longest source lines degrade to a count first, and trailing sources are
 * dropped only if even the counts do not fit.
 * @param deferred - the deferred definitions.
 * @param maxBytes - UTF-8 byte budget.
 * @returns the catalog text, or '' when nothing is deferred.
 */
export function renderDeferredCatalog(deferred: readonly ToolDefinition[], maxBytes = DEFERRED_CATALOG_MAX_BYTES): string {
  if (deferred.length === 0) return ''
  const groups = bySource(deferred)
  const full = groups.map(([source, names]) => modelText('tools/deferred/catalog-source', { source, count: names.length, names: names.join(', ') }))
  const summary = groups.map(([source, names]) => modelText('tools/deferred/catalog-summary', { source, count: names.length }))
  const lines = [...full]
  const intro = modelText('tools/deferred/catalog-intro')
  const size = (): number => Buffer.byteLength([intro, ...lines].join('\n'))
  while (size() > maxBytes) {
    let longest = -1
    for (let index = 0; index < lines.length; index++) {
      if (lines[index] !== summary[index] && (longest < 0 || lines[index]!.length > lines[longest]!.length)) longest = index
    }
    if (longest < 0) break
    lines[longest] = summary[longest]!
  }
  while (lines.length > 1 && size() > maxBytes) lines.pop()
  return [intro, ...lines].join('\n')
}

/** Lower-case alphanumeric tokens. */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0)
}

/** The tool's own name without its `mcp__<source>__` namespace. */
function rawName(definition: ToolDefinition): string {
  const prefix = `mcp__${definition.deferral?.source ?? ''}__`
  return definition.name.startsWith(prefix) ? definition.name.slice(prefix.length) : definition.name
}

function schemaRecord(definition: ToolDefinition): { properties: string[]; required: string[] } {
  const parameters = definition.parameters as { properties?: unknown; required?: unknown }
  const properties = typeof parameters.properties === 'object' && parameters.properties !== null && !Array.isArray(parameters.properties)
    ? Object.keys(parameters.properties)
    : []
  const required = Array.isArray(parameters.required) ? parameters.required.filter((name): name is string => typeof name === 'string') : []
  return { properties, required }
}

/**
 * Deterministic keyword ranking over the deferred set. An exact tool name wins
 * outright. Otherwise each query token scores name tokens (3), partial name
 * matches (2), source tokens (2), and description or parameter-name tokens
 * (1). When some tools match every token, only those are returned; otherwise
 * partial matches are, so a vague query still lists candidates. Ties by name.
 * @param deferred - the deferred definitions.
 * @param query - the model's keywords.
 * @returns the matching definitions with their scores, best first.
 */
export function searchDeferredTools(deferred: readonly ToolDefinition[], query: string): { definition: ToolDefinition; score: number }[] {
  const exact = query.trim().toLowerCase()
  const wanted = [...new Set(tokens(query))]
  const scored: { definition: ToolDefinition; score: number; complete: boolean }[] = []
  for (const definition of deferred) {
    if (definition.name.toLowerCase() === exact) { scored.push({ definition, score: Number.MAX_SAFE_INTEGER, complete: true }); continue }
    const own = rawName(definition).toLowerCase()
    const nameTokens = new Set(tokens(own))
    const sourceTokens = new Set(tokens(sourceOf(definition)))
    const textTokens = new Set(tokens(`${definition.description} ${schemaRecord(definition).properties.join(' ')}`))
    let score = 0
    let matched = 0
    for (const token of wanted) {
      const before = score
      if (nameTokens.has(token)) score += 3
      else if (token.length >= 3 && own.includes(token)) score += 2
      if (sourceTokens.has(token)) score += 2
      if (textTokens.has(token)) score += 1
      if (score > before) matched += 1
    }
    if (score > 0) scored.push({ definition, score, complete: matched === wanted.length })
  }
  const complete = scored.filter(entry => entry.complete)
  return (complete.length > 0 ? complete : scored)
    .sort((a, b) => b.score - a.score || compareNames(a.definition.name, b.definition.name))
    .map(({ definition, score }) => ({ definition, score }))
}

function clip(text: string, points: number): string {
  const characters = Array.from(text.replace(/\s+/gu, ' ').trim())
  return characters.length <= points ? characters.join('') : characters.slice(0, points - 1).join('') + '…'
}

/** Whole required-field names, never a partial identifier; the full schema is not changed. */
function requiredPreview(required: readonly string[]): string {
  if (required.length === 0) return ''
  const names: string[] = []
  let bytes = 0
  for (const name of required) {
    const added = Buffer.byteLength(name) + (names.length > 0 ? 2 : 0)
    if (bytes + added > 384) break
    names.push(name)
    bytes += added
  }
  return names.length === required.length
    ? modelText('tools/tool-search/required', { names: names.join(', ') })
    : modelText('tools/tool-search/required-preview', { names: names.join(', '), count: required.length })
}

/** Bounded discovery, not a replacement for exact schema delivery by tool_describe. */
function searchSummary(matches: ReturnType<typeof searchDeferredTools>, limit: number, query: string): string {
  const lines = matches.slice(0, limit).map(({ definition }) => {
    const required = requiredPreview(schemaRecord(definition).required)
    return `- ${definition.name} (${clip(sourceOf(definition), 64)}): ${clip(definition.description, SEARCH_DESCRIPTION_POINTS)}`
      + (required === '' ? '' : ` [${required}]`)
  })
  const render = (): string => [
    modelText('tools/tool-search/result-header', { shown: lines.length, count: matches.length, query }),
    ...lines,
    modelText('tools/tool-search/next-step'),
  ].join('\n')
  // Discard complete trailing records, never split names, UTF-8 or schemas.
  // The header's shown count is recomputed after every removal.
  while (lines.length > 0 && Buffer.byteLength(render()) > TOOL_SEARCH_MAX_BYTES) lines.pop()
  return render()
}

/** What the bridges need from the registry that owns them. */
export interface DeferralHost {
  /** The calling scope's current plan. */
  deferral(agent: Agent | undefined): DeferralPlan
  /** The definition a scope resolves for a name. */
  get(name: string, agent: Agent | undefined): ToolDefinition | undefined
  /** The registry's single invocation pipeline. */
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult>
}

/** Re-raise a nested failure with its message and error identity intact. */
function nestedFailure(failure: ToolFailure): Error {
  if (failure.info === undefined) return new Error(failure.message)
  const error = new HarnessError(failure.message, failure.info.code)
  error.name = failure.info.name
  return error
}

/**
 * Build the three bridge definitions. They close over the host and are
 * inserted by the registry after restriction filtering, like `run_code`.
 * @param host - the owning registry's plan, lookup and execution.
 * @returns `tool_search`, `tool_describe` and `tool_call`.
 */
export function createDeferralBridges(host: DeferralHost): ToolDefinition[] {
  const search = defineTool({
    name: TOOL_SEARCH_NAME,
    description: modelText('tools/tool-search/description'),
    parameters: {
      query: { type: 'string', required: true, description: modelText('tools/tool-search/query') },
      limit: { type: 'integer', description: modelText('tools/tool-search/limit') },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const { deferred } = host.deferral(exec.agent)
      const limit = Math.min(TOOL_SEARCH_MAX_LIMIT, Math.max(1, args.limit ?? TOOL_SEARCH_DEFAULT_LIMIT))
      const matches = searchDeferredTools(deferred, args.query)
      const query = JSON.stringify(clip(args.query, 256))
      if (matches.length === 0) {
        const sources = bySource(deferred).map(([source, names]) => `${source} (${names.length})`).join(', ')
        return Promise.resolve(modelText('tools/tool-search/no-match', { query, sources: clip(sources, 512) || '-' }))
      }
      return Promise.resolve(searchSummary(matches, limit, query))
    },
  })

  const describe = defineTool({
    name: TOOL_DESCRIBE_NAME,
    description: modelText('tools/tool-describe/description'),
    parameters: {
      names: { type: 'array', items: { type: 'string' }, required: true, description: modelText('tools/tool-describe/names') },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const names = [...new Set(args.names.map(name => name.trim()).filter(name => name.length > 0))]
      if (names.length === 0 || names.length > TOOL_DESCRIBE_MAX_NAMES) {
        throw new HarnessError(modelText('tools/tool-describe/names-count'), 'DEFERRED_TOOL_INVALID_REQUEST')
      }
      const deferred = new Map(host.deferral(exec.agent).deferred.map(definition => [definition.name, definition]))
      const sections: string[] = []
      const missing: string[] = []
      for (const name of names) {
        const definition = deferred.get(name)
        if (definition === undefined) { missing.push(name); continue }
        // The exact wire bytes an eager presentation would have sent.
        const schema = JSON.stringify(canonicalJson(definition.parameters))
        sections.push(`### ${definition.name} (${sourceOf(definition)})\n${definition.description.trim()}\n`
          + modelText('tools/tool-describe/parameters', { schema }))
      }
      if (missing.length > 0) sections.push(modelText('tools/tool-describe/not-found', { names: missing.join(', ') }))
      if (missing.length < names.length) sections.push(modelText('tools/tool-describe/next-step'))
      return Promise.resolve(sections.join('\n\n'))
    },
  })

  const call = defineTool({
    name: TOOL_CALL_NAME,
    description: modelText('tools/tool-call/description'),
    parameters: {
      name: { type: 'string', required: true, description: modelText('tools/tool-call/name') },
      arguments: { type: 'object', additionalProperties: true, description: modelText('tools/tool-call/arguments') },
    },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array', required: true } }, additionalProperties: false },
      // The underlying tool's own content, verbatim (MCP images and attachment references included).
      render: (_args, value) => value.content as unknown as ContentBlock[],
    },
    // No concurrency classifier: a composite that may ask for approval runs exclusively.
    async execute(args, exec) {
      const plan = host.deferral(exec.agent)
      const target = plan.presented ? plan.deferred.find(definition => definition.name === args.name) : undefined
      if (target === undefined) {
        const visible = !isDeferralBridge(args.name) && host.get(args.name, exec.agent) !== undefined
        throw new HarnessError(
          modelText(visible ? 'tools/tool-call/not-deferred' : 'tools/tool-call/unknown', { name: args.name }),
          visible ? 'DEFERRED_TOOL_NOT_DEFERRED' : 'DEFERRED_TOOL_UNKNOWN',
        )
      }
      // Nested dispatch under the underlying name: policy, approval, guards,
      // timeout and post-execute all apply; the sub-call id stays unique per call.
      const result = await host.execute({
        callId: brandString<ToolCallId>(`${String(exec.callId)}:deferred`),
        rootCallId: exec.rootCallId,
        name: target.name,
        arguments: args.arguments ?? {},
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        parent: exec.token,
        signal: exec.signal,
      })
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      if (result.isError) throw nestedFailure(result.error)
      if (result.concludesTurn === true) exec.concludeTurn()
      return { content: result.content as unknown as JsonValue[] }
    },
  })
  return [search, describe, call]
}
