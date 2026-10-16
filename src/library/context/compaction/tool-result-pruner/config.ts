/** Configuration resolution for deterministic tool-result pruning. */

import { modelText } from "../../text/index.ts"
import { deepFreeze } from "../../../util/values/index.ts"
import type { PruneRetentionPolicy, ResolvedConfig, ToolResultFormats, ToolResultPruneConfig } from './types.ts'

/** Fixed marker substituted for every removed middle span. */
export const PRUNE_MARKER = modelText('compaction/pruned-tool-result')

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
  'retention',
  'formats',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars, retention, formats)',
      )
    }
  }

  const retention = config.retention === undefined ? undefined : resolveRetention(config.retention)
  const formats = config.formats === undefined ? undefined : resolveFormats(config.formats)
  if (retention?.skillToolName !== undefined && formats?.skillBodyName === undefined) {
    throw new TypeError('retention.skillToolName requires formats.skillBodyName to recognize a loaded skill body')
  }
  const resolved: ResolvedConfig = {
    ...(retention === undefined || Object.keys(retention).length === 0 ? {} : { retention }),
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)

  const emittedChars = resolved.headChars
    + codePointLength(PRUNE_MARKER)
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  const frozen = deepFreeze(structuredClone(resolved))
  // Formats are functions: frozen as given, never cloned.
  return formats === undefined ? frozen : Object.freeze({ ...frozen, formats })
}

/**
 * Look up the outcome-marker format registered for one tool, ignoring
 * inherited properties (a tool named `constructor` has no format).
 * @param formats - resolved formats, if any.
 * @param tool - tool name the model called.
 * @returns the tool's marker parser, or `undefined`.
 */
export function outcomeMarkerFormat(
  formats: Readonly<ToolResultFormats> | undefined,
  tool: string,
): ((text: string) => string | undefined) | undefined {
  const markers = formats?.outcomeMarkers
  return markers !== undefined && Object.hasOwn(markers, tool) ? markers[tool] : undefined
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}

/** Validate policy without introducing another session state or scheduling service. */
function resolveRetention(value: PruneRetentionPolicy): PruneRetentionPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('retention must be an object')
  const allowed = new Set(['keepRecentToolGroups', 'preserveErrors', 'preserveMedia', 'minimumSavingsChars',
    'stubAfterToolGroups', 'stubMinChars', 'skillToolName', 'keepRecentSkillToolGroups'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown retention key: ${key}`)
  for (const key of ['keepRecentToolGroups', 'minimumSavingsChars', 'stubAfterToolGroups', 'stubMinChars', 'keepRecentSkillToolGroups'] as const) {
    const field = value[key]
    if (field !== undefined && (!Number.isSafeInteger(field) || field < 0)) throw new TypeError(`${key} must be a non-negative safe integer`)
  }
  for (const key of ['preserveErrors', 'preserveMedia'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError(`${key} must be boolean`)
  }
  if (value.stubAfterToolGroups !== undefined && value.stubAfterToolGroups < (value.keepRecentToolGroups ?? 0)) {
    throw new TypeError('stubAfterToolGroups must be at least keepRecentToolGroups')
  }
  if (value.skillToolName !== undefined && (typeof value.skillToolName !== 'string' || value.skillToolName.length === 0)) {
    throw new TypeError('skillToolName must be a non-empty string')
  }
  return { ...value }
}

/**
 * Validate tool-owned formats: plain functions only, frozen, never cloned.
 * Absent and empty entries are dropped (plugin schema resolution fills an
 * omitted `formats` with an empty marker map), so no formats resolves like none.
 */
function resolveFormats(value: ToolResultFormats): Readonly<ToolResultFormats> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('formats must be an object')
  const allowed = new Set(['skillBodyName', 'retrievalNotice', 'outcomeMarkers', 'logPointer', 'pointedResults'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown formats key: ${key}`)
  for (const key of ['skillBodyName', 'retrievalNotice', 'logPointer', 'pointedResults'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'function') throw new TypeError(`formats.${key} must be a function`)
  }
  const markers = value.outcomeMarkers
  if (markers !== undefined && (markers === null || typeof markers !== 'object' || Array.isArray(markers)
    || Object.values(markers).some(parse => typeof parse !== 'function'))) {
    throw new TypeError('formats.outcomeMarkers must map tool names to functions')
  }
  const resolved: ToolResultFormats = {
    ...value.skillBodyName === undefined ? {} : { skillBodyName: value.skillBodyName },
    ...value.retrievalNotice === undefined ? {} : { retrievalNotice: value.retrievalNotice },
    ...value.logPointer === undefined ? {} : { logPointer: value.logPointer },
    ...value.pointedResults === undefined ? {} : { pointedResults: value.pointedResults },
    ...markers === undefined || Object.keys(markers).length === 0 ? {} : { outcomeMarkers: Object.freeze({ ...markers }) },
  }
  return Object.keys(resolved).length === 0 ? undefined : Object.freeze(resolved)
}
