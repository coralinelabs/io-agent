/**
 * Compaction checkpoint source: the correlated constructor and type
 * every backend uses for its replacement user message, plus the predicate that
 * recognizes persisted checkpoints.
 *
 * The seam itself lives in `io-agent/compaction`, which re-exports these
 * contracts; this module is a pure type/value/predicate outlet (no cordis
 * imports, no module augmentation) so client and wire programs can name the
 * checkpoint source without loading the host plugin's Context merges — the
 * `dsh-commands/brand` shape.
 *
 * @module io-agent/compaction/checkpoint
 */

import type { MessageSource } from "../../../model/llm/message.ts"
import type { CommandId } from "../../../interaction/commands/brand.ts"
import type { CompactionId } from './brand.ts'

const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'plugin', plugin: 'compact' } as const)

/** One user message carried verbatim (after a deterministic byte cut) by a checkpoint. */
export interface CheckpointUserEntry {
  /** Log seq of the authored message the text came from. */
  readonly seq: number
  /** The user's own text as the checkpoint quotes it; carried forward unchanged. */
  readonly text: string
  /** Marks the session's first user message, which later checkpoints always keep. */
  readonly first?: true
}

/** One todo item carried by a checkpoint, taken from the model's last successful `todo_write`. */
export interface CheckpointTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** Anchor categories, in rendered order. */
export const CHECKPOINT_ANCHOR_KINDS = ['files', 'errors', 'tests', 'commits', 'urls'] as const

/** One anchor category. */
export type CheckpointAnchorKind = typeof CHECKPOINT_ANCHOR_KINDS[number]

/** One exact identifier and how often it occurred in the conversations condensed so far. */
export interface CheckpointAnchor {
  readonly value: string
  readonly count: number
}

/** Rendered anchors by category, each in ranked order; empty categories are absent. */
export type CheckpointAnchors = { readonly [Kind in CheckpointAnchorKind]?: readonly CheckpointAnchor[] }

/**
 * Structured facts a checkpoint carries beside its model-facing text, so the
 * next compaction can carry them forward mechanically instead of asking the
 * summarizer to reproduce them. The rendered sections are derived from it
 * deterministically; nothing here is model output.
 */
export interface CheckpointRecord {
  readonly version: 1
  /** Kept user messages in chronological order; the first-flagged entry, when present, comes first. */
  readonly users: readonly CheckpointUserEntry[]
  /** Older user messages dropped by the byte budget, cumulative across checkpoints. */
  readonly omittedUsers: number
  /** Skills whose loaded instructions are no longer visible, newest first. */
  readonly skills: readonly string[]
  /**
   * The latest todo list, including completed items, while it is still current:
   * absent when none was written or when a user message followed the write.
   */
  readonly todos?: readonly CheckpointTodo[]
  /** The anchor index as rendered, carried by value so later checkpoints never re-parse it. */
  readonly anchors?: CheckpointAnchors
  /**
   * Log seq of the earliest original surface event behind this checkpoint,
   * carried across checkpoints: a later checkpoint that condenses this one
   * reaches back to it rather than to this checkpoint's own seq.
   */
  readonly condensedFrom?: number
}

/** Message source carried by a concrete compaction checkpoint. */
export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
  /** Mechanically carried facts; absent on older checkpoints. */
  readonly record?: CheckpointRecord
}

/**
 * Create a checkpoint source correlated with one compaction transaction.
 * @param compactionId - owning compaction identity.
 * @param sourceCommandId - initiating manual command, when present.
 * @param record - mechanically carried checkpoint facts, when any exist.
 * @returns immutable checkpoint source.
 */
export function compactCheckpointSource(
  compactionId: CompactionId,
  sourceCommandId?: CommandId,
  record?: CheckpointRecord,
): CompactionCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_MARKER,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
    ...record === undefined ? {} : { record },
  })
}

/**
 * Test whether a persisted message source identifies a compaction checkpoint.
 * @param source - source restored from a surface user message.
 * @returns whether the source carries the backend-independent checkpoint marker.
 */
export function isCompactCheckpointSource(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === COMPACT_CHECKPOINT_MARKER.plugin
}

