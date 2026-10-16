/** Duplicate-install-safe JSON and immutable-value helpers. @module io-agent/util-values */

/** A value that round-trips through JSON without loss. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Mark an unreachable closed-union branch.
 * @param value - impossible value; an unhandled typed variant fails at the call site.
 * @param context - optional switch-site label included in the failure message.
 * @returns never; a runtime value that escaped its type always throws.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}

/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isIntrinsicObjectPrototype(objectPrototype)
}

/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null
    || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)
}

/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined
  return keys as string[]
}

/** Cross-realm plain record; hostile reflection is a failed boundary, not a throw. */
export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try { return hasPlainObjectPrototype(value) } catch { return false }
}

/** Schema maps may not hide keys that JSON would drop. Values are checked by the caller. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainJsonRecord(value)) return false
  try { return enumerableStringKeys(value) !== undefined } catch { return false }
}

/** Dense, undecorated array with the intrinsic prototype of its own realm. */
export function isPlainJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false
    return true
  } catch { return false }
}

// Only proven, transitively frozen DATA graphs enter this cache. Object.freeze
// does not make getters stable. A mutable parent or accessor therefore never
// acquires a cached answer, even if it currently returns valid JSON. Weak keys
// do not retain old session messages or tool results.
const jsonObjectPrototype = Object.prototype
const jsonArrayPrototype = Array.prototype
const jsonObjectConstructor = Object
const jsonArrayConstructor = Array

// A frozen record can still inherit a mutable intrinsic prototype. All owned
// snapshots are allocated in this realm; when its prototypes are customized,
// fall back to full validation rather than reusing an old structural answer.
function standardJsonPrototypes(): boolean {
  return Object.getOwnPropertyDescriptor(jsonObjectPrototype, 'constructor')?.value === jsonObjectConstructor
    && Object.getOwnPropertyDescriptor(jsonArrayPrototype, 'constructor')?.value === jsonArrayConstructor
    && Object.getPrototypeOf(jsonArrayPrototype) === jsonObjectPrototype
    && isIntrinsicObjectPrototype(jsonObjectPrototype)
    && hasIntrinsicConstructor(jsonArrayPrototype, 'Array')
}

const frozenJson = new WeakSet<object>()
// Only objects allocated by our detacher have proven non-proxy identity. A
// frozen revocable proxy can stop being JSON tomorrow; never memoize one.
const ownedJsonSnapshots = new WeakSet<object>()

function rememberFrozenJson(value: object): void {
  if (!ownedJsonSnapshots.has(value) || !Object.isFrozen(value)) return
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) return
    const child: unknown = descriptor.value
    if (child !== null && typeof child === 'object' && !frozenJson.has(child)) return
  }
  frozenJson.add(value)
}

type SnapshotDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: JsonValue[]; index: number }
  | { kind: 'object'; target: { [key: string]: JsonValue }; key: string }

type JsonWalkTask =
  | { kind: 'visit'; value: unknown; destination?: SnapshotDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; target?: JsonValue[] }
  | { kind: 'object-property'; source: Record<string, unknown>; key: string; target?: { [key: string]: JsonValue } }
  | { kind: 'leave'; source: object }

/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value: unknown, detach: boolean): JsonValue | true | undefined {
  const ancestors = new Set<object>()
  const reuseFrozen = !detach && standardJsonPrototypes()
  let root: JsonValue | undefined
  const assign = (destination: SnapshotDestination | undefined, item: JsonValue): void => {
    if (destination === undefined) return
    if (destination.kind === 'root') {
      root = item
    } else if (destination.kind === 'array') {
      destination.target[destination.index] = item
    } else {
      Object.defineProperty(destination.target, destination.key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }

  const tasks: JsonWalkTask[] = [{
    kind: 'visit',
    value,
    ...(detach ? { destination: { kind: 'root' } as const } : {}),
  }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      if (!detach) rememberFrozenJson(task.source)
      ancestors.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return undefined
      tasks.push({
        kind: 'visit',
        value: task.source[task.index],
        ...(task.target === undefined ? {} : { destination: { kind: 'array', target: task.target, index: task.index } as const }),
      })
      continue
    }
    if (task.kind === 'object-property') {
      tasks.push({
        kind: 'visit',
        value: task.source[task.key],
        ...(task.target === undefined ? {} : { destination: { kind: 'object', target: task.target, key: task.key } as const }),
      })
      continue
    }

    const current = task.value
    if (current === null) {
      assign(task.destination, null)
      continue
    }
    if (typeof current === 'boolean' || typeof current === 'string') {
      assign(task.destination, current)
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return undefined
      assign(task.destination, current)
      continue
    }
    if (typeof current !== 'object') return undefined
    if (reuseFrozen && frozenJson.has(current)) continue
    if (ancestors.has(current)) return undefined

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return undefined
      const length = current.length
      if (Reflect.ownKeys(current).length !== length + 1) return undefined
      const target = detach ? [] as JsonValue[] : undefined
      if (target !== undefined) { ownedJsonSnapshots.add(target); assign(task.destination, target) }
      ancestors.add(current)
      tasks.push({ kind: 'leave', source: current })
      for (let index = length - 1; index >= 0; index--) {
        tasks.push({ kind: 'array-item', source: current, index, ...(target === undefined ? {} : { target }) })
      }
      continue
    }

    if (!hasPlainObjectPrototype(current)) return undefined
    const keys = enumerableStringKeys(current)
    if (keys === undefined) return undefined
    const target = detach ? {} as { [key: string]: JsonValue } : undefined
    if (target !== undefined) { ownedJsonSnapshots.add(target); assign(task.destination, target) }
    ancestors.add(current)
    tasks.push({ kind: 'leave', source: current })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) return undefined
      tasks.push({ kind: 'object-property', source: current as Record<string, unknown>, key, ...(target === undefined ? {} : { target }) })
    }
  }
  return detach ? root : true
}

