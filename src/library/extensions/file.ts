/** Trusted ESM bundle hot loading. Local code dependencies must be bundled; assets stay relative to the entry. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { watch, type FSWatcher } from 'chokidar'
import type { Plugin } from '../runtime/vendor/cordis/index.ts'
import { snapshotJsonValue } from '../util/values/index.ts'
import type { ExtensionManager, ExtensionState } from './index.ts'

export interface FileExtensionOptions<C = unknown> {
  id: string
  /** Host-trusted bundled ESM (.mjs or .js). The directory must permit temporary snapshot files. */
  file: string
  config: C
  /** Watch content changes and atomic file replacements; default true. */
  watch?: boolean
  debounceMs?: number
  /** Node retains imported ESM modules. Bound new code generations per controller; default 128. */
  maxCodeGenerations?: number
  /** Observational. Rejected callbacks are retained as lastError, not unhandled rejections. */
  onError?: (error: unknown) => void | Promise<void>
}
export interface FileExtensionState extends ExtensionState {
  readonly sourceHash: string
  readonly watching: boolean
  readonly lastError?: unknown
}
export interface FileExtension extends AsyncDisposable {
  snapshot(): FileExtensionState
  reload(): Promise<FileExtensionState>
  updateConfig(config: unknown): Promise<FileExtensionState>
  close(): Promise<void>
}
export class FileExtensionError extends Error {
  constructor(readonly code: 'CLOSED' | 'RELOAD_LIMIT', message: string) { super(message); this.name = 'FileExtensionError' }
}

