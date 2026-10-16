import { skillExecutionPolicy, skillToolConditions, type SkillExecutionPolicy, type SkillToolConditions } from '../execution-policy.ts'
/**
 * Local filesystem skill provider.
 *
 * This package is one implementation of the `ctx.skills` provider registry. It
 * discovers directory-bundle and flat Markdown skills from the configured
 * project, custom and bundled roots only, parses YAML frontmatter, and loads
 * bodies through `ctx.fs` when a filesystem service is present.
 *
 * @module io-agent/skill-filesystem
 */

import { modelText } from "../../context/text/index.ts"
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import chokidar from 'chokidar'
import z from "../../runtime/vendor/schemastery/index.ts"
import type Schema from "../../runtime/vendor/schemastery/index.ts"
import { parse as parseYaml } from 'yaml'
import type { FileSystem, FsTarget } from "../../filesystem/fs/index.ts"
import { canonicalizeWatchPath } from "../../util/home-paths/index.ts"
import {
  BUNDLED_SKILL_RANK,
  MAX_SKILL_RESOURCE_FILES,
  MAX_SKILL_RESOURCE_LISTING_BYTES,
  hasControlCharacter,
  isSkillName,
  resourceFileLineBytes,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillProviderObservation,
  type SkillResourceFiles,
  type SkillSource,
} from "../skill/index.ts"

const CUSTOM_RANK = 300
const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100
/** Level-1 listing roots, in disclosure order (Hermes `_LINKED_FILE_SPECS` directories). */
const RESOURCE_DIRECTORIES = ['references', 'templates', 'scripts', 'assets'] as const
/** Directory levels listed below each resource directory. */
const RESOURCE_LISTING_MAX_DEPTH = 3
/** Directories one load may list, including the resource directories themselves. */
const RESOURCE_LISTING_MAX_DIRECTORIES = 32
/**
 * Dependency and generated entries never listed (Hermes `EXCLUDED_SKILL_DIRS`). A bundled
 * script that runs once must not change the next listing: it would spend listing slots and
 * defeat the content-exact `unchanged` reply for an otherwise identical skill.
 */
const RESOURCE_LISTING_EXCLUDED_NAMES = new Set(['node_modules', '__pycache__', 'site-packages', 'venv'])
const RESOURCE_LISTING_EXCLUDED_SUFFIXES = ['.pyc', '.pyo'] as const

export const name = 'skill-filesystem'
export const inject = ['skills']

/** Local filesystem skill provider configuration. */
export interface Config {
  /** Discovery reads only this many bytes of frontmatter, never an entire body. */
  metadataMaxBytes?: number
  /** Refuse full instruction sources larger than this many bytes; never truncate. */
  maxSourceBytes?: number
  /** Category nesting under each root (root depth is zero). Defaults to 4. */
  discoveryMaxDepth?: number
  /** Maximum directories inspected per root, including the root. Defaults to 512. */
  discoveryMaxDirectories?: number
  /** Unique provider name. Defaults to `filesystem`. */
  providerName?: string
  /**
   * Explicit project-scoped roots, scanned before custom roots with source `project`. They
   * outrank custom roots explicitly. Distinct same-tier skills require qualified names;
   * traversal order is not authorization to silently select one implementation.
   */
  projectSkillDirs?: string[]
  /** Additional skill roots scanned after the project roots. */
  customSkillDirs?: string[]
  /** Whether host-local skill roots are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed skill entry must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
  /** Whether watched symbolic links follow their target files. */
  watchFollowSymlinks?: boolean
  /** Host-trusted bundled skill root, scanned last; none unless configured. */
  bundledSkillDir?: string
}

export const Config: Schema<Config> = z.object({
  metadataMaxBytes: z.number(),
  maxSourceBytes: z.number(),
  discoveryMaxDepth: z.number().step(1).min(1).max(32).default(4),
  discoveryMaxDirectories: z.number().step(1).min(1).max(10000).default(512),
  providerName: z.string().min(1).default('filesystem'),
  projectSkillDirs: z.array(z.string()).default([]),
  customSkillDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
  watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
  watchFollowSymlinks: z.boolean().default(true),
  bundledSkillDir: z.string(),
})

interface SkillRoot {
  path: string
  source: SkillSource
  rank: number
  trustedHost?: boolean
  /** Relative bundle boundaries, learned by the bounded scanner. */
  bundles?: Set<string>
}

interface SkillRootEntry {
  name: string
  type: 'directory' | 'file' | 'other'
  path: string
}

interface SkillText {
  path: string
  content: string
}

interface ParsedSkill extends SkillText {
  execution?: SkillExecutionPolicy
  conditions?: SkillToolConditions
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  metadata?: Record<string, unknown>
}

