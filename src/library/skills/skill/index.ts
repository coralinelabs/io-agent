import { isDeepStrictEqual } from 'node:util'
import { validateSkillExecution, validateSkillToolConditions, type SkillExecutionPolicy, type SkillToolConditions } from '../execution-policy.ts'
export type { SkillExecutionPolicy, SkillToolConditions } from '../execution-policy.ts'
/**
 * Agent skill provider registry.
 *
 * This package owns the Service Definition role of the skill capability seam.
 * Concrete
 * providers such as `io-agent/skill-filesystem` decide where skills come
 * from; this service only merges provider catalogs, resolves the winning skill
 * for a name, and exposes the winning summaries and definitions to consumers.
 *
 * @module io-agent/skill
 */

import { createHash } from 'node:crypto'
import { modelText } from "../../context/text/index.ts"
import { Context, Service } from "../../runtime/vendor/cordis/index.ts"
import type {} from "../../model/llm/index.ts"
import { assertNever } from "../../util/values/index.ts"
import { NamedEntries, ScopedLayers, scopeChainOf, scopeOf } from "../../runtime/scope/index.ts"
import type { ScopeKey, ScopeLayer } from "../../runtime/scope/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import type Schema from "../../runtime/vendor/schemastery/index.ts"

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_COLLECT_CACHE_ENTRIES = 128
const MAX_COLLECT_ATTEMPTS = 2
const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_RANK = 250

/** Standard precedence rank for packaged skill providers and local bundled roots. */
export const BUNDLED_SKILL_RANK = 600

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Catalog-issued references disambiguate origins without changing provider-local names. */
export function isSkillReference(name: string): boolean {
  return name.length <= 8192 && (isSkillName(name)
    || /^[A-Za-z0-9%_.~-]+:[A-Za-z0-9%_.~-]+:[A-Za-z0-9%_.~\/-]+(?:@[a-f0-9]{12})?$/.test(name))
}

export class AmbiguousSkillError extends Error {
  readonly code = 'AMBIGUOUS_SKILL'
  constructor(readonly skillName: string) {
    // Do not leak user-only catalog entries in a model-facing failure.
    super(modelText('skills/ambiguous-name', { name: skillName }))
  }
}

/**
 * Origin bucket for a skill contribution. The value is metadata, not precedence by itself.
 * `project` and `project-*` sources form the project tier that catalog previews select first.
 */
export type SkillSource = 'project' | 'runtime' | 'custom' | 'bundled' | (string & {})

/** Most supporting-file paths one loaded skill may list. */
export const MAX_SKILL_RESOURCE_FILES = 50

/**
 * Most UTF-8 bytes the listed path lines of one loaded skill may render, counted by
 * {@link resourceFileLineBytes}. The listing is an optional disclosure with its own budget,
 * so long names cannot crowd out the body.
 */
export const MAX_SKILL_RESOURCE_LISTING_BYTES = 4096

/** Bounded, sorted listing of a directory skill's supporting files, relative to its base directory. */
export interface SkillResourceFiles {
  /** POSIX-style relative paths, in provider listing order. */
  readonly paths: readonly string[]
  /** Whether the listing may be incomplete: a bound was reached or a folder could not be read. */
  readonly truncated: boolean
}

/**
 * Exact UTF-8 bytes one listed path adds to the rendered `<skill_content>` block: its escaped
 * `- path` line plus the joining newline.
 * @param path - one relative path of a {@link SkillResourceFiles} listing.
 * @returns the rendered byte cost of that path.
 */
export function resourceFileLineBytes(path: string): number {
  return Buffer.byteLength(`- ${escapeText(path)}\n`, 'utf8')
}

/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Invocation controls shared by skill discovery consumers. */
export interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}

/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
export interface SkillSummary {
  /** Optional isolated execution and named argument contract. */
  readonly execution?: SkillExecutionPolicy
  /** Absolute instruction file path when supplied by the provider; absent for virtual skills. */
  readonly path?: string
  /** Bare name when unique; otherwise a catalog-issued qualified identity. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
  /** Provider-discovered grouping path ('/'-joined), used in qualified identity but not precedence. */
  readonly category?: string
  /** Offer-time tool conditions; see {@link SkillToolConditions}. */
  readonly conditions?: SkillToolConditions
}

