/** Canonical wire schemas: stable prefixes without freezing live capability availability.
 * Reorders object keys only; never reorders examples, enum values or tuple schemas.
 * Like ZCode's builder, tools stay in the tools field, not duplicated in system text.
 */
import type { ToolSchema } from '../model/llm/index.ts'
import { snapshotJsonValue, type JsonValue } from '../util/values/index.ts'

export function canonicalJson(value: unknown): JsonValue {
  const detached = snapshotJsonValue(value)
  if (detached === undefined) throw new TypeError('model schema must be lossless JSON')
  // snapshotJsonValue validates before this narrowing. Iterative traversal retains
  // its support for deeply nested plain JSON without overflowing the JS call stack.
  const root = detached as JsonValue
  const pending = [root]
  while (pending.length) {
    const item = pending.pop()!
    if (item === null || typeof item !== 'object') continue
    if (Array.isArray(item)) { for (const value of item) pending.push(value); continue }
    const entries = Object.keys(item).sort().map(key => [key, item[key]!] as const)
    for (const key of Object.keys(item)) delete item[key]
    for (const [key, value] of entries) {
      Object.defineProperty(item, key, { value, enumerable: true, writable: true, configurable: true })
      pending.push(value)
    }
  }
  return root
}

/** Retain explicit tool-array ordering, but reject ambiguous names at the wire boundary. */
export function stableToolSchemas(tools: readonly ToolSchema[]): ToolSchema[] {
  const names = new Set<string>()
  return tools.map(tool => {
    if (names.has(tool.name)) throw new TypeError(`duplicate model tool: ${tool.name}`)
    names.add(tool.name)
    const parameters = canonicalJson(tool.parameters)
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) throw new TypeError('tool parameters must be an object')
    return { name: tool.name, description: tool.description, parameters }
  })
}