interface LocalLocator {
  path: string
  directory: string
  /** A `<name>/SKILL.md` bundle owns its directory; a flat Markdown skill shares a category folder. */
  bundle: boolean
}

interface ResolvedWatchConfig {
  enabled: boolean
  usePolling: boolean
  stabilityThresholdMs: number
  pollIntervalMs: number
  followSymlinks: boolean
  depth: number
}

/** Register the local filesystem skill provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config = {}): void {
  let provider!: FileSystemSkillProvider
  ctx.skills.registerProvider((control) => {
    provider = new FileSystemSkillProvider(ctx, control, config)
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'skill-filesystem watcher')
  const announced = new WeakMap<object, Set<string>>()
  ctx.on('fs/before-change', (target, actor) => {
    if (actor === undefined) return
    let paths = announced.get(actor)
    if (paths === undefined) { paths = new Set(); announced.set(actor, paths) }
    paths.add(target.displayPath)
  })
  ctx.on('fs/observed', (target, _observation, actor) => {
    if (mutationToolName(actor) === undefined && (actor === undefined || !announced.has(actor))) return
    provider.observeHostMutation(target.displayPath)
  })
  // A multi-file failure may have rolled back or partially published. Re-scan announced
  // paths after the contained final outcome; never retain an authoritative stale catalog.
  ctx.inject(['tools'], toolCtx => { toolCtx.on('tools/result', exec => {
    const paths = announced.get(exec)
    if (paths === undefined) return
    announced.delete(exec)
    for (const path of paths) provider.observeHostMutation(path)
  }) })
}

/**
 * Provider that maps the configured local skill roots into `ctx.skills`. It
 * has no default roots: nothing under the OS home, the project, or an
 * environment variable is scanned unless the configuration names it.
 */
export class FileSystemSkillProvider implements SkillProvider {
  readonly name: string
  private readonly projectSkillDirs: string[]
  private readonly customSkillDirs: string[]
  private readonly watchManager: SkillWatchManager
  private readonly bundledSkillDir: string | undefined
  private disposal: Promise<void> | undefined
  private readonly metadataMaxBytes: number | undefined
  private readonly maxSourceBytes: number | undefined
  private readonly discovery: { maxDepth: number; maxDirectories: number }

  constructor(
    private readonly ctx: Context,
    control: SkillProviderControl,
    config: Config = {},
  ) {
    this.metadataMaxBytes = config.metadataMaxBytes
    this.maxSourceBytes = config.maxSourceBytes
    for (const [key, value] of Object.entries({ metadataMaxBytes: this.metadataMaxBytes, maxSourceBytes: this.maxSourceBytes })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 256 || value > 16_777_216)) {
        throw new TypeError(`skill-filesystem: ${key} must be a safe integer from 256 through 16777216`)
      }
    }
    this.discovery = { maxDepth: config.discoveryMaxDepth ?? 4, maxDirectories: config.discoveryMaxDirectories ?? 512 }
    for (const [key, value] of Object.entries(this.discovery)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > (key === 'maxDepth' ? 32 : 10000)) {
        throw new TypeError(`skill-filesystem: invalid discovery ${key}`)
      }
    }
    this.name = config.providerName ?? 'filesystem'
    this.projectSkillDirs = (config.projectSkillDirs ?? []).map(root => resolve(root))
    this.customSkillDirs = (config.customSkillDirs ?? []).map(root => resolve(root))
    this.watchManager = new SkillWatchManager(ctx, control.invalidate, resolveWatchConfig(config))
    control.signal.addEventListener('abort', () => { void this.dispose() }, { once: true })
    this.bundledSkillDir = config.bundledSkillDir === undefined ? undefined : resolve(config.bundledSkillDir)
  }

  /**
   * Discover local skill summaries in the configured roots.
   * @param options - lookup options; only the signal is used, since the roots do not depend on `cwd`.
   * @returns local provider candidates with stable root ranks; watcher startup
   *   failure returns readable candidates as an incomplete observation.
   */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    const roots = this.roots()
    let complete = true
    try {
      await this.watchManager.observeRoots(roots)
    } catch (error) {
      if (this.disposal !== undefined) throw error
      complete = false
    }
    const candidates: SkillCandidate[] = []
    for (const root of roots) {
      const observation = await discoverRoot(root, this.ctx, this.name, this.discovery, options.signal, this.metadataMaxBytes)
      candidates.push(...observation.candidates)
      complete &&= observation.complete
    }
    return complete ? candidates : { candidates, complete }
  }

  /**
   * Load a complete local skill body from the candidate's file locator.
   * @param candidate - the winning candidate returned by this provider.
   * @param options - lookup options whose signal cancels filesystem reads.
   * @returns the full local skill, or `undefined` if the file disappeared.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as LocalLocator
    const trustedHost = candidate.source === 'bundled'
    const parsed = await parseSkillFile(locator.path, this.ctx, options.signal, trustedHost, this.maxSourceBytes === undefined ? undefined : { maxBytes: this.maxSourceBytes, metadataOnly: false })
    if (parsed === undefined) return undefined
    // Listed after the body read: a bundle's own directory only, never a shared category folder.
    const resourceFiles = locator.bundle ? await listBundleFiles(locator.directory, this.ctx, trustedHost, options.signal) : undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      ...(parsed.execution === undefined ? {} : { execution: parsed.execution }),
      ...(parsed.conditions === undefined ? {} : { conditions: parsed.conditions }),
      ...(candidate.category === undefined ? {} : { category: candidate.category }),
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      ...(resourceFiles === undefined ? {} : { resourceFiles }),
      path: parsed.path,
      ...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
      content: parsed.content,
    }
  }

  /**
   * Invalidate this provider synchronously after a first-party filesystem mutation.
   * @param path - host display path observed after a model-facing write or edit.
   */
  observeHostMutation(path: string): void {
    this.watchManager.observeHostMutation(path)
  }

  /**
   * Close every host watcher and contain late filesystem callbacks.
   * @returns a shared promise that settles when every watcher reaches quiescence.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.watchManager.dispose()
    return this.disposal
  }

  /** The configured roots in precedence order: project, custom, then bundled. */
  private roots(): SkillRoot[] {
    const roots: SkillRoot[] = [
      ...this.projectSkillDirs.map(path => ({ path, source: 'project' as const, rank: CUSTOM_RANK - 1 })),
      ...this.customSkillDirs.map(path => ({ path, source: 'custom' as const, rank: CUSTOM_RANK })),
    ]
    if (this.bundledSkillDir !== undefined) {
      roots.push({ path: this.bundledSkillDir, source: 'bundled', rank: BUNDLED_SKILL_RANK, trustedHost: true })
    }
    return roots
  }
}

type SkillWatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'

type RootWatchMode =
  | { kind: 'root'; anchor: string }
  | { kind: 'ancestor'; anchor: string; nextPath: string }

interface RootWatchState {
  root: SkillRoot
  watcher: WatchHandle | undefined
  opening: Promise<void> | undefined
  unhealthy: boolean
}

interface WatchHandle {
  mode: RootWatchMode
  close(): Promise<void> | void
}

/** Owns bounded host watchers while discovery and reads remain on the filesystem service. */
class SkillWatchManager {
  private readonly roots = new Map<string, RootWatchState>()
  private readonly lifecycle = new AbortController()
  private closing = false
  private invalidationQueued = false

  constructor(
    private readonly ctx: Context,
    private readonly invalidate: () => void,
    private readonly config: ResolvedWatchConfig,
  ) {}

  async observeRoots(roots: readonly SkillRoot[]): Promise<void> {
    if (this.closing) return
    await Promise.all(roots.map(root => this.retainRoot(root)))
  }

  observeHostMutation(path: string): void {
    if (this.closing) return
    const normalized = resolve(path)
    if (![...this.roots.values()].some(state => isPotentialSkillPath(state.root, normalized))) return
    this.invalidate()
  }

  async dispose(): Promise<void> {
    this.closing = true
    this.lifecycle.abort(new Error('skill-filesystem watcher disposed'))
    const states = [...this.roots.values()]
    this.roots.clear()
    await Promise.all(states.map(async (state) => {
      await settleWatcherOpening(state.opening)
      const watcher = state.watcher
      state.watcher = undefined
      if (watcher !== undefined) await this.closeWatcher(watcher)
    }))
  }

  private async retainRoot(root: SkillRoot): Promise<void> {
    let state = this.roots.get(root.path)
    if (state === undefined) {
      state = { root, watcher: undefined, opening: undefined, unhealthy: true }
      this.roots.set(root.path, state)
    }
    state.root = root
    if (this.config.enabled) await this.ensureWatcher(state)
  }

  private ensureWatcher(state: RootWatchState): Promise<void> {
    /* v8 ignore next -- A scheduled rewatch can reach this guard only when teardown wins its await. */
    if (this.closing || !this.config.enabled) return Promise.resolve()
    if (state.opening !== undefined) return state.opening
    const opening = this.ensureCurrentWatcher(state)
    state.opening = opening
    void opening.then(
      () => {
        state.opening = undefined
      },
      () => {
        state.opening = undefined
      },
    )
    return opening
  }

  private async ensureCurrentWatcher(state: RootWatchState): Promise<void> {
    const watcher = state.watcher
    if (watcher !== undefined && !state.unhealthy) {
      const current = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
      // A child unlink can publish an empty catalog before root unlinkDir arrives.
      // Discovery therefore revalidates the retained handle independently.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- watcher callbacks can mark unhealthy while the probe awaits
      if (!state.unhealthy && sameWatchMode(watcher.mode, current)) return
    }
    await this.replaceWatcher(state)
  }

