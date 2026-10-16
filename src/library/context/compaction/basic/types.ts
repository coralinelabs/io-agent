/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module io-agent/compaction-basic/types
 */

import type { LlmCallConfig, Message } from "../../../model/llm/index.ts"
import type { Session } from "../../../session/journal/index.ts"
import type { CheckpointTodo } from "../compaction/checkpoint.ts"

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the model's context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Additional input headroom beyond the actual request output cap. Defaults to `0`. */
  headroomTokens?: number
  /** Recent context retained as a fraction of the available input window. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/**
 * Byte and item budgets for the deterministic checkpoint sections appended
 * after the summarizer's output. Every budget defaults to `0`, which disables
 * the corresponding section.
 */
export interface CheckpointConfig {
  /** Total UTF-8 bytes of quoted user messages, the first message included. io-agent wires `16384`. */
  userMessageBytes?: number
  /** Cap for the session's first user message, which is always kept; at most `userMessageBytes`. io-agent wires `8192`. */
  firstUserMessageMaxBytes?: number
  /** Cap for each other quoted user message. io-agent wires `4096`. */
  userMessageMaxBytes?: number
  /** UTF-8 bytes of anchor values (paths, errors, tests, hashes, URLs). io-agent wires `4096`. */
  anchorBytes?: number
  /** Skills listed as no longer loaded. io-agent wires `20`. */
  maxSkills?: number
  /** Open todo items shown; `0` also stops carrying the list. io-agent wires `50`. */
  maxTodoItems?: number
}

/** Validated checkpoint budgets. */
export type ResolvedCheckpointConfig = Readonly<Required<CheckpointConfig>>

/** A visible successful tool result as a checkpoint reader sees it, with the call that produced it. */
export interface CheckpointToolResult {
  /** Name and raw JSON arguments of the paired call; absent when that call is not visible. */
  readonly call?: { readonly name: string; readonly arguments: string }
  /** The result's text as the context shows it now, blocks joined. */
  readonly text: string
  /** Whether another producer (a pruner) rewrote the result in place after it was appended. */
  readonly rewritten: boolean
  /**
   * The text the call recorded, before any in-place rewrite: `text` itself
   * when not rewritten, else read back through the replacement chain.
   * Absent when that chain cannot be read. Classify this, not `text`: a stub
   * or marker says nothing about what the call returned.
   */
  readonly recordedText?: string
}

/**
 * Capability-owned readers for the facts a checkpoint carries. This backend
 * never parses another capability's tool names or wire formats: the owning
 * libraries export these readers and the host wires them (io-agent:
 * `src/plugins/index.ts`). A missing reader leaves its section empty.
 */
export interface CheckpointReaders {
  /** Skill whose instructions this tool result loaded into the context, if it is such a load. */
  readonly skillLoad?: (result: CheckpointToolResult) => string | undefined
  /** Skill whose instructions this injected message loaded into the context, if it is such an injection. */
  readonly skillInjection?: (message: Message) => string | undefined
  /** The whole todo list this successful tool result wrote, if it is such a write. */
  readonly todoList?: (result: CheckpointToolResult) => readonly CheckpointTodo[] | undefined
}

/**
 * The history a checkpoint condenses: `from` is the earliest original event
 * behind the span (a condensed prior checkpoint stands for the span it
 * replaced, carried as its record's `condensedFrom`), `to` the largest
 * condensed surface-node seq.
 */
export interface CheckpointRange {
  readonly from: number
  readonly to: number
}

/**
 * The checkpoint's pointer to where the condensed messages and results stay
 * in full, for example a history tool's range call. The host renders the
 * whole section; `undefined` leaves it out (for instance for an agent that
 * cannot see that tool). It is the checkpoint's last section and not part of
 * the carried record: each checkpoint renders its own range.
 */
export type CheckpointLogPointer = (range: CheckpointRange, session: Session) => string | undefined

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
  /**
   * Also run the model-free tool-result prune at a step boundary when the
   * session has had no model response for longer than this many milliseconds:
   * the provider's prompt cache has expired by then, so rewriting old results
   * costs no extra cache miss. Prune only, never a summary. Requires `auto`
   * and a mounted tool-result pruner; omitted disables the idle trigger.
   */
  coldCachePruneAfterMs?: number
  /** Budgets for the deterministic checkpoint sections; model-independent. */
  checkpoint?: CheckpointConfig
  /** Readers for skill loads and todo lists; without them those sections stay empty. */
  checkpointReaders?: CheckpointReaders
  /** Pointer section to the full condensed history; omitted, no such section. */
  checkpointLogPointer?: CheckpointLogPointer
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
  readonly coldCachePruneAfterMs?: number
  readonly checkpoint: ResolvedCheckpointConfig
  readonly checkpointReaders: CheckpointReaders
  readonly checkpointLogPointer?: CheckpointLogPointer
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens'> & {
  readonly contextWindow: number
  readonly reservedOutputTokens: number
  readonly thresholdTokens: number
  readonly retainTokens: number
}
