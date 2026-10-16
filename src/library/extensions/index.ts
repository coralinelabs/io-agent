/** Headless live plugin ownership: import/validate first, replace, and restore on activation failure. */
import type { Context, Fiber, Plugin } from '../runtime/vendor/cordis/index.ts'
import { FiberState, resolveConfig } from '../runtime/vendor/cordis/index.ts'
import { snapshotJsonValue } from '../util/values/index.ts'
import { commitLiveChanges, planLiveChanges } from './live.ts'

export interface ExtensionSpec<C = unknown, Parsed = C> {
  /** Stable owner identity, independent of the module's internal plugin name. */
  id: string
  /** Called for every replacement. Return a fresh module/factory to reload code, or the same plugin to reload config. */
  load: () => Plugin<Parsed> | Promise<Plugin<Parsed>>
  /** Declarative JSON configuration; caller mutations cannot silently modify a running generation. */
  config: C
}
export interface ExtensionState {
  readonly id: string
  readonly revision: number
  readonly status: 'active' | 'failed'
}
interface Generation {
  readonly load: (config: unknown) => Promise<Fiber>
  readonly plugin: Plugin
  config: unknown
  revision: number
  fiber: Fiber | undefined
}
export class ExtensionError extends Error {
  constructor(readonly code: 'CLOSED' | 'EXISTS' | 'MISSING' | 'STALE' | 'ACTIVATION' | 'ROLLBACK', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExtensionError'
  }
}

/** Trusted host control. Installing plugins executes host code; this is not a model tool or a sandbox. */
export class ExtensionManager implements AsyncDisposable {
  private readonly generations = new Map<string, Generation>()
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  private closeTask: Promise<void> | undefined
  private revision = 0
  private readonly disposers = new Set<() => void | Promise<void>>()

  constructor(private readonly ctx: Context) {}

  list(): readonly ExtensionState[] {
    return [...this.generations].map(([id, generation]) => Object.freeze({ id, revision: generation.revision,
      status: generation.fiber?.state === FiberState.ACTIVE ? 'active' : 'failed' }))
  }

  install<C, Parsed = C>(spec: ExtensionSpec<C, Parsed>): Promise<ExtensionState> {
    return this.change(spec, undefined)
  }

  /** Compare-and-replace. A stale UI/config watcher cannot overwrite a newer installed generation. */
  replace<C, Parsed = C>(spec: ExtensionSpec<C, Parsed>, expectedRevision: number): Promise<ExtensionState> {
    return this.change(spec, expectedRevision)
  }

  /** Update explicitly live fields without remounting. Ordinary changes use replacement and rollback.
   * All configuration is validated first, through the running fiber's scoped hooks. Old operation
   * snapshots stay immutable; dependencies recreated later receive the latest raw configuration.
   */
  configure(id: string, config: unknown, expectedRevision: number): Promise<ExtensionState> {
    let owned: unknown
    try {
      owned = snapshotJsonValue(config)
      if (owned === undefined && config !== undefined) throw new TypeError('Extension config must be lossless JSON')
    } catch (error) { return Promise.reject(error) }
    return this.enqueue(async () => {
      const current = this.expect(id, expectedRevision)
      const fiber = current.fiber
      const parsed = fiber?.state === FiberState.ACTIVE
        ? fiber.prepareConfig(snapshotJsonValue(owned))
        : resolveConfig({ Config: current.plugin.Config } as Parameters<typeof resolveConfig>[0], snapshotJsonValue(owned))
      const changes = fiber?.state === FiberState.ACTIVE ? planLiveChanges(fiber.config, parsed) : undefined
      if (changes !== undefined) {
        // Trusted schemas/hooks have run. Publication is one synchronous transaction.
        if (this.closing) throw new ExtensionError('CLOSED', 'Extension manager closed during configuration')
        commitLiveChanges(changes)
        fiber!._config = snapshotJsonValue(owned)
        current.config = owned
        current.revision = ++this.revision
      } else {
        try {
          await fiber?.dispose()
          current.fiber = undefined
          const next = await current.load(owned)
          if (this.closing) { await next.dispose(); throw new ExtensionError('CLOSED', 'Extension manager closed during configuration') }
          current.fiber = next
          current.config = owned
          current.revision = ++this.revision
        } catch (error) {
          if (!this.closing) {
            try { current.fiber = await current.load(current.config) }
            catch (rollback) { throw new ExtensionError('ROLLBACK', `Configuration and restoration failed: ${id}`, { cause: new AggregateError([error, rollback]) }) }
          }
          throw new ExtensionError('ACTIVATION', `Extension configuration failed: ${id}`, { cause: error })
        }
      }
      return Object.freeze({ id, revision: current.revision, status: 'active' })
    })
  }