  private async replaceWatcher(state: RootWatchState): Promise<void> {
    const previous = state.watcher
    state.watcher = undefined
    if (previous !== undefined) await this.closeWatcher(previous)
    /* v8 ignore next -- Teardown can win while an unhealthy watcher is still closing. */
    if (this.closing) return
    try {
      const watcher = await this.openStableWatcher(state)
      /* v8 ignore next -- The loop returns no handle only when teardown wins between awaited probes. */
      if (watcher === undefined) return
      /* v8 ignore start -- Post-open teardown is timing-dependent; the disposal race has an explicit integration test. */
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- teardown can race awaited watcher startup
      if (this.closing) {
        await this.closeWatcher(watcher)
        return
      }
      /* v8 ignore stop */
      state.watcher = watcher
      state.unhealthy = false
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- teardown can race awaited watcher startup
      if (!this.closing) {
        state.unhealthy = true
        this.ctx.logger.warn(`skill-filesystem: failed to watch ${state.root.path}: ${errorMessage(error)}`)
      }
      throw error
    }
  }

  private async openStableWatcher(state: RootWatchState): Promise<WatchHandle | undefined> {
    while (!this.closing) {
      const mode = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
      const watcher = mode.kind === 'ancestor'
        ? this.openAncestorWatcher(state, mode)
        : await this.openRootWatcher(state, mode)
      const current = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
      /* v8 ignore else -- A host path transition between the two probes is timing-dependent. */
      if (sameWatchMode(mode, current)) return watcher
      /* v8 ignore next -- Covered by the same host path transition guard. */
      await this.closeWatcher(watcher)
    }
    /* v8 ignore next -- The loop exits only when teardown wins between awaited probes. */
    return undefined
  }

  private openAncestorWatcher(state: RootWatchState, mode: Extract<RootWatchMode, { kind: 'ancestor' }>): WatchHandle {
    const listener = (_current: Stats, _previous: Stats): void => {
      void this.handleAncestorWatchEvent(state, mode)
    }
    watchFile(mode.nextPath, {
      persistent: false,
      interval: this.config.pollIntervalMs,
    }, listener)
    return {
      mode,
      close() {
        unwatchFile(mode.nextPath, listener)
      },
    }
  }

  private async handleAncestorWatchEvent(
    state: RootWatchState,
    mode: Extract<RootWatchMode, { kind: 'ancestor' }>,
  ): Promise<void> {
    let current: RootWatchMode
    try {
      current = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
    } catch (error) {
      /* v8 ignore start -- Non-absence stat failures need a platform permission or I/O fault. */
      if (!this.closing) this.handleWatcherError(state, error)
      return
      /* v8 ignore stop */
    }
    if (this.closing || sameWatchMode(mode, current)) return
    this.queueInvalidation()
    state.unhealthy = true
    this.scheduleRewatch(state)
  }