/** Import the exact captured bytes, not a file that can change between hashing and evaluation. */
export async function loadFileExtension<C>(manager: ExtensionManager, options: FileExtensionOptions<C>): Promise<FileExtension> {
  const id = options.id, filename = resolve(options.file)
  if (!['.mjs', '.js'].includes(extname(filename))) throw new TypeError('Extension entry must be a bundled ESM .mjs or .js file')
  const debounceMs = options.debounceMs ?? 75, maxCodeGenerations = options.maxCodeGenerations ?? 128
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000) throw new TypeError('Invalid reload debounce')
  if (!Number.isSafeInteger(maxCodeGenerations) || maxCodeGenerations < 1) throw new TypeError('Invalid module generation limit')
  const captureConfig = (value: unknown): unknown => {
    const snapshot = snapshotJsonValue(value)
    if (snapshot === undefined && value !== undefined) throw new TypeError('Extension config must be lossless JSON')
    return snapshot
  }
  let config = captureConfig(options.config), state: ExtensionState | undefined, sourceHash = ''
  let closed = false, closeTask: Promise<void> | undefined, watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, pumping: Promise<void> | undefined, dirty = false
  let lastError: unknown, lastTarget = '', imported = 0
  const stopped = new AbortController()
  const code = new Map<string, Plugin<unknown>>()
  const report = (error: unknown): void => {
    lastError = error
    if (options.onError) Promise.resolve().then(() => options.onError!(error)).catch(failure => { lastError = failure })
  }
  const stop = async (): Promise<void> => {
    closed = true
    stopped.abort(new FileExtensionError('CLOSED', 'File extension is closed'))
    clearTimeout(timer)
    await watcher?.close()
    watcher = undefined
    await pumping
  }
  const detach = manager.onClose(stop)
  const snapshot = (): FileExtensionState => {
    if (state === undefined) throw new Error('Extension is not initialized')
    const current = manager.list().find(item => item.id === id)
    return Object.freeze({ ...state, status: current?.revision === state.revision ? current.status : 'failed', sourceHash,
      watching: watcher !== undefined && !closed, ...(lastError === undefined ? {} : { lastError }) })
  }
  const change = async (nextConfig: unknown, initial = false): Promise<FileExtensionState> => {
    if (closed) throw new FileExtensionError('CLOSED', 'File extension is closed')
    const expectedRevision = state?.revision
    const target = await realpath(filename)
    const bytes = await readFile(target)
    const nextHash = createHash('sha256').update(bytes).digest('hex')
    if (closed) throw new FileExtensionError('CLOSED', 'File extension is closed')
    if (!initial && nextHash === sourceHash && target === lastTarget && JSON.stringify(nextConfig) === JSON.stringify(config)
      && manager.list().some(item => item.id === id && item.revision === expectedRevision && item.status === 'active')) return snapshot()
    const load = async (): Promise<Plugin<unknown>> => {
      // Same bytes at a different real path may resolve imports/assets differently.
      const identity = `${target}\0${nextHash}`
      const prior = code.get(identity)
      if (prior !== undefined) return prior
      if (imported >= maxCodeGenerations) throw new FileExtensionError('RELOAD_LIMIT', 'ESM generation limit reached; restart the host to release Node module cache')
      const temporary = join(dirname(target), `.${basename(target)}.io-${randomUUID()}.mjs`)
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      try {
        imported++
        const module = await import(/* @vite-ignore */ pathToFileURL(temporary).href)
        const plugin = Object.hasOwn(module, 'default') ? module.default : module
        // Count imports, including modules later rejected at activation: Node still retains them.
        code.set(identity, plugin as Plugin<unknown>)
        return plugin as Plugin<unknown>
      } finally { await unlink(temporary) }
    }
    const spec = { id, config: nextConfig, load }
    const result = initial ? await manager.install(spec)
      : nextHash === sourceHash && target === lastTarget
        ? await manager.configure(id, nextConfig, expectedRevision!)
        : await manager.replace(spec, expectedRevision!)
    state = result; config = nextConfig; sourceHash = nextHash; lastTarget = target; lastError = undefined
    return snapshot()
  }
  // Coalesce filesystem bursts; a write during an import causes one subsequent read of the newest entry.
  const schedule = (): void => {
    if (closed) return
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (pumping !== undefined || closed) return
      pumping = (async () => {
        while (dirty && !closed) { dirty = false; try { await change(config) } catch (error) { report(error) } }
      })().finally(() => { pumping = undefined })
    }, debounceMs)
    timer.unref()
  }
  try {
    await change(config, true)
    if (options.watch !== false) {
      watcher = watch(filename, { ignoreInitial: true })
      watcher.on('add', schedule).on('change', schedule).on('unlink', schedule).on('error', report)
      await new Promise<void>((resolveReady, reject) => {
        const current = watcher!
        const finish = (error?: unknown): void => {
          current.off('ready', ready).off('error', fail)
          stopped.signal.removeEventListener('abort', abort)
          if (error !== undefined) reject(error); else resolveReady()
        }
        const ready = (): void => { finish() }, fail = (error: unknown): void => { finish(error) }
        const abort = (): void => { finish(stopped.signal.reason) }
        current.once('ready', ready).once('error', fail)
        stopped.signal.addEventListener('abort', abort, { once: true })
        if (stopped.signal.aborted) abort()
      })
      // Cover a replacement in the interval between the initial read and watch readiness.
      if (createHash('sha256').update(await readFile(filename)).digest('hex') !== sourceHash) schedule()
    }
    const controller: FileExtension = {
      snapshot,
      reload: () => change(config),
      updateConfig: value => { try { return change(captureConfig(value)) } catch (error) { return Promise.reject(error) } },
      close: () => closeTask ??= (async () => {
        await stop(); detach()
        const current = manager.list().find(item => item.id === id)
        // A successor installed through the manager belongs to somebody else, not this controller.
        if (current !== undefined && current.revision === state?.revision) {
          try { await manager.remove(id, current.revision) }
          catch (error) { if ((error as {code?: string}).code !== 'CLOSED') throw error }
        }
      })(),
      async [Symbol.asyncDispose]() { await controller.close() },
    }
    return controller
  } catch (error) {
    await stop(); detach()
    if (state !== undefined) {
      try { await manager.remove(id, state.revision) } catch (cleanup) {
        if ((cleanup as {code?: string}).code !== 'CLOSED') throw new AggregateError([error, cleanup], 'File extension startup failed')
      }
    }
    throw error
  }
}
