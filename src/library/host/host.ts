/** Product-neutral host over one io-agent engine: sessions, activities, interactions, fenced cancellation and durable history. */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createIoAgent } from "../../index.ts"
import type { IoAgent, IoAgentEvent, IoAgentSession, VerificationResult } from "../../index.ts"
import type { Context } from "../runtime/vendor/cordis/index.ts"
import type { Agent, AssistantStreamFrame } from "../runtime/agents/index.ts"
import { createUserMessage } from "../model/llm/index.ts"
import type { ContentBlock } from "../model/llm/index.ts"
import { SessionId, redactText, redactValue } from "../session/journal/index.ts"
import type { SessionEvent } from "../session/journal/index.ts"
import type { SessionPersistenceSnapshot } from "../session/persistence/index.ts"
import { SessionAlreadyExistsError, SessionAlreadyOwnedError } from "../session/persistence/index.ts"
import type { CompactionResult } from "../context/compaction/compaction/index.ts"
import { SessionTitleInvalidError } from "../session/title/index.ts"
import type { FileAttachmentRef, ImageAttachmentRef } from "../context/attachments/attachment/index.ts"
import type { KvTable } from "../storage/domain/index.ts"
import { JournalProjection, MAX_PROJECTED, SEQ_BLOCK, journalCursor, projectedSeq, toolPreview } from './events.ts'
import { ToolPreviews } from './previews.ts'
import { SummaryFold, hostSummaryDomainSpec } from './summary.ts'
import type { StoredSummary, SummaryRecord } from './summary.ts'
import type { Projected, ProjectionRuntime } from './events.ts'
import { HostError, digest, identifier, reply, steering, submission, turnKey, validateAnswers, validateQuestions } from './validation.ts'
import { HOST_EVENT_VERSION } from './types.ts'
import { HostModels, modelIdentity } from './models.ts'
import { snapshotRequestMetadata } from '../model/request-metadata.ts'
import type { ModelConnection, ResolvedConnection } from '../model/connection.ts'
import { verifyCompletion } from '../context/verification.ts'
import { awaitHostCallback } from '../interaction/host-callback.ts'
import type { ToolCallView, ToolExecution } from '../tools/index.ts'
import type { JsonValue } from '../util/values/index.ts'
import type { ActivityView, ApprovalRequest, BackgroundChange, BackgroundView, DeleteAllResult, HostBackgroundJob, HostEndReason, HostEvent,
  HostEventBody, HostFailure, HostOptions, HostPromptBlock, HostWakeup, HostWatcher, InteractionCloseReason, InteractionReply, InteractionRequest,
  QuestionAnswer, QuestionRequest, SearchHit, SessionHistory, SessionStatus, SessionSummary, SessionView, SteerReceipt, SteerLookup, TurnReceipt, TurnLookup, TurnOptions,
  HostFileChange, LegacyHostOptions } from './types.ts'
import type { JobRecord, WatcherRecord } from '../execution/jobs/background/index.ts'
import { describeCondition } from '../execution/jobs/background/index.ts'
import { JobId, type JobOutputOptions, type JobOutputPage } from '../execution/jobs/jobs/index.ts'
import type { JobSnapshot } from '../execution/jobs/jobs/index.ts'
import { modelText } from '../context/text/index.ts'

type Limits = Required<Omit<HostOptions, 'ioAgent' | 'onFileChange' | 'onFileChangeComplete' | 'connectionFor'>>
interface Owner {
  readonly id: string
  readonly session: IoAgentSession
  readonly agent: Agent
  operation?: 'submit' | 'maintenance'
  pendingTurn?: string
  activity?: Activity
  readonly activities: Map<string, Activity>
  readonly barriers: Set<Promise<void>>
  readonly projection: JournalProjection
  /** Tool calls the model is streaming, for live previews of file changes. */
  readonly previews: ToolPreviews
  /** Journal events folded so far. */
  count: number
  /** Live events emitted since the last journal event. */
  offset: number
  /** Cursor after the newest delivered event: `journalCursor(count) + offset`. */
  last: number
  /** Retained replay covers every event after this cursor. */
  floor: number
  /**
   * Cursors a released opening in this process delivered after its last durable event, when the
   * journal events appended since (a resume marker) project nothing: they mean `floor`.
   */
  continues?: { from: number; to: number }
  bytes: number
  events: { value: HostEvent; bytes: number }[]
  readonly wake: Set<() => void>
  unsubscribe: () => void
  transportError?: HostError
  /** Durable and in-process turn identities of this session. */
  readonly turns: Map<string, TurnRecord>
  readonly steers: Map<string, SteerRecord>
  connection?: ResolvedConnection
  /** Summary fold over every journal event delivered so far. */
  readonly summary: SummaryFold
  /** Attached `watchSession` observers; an observed session is never released as idle. */
  watchers: number
  /** Last use, for idle release. */
  used: number
  idleTimer?: ReturnType<typeof setTimeout>
}
/** One admitted (or being admitted) submission. */
interface TurnRecord {
  readonly digest: string
  activity_id?: string
  /** Cursor preceding the turn's events; set once the turn is recorded. */
  after?: number
  /** Present while the submission is being admitted; settles when it is recorded or has failed. */
  admission?: Promise<void>
  model?: string
  metadata?: JsonValue
  settlement?: Promise<void>
  admissionError?: unknown
}
/** A steering admission retained for durable idempotency and annotation lookup. */
interface SteerRecord { digest: string; metadata?: JsonValue; admission?: Promise<void>; error?: unknown }
/** An attachment reference found in a journal. */
type AttachmentRef = ImageAttachmentRef | FileAttachmentRef
interface Activity {
  readonly session_id: string
  readonly activity_id: string
  readonly turn_id?: string
  readonly owner: Owner
  status: ActivityView['status']
  cancelling: boolean
  end?: HostEndReason
  readonly requests: Map<string, Pending>
  pendingBytes: number
  readonly done: Promise<void>
  readonly finish: () => void
  error?: HostError
}
interface Pending {
  kind: InteractionRequest['kind']
  request?: InteractionRequest
  accepted?: string
  finish?: (reason: InteractionCloseReason, answer?: QuestionAnswer | 'allowed-once' | 'rejected' | 'cancelled') => void
  open: boolean
}

/** Most jobs and watchers a background listing returns, each. */
const BACKGROUND_LIST_MAX = 200

/** A durable job record as the host lists it. */
function jobView(record: JobRecord): HostBackgroundJob {
  const outcome = record.outcome
  return { job_id: record.jobId ?? '', kind: 'bash', label: record.label,
    state: record.phase === 'finished' ? outcome?.status ?? 'completed' : record.phase === 'stopping' ? 'stopping' : 'running',
    ...(outcome === undefined || outcome.detail === '' ? {} : { detail: outcome.detail }),
    ...(outcome === undefined ? {} : { exit_code: outcome.exitCode, finished_at: outcome.finishedAt }),
    started_at: record.startedAt, durable: true, ...(record.notice === 'pending' ? { notice_pending: true as const } : {}) }
}

/** A registry job (delegated work, or a command that cannot run durably) as the host lists it. */
function registryJobView(snapshot: JobSnapshot): HostBackgroundJob {
  return { job_id: String(snapshot.id), kind: snapshot.kind, label: snapshot.label, state: snapshot.status,
    ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail }), started_at: snapshot.startedAt,
    ...(snapshot.finishedAt === undefined ? {} : { finished_at: snapshot.finishedAt }), durable: false }
}

/** A watcher record as the host lists it. */
function watcherView(record: WatcherRecord): HostWatcher {
  return { watch_id: record.id, condition: record.condition.kind, state: record.state, waits_for: describeCondition(record), deadline: record.deadline,
    created_at: record.createdAt, ...(record.settledAt === undefined ? {} : { settled_at: record.settledAt }),
    ...(record.result === undefined ? {} : { result: record.result }), ...(record.state === 'armed' && record.lastPoll !== undefined ? { last_poll: record.lastPoll } : {}),
    ...(record.note === undefined ? {} : { note: record.note }), ...(record.notice === 'pending' ? { notice_pending: true as const } : {}) }
}

/** Largest gap before the first live event of a reopened session (see `adopt`). */
const REOPEN_GAP_MAX = SEQ_BLOCK / 2
/** Gap per second since the last journal event for an opening lost with a restart. */
const REOPEN_GAP_PER_SECOND = 16

function resolveLimits(options: HostOptions): Limits {
  // A question or approval waits for its answer (or cancellation, or the host closing): the longest timer.
  const limits = { interactionTimeoutMs: options.interactionTimeoutMs ?? 2147483647, maxActivities: options.maxActivities ?? 128,
    maxModelConnections: options.maxModelConnections ?? 1024,
    maxReplayEvents: options.maxReplayEvents ?? 65536, maxReplayBytes: options.maxReplayBytes ?? 16777216,
    idleReleaseMs: options.idleReleaseMs ?? 600000 }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new HostError('INVALID_REQUEST', `${key} must be an integer from 1 through 2147483647`)
  }
  return limits
}

function failure(error: HostError): HostFailure { return { code: error.code, message: error.message } }

/** A connection the host keeps, detached from the caller's mutable input list and request metadata. */
function detachConnection(chosen: ModelConnection): ModelConnection {
  return { ...chosen, ...(chosen.input === undefined ? {} : { input: [...chosen.input] }),
    ...(chosen.requestMetadata === undefined ? {} : { requestMetadata: snapshotRequestMetadata(chosen.requestMetadata) }) }
}

/**
 * Collect every attachment reference in a journal event's data.
 * @param value - event data.
 * @param found - references by attachment id.
 */
function attachmentRefs(value: unknown, found: Map<string, AttachmentRef[]>): void {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const item = stack.pop()
    if (typeof item !== 'object' || item === null) continue
    if (Array.isArray(item)) { stack.push(...(item as unknown[])); continue }
    const row = item as Record<string, unknown>
    if (typeof row.attachmentId === 'string') {
      found.set(row.attachmentId, [...(found.get(row.attachmentId) ?? []), row as unknown as AttachmentRef])
      continue
    }
    stack.push(...Object.values(row))
  }
}

/** One trusted workspace host. Its caller authenticates every client request before invoking it. */
export class Host implements AsyncDisposable {
  private readonly sessions = new Map<string, Owner>()
  private readonly opening = new Map<string, Promise<Owner>>()
  private readonly summaries = new Map<string, SummaryRecord>()
  /** Sessions being deleted: nothing opens, creates or submits to them meanwhile. */
  private readonly deleting = new Set<string>()
  /** Cursor after the last event a released opening delivered, so the next opening continues past it. */
  private readonly delivered = new Map<string, number>()
  /** Native closes of released sessions; reopening one waits for its close. */
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly closing = new AbortController()
  private closeTask: Promise<void> | undefined
  private readonly runtime: ProjectionRuntime
  private readonly models: HostModels
  private readonly unwatchRetries: () => void
  private readonly unwatchJobs: () => void
  private readonly unwatchBackground: () => void
  /** Observers of background changes across sessions (`watchBackground`). */
  private readonly backgroundObservers = new Set<(change: BackgroundChange) => void>()

