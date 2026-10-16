/**
 * PTC mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
 * text the model programs against (the `tools:sdk` prompt section). Sibling of
 * `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
 * `declare const tools` API) are two projections of the same store.
 * @module io-agent/tools/src/ts-types
 */

import { modelText } from "../context/text/index.ts"
import { foldTree } from '../util/tree.ts'
import type { ToolSchema } from "../model/llm/index.ts"
import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar } from './json-schema.ts'
/** Internal PTC mode projection: the model-facing schema plus the canonical output schema. */
export interface ToolSdkSchema extends ToolSchema {
  /** Validated canonical value returned by the tool binding. */
  output: JsonSchemaNode
}

/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** One `indent`-deep line prefix (two spaces per level). */
function pad(indent: number): string {
  return '  '.repeat(indent)
}

/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return []
  // Collapse prose to stable one-line docs and escape comment closers so a
  // schema description cannot terminate generated JSDoc.
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value: JsonSchemaScalar): string {
  return JSON.stringify(value)
}

/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar(node: Record<string, unknown>, type: string): string {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return renderScalar(node.const as JsonSchemaScalar)
  if (Object.hasOwn(node, 'enum')) {
    return (node.enum as JsonSchemaScalar[]).map(renderScalar).join(' | ')
  }
  return broad
}

/** A composable type document that can be flattened without recursive string concatenation. */
interface TypeDocument {
  readonly parts: readonly (string | TypeDocument)[]
  readonly containsUnionOrIntersection: boolean
}

/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts: readonly (string | TypeDocument)[]): TypeDocument {
  return {
    parts,
    containsUnionOrIntersection: parts.some(part => typeof part === 'string'
      ? part.includes('|') || part.includes('&')
      : part.containsUnionOrIntersection),
  }
}

/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts: (string | TypeDocument)[]): TypeDocument {
  return typeDocumentFrom(parts)
}

/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document: TypeDocument): string {
  const chunks: string[] = []
  const tasks: (string | TypeDocument)[] = [document]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (typeof task === 'string') {
      chunks.push(task)
      continue
    }
    for (let index = task.parts.length - 1; index >= 0; index--) {
      const part = task.parts[index]
      /* v8 ignore next -- the loop is bounded by the captured part count. */
      if (part !== undefined) tasks.push(part)
    }
  }
  return chunks.join('')
}

/** Render the validated tree. The common evaluator owns stack and visit order. */
function renderSupportedSchema(schema: JsonSchemaNode, indent: number): TypeDocument {
  return foldTree<{ node: JsonSchemaNode; indent: number }, TypeDocument>({ node: schema, indent }, ({ node, indent }) => {
    if (node.oneOf !== undefined) return {
      children: node.oneOf.map(node => ({ node, indent })),
      reduce: children => typeDocumentFrom(children.flatMap((child, index) => index ? [' | ', child] : [child])),
    }
    switch (node.type) {
      case undefined: return { value: typeDocument('JsonValue') }
      case 'string': case 'number': case 'integer': case 'boolean': case 'null':
        return { value: typeDocument(renderConstrainedScalar(node as Record<string, unknown>, node.type)) }
      case 'array': return node.items === undefined ? { value: typeDocument('JsonValue[]') } : {
        children: [{ node: node.items, indent }],
        reduce: ([child]) => child!.containsUnionOrIntersection
          ? typeDocument('(', child!, ')[]') : typeDocument(child!, '[]'),
      }
      case 'object': {
        const entries = Object.entries(node.properties ?? {})
        if (!entries.length) return { value: typeDocument(node.additionalProperties === false ? 'Record<string, never>' : 'Record<string, JsonValue>') }
        return {
          children: entries.map(([, node]) => ({ node, indent: indent + 1 })),
          reduce: children => {
            const required = new Set(node.required)
            const parts: (string | TypeDocument)[] = ['{']
            for (const [index, [name, prop]] of entries.entries()) {
              for (const line of docLines(prop.description, indent + 1)) parts.push('\n', line)
              parts.push('\n', `${pad(indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: `, children[index]!, ';')
            }
            parts.push('\n', `${pad(indent)}}`)
            const declared = typeDocumentFrom(parts)
            return node.additionalProperties === false ? declared : typeDocument(declared, ' & Record<string, JsonValue>')
          },
        }
      }
      default: return { value: typeDocument('unknown') }
    }
  })
}

/**
 * Map one enforced JSON-Schema node to a TypeScript type literal. Supports
 * every unified schema construct and returns `unknown` for malformed or
 * unsupported inputs without throwing.
 * @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
 * @param indent - the indentation level for nested object members.
 * @returns the TS type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  try {
    assertSupportedJsonSchema(schema)
    return flattenTypeDocument(renderSupportedSchema(schema, indent))
  } catch {
    return 'unknown'
  }
}

/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = modelText('foundation/tools-ts-types/text-04')

const SDK_PROGRAM_INSTRUCTIONS = modelText('foundation/tools-ts-types/text-05')

/** Whether one string schema accepts the literal used by the bash example. */
function acceptsExampleString(schema: JsonSchemaNode | undefined, value: string): boolean {
  return schema?.type === 'string'
    && (schema.const === undefined || schema.const === value)
    && (schema.enum === undefined || schema.enum.includes(value))
}

/** Render the bash example only when its literal arguments satisfy the current parameter schema. */
function renderBashExample(schemas: ToolSdkSchema[]): string {
  const bash = schemas.find(schema => schema.name === 'bash')
  if (bash === undefined) return ''
  const parameters = bash.parameters as JsonSchemaNode
  if (parameters.type !== 'object') return ''
  const required = parameters.required ?? []
  if (required.some(name => name !== 'command' && name !== 'description')) return ''
  if (!acceptsExampleString(parameters.properties?.command, 'pwd')) return ''
  const needsDescription = required.includes('description')
  if (needsDescription && !acceptsExampleString(parameters.properties?.description, 'Show current directory')) return ''
  const description = needsDescription ? ", description: 'Show current directory'" : ''
  return modelText('foundation/tools-ts-types/text-06', { value_1: String(description) })
}

/**
 * Render the full `tools:sdk` prompt section: the fixed usage instructions
 * plus one `declare const tools` interface covering every given tool.
 * Deterministic — tools are emitted in lexicographic name order, so an
 * unchanged tool set produces byte-identical text across assemblies. The sort
 * is not a total order on byte-equal names, so two schemas sharing a name
 * would render in argument order; the caller's visible-capability map is keyed
 * by name, so the input never carries a duplicate.
 * @param schemas - the tool schemas to declare (the caller excludes
 *   `run_code` itself).
 * @returns the complete section text.
 */
export function renderToolsSdk(schemas: ToolSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const argsMembers: string[] = []
  const outputMembers: string[] = []
  for (const schema of sorted) {
    argsMembers.push(...docLines(schema.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`)
  }
  const argsMap = `interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join('\n')}\n` : ''}}`
  const outputMap = `interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join('\n')}\n` : ''}}`
  const declaration = [
    argsMap,
    outputMap,
    'type ToolName = keyof ToolOutputMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;', '}'].join('\n'),
  ].join('\n\n')
  const jsonValue = 'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }'
  return modelText('foundation/tools-ts-types/text-07', { value_1: String(SDK_INSTRUCTIONS), value_2: String(renderBashExample(sorted)), value_3: String(SDK_PROGRAM_INSTRUCTIONS), value_4: String(jsonValue), value_5: String(declaration) })
}
