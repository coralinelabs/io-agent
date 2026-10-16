/** Guarded text batches with bounded preflight and conditional rollback, not crash-atomic transactions. */
import type { FsObservation, FsTarget, FsVersion } from './fs/types.ts'
import { FsError } from './fs/types.ts'
import { modelText } from '../context/text/index.ts'

export interface FsTextMutation { readonly target: FsTarget; readonly expected: FsObservation; readonly content: string | null }
export interface FsTextChange { readonly target: FsTarget; readonly before: string | null; readonly after: string | null; readonly version?: FsVersion }
export interface FsTextBatchResult { readonly changes: readonly FsTextChange[] }
export interface BatchSnapshot { readonly version: FsVersion; readonly content: string; readonly mode?: number }
export interface TextBatchIO {
  inspect(target: FsTarget, signal?: AbortSignal): Promise<BatchSnapshot | undefined>
  put(target: FsTarget, text: string, mode: number | undefined, absent: boolean, signal?: AbortSignal): Promise<void>
  remove(target: FsTarget): Promise<void>
}
export const MAX_TEXT_BATCH_FILES = 64
export const MAX_TEXT_BATCH_BYTES = 8 * 1024 * 1024
export class FsTextBatchError extends FsError {
  readonly status: 'rolled-back' | 'partial'
  constructor(readonly uncertainPaths: readonly string[], cause: unknown) {
    const status = uncertainPaths.length ? 'partial' : 'rolled-back'
    super(modelText('filesystem/batch-failed', { status, paths: JSON.stringify(uncertainPaths), reason: String(cause) }), 'FS_BATCH_FAILED', { cause })
    this.status = status
  }
}
function invalid(code: string): never { throw new FsError(modelText('filesystem/batch-invalid', { code }), 'FS_INVALID_EDIT') }
function same(a: BatchSnapshot | undefined, b: BatchSnapshot | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.version === b.version && a.content === b.content
}
function matches(expected: FsObservation, value: BatchSnapshot | undefined): boolean {
  return expected.kind === 'absent' ? value === undefined : value?.version === expected.version
}

/** Caller owns the mutation locks and permission checks for every target for the whole operation. */
export async function applyTextBatch(changes: readonly FsTextMutation[], io: TextBatchIO, signal?: AbortSignal): Promise<FsTextBatchResult> {
  if (!changes.length || changes.length > MAX_TEXT_BATCH_FILES) invalid('BATCH_SIZE')
  const seen = new Set<string>()
  let bytes = 0
  for (const change of changes) {
    if (seen.has(change.target.targetKey)) invalid('DUPLICATE_TARGET')
    seen.add(change.target.targetKey)
    if (change.content !== null && (typeof change.content !== 'string' || !change.content.isWellFormed())) invalid('CONTENT_TYPE')
    bytes += change.content === null ? 0 : Buffer.byteLength(change.content)
  }
  if (bytes > MAX_TEXT_BATCH_BYTES) invalid('BYTE_LIMIT')
  const planned: { change: FsTextMutation; before: BatchSnapshot | undefined }[] = []
  for (const change of changes) {
    signal?.throwIfAborted()
    const before = await io.inspect(change.target, signal)
    if (!matches(change.expected, before)) throw new FsError(modelText('filesystem/batch-stale', { path: change.target.displayPath }), 'FS_STALE_VERSION')
    if (before === undefined && change.content === null) invalid('DELETE_MISSING')
    bytes += before === undefined ? 0 : Buffer.byteLength(before.content)
    if (bytes > MAX_TEXT_BATCH_BYTES) invalid('BYTE_LIMIT')
    planned.push({ change, before })
  }
  const committed: { plan: typeof planned[number]; after: BatchSnapshot | undefined }[] = []
  let attempted: typeof planned[number] | undefined
  try {
    for (const plan of planned) {
      signal?.throwIfAborted()
      if (!same(plan.before, await io.inspect(plan.change.target, signal))) {
        throw new FsError(modelText('filesystem/batch-stale', { path: plan.change.target.displayPath }), 'FS_STALE_VERSION')
      }
      signal?.throwIfAborted()
      if (plan.before?.content === plan.change.content) { committed.push({ plan, after: plan.before }); continue }
      attempted = plan
      if (plan.change.content === null) await io.remove(plan.change.target)
      else await io.put(plan.change.target, plan.change.content, plan.before?.mode, plan.before === undefined, signal)
      const after = await io.inspect(plan.change.target)
      if ((after?.content ?? null) !== plan.change.content) invalid('PUBLICATION_CHANGED')
      committed.push({ plan, after }); attempted = undefined
    }
    return { changes: committed.map(({ plan, after }) => ({ target: plan.change.target, before: plan.before?.content ?? null,
      after: plan.change.content, ...(after === undefined ? {} : { version: after.version }) })) }
  } catch (error) {
    const uncertain = new Set<string>()
    // A failing primitive may already have published. Do not claim ownership of an unacknowledged effect.
    if (attempted !== undefined) {
      try { if (!same(attempted.before, await io.inspect(attempted.change.target))) uncertain.add(attempted.change.target.displayPath) }
      catch { uncertain.add(attempted.change.target.displayPath) }
    }
    for (const { plan, after } of committed.toReversed()) {
      if (plan.before?.content === plan.change.content) continue
      try {
        if (!same(after, await io.inspect(plan.change.target))) { uncertain.add(plan.change.target.displayPath); continue }
        // Cleanup ignores caller cancellation but only undoes exactly the still-owned result.
        if (plan.before === undefined) await io.remove(plan.change.target)
        else await io.put(plan.change.target, plan.before.content, plan.before.mode, after === undefined)
      } catch { uncertain.add(plan.change.target.displayPath) }
    }
    throw new FsTextBatchError([...uncertain], error)
  }
}