/** Provider catalog entry used by the registry to merge and later load skills. */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks override duplicate names; equal-rank distinct origins require qualified references. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Supporting files disclosed with the loaded body; requires a directory resource base. */
  readonly resourceFiles?: SkillResourceFiles
}

/** Runtime skill contribution accepted by `ctx.skills.register()`. */
export type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  /** Invocation controls; omission permits both model and user surfaces. */
  readonly invocation?: SkillInvocationPolicy
  /** Provider label; omission uses the registry-owned runtime provider. */
  readonly provider?: string
}

/** Caller context used for cwd-sensitive and abortable provider work. */
export interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Registry read options: provider lookup context plus the viewing scope.
 * The registry consumes `scope` to select layers; providers receive the same
 * borrowed options object and read only their {@link SkillLookupOptions}
 * contract from it.
 */
export interface SkillViewOptions extends SkillLookupOptions {
  /** Viewing scope (the calling agent); omitted reads the global layer alone. */
  readonly scope?: ScopeKey | undefined
}

/**
 * Return whether a skill may be advertised to and loaded by a model.
 * @param skill - skill metadata carrying resolved invocation controls.
 * @returns whether the policy permits model invocation.
 */
export function isModelInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean {
  return skill.invocation.modelInvocable
}

/**
 * Return whether a skill may be advertised to and loaded by a human-facing command.
 * @param skill - skill metadata carrying resolved invocation controls.
 * @returns whether the policy permits user invocation.
 */
export function isUserInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean {
  return skill.invocation.userInvocable
}

/**
 * Durable source for the context message a user-explicit skill invocation
 * injects: the user's own words ride a plain user message, and the rendered
 * skill body follows as injected `instructions`-form context carrying this
 * source, so transcript consumers present the injection from metadata
 * instead of re-parsing the model-facing text.
 */
export interface SkillInvocationSource {
  readonly kind: 'skill-invocation'
  /** Invoked skill name, validated user-invocable at the injecting boundary. */
  readonly name: string
  /** Injected skill bodies are instructions for the model to follow. */
  readonly form: 'instructions'
}

declare module "../../model/llm/index.ts" {
  interface MessageSourceMap {
    /** A user-explicit skill invocation injected by the host. */
    'skill-invocation': SkillInvocationSource
  }
}

/**
 * Render one loaded skill for the model. The output is shared verbatim by the
 * `skill` tool result and the user-explicit invocation injection, so the model
 * sees one canonical `<skill_content>` shape on both paths. The name rides an
 * escaped attribute; the body is embedded verbatim (skills are trusted local
 * content, and user-supplied invocation text stays outside this wrapper).
 * @param skill - name, provider, optional resource base, and body to render.
 * @returns the complete model-facing `<skill_content>` block.
 */
export function renderSkillContent(skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'resourceFiles' | 'content'>): string {
  const resourceHint = renderResourceHint(skill)
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint,
    ...renderResourceFiles(skill.resourceFiles),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function renderResourceHint(skill: Pick<SkillDefinition, 'provider' | 'resourceBase'>): string[] {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        modelText('runtime/skill-index/text-01'),
      ]
    case 'url':
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        modelText('runtime/skill-index/text-02'),
      ]
    case 'opaque':
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        'Load referenced resources only as needed.',
      ]
    /* v8 ignore start -- SkillResourceBase is a closed union; a future kind must fail compilation here. */
    default:
      return assertNever(base, 'SkillResourceBase.kind')
    /* v8 ignore stop */
  }
}

/** The level-1 file listing; absent or empty listings render nothing, keeping the block byte-identical. */
function renderResourceFiles(files: SkillResourceFiles | undefined): string[] {
  if (files === undefined || (files.paths.length === 0 && !files.truncated)) return []
  return [
    modelText('skills/resource-files'),
    ...files.paths.map(path => `- ${escapeText(path)}`),
    ...files.truncated ? [modelText('skills/resource-files-truncated')] : [],
  ]
}

/** Whether text carries a C0 control character or DEL. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * Escape model-facing prose embedded inside skill markup so provider-supplied
 * text cannot open or close framing tags.
 * @param value - raw prose to embed.
 * @returns the escaped text.
 */
export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Opening of every block {@link renderSkillContent} writes; the name attribute follows. */
const SKILL_CONTENT_OPEN = '<skill_content name="'