const RECORD_KEYS: ReadonlySet<string> = new Set(['version', 'users', 'omittedUsers', 'skills', 'todos', 'anchors', 'condensedFrom'])
const ANCHOR_KINDS: ReadonlySet<string> = new Set(CHECKPOINT_ANCHOR_KINDS)
const TODO_STATUSES: ReadonlySet<unknown> = new Set(['pending', 'in_progress', 'completed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Describe the first structural defect of an untrusted checkpoint record.
 * @param value - `record` member read from a checkpoint source.
 * @returns the defect, or `undefined` for a well-formed version 1 record.
 */
export function checkpointRecordProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object'
  const unknown = Object.keys(value).find(key => !RECORD_KEYS.has(key))
  if (unknown !== undefined) return `has unexpected member ${JSON.stringify(unknown)}`
  if (value['version'] !== 1) return 'version must be 1'
  if (!isCount(value['omittedUsers'])) return 'omittedUsers must be a non-negative safe integer'
  const users = value['users']
  if (!Array.isArray(users)) return 'users must be an array'
  for (const [index, user] of users.entries()) {
    if (!isRecord(user) || Object.keys(user).some(key => key !== 'seq' && key !== 'text' && key !== 'first')) {
      return `users[${index}] must hold only seq, text and first`
    }
    if (!isCount(user['seq'])) return `users[${index}].seq must be a non-negative safe integer`
    if (typeof user['text'] !== 'string') return `users[${index}].text must be a string`
    if (user['first'] !== undefined && (user['first'] !== true || index !== 0)) {
      return `users[${index}].first must be true and only on the first entry`
    }
  }
  if (value['condensedFrom'] !== undefined && !isCount(value['condensedFrom'])) {
    return 'condensedFrom must be a non-negative safe integer'
  }
  const skills = value['skills']
  if (!Array.isArray(skills) || skills.some(name => typeof name !== 'string' || name.length === 0)) {
    return 'skills must be an array of non-empty strings'
  }
  const todos = value['todos']
  if (todos !== undefined) {
    if (!Array.isArray(todos)) return 'todos must be an array'
    for (const [index, todo] of todos.entries()) {
      if (!isRecord(todo) || Object.keys(todo).some(key => key !== 'content' && key !== 'status')
        || typeof todo['content'] !== 'string' || !TODO_STATUSES.has(todo['status'])) {
        return `todos[${index}] must be { content, status } with a todo_write status`
      }
    }
  }
  return anchorsProblem(value['anchors'])
}

function anchorsProblem(anchors: unknown): string | undefined {
  if (anchors === undefined) return undefined
  if (!isRecord(anchors)) return 'anchors must be an object'
  for (const [kind, values] of Object.entries(anchors)) {
    if (!ANCHOR_KINDS.has(kind)) return `anchors has unexpected category ${JSON.stringify(kind)}`
    if (!Array.isArray(values) || values.length === 0) return `anchors.${kind} must be a non-empty array`
    for (const [index, anchor] of values.entries()) {
      if (!isRecord(anchor) || Object.keys(anchor).some(key => key !== 'value' && key !== 'count')
        || typeof anchor['value'] !== 'string' || anchor['value'].length === 0
        || !isCount(anchor['count']) || anchor['count'] === 0) {
        return `anchors.${kind}[${index}] must be { value, count } with a non-empty value and a positive count`
      }
    }
  }
  return undefined
}

/**
 * Read the structured record a checkpoint carries.
 * @param source - source of a surface user message.
 * @returns the record, or `undefined` for a non-checkpoint or a checkpoint written without one.
 * @throws when a checkpoint carries a malformed record; carried user text is never silently dropped.
 */
export function readCheckpointRecord(source: MessageSource): CheckpointRecord | undefined {
  if (!isCompactCheckpointSource(source)) return undefined
  const record = (source as MessageSource & { record?: unknown }).record
  if (record === undefined) return undefined
  const problem = checkpointRecordProblem(record)
  if (problem !== undefined) throw new Error(`compaction checkpoint record ${problem}`)
  return record as CheckpointRecord
}
