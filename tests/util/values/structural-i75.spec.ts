import { describe, expect, it, vi } from 'vitest'
import { deepEqualJson, deepFreeze, isJsonValue, snapshotJsonValue } from '../../../src/library/util/values/index.ts'
import { foldTree } from '../../../src/library/util/tree.ts'
import { validateJsonSchemaValue, type JsonSchemaNode } from '../../../src/library/tools/json-schema.ts'

describe('shared stack-safe tree evaluation', () => {
  it('retains left-to-right entry and post-order reduction including empty branches', () => {
    const visited: number[] = [], reduced: number[] = []
    const result = foldTree<number, number>(3, value => {
      visited.push(value)
      if (value === 0) return { value: 1 }
      return { children: [value - 1, 0], reduce: results => { reduced.push(value); return results.reduce((a, b) => a + b, 0) } }
    })
    expect(result).toBe(4)
    expect(visited).toEqual([3, 2, 1, 0, 0, 0, 0])
    expect(reduced).toEqual([1, 2, 3])
    expect(foldTree<number, undefined>(0, () => ({ children: [], reduce: () => undefined }))).toBeUndefined()
  })
  it('handles deep and wide trees without recursive calls or argument spreads', () => {
    expect(foldTree<number, number>(20000, n => n ? { children: [n - 1], reduce: values => values[0]! + 1 } : { value: 0 })).toBe(20000)
    expect(foldTree<number, number>(-1, n => n < 0 ? { children: Array(100000).fill(0), reduce: v => v.length } : { value: n })).toBe(100000)
  })
  it('does not memoize a shared node whose meaning depends on its visit', () => {
    let visits = 0
    expect(foldTree<number, number>(1, n => n ? { children: [0, 0], reduce: v => v[0]! + v[1]! } : { value: ++visits })).toBe(3)
  })
  it('does not swallow visitor or reducer failures', () => {
    expect(() => foldTree(1, () => { throw new Error('visit') })).toThrow('visit')
    expect(() => foldTree<number, number>(1, () => ({ children: [], reduce: () => { throw new Error('reduce') } }))).toThrow('reduce')
  })
})

describe('JSON contracts used by model context, tools and durable state', () => {
  it('compares deeply nested JSON without overflowing and detects the final difference', () => {
    let a: unknown = 0, b: unknown = 0, c: unknown = 1
    for (let i = 0; i < 15000; i++) { a = { x: a }; b = { x: b }; c = { x: c } }
    expect(deepEqualJson(a, b)).toBe(true)
    expect(deepEqualJson(a, c)).toBe(false)
  })
  it('does not confuse an inherited value with the corresponding own property', () => {
    const inherited = Object.assign(Object.create({ x: 1 }), { y: 1 })
    expect(deepEqualJson({ x: 1 }, inherited)).toBe(false)
    expect(deepEqualJson({ x: 1 }, { x: 1 })).toBe(true)
  })
  it('keeps mutable and accessor JSON validation fresh', () => {
    let value: unknown = 1
    const getter = Object.freeze({ get item() { return value } })
    expect(isJsonValue(getter)).toBe(true)
    value = undefined
    expect(isJsonValue(getter)).toBe(false)
    const inner: { item: unknown } = { item: 1 }, outer = Object.freeze({ inner })
    expect(isJsonValue(outer)).toBe(true)
    inner.item = undefined
    expect(isJsonValue(outer)).toBe(false)
  })
  it('never caches a revocable proxy just because its target is frozen', () => {
    const proxy = Proxy.revocable(Object.freeze({ x: 1 }), {})
    expect(isJsonValue(proxy.proxy)).toBe(true)
    proxy.revoke()
    expect(() => isJsonValue(proxy.proxy)).toThrow()
  })
  it('only memoizes frozen data snapshots, never adopted getters', () => {
    const data = snapshotJsonValue({ x: 1 })!
    let observed: unknown = 1
    Object.defineProperty(data, 'x', { enumerable: true, get: () => observed })
    Object.freeze(data)
    expect(isJsonValue(data)).toBe(true)
    observed = undefined
    expect(isJsonValue(data)).toBe(false)
  })
  it('validates admitted nested values with linear structural reflection, not repeated subtree walks', () => {
    const depth = 180
    let schema: JsonSchemaNode = { type: 'string' }, data: unknown = 'leaf'
    for (let i = 0; i < depth; i++) { schema = { type: 'object', properties: { x: schema } }; data = { x: data } }
    const owned = deepFreeze(snapshotJsonValue(data))
    const keys = vi.spyOn(Reflect, 'ownKeys')
    try {
      expect(validateJsonSchemaValue(schema, owned)).toEqual([])
      expect(keys.mock.calls.length).toBeLessThan(depth * 6)
    } finally { keys.mockRestore() }
    const copy = snapshotJsonValue(owned)
    expect(copy).not.toBe(owned)
    expect(deepEqualJson(copy, owned)).toBe(true)
  })
})

it('revalidates owned frozen JSON if its realm intrinsic prototypes were changed', () => {
  const value = deepFreeze(snapshotJsonValue({ child: [] })!)
  expect(isJsonValue(value)).toBe(true)
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'constructor')!
  try {
    Object.defineProperty(Array.prototype, 'constructor', { ...descriptor, value: function CustomizedArray() {} })
    const valid = isJsonValue(value)
    Object.defineProperty(Array.prototype, 'constructor', descriptor)
    expect(valid).toBe(false)
  } finally { Object.defineProperty(Array.prototype, 'constructor', descriptor) }
  expect(isJsonValue(value)).toBe(true)
})


it('revalidates a cached snapshot when the native constructor name changes', () => {
  const value = deepFreeze(snapshotJsonValue({ child: [] })!)
  expect(isJsonValue(value)).toBe(true)
  const name = Object.getOwnPropertyDescriptor(Array, 'name')!
  try {
    Object.defineProperty(Array, 'name', { ...name, value: 'ChangedArray' })
    const valid = isJsonValue(value)
    Object.defineProperty(Array, 'name', name)
    expect(valid).toBe(false)
  } finally { Object.defineProperty(Array, 'name', name) }
})