/**
 * Recover the skill name from a rendered skill body: the inverse of the
 * opening tag {@link renderSkillContent} writes. Only a full loaded body
 * starts with that tag, so a fork-skill report or an "unchanged" note never
 * matches. Context pruning uses this to recognize a skill body it must not
 * cut partway and to name the skill in the marker it leaves behind; history
 * readers (compaction checkpoints) use it to recognize a skill load, including
 * a body another producer later cut down.
 * @param text - one tool-result text.
 * @returns the unescaped skill name, or `undefined` when the text is not a skill body.
 */
export function skillContentName(text: string): string | undefined {
  if (!text.startsWith(SKILL_CONTENT_OPEN)) return undefined
  const end = text.indexOf('">', SKILL_CONTENT_OPEN.length)
  if (end < 0) return undefined
  const escaped = text.slice(SKILL_CONTENT_OPEN.length, end)
  if (escaped.length === 0 || /["<\n]/.test(escaped)) return undefined
  return escaped.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&')
}

/** One catalog observation plus whether discovery completed within a stable catalog revision. */
export interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly skills: SkillSummary[]
  /** Whether every registered provider completed without a concurrent catalog revision. */
  readonly complete: boolean
}

/** Provider candidates plus whether the current discovery is authoritative. */
export interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}

/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates as a complete-array shorthand, or an explicit
   *   observation when usable candidates came from incomplete discovery.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** Registration-scoped lifecycle and invalidation capability borrowed by one provider. */
export interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
  readonly invalidate: () => void
}

/** Skill registry configuration. */
export interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}

declare module "../../runtime/vendor/cordis/index.ts" {
  interface Context {
    skills: SkillRegistry
  }

  interface Events {
    /**
     * A skill provider, runtime contribution, or provider-backed catalog may
     * have changed. This is an unfiltered invalidation notification; consumers
     * refetch the catalog for their own lookup options. Listener failures are
     * contained and cannot veto the registry mutation.
     * @mode emit
     */
    'skills/change'(): void
  }
}

interface IndexedCandidate {
  candidate: SkillCandidate
  provider: SkillProvider
  providerOrder: number
  localOrder: number
  /** Owning layer, so a stale-definition invalidation can verify the exact registration is still live. */
  layer: SkillLayer
  /** Invocation name published by the resolved catalog, never inferred by consumers. */
  publicName?: string
}

/** One provider registration retained by its layer. */
interface RegisteredProvider {
  provider: SkillProvider
  /** Service-wide monotonic registration order, the within-layer rank tiebreak. */
  order: number
}

interface CollectedCatalog {
  entries: Map<string, IndexedCandidate>
  catalog: Map<string, IndexedCandidate>
  ambiguous: Set<string>
}
interface CollectResult extends CollectedCatalog { cacheable: boolean }

/** One scope's complete skill-registry contribution. */
class SkillLayer implements ScopeLayer {
  /** Providers registered through contexts carrying this scope, insertion-ordered. */
  readonly providers: NamedEntries<RegisteredProvider>
  /** Runtime skills registered through contexts carrying this scope. */
  readonly runtime = new Map<string, SkillDefinition>()

  constructor(scope: ScopeKey | undefined) {
    this.providers = new NamedEntries(name => new Error(scope === undefined
      ? `a skill provider named "${name}" is already registered`
      : modelText('runtime/skill-index/text-03', { value_1: String(name) })))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.providers.isEmpty() && this.runtime.size === 0
  }
}

/**
 * Layered registry of skill providers, the host+per-scope shape the tools
 * registry established. A registration files into the layer of its calling
 * context's scope ({@link scopeOf}): host rows and repository plugins land in
 * the global layer, while a plugin mounted by an agent preset's standing
 * composition lands in that preset's layer. A read merges the global layer
 * with the viewing scope's chain — the nearest layer's entry wins a duplicate
 * name outright, and the rank order decides duplicates only within one layer.
 * It exposes sorted invocation-neutral summaries and loads full skill bodies
 * on demand.
 */
export class SkillRegistry extends Service {
  static Config: Schema<Config> = z.object({
    collectCacheMaxEntries: z.number().default(DEFAULT_COLLECT_CACHE_ENTRIES),
  })