  private async openRootWatcher(state: RootWatchState, mode: Extract<RootWatchMode, { kind: 'root' }>): Promise<WatchHandle> {
    const watcher = chokidar.watch(mode.anchor, {
      // Chokidar owns late native fs.watch errors only for persistent watchers;
      // this provider's effect explicitly closes every handle at teardown.
      persistent: true,
      ignoreInitial: true,
      depth: this.config.depth,
      followSymlinks: this.config.followSymlinks,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.stabilityThresholdMs,
        pollInterval: this.config.pollIntervalMs,
      },
      usePolling: this.config.usePolling,
      interval: this.config.pollIntervalMs,
    })
    const handle: WatchHandle = {
      mode,
      close: () => watcher.close(),
    }
    let ready = false
    const readiness = Promise.withResolvers<undefined>()
    const signal = this.lifecycle.signal
    if (signal.aborted) {
      await this.closeWatcher(handle)
      signal.throwIfAborted()
    }
    const onAbort = (): void => { readiness.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    const onError = (error: unknown): void => {
      if (!ready) {
        readiness.reject(error)
        return
      }
      this.handleWatcherError(state, error)
    }
    watcher.on('error', onError)
    watcher.once('ready', () => {
      ready = true
      readiness.resolve(undefined)
    })
    for (const event of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
      watcher.on(event, (path) => { this.handleWatchEvent(state, mode, event, path) })
    }
    try {
      await readiness.promise
    } catch (error) {
      await this.closeWatcher(handle)
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    return handle
  }

  private handleWatchEvent(
    state: RootWatchState,
    mode: Extract<RootWatchMode, { kind: 'root' }>,
    event: SkillWatchEvent,
    path: string,
  ): void {
    const target = resolve(path)
    if (this.closing || !isRelevantWatchEvent({ ...state.root, path: mode.anchor }, event, target)) return
    this.queueInvalidation()
    if (target === mode.anchor && event === 'unlinkDir') {
      state.unhealthy = true
      this.scheduleRewatch(state)
    }
  }

  private handleWatcherError(state: RootWatchState, error: unknown): void {
    if (this.closing) return
    this.ctx.logger.warn(`skill-filesystem: watcher for ${state.root.path} failed: ${errorMessage(error)}`)
    state.unhealthy = true
    this.queueInvalidation()
    this.scheduleRewatch(state)
  }

  private scheduleRewatch(state: RootWatchState): void {
    const currentOpening = state.opening ?? Promise.resolve()
    void (async () => {
      await settleWatcherOpening(currentOpening)
      try {
        await this.ensureWatcher(state)
      } catch {
        // Watch startup logged the retry failure; the next incomplete discovery retries it again.
        return
      }
      this.queueInvalidation()
    })()
  }

  private queueInvalidation(): void {
    if (this.closing || this.invalidationQueued) return
    this.invalidationQueued = true
    queueMicrotask(() => {
      this.invalidationQueued = false
      /* v8 ignore next -- Effect teardown can win this queued microtask before provider disposal emits. */
      if (this.closing) return
      this.invalidate()
    })
  }

  private async closeWatcher(watcher: WatchHandle): Promise<void> {
    try {
      await watcher.close()
    } catch (error) {
      this.ctx.logger.warn(`skill-filesystem: failed to close watcher: ${errorMessage(error)}`)
    }
  }
}

async function settleWatcherOpening(opening: Promise<void> | undefined): Promise<void> {
  if (opening === undefined) return
  try {
    await opening
  } catch {
    // Watch startup already logged the underlying failure; teardown only contains it.
  }
}

function resolveWatchConfig(config: Config): ResolvedWatchConfig {
  const stabilityThresholdMs = config.watchStabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_THRESHOLD_MS
  const pollIntervalMs = config.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS
  assertPositiveInteger('watchStabilityThresholdMs', stabilityThresholdMs)
  assertPositiveInteger('watchPollIntervalMs', pollIntervalMs)
  return {
    enabled: config.watch ?? true,
    usePolling: config.watchUsePolling ?? false,
    stabilityThresholdMs,
    pollIntervalMs,
    followSymlinks: config.watchFollowSymlinks ?? true,
    depth: config.discoveryMaxDepth ?? 4,
  }
}

async function resolveRootWatchMode(root: string, followSymlinks: boolean): Promise<RootWatchMode> {
  let candidate = root
  while (true) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) {
        const preserveRootLink = candidate === root
          && !followSymlinks
          && (await lstat(candidate)).isSymbolicLink()
        const anchor = preserveRootLink ? resolve(candidate) : await canonicalizeWatchPath(candidate)
        if (candidate === root) return { kind: 'root', anchor }
        const firstSegment = relative(candidate, root).split(sep)[0]
        /* v8 ignore next -- candidate is a strict ancestor of root. */
        if (firstSegment === undefined || firstSegment.length === 0) return { kind: 'root', anchor }
        return { kind: 'ancestor', anchor, nextPath: join(anchor, firstSegment) }
      }
    } catch (error) {
      /* v8 ignore next -- Non-absence stat failures are platform/permission-specific and propagate as incomplete discovery. */
      if (!isAbsentPathError(error)) throw error
    }
    const parent = dirname(candidate)
    /* v8 ignore next -- Traversal reaches the existing filesystem root before this fallback. */
    if (parent === candidate) return { kind: 'ancestor', anchor: candidate, nextPath: root }
    candidate = parent
  }
}

function sameWatchMode(left: RootWatchMode, right: RootWatchMode): boolean {
  return left.kind === right.kind
    && left.anchor === right.anchor
    && (left.kind === 'root' || (right.kind === 'ancestor' && left.nextPath === right.nextPath))
}

function isRelevantWatchEvent(root: SkillRoot, event: SkillWatchEvent, path: string): boolean {
  const segments = containedSegments(root.path, path)
  if (segments === undefined) return false
  return event === 'addDir' || event === 'unlinkDir' || isPotentialSkillPath(root, path)
}

function isPotentialSkillPath(root: SkillRoot, path: string): boolean {
  const segments = containedSegments(root.path, path)
  if (segments === undefined || !segments.at(-1)?.endsWith('.md')) return false
  const pathKey = segments.join(sep)
  for (const bundle of root.bundles ?? []) {
    if (pathKey.startsWith(bundle + sep) && pathKey !== join(bundle, 'SKILL.md')) return false
  }
  return true
}

function containedSegments(root: string, path: string): string[] | undefined {
  const child = relative(root, path)
  if (child.length === 0) return []
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
  return child.split(sep)
}

