/**
 * Load-time validation and routed-model policy resolution for compaction-basic.
 *
 * @module io-agent/compaction-basic/config
 */

import type { LlmCallConfig } from "../../../model/llm/index.ts"
import { deepFreeze } from "../../../util/values/index.ts"
import type {
  BasicCompactionConfig,
  CheckpointConfig,
  CheckpointLogPointer,
  CheckpointReaders,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCheckpointConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Fields shared by top-level defaults and exact-target overrides. */
const POLICY_CONFIG_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
] as const

/** Complete public top-level configuration key set. */
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_CONFIG_KEYS,
  'modelPolicies',
  'auto',
  'coldCachePruneAfterMs',
  'checkpoint',
  'checkpointReaders',
  'checkpointLogPointer',
])

/**
 * Checkpoint sections are off unless the host opts in: this backend stays a
 * plain summary checkpoint for other compositions, and io-agent's runtime wires
 * explicit budgets in `src/plugins`. Every key not configured defaults to `0`.
 */
export const DEFAULT_CHECKPOINT_CONFIG: ResolvedCheckpointConfig = Object.freeze({
  userMessageBytes: 0,
  firstUserMessageMaxBytes: 0,
  userMessageMaxBytes: 0,
  anchorBytes: 0,
  maxSkills: 0,
  maxTodoItems: 0,
})

/** Complete checkpoint budget key set. */
const CHECKPOINT_CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CHECKPOINT_CONFIG))

/** Complete checkpoint reader key set. */
const CHECKPOINT_READER_KEYS: ReadonlySet<string> = new Set(['skillLoad', 'skillInjection', 'todoList'])

/** Complete exact-target override key set. */
const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  ...POLICY_CONFIG_KEYS,
])

/** Target-specific pressure configuration failure eligible for warning suppression. */
export class TargetPressureConfigError extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(readonly targetKey: string, message: string) {
    super(message)
  }
}

/**
 * Resolve and validate service defaults plus exact-target partial overrides.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable defaults and validated exact-target overrides.
 */
export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  validatePolicy(config, 'BasicCompactionConfig')
  if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    throw new Error('BasicCompactionConfig: auto must be a boolean')
  }
  if (config.coldCachePruneAfterMs !== undefined) {
    assertPositiveInteger('BasicCompactionConfig.coldCachePruneAfterMs', config.coldCachePruneAfterMs)
  }

  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO })
  validateRatioRetention(thresholdRatio, retention, 'BasicCompactionConfig')
  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `BasicCompactionConfig: modelPolicies[${index}]`,
    )
  }

  return deepFreeze({
    thresholdRatio,
    headroomTokens: config.headroomTokens ?? 0,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    modelPolicies,
    auto: config.auto ?? true,
    ...config.coldCachePruneAfterMs === undefined ? {} : { coldCachePruneAfterMs: config.coldCachePruneAfterMs },
    checkpoint: resolveCheckpointConfig(config.checkpoint),
    checkpointReaders: resolveCheckpointReaders(config.checkpointReaders),
    ...config.checkpointLogPointer === undefined ? {} : { checkpointLogPointer: resolveLogPointer(config.checkpointLogPointer) },
  })
}

/**
 * Validate the host's checkpoint log pointer.
 * @param pointer - untrusted `checkpointLogPointer` member.
 * @returns the function itself.
 */
function resolveLogPointer(pointer: unknown): CheckpointLogPointer {
  if (typeof pointer !== 'function') throw new Error('BasicCompactionConfig.checkpointLogPointer must be a function')
  return pointer as CheckpointLogPointer
}

/**
 * Validate the capability-owned checkpoint readers.
 * @param readers - untrusted `checkpointReaders` member.
 * @returns a detached reader table; empty when none are configured.
 */
export function resolveCheckpointReaders(readers: CheckpointReaders | undefined): CheckpointReaders {
  if (readers === undefined) return {}
  if (!isUnknownRecord(readers)) throw new Error('BasicCompactionConfig.checkpointReaders must be an object')
  validateKeys(readers, CHECKPOINT_READER_KEYS, 'BasicCompactionConfig.checkpointReaders')
  for (const [key, reader] of Object.entries(readers)) {
    if (reader !== undefined && typeof reader !== 'function') {
      throw new Error(`BasicCompactionConfig.checkpointReaders.${key} must be a function`)
    }
  }
  return { ...readers }
}

/**
 * Validate checkpoint budgets and fill defaults per key.
 * @param config - untrusted `checkpoint` member.
 * @returns detached budgets.
 */
