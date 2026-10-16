/**
 * The durable records of background work: one per durable job (beside its
 * process files) and one per watcher. Each record is replaced atomically, and
 * writes to one record are serialized so the newest state always lands last.
 * @module io-agent/background/records
 */

import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../../../util/atomic-write/index.ts'

/**
 * Where a settled item's notice stands: `pending` until the agent's step has taken it in (claimed it
 * from the inbox), then `read`; `suppressed` when the agent learned the outcome another way.
 */
export type NoticeState = 'pending' | 'read' | 'suppressed'

/** How a durable job ended. */
export interface JobRecordOutcome {
  status: 'completed' | 'killed' | 'failed'
  /** Status detail for the model and the UI ('exit code: 0'). */
  detail: string
  exitCode: number | null
  /** The process was gone without a status while nobody watched it. */
  lost?: true
  finishedAt: number
}

/** One durable job. */
export interface JobRecord {
  version: 1
  /** Directory name and producer key; also the process marker. */
  token: string
  /** Owning session (agent) id. */
  session: string
  /** Registry id (`bash-N`), once the command became a job. */
  jobId?: string
  label: string
  /**
   * `foreground`: a foreground command that may still become a job; it dies with its tool call.
   * `running`/`stopping`: a job; `finished`: its outcome is recorded.
   */
  phase: 'foreground' | 'running' | 'stopping' | 'finished'
  startedAt: number
  outcome?: JobRecordOutcome
  notice?: NoticeState
  /** Whole-stream offsets the job's reader has consumed. */
  cursor: { stdout: number; stderr: number }
  outputLimitBytes?: number
  /** Read and disk bounds, so an adopter reads the files the way the spawner did. */
  maxBytes: { stdout: number; stderr: number }
  maxFileBytes: number
  /** Why a stop was requested from outside the session's agent, for the outcome's detail. */
  stopReason?: string
  /** Lifecycle events already written to the session journal. */
  journaled: { started?: true; ended?: true }
}

/** What a watcher waits for. Times are epoch milliseconds. */
export type WatchCondition =
  | { kind: 'time' }
  | { kind: 'job'; job: string }
  | { kind: 'pid'; pid: number; started?: string; bootId?: string }
  | { kind: 'output'; job: string; pattern: string; cursor?: { stdout: number; stderr: number } }
  | { kind: 'file'; path: string; baseline: FileState | null }
  | { kind: 'url'; url: string }

/** A file's observable state. */
export interface FileState { size: number; mtimeMs: number; ino: number }

/** One watcher. */
export interface WatcherRecord {
  version: 1
  /** File name; also the notice key. */
  token: string
  /** Session-scoped id (`watch-N`). */
  id: string
  session: string
  condition: WatchCondition
  note?: string
  createdAt: number
  /** When it wakes the agent at the latest (the time itself for a time watcher). */
  deadline: number
  state: 'armed' | 'fired' | 'expired' | 'cancelled'
  /** Status text once settled: what fired it, or the last observation at the deadline. */
  result?: string
  /** The latest poll's observation while armed. */
  lastPoll?: string
  settledAt?: number
  notice?: NoticeState
  journaled: { armed?: true; settled?: true }
}

/**
 * Atomic, serialized record writes. Each write stores the record's state at the moment it runs, so
 * a burst of updates coalesces into the newest one.
 */
export class RecordWriter {
  private readonly chains = new Map<string, Promise<void>>()

  /**
   * Persist the current state of a record.
   * @param path - the record file.
   * @param record - the live record; serialized when the write runs.
   * @returns resolves once that state (or a newer one) is durable.
   */
  write(path: string, record: object): Promise<void> {
    const previous = this.chains.get(path) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, dirMode: 0o700 }))
    this.chains.set(path, next)
    void next.finally(() => { if (this.chains.get(path) === next) this.chains.delete(path) }).catch(() => undefined)
    return next
  }

  /** @returns resolves once every write started so far settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
  }
}

/**
 * Read every job record under `root/jobs`.
 * @param root - the background root.
 * @returns records with their directories; unreadable records are skipped.
 */
export async function readJobRecords(root: string): Promise<{ directory: string; record: JobRecord | undefined }[]> {
  const base = join(root, 'jobs')
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const out: { directory: string; record: JobRecord | undefined }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(base, entry.name)
    out.push({ directory, record: parseJob(await readFile(join(directory, 'record.json'), 'utf8').catch(() => undefined)) })
  }
  return out
}

/**
 * Read every watcher record under `root/watchers`.
 * @param root - the background root.
 * @returns the readable records.
 */
export async function readWatcherRecords(root: string): Promise<WatcherRecord[]> {
  const base = join(root, 'watchers')
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const out: WatcherRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const record = parseWatcher(await readFile(join(base, entry.name), 'utf8').catch(() => undefined))
    if (record !== undefined) out.push(record)
  }
  return out
}

/**
 * Whether a state directory holds background work a host should take up now, before anyone calls: a
 * command recorded as running, a watcher armed, or a notice still owed.
 * @param root - the background root (`<stateDirectory>/background`).
 * @returns true when some work is pending.
 */
export async function pendingWork(root: string): Promise<boolean> {
  for (const { record } of await readJobRecords(root)) {
    if (record === undefined) continue
    if (record.phase === 'running' || record.phase === 'stopping' || (record.phase === 'finished' && record.notice === 'pending')) return true
  }
  for (const record of await readWatcherRecords(root)) if (record.state === 'armed' || record.notice === 'pending') return true
  return false
}

/**
 * Remove a record and everything beside it.
 * @param path - a job directory or a watcher file.
 */
export async function removeRecord(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

function parseJob(text: string | undefined): JobRecord | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as JobRecord
    if (value.version !== 1 || typeof value.token !== 'string' || typeof value.session !== 'string' || typeof value.label !== 'string'
      || !['foreground', 'running', 'stopping', 'finished'].includes(value.phase) || !Number.isSafeInteger(value.startedAt)) return undefined
    return { ...value, cursor: value.cursor ?? { stdout: 0, stderr: 0 }, journaled: value.journaled ?? {}, ...noticeOf(value.notice) }
  } catch {
    return undefined
  }
}

function parseWatcher(text: string | undefined): WatcherRecord | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as WatcherRecord
    if (value.version !== 1 || typeof value.token !== 'string' || typeof value.id !== 'string' || typeof value.session !== 'string'
      || typeof value.condition?.kind !== 'string' || !Number.isSafeInteger(value.deadline)
      || !['armed', 'fired', 'expired', 'cancelled'].includes(value.state)) return undefined
    return { ...value, journaled: value.journaled ?? {}, ...noticeOf(value.notice) }
  } catch {
    return undefined
  }
}

/** A stored notice state; anything unknown is owed, so it is delivered rather than dropped. */
function noticeOf(value: unknown): { notice?: NoticeState } {
  if (value === undefined) return {}
  return { notice: value === 'read' || value === 'suppressed' ? value : 'pending' }
}