  private readonly collectCacheMaxEntries: number
  private readonly layers = new ScopedLayers<SkillLayer>(
    scope => new SkillLayer(scope),
    () => { this.invalidateCache() },
  )
  private readonly collectCache = new Map<string, CollectedCatalog>()
  private revision = 0
  private nextProviderOrder = 0
  /** Stable identities for cache keys; scope keys are opaque identity-compared objects. */
  private readonly scopeIds = new WeakMap<ScopeKey, number>()
  private nextScopeId = 1

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skills')
    this.collectCacheMaxEntries = config.collectCacheMaxEntries ?? DEFAULT_COLLECT_CACHE_ENTRIES
    assertPositiveInteger('collectCacheMaxEntries', this.collectCacheMaxEntries)
  }

  /**
   * Register a borrowed same-process provider synchronously during plugin
   * apply, into the calling context's layer: a scoped context (an agent
   * preset's standing mount) registers for that scope alone, an unscoped
   * context registers globally. Duplicate names within one layer and reserved
   * names throw; remote initialization belongs in `list()`. Fiber disposal
   * unregisters the provider and invalidates catalog caches.
   * @param create - synchronous factory receiving this registration's lifecycle and invalidation control.
   * @returns the exact Cordis effect disposer that unregisters this provider;
   *   composite effects may yield it directly to preserve teardown ordering.
   */
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void {
    const lifecycle = new AbortController()
    let registration: { layer: SkillLayer; name: string } | undefined
    let provider: SkillProvider
    const control: SkillProviderControl = {
      signal: lifecycle.signal,
      invalidate: () => {
        const active = registration
        if (active !== undefined && active.layer.providers.get(active.name)?.provider === provider) {
          this.invalidateCache()
        }
      },
    }
    try {
      provider = create(control)
      const name = provider.name
      if (name === RUNTIME_PROVIDER) {
        throw new Error(`"${RUNTIME_PROVIDER}" is reserved for runtime skill registrations`)
      }
      const order = this.nextProviderOrder
      this.nextProviderOrder += 1
      return this.layers.effect(
        this.ctx,
        (layer) => {
          const undo = layer.providers.insert(name, { provider, order })
          registration = { layer, name }
          return () => {
            registration = undefined
            undo()
            lifecycle.abort(new Error(`skill provider "${name}" disposed`))
          }
        },
        { label: 'skills.registerProvider()' },
      )
    } catch (error) {
      lifecycle.abort(error)
      throw error
    }
  }

  /**
   * Register a borrowed readonly runtime skill into the calling context's
   * layer. Project entries outrank runtime entries, which outrank user
   * entries, within one layer. Same-name runtime entries in one layer are
   * first-wins; a duplicate logs a warning and receives a no-op disposer so
   * it cannot remove the winner.
   * @param skill - the skill definition input; omitted invocation and provider fields receive defaults.
   * @returns the exact Cordis effect disposer, preserving composite teardown order and invalidating caches.
   */
  register(skill: SkillRegistration): () => void {
    validateRuntimeSkill(skill)
    const scope = scopeOf(this.ctx)
    const existingLayer = scope === undefined ? this.layers.global : this.layers.peek(scope)
    if (existingLayer !== undefined && existingLayer.runtime.has(skill.name)) {
      this.ctx.logger.warn(modelText('runtime/skill-index/text-04', { value_1: String(skill.name) }))
      return () => {}
    }
    const definition: SkillDefinition = {
      ...skill,
      invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
      provider: skill.provider ?? RUNTIME_PROVIDER,
    }
    return this.layers.effect(
      this.ctx,
      (layer) => {
        layer.runtime.set(definition.name, definition)
        return () => { layer.runtime.delete(definition.name) }
      },
      { label: 'skills.register()' },
    )
  }

  /**
   * List invocation-neutral skill summaries for a workspace. Consumers apply
   * model or user invocation policy at their operational boundary. Lookup
   * options and provider candidates are readonly same-process values borrowed
   * throughout discovery.
   * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
   * @returns all sorted winning summaries.
   */
  async list(options: SkillViewOptions = {}): Promise<SkillSummary[]> {
    return (await this.snapshot(options)).skills
  }

  /**
   * Observe the current invocation-neutral catalog and whether discovery completed within a stable revision.
   * Incomplete observations are never cached, allowing consumers to retain last-good state and
   * retry on their next request boundary.
   * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
   * @returns sorted summaries plus discovery-completeness state.
   */
  async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot> {
    const collected = await this.collect(options)
    return {
      skills: [...collected.catalog.values()]
        .map(entry => ({ ...toSummary(entry.candidate), name: entry.publicName! }))
        .sort(compareSkillSummary),
      complete: collected.cacheable,
    }
  }

  /**
   * Load and validate the winning candidate, passing its opaque discovery locator back to the
   * provider. Cancellation is rechecked after selection, including cache hits, and raced against
   * loading so an uncooperative provider cannot hang the caller.
   * @param name - kebab-case skill name.
   * @param options - view options; `scope` selects the viewing agent's layers,
   *   `cwd` selects workspace-sensitive skills, and `signal` cancels work.
   * @returns the full skill, including body content, or `undefined`.
   */
  /** Resolve metadata without reading the body, using exactly the loader's ambiguity policy. */
  async describe(name: string, options: SkillViewOptions = {}): Promise<SkillSummary | undefined> {
    if (!isSkillReference(name)) return undefined
    const collected = await this.collect(options)
    if (collected.ambiguous.has(name)) throw new AmbiguousSkillError(name)
    const entry = collected.entries.get(name)
    return entry === undefined ? undefined : { ...toSummary(entry.candidate), name: entry.publicName! }
  }

  async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillReference(name)) return undefined
    const collected = await this.collect(options)
    throwIfAborted(options.signal)
    if (collected.ambiguous.has(name)) throw new AmbiguousSkillError(name)
    const match = collected.entries.get(name)
    if (match === undefined) return undefined
    const selectionKey = this.collectCacheKey(options.cwd, scopeChainOf(options.scope), this.revision)
    const selectedMetadata = structuredClone(toSummary(match.candidate))
    const definition = await waitWithAbort(match.provider.get(match.candidate, options), options.signal)
    throwIfAborted(options.signal)
    if (definition === undefined) return undefined
    validateDefinition(definition)
    // A suspended load cannot return a removed/replaced provider or a now-hidden
    // scope's body. Do not execute an automatic replacement load with new policy.
    if (!this.ownsEntry(match) || !isDeepStrictEqual(toSummary(match.candidate), selectedMetadata)) return undefined
    if (selectionKey !== this.collectCacheKey(options.cwd, scopeChainOf(options.scope), this.revision)) {
      const current = (await this.collect(options)).entries.get(name)
      throwIfAborted(options.signal)
      if (current === undefined || current.layer !== match.layer || current.provider !== match.provider
        || current.providerOrder !== match.providerOrder || !this.ownsEntry(match)
        || !isDeepStrictEqual(toSummary(current.candidate), selectedMetadata)) return undefined
    }
    if (definition.name !== match.candidate.name
      || definition.provider !== match.candidate.provider || definition.source !== match.candidate.source) {
      this.invalidateEntry(match)
      return undefined
    }
    return definition.name === match.publicName ? definition : { ...definition, name: match.publicName! }
  }

  private async collect(options: SkillViewOptions): Promise<CollectResult> {
    throwIfAborted(options.signal)
    let attempt = 1
    while (true) {
      const revision = this.revision
      // The chain is part of the key rather than assumed stable: a blank-session
      // recompose re-parents an existing scope without touching this registry,
      // and only a chain-bearing key makes the next read see the new preset.
      const key = this.collectCacheKey(options.cwd, scopeChainOf(options.scope), revision)
      const cached = this.collectCache.get(key)
      if (cached !== undefined) return { ...cached, cacheable: true }

      const result = await this.collectFresh(options)
      throwIfAborted(options.signal)
      if (key !== this.collectCacheKey(options.cwd, scopeChainOf(options.scope), this.revision)) {
        if (attempt < MAX_COLLECT_ATTEMPTS) {
          attempt += 1
          continue
        }
        return { ...result, cacheable: false }
      }
      if (result.cacheable) {
        this.collectCache.set(key, { entries: result.entries, catalog: result.catalog, ambiguous: result.ambiguous })
        if (this.collectCache.size > this.collectCacheMaxEntries) {
          const oldest = this.collectCache.keys().next() as IteratorYieldResult<string>
          this.collectCache.delete(oldest.value)
        }
      }
      return result
    }
  }

  /** Scope/rank are policy; registration order is not permission to hide a conflicting skill. */
  private async collectFresh(options: SkillViewOptions): Promise<CollectResult> {
    const merged = new Map<string, IndexedCandidate[]>()
    let cacheable = true
    for (const layer of [this.layers.global, ...this.layers.chainLayers(options.scope)]) {
      const winners = new Map<string, IndexedCandidate[]>()
      const retain = (entry: IndexedCandidate): void => {
        const old = winners.get(entry.candidate.name)
        if (old === undefined || entry.candidate.rank < old[0]!.candidate.rank) {
          winners.set(entry.candidate.name, [entry])
        } else if (entry.candidate.rank === old[0]!.candidate.rank) old.push(entry)
      }
      let localOrder = 0
      for (const skill of layer.runtime.values()) {
        retain({ candidate: runtimeCandidate(skill), provider: RUNTIME_SKILL_PROVIDER,
          providerOrder: -1, localOrder: localOrder++, layer })
      }
      for (const { provider, order } of [...layer.providers.values()]) {
        throwIfAborted(options.signal)
        let output: unknown
        try { output = await waitWithAbort(provider.list(options), options.signal) }
        catch (error) {
          throwIfAborted(options.signal)
          cacheable = false
          this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
        }
        if (output === undefined) continue
        const observation = normalizeProviderObservation(output, provider.name)
        cacheable &&= observation.complete
        localOrder = 0
        for (const candidate of observation.candidates) {
          validateCandidate(candidate, provider.name)
          retain({ candidate, provider, providerOrder: order, localOrder: localOrder++, layer })
        }
      }
      // A closer scope's override is authoritative, including its invocation restrictions.
      for (const [name, entries] of winners) merged.set(name, entries)
    }
    const entries = new Map<string, IndexedCandidate>()
    const catalog = new Map<string, IndexedCandidate>()
    const ambiguous = new Set<string>()
    for (const [name, candidates] of merged) {
      const references = new Map<string, IndexedCandidate[]>()
      for (const entry of candidates) {
        const c = entry.candidate
        const ref = [c.provider, c.source, ...(c.category ? c.category.split('/') : []), c.name]
          .map(part => encodeURIComponent(part).replaceAll(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16)}`))
        const base = `${ref[0]}:${ref[1]}:${ref.slice(2).join('/')}`
        const group = references.get(base)
        if (group === undefined) references.set(base, [entry]); else group.push(entry)
      }
      if (candidates.length > 1) ambiguous.add(name)
      for (const [base, group] of references) for (const entry of group) {
        const identity = JSON.stringify([entry.candidate.path, entry.candidate.resourceBase])
        const ref = group.length === 1 ? base : `${base}@${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`
        if (entries.has(ref)) throw new Error(modelText('skills/duplicate-origin', { name }))
        entry.publicName = candidates.length === 1 ? name : ref
        entries.set(ref, entry)
        catalog.set(entry.publicName, entry)
        if (candidates.length === 1) entries.set(name, entry)
      }
    }
    return { entries, catalog, ambiguous, cacheable }
  }

  private invalidateCache(): void {
    this.revision += 1
    this.collectCache.clear()
    this.notifyChange()
  }

  /** Registration epochs—not object equality alone—fence suspended reads. */
  private ownsEntry(entry: IndexedCandidate): boolean {
    if (entry.provider === RUNTIME_SKILL_PROVIDER) return entry.layer.runtime.get(entry.candidate.name) === entry.candidate.locator
    const live = entry.layer.providers.get(entry.provider.name)
    return live?.provider === entry.provider && live.order === entry.providerOrder
  }

  private invalidateEntry(entry: IndexedCandidate): void {
    if (this.ownsEntry(entry)) this.invalidateCache()
  }

  private scopeId(key: ScopeKey): number {
    let id = this.scopeIds.get(key)
    if (id === undefined) {
      id = this.nextScopeId
      this.nextScopeId += 1
      this.scopeIds.set(key, id)
    }
    return id
  }

  private collectCacheKey(cwd: string | undefined, chain: ScopeKey[], revision: number): string {
    return JSON.stringify({ cwd, scopes: chain.map(key => this.scopeId(key)), revision })
  }

  /** Notify catalog observers without making their refresh work load-bearing. */
  private notifyChange(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['skills/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`skills/change listener rejected: ${errorMessage(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`skills/change listener threw: ${errorMessage(error)}`)
      }
    }
  }
}

function normalizeProviderObservation(output: unknown, providerName: string): SkillProviderObservation {
  if (Array.isArray(output)) {
    return { candidates: output as readonly SkillCandidate[], complete: true }
  }
  if (output === null || typeof output !== 'object') {
    throw invalidProviderObservation(providerName)
  }
  const observation = output as Partial<SkillProviderObservation>
  if (!Array.isArray(observation.candidates) || typeof observation.complete !== 'boolean') {
    throw invalidProviderObservation(providerName)
  }
  return observation as SkillProviderObservation
}

function invalidProviderObservation(providerName: string): TypeError {
  return new TypeError(modelText('runtime/skill-index/text-06', { value_1: String(providerName) }))
}

const RUNTIME_SKILL_PROVIDER: SkillProvider = {
  name: RUNTIME_PROVIDER,
  /* v8 ignore next -- Runtime skills are injected directly by the registry; this provider only owns `get()`. */
  list() {
    return Promise.resolve([])
  },
  get(candidate) {
    return Promise.resolve(candidate.locator as SkillDefinition)
  },
}

function runtimeCandidate(skill: SkillDefinition): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    ...(skill.execution === undefined ? {} : { execution: skill.execution }),
    source: skill.source,
    provider: skill.provider,
    ...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {},
    ...skill.category !== undefined ? { category: skill.category } : {},
    ...skill.conditions !== undefined ? { conditions: skill.conditions } : {},
    rank: RUNTIME_RANK,
    locator: skill,
    ...skill.path !== undefined ? { path: skill.path } : {},
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

function validateCandidate(candidate: SkillCandidate, providerName: string): void {
  validateSkillExecution(candidate.execution)
  validateSkillToolConditions(candidate.conditions)
  validateCategory(candidate.category, `skill provider "${providerName}" returned skill "${String(candidate.name)}"`)
  if (typeof candidate.name !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned a non-string skill name`)
  }
  if (!SKILL_NAME.test(candidate.name)) {
    throw new Error(modelText('runtime/skill-index/text-07', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  if (typeof candidate.description !== 'string') {
    throw new TypeError(modelText('runtime/skill-index/text-08', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  if (candidate.description.length === 0) {
    throw new Error(modelText('runtime/skill-index/text-09', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  validateInvocation(candidate.invocation, `skill provider "${providerName}" returned skill "${candidate.name}"`)
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') {
    throw new TypeError(modelText('runtime/skill-index/text-10', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  if (typeof candidate.source !== 'string') {
    throw new TypeError(modelText('runtime/skill-index/text-11', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) {
    throw new Error(modelText('runtime/skill-index/text-12', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  if (typeof candidate.provider !== 'string') {
    throw new TypeError(modelText('runtime/skill-index/text-13', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
  if (candidate.provider !== providerName) {
    throw new Error(modelText('runtime/skill-index/text-14', { value_1: String(providerName), value_2: String(candidate.name), value_3: String(candidate.provider) }))
  }
  if (candidate.path !== undefined && typeof candidate.path !== 'string') {
    throw new TypeError(modelText('runtime/skill-index/text-15', { value_1: String(providerName), value_2: String(candidate.name) }))
  }
}

function validateRuntimeSkill(skill: SkillRegistration): void {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`)
  validateInvocation(skill.invocation, `runtime skill "${skill.name}"`)
  validateSkillToolConditions(skill.conditions)
  validateCategory(skill.category, `runtime skill "${skill.name}"`)
  validateResourceFiles(skill, `runtime skill "${skill.name}"`)
}

function validateCategory(category: unknown, subject: string): void {
  if (category !== undefined && (typeof category !== 'string' || category.length === 0)) {
    throw new TypeError(`${subject} category must be a non-empty string`)
  }
}

/** A malformed listing is a provider result error, never a silently shortened disclosure. */
function validateResourceFiles(skill: Pick<SkillDefinition, 'resourceFiles' | 'resourceBase'>, subject: string): void {
  const files: unknown = skill.resourceFiles
  if (files === undefined) return
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new TypeError(`${subject} resourceFiles must be an object`)
  const { paths, truncated } = files as { paths?: unknown; truncated?: unknown }
  if (typeof truncated !== 'boolean') throw new TypeError(`${subject} resourceFiles.truncated must be a boolean`)
  if (!Array.isArray(paths) || paths.length > MAX_SKILL_RESOURCE_FILES) {
    throw new TypeError(`${subject} resourceFiles.paths must list at most ${MAX_SKILL_RESOURCE_FILES} paths`)
  }
  let bytes = 0
  for (const path of paths as unknown[]) {
    // Only paths skill_read can accept: relative POSIX segments, no scheme or drive prefix,
    // and no control characters that could forge listing lines.
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\')
      || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || hasControlCharacter(path)
      || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new TypeError(`${subject} resourceFiles lists an invalid relative path`)
    }
    bytes += resourceFileLineBytes(path)
  }
  if (bytes > MAX_SKILL_RESOURCE_LISTING_BYTES) {
    throw new TypeError(`${subject} resourceFiles.paths must render in at most ${MAX_SKILL_RESOURCE_LISTING_BYTES} bytes`)
  }
  if (skill.resourceBase?.kind !== 'directory') throw new TypeError(`${subject} resourceFiles requires a directory resource base`)
}