  /** @internal Construct through createHost so callbacks are installed before sessions exist. */
  constructor(private readonly engine: IoAgent, private readonly context: Context, private readonly limits: Limits,
    private readonly workspace: string, private readonly summaryStore?: { table: KvTable<string, SummaryRecord>; close(): Promise<void> }, model?: ModelConnection,
    private readonly connectionFor?: HostOptions['connectionFor'], private readonly activeDirectory?: string) {
    if (model === undefined) throw new Error('host needs its initial model connection')
    this.models = new HostModels(context, model, limits.maxModelConnections)
    this.runtime = {
      tool: name => context.tools.get(name),
      imagePath: (ref) => { try { return context.attachments.imageHostPath(ref) } catch { return undefined } },
    }
    // Every session this host opens runs on its own connection from its first step. Background work can wake
    // an agent before any client turn selects (a watcher firing after an idle release, a notice owed after a
    // restart), so the selection is made here, ahead of the listener that delivers what is owed.
    context.on('agent/created', ({ agent }) => {
      if (context.agents.roots().includes(agent)) this.models.select(agent, this.models.current(String(agent.id)))
      return undefined
    }, { prepend: true })
    // A delegated child resumed with a route no registration serves (one recorded before a restart) follows its
    // root's current connection instead of failing every request.
    context.on('agent/created', ({ agent }) => {
      const provider = agent.options.provider
      if (provider === undefined || context.llm.listProviders().some(info => info.id === provider)) return undefined
      const owner = [...this.sessions.values()].find(candidate => candidate.agent !== agent && this.tree(candidate).has(agent))
      if (owner !== undefined && !this.models.follow(owner.agent, agent)) {
        context.logger.warn('Delegated child has no registered model route', { session_id: owner.id, agent_id: String(agent.id) })
      }
      return undefined
    })
    this.unwatchRetries = context.on('session/event', (session, event) => {
      if (event.type !== 'llm/retry') return
      for (const owner of this.sessions.values()) {
        if (owner.agent.session === session) continue
        if (![...this.tree(owner)].some(agent => agent.session === session)) continue
        // Use the root's existing journal so live delivery and history share one cursor.
        owner.agent.session.append('host/child-retry', { sessionId: String(session.id), sourceSeq: event.seq, retry: event.data })
        break
      }
    })
    // A session kept open by its running jobs starts its idle period when they change (a job settles).
    this.unwatchJobs = context.jobs.onJobsChanged((agent) => {
      if (agent === undefined) return
      for (const owner of this.sessions.values()) {
        if (!this.tree(owner).has(agent)) continue
        this.touch(owner)
        // A durable job reports its own changes below; delegated work and the like only here.
        this.backgroundChanged({ session_id: owner.id, item: 'job' })
      }
    })
    // Background work that settled while its session was closed reopens it, so its agent hears of
    // it without waiting for a client; so does work owed from before this host started.
    const background = context.get('background')
    const stopAttention = background?.onAttention((id) => { this.reopen(id) })
    const stopChanges = background?.onChange((change) => {
      this.backgroundChanged({ session_id: change.session, item: change.item, id: change.id, state: change.state })
    })
    this.unwatchBackground = () => { stopAttention?.(); stopChanges?.() }
    queueMicrotask(() => { for (const id of background?.owedSessions() ?? []) this.reopen(id) })
  }

  /**
   * Continue every session whose turn the last stop cut off: reopened, its turn closed, its agent told to carry on.
   * The embedder calls it once, as its service starts; a host opened again within one process (a test, a restart of
   * the host alone) resumes nothing unless asked.
   */
  async resumeStopped(): Promise<void> {
    if (this.activeDirectory === undefined) return
    const ids = await readdir(this.activeDirectory).catch(() => [] as string[])
    await Promise.all(ids.map(id => this.resumeInterrupted(id)))
  }

  /** The marker that a session's activity runs: written as it starts, removed as it settles, kept through a stop. */
  private activeMarker(id: string): string | undefined {
    return this.activeDirectory === undefined ? undefined : join(this.activeDirectory, encodeURIComponent(id))
  }

  /**
   * Continue a session whose turn the last stop cut off. Reopening closes that turn as interrupted (missing tool
   * results, step and turn ends); the agent is then woken with a notice to carry on. DeepSeek Harness left such a
   * turn closed for a person to re-prompt; an unattended agent has no one to do that.
   */
  private async resumeInterrupted(file: string): Promise<void> {
    const id = decodeURIComponent(file), marker = this.activeMarker(id)
    try {
      if (marker !== undefined) await unlink(marker).catch(() => undefined)
      if (this.closing.signal.aborted || this.deleting.has(id)) return
      const owner = this.sessions.get(id) ?? await this.ensure(id)
      const last = (await this.history(id)).events.findLast(event => event.type === 'end')
      // A stop ends a running turn as cancelled (a clean stop) or interrupted (a crash); the marker surviving says
      // which one it was not: a person's own cancel settles and clears it.
      if (last?.type !== 'end' || (last.reason !== 'interrupted' && last.reason !== 'cancelled') || owner.activity !== undefined) return
      owner.agent.followup(createUserMessage({
        content: [{ type: 'text', text: modelText('runtime/host/resume-interrupted') }],
        source: { kind: 'plugin', plugin: 'io-agent-host', form: 'notice', summary: 'resumed after a restart' },
      }))
    } catch (cause: unknown) {
      if (cause instanceof HostError && (cause.code === 'UNKNOWN_SESSION' || cause.code === 'CLOSED')) return
      this.context.logger.warn('A session cut off by the last stop could not be resumed', { session_id: id, error: String(cause) })
    }
  }

  /**
   * Create and open a session; this never submits input.
   * @param id Optional session ID.
   * @returns Session identity.
   */
  async createSession(id?: string): Promise<string> {
    this.assertOpen()
    if (id !== undefined) identifier(id, 'session id')
    if (id !== undefined && this.deleting.has(id)) throw new HostError('SESSION_BUSY', 'a session with that id is being deleted')
    let session: IoAgentSession
    try { session = await this.engine.createSession(id === undefined ? {} : { id }) } catch (cause: unknown) {
      if (cause instanceof SessionAlreadyExistsError || (id !== undefined && (this.sessions.has(id) || this.opening.has(id)))) {
        throw new HostError('INVALID_REQUEST', 'a session with that id already exists', { cause })
      }
      throw cause
    }
    return (await this.adopt(session)).id
  }

  /**
   * Open a persisted root session of this workspace through io-agent recovery; idempotent.
   * @param id Session ID.
   * @returns Opened session identity.
   */
  async resumeSession(id: string): Promise<string> { return (await this.ensure(id)).id }

  /**
   * Release an idle open session; its history stays on disk.
   * @param id Open session identity.
   */
  async closeSession(id: string): Promise<void> {
    const owner = this.owner(id)
    this.syncActivity(owner)
    if (this.busy(owner)) throw new HostError('SESSION_BUSY', 'close requires the session to be idle')
    await this.release(owner)
  }