export function resolveCheckpointConfig(config: CheckpointConfig | undefined): ResolvedCheckpointConfig {
  if (config === undefined) return DEFAULT_CHECKPOINT_CONFIG
  if (!isUnknownRecord(config)) throw new Error('BasicCompactionConfig.checkpoint must be an object')
  validateKeys(config, CHECKPOINT_CONFIG_KEYS, 'BasicCompactionConfig.checkpoint')
  const resolved: Record<keyof ResolvedCheckpointConfig, number> = { ...DEFAULT_CHECKPOINT_CONFIG }
  for (const key of Object.keys(DEFAULT_CHECKPOINT_CONFIG) as (keyof ResolvedCheckpointConfig)[]) {
    const value: unknown = config[key]
    if (value === undefined) continue
    assertNonNegativeInteger(`BasicCompactionConfig.checkpoint.${key}`, value)
    resolved[key] = value
  }
  if (resolved.firstUserMessageMaxBytes > resolved.userMessageBytes) {
    throw new Error(
      `BasicCompactionConfig.checkpoint: firstUserMessageMaxBytes (${resolved.firstUserMessageMaxBytes}) `
      + `must not exceed userMessageBytes (${resolved.userMessageBytes})`,
    )
  }
  return Object.freeze(resolved)
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - validated service defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns detached immutable policy before model-capacity scaling.
 */
export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): ResolvedTargetPolicy {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const inheritedRetention: ResolvedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  })
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @param reservedOutputTokens - cap of the actual primary request, not summary or lifetime usage.
 *   Zero for an uncapped request; this function does not invent a generation cap.
 * @returns detached immutable pressure and retention budgets.
 */
export function resolveCompactSpec(
  policy: ResolvedTargetPolicy,
  contextWindow: number,
  reservedOutputTokens = 0,
): ResolvedCompactSpec {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`,
    )
  }
  if (!Number.isSafeInteger(reservedOutputTokens) || reservedOutputTokens < 0 || reservedOutputTokens >= contextWindow) {
    throw new TargetPressureConfigError(targetKey,
      `BasicCompactionConfig: reservedOutputTokens (${reservedOutputTokens}) must be a non-negative integer smaller than contextWindow (${contextWindow})`)
  }
  const inputWindow = contextWindow - reservedOutputTokens
  const thresholdTokens = Math.min(Math.floor(contextWindow * policy.thresholdRatio), inputWindow - policy.headroomTokens)
  if (thresholdTokens <= 0) {
    throw new TargetPressureConfigError(targetKey,
      `BasicCompactionConfig: headroomTokens (${policy.headroomTokens}) leaves no input capacity for ${targetKey}`)
  }
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(inputWindow * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens `
      + `(${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    reservedOutputTokens,
    headroomTokens: policy.headroomTokens,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  })
}

/** Choose an explicit retention form or inherit the already-resolved fallback. */
function resolveRetention(
  config: CompactionPolicyConfig,
  fallback: ResolvedRetention,
): ResolvedRetention {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens }
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio }
  return fallback
}

/** Reject a capacity-independent retention conflict at plugin load. */
function validateRatioRetention(
  thresholdRatio: number,
  retention: ResolvedRetention,
  name: string,
): void {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than `
      + `the resolved thresholdRatio (${thresholdRatio})`,
    )
  }
}

/** Validate, detach, and reject duplicate exact-target policies. */
function resolveModelPolicies(configured: unknown): ModelCompactPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) {
    throw new Error('BasicCompactionConfig: modelPolicies must be an array')
  }
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    assertModelPolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) {
      throw new Error(
        `BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`,
      )
    }
    seen.add(key)
    return { ...source }
  })
}

/** Validate one untrusted exact-target override and narrow its public type. */
function assertModelPolicy(
  source: unknown,
  name: string,
): asserts source is ModelCompactPolicyConfig {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, MODEL_POLICY_KEYS, name)
  assertNonEmptyString(`${name}.provider`, source.provider)
  assertNonEmptyString(`${name}.model`, source.model)
  validatePolicy(source, name)
}

/** Validate the fields common to defaults and exact-target partial overrides. */
function validatePolicy(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const thresholdRatio = config.thresholdRatio
  if (config.headroomTokens !== undefined) assertNonNegativeInteger(`${name}.headroomTokens`, config.headroomTokens)
  const retainRatio = config.retainRatio
  const retainTokens = config.retainTokens
  const maxTokens = config.maxTokens
  const compactionRetries = config.compactionRetries
  const maxOverflowRetries = config.maxOverflowRetries
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio)
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio)
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens)
  if (retainRatio !== undefined && retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`)
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens)
  if (compactionRetries !== undefined) {
    assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries)
  }
  if (maxOverflowRetries !== undefined) {
    assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries)
  }

  validateSummarizationPair(config, name)
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error(`${name}.summarizationProvider must be a string`)
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`${name}.summarizationModel must be a string`)
  }
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined
    || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together `
      + 'as an empty or non-empty pair',
    )
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}