/** Validate a definition loaded from a provider-controlled parser or remote source. */
function validateDefinition(skill: SkillDefinition): void {
  validateSkillExecution(skill.execution)
  validateSkillToolConditions(skill.conditions)
  const name = skill.name
  const description = skill.description
  const whenToUse = skill.whenToUse
  const invocation = skill.invocation
  const source = skill.source
  const provider = skill.provider
  const content = skill.content
  const path = skill.path
  if (typeof name !== 'string') throw new TypeError('loaded skill name must be a string')
  if (!SKILL_NAME.test(name)) throw new Error(`loaded skill has invalid name "${name}"`)
  if (typeof description !== 'string') throw new TypeError(`loaded skill "${name}" description must be a string`)
  if (description.length === 0) throw new Error(`loaded skill "${name}" requires a description`)
  validateInvocation(invocation, `loaded skill "${name}"`)
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new TypeError(`loaded skill "${name}" whenToUse must be a string`)
  if (typeof source !== 'string') throw new TypeError(`loaded skill "${name}" source must be a string`)
  if (typeof provider !== 'string') throw new TypeError(`loaded skill "${name}" provider must be a string`)
  if (typeof content !== 'string') throw new TypeError(`loaded skill "${name}" content must be a string`)
  if (path !== undefined && typeof path !== 'string') throw new TypeError(`loaded skill "${name}" path must be a string`)
  validateCategory(skill.category, `loaded skill "${name}"`)
  validateResourceFiles(skill, `loaded skill "${name}"`)
}