  /**
   * Summaries of this workspace's root sessions, most recently updated first.
   * @returns One summary per session; unchanged sessions are served from a revision-keyed cache.
   */
  async listSessions(): Promise<SessionSummary[]> {
    this.assertOpen()
    const all = await this.engine.listSessions()
    const stored = new Set(all.map(row => String(row.header.id)))
    const out: SessionSummary[] = []
    for (const row of all) {
      if (!this.isRoot(row)) continue
      const id = String(row.header.id)
      const owner = this.sessions.get(id)
      // An open session's summary is folded as its events arrive; a closed one's is cached by log revision.
      let summary: StoredSummary
      if (owner !== undefined) summary = owner.summary.value()
      else {
        const revision = String(row.revision)
        const cached = this.summaries.get(id) ?? this.summaryStore?.table.get(id)
        if (cached?.revision === revision) summary = cached.summary
        else {
          summary = await this.summarize(id, row.header.createdAt)
          await this.remember(id, revision, summary)
        }
      }
      out.push({ ...summary, status: this.statusOf(owner), background: this.backgroundActive(id, owner) })
    }
    for (const id of this.summaries.keys()) if (!stored.has(id)) this.summaries.delete(id)
    for (const id of this.summaryStore?.table.keys() ?? []) if (!stored.has(id)) await this.summaryStore?.table.delete(id).catch(() => false)
    return out.sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? -1 : 1))
  }

  /**
   * Set a user title; automatic titles never replace it afterwards.
   * @param id Session identity.
   * @param title Visible title text.
   * @returns The normalized stored title.
   */
  async renameSession(id: string, title: unknown): Promise<string> {
    if (typeof title !== 'string') throw new HostError('INVALID_REQUEST', 'title must be text')
    const owner = await this.ensure(id)
    this.assertNotDeleting(owner.id)
    try {
      const snapshot = this.context.sessionTitle.rename(owner.agent.session, title)
      await owner.session.flush()
      return snapshot.title
    } catch (cause: unknown) {
      if (cause instanceof SessionTitleInvalidError) throw new HostError('INVALID_REQUEST', cause.message, { cause })
      throw cause
    } finally {
      this.touch(owner)
    }
  }

  /**
   * Cancel any running work, close and permanently delete a root session with its delegated children,
   * their derived rows (projection cache, full-text index, summary), spilled output and the stored
   * attachments no remaining session references. Nothing opens the session while this runs, and a
   * child still owned by a writer fails the whole call before anything is removed.
   * @param id Session identity.
   */
  async deleteSession(id: string): Promise<void> {
    this.assertOpen()
    identifier(id, 'session id')
    if (this.deleting.has(id)) throw new HostError('SESSION_BUSY', 'the session is already being deleted')
    this.deleting.add(id)
    try {
      await this.opening.get(id)?.catch(() => undefined)
      await this.releasing.get(id)?.catch(() => undefined)
      const rows = await this.engine.listSessions()
      const owner = this.sessions.get(id)
      if (owner === undefined && !rows.some(row => this.isRoot(row) && String(row.header.id) === id)) {
        throw new HostError('UNKNOWN_SESSION', 'only root sessions of this workspace can be deleted')
      }
      if (owner !== undefined) {
        if (owner.operation !== undefined) throw new HostError('SESSION_BUSY', 'wait for the session operation to settle')
        this.syncActivity(owner)
        if (owner.activity !== undefined) await this.cancel(id, owner.activity.activity_id).catch(() => undefined)
        await Promise.allSettled(owner.barriers)
        await this.release(owner)
      }
      const children = new Map<string, string[]>()
      for (const row of rows) {
        const parent = row.header.parentSession
        if (parent !== undefined) children.set(String(parent), [...(children.get(String(parent)) ?? []), String(row.header.id)])
      }
      const doomed: string[] = []
      const visit = (node: string): void => { for (const child of children.get(node) ?? []) visit(child); doomed.push(node) }
      visit(id)
      const referenced = await this.attachmentsOf(doomed)
      const ids = doomed.map(target => SessionId(target))
      try { await this.context.sessionPersistence.delete(ids) } catch (cause: unknown) {
        if (cause instanceof SessionAlreadyOwnedError) {
          throw new HostError('SESSION_BUSY', 'a session or delegated child is still owned by a writer; nothing was deleted', { cause })
        }
        throw cause
      }
      // Its background commands stop and its watchers go with it.
      await this.context.get('background')?.forget(new Set(doomed))
      // Derived rows, spilled tool output and attachments hold conversation content; a deleted session leaves none behind.
      for (const target of ids) {
        await this.context.sessionProjectionCache.forget(target)
        await this.context.spillStore.forget(target)
      }
      await this.context.sessionQuery.forget(ids)
      this.summaries.delete(id)
      this.delivered.delete(id)
      this.models.forget(id)
      await this.summaryStore?.table.delete(id).catch(() => false)
      await this.collectAttachments(referenced)
    } finally {
      this.deleting.delete(id)
    }
  }

  /**
   * Delete every root session of this workspace; one session's failure does not stop the others.
   * When no session of any workspace remains, the attachment store is emptied too.
   * @returns The deleted sessions and each failure.
   */
  async deleteAllSessions(): Promise<DeleteAllResult> {
    const ids = new Set([...(await this.roots()).map(row => String(row.header.id)), ...this.sessions.keys()])
    const result: DeleteAllResult = { deleted: [], failed: [] }
    for (const id of ids) {
      try {
        await this.deleteSession(id)
        result.deleted.push(id)
      } catch (cause: unknown) {
        if (cause instanceof HostError && cause.code === 'UNKNOWN_SESSION') continue
        result.failed.push({ session_id: id, error: cause instanceof HostError ? failure(cause)
          : { code: 'INTERNAL', message: 'the session could not be deleted' } })
      }
    }
    if (result.failed.length === 0 && (await this.engine.listSessions()).length === 0) await this.context.attachments.forgetAll()
    return result
  }

  /**
   * Full-text search over what the user typed and what the model replied in this workspace's root
   * sessions (needs `recall.fullText`). Host `context` blocks, notices and other injected input are
   * never matched, so an excerpt only shows text the history shows.
   * @param query Text to find, interpreted as data.
   * @param limit Sessions to return, 1-100; default 20.
   * @returns One best hit per session. `seq` is the history cursor ending the matched event's projections.
   */
  async search(query: unknown, limit = 20): Promise<SearchHit[]> {
    this.assertOpen()
    if (typeof query !== 'string' || query.trim() === '' || query.length > 1000) throw new HostError('INVALID_REQUEST', 'query must be 1-1000 characters of nonblank text')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HostError('INVALID_REQUEST', 'limit must be an integer from 1 through 100')
    try {
      const page = await this.context.sessionQuery.searchSessions({ query, limit,
        sessionFilters: [{ kind: 'parent', values: [null] }, { kind: 'cwd', values: [this.workspace] }],
        eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'source', values: ['user', 'model'] }] })
      return page.items.map(hit => ({ session_id: String(hit.header.id), seq: journalCursor(hit.bestMatch.seq + 1), excerpt: hit.bestMatch.snippet }))
    } catch (cause: unknown) {
      if ((cause as { code?: unknown } | null)?.code === 'SESSION_QUERY_SEARCH_DISABLED') {
        throw new HostError('UNSUPPORTED', 'full-text search needs ioAgent.recall.fullText', { cause })
      }
      throw cause
    }
  }

  /**
   * Durable history as HostEvents (the events live delivery carries, without deltas and live-only controls).
   * Reading history never opens a session. For an open session the cursor is exact: tailing from it
   * continues where history ends. A session that is not open has nothing live to tail; its next
   * submission's receipt carries the cursor to watch from.
   * @param id Root session of this workspace, open or not.
   * @returns Events, the cursor to tail live delivery from, and the current activity when one runs.
   */
  async history(id: string): Promise<SessionHistory> {
    this.assertOpen()
    identifier(id, 'session id')
    if (!this.sessions.has(id) && !(await this.roots()).some(row => String(row.header.id) === id)) {
      throw new HostError('UNKNOWN_SESSION', 'no root session of this workspace has that id')
    }
    using observation = await this.context.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
    const projection = new JournalProjection(this.runtime)
    const events: HostEvent[] = []
    for (const event of observation.events) {
      const bodies = projection.project(event)
      bodies.forEach((body, index) => { events.push(this.envelope(id, projectedSeq(event.seq, index, bodies.length), body)) })
    }
    const owner = this.sessions.get(id)
    if (owner !== undefined) this.syncActivity(owner)
    return structuredClone({ session_id: id, events, cursor: journalCursor(observation.events.length),
      ...(owner?.activity === undefined ? {} : { activity: this.activityView(owner.activity) }) })
  }

  /**
   * Admit one user turn, or acknowledge an identical retry of an admitted one.
   * @param input Untrusted submission JSON; the session opens when it is persisted but not open.
   * @returns Admission receipt, not execution success.
   */
  async submit(input: unknown, options: TurnOptions = {}): Promise<TurnReceipt> {
    this.assertOpen()
    const request = submission(input)
    const owner = await this.ensure(request.session_id)
    const known = owner.turns.get(request.turn_id)
    const model = detachConnection(options.model ?? this.models.current(owner.id))
    const selectedModel = modelIdentity(model)
    const hash = digest({ prompt: request.prompt, context: request.context ?? null,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      ...(known !== undefined && known.model === undefined && options.model === undefined ? {} : { model: selectedModel }) })
    if (known !== undefined) {
      if (known.digest !== hash) throw new HostError('TURN_CONFLICT', 'turn ID already names a different submission')
      // A retry racing the first submission's admission is answered once that is recorded or has
      // failed; after a failure the retry is a fresh submission.
      if (known.admission !== undefined) {
        await known.admission
        return this.submit(input, options)
      }
      if (known.admissionError !== undefined) throw known.admissionError
      this.touch(owner)
      return { session_id: owner.id, turn_id: request.turn_id, ...(known.activity_id === undefined ? {} : { activity_id: known.activity_id }),
        after: known.after ?? owner.last, duplicate: true }
    }
    this.assertNotDeleting(owner.id)
    this.reserve(owner, 'submit')
    // Reserved before admission so a concurrent retry is recognized as a duplicate.
    const admission = Promise.withResolvers<void>()
    const turn: TurnRecord = { digest: hash, model: selectedModel, admission: admission.promise,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }) }
    owner.turns.set(request.turn_id, turn)
    let recorded = false
    try {
      const content = await this.admit(request.prompt)
      this.assertOpen()
      if (this.sessions.get(owner.id) !== owner) throw new HostError('UNKNOWN_SESSION', 'session closed during admission')
      owner.connection = this.models.select(owner.agent, model)
      const message = createUserMessage({ content, source: { kind: 'user' } })
      turn.after = owner.last
      owner.agent.session.append('host/turn', { turnId: request.turn_id, messageId: message.id, digest: hash, model: selectedModel,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }) })
      recorded = true
      owner.pendingTurn = request.turn_id
      if (request.context !== undefined) {
        owner.agent.inject(createUserMessage({ content: [{ type: 'text', text: request.context }], source: { kind: 'plugin', plugin: 'host' } }))
      }
      owner.agent.followup(message)
      this.syncActivity(owner)
      if (owner.activity !== undefined) turn.activity_id = owner.activity.activity_id
      await owner.session.flush()
      return { session_id: owner.id, turn_id: request.turn_id, ...(turn.activity_id === undefined ? {} : { activity_id: turn.activity_id }),
        after: turn.after, duplicate: false }
    } catch (cause: unknown) {
      if (recorded) turn.admissionError = cause
      throw cause
    } finally {
      if (!recorded && owner.turns.get(request.turn_id) === turn) owner.turns.delete(request.turn_id)
      delete turn.admission
      admission.resolve()
      delete owner.pendingTurn
      if (owner.operation === 'submit') delete owner.operation
      this.touch(owner)
    }
  }

  /**
   * Find a durable admission before resolving mutable input files or a current model catalog.
   * An in-progress admission is awaited; its persistence failure is preserved.
   * @returns Detached metadata and a duplicate receipt, or undefined when the key was not admitted.
   */
  async lookupTurn(id: string, turnId: string): Promise<TurnLookup | undefined> {
    this.assertOpen()
    identifier(id, 'session_id')
    turnKey(turnId, 'turn_id')
    const owner = await this.ensure(id)
    const turn = owner.turns.get(turnId)
    if (turn === undefined) return undefined
    if (turn.admission !== undefined) await turn.admission
    if (owner.turns.get(turnId) !== turn) return undefined
    if (turn.admissionError !== undefined) throw turn.admissionError
    this.touch(owner)
    return structuredClone({ receipt: { session_id: id, turn_id: turnId,
      ...(turn.activity_id === undefined ? {} : { activity_id: turn.activity_id }), after: turn.after!, duplicate: true },
      ...(turn.metadata === undefined ? {} : { metadata: turn.metadata }) })
  }

  /**
   * Steer running work at its next step boundary. An omitted target captures the current activity.
   * @param input Untrusted `{ session_id, prompt }`.
   * @returns Acceptance; the input appears as a `steered` event when the model receives it.
   */
  async steer(input: unknown): Promise<SteerReceipt> {
    this.assertOpen()
    const request = steering(input)
    const owner = await this.ensure(request.session_id)
    // Omitted new fields preserve the digest of already admitted plain steering.
    const hash = digest({ prompt: request.prompt, turn_id: request.turn_id ?? null,
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }) })
    const known = request.steer_id === undefined ? undefined : owner.steers.get(request.steer_id)
    if (known !== undefined) {
      if (known.digest !== hash) throw new HostError('TURN_CONFLICT', 'steer ID already names different input')
      if (known.admission !== undefined) { await known.admission; return this.steer(input) }
      if (known.error !== undefined) throw known.error
      return { accepted: true }
    }
    this.syncActivity(owner)
    const target = owner.activity
    const running = (): boolean => { this.syncActivity(owner); return target !== undefined && owner.activity === target
      && target.status === 'running' && !target.cancelling && (request.turn_id === undefined || target.turn_id === request.turn_id) }
    if (!running()) throw new HostError('SESSION_IDLE', 'steering needs running work; submit a turn instead')
    const admission = Promise.withResolvers<void>()
    const retained: SteerRecord = { digest: hash, admission: admission.promise,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }) }
    if (request.steer_id !== undefined) owner.steers.set(request.steer_id, retained)
    let recorded = false
    try {
      const content = await this.admit(request.prompt)
      if (!running()) throw new HostError('SESSION_IDLE', 'the work settled before the steering arrived; submit a turn instead')
      const message = createUserMessage({ content, source: { kind: 'user' } })
      if (request.steer_id !== undefined || request.metadata !== undefined) owner.agent.session.append('host/steer', {
        ...(request.steer_id === undefined ? {} : { steerId: request.steer_id }), ...(target!.turn_id === undefined ? {} : { turnId: target!.turn_id }),
        activityId: target!.activity_id, messageId: message.id, digest: hash,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }) })
      if (request.context !== undefined) {
        owner.agent.inject(createUserMessage({ content: [{ type: 'text', text: request.context }], source: { kind: 'plugin', plugin: 'host' } }))
      }
      owner.agent.steer(message)
      recorded = true
      await owner.session.flush()
      return { accepted: true }
    } catch (cause: unknown) {
      if (recorded) retained.error = cause
      throw cause
    } finally {
      if (!recorded && request.steer_id !== undefined) owner.steers.delete(request.steer_id)
      delete retained.admission
      admission.resolve()
      this.touch(owner)
    }
  }

  /** Look up an admitted steer before resolving mutable input; wait for its persistence or preserve its failure. */
  async lookupSteer(id: string, steerId: string): Promise<SteerLookup | undefined> {
    this.assertOpen()
    identifier(id, 'session_id')
    turnKey(steerId, 'steer_id', 128)
    const owner = await this.ensure(id)
    const steer = owner.steers.get(steerId)
    if (steer === undefined) return undefined
    if (steer.admission !== undefined) await steer.admission
    if (owner.steers.get(steerId) !== steer) return undefined
    if (steer.error !== undefined) throw steer.error
    this.touch(owner)
    return structuredClone({ receipt: { accepted: true }, ...(steer.metadata === undefined ? {} : { metadata: steer.metadata }) })
  }

  /**
   * Retained live delivery after a cursor plus current controls.
   * @param id Open session identity.
   * @param after Exclusive cursor (a receipt's `after`, a history `cursor` or a delivered `seq`); omit for the retained tail.
   * @returns Detached snapshot; an evicted prefix throws REPLAY_GAP, after which history is authoritative.
   */
  readSession(id: string, after?: number): SessionView {
    const owner = this.owner(id)
    this.syncActivity(owner)
    this.touch(owner)
    if (after !== undefined && owner.transportError !== undefined) throw owner.transportError
    const continued = after !== undefined && owner.continues !== undefined && after >= owner.continues.from && after <= owner.continues.to
    const cursor = continued ? owner.floor : after ?? owner.floor
    const gap = (): HostError => new HostError('REPLAY_GAP', 'events after the cursor are no longer retained; read history',
      { details: { first_seq: owner.events[0]?.value.seq ?? owner.last, last_seq: owner.last } })
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HostError('INVALID_CURSOR', 'cursor must come from this session\'s delivery or history')
    if (cursor > owner.last) {
      // A live cursor in the current journal block that this opening has not reached was delivered by an earlier opening.
      if (Math.floor(cursor / SEQ_BLOCK) === owner.count) throw gap()
      throw new HostError('INVALID_CURSOR', 'cursor must come from this session\'s delivery or history')
    }
    if (cursor < owner.floor) throw gap()
    return structuredClone({ session_id: id, status: this.statusOf(owner), busy: this.busy(owner), background: this.backgroundActive(id, owner),
      ...(owner.transportError === undefined ? {} : { delivery_error: failure(owner.transportError) }),
      ...(owner.activity === undefined ? {} : { activity: this.activityView(owner.activity) }),
      last_seq: owner.last, events: owner.events.filter(event => event.value.seq > cursor).map(event => event.value) })
  }

  /**
   * Observe a session across activities; disconnecting never cancels work.
   * @param id Open session identity.
   * @param after Exclusive cursor; omit for the retained tail.
   * @param signal Observer cancellation only.
   * @returns Replay then live events until the session is released or the host closes.
   */
  async *watchSession(id: string, after?: number, signal?: AbortSignal): AsyncGenerator<HostEvent> {
    const owner = this.owner(id)
    let cursor = after ?? owner.floor
    owner.watchers += 1
    try {
      for (;;) {
        signal?.throwIfAborted()
        const view = this.readSession(id, cursor)
        for (const event of view.events) {
          signal?.throwIfAborted()
          cursor = event.seq
          yield event
        }
        // Journal events that project nothing still advance the cursor.
        cursor = Math.max(cursor, view.last_seq)
        if (owner.last > cursor) continue
        await this.changed(owner, cursor, signal)
      }
    } finally {
      owner.watchers -= 1
      this.touch(owner)
    }
  }

  /**
   * A session's background work: its jobs (running and recently ended), its watchers (armed and recently settled)
   * and the times its agent will be woken at the latest. Reading it never opens the session; delegated work is
   * listed while the session is open.
   * @param id Root session of this workspace, open or not.
   * @returns Detached view.
   */
  async background(id: string): Promise<BackgroundView> {
    await this.assertRoot(id)
    const service = this.context.get('background')
    const owner = this.sessions.get(id)
    const sessions = new Set([id])
    const durable = service?.jobsOf(sessions) ?? []
    const keys = new Set(durable.map(record => record.token))
    const jobs = durable.map(jobView)
    if (owner !== undefined) {
      for (const agent of this.tree(owner)) {
        for (const snapshot of this.context.jobs.list(agent)) {
          if (snapshot.ownerSession !== agent.session.id || (snapshot.key !== undefined && keys.has(snapshot.key))) continue
          jobs.push(registryJobView(snapshot))
        }
      }
    }
    jobs.sort((a, b) => b.started_at - a.started_at)
    const watchers = (service?.watchersOf(sessions) ?? []).map(watcherView)
    const wakeups: HostWakeup[] = watchers.filter(watcher => watcher.state === 'armed')
      .map(watcher => ({ at: watcher.deadline, kind: 'watcher' as const, watch_id: watcher.watch_id }))
    const checkIn = service?.checkInOf(id)
    if (checkIn !== undefined) wakeups.push({ at: checkIn, kind: 'check_in' })
    wakeups.sort((a, b) => a.at - b.at)
    // labels, a watcher's matched output and its latest observation can carry what an embedder redacts
    return redactValue(structuredClone({ session_id: id, active: this.backgroundActive(id, owner), jobs: jobs.slice(0, BACKGROUND_LIST_MAX),
      watchers: watchers.slice(0, BACKGROUND_LIST_MAX), wakeups }))
  }

  /**
   * Stop a background job of a session, open or not: its whole process group goes. The agent is told how it
   * ended (`stopped by the user`), at its next step or by a turn of its own.
   * @param id Root session of this workspace.
   * @param jobId The job, as listed by `background`.
   * @returns `requested`, or `already_finished` when it had ended.
   */
  async killJob(id: string, jobId: string): Promise<'requested' | 'already_finished'> {
    await this.assertRoot(id)
    if (typeof jobId !== 'string' || jobId === '') throw new HostError('INVALID_REQUEST', 'job_id must be text')
    const result = await this.context.get('background')?.kill(id, jobId, modelText('runtime/background/stopped-by-user'))
    if (result !== undefined) return result === 'requested' ? 'requested' : 'already_finished'
    const owner = this.sessions.get(id)
    for (const agent of owner === undefined ? [] : this.tree(owner)) {
      try {
        return this.context.jobs.kill(JobId(jobId), agent, 'stopped by the user') === 'requested' ? 'requested' : 'already_finished'
      } catch {
        // Not this agent's job.
      }
    }
    throw new HostError('UNKNOWN_JOB', 'no background job of this session has that id')
  }

  /**
   * Cancel an armed watcher of a session, open or not. Nobody is woken for it.
   * @param id Root session of this workspace.
   * @param watchId The watcher, as listed by `background`.
   * @returns The watcher after the call (already settled ones are returned unchanged).
   */
  async cancelWatcher(id: string, watchId: string): Promise<HostWatcher> {
    await this.assertRoot(id)
    if (typeof watchId !== 'string' || watchId === '') throw new HostError('INVALID_REQUEST', 'watch_id must be text')
    const record = await this.context.get('background')?.cancelWatcher(id, watchId)
    if (record === undefined) throw new HostError('UNKNOWN_WATCHER', 'no watcher of this session has that id')
    return structuredClone(watcherView(record))
  }

  /**
   * Read a durable job's output for display, without moving the agent's own read position.
   * @param id Root session of this workspace.
   * @param jobId The job.
   * @param options `stream` (default stdout) and `from`, a whole-stream byte offset (0, or a previous read's `next`).
   * @returns At most the job's read window of text, the offset to continue from, and whether bytes before it were skipped.
   */
  async readJobOutput(id: string, jobId: string, options: { stream?: 'stdout' | 'stderr'; from?: number } = {}): Promise<{ text: string; next: number; lossy: boolean }> {
    await this.assertRoot(id)
    const stream = options.stream ?? 'stdout'
    const from = options.from ?? 0
    if (stream !== 'stdout' && stream !== 'stderr') throw new HostError('INVALID_REQUEST', 'stream must be stdout or stderr')
    if (!Number.isSafeInteger(from) || from < 0) throw new HostError('INVALID_REQUEST', 'from must be a non-negative integer')
    const read = this.context.get('background')?.peek(id, jobId, stream, from)
    if (read === undefined) throw new HostError('UNKNOWN_JOB', 'no durable background job of this session has that id')
    // the durable output is the job's own bytes; what an embedder redacts never leaves through this read
    return { ...read, text: redactText(read.text) }
  }

  /** Read a live registry job (including workflows/native children) without advancing the model's output cursor. */
  readLiveJobOutput(id: string, jobId: string, options: JobOutputOptions = {}): JobOutputPage {
    const owner = this.owner(id)
    const page = this.context.jobs.readAt(JobId(jobId), options, owner.agent)
    return this.redactJobOutput(page)
  }

  /** Stream bounded pages. Reconnect with the last cursor; detachment never kills work or acknowledges completion. */
  async *followJobOutput(id: string, jobId: string, options: JobOutputOptions = {}, signal?: AbortSignal): AsyncGenerator<JobOutputPage> {
    const owner = this.owner(id)
    const stop = signal === undefined ? this.closing.signal : AbortSignal.any([signal, this.closing.signal])
    for await (const page of this.context.jobs.follow(JobId(jobId), options, owner.agent, stop)) {
      stop.throwIfAborted()
      yield this.redactJobOutput(page)
    }
  }

  private redactJobOutput(page: JobOutputPage): JobOutputPage {
    return { ...page, text: redactText(page.text),
      snapshot: { ...page.snapshot, label: redactText(page.snapshot.label),
        ...page.snapshot.detail === undefined ? {} : { detail: redactText(page.snapshot.detail) } },
      ...page.outputError === undefined ? {} : { outputError: redactText(page.outputError) } }
  }

  /**
   * Observe background changes across this workspace's sessions, open or not: a job started, stopping or ended,
   * a watcher armed or settled. Each change names the session; read `background(id)` for the whole picture.
   * @param signal Observer cancellation.
   * @returns Changes as they happen, until the signal aborts or the host closes.
   */
  async *watchBackground(signal?: AbortSignal): AsyncGenerator<BackgroundChange> {
    this.assertOpen()
    const queue: BackgroundChange[] = []
    let wake: (() => void) | undefined
    const observer = (change: BackgroundChange): void => {
      queue.push(change)
      // A slow observer loses the oldest changes, never the latest state: it re-reads anyway.
      if (queue.length > 1024) queue.shift()
      wake?.()
    }
    const stop = AbortSignal.any([this.closing.signal, ...(signal === undefined ? [] : [signal])])
    // One listener for the observer's whole life: it ends whichever wait is current.
    const stopped = (): void => { wake?.() }
    stop.addEventListener('abort', stopped, { once: true })
    this.backgroundObservers.add(observer)
    try {
      for (;;) {
        if (this.closing.signal.aborted) return
        signal?.throwIfAborted()
        while (queue.length > 0) yield queue.shift() as BackgroundChange
        await new Promise<void>((resolve) => {
          wake = resolve
          if (stop.aborted || queue.length > 0) resolve()
        })
        wake = undefined
      }
    } finally {
      stop.removeEventListener('abort', stopped)
      this.backgroundObservers.delete(observer)
    }
  }

  /** @internal Reopen a session its background work needs; a session that is not a root here is left alone. */
  reopen(id: string): void {
    if (this.closing.signal.aborted || this.deleting.has(id) || this.sessions.has(id)) return
    void this.ensure(id).catch((cause: unknown) => {
      if (cause instanceof HostError && (cause.code === 'UNKNOWN_SESSION' || cause.code === 'CLOSED' || cause.code === 'SESSION_BUSY')) return
      this.context.logger.warn('A session owed a background notice could not be reopened', { session_id: id, error: String(cause) })
    })
  }

  /**
   * Read one retained activity.
   * @param id Open session identity.
   * @param activityId Activity identity.
   * @returns Detached view.
   */
  readActivity(id: string, activityId: string): ActivityView {
    return structuredClone(this.activityView(this.activity(this.owner(id), activityId)))
  }

  /**
   * Wait for an activity's persistence barrier.
   * @param id Open session identity.
   * @param activityId Activity identity.
   * @returns Settled view; a failed barrier rejects with its error.
   */
  async settled(id: string, activityId: string): Promise<ActivityView> {
    const activity = this.activity(this.owner(id), activityId)
    await activity.done
    if (activity.error !== undefined) throw activity.error
    return structuredClone(this.activityView(activity))
  }

  /**
   * Cancel the exact named activity (or the current one) and cross its persistence barrier.
   * @param id Open session identity.
   * @param activityId Activity to cancel; a settled or replaced activity never cancels its successor.
   * @returns The settled activity, or undefined when nothing was running and none was named.
   */
  async cancel(id: string, activityId?: string): Promise<ActivityView | undefined> {
    const owner = this.owner(id)
    this.syncActivity(owner)
    const activity = activityId === undefined ? owner.activity : this.activity(owner, activityId)
    if (activity === undefined) return undefined
    if (owner.activity === activity && activity.status === 'running') {
      if (owner.operation === 'maintenance') throw new HostError('SESSION_BUSY', 'native maintenance owns cancellation; wait for its settlement')
      activity.cancelling = true
      this.closeRequests(activity, 'cancelled')
      owner.session.cancel()
      this.syncActivity(owner)
    }
    await activity.done
    this.touch(owner)
    if (activity.error !== undefined) throw activity.error
    return structuredClone(this.activityView(activity))
  }

  /** Cancel only the admitted turn, including safe retries after another turn or a restart. */
  async cancelTurn(id: string, turnId: string): Promise<ActivityView | undefined> {
    turnKey(turnId, 'turn_id')
    const owner = await this.ensure(id)
    const turn = owner.turns.get(turnId)
    if (turn === undefined) throw new HostError('UNKNOWN_ACTIVITY', 'turn has not been admitted in this session')
    await turn.admission
    if (owner.turns.get(turnId) !== turn) throw new HostError('UNKNOWN_ACTIVITY', 'turn admission failed')
    if (turn.admissionError !== undefined) throw turn.admissionError
    this.syncActivity(owner)
    if (turn.activity_id !== undefined && owner.activities.has(turn.activity_id)) return this.cancel(id, turn.activity_id)
    if (owner.activity?.turn_id === turnId) return this.cancel(id, owner.activity.activity_id)
    await turn.settlement
    await owner.session.flush()
    return undefined
  }

  /**
   * Answer a pending question or approval once; an identical retry only acknowledges.
   * @param input Untrusted reply JSON.
   * @returns Acceptance, never an execution result.
   */
  reply(input: unknown): { accepted: true } {
    this.assertOpen()
    const response = reply(input)
    const owner = this.owner(response.session_id)
    this.syncActivity(owner)
    const activity = response.activity_id !== undefined ? this.activity(owner, response.activity_id)
      : [...owner.activities.values()].find(candidate => candidate.requests.has(response.request_id))
    if (activity === undefined) throw new HostError('REQUEST_CLOSED', 'request is not retained by this session')
    return this.accept(activity.requests, activity.status !== 'running', response)
  }

  /** Durable continued clarifications are session controls, not activity callbacks. */
  pendingQuestions(id: string) { this.assertOpen(); return this.owner(id).session.pendingQuestions() }
  answerQuestion(id: string, requestId: string, answer: unknown) {
    this.assertOpen(); return this.owner(id).session.answerQuestion(identifier(requestId, 'requestId'), answer)
  }
  dismissQuestion(id: string, requestId: string) {
    this.assertOpen(); return this.owner(id).session.dismissQuestion(identifier(requestId, 'requestId'))
  }

  /**
   * Native compaction while the session is otherwise idle.
   * @param id Open session.
   * @param signal Optional cancellation.
   * @returns Native compaction result.
   */
  compact(id: string, signal?: AbortSignal): Promise<CompactionResult | null> {
    return this.exclusive(id, session => session.compact(signal === undefined ? this.closing.signal : AbortSignal.any([signal, this.closing.signal])))
  }

  /**
   * Native tool-free completion review while idle.
   * @param id Open session.
   * @param options Review cancellation.
   * @returns Native review result.
   */
  verify(id: string, options: { signal?: AbortSignal } = {}): Promise<VerificationResult> {
    return this.exclusive(id, session => {
      const owner = this.owner(id)
      const signal = options.signal === undefined ? this.closing.signal : AbortSignal.any([options.signal, this.closing.signal])
      return owner.connection === undefined ? session.verify({ signal }) : verifyCompletion(this.context, owner.agent, owner.connection, signal)
    })
  }

  /**
   * Stop admission, withdraw interactions and await native shutdown, including owned jobs.
   * @returns Shared shutdown completion.
   */
  close(): Promise<void> {
    if (this.closeTask === undefined) {
      this.closing.abort(new HostError('CLOSED', 'host is closing'))
      this.closeTask = this.dispose()
    }
    return this.closeTask
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  /** @internal Stable callback destination installed before any session exists. */
  question(request: QuestionRequest, rootId: string | undefined): Promise<QuestionAnswer> {
    const activity = this.interactionActivity(rootId)
    if (activity === undefined || request.agent === undefined || String(request.agent.id) !== rootId) return Promise.reject(new HostError('UNKNOWN_OWNER', 'question has no active owned root'))
    try { validateQuestions(request.questions) } catch (error: unknown) { return Promise.reject(error instanceof Error ? error : new HostError('INVALID_REQUEST', 'question validation failed', { cause: error })) }
    return this.interact(activity, { request_id: randomUUID(), agent_id: String(request.agent.id), kind: 'question', questions: request.questions }, request.signal) as Promise<QuestionAnswer>
  }

  /** @internal Child approvals retain exact runtime ancestry and calling-agent identity. */
  approval(request: ApprovalRequest, rootId: string | undefined, action?: { arguments: unknown }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    const activity = this.interactionActivity(rootId)
    if (activity === undefined || (String(request.agent.id) !== rootId && action === undefined)) return Promise.resolve('unavailable')
    return this.interact(activity, { request_id: randomUUID(), agent_id: String(request.agent.id), kind: 'approval', toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(action === undefined ? {} : { arguments: action.arguments }) }, request.signal)
      .then(value => typeof value === 'string' ? value : 'unavailable', () => 'unavailable')
  }

  /** @internal Only sessions opened by this host can be interaction roots. */
  owns(id: string): boolean { return this.sessions.has(id) }

  /** @internal The accepted preimage and its live notification share the owning activity. */
  async fileChange(change: Omit<HostFileChange, 'change_id'>, callback?: HostOptions['onFileChange']): Promise<HostFileChange> {
    const owner = change.session_id === undefined ? undefined : this.sessions.get(change.session_id)
    const activity = owner?.activity
    const turnId = owner?.projection.currentTurn ?? activity?.turn_id
    const captured = { ...change, change_id: randomUUID(), ...(turnId === undefined ? {} : { turn_id: turnId }) }
    await callback?.(structuredClone(captured))
    if (owner !== undefined) this.live(owner, { type: 'file_change', call_id: change.call_id, paths: [...change.paths] }, activity)
    return captured
  }

  private ensure(id: string): Promise<Owner> {
    this.assertOpen()
    identifier(id, 'session id')
    this.assertNotDeleting(id)
    const open = this.sessions.get(id)
    if (open !== undefined) return Promise.resolve(open)
    let pending = this.opening.get(id)
    if (pending === undefined) {
      pending = (async () => {
        // A session released a moment ago (idle release) still holds its writer until its close ends.
        await this.releasing.get(id)?.catch(() => undefined)
        if (!(await this.roots()).some(row => String(row.header.id) === id)) {
          throw new HostError('UNKNOWN_SESSION', 'only persisted root sessions of this workspace can be opened')
        }
        // Its agent may be woken as it opens, before any turn here chooses: it runs where its turns last ran.
        if (this.connectionFor !== undefined && !this.models.chosen(id)) {
          const recalled = await this.connectionFor(id)
          if (recalled !== undefined) this.models.recall(id, detachConnection(recalled))
        }
        return this.adopt(await this.engine.resumeSession(id))
      })()
      this.opening.set(id, pending)
      const clear = (): void => { this.opening.delete(id) }
      void pending.then(clear, clear)
    }
    return pending
  }
  /** Fold the existing journal, then subscribe with no await in between so no event is missed or seen twice. */
  private async adopt(session: IoAgentSession): Promise<Owner> {
    const agent = this.context.agents.get(SessionId(session.id))
    if (agent === undefined || this.deleting.has(session.id)) {
      await session.close().catch(() => undefined)
      throw agent === undefined ? new HostError('UNKNOWN_SESSION', 'native session has no live agent')
        : new HostError('SESSION_BUSY', 'the session is being deleted')
    }
    const projection = new JournalProjection(this.runtime)
    const summary = new SummaryFold(session.id, agent.session.header.createdAt)
    const turns: Owner['turns'] = new Map()
    const steers: Owner['steers'] = new Map()
    const previous = this.delivered.get(session.id)
    const releasedAt = previous === undefined ? undefined : Math.floor(previous / SEQ_BLOCK)
    let silent = true
    let folded = 0
    let lastTime = agent.session.header.createdAt
    try {
      while (folded < agent.session.seq) {
        using observation = await this.context.sessionQuery.observeSession(SessionId(session.id), { projectionMode: 'none' })
        for (const event of observation.events.slice(folded)) {
          // The turn's events follow this journal event; a restarted host no longer retains them live.
          if (event.type === 'host/turn') turns.set(event.data.turnId, { digest: event.data.digest, after: journalCursor(event.seq),
            ...(event.data.model === undefined ? {} : { model: event.data.model }),
            ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }) })
          if (event.type === 'host/steer' && event.data.steerId !== undefined) steers.set(event.data.steerId, { digest: event.data.digest,
            ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }) })
          const bodies = projection.project(event)
          if (releasedAt !== undefined && event.seq >= releasedAt && bodies.length > 0) silent = false
          summary.add(event)
          lastTime = event.time
        }
        folded = observation.events.length
      }
      this.assertOpen()
    } catch (error: unknown) {
      // An unadopted native session would otherwise stay open and refuse the next resume.
      await session.close().catch(() => undefined)
      throw error
    }
    const cursor = journalCursor(folded)
    // Live events of an earlier opening may hold this journal block: start past them. This process
    // knows where its own released openings stopped; an opening lost with a restart gets a gap that
    // grows with the time since the last journal event.
    const known = previous !== undefined && releasedAt === folded ? previous - cursor : 0
    const offset = Math.min(REOPEN_GAP_MAX, Math.max(known,
      1 + Math.floor(Math.max(0, Date.now() - lastTime) / 1000) * REOPEN_GAP_PER_SECOND))
    const continues = previous !== undefined && releasedAt !== undefined && releasedAt < folded && silent
      ? { from: journalCursor(releasedAt), to: previous } : undefined
    const owner: Owner = { id: session.id, session, agent, activities: new Map(), barriers: new Set(), projection, previews: new ToolPreviews(), count: folded, offset,
      last: cursor + offset, floor: cursor, ...(continues === undefined ? {} : { continues }), bytes: 0, events: [], wake: new Set(),
      unsubscribe: () => {}, turns, steers, summary, watchers: 0, used: Date.now() }
    this.sessions.set(owner.id, owner)
    owner.unsubscribe = session.subscribe((event) => { this.observe(owner, event) }, () => {
      owner.transportError ??= new HostError('TRANSPORT_ERROR', 'native session delivery failed; read history')
      for (const wake of owner.wake) wake()
    })
    this.syncActivity(owner)
    this.touch(owner)
    return owner
  }
  private async release(owner: Owner): Promise<void> {
    if (owner.idleTimer !== undefined) clearTimeout(owner.idleTimer)
    delete owner.idleTimer
    owner.unsubscribe()
    this.sessions.delete(owner.id)
    this.delivered.set(owner.id, owner.last)
    for (const wake of owner.wake) wake()
    const closed = owner.session.close()
    this.releasing.set(owner.id, closed)
    try { await closed } finally { if (this.releasing.get(owner.id) === closed) this.releasing.delete(owner.id) }
    this.models.release(owner.id)
    if (this.deleting.has(owner.id)) {
      this.delivered.delete(owner.id)
      return
    }
    // The closed log's revision is final: listing it later reads no journal.
    try {
      const stored = await this.context.sessionPersistence.stat(SessionId(owner.id))
      if (stored !== undefined) await this.remember(owner.id, String(stored.revision), owner.summary.value())
    } catch {
      // Derived data; the next listing folds the journal instead.
    }
  }
  /** Mark use; an idle session with no watcher is released after `idleReleaseMs` without use. */
  private touch(owner: Owner): void {
    owner.used = Date.now()
    if (owner.idleTimer !== undefined || this.sessions.get(owner.id) !== owner || this.closing.signal.aborted) return
    const expire = (): void => {
      delete owner.idleTimer
      if (this.sessions.get(owner.id) !== owner || this.closing.signal.aborted || this.deleting.has(owner.id)) return
      this.syncActivity(owner)
      // Busy, watched or running jobs: the transition back to idle (settlement, detach, a job's change) touches again.
      if (this.busy(owner) || owner.watchers > 0 || this.jobsRunning(owner)) return
      const left = owner.used + this.limits.idleReleaseMs - Date.now()
      if (left > 0) {
        owner.idleTimer = setTimeout(expire, left)
        owner.idleTimer.unref()
        return
      }
      void this.release(owner).catch(() => undefined)
    }
    owner.idleTimer = setTimeout(expire, this.limits.idleReleaseMs)
    owner.idleTimer.unref()
  }
  private async remember(id: string, revision: string, summary: StoredSummary): Promise<void> {
    const record = { revision, summary }
    this.summaries.set(id, record)
    await this.summaryStore?.table.put(id, record).catch(() => undefined)
  }
  /** Attachment references in the journals of `ids`, read before they are deleted. */
  private async attachmentsOf(ids: readonly string[]): Promise<Map<string, AttachmentRef[]>> {
    const found = new Map<string, AttachmentRef[]>()
    for (const id of ids) {
      try {
        using observation = await this.context.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
        for (const event of observation.events) attachmentRefs(event.data, found)
      } catch {
        // A log that cannot be read names no attachment this call can find.
      }
    }
    return found
  }
  /** Remove the candidates no remaining session of any workspace references. */
  private async collectAttachments(candidates: Map<string, AttachmentRef[]>): Promise<void> {
    if (candidates.size === 0) return
    for (const row of await this.engine.listSessions()) {
      const found = new Map<string, AttachmentRef[]>()
      try {
        using observation = await this.context.sessionQuery.observeSession(row.header.id, { projectionMode: 'none' })
        for (const event of observation.events) attachmentRefs(event.data, found)
      } catch {
        // An unreadable log might still reference any candidate: keep them all.
        return
      }
      for (const id of found.keys()) candidates.delete(id)
      if (candidates.size === 0) return
    }
    await this.context.attachments.forget([...candidates.values()].flat())
  }
  private owner(id: string): Owner {
    this.assertOpen()
    const owner = this.sessions.get(id)
    if (owner === undefined) throw new HostError('UNKNOWN_SESSION', 'session must be created or resumed by this host')
    return owner
  }
  private async roots(): Promise<readonly SessionPersistenceSnapshot[]> {
    this.assertOpen()
    return (await this.engine.listSessions()).filter(row => this.isRoot(row))
  }
  private isRoot(row: SessionPersistenceSnapshot): boolean { return row.header.parentSession === undefined && row.header.cwd === this.workspace }
  private async summarize(id: string, createdAt: number): Promise<StoredSummary> {
    using observation = await this.context.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
    const fold = new SummaryFold(id, createdAt)
    for (const event of observation.events) fold.add(event)
    return fold.value()
  }
  private async admit(prompt: string | HostPromptBlock[]): Promise<ContentBlock[]> {
    if (typeof prompt === 'string') return [{ type: 'text', text: prompt }]
    try {
      const admitted = await this.context.attachments.admitPromptContent(prompt.map(block => block.type === 'text' ? block
        : { type: 'image' as const, mediaType: block.media_type, data: block.data, ...(block.name === undefined ? {} : { name: block.name }) }))
      return admitted.map(part => ({ ...part }) as ContentBlock)
    } catch (cause: unknown) {
      if (this.context.attachments.isAttachmentError(cause)) throw new HostError('INVALID_REQUEST', cause.message, { cause })
      throw cause
    }
  }
  /** The session's agent and every agent it owns, directly or through another. */
  private tree(owner: Owner): Set<Agent> {
    const agents = this.context.agents.list()
    const tree = new Set<Agent>([owner.agent])
    for (let grew = true; grew;) {
      grew = false
      for (const agent of agents) {
        if (tree.has(agent) || ![...tree].some(parent => this.context.agents.isOwnedBy(agent.id, parent))) continue
        tree.add(agent)
        grew = true
      }
    }
    return tree
  }
  /**
   * Whether background work of the session (its own jobs or its children's) is still running. Releasing the
   * session would kill it, and lose the completion that wakes the agent, so an idle session waits for it.
   */
  private jobsRunning(owner: Owner): boolean {
    return [...this.tree(owner)].some(agent => this.context.jobs.list(agent)
      .some(job => job.ownerSession === agent.session.id && (job.status === 'running' || job.status === 'stopping')))
  }
  /** Whether the session has a durable job running, a watcher armed, or (open) delegated work running. */
  private backgroundActive(id: string, owner: Owner | undefined): boolean {
    if (this.context.get('background')?.active(new Set([id])) === true) return true
    return owner !== undefined && this.jobsRunning(owner)
  }
  private backgroundChanged(change: BackgroundChange): void {
    for (const observer of this.backgroundObservers) {
      try { observer(change) } catch { /* observers never break the change */ }
    }
  }
  private async assertRoot(id: string): Promise<void> {
    this.assertOpen()
    identifier(id, 'session id')
    if (this.sessions.has(id)) return
    if (!(await this.roots()).some(row => String(row.header.id) === id)) throw new HostError('UNKNOWN_SESSION', 'no root session of this workspace has that id')
  }
  private busy(owner: Owner): boolean {
    return owner.operation !== undefined || owner.session.busy || owner.activity !== undefined || owner.barriers.size > 0
  }
  private statusOf(owner: Owner | undefined): SessionStatus {
    if (owner === undefined) return 'idle'
    if (owner.activity === undefined) return owner.session.busy ? 'working' : 'idle'
    return [...owner.activity.requests.values()].some(pending => pending.request !== undefined) ? 'needs_you' : 'working'
  }
  private assertOpen(): void { if (this.closing.signal.aborted) throw new HostError('CLOSED', 'host is closed') }
  private assertNotDeleting(id: string): void { if (this.deleting.has(id)) throw new HostError('SESSION_BUSY', 'the session is being deleted') }
  private reserve(owner: Owner, operation: 'submit' | 'maintenance'): void {
    if (this.busy(owner)) throw new HostError('SESSION_BUSY', 'session already owns an operation')
    owner.operation = operation
  }
  private async exclusive<T>(id: string, call: (session: IoAgentSession) => Promise<T>): Promise<T> {
    const owner = this.owner(id)
    this.reserve(owner, 'maintenance')
    try { return await call(owner.session) } finally { delete owner.operation; this.touch(owner) }
  }
  private interactionActivity(rootId: string | undefined): Activity | undefined {
    if (this.closing.signal.aborted || rootId === undefined) return undefined
    const owner = this.sessions.get(rootId)
    if (owner === undefined) return undefined
    this.syncActivity(owner)
    const activity = owner.activity
    return activity?.status === 'running' && !activity.cancelling ? activity : undefined
  }
  private interact(activity: Activity, request: InteractionRequest, signal?: AbortSignal): Promise<QuestionAnswer | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    if (signal?.aborted) return Promise.reject(new HostError('REQUEST_CLOSED', 'request was cancelled'))
    const bytes = Buffer.byteLength(JSON.stringify(request))
    if (activity.pendingBytes + bytes > this.limits.maxReplayBytes) return Promise.reject(new HostError('CAPACITY', 'pending interactions exceed the configured byte limit'))
    if (activity.requests.size >= this.limits.maxReplayEvents) return Promise.reject(new HostError('CAPACITY', 'interaction receipt capacity reached'))
    return new Promise((resolve, reject) => {
      const finish: NonNullable<Pending['finish']> = (reason, answer) => {
        if (!pending.open) return
        pending.open = false
        activity.pendingBytes -= bytes
        delete pending.request
        delete pending.finish
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.live(activity.owner, { type: 'interaction_closed', request_id: request.request_id, reason }, activity)
        if (reason === 'answered' && answer !== undefined) resolve(structuredClone(answer))
        else if (request.kind === 'approval') resolve(reason === 'timeout' ? 'unavailable' : 'cancelled')
        else reject(new HostError(reason === 'timeout' ? 'INTERACTION_TIMEOUT' : 'REQUEST_CLOSED', `question closed: ${reason}`))
      }
      const abort = (): void => { finish('cancelled') }
      const timer = setTimeout(() => { finish('timeout') }, this.limits.interactionTimeoutMs)
      const pending: Pending = { kind: request.kind, request: structuredClone(request), finish, open: true }
      activity.pendingBytes += bytes
      activity.requests.set(request.request_id, pending)
      signal?.addEventListener('abort', abort, { once: true })
      this.live(activity.owner, { type: 'interaction', request }, activity)
      if (signal?.aborted) abort()
    })
  }
  private closeRequests(activity: Activity, reason: InteractionCloseReason): void {
    for (const request of activity.requests.values()) if (request.open) request.finish?.(reason)
  }
  private activity(owner: Owner, activityId: string): Activity {
    this.syncActivity(owner)
    const activity = owner.activities.get(activityId)
    if (activity === undefined) throw new HostError('UNKNOWN_ACTIVITY', 'activity identity expired or does not belong to this session')
    return activity
  }
  private activityView(activity: Activity): ActivityView {
    return { session_id: activity.session_id, activity_id: activity.activity_id, ...(activity.turn_id === undefined ? {} : { turn_id: activity.turn_id }),
      status: activity.status, ...(activity.end === undefined ? {} : { end: activity.end }),
      ...(activity.error === undefined ? {} : { error: failure(activity.error) }),
      pending_requests: [...activity.requests.values()].flatMap(pending => pending.request === undefined ? [] : [pending.request]) }
  }
  private startActivity(owner: Owner): Activity {
    const completion = Promise.withResolvers<void>()
    const turnId = owner.pendingTurn
    delete owner.pendingTurn
    const activity: Activity = { session_id: owner.id, activity_id: randomUUID(), ...(turnId === undefined ? {} : { turn_id: turnId }), owner,
      status: 'running', cancelling: false, requests: new Map(), pendingBytes: 0, done: completion.promise, finish: completion.resolve }
    owner.activity = activity
    owner.activities.set(activity.activity_id, activity)
    const turn = turnId === undefined ? undefined : owner.turns.get(turnId)
    if (turn !== undefined) {
      turn.activity_id = activity.activity_id
      turn.settlement = activity.done.then(() => { if (activity.error !== undefined) throw activity.error })
      void turn.settlement.catch(() => undefined)
    }
    for (const [key, retained] of owner.activities) {
      if (owner.activities.size <= this.limits.maxActivities) break
      if (retained !== activity) owner.activities.delete(key)
    }
    this.live(owner, { type: 'activity', state: 'started' }, activity)
    const marker = this.activeMarker(owner.id)
    if (marker !== undefined) void mkdir(this.activeDirectory!, { recursive: true }).then(() => writeFile(marker, activity.activity_id)).catch(() => undefined)
    return activity
  }
  private syncActivity(owner: Owner): void {
    if (this.sessions.get(owner.id) !== owner) return
    const active = owner.session.status !== 'idle' || owner.session.pendingInput
    if (active && owner.activity === undefined && !this.closing.signal.aborted) this.startActivity(owner)
    else if (!active && owner.activity !== undefined) this.retire(owner.activity)
  }
  private observe(owner: Owner, event: IoAgentEvent): void {
    // Native status is observed before other handlers can synchronously start a successor.
    // Inbox insertion can precede running; its committed pending state also owns controls.
    if (event.type === 'status' && event.status === 'running') {
      if (owner.activity === undefined && !this.closing.signal.aborted) this.startActivity(owner)
    } else if (event.type !== 'status') {
      if (owner.activity === undefined && (owner.session.status !== 'idle' || owner.session.pendingInput) && !this.closing.signal.aborted) this.startActivity(owner)
    }
    const activity = owner.activity
    if (event.type === 'event') this.journal(owner, event.event, activity)
    else if (event.type === 'stream') this.stream(owner, event.frame, activity)
    const ended = event.type === 'status' && event.status === 'idle' && (activity?.cancelling || !owner.session.pendingInput)
    const emptied = event.type === 'event' && event.event.type === 'agent/inbox/spliced'
      && owner.session.status === 'idle' && !owner.session.pendingInput
    if ((ended || emptied) && activity !== undefined) this.retire(activity)
  }
  private journal(owner: Owner, event: SessionEvent, activity: Activity | undefined): void {
    if (event.seq < owner.count) return
    if (event.seq !== owner.count) {
      owner.transportError ??= new HostError('TRANSPORT_ERROR', 'journal delivery skipped an event; read history')
      for (const wake of owner.wake) wake()
      return
    }
    const bodies = owner.projection.project(event)
    owner.summary.add(event)
    owner.count = event.seq + 1
    owner.offset = 0
    bodies.forEach((body, index) => { this.append(owner, projectedSeq(event.seq, index, bodies.length), body, activity) })
    owner.last = journalCursor(owner.count)
    for (const body of bodies) if (body.type === 'end' && activity !== undefined) activity.end = body.reason
    for (const wake of owner.wake) wake()
  }
  private stream(owner: Owner, frame: AssistantStreamFrame, activity: Activity | undefined): void {
    if (frame.type === 'start') { owner.previews.reset(); return }
    if (frame.type !== 'chunk') return
    const { chunk } = frame
    if (chunk.type === 'text-delta' && chunk.text !== '') this.live(owner, { type: 'text', delta: chunk.text }, activity)
    else if (chunk.type === 'reasoning-delta' && chunk.text !== '') this.live(owner, { type: 'reasoning', delta: chunk.text }, activity)
    else if (chunk.type === 'tool-call-delta') {
      const call = owner.previews.push(String(frame.attemptId), chunk, frame.time)
      if (call === undefined) return
      let view: ToolCallView | undefined
      try { view = this.runtime.tool(call.name)?.presentCall?.(call.args) } catch { return }
      const body = toolPreview(call.id, call.name, view)
      if (body !== undefined) this.live(owner, body, activity)
    }
  }
  /** Deliver an event that is not in the journal, inside the current journal block. */
  private live(owner: Owner, body: HostEventBody, activity: Activity | undefined): void {
    if (owner.offset >= SEQ_BLOCK - MAX_PROJECTED - 1) {
      owner.transportError ??= new HostError('TRANSPORT_ERROR', 'too many live events between journal events; read history')
    } else {
      owner.offset += 1
      owner.last = journalCursor(owner.count) + owner.offset
      // Lifecycle events outside the turn's journal span belong to the turn that started the activity.
      const turn = owner.projection.currentTurn ?? (body.type === 'activity' ? activity?.turn_id : undefined)
      this.append(owner, owner.last, turn === undefined ? body : { ...body, turn_id: turn }, activity)
    }
    for (const wake of owner.wake) wake()
  }
  private envelope(sessionId: string, seq: number, body: Projected, activity?: Activity): HostEvent {
    return { v: HOST_EVENT_VERSION, seq, session_id: sessionId, ...(activity === undefined ? {} : { activity_id: activity.activity_id }), ...body }
  }
  private append(owner: Owner, seq: number, body: Projected, activity: Activity | undefined): void {
    if (owner.transportError !== undefined) return
    try {
      const value = this.envelope(owner.id, seq, body, activity)
      const bytes = Buffer.byteLength(JSON.stringify(value))
      owner.events.push({ value, bytes })
      owner.bytes += bytes
      while (owner.events.length > this.limits.maxReplayEvents || owner.bytes > this.limits.maxReplayBytes) {
        const retired = owner.events.shift()
        if (retired === undefined) break
        owner.bytes -= retired.bytes
        owner.floor = retired.value.seq
      }
    } catch (cause: unknown) {
      owner.transportError = new HostError('TRANSPORT_ERROR', 'native event could not be projected; read history', { cause })
    }
  }
  private retire(activity: Activity, flush = true): void {
    if (activity.status !== 'running') return
    activity.status = 'settling'
    const owner = activity.owner
    // A stop keeps the marker, so the next process resumes the turn; any other settling clears it.
    const marker = this.activeMarker(owner.id)
    if (marker !== undefined && !this.closing.signal.aborted) void unlink(marker).catch(() => undefined)
    if (owner.activity === activity) delete owner.activity
    this.closeRequests(activity, this.closing.signal.aborted ? 'shutdown' : 'settled')
    // The captured persistence operation cannot follow or cancel a replacement driver.
    let barrier: Promise<void>
    try { barrier = flush ? owner.session.flush() : Promise.resolve() }
    catch (cause: unknown) { barrier = Promise.reject(new HostError('TRANSPORT_ERROR', 'activity persistence could not start', { cause })) }
    const complete = (error?: HostError): void => {
      if (error !== undefined) activity.error = error
      activity.status = 'settled'
      owner.barriers.delete(settled)
      this.live(owner, error === undefined ? { type: 'activity', state: 'settled' } : { type: 'activity', state: 'failed', error: failure(error) }, activity)
      activity.finish()
      this.touch(owner)
    }
    const settled = barrier.then(() => { complete() }, (cause: unknown) => {
      complete(new HostError('TRANSPORT_ERROR', 'activity persistence barrier failed; inspect native session evidence', { cause }))
    })
    owner.barriers.add(settled)
  }
  private accept(requests: Map<string, Pending>, closed: boolean, response: InteractionReply): { accepted: true } {
    const pending = requests.get(response.request_id)
    if (pending === undefined) throw new HostError('REQUEST_CLOSED', 'request is not retained by this owner')
    if (pending.kind !== response.kind) throw new HostError('REQUEST_MISMATCH', 'response kind differs from the request')
    const hash = digest(response.kind === 'question' ? { request_id: response.request_id, kind: response.kind, answer: response.answer }
      : { request_id: response.request_id, kind: response.kind, decision: response.decision })
    if (pending.accepted !== undefined) {
      if (pending.accepted !== hash) throw new HostError('ANSWER_CONFLICT', 'request already accepted another response')
      return { accepted: true }
    }
    if (!pending.open || closed) throw new HostError('REQUEST_CLOSED', 'request is no longer pending')
    if (response.kind === 'question' && pending.request?.kind === 'question') validateAnswers(response.answer, pending.request.questions)
    pending.accepted = hash
    pending.finish?.('answered', response.kind === 'question' ? response.answer : response.decision)
    return { accepted: true }
  }
  private changed(owner: Owner, after: number, signal?: AbortSignal): Promise<void> {
    if (owner.last > after || owner.transportError !== undefined || this.sessions.get(owner.id) !== owner
      || this.closing.signal.aborted) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const clear = (): void => { owner.wake.delete(wake); signal?.removeEventListener('abort', abort) }
      const wake = (): void => { clear(); resolve() }
      const abort = (): void => { clear(); reject(signal?.reason instanceof Error ? signal.reason : new HostError('REQUEST_CLOSED', 'observer cancelled', { cause: signal?.reason })) }
      owner.wake.add(wake)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  private async dispose(): Promise<void> {
    this.unwatchJobs()
    this.unwatchRetries()
    this.unwatchBackground()
    for (const owner of this.sessions.values()) {
      if (owner.idleTimer !== undefined) clearTimeout(owner.idleTimer)
      delete owner.idleTimer
      for (const activity of owner.activities.values()) this.closeRequests(activity, 'shutdown')
      for (const wake of owner.wake) wake()
    }
    await Promise.allSettled(this.opening.values())
    // An idle session's log is final: cache its summary so the next host lists it without reading the journal.
    for (const owner of this.sessions.values()) {
      if (this.busy(owner)) continue
      try {
        const stored = await this.context.sessionPersistence.stat(SessionId(owner.id))
        if (stored !== undefined) await this.remember(owner.id, String(stored.revision), owner.summary.value())
      } catch {
        // Derived data; the next listing folds the journal instead.
      }
    }
    await this.summaryStore?.close().catch(() => undefined)
    try { await this.engine.close() } finally {
      for (const owner of this.sessions.values()) {
        owner.unsubscribe()
        if (owner.activity !== undefined) this.retire(owner.activity, false)
      }
      await Promise.all([...this.sessions.values()].flatMap(owner => [...owner.barriers]))
    }
  }
}

