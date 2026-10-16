/** Explicit live configuration: immutable operation snapshots, stable references, no hidden watchers.
 * Informed by DSH's volatile config protocol; this is independent of its YAML loader/application.
 */
import { deepEqualJson, deepFreeze, snapshotJsonValue } from '../util/values/index.ts'

const write = Symbol.for('io-agent.live-config.write')
export type LiveSnapshot<T> = T extends object ? { readonly [K in keyof T]: LiveSnapshot<T[K]> } : T
export interface LiveConfig<T> { get(): LiveSnapshot<T> }
type Writable = LiveConfig<unknown> & { [write](value: unknown): void }

/** Use as a schema transform, e.g. z.object({ limit: z.number() }).transform(liveConfig).
 * Keep the reference; capture get() once at an operation's decision/admission boundary.
 */
export function liveConfig<T>(value: T): LiveConfig<T> {
  const copy = snapshotJsonValue(value)
  if (copy === undefined && value !== undefined) throw new TypeError('Live config must be lossless JSON or undefined')
  let current = deepFreeze(copy)
  return Object.freeze({ get: () => current, [write]: (next: T) => { current = next } }) as LiveConfig<T>
}
function isLive(value: unknown): value is Writable {
  return typeof value === 'object' && value !== null
    && typeof (value as Writable).get === 'function' && typeof (value as Writable)[write] === 'function'
}
function plain(value: object): boolean {
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
}
export interface LiveChange { readonly path: readonly string[]; readonly target: LiveConfig<unknown>; readonly value: unknown }

/** Undefined means ordinary config changed: perform the normal replacement lifecycle.
 * Build the entire plan before changing any reference. Opaque/cyclic config is conservatively remounted.
 */
export function planLiveChanges(before: unknown, after: unknown): LiveChange[] | undefined {
  const changes: LiveChange[] = []
  const targets = new Map<LiveConfig<unknown>, unknown>()
  const seen = new WeakSet<object>()
  const pending: { a: unknown; b: unknown; path: string[] }[] = [{ a: before, b: after, path: [] }]
  while (pending.length) {
    const { a, b, path } = pending.pop()!
    if (isLive(a) || isLive(b)) {
      if (!isLive(a) || !isLive(b)) return
      const value = b.get()
      if (targets.has(a) && !deepEqualJson(targets.get(a), value)) return
      if (!targets.has(a) && !deepEqualJson(a.get(), value)) changes.push({ path, target: a, value })
      targets.set(a, value)
      continue
    }
    if (Object.is(a, b)) continue
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object'
      || !plain(a) || !plain(b) || Array.isArray(a) !== Array.isArray(b)) return
    if (seen.has(a)) return
    seen.add(a)
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return
    const keys = Reflect.ownKeys(a)
    if (keys.length !== Reflect.ownKeys(b).length) return
    for (const key of keys) {
      const x = Object.getOwnPropertyDescriptor(a, key), y = Object.getOwnPropertyDescriptor(b, key)
      if (typeof key !== 'string' || !x || !y || !('value' in x) || !('value' in y)) return
      pending.push({ a: x.value, b: y.value, path: [...path, key] })
    }
  }
  return changes
}

/** Commit a prevalidated plan synchronously; no await or plugin callback sees a partial update. */
export function commitLiveChanges(changes: readonly LiveChange[]): void {
  for (const change of changes) (change.target as Writable)[write](change.value)
}