function mutationToolName(actor: object | undefined): 'edit' | 'write' | undefined {
  if (actor === undefined || !('name' in actor)) return undefined
  const value = actor.name
  return value === 'edit' || value === 'write' ? value : undefined
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`skill-filesystem: ${field} must be a positive integer`)
  }
}

function isAbsentPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')
}

function isAbsentSkillPathError(error: unknown): boolean {
  return isAbsentPathError(error)
    || hasErrorCode(error, 'FS_NOT_FOUND')
    || hasErrorCode(error, 'FS_NOT_DIRECTORY')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Breadth-first category discovery. A bundle is a leaf, including invalid bundles;
 * references/assets below it can never become independently invocable skills.
 * Canonical directory identities bound symlink aliases/cycles. Truncation is an
 * explicit incomplete observation, never a cacheable claim that discovery finished.
 */
async function discoverRoot(
  root: SkillRoot, ctx: Context, provider: string,
  limits: { maxDepth: number; maxDirectories: number }, signal?: AbortSignal, metadataMaxBytes?: number,
): Promise<SkillProviderObservation> {
  const candidates: SkillCandidate[] = [], visited = new Set<string>()
  root.bundles = new Set()
  // Category segments are the walked directory names, so symlinked folders keep their visible path.
  const pending: { path: string; depth: number; segments: string[] }[] = [{ path: root.path, depth: 0, segments: [] }]
  let complete = true, inspected = 0
  const add = async (path: string, directory: string, bundle: boolean, segments: readonly string[]): Promise<void> => {
    const parsed = await parseSkillFile(path, ctx, signal, root.trustedHost === true,
      metadataMaxBytes === undefined ? undefined : { maxBytes: metadataMaxBytes, metadataOnly: true })
    if (parsed === undefined) return
    const { content: _body, ...metadata } = parsed
    const category = segments.join('/')
    const locator: LocalLocator = { path, directory, bundle }
    candidates.push({ ...metadata, provider, source: root.source, rank: root.rank, ...(category === '' ? {} : { category }),
      locator, resourceBase: { kind: 'directory', path: directory } })
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    signal?.throwIfAborted()
    if (inspected++ >= limits.maxDirectories) { complete = false; break }
    const current = pending[cursor]!
    const listing = await listSkillDirectory({ ...root, path: current.path }, ctx, signal)
    if (listing === undefined || visited.has(listing.identity)) continue
    visited.add(listing.identity)
    const entries = listing.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const bundle = entries.find(entry => entry.name === 'SKILL.md')
    if (bundle !== undefined && current.depth > 0) {
      root.bundles.add(relative(root.path, current.path))
      await add(bundle.path, current.path, true, current.segments.slice(0, -1))
      continue
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      if (entry.type === 'file' && entry.name.endsWith('.md')) await add(entry.path, current.path, false, current.segments)
      else if (entry.type === 'directory') {
        if (current.depth >= limits.maxDepth || pending.length >= limits.maxDirectories) { complete = false; continue }
        pending.push({ path: entry.path, depth: current.depth + 1, segments: [...current.segments, entry.name] })
      }
    }
  }
  return { candidates, complete }
}

/**
 * Level-1 listing of a bundle's supporting files: references/, templates/, scripts/
 * and assets/ in that order, depth-first with code-unit-sorted names, at most
 * {@link MAX_SKILL_RESOURCE_FILES} paths rendering in at most
 * {@link MAX_SKILL_RESOURCE_LISTING_BYTES} bytes. Dot entries, dependency and generated
 * entries (node_modules, __pycache__, *.pyc, ...), unreadable names and anything resolving
 * outside the bundle are skipped, matching what skill_read can open. Depth, directory, file
 * and byte bounds mark the listing truncated. An absent directory is skipped and
 * cancellation propagates; any other failure is logged and marks the listing truncated, so
 * the skill itself stays loadable.
 * @returns the listing, or undefined when the bundle has no supporting files.
 */
async function listBundleFiles(
  directory: string, ctx: Context, trustedHost: boolean, signal?: AbortSignal,
): Promise<SkillResourceFiles | undefined> {
  const fs = trustedHost ? undefined : optionalFileSystem(ctx)
  const paths: string[] = []
  const visited = new Set<string>()
  let truncated = false, listed = 0, bytes = 0
  let base: FsTarget | string
  try {
    base = fs !== undefined ? await fs.resolve(directory, signal === undefined ? undefined : { signal }) : await realpath(directory)
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsentSkillPathError(error)) return undefined
    ctx.logger.warn(`skill-filesystem: cannot list supporting files of ${directory}: ${errorMessage(error)}`)
    return { paths: [], truncated: true }
  }
  const listable = (name: string): boolean => !name.startsWith('.') && !RESOURCE_LISTING_EXCLUDED_NAMES.has(name)
    && !RESOURCE_LISTING_EXCLUDED_SUFFIXES.some(suffix => name.endsWith(suffix))
    && !name.includes('\\') && !hasControlCharacter(name)
  const open = async (path: string): Promise<{ identity: string; entries: SkillRootEntry[] } | undefined> => {
    if (fs !== undefined) {
      const target = await fs.resolve(path, signal === undefined ? undefined : { signal })
      if (!fs.contains(base as FsTarget, target)) return undefined
      const entries = await fs.listDir(target, signal)
      return { identity: String(target.targetKey), entries: entries
        .filter(entry => entry.type !== 'file' || fs.contains(base as FsTarget, entry.target))
        .map(entry => ({ name: entry.name, type: entry.type, path: entry.target.displayPath })) }
    }
    const identity = await realpath(path)
    const inside = relative(base as string, identity)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
    const entries: SkillRootEntry[] = []
    for (const entry of await readdir(path, { withFileTypes: true, encoding: 'utf8' })) {
      const child = join(path, entry.name)
      entries.push({ name: entry.name, type: await nodeEntryKind(child, entry, ctx) ?? 'other', path: child })
    }
    return { identity, entries }
  }
  // Returns true once the file or byte bound is reached; later directories are then not listed.
  const walk = async (path: string, prefix: string, depth: number): Promise<boolean> => {
    if (listed >= RESOURCE_LISTING_MAX_DIRECTORIES) { truncated = true; return true }
    listed += 1
    let listing
    try {
      signal?.throwIfAborted()
      listing = await open(path)
      signal?.throwIfAborted()
    } catch (error) {
      signal?.throwIfAborted()
      if (isAbsentSkillPathError(error)) return false
      ctx.logger.warn(`skill-filesystem: cannot list supporting files in ${path}: ${errorMessage(error)}`)
      truncated = true
      return false
    }
    if (listing === undefined || visited.has(listing.identity)) return false
    visited.add(listing.identity)
    const entries = listing.entries.filter(entry => listable(entry.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const child = `${prefix}/${entry.name}`
      if (entry.type === 'file') {
        const cost = resourceFileLineBytes(child)
        if (paths.length >= MAX_SKILL_RESOURCE_FILES || bytes + cost > MAX_SKILL_RESOURCE_LISTING_BYTES) { truncated = true; return true }
        bytes += cost
        paths.push(child)
      } else if (entry.type === 'directory') {
        if (depth >= RESOURCE_LISTING_MAX_DEPTH) { truncated = true; continue }
        if (await walk(entry.path, child, depth + 1)) return true
      }
    }
    return false
  }
  for (const name of RESOURCE_DIRECTORIES) {
    if (await walk(join(directory, name), name, 0)) break
  }
  return paths.length === 0 && !truncated ? undefined : { paths, truncated }
}

async function listSkillDirectory(root: SkillRoot, ctx: Context, signal?: AbortSignal): Promise<{
  identity: string; entries: SkillRootEntry[]
} | undefined> {
  try {
    signal?.throwIfAborted()
    const fs = root.trustedHost === true ? undefined : optionalFileSystem(ctx)
    if (fs !== undefined) {
      const target = await fs.resolve(root.path, signal === undefined ? undefined : { signal })
      const entries = await fs.listDir(target, signal)
      signal?.throwIfAborted()
      return { identity: String(target.targetKey), entries: entries.map(entry => ({
        name: entry.name, type: entry.type, path: entry.target.displayPath,
      })) }
    }
    const identity = await realpath(root.path)
    const entries: SkillRootEntry[] = []
    for (const entry of await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })) {
      signal?.throwIfAborted()
      const path = join(root.path, entry.name)
      entries.push({ name: entry.name, type: await nodeEntryKind(path, entry, ctx) ?? 'other', path })
    }
    return { identity, entries }
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsentSkillPathError(error)) return undefined
    throw error
  }
}