let warnedLegacyHostOptions = false
/**
 * The options under their io-agent names. `ioAgent` wins whenever it is present; `pluto`, its name before io-agent, is
 * read only in its absence, for one release, and reported once as a `DeprecationWarning`.
 */
function canonicalHostOptions(input: HostOptions | LegacyHostOptions): HostOptions {
  if (input.ioAgent !== undefined) {
    const canonical: HostOptions & { pluto?: unknown } = { ...input, ioAgent: input.ioAgent }
    delete canonical.pluto
    return canonical
  }
  const { pluto, ...rest } = input as LegacyHostOptions
  if (pluto === undefined) throw new TypeError('createHost needs the engine options as ioAgent')
  if (!warnedLegacyHostOptions) {
    warnedLegacyHostOptions = true
    process.emitWarning('HostOptions.pluto is deprecated; use HostOptions.ioAgent', { type: 'DeprecationWarning', code: 'IO_AGENT_LEGACY_API' })
  }
  return { ...rest, ioAgent: pluto }
}

/**
 * Create a host with stable interaction callbacks and one io-agent engine.
 * @param input Trusted engine configuration (`ioAgent`, or `pluto` for one release), delivery limits and the optional
 *   file-change hook.
 * @returns Host; no inference or server is started.
 */
export async function createHost(input: HostOptions | LegacyHostOptions): Promise<Host> {
  const options = canonicalHostOptions(input)
  const limits = resolveLimits(options)
  const workspace = await realpath(resolve(options.ioAgent.workspace))
  const holder: { host?: Host; context?: Context } = {}
  let rootOf: (agent: Agent) => Agent | undefined = () => undefined
  const ownedRoot = (agent: Agent): string | undefined => {
    const root = rootOf(agent)
    return root !== undefined && holder.host?.owns(String(root.id)) ? String(root.id) : undefined
  }
  type ActiveCall = { readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal; readonly token: symbol }
  const active = new WeakMap<Agent, Map<string, Map<symbol, ActiveCall>>>()
  const changes = new Map<symbol, HostFileChange[]>()
  const { onFileChange, onFileChangeComplete } = options
  const engine = await createIoAgent({ ...options.ioAgent,
    configure: async (context) => {
      holder.context = context
      rootOf = (agent) => {
        if (context.agents.get(agent.id) !== agent) return undefined
        const agents = context.agents.list()
        const roots = context.agents.roots()
        let owner = agent
        for (let depth = 0; depth < agents.length; depth += 1) {
          if (roots.includes(owner)) return owner
          const parent = agents.find(candidate => context.agents.isOwnedBy(owner.id, candidate))
          if (parent === undefined) return undefined
          owner = parent
        }
        return undefined
      }
      await options.ioAgent.configure?.(context)
      context.on('fs/before-change', async (target, actor) => {
        const exec = actor as ToolExecution | undefined
        const root = exec?.agent === undefined ? undefined : rootOf(exec.agent)
        const session = root === undefined ? exec?.agent?.id : root.id
        const captured = await awaitHostCallback(async () => holder.host?.fileChange({ ...(session === undefined ? {} : { session_id: String(session) }),
          call_id: String(exec?.callId ?? ''), tool: exec?.name ?? '', paths: [context.fs.processPath(target)] }, onFileChange), exec?.signal)
        if (exec !== undefined && captured !== undefined) changes.set(exec.token, [...changes.get(exec.token) ?? [], captured])
      })
      context.on('tools/post-execute', async (exec, _result, next) => {
        const captured = changes.get(exec.token)
        changes.delete(exec.token)
        for (const change of captured ?? []) await onFileChangeComplete?.(structuredClone(change))
        return next()
      }, { prepend: true })
      // Dispatch can fail after the body mutated a file and bypass post-execute. The
      // outer finally still crosses the host's postimage barrier before finalization.
      context.on('tools/execute', async (exec, next) => {
        try { return await next() } finally {
          const captured = changes.get(exec.token)
          changes.delete(exec.token)
          for (const change of captured ?? []) await onFileChangeComplete?.(structuredClone(change))
        }
      }, { prepend: true })
      // Borrow current immutable execution evidence; settlement removes it, so this is not another history.
      context.on('tools/pre-execute', (exec, next) => {
        if (exec.agent !== undefined) {
          let calls = active.get(exec.agent)
          if (calls === undefined) active.set(exec.agent, calls = new Map<string, Map<symbol, ActiveCall>>())
          let sameId = calls.get(String(exec.callId))
          if (sameId === undefined) calls.set(String(exec.callId), sameId = new Map<symbol, ActiveCall>())
          sameId.set(exec.token, exec)
        }
        return next()
      }, { prepend: true })
      context.on('tools/result', (exec) => {
        changes.delete(exec.token)
        if (exec.agent === undefined) return
        const calls = active.get(exec.agent)
        const sameId = calls?.get(String(exec.callId))
        sameId?.delete(exec.token)
        if (sameId?.size === 0) calls?.delete(String(exec.callId))
        if (calls?.size === 0) active.delete(exec.agent)
      })
    },
    onQuestion: request => holder.host?.question(request, request.agent === undefined ? undefined : ownedRoot(request.agent))
      ?? Promise.reject(new HostError('UNKNOWN_OWNER', 'host has no initialized session')),
    onApproval: (request) => {
      const calls = request.callId === undefined ? undefined : active.get(request.agent)?.get(String(request.callId))
      if (calls !== undefined && calls.size !== 1) return Promise.resolve('unavailable')
      const action = calls?.values().next().value
      if (action !== undefined && (action.name !== request.toolName || action.signal.aborted)) return Promise.resolve('unavailable')
      return holder.host?.approval(request, ownedRoot(request.agent), action) ?? Promise.resolve('unavailable')
    },
  })
  if (holder.context === undefined) throw new Error('io-agent did not run configure()')
  // The summary cache is derived data: a store that cannot open only costs journal reads.
  let summaryStore: ConstructorParameters<typeof Host>[4]
  try {
    const domain = await holder.context.storageDomain.open(hostSummaryDomainSpec)
    summaryStore = { table: domain.table('sessions'), close: () => domain.close() }
  } catch {
    summaryStore = undefined
  }
  holder.host = new Host(engine, holder.context, limits, workspace, summaryStore, options.ioAgent.model, options.connectionFor,
    join(resolve(options.ioAgent.stateDirectory), 'active'))
  return holder.host
}