  remove(id: string, expectedRevision: number): Promise<void> {
    return this.enqueue(async () => {
      const current = this.expect(id, expectedRevision)
      await current.fiber?.dispose()
      this.generations.delete(id)
    })
  }

  /** Register owned observation resources; cleanup runs before plugin shutdown. */
  onClose(dispose: () => void | Promise<void>): () => void {
    if (this.closing) throw new ExtensionError('CLOSED', 'Extension manager is closed')
    this.disposers.add(dispose)
    return () => { this.disposers.delete(dispose) }
  }

  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closing = true
    this.closeTask = (async () => {
      const failures: unknown[] = []
      for (const dispose of [...this.disposers].reverse()) {
        try { await dispose() } catch (error) { failures.push(error) }
      }
      this.disposers.clear()
      await this.tail
      for (const generation of [...this.generations.values()].reverse()) {
        try { await generation.fiber?.dispose() } catch (error) { failures.push(error) }
      }
      this.generations.clear()
      if (failures.length) throw new AggregateError(failures, 'Extension manager cleanup failed')
    })()
    return this.closeTask
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ExtensionError('CLOSED', 'Extension manager is closed'))
    const task = this.tail.then(() => {
      if (this.closing) throw new ExtensionError('CLOSED', 'Extension manager is closed')
      return operation()
    })
    this.tail = task.catch(() => {})
    return task
  }

  private expect(id: string, revision: number): Generation {
    const generation = this.generations.get(id)
    if (generation === undefined) throw new ExtensionError('MISSING', `Extension is not installed: ${id}`)
    if (generation.revision !== revision) throw new ExtensionError('STALE', `Extension changed: ${id}`)
    return generation
  }

  private change<C, Parsed>(spec: ExtensionSpec<C, Parsed>, expectedRevision: number | undefined): Promise<ExtensionState> {
    if (!/^[a-zA-Z0-9][\w./-]{0,127}$/.test(spec.id)) return Promise.reject(new TypeError('Invalid extension id'))
    // Snapshot at admission, not after another queued reload or arbitrary module import awaits.
    const id = spec.id
    const importer = spec.load
    let config: C
    try {
      const owned = snapshotJsonValue(spec.config)
      if (owned === undefined && spec.config !== undefined) throw new TypeError('Extension config must be lossless JSON')
      config = owned as C
    } catch (error) { return Promise.reject(error) }
    return this.enqueue(async () => {
      const previous = expectedRevision === undefined ? undefined : this.expect(id, expectedRevision)
      if (previous === undefined && this.generations.has(id)) throw new ExtensionError('EXISTS', `Extension already installed: ${id}`)
      const plugin = await importer()
      if (this.closing) throw new ExtensionError('CLOSED', 'Extension manager closed during import')
      if (typeof plugin !== 'function' && (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function')) {
        throw new TypeError('Extension loader did not return a Cordis plugin')
      }
      // Standard-schema validation before detaching the old generation. Cordis validates again at activation.
      if (plugin.Config !== undefined) resolveConfig({ Config: plugin.Config } as Parameters<typeof resolveConfig>[0], config)
      const load = async (raw: unknown): Promise<Fiber> => {
        const fiber = this.ctx.plugin(plugin, snapshotJsonValue(raw) as Parsed)
        try {
          await fiber.await()
          if (fiber.state !== FiberState.ACTIVE) throw new Error('Extension has unavailable dependencies')
          return fiber
        } catch (error) {
          await fiber.dispose()
          throw error
        }
      }
      try {
        await previous?.fiber?.dispose()
        if (previous !== undefined) previous.fiber = undefined
        const fiber = await load(config)
        if (this.closing) { await fiber.dispose(); throw new ExtensionError('CLOSED', 'Extension manager closed during activation') }
        const revision = ++this.revision
        this.generations.set(id, { load, plugin, config, fiber, revision })
        return Object.freeze({ id, revision, status: 'active' })
      } catch (error) {
        if (previous !== undefined && !this.closing) {
          try { previous.fiber = await previous.load(previous.config) } catch (rollback) {
            throw new ExtensionError('ROLLBACK', `Replacement and restoration failed: ${id}`, { cause: new AggregateError([error, rollback]) })
          }
        }
        throw new ExtensionError('ACTIVATION', `Extension activation failed: ${id}`, { cause: error })
      }
    })
  }
}

/** Scope the manager to the host lifecycle. Async close waits queued imports and plugin resource release. */
export function createExtensionManager(ctx: Context): ExtensionManager {
  const manager = new ExtensionManager(ctx)
  ctx.effect(() => () => manager.close())
  return manager
}

export type { Context, Plugin } from '../runtime/vendor/cordis/index.ts'
export { loadFileExtension, FileExtensionError } from './file.ts'
export type { FileExtensionOptions, FileExtension, FileExtensionState } from './file.ts'

export { liveConfig } from './live.ts'
export type { LiveConfig, LiveSnapshot } from './live.ts'
