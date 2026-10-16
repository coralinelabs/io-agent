/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module io-agent/settings/redact
 */

import type z from "../vendor/schemastery/index.ts"

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema; the wrapped schema of `transform` and a built `lazy`. */
  inner?: SchemaNode
  /** `tuple` element schemas; `union`/`intersect` branches. */
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Store a key as own data, so a JSON key such as `__proto__` cannot re-parent the copy. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Whether a schema declares a secret anywhere below this node. A `lazy` node
 * whose schema is not built yet cannot be inspected and counts as declaring one.
 */
function declaresSecret(node: SchemaNode | undefined, seen: Set<SchemaNode>): boolean {
  if (node === undefined || seen.has(node)) return false
  seen.add(node)
  if (node.meta?.role === 'secret') return true
  if (node.type === 'lazy' && typeof node.inner?.type !== 'string') return true
  return [...Object.values(node.dict ?? {}), node.inner, ...node.list ?? []]
    .some(child => declaresSecret(child, seen))
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (Object.hasOwn(properties, key)) continue
          setOwn(rebuilt, key, entry)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined, [...path, key], secrets)
        if (stripped !== undefined) setOwn(rebuilt, key, stripped)
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) setOwn(rebuilt, key, stripped)
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    case 'tuple': {
      if (!Array.isArray(value)) return value
      const items = node.list ?? []
      // Elements past the declared list carry no schema, as for an array without one.
      return value.map((entry, index) => walk(items[index], entry, [...path, String(index)], secrets))
    }
    case 'lazy':
      if (typeof node.inner?.type === 'string') return walk(node.inner, value, path, secrets)
      break
    default:
      break
  }
  // Fail closed: a secret declared below a union, intersection, transform or
  // unbuilt lazy schema cannot be located field by field in the value, so the
  // whole value is withheld and its position recorded. Leaves and composites
  // that declare no secret pass through.
  if (!declaresSecret(node, new Set())) return value
  secrets.push({ path, set: value !== undefined })
  return undefined
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows `object`, `dict`, `array` and `tuple` containers and built
 * `lazy` schemas field by field. Below any other composite (a union branch,
 * an intersection, a transform) a secret cannot be located in the value, so
 * the whole value at that position is withheld and recorded as one secret
 * slot instead of being returned. The input is never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  return { value: stripped, secrets }
}