function toSummary(skill: SkillDefinition | SkillCandidate): SkillSummary {
  const { name, description, whenToUse, invocation, source, provider, resourceBase } = skill
  return {
    name,
    ...skill.path === undefined ? {} : { path: skill.path },
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    invocation,
    ...(skill.execution === undefined ? {} : { execution: skill.execution }),
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase } : {},
    ...skill.category !== undefined ? { category: skill.category } : {},
    ...skill.conditions !== undefined ? { conditions: skill.conditions } : {},
  }
}

function validateInvocation(invocation: unknown, subject: string): void {
  if (invocation === undefined) return
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
    throw new TypeError(`${subject} with a non-object invocation policy`)
  }
  const policy = invocation as Record<string, unknown>
  if (typeof policy.modelInvocable !== 'boolean') {
    throw new TypeError(`${subject} with a non-boolean invocation.modelInvocable`)
  }
  if (typeof policy.userInvocable !== 'boolean') {
    throw new TypeError(`${subject} with a non-boolean invocation.userInvocable`)
  }
}

function compareSkillSummary(left: SkillSummary, right: SkillSummary): number {
  return compareCodePoints(left.name, right.name)
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}


function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(modelText('runtime/skill-index/text-16', { value_1: String(name), value_2: String(minimum) }))
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(toError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(toError(error))
      },
    )
  })
}

/** Throw a total Error for an already-aborted lookup. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw toError(signal.reason)
}

/** Normalize an arbitrary abort or provider failure without trusting coercion. */
function toError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  } catch {
    // A hostile proxy may throw during instanceof; fall through to the total renderer.
  }
  return new Error(errorMessage(error))
}

/** Render an arbitrary provider failure without letting coercion escape containment. */
function errorMessage(error: unknown): string {
  try {
    return String(error)
  } catch {
    return modelText('foundation/skill-index/text-01')
  }
}

export default SkillRegistry
