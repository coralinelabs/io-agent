import type { ToolCallId } from "../../../model/llm/index.ts"
import type { Session } from "../../../session/journal/index.ts"
import type { SessionSeq } from "../../../session/journal/types.ts"

/** Optional working-set policy; omitted preserves the inherited pruning behavior. */
export interface PruneRetentionPolicy {
  /** Keep complete newest turn/step tool-result groups, not merely the last N parallel calls. */
  keepRecentToolGroups?: number
  /** Leave failed tool results intact for diagnosis. Broader compaction can still summarize them. */
  preserveErrors?: boolean
  /** Leave results with images/other non-text blocks intact. */
  preserveMedia?: boolean
  /** Do not rewrite the surface unless the complete planned pass saves this many code points. */
  minimumSavingsChars?: number
  /**
   * Replace results at least this many tool groups old (0 = the newest group)
   * with a one-line stub (tool, key argument, size, exit marker, pointer to
   * the full result) instead of a head/tail excerpt. Must be at least
   * `keepRecentToolGroups`; omitted keeps head/tail for every pruned result.
   */
  stubAfterToolGroups?: number
  /** Stub only results longer than this many code points. Defaults to `thresholdChars`. */
  stubMinChars?: number
  /**
   * Tool whose results may be loaded skill bodies, recognized by
   * `formats.skillBodyName` (required with this key). Such a body is never
   * cut partway: it stays verbatim while that skill was requested within
   * `keepRecentSkillToolGroups`, otherwise it is replaced by the canonical
   * skill-removed marker. Omitted treats skill results like any other result.
   */
  skillToolName?: string
  /** Protect a skill body while its newest request is younger than this many tool groups. Defaults to `stubAfterToolGroups`, else `keepRecentToolGroups`. */
  keepRecentSkillToolGroups?: number
}

/**
 * Result formats owned by particular tools or policies that the pruner reads
 * but does not own. The composition layer supplies them, so this generic
 * pruner never imports the shell, skill, spill or history-tool modules. The
 * text formats are pure functions of the recorded text; every rewrite is
 * durable, so resume and replay read stubs and markers back byte-identically.
 * An omitted format is simply not recognized.
 */
export interface ToolResultFormats {
  /** The skill name when `text` is a loaded skill body of `retention.skillToolName`, else `undefined`. */
  readonly skillBodyName?: (text: string) => string | undefined
  /**
   * Split a trailing retrieval notice (for example the spill policy's) off a
   * result: the inline part it kept and the notice, which a stub keeps
   * verbatim as its pointer. `undefined` when the text carries no notice.
   */
  readonly retrievalNotice?: (text: string) => { readonly body: string; readonly notice: string } | undefined
  /** Per tool name: the terminal outcome marker a result ended with (for example `[exit code: 2]`), else `undefined`. */
  readonly outcomeMarkers?: Readonly<Record<string, (text: string) => string | undefined>>
  /**
   * The pointer a stub gives to the recorded result's journal event when no
   * retrieval notice names it, for example a history tool's call visible to
   * the session's agent; `undefined` keeps the generic session-log pointer.
   * Read once, when the stub is written; the stub is durable after that.
   */
  readonly logPointer?: (seq: SessionSeq, session: Session) => string | undefined
  /**
   * Visible results that point the model at an earlier visible result
   * instead of repeating it (a re-read's "unchanged" notice), each mapped to
   * the seq of the result it points at. The pruner keeps a pointed-at result
   * verbatim while a result pointing at it is younger than
   * `retention.keepRecentToolGroups`, the window that keeps the pointer
   * itself, so a recent pointer never stands for content that is gone. Read
   * once per pass.
   */
  readonly pointedResults?: (session: Session) => ReadonlyMap<SessionSeq, SessionSeq>
}

/** Character-budget policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  retention?: PruneRetentionPolicy
  /** Tool-owned result formats used to build stubs and skill markers. */
  formats?: ToolResultFormats
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
}

/** Validated, detached, deeply immutable pruning configuration. */
export interface ResolvedConfig {
  readonly retention?: Readonly<PruneRetentionPolicy>
  readonly formats?: Readonly<ToolResultFormats>
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

/** How a pruned result was rewritten: a head/tail excerpt, a one-line stub, or the skill-removed marker. */
export type PruneKind = 'head-tail' | 'stub' | 'skill'

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: SessionSeq
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
  /** Which rewrite landed. */
  readonly kind: PruneKind
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
