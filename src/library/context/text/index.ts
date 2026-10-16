/**
 * Model-facing language compiled from the editable model-context directory.
 * Interpolation is single-pass: file contents and tool arguments are never templates.
 * @module io-agent/model-context
 */
import { definitions } from "../../../prompts/catalog.generated.ts"

export { MODEL_CONTEXT_REVISION } from "../../../prompts/catalog.generated.ts"

/** Identifier of an asset in the checked model-context manifest. */
export type ModelTextId = keyof typeof definitions

/** Required substitutions for exactly one asset. */
export type ModelTextVariables<K extends ModelTextId> = {
  [P in typeof definitions[K]['parameters'][number]]: string | number
}

type Arguments<K extends ModelTextId> = keyof ModelTextVariables<K> extends never
  ? []
  : [variables: ModelTextVariables<K>]

/**
 * Read one model-facing asset from this build's immutable catalog snapshot.
 * @param id - stable manifest identifier, independent of caller implementation.
 * @param args - exactly the substitutions declared for this asset, when any.
 * @returns text preserving the asset's whitespace and literal substitution values.
 * @throws on an unknown id or missing, extra, inherited, or invalid substitutions.
 */
export function modelText<K extends ModelTextId>(id: K, ...args: Arguments<K>): string {
  if (!Object.hasOwn(definitions, id)) throw new Error(`model-context: unknown asset ${id}`)
  const definition = definitions[id]
  const values: Readonly<Record<string, string | number>> = args[0] ?? {}
  const expected: readonly string[] = definition.parameters
  const keys = Object.keys(values)
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(values, key))) {
    throw new Error(`model-context: ${id} requires exactly [${expected.join(', ')}]`)
  }
  for (const key of keys) {
    const value = values[key]
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`model-context: invalid value for ${id}.${key}`)
    }
  }
  if (expected.length === 0) return definition.text
  return definition.text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_placeholder, key: string) => String(values[key]))
}