/**
 * Validate and detach lossless JSON in one read per property.
 * @param value - candidate value to validate and detach.
 * @returns the detached snapshot, or `undefined` when the value is not losslessly JSON-serializable.
 */
export function snapshotJsonValue<T>(value: T): T | undefined {
  return walkJsonValue(value, true) as T | undefined
}

/**
 * Test the same lossless JSON rules as {@link snapshotJsonValue} without detaching the value.
 * @param value - candidate value to test.
 * @returns whether the value survives a JSON round trip without loss.
 */
export function isJsonValue(value: unknown): boolean {
  return walkJsonValue(value, false) === true
}

/**
 * Compare JSON-compatible values structurally.
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether both values contain the same JSON data.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  const pending: [unknown, unknown][] = [[a, b]]
  const compared = new WeakMap<object, WeakSet<object>>()
  while (pending.length) {
    const [left, right] = pending.pop()!
    if (left === right) continue
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
    const leftArray = Array.isArray(left)
    if (leftArray !== Array.isArray(right)) return false
    if (leftArray && left.length !== (right as unknown[]).length) return false
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    let rights = compared.get(left)
    if (rights?.has(right)) continue
    if (rights === undefined) compared.set(left, rights = new WeakSet())
    rights.add(right)
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false
      pending.push([(left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]])
    }
  }
  return true
}

/**
 * Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
 * @param value - value to freeze.
 * @returns the same value after every reachable enumerable child is frozen.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* v8 ignore next -- the loop condition guarantees one pending task. */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

/**
 * Weak-key lookup with a strongly retained iterable set of associated values.
 *
 * Each value must belong to only one key. The container performs no automatic
 * cleanup; owners delete associations or clear the container at lifecycle end.
 */
export class WeakMapWithValues<Key extends object, Value> {
  private keys = new WeakMap<Key, Value>()
  private readonly valueSet = new Set<Value>()
  /** Live strongly retained values in insertion order. */
  readonly values: ReadonlySet<Value> = this.valueSet

  /**
   * Read the value associated with a key.
   * @param key - weakly held lookup key.
   * @returns the associated value, or absence.
   */
  get(key: Key): Value | undefined {
    return this.keys.get(key)
  }

  /**
   * Test whether a key has an association.
   * @param key - weakly held lookup key.
   * @returns whether the key is present.
   */
  has(key: Key): boolean {
    return this.keys.has(key)
  }

  /**
   * Associate one key with one caller-unique value.
   * @param key - weakly held lookup key.
   * @param value - strongly retained value that belongs to no other key.
   * @returns this container.
   */
  set(key: Key, value: Value): this {
    if (this.keys.has(key)) {
      const previous = this.keys.get(key) as Value
      if (previous === value) return this
      this.valueSet.delete(previous)
    }
    this.keys.set(key, value)
    this.valueSet.add(value)
    return this
  }

  /**
   * Remove one association and its strongly retained value.
   * @param key - weakly held lookup key.
   * @returns whether an association was removed.
   */
  delete(key: Key): boolean {
    if (!this.keys.has(key)) return false
    const value = this.keys.get(key) as Value
    const deleted = this.keys.delete(key)
    this.valueSet.delete(value)
    return deleted
  }

  /** Remove every association and strongly retained value. */
  clear(): void {
    this.keys = new WeakMap()
    this.valueSet.clear()
  }
}