async function parseSkillFile(
  path: string, ctx: Context, signal?: AbortSignal, trustedHost = false, bounds?: SkillReadBounds,
): Promise<ParsedSkill | undefined> {
  const raw = await readSkillText(ctx, path, signal, trustedHost, bounds)
  signal?.throwIfAborted()
  if (raw === undefined) {
    return undefined
  }
  try { return parseSkillSource(raw.content, raw.path) }
  catch (error) {
    ctx.logger.warn(modelText('runtime/skill-filesystem-index/text-03', { value_1: path, value_2: errorMessage(error) }))
    return undefined
  }
}

/** One parser shared by bounded discovery, explicit loading and pre-publication validation. */
export function parseSkillSource(content: string, path: string): ParsedSkill | undefined {
  const parsed = parseFrontmatter(content)
  if (parsed === undefined) return undefined
  const name = stringField(parsed.data, 'name'), description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined || !isSkillName(name)) return undefined
  const execution = skillExecutionPolicy(parsed.data)
  const invocation = parseInvocationPolicy(parsed.data)
  const conditions = skillToolConditions(parsed.data)
  return { name, description, ...optionalString(parsed.data, 'whenToUse'), invocation,
    ...(execution === undefined ? {} : { execution }), ...(conditions === undefined ? {} : { conditions }),
    ...optionalMetadata(parsed.data), path, content: parsed.body.trim() }
}

function optionalFileSystem(ctx: Context): FileSystem | undefined {
  return ctx.get('fs')
}

interface SkillReadBounds { maxBytes: number; metadataOnly: boolean }

function boundedSkillText(bytes: Uint8Array, bounds: SkillReadBounds, path: string): string {
  if (!bounds.metadataOnly && bytes.length > bounds.maxBytes) {
    throw new Error(modelText('skills/source-too-large', { path, limit: bounds.maxBytes }))
  }
  // Streaming decode tolerates an incomplete final UTF-8 codepoint in a
  // metadata prefix, but never accepts malformed UTF-8 inside the prefix.
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bounds.maxBytes), { stream: bounds.metadataOnly })
  } catch (cause) {
    throw Object.assign(new Error(modelText('skills/not-text', { path }), { cause }), { code: 'FS_NOT_TEXT' })
  }
  if (text.includes('\0')) throw Object.assign(new Error(modelText('skills/not-text', { path })), { code: 'FS_NOT_TEXT' })
  if (bounds.metadataOnly) {
    const first = text.indexOf('\n')
    const closing = first < 0 ? undefined : findClosingFrontmatter(text, first + 1)
    // Do not interpret a delimiter cut at the cap as a complete line.
    if (closing === undefined || (bytes.length > bounds.maxBytes && closing.bodyStart === text.length && !text.endsWith('\n'))) return ''
    text = text.slice(0, closing.bodyStart)
  }
  return text
}

/** The two I/O backends share one absence/text/error policy and one decoder. */
async function readSkillText(
  ctx: Context, path: string, signal?: AbortSignal, trustedHost = false, bounds?: SkillReadBounds,
): Promise<SkillText | undefined> {
  signal?.throwIfAborted()
  try {
    const fs = trustedHost ? undefined : optionalFileSystem(ctx)
    let source: SkillText
    if (fs !== undefined) {
      const target = await fs.resolve(path, signal === undefined ? undefined : { signal })
      signal?.throwIfAborted()
      if ((await fs.stat(target, signal))?.type !== 'file') return undefined
      const content = bounds === undefined ? await fs.readText(target, signal)
        : boundedSkillText(await fs.readByteRange(target, { offset: 0, length: bounds.maxBytes + 1 }, signal), bounds, path)
      source = { path: fs.processPath(target), content }
    } else {
      const resolvedPath = await realpath(path)
      if (bounds === undefined) source = { path: resolvedPath, content: await readFile(resolvedPath, { encoding: 'utf8', signal }) }
      else {
        const handle = await open(resolvedPath, 'r')
        try {
          if (!(await handle.stat()).isFile()) return undefined
          const buffer = Buffer.alloc(bounds.maxBytes + 1)
          let length = 0
          while (length < buffer.length) {
            signal?.throwIfAborted()
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
            if (bytesRead === 0) break
            length += bytesRead
          }
          source = { path: resolvedPath, content: boundedSkillText(buffer.subarray(0, length), bounds, path) }
        } finally { await handle.close() }
      }
    }
    signal?.throwIfAborted()
    return source
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsentSkillPathError(error)) return undefined
    if (!hasErrorCode(error, 'FS_NOT_TEXT')) throw error
    ctx.logger.warn(modelText('skills/not-text', { path }))
    return undefined
  }
}

async function nodeEntryKind(fullPath: string, entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }, ctx: Context): Promise<'directory' | 'file' | undefined> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  /* v8 ignore next -- Non-file directory entries such as FIFOs are platform-specific and intentionally skipped. */
  if (!entry.isSymbolicLink()) return undefined
  try {
    const info = await stat(fullPath)
    if (info.isDirectory()) return 'directory'
    /* v8 ignore else -- the special-file symlink branch relies on POSIX /dev/null. */
    if (info.isFile()) return 'file'
    /* v8 ignore next -- The special-file symlink fixture relies on POSIX /dev/null. */
    return undefined
  } catch (error) {
    ctx.logger.warn(modelText('runtime/skill-filesystem-index/text-04', { value_1: fullPath, value_2: errorMessage(error) }))
    return undefined
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const yaml = raw.slice(start, closing.start)
  const parsed = parseYaml(yaml) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function rejectLegacyInvocationKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(modelText('runtime/skill-filesystem-index/text-05', { value_1: legacy, value_2: canonical }))
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function optionalMetadata(data: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { metadata: value as Record<string, unknown> }
  }
  return {}
}

function errorMessage(error: unknown): string {
  return String(error)
}
