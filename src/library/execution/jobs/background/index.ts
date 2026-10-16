/**
 * Background work that outlives the process (`ctx.background`): durable bash
 * jobs and watchers, both recorded on disk and both owned by their session
 * rather than by a live agent. Only root sessions own background work: a
 * delegated agent's work ends with it, as before.
 *
 * A durable job is a command running as a durable process (see
 * `io-agent/durable-process`). While its session's agent is live it is an
 * ordinary `ctx.jobs` job (same id, same tools, same completion notice);
 * when the agent goes (an idle release, a shutdown, a crash) the job is let
 * go, not killed, and this service keeps watching it. A later agent of the
 * session, in this process or the next, gets it back under its old id.
 *
 * A watcher waits for a condition or a time without holding a turn open and
 * wakes its agent exactly once: when the condition holds, or when its
 * deadline passes. Watchers are stored with absolute times and re-armed on
 * start; one whose moment passed while nothing ran fires late. A watcher on a
 * job reports that job's end itself, so the job's own notice is not sent too.
 *
 * Exactly-once delivery: a settled item's notice is owed (`notice: pending`)
 * until the agent's step takes it from the inbox and the journal holding that
 * step is on disk. Notices carry an id derived from the item, so an opening
 * after a restart recognizes one that is still queued (and wakes the agent
 * for it) or that the journal shows was already taken in (and sends nothing).
 * A notice discarded from the inbox (a cancel clears it) is queued again
 * without waking. A session whose agent is not live is announced through
 * {@link BackgroundWork.onAttention}, so a host can reopen it.
 * @module io-agent/background
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { stat, watch as watchFs } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '../../../runtime/vendor/cordis/index.ts'
import z from '../../../runtime/vendor/schemastery/index.ts'
import type { Agent } from '../../../runtime/agents/index.ts'
import { SessionId } from '../../../session/journal/index.ts'
import { freezeMessage, boundContextSummary } from '../../../model/llm/index.ts'
import type { MessageId, UserMessage } from '../../../model/llm/index.ts'
import { modelText } from '../../../context/text/index.ts'
import { JobId } from '../jobs/index.ts'
import type { JobOutcome, JobSnapshot } from '../jobs/index.ts'
import { noticeMessageId } from '../jobs/notice.ts'
import { adoptDurable, DurableOutput, readLaunchFacts, identify, isAlive, terminateMarked } from '../../process/durable/index.ts'
import type { DurableExit, DurableLaunch, DurableProcess } from '../../process/durable/index.ts'
import type { ShellProcess, ShellProcessRead } from '../../shell/shell/index.ts'
import { readJobRecords, readWatcherRecords, RecordWriter, removeRecord } from './records.ts'
import { LineMatcher, MatchStopped } from './matcher.ts'
import type { FileState, JobRecord, JobRecordOutcome, NoticeState, WatchCondition, WatcherRecord } from './records.ts'

export type { FileState, JobRecord, JobRecordOutcome, NoticeState, WatchCondition, WatcherRecord } from './records.ts'

declare module '../../../runtime/vendor/cordis/index.ts' {
  interface Context {
    background: BackgroundWork
  }
}

declare module '../../../session/journal/types.ts' {
  interface SessionEventMap {
    /**
     * A durable background job of this session started or ended. Informational: it names the
     * job, never changes the model surface, and is written when the session's agent is live
     * (late, with the original time in `at`, for an end seen while it was not).
     */
    'background/job': {
      job: string
      event: 'started' | 'ended'
      label: string
      status?: 'completed' | 'killed' | 'failed'
      detail?: string
      exitCode?: number | null
      at: number
    }
    /** A watcher of this session was armed or settled. Informational, like `background/job`. */
    'background/watch': {
      watcher: string
      event: 'armed' | 'fired' | 'expired' | 'cancelled'
      description: string
      deadline: number
      result?: string
      at: number
    }
  }
}

/** Plugin configuration. */
export interface Config {
  /** Directory holding job directories and watcher records. */
  root: string
  /** Delay between SIGTERM and SIGKILL when a job is killed (default 3 s). */
  graceMs?: number
  /** How often durable processes are checked (default 250 ms). */
  pollMs?: number
  /** Most armed watchers one session may hold (default 32). */
  maxWatchersPerSession?: number
  /** Deadline of a watcher whose call names none (default 60 minutes). */
  defaultWatchMs?: number
  /** Longest deadline a watcher may have (default 7 days). */
  maxWatchMs?: number
  /** How long settled records whose notice is taken care of are kept (default 7 days). */
  retainMs?: number
  /** Longest wait between two checks of an armed watcher (default 15 s), so a wall-clock jump is noticed. */
  recheckMs?: number
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  graceMs: z.number().min(1).default(3_000),
  pollMs: z.number().min(1).default(250),
  maxWatchersPerSession: z.number().min(1).default(32),
  defaultWatchMs: z.number().min(1).default(3_600_000),
  maxWatchMs: z.number().min(1).default(7 * 24 * 3_600_000),
  retainMs: z.number().min(0).default(7 * 24 * 3_600_000),
  recheckMs: z.number().min(1).default(15_000),
})

/** How often an armed watcher is checked, by condition. */
const POLL_MS: Record<WatchCondition['kind'], number> = { time: 15_000, job: 1_000, pid: 1_000, output: 1_000, file: 1_000, url: 5_000 }
/** One URL probe's bound; a probe that hangs is an answer of "not yet", and the next probe follows. */
const URL_PROBE_MS = 10_000
/** Longest matched line quoted back. */
const LINE_MAX = 500
/** Longest partial line an output watcher carries between reads. */
const CARRY_MAX = 64 * 1024
/** One forward read of an output watcher. */
const SCAN_CHUNK_BYTES = 1024 * 1024
/** Most output one check of an output watcher scans; the rest is scanned at once after. */
const SCAN_TICK_BYTES = 16 * 1024 * 1024
/** A watcher woken this much after its deadline says so. */
const LATE_MS = 60_000
/** How often settled records past their retention are removed. */
const SWEEP_MS = 3_600_000
/** Longest note kept on a watcher. */
const NOTE_MAX = 2000

/** A watcher request, validated by {@link BackgroundWork.arm}. */
export interface WatchRequest {
  job_id?: string
  pattern?: string
  pid?: number
  path?: string
  url?: string
  /** ISO 8601 time: alone, when to wake; beside a condition, the deadline. */
  at?: string
  /** Minutes from now: alone, when to wake; beside a condition, the deadline. */
  minutes?: number
  note?: string
}

/** A change hosts may want to show: one job or watcher of a session moved. */
export interface BackgroundChange {
  session: string
  item: 'job' | 'watcher'
  id: string
  /** The item's state after the change: a job phase or outcome status, or a watcher state. */
  state: string
}

/** Outcome mapping for a live job's process, supplied by the producer. */
export type ProcessOutcome = (process: ShellProcess) => { status: JobOutcome['status']; detail: string }

/** Read renderer for a job's output, supplied by the producer (the bash tool). */
export type ReadRenderer = (read: ShellProcessRead, process: ShellProcess | undefined) => string

interface JobBinding {
  readonly agent: Agent
  readonly settle: (outcome: JobOutcome) => void
  /** Bound to a job that had already ended: its settlement replays the record and decides nothing. */
  readonly replayed: boolean
}

interface JobEntry {
  readonly kind: 'job'
  record: JobRecord
  readonly directory: string
  /** The process: spawned here, or adopted from its directory. */
  process?: DurableProcess | undefined
  /** The executor's handle, for a process spawned in this process. */
  shell?: ShellProcess | undefined
  /** Cancellation of a job whose process is not spawned yet. */
  abort?: AbortController | undefined
  binding?: JobBinding | undefined
  render?: ReadRenderer | undefined
}

interface WatcherEntry {
  readonly kind: 'watcher'
  record: WatcherRecord
  timer?: ReturnType<typeof setTimeout> | undefined
  /** Partial last lines of an output watcher, per stream. */
  carry: { stdout: string; stderr: string }
  probing: boolean
  files?: AbortController | undefined
  /** An output watcher's matcher, off the host's thread. */
  matcher?: LineMatcher | undefined
  /** An output watcher its job's end settled (with the job's status): the rest of the output is read before its notice says how. */
  ending?: { status: string } | undefined
}

type Entry = JobEntry | WatcherEntry

/** A foreground command started durably, until it ends or becomes a job. */
export interface DurableSlot {
  readonly token: string
  readonly launch: DurableLaunch
}

/**
 * The background-work service. See the module notes.
 */
export class BackgroundWork extends Service {
  static inject = ['jobs', 'agents']
  static Config = Config

  private readonly config: Required<Config>
  private readonly writer = new RecordWriter()
  private readonly pendingSaves = new Map<Entry, { revision: number; promise: Promise<boolean> }>()
  private readonly jobs = new Map<string, JobEntry>()
  private readonly watchers = new Map<string, WatcherEntry>()
  /** Owed notices by message id. */
  private readonly owed = new Map<string, Entry>()
  /** Notice ids this service is taking out of an inbox itself, to send again with a wake. */
  private readonly rewaking = new Set<string>()
  /** Owed notices a cancel cleared from a live agent's inbox, kept to go in with its next turn. */
  private readonly parked = new Map<string, UserMessage>()
  /** Owed notices already handed to a live agent, which takes them in at its next step: not sent twice. */
  private readonly sent = new Map<string, Agent>()
  private readonly attention = new Set<(session: string) => void>()
  private readonly changes = new Set<(change: BackgroundChange) => void>()
  private readonly checkIns = new Map<string, number>()
  private renderer: ReadRenderer | undefined
  private sweeper: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'background')
    this.config = config as Required<Config>
    ctx.on('agent/created', async ({ agent }) => { await this.attach(agent); return undefined })
    // Claim is provisional: assembly or pre-step policy may still reject it. Keep a copy
    // for the next turn until the corresponding user/message actually enters the journal.
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const entry = this.owed.get(message.id)
      if (entry !== undefined && entry.record.session === String(agent.id)) this.parked.set(message.id, message)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const entry = this.owed.get(event.data.id)
      if (entry === undefined || entry.record.session !== String(session.id)) return
      this.parked.delete(event.data.id)
      // All append observers, including persistence, must enqueue this event before the barrier.
      queueMicrotask(() => { void this.confirmRead(entry) })
    })
    // A cancel clears the inbox. The notice stays owed and goes in with the agent's next turn (or
    // its next opening); it does not wake an agent someone just stopped.
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const entry = this.owed.get(message.id)
      if (entry === undefined || this.rewaking.has(message.id) || entry.record.session !== String(agent.id)) return
      this.sent.delete(message.id)
      this.parked.set(message.id, message)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'running' && this.serves(agent)) this.resend(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const session = String(agent.id)
      this.checkIns.delete(session)
      let owes = false
      for (const [id, entry] of this.owed) {
        if (entry.record.session !== session) continue
        if (this.sent.get(id) === agent) this.sent.delete(id)
        if (this.parked.delete(id)) continue
        owes = true
      }
      // Something was still owed (a notice held for a check-in, one queued as the agent went): a
      // host reopens the session to deliver it.
      if (owes) {
        const timer = setTimeout(() => { if (!this.closed && this.ctx.get('agents')?.get(agent.id) === undefined) this.announce(session) }, 0)
        timer.unref?.()
      }
    })
    ctx.jobs.onJobDone((snapshot) => { this.onRegistrySettled(snapshot) })
    ctx.effect(() => () => this.dispose(), 'background teardown')
  }

  /** Load every record, adopt running processes, re-arm watchers and note what is owed. */
  protected async [Service.init](): Promise<void> {
    const reserved: JobId[] = []
    for (const { directory, record } of await readJobRecords(this.config.root)) {
      if (record === undefined || record.phase === 'foreground') {
        // A directory without a record never became work anyone knows about, and a foreground
        // command's tool call ended with the process that started it: neither keeps running.
        await this.terminateIn(directory, record)
        await removeRecord(directory)
        continue
      }
      if (this.expired(record.phase === 'finished' ? record.outcome?.finishedAt : undefined, record.notice)) {
        await this.terminateIn(directory, record)
        await removeRecord(directory)
        continue
      }
      const entry: JobEntry = { kind: 'job', record, directory }
      this.jobs.set(record.token, entry)
      if (record.jobId !== undefined) reserved.push(JobId(record.jobId))
      if (record.phase !== 'finished') this.monitor(entry)
      else if (record.notice === 'pending') this.owed.set(this.noticeId(entry), entry)
    }
    this.ctx.jobs.reserve(reserved)
    for (const record of await readWatcherRecords(this.config.root)) {
      if (record.state !== 'armed' && this.expired(record.settledAt ?? record.createdAt, record.notice)) {
        await removeRecord(this.watcherPath(record))
        continue
      }
      const entry: WatcherEntry = { kind: 'watcher', record, carry: { stdout: '', stderr: '' }, probing: false }
      this.watchers.set(record.token, entry)
      if (record.state === 'armed') this.schedule(entry, 0)
      else if (record.notice === 'pending') this.owed.set(this.noticeId(entry), entry)
    }
    this.sweeper = setInterval(() => { void this.sweep() }, SWEEP_MS)
    this.sweeper.unref()
  }

  /**
   * Whether this agent's session can own background work: root sessions only. A delegated agent's
   * commands and waits end with it.
   * @param agent - the agent.
   * @returns true for a root session.
   */
  serves(agent: Agent): boolean {
    return !this.closed && agent.session.header.parentSession === undefined
  }

  /** The deadline a watcher gets when its call names none, in ms. */
  get defaultWatchMs(): number { return this.config.defaultWatchMs }

  // ---- producers (the bash tool) ----

  /**
   * Install the renderer for job output reads (the bash tool's own formatting).
   * @param render - renders one read.
   */
  setRenderer(render: ReadRenderer): void { this.renderer = render }

  /**
   * Record a foreground command that may become a job, before it starts.
   * @param owner - the calling agent.
   * @param label - the command.
   * @param bounds - read and disk bounds of its output.
   * @returns the slot whose launch the executor runs the command under.
   */
  async prepare(owner: Agent, label: string, bounds: { maxBytes: { stdout: number; stderr: number }; maxFileBytes: number }): Promise<DurableSlot> {
    const token = randomUUID()
    const record: JobRecord = { version: 1, token, session: String(owner.id), label, phase: 'foreground', startedAt: Date.now(),
      cursor: { stdout: 0, stderr: 0 }, ...bounds, journaled: {} }
    const entry: JobEntry = { kind: 'job', record, directory: join(this.config.root, 'jobs', token) }
    this.jobs.set(token, entry)
    try { await this.persist(entry) } catch (error) {
      this.jobs.delete(token)
      await removeRecord(entry.directory)
      throw error
    }
    return { token, launch: { directory: entry.directory, marker: token } }
  }

  /**
   * A prepared foreground command ended in the foreground. Its files go, unless its result points
   * at them (truncated output names the file holding all of it).
   * @param slot - the slot.
   * @param keepFiles - whether the result references the output files.
   */
  async release(slot: DurableSlot, keepFiles: boolean): Promise<void> {
    const entry = this.jobs.get(slot.token)
    if (entry === undefined || entry.record.phase !== 'foreground') return
    this.jobs.delete(slot.token)
    entry.process?.release()
    if (!keepFiles) {
      await this.writer.drain()
      await removeRecord(entry.directory)
      return
    }
    // Kept as a finished record nothing is owed for, so the retention sweep removes it later.
    entry.record.phase = 'finished'
    entry.record.notice = 'suppressed'
    entry.record.outcome = { status: 'completed', detail: '', exitCode: null, finishedAt: Date.now() }
    this.jobs.set(slot.token, entry)
    await this.persist(entry)
  }

  /**
   * Turn a prepared foreground command that outlasted its wait into a job.
   * @param slot - the slot it ran under.
   * @param owner - the calling agent.
   * @param process - the executor's handle of the still-running command.
   * @param outcome - maps the settled process to a job outcome.
   * @param render - renders reads.
   * @param outputLimitBytes - optional notice and read cap.
   * @returns the job id.
   */
  async continueAsJob(slot: DurableSlot, owner: Agent, process: ShellProcess, outcome: ProcessOutcome, render: ReadRenderer, outputLimitBytes?: number): Promise<JobId> {
    const entry = this.jobs.get(slot.token)
    if (entry === undefined || entry.record.phase !== 'foreground' || process.durable === undefined) {
      throw new Error('background: the command is not running durably')
    }
    const previous = entry.record
    entry.shell = process
    entry.process = process.durable
    entry.render = render
    const cursor = process.cursor?.()
    entry.record = { ...entry.record, phase: 'running', ...cursor === undefined ? {} : { cursor },
      ...outputLimitBytes === undefined ? {} : { outputLimitBytes } }
    let id: JobId
    try {
      id = this.bind(entry, owner, false)
      entry.record.jobId = id
      await this.persist(entry)
    } catch (error) {
      entry.binding?.settle({ status: 'failed', detail: String(error), reported: true })
      entry.binding = undefined
      entry.record = previous
      throw error
    }
    this.journalJob(entry, 'started')
    void this.follow(entry, process, outcome)
    this.changed(entry)
    return id
  }

  /**
   * Start a background command as a durable job.
   * @param spec - owner, label, output bounds, the executor start, outcome mapping and renderer.
   * @returns the job id, before the process exists.
   */
  async startJob(spec: {
    owner: Agent
    label: string
    maxBytes: { stdout: number; stderr: number }
    maxFileBytes: number
    outputLimitBytes?: number
    start: (launch: DurableLaunch, signal: AbortSignal) => Promise<ShellProcess>
    outcome: ProcessOutcome
    render: ReadRenderer
  }): Promise<JobId> {
    const token = randomUUID()
    const record: JobRecord = { version: 1, token, session: String(spec.owner.id), label: spec.label, phase: 'running', startedAt: Date.now(),
      cursor: { stdout: 0, stderr: 0 }, maxBytes: spec.maxBytes, maxFileBytes: spec.maxFileBytes, journaled: {},
      ...spec.outputLimitBytes === undefined ? {} : { outputLimitBytes: spec.outputLimitBytes } }
    const entry: JobEntry = { kind: 'job', record, directory: join(this.config.root, 'jobs', token), abort: new AbortController(), render: spec.render }
    const id = this.bind(entry, spec.owner, false)
    record.jobId = id
    this.jobs.set(token, entry)
    const abort = entry.abort as AbortController
    try { await this.persist(entry) } catch (error) {
      this.jobs.delete(token)
      entry.binding?.settle({ status: 'failed', detail: String(error), reported: true })
      await removeRecord(entry.directory)
      throw error
    }
    void (async () => {
      let process: ShellProcess | undefined
      try {
        // The record is durable before the process exists, so a crash never leaves an unknown process.
        abort.signal.throwIfAborted()
        process = await spec.start({ directory: entry.directory, marker: token }, abort.signal)
        entry.shell = process
        entry.process = process.durable
        this.journalJob(entry, 'started')
        this.changed(entry)
        if (abort.signal.aborted) process.kill()
      } catch (error: unknown) {
        await this.finishJob(entry, { status: abort.signal.aborted ? 'killed' : 'failed',
          detail: entry.record.stopReason ?? (error instanceof Error ? error.message : String(error)), exitCode: null })
        return
      }
      await this.follow(entry, process, spec.outcome)
    })()
    return id
  }

  // ---- watchers ----

  /**
   * Arm a watcher for the calling agent's session.
   * @param owner - the calling agent.
   * @param request - the condition, deadline and note.
   * @returns the armed record.
   */
  async arm(owner: Agent, request: WatchRequest): Promise<WatcherRecord> {
    if (!this.serves(owner)) throw new Error(modelText('runtime/tool-watch-index/error-no-session'))
    const session = String(owner.id)
    const now = Date.now()
    const armed = [...this.watchers.values()].filter(entry => entry.record.session === session && entry.record.state === 'armed')
    if (armed.length >= this.config.maxWatchersPerSession) {
      throw new Error(modelText('runtime/tool-watch-index/error-limit', { limit: String(this.config.maxWatchersPerSession) }))
    }
    const condition = this.condition(owner, request)
    // A time alone is the condition; beside a condition it is the deadline.
    const deadline = request.at !== undefined ? Date.parse(request.at)
      : now + (request.minutes === undefined ? this.config.defaultWatchMs : request.minutes * 60_000)
    if (deadline - now > this.config.maxWatchMs) {
      throw new Error(modelText('runtime/tool-watch-index/error-too-far', { days: String(Math.round(this.config.maxWatchMs / 86_400_000)) }))
    }
    const ordinal = 1 + Math.max(0, ...[...this.watchers.values()].filter(entry => entry.record.session === session)
      .map(entry => Number(entry.record.id.replace(/^watch-/, '')) || 0))
    const note = request.note === undefined || request.note === '' ? undefined
      : request.note.length <= NOTE_MAX ? request.note : `${request.note.slice(0, NOTE_MAX - 1)}…`
    const record: WatcherRecord = { version: 1, token: randomUUID(), id: `watch-${String(ordinal)}`, session, condition,
      ...note === undefined ? {} : { note }, createdAt: now, deadline, state: 'armed', journaled: {} }
    const entry: WatcherEntry = { kind: 'watcher', record, carry: { stdout: '', stderr: '' }, probing: false }
    this.watchers.set(record.token, entry)
    try {
      // Reserve capacity before observing a file; parallel tool calls share this bound.
      if (condition.kind === 'file') record.condition = { ...condition, baseline: await fileState(condition.path) }
      if (!this.holds(entry) || !this.serves(owner)) throw new Error('background watcher admission was cancelled')
      await this.persistWatcher(entry)
      if (!this.holds(entry) || !this.serves(owner)) throw new Error('background watcher admission was cancelled')
    } catch (error) {
      this.watchers.delete(record.token)
      await removeRecord(this.watcherPath(record))
      throw error
    }
    this.journalWatcher(entry)
    this.changed(entry)
    this.schedule(entry, 0)
    return { ...record }
  }

  /**
   * Cancel an armed watcher of a session. Nobody is woken for it.
   * @param session - the session id.
   * @param id - the watcher id.
   * @returns the record after cancellation, or undefined when the session has no such watcher.
   */
  async cancelWatcher(session: string, id: string): Promise<WatcherRecord | undefined> {
    const entry = [...this.watchers.values()].find(candidate => candidate.record.session === session && candidate.record.id === id)
    if (entry === undefined) return undefined
    if (entry.record.state === 'armed') {
      const previous = entry.record
      this.flip(entry, 'cancelled', undefined)
      try { await this.persistWatcher(entry) } catch (error) {
        entry.record = previous
        this.schedule(entry, 0)
        throw error
      }
      await this.afterSettle(entry)
    }
    return { ...entry.record }
  }

  /**
   * A job of the session ended: settle every armed watcher waiting for it, at once, so that the
   * watcher's notice is the one report of the end. Idempotent.
   * @param session - the job's session.
   * @param jobId - the job id.
   * @param status - the job's status text (`[status: completed, exit code: 0]`).
   * @returns whether a watcher took the end (the job's own notice is then not sent).
   */
  claimJobEnd(session: string, jobId: string, status: string): boolean {
    const ended = this.endWatchers(session, jobId, status)
    for (const entry of ended) void this.afterSettle(entry)
    return ended.length > 0
  }

  // ---- hosts ----

  /**
   * Register for sessions that have something to deliver while no agent of theirs is live.
   * @param listener - receives the session id.
   * @returns the disposer.
   */
  onAttention(listener: (session: string) => void): () => void {
    this.attention.add(listener)
    return () => { this.attention.delete(listener) }
  }

  /**
   * The sessions with an owed notice and no live agent: a host opening late (after a restart)
   * reopens these, as {@link onAttention} would have asked.
   * @returns session ids.
   */
  owedSessions(): string[] {
    const sessions = new Set<string>()
    for (const entry of this.owed.values()) {
      if (this.ctx.agents.get(SessionId(entry.record.session)) === undefined) sessions.add(entry.record.session)
    }
    return [...sessions]
  }

  /**
   * Register for every change to a job or watcher.
   * @param listener - receives the session, item and state.
   * @returns the disposer.
   */
  onChange(listener: (change: BackgroundChange) => void): () => void {
    this.changes.add(listener)
    return () => { this.changes.delete(listener) }
  }

  /**
   * The durable jobs of some sessions, newest first.
   * @param sessions - session ids.
   * @returns record copies.
   */
  jobsOf(sessions: ReadonlySet<string>): JobRecord[] {
    return [...this.jobs.values()].filter(entry => sessions.has(entry.record.session) && entry.record.phase !== 'foreground'
      && entry.record.jobId !== undefined).map(entry => structuredClone(entry.record)).sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * The watchers of some sessions, newest first.
   * @param sessions - session ids.
   * @returns record copies.
   */
  watchersOf(sessions: ReadonlySet<string>): WatcherRecord[] {
    return [...this.watchers.values()].filter(entry => sessions.has(entry.record.session))
      .map(entry => structuredClone(entry.record)).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Whether any of the sessions has a running job or an armed watcher.
   * @param sessions - session ids.
   * @returns true while background work is pending.
   */
  active(sessions: ReadonlySet<string>): boolean {
    for (const entry of this.jobs.values()) {
      if (sessions.has(entry.record.session) && (entry.record.phase === 'running' || entry.record.phase === 'stopping') && entry.record.jobId !== undefined) return true
    }
    for (const entry of this.watchers.values()) if (sessions.has(entry.record.session) && entry.record.state === 'armed') return true
    return false
  }

  /**
   * The sessions with background work pending (a running job or an armed watcher).
   * @returns session ids.
   */
  activeSessions(): string[] {
    const sessions = new Set<string>()
    for (const entry of this.jobs.values()) {
      if ((entry.record.phase === 'running' || entry.record.phase === 'stopping') && entry.record.jobId !== undefined) sessions.add(entry.record.session)
    }
    for (const entry of this.watchers.values()) if (entry.record.state === 'armed') sessions.add(entry.record.session)
    return [...sessions]
  }

  /**
   * When an idle agent's next check-in is due (the job controls report it).
   * @param session - the session id.
   * @param at - epoch ms, or undefined when none is armed.
   */
  noteCheckIn(session: string, at: number | undefined): void {
    if (at === undefined) this.checkIns.delete(session)
    else this.checkIns.set(session, at)
  }

  /**
   * @param session - the session id.
   * @returns the epoch ms of its next check-in, when one is armed.
   */
  checkInOf(session: string): number | undefined { return this.checkIns.get(session) }

  /**
   * Read a job's output for a viewer, without moving the agent's cursor.
   * @param session - the job's session.
   * @param jobId - its id.
   * @param stream - which stream.
   * @param from - whole-stream offset (0 for the retained tail).
   * @returns the read, or undefined for an unknown job.
   */
  peek(session: string, jobId: string, stream: 'stdout' | 'stderr', from: number): { text: string; next: number; lossy: boolean } | undefined {
    const entry = this.find(session, jobId)
    if (entry === undefined) return undefined
    const read = this.outputs(entry)[stream].readFrom(from)
    return { text: read.text, next: read.nextOffset, lossy: read.lossy }
  }

  /**
   * Kill a job of a session from outside it, live or not. Its agent is told how it ended, with the
   * reason as the detail.
   * @param session - the job's session.
   * @param jobId - its id.
   * @param reason - why, for the outcome's detail.
   * @returns what happened, or undefined for an unknown job.
   */
  async kill(session: string, jobId: string, reason?: string): Promise<'requested' | 'already-finished' | undefined> {
    const entry = this.find(session, jobId)
    if (entry === undefined) return undefined
    return this.killEntry(entry, reason)
  }

  /**
   * Remove every job and watcher of deleted sessions: running processes are killed, records deleted.
   * @param sessions - the deleted session ids.
   */
  async forget(sessions: ReadonlySet<string>): Promise<void> {
    for (const [id, entry] of [...this.owed]) {
      if (!sessions.has(entry.record.session)) continue
      this.owed.delete(id)
      this.sent.delete(id)
      this.parked.delete(id)
    }
    const doomedWatchers = [...this.watchers.values()].filter(entry => sessions.has(entry.record.session))
    // Withdraw watchers before waiting for any process: its death must not create a fresh notice.
    for (const entry of doomedWatchers) {
      if (entry.record.state === 'armed') this.flip(entry, 'cancelled', undefined)
      this.stopWatcher(entry)
      this.watchers.delete(entry.record.token)
    }
    const doomed = [...this.jobs.values()].filter(entry => sessions.has(entry.record.session))
    await Promise.all(doomed.map(async (entry) => {
      this.jobs.delete(entry.record.token)
      entry.abort?.abort()
      if (entry.process !== undefined) await entry.process.terminate(this.config.graceMs)
      else await this.terminateIn(entry.directory, entry.record)
      entry.process?.release()
      await this.writer.drain()
      await removeRecord(entry.directory)
    }))
    for (const entry of doomedWatchers) {
      await this.writer.drain()
      await removeRecord(this.watcherPath(entry.record))
    }
  }

  // ---- jobs: internals ----

  /** Register a job with the job registry for a live agent. */
  private bind(entry: JobEntry, agent: Agent, reported: boolean): JobId {
    const record = entry.record
    let settle!: (outcome: JobOutcome) => void
    const done = new Promise<JobOutcome>((resolveDone) => { settle = resolveDone })
    const binding: JobBinding = { agent, settle, replayed: record.phase === 'finished' }
    const id = this.ctx.jobs.start({
      kind: 'bash',
      label: record.label,
      owner: agent,
      key: record.token,
      ...record.jobId === undefined ? {} : { id: JobId(record.jobId) },
      ...record.outputLimitBytes === undefined ? {} : { outputLimitBytes: record.outputLimitBytes },
      ...reported ? { reported: true as const } : {},
      run: () => ({
        cancel: () => { void this.killEntry(entry).catch(error => this.ctx.logger.warn(`background: kill intent failed: ${String(error)}`)) },
        // The agent is going; the job is not. It stays recorded and watched here.
        detach: () => {
          if (entry.binding === binding) entry.binding = undefined
          settle({ status: 'killed', detail: 'detached', reported: true })
        },
        done,
        readOutput: () => this.read(entry),
      }),
    })
    entry.binding = binding
    if (record.phase === 'finished' && record.outcome !== undefined) settle(this.jobOutcome(entry, reported))
    return id
  }

  /** Wait for a live process and record how it ended. */
  private async follow(entry: JobEntry, process: ShellProcess, outcome: ProcessOutcome): Promise<void> {
    await process.done
    if (this.closed) return
    const mapped = outcome(process)
    const stopped = entry.record.stopReason
    await this.finishJob(entry, stopped === undefined ? { ...mapped, exitCode: process.exitCode }
      : { status: 'killed', detail: stopped, exitCode: process.exitCode })
  }

  /** Watch an adopted process until it ends; finish a kill a restart interrupted. */
  private monitor(entry: JobEntry): void {
    const process = this.adopt(entry.directory, entry.record)
    if (process === undefined) {
      // Recorded, but its launch never was (the harness stopped in between): nothing may be left running.
      void (async () => {
        await this.terminateIn(entry.directory, entry.record)
        await this.finishJob(entry, { status: 'failed', detail: modelText('runtime/background/job-never-started'), exitCode: null })
      })()
      return
    }
    entry.process = process
    if (entry.record.phase === 'stopping') void process.terminate(this.config.graceMs)
    void process.done.then(async (exit) => {
      if (this.closed) return
      await this.finishJob(entry, this.exitOutcome(exit, entry.record))
    })
  }

  private adopt(directory: string, record: JobRecord): DurableProcess | undefined {
    return adoptDurable(directory, { maxBytes: record.maxBytes, maxFileBytes: record.maxFileBytes, pollMs: this.config.pollMs })
  }

  /** Stop whatever runs in a job directory: its recorded process, or anything carrying its marker. */
  private async terminateIn(directory: string, record: JobRecord | undefined): Promise<void> {
    const marker = record?.token ?? directory.split(/[\\/]/).pop() ?? ''
    const process = adoptDurable(directory, { maxBytes: { stdout: 1, stderr: 1 }, maxFileBytes: Number.MAX_SAFE_INTEGER, pollMs: 3_600_000 })
    if (process !== undefined) {
      await process.terminate(this.config.graceMs)
      process.release()
    } else if (marker !== '') {
      await terminateMarked(marker, this.config.graceMs)
    }
  }

  private exitOutcome(exit: DurableExit, record: JobRecord): Omit<JobRecordOutcome, 'finishedAt'> {
    const ended = exit.exitCode !== null ? `exit code: ${String(exit.exitCode)}` : exit.signal !== null ? `signal: ${exit.signal}` : 'killed before exit'
    if (record.phase === 'stopping') return { status: 'killed', detail: record.stopReason ?? ended, exitCode: exit.exitCode }
    if (exit.lost) return { status: 'failed', detail: modelText('runtime/background/job-lost'), exitCode: null, lost: true }
    if (exit.exitCode === null) return { status: 'killed', detail: ended, exitCode: null }
    return { status: 'completed', detail: ended, exitCode: exit.exitCode }
  }

  private jobOutcome(entry: JobEntry, reported: boolean): JobOutcome {
    const outcome = entry.record.outcome as JobRecordOutcome
    return { status: outcome.status, detail: outcome.detail, ...reported || entry.record.notice !== 'pending' ? { reported: true as const } : {} }
  }

  /** Record a job's end durably, then let its registration settle (which sends its notice). */
  private async finishJob(entry: JobEntry, outcome: Omit<JobRecordOutcome, 'finishedAt'>): Promise<void> {
    // A job its deleted session took along (forget) is gone: nothing is recorded or owed for it.
    if (entry.record.phase === 'finished' || this.closed || this.jobs.get(entry.record.token) !== entry) return
    // A watcher on this job reports its end itself; the job's own notice would say it twice.
    const claimed = entry.record.jobId === undefined ? []
      : this.endWatchers(entry.record.session, entry.record.jobId, statusText(outcome.status, outcome.detail))
    entry.record = { ...entry.record, phase: 'finished', outcome: { ...outcome, finishedAt: Date.now() },
      notice: entry.record.notice ?? (claimed.length > 0 ? 'suppressed' : 'pending') }
    entry.abort = undefined
    if (entry.record.notice === 'pending') this.owed.set(this.noticeId(entry), entry)
    // The job's record lands before its watchers': a restart in between re-fires them, never the job's notice too.
    if (!await this.persistEventually(entry)) return
    for (const watcher of claimed) void this.afterSettle(watcher)
    if (this.closed) return
    this.journalJob(entry, 'ended')
    this.changed(entry)
    const binding = entry.binding
    if (binding !== undefined) binding.settle(this.jobOutcome(entry, false))
    else if (entry.record.notice === 'pending') this.announce(entry.record.session)
  }

  private async killEntry(entry: JobEntry, reason?: string): Promise<'requested' | 'already-finished'> {
    if (entry.record.phase === 'finished') {
      await this.terminateIn(entry.directory, entry.record)
      return 'already-finished'
    }
    const previous = entry.record
    const stopping = { ...entry.record, phase: 'stopping' as const, ...reason === undefined ? {} : { stopReason: reason } }
    entry.record = stopping
    try { await this.persist(entry) } catch (error) {
      if (entry.record === stopping) entry.record = previous
      throw error
    }
    this.changed(entry)
    if (entry.shell !== undefined) entry.shell.kill()
    else if (entry.process !== undefined) void entry.process.terminate(this.config.graceMs)
    else entry.abort?.abort()
    return 'requested'
  }

  /** A job's output files: through its process, or read directly once nothing watches it. */
  private outputs(entry: JobEntry): { stdout: DurableOutput; stderr: DurableOutput } {
    if (entry.process !== undefined) return { stdout: entry.process.stdout, stderr: entry.process.stderr }
    const finished = (): boolean => entry.record.phase === 'finished'
    const { maxBytes, maxFileBytes } = entry.record
    const captured = readLaunchFacts(entry.directory)?.captured ?? false
    return {
      stdout: new DurableOutput(join(entry.directory, 'stdout'), maxBytes.stdout, maxFileBytes, finished, captured),
      stderr: new DurableOutput(join(entry.directory, 'stderr'), maxBytes.stderr, maxFileBytes, finished, captured),
    }
  }

  /** The agent's consuming read: from the persisted cursor, which then moves. */
  private read(entry: JobEntry): string {
    const outputs = this.outputs(entry)
    const out = outputs.stdout.readFrom(entry.record.cursor.stdout)
    const err = outputs.stderr.readFrom(entry.record.cursor.stderr)
    entry.record.cursor = { stdout: out.nextOffset, stderr: err.nextOffset }
    void this.persistEventually(entry)
    const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
    const delta = out.text + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : '')
    const read: ShellProcessRead = { delta, lossy: out.lossy || err.lossy,
      ...out.spillPath !== undefined && out.lossy ? { stdoutSpillPath: out.spillPath } : {},
      ...err.spillPath !== undefined && err.lossy ? { stderrSpillPath: err.spillPath } : {} }
    const render = entry.render ?? this.renderer
    return render === undefined ? read.delta : render(read, entry.shell)
  }

  private onRegistrySettled(snapshot: JobSnapshot): void {
    // A job that is not durable (delegated work, say) may be what a watcher waits for: the job controls'
    // completion listener claims its end (claimJobEnd) and sends its own notice only when no watcher did.
    if (snapshot.key === undefined) return
    const entry = this.jobs.get(snapshot.key)
    if (entry === undefined || entry.record.phase !== 'finished' || entry.binding?.replayed === true) return
    // Killed by the agent or waited for: it already knows, so nothing is owed.
    if (snapshot.reported && entry.record.notice === 'pending') this.setNotice(entry, 'suppressed')
  }

  private find(session: string, jobId: string): JobEntry | undefined {
    return [...this.jobs.values()].find(entry => entry.record.session === session && entry.record.jobId === jobId)
  }

  // ---- watchers: internals ----

  /** Validate a request into a condition. */
  private condition(owner: Agent, request: WatchRequest): WatchCondition {
    const named = [request.job_id !== undefined, request.pid !== undefined, request.path !== undefined, request.url !== undefined].filter(Boolean).length
    if (request.pattern !== undefined && request.job_id === undefined) throw new Error(modelText('runtime/tool-watch-index/error-pattern-job'))
    if (request.at !== undefined && request.minutes !== undefined) throw new Error(modelText('runtime/tool-watch-index/error-at-and-minutes'))
    if (named > 1 || (named === 0 && request.at === undefined && request.minutes === undefined)) {
      throw new Error(modelText('runtime/tool-watch-index/error-one-condition'))
    }
    if (request.minutes !== undefined && (!Number.isFinite(request.minutes) || request.minutes <= 0)) {
      throw new Error(modelText('runtime/tool-watch-index/error-minutes'))
    }
    if (request.at !== undefined && !Number.isFinite(Date.parse(request.at))) throw new Error(modelText('runtime/tool-watch-index/error-time'))
    if (request.job_id !== undefined && request.pattern !== undefined) {
      try { new RegExp(request.pattern) } catch (error: unknown) {
        throw new Error(modelText('runtime/tool-watch-index/error-pattern', { reason: error instanceof Error ? error.message : String(error) }))
      }
      const entry = this.find(String(owner.id), request.job_id)
      if (entry === undefined) throw new Error(modelText('runtime/tool-watch-index/error-output-job', { job_id: request.job_id }))
      // From the job's current end: earlier output already happened.
      const outputs = this.outputs(entry)
      return { kind: 'output', job: request.job_id, pattern: request.pattern, cursor: { stdout: outputs.stdout.end(), stderr: outputs.stderr.end() } }
    }
    if (request.job_id !== undefined) {
      if (this.find(String(owner.id), request.job_id) === undefined && !this.registryHas(owner, request.job_id)) {
        throw new Error(modelText('runtime/tool-watch-index/error-unknown-job', { job_id: request.job_id }))
      }
      return { kind: 'job', job: request.job_id }
    }
    if (request.pid !== undefined) {
      const identity = Number.isSafeInteger(request.pid) && request.pid > 0 ? identify(request.pid) : undefined
      if (identity === undefined || !isAlive(identity)) throw new Error(modelText('runtime/tool-watch-index/error-pid', { pid: String(request.pid) }))
      return { kind: 'pid', pid: request.pid, ...identity.started === undefined ? {} : { started: identity.started },
        ...identity.bootId === undefined ? {} : { bootId: identity.bootId } }
    }
    if (request.path !== undefined) {
      if (request.path === '') throw new Error(modelText('runtime/tool-watch-index/error-path'))
      const cwd = owner.session.header.cwd ?? process.cwd()
      return { kind: 'file', path: isAbsolute(request.path) ? request.path : resolve(cwd, request.path), baseline: null }
    }
    if (request.url !== undefined) {
      let url: URL
      try { url = new URL(request.url) } catch { throw new Error(modelText('runtime/tool-watch-index/error-url')) }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(modelText('runtime/tool-watch-index/error-url'))
      return { kind: 'url', url: url.href }
    }
    return { kind: 'time' }
  }

  private registryHas(owner: Agent, jobId: string): boolean {
    try { this.ctx.jobs.get(JobId(jobId), owner); return true } catch { return false }
  }

  private schedule(entry: WatcherEntry, delayMs: number): void {
    clearTimeout(entry.timer)
    if (this.closed || entry.record.state !== 'armed') return
    entry.timer = setTimeout(() => { void this.tick(entry) }, Math.max(0, delayMs))
    entry.timer.unref?.()
    if (entry.record.condition.kind === 'file' && entry.files === undefined) this.watchFile(entry)
  }

  private async tick(entry: WatcherEntry): Promise<void> {
    if (this.closed || entry.record.state !== 'armed' || entry.probing || !this.holds(entry)) return
    entry.probing = true
    let probe: { met: boolean; result: string; more?: boolean }
    try {
      probe = await this.probe(entry)
    } catch (error: unknown) {
      probe = { met: false, result: error instanceof Error ? error.message : String(error) }
    } finally {
      entry.probing = false
    }
    if (this.closed || entry.record.state !== 'armed' || !this.holds(entry)) return
    const now = Date.now()
    if (probe.met) {
      this.flip(entry, 'fired', probe.result)
      await this.afterSettle(entry)
      return
    }
    entry.record.lastPoll = probe.result
    if (now >= entry.record.deadline) {
      // A time watcher's deadline is its moment: reaching it is what it waits for, even when the check ran just before.
      if (entry.record.condition.kind === 'time') this.flip(entry, 'fired', modelText('runtime/tool-watch-index/result-time', { at: new Date(entry.record.deadline).toISOString() }))
      else this.flip(entry, 'expired', probe.result)
      await this.afterSettle(entry)
      return
    }
    // A clock that jumps forward is noticed within one recheck; a scan with more to read goes on now.
    this.schedule(entry, probe.more === true ? 0 : Math.min(POLL_MS[entry.record.condition.kind], entry.record.deadline - now, this.config.recheckMs))
  }

  /** One observation of a watcher's condition. */
  private async probe(entry: WatcherEntry): Promise<{ met: boolean; result: string; more?: boolean }> {
    const record = entry.record
    const condition = record.condition
    switch (condition.kind) {
      case 'time':
        return { met: Date.now() >= record.deadline, result: modelText('runtime/tool-watch-index/result-time', { at: new Date(record.deadline).toISOString() }) }
      case 'job': {
        const state = this.jobState(record.session, condition.job)
        if (state === undefined) return { met: true, result: modelText('runtime/tool-watch-index/result-job-gone', { job_id: condition.job }) }
        return state.finished
          ? { met: true, result: modelText('runtime/tool-watch-index/result-job-finished', { job_id: condition.job, status: state.status }) }
          : { met: false, result: modelText('runtime/tool-watch-index/result-job-running', { job_id: condition.job }) }
      }
      case 'pid': {
        const alive = isAlive({ pid: condition.pid, ...condition.started === undefined ? {} : { started: condition.started },
          ...condition.bootId === undefined ? {} : { bootId: condition.bootId } })
        return alive
          ? { met: false, result: modelText('runtime/tool-watch-index/result-pid-running', { pid: String(condition.pid) }) }
          : { met: true, result: modelText('runtime/tool-watch-index/result-pid-exited', { pid: String(condition.pid) }) }
      }
      case 'output': return this.probeOutput(entry, condition)
      case 'file': {
        const now = await fileState(condition.path)
        const before = condition.baseline
        if (before === null && now !== null) return { met: true, result: modelText('runtime/tool-watch-index/result-file-appeared', { path: condition.path }) }
        if (before !== null && now === null) return { met: true, result: modelText('runtime/tool-watch-index/result-file-removed', { path: condition.path }) }
        if (before !== null && now !== null && (before.size !== now.size || before.mtimeMs !== now.mtimeMs || before.ino !== now.ino)) {
          return { met: true, result: modelText('runtime/tool-watch-index/result-file-changed', { path: condition.path }) }
        }
        return { met: false, result: now === null ? modelText('runtime/tool-watch-index/result-file-missing', { path: condition.path })
          : modelText('runtime/tool-watch-index/result-file-unchanged', { path: condition.path }) }
      }
      case 'url': {
        try {
          const response = await fetch(condition.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(URL_PROBE_MS) })
          void response.body?.cancel().catch(() => undefined)
          const result = modelText('runtime/tool-watch-index/result-url-answered', { url: condition.url, status: String(response.status) })
          return { met: response.status < 500, result }
        } catch (error: unknown) {
          const cause = (error as { cause?: { code?: string } }).cause?.code
          return { met: false, result: modelText('runtime/tool-watch-index/result-url-failed', { url: condition.url,
            reason: cause ?? (error instanceof Error ? error.message : String(error)) }) }
        }
      }
      default:
        return { met: false, result: '' }
    }
  }

  /** Scan the job's new output for the pattern; while the job runs, at most one tick's worth. */
  private async probeOutput(entry: WatcherEntry, condition: Extract<WatchCondition, { kind: 'output' }>): Promise<{ met: boolean; result: string; more?: boolean }> {
    const state = this.jobState(entry.record.session, condition.job)
    if (state === undefined) return { met: true, result: modelText('runtime/tool-watch-index/result-job-gone', { job_id: condition.job }) }
    let scan: { line?: string; more: boolean }
    try {
      scan = await this.scanOutput(entry, condition, state.finished)
    } catch (error: unknown) {
      if (!(error instanceof MatchStopped)) throw error
      // Stopped at the deadline (or by the watcher settling): no line was found in time.
      return { met: false, result: state.finished ? modelText('runtime/tool-watch-index/result-job-finished', { job_id: condition.job, status: state.status })
        : modelText('runtime/tool-watch-index/result-output-none', { job_id: condition.job }) }
    }
    if (scan.line !== undefined) {
      return { met: true, result: modelText('runtime/tool-watch-index/result-output-matched', { job_id: condition.job, line: cutLine(scan.line) }) }
    }
    if (state.finished && !scan.more) {
      return { met: true, result: modelText('runtime/tool-watch-index/result-output-ended', { job_id: condition.job, status: state.status }) }
    }
    return { met: false, result: modelText('runtime/tool-watch-index/result-output-none', { job_id: condition.job }), more: scan.more }
  }

  /**
   * Read the job's output forward from the watcher's cursor, line by line, until a line matches. The cursor
   * (with the partial line carried) moves past lines only once they were tested, so a stopped check reads them again.
   * @param entry - the watcher.
   * @param condition - its output condition.
   * @param final - the job ended: scan everything and treat the last partial line as complete.
   * @returns the matching line, if any, and whether unscanned output remains.
   * @throws {MatchStopped} when the match is stopped before it finishes.
   */
  private async scanOutput(entry: WatcherEntry, condition: Extract<WatchCondition, { kind: 'output' }>, final: boolean): Promise<{ line?: string; more: boolean }> {
    const job = this.find(entry.record.session, condition.job)
    if (job === undefined) return { more: false }
    const outputs = this.outputs(job)
    const cursor = { ...condition.cursor ?? { stdout: 0, stderr: 0 } }
    let more = false
    for (const stream of ['stdout', 'stderr'] as const) {
      let budget = final ? Number.POSITIVE_INFINITY : SCAN_TICK_BYTES
      while (budget > 0) {
        const read = outputs[stream].readForward(cursor[stream], Math.min(SCAN_CHUNK_BYTES, budget))
        const consumed = read.nextOffset - cursor[stream]
        budget -= Math.max(consumed, 1)
        const text = (read.skipped ? '' : entry.carry[stream]) + read.text
        const lines = text.split('\n')
        let carry = (lines.pop() ?? '').slice(-CARRY_MAX)
        const exhausted = consumed <= 0 || read.nextOffset >= outputs[stream].end()
        // An ended job's last line has no newline to wait for.
        if (final && exhausted && carry !== '') { lines.push(carry); carry = '' }
        const found = await this.firstMatch(entry, condition.pattern, lines)
        cursor[stream] = read.nextOffset
        entry.carry[stream] = carry
        entry.record.condition = { ...condition, cursor: { ...cursor } }
        const line = lines[found]
        if (line !== undefined) return { line, more: false }
        if (exhausted) break
        if (budget <= 0) more = true
      }
    }
    return { more }
  }

  /**
   * The first of `lines` the pattern matches, found in the watcher's worker. A match still running at the
   * watcher's deadline is stopped then; a late check (its deadline passed while nothing ran) reads what is there.
   */
  private async firstMatch(entry: WatcherEntry, pattern: string, lines: readonly string[]): Promise<number> {
    if (lines.length === 0) return -1
    const matcher = entry.matcher ??= new LineMatcher(pattern)
    const left = entry.record.deadline - Date.now()
    const stop = left > 0 ? setTimeout(() => { matcher.stop() }, left) : undefined
    stop?.unref?.()
    try {
      return await matcher.first(lines)
    } finally {
      clearTimeout(stop)
    }
  }

  /** The result of an output watcher its job's end settled: the rest of the output decides it. */
  private async endResult(entry: WatcherEntry, status: string): Promise<string> {
    const condition = entry.record.condition
    if (condition.kind !== 'output') return entry.record.result ?? ''
    try {
      const scan = await this.scanOutput(entry, condition, true)
      return scan.line !== undefined
        ? modelText('runtime/tool-watch-index/result-output-matched', { job_id: condition.job, line: cutLine(scan.line) })
        : modelText('runtime/tool-watch-index/result-output-ended', { job_id: condition.job, status })
    } catch {
      // Stopped at its deadline, or the output could not be read: the job's end is still what it reports.
      return modelText('runtime/tool-watch-index/result-job-finished', { job_id: condition.job, status })
    } finally {
      entry.matcher?.stop()
    }
  }

  /** A job's state for a watcher: a durable job of the session, or a live registry job. */
  private jobState(session: string, jobId: string): { finished: boolean; status: string } | undefined {
    const entry = this.find(session, jobId)
    if (entry !== undefined) {
      const outcome = entry.record.outcome
      return entry.record.phase === 'finished' && outcome !== undefined
        ? { finished: true, status: statusText(outcome.status, outcome.detail) } : { finished: false, status: '' }
    }
    const agent = this.ctx.agents.get(SessionId(session))
    if (agent === undefined) return undefined
    try {
      const snapshot = this.ctx.jobs.get(JobId(jobId), agent)
      const finished = snapshot.status !== 'running' && snapshot.status !== 'stopping'
      return { finished, status: statusText(snapshot.status, snapshot.detail) }
    } catch {
      return undefined
    }
  }

  /**
   * Settle, at once, every armed watcher of a session waiting for one job's end. An output watcher's result
   * waits for the rest of the output, which {@link afterSettle} reads off the host's thread.
   */
  private endWatchers(session: string, jobId: string, status: string): WatcherEntry[] {
    const ended: WatcherEntry[] = []
    for (const entry of this.watchers.values()) {
      const record = entry.record
      const condition = record.condition
      if (record.session !== session || record.state !== 'armed') continue
      if ((condition.kind !== 'job' && condition.kind !== 'output') || condition.job !== jobId) continue
      if (condition.kind === 'job') this.flip(entry, 'fired', modelText('runtime/tool-watch-index/result-job-finished', { job_id: jobId, status }))
      else {
        this.flip(entry, 'fired', undefined)
        entry.ending = { status }
      }
      ended.push(entry)
    }
    return ended
  }

  /** File events make a file watcher react at once; the poll stays the authority. */
  private watchFile(entry: WatcherEntry): void {
    const condition = entry.record.condition
    if (condition.kind !== 'file') return
    const files = new AbortController()
    entry.files = files
    const directory = resolve(condition.path, '..')
    void (async () => {
      try {
        for await (const _event of watchFs(directory, { signal: files.signal })) this.schedule(entry, 0)
      } catch {
        // Unwatchable (missing directory, no inotify): polling alone covers it.
      }
    })()
  }

  /** Whether the watcher is still this service's: a deleted session's watchers are dropped (forget). */
  private holds(entry: WatcherEntry): boolean { return this.watchers.get(entry.record.token) === entry }

  private stopWatcher(entry: WatcherEntry): void {
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.files?.abort()
    entry.files = undefined
    entry.matcher?.stop()
  }

  /** The synchronous part of settling: from now on the watcher is no longer armed. */
  private flip(entry: WatcherEntry, state: 'fired' | 'expired' | 'cancelled', result: string | undefined): void {
    this.stopWatcher(entry)
    entry.record = { ...entry.record, state, ...result === undefined ? {} : { result }, settledAt: Date.now(),
      notice: state === 'cancelled' ? 'suppressed' : 'pending' }
    if (entry.record.notice === 'pending') this.owed.set(this.noticeId(entry), entry)
  }

  /** Record a settled watcher, then wake its agent (or ask a host to reopen its session). */
  private async afterSettle(entry: WatcherEntry): Promise<void> {
    const ending = entry.ending
    if (ending !== undefined) {
      const result = await this.endResult(entry, ending.status)
      entry.ending = undefined
      entry.record = { ...entry.record, result }
    }
    // A watcher its deleted session took along (forget) is gone: its record is not written again.
    if (!this.holds(entry)) return
    if (!await this.persistEventually(entry)) return
    if (this.closed) return
    this.journalWatcher(entry)
    this.changed(entry)
    if (entry.record.notice !== 'pending') return
    const agent = this.ctx.agents.get(SessionId(entry.record.session))
    if (agent === undefined) this.announce(entry.record.session)
    else this.deliverWatcher(entry, agent)
  }

  private deliverWatcher(entry: WatcherEntry, agent: Agent): void {
    const id = this.noticeId(entry)
    // Still reading its job's last output: afterSettle delivers it with its result.
    if (entry.record.notice !== 'pending' || entry.ending !== undefined || this.sent.get(id) === agent) return
    if (pendingIn(agent, id)) {
      this.wake(agent, id)
      return
    }
    const message = freezeMessage({ role: 'user', id, content: [{ type: 'text', text: watcherNotice(entry.record) }],
      source: { kind: 'plugin', plugin: 'tool-watch', form: 'notice',
        summary: boundContextSummary(`${entry.record.id} ${entry.record.state}: ${entry.record.result ?? ''}`) } }) as UserMessage
    try {
      // A busy agent takes it at its next step, or continues for it; an idle one is woken.
      if (agent.status === 'idle') agent.followup(message)
      else agent.steer(message)
      this.sent.set(id, agent)
    } catch (error: unknown) {
      this.ctx.logger.warn(`background: watcher ${entry.record.id} notice could not be delivered: ${String(error)}`)
    }
  }

  // ---- delivery and journal ----

  /** A live agent of a session appeared: give it its jobs, journal what it missed, deliver what is owed. */
  private async attach(agent: Agent): Promise<void> {
    if (!this.serves(agent)) return
    const session = String(agent.id)
    const jobs = [...this.jobs.values()].filter(entry => entry.record.session === session && entry.binding === undefined
      && entry.record.jobId !== undefined && entry.record.phase !== 'foreground')
    const watchers = [...this.watchers.values()].filter(entry => entry.record.session === session)
    // An owed notice the inbox no longer holds may have been taken in just before the process
    // stopped: the journal says.
    const unsure = [...jobs, ...watchers].filter(entry => entry.record.notice === 'pending' && !pendingIn(agent, this.noticeId(entry)))
    if (unsure.length > 0) {
      const taken = await this.consumed(session, new Set(unsure.map(entry => this.noticeId(entry))))
      for (const entry of unsure) if (taken.has(this.noticeId(entry))) this.setNotice(entry, 'read')
    }
    if (this.closed || this.ctx.agents.get(agent.id) !== agent) return
    const queued = (entry: Entry): boolean => entry.record.notice === 'pending' && pendingIn(agent, this.noticeId(entry))
    for (const entry of jobs) {
      try {
        // A job whose notice is still queued in the inbox is not announced again: the wake below delivers it.
        this.bind(entry, agent, entry.record.phase === 'finished' && (entry.record.notice !== 'pending' || queued(entry)))
      } catch (error: unknown) {
        this.ctx.logger.warn(`background: job ${String(entry.record.jobId)} could not be adopted: ${String(error)}`)
      }
    }
    queueMicrotask(() => {
      if (this.closed || this.ctx.agents.get(agent.id) !== agent) return
      for (const entry of jobs) {
        this.journalJob(entry, 'started')
        if (entry.record.phase === 'finished') this.journalJob(entry, 'ended')
        if (queued(entry)) this.wake(agent, this.noticeId(entry))
      }
      for (const entry of watchers) {
        this.journalWatcher(entry)
        if (entry.record.notice === 'pending') this.deliverWatcher(entry, agent)
      }
    })
  }

  /**
   * Wake an idle agent for a notice already queued in its inbox (one an earlier opening queued):
   * the notice is taken out and sent again as a waking follow-up.
   */
  private wake(agent: Agent, id: MessageId): void {
    if (agent.status !== 'idle') return
    const message = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(pending => pending.id === id)
    if (message === undefined) return
    this.rewaking.add(id)
    try {
      agent.inbox.remove(id)
    } finally {
      this.rewaking.delete(id)
    }
    agent.followup(message)
    this.sent.set(id, agent)
  }

  /** A turn started: owed notices a cancel cleared go in with it, at its next step. */
  private resend(agent: Agent): void {
    const session = String(agent.id)
    for (const [id, message] of [...this.parked]) {
      const entry = this.owed.get(id)
      if (entry === undefined || entry.record.session !== session) continue
      this.parked.delete(id)
      if (pendingIn(agent, id)) continue
      try {
        agent.inject(message)
        this.sent.set(id, agent)
      } catch { /* its next opening delivers it */ }
    }
  }

  /** The notice ids among `ids` that a step of the session already took in, per its journal. */
  private async consumed(session: string, ids: ReadonlySet<string>): Promise<Set<string>> {
    const taken = new Set<string>()
    try {
      const log = await this.ctx.get('sessionQuery')?.readSession(SessionId(session))
      for (const event of log?.events ?? []) if (event.type === 'user/message' && ids.has(event.data.id)) taken.add(event.data.id)
    } catch (error: unknown) {
      this.ctx.logger.warn(`background: the journal of ${session} could not be read: ${String(error)}`)
    }
    return taken
  }

  private journalJob(entry: JobEntry, event: 'started' | 'ended'): void {
    const record = entry.record
    if (record.journaled[event] === true || record.jobId === undefined || record.phase === 'foreground') return
    if (event === 'ended' && record.outcome === undefined) return
    const agent = this.ctx.agents.get(SessionId(record.session))
    if (agent === undefined) return
    const outcome = record.outcome
    try {
      agent.session.append('background/job', { job: record.jobId, event, label: record.label,
        ...event === 'ended' && outcome !== undefined ? { status: outcome.status, detail: outcome.detail, exitCode: outcome.exitCode } : {},
        at: event === 'ended' && outcome !== undefined ? outcome.finishedAt : record.startedAt })
    } catch {
      return
    }
    record.journaled = { ...record.journaled, [event]: true }
    void this.persistEventually(entry)
  }

  private journalWatcher(entry: WatcherEntry): void {
    const record = entry.record
    const agent = this.ctx.agents.get(SessionId(record.session))
    if (agent === undefined) return
    const append = (event: 'armed' | 'fired' | 'expired' | 'cancelled', at: number): boolean => {
      try {
        agent.session.append('background/watch', { watcher: record.id, event, description: describeCondition(record), deadline: record.deadline,
          ...event === 'armed' || record.result === undefined ? {} : { result: record.result }, at })
        return true
      } catch {
        return false
      }
    }
    let changed = false
    if (record.journaled.armed !== true && append('armed', record.createdAt)) { record.journaled = { ...record.journaled, armed: true }; changed = true }
    if (record.state !== 'armed' && record.journaled.settled !== true && append(record.state, record.settledAt ?? Date.now())) {
      record.journaled = { ...record.journaled, settled: true }
      changed = true
    }
    if (changed) void this.persistEventually(entry)
  }

  private noticeId(entry: Entry): MessageId {
    return noticeMessageId(entry.kind === 'job' ? entry.record.token : `watch:${entry.record.token}`)
  }

  private setNotice(entry: Entry, state: NoticeState): void {
    if (entry.record.notice === state) return
    if (entry.kind === 'job') entry.record = { ...entry.record, notice: state }
    else entry.record = { ...entry.record, notice: state }
    if (state === 'pending') this.owed.set(this.noticeId(entry), entry)
    else void this.persistEventually(entry).then(saved => {
      if (!saved) return
      this.owed.delete(this.noticeId(entry))
      this.parked.delete(this.noticeId(entry))
      this.sent.delete(this.noticeId(entry))
    })
    if (state === 'pending') void this.persistEventually(entry)
  }

  /** A step took the notice in: once the journal holding it is on disk, the item owes nothing. */
  private async confirmRead(entry: Entry): Promise<void> {
    try {
      await this.ctx.get('sessionPersistence')?.flush()
    } catch {
      // Not known to be on disk: the notice stays owed, and the next opening asks the journal (attach).
      return
    }
    if (this.closed || entry.record.notice !== 'pending') return
    this.setNotice(entry, 'read')
  }

  private announce(session: string): void {
    if (this.closed) return
    for (const listener of this.attention) {
      try { listener(session) } catch (error: unknown) { this.ctx.logger.warn(`background: attention listener threw: ${String(error)}`) }
    }
  }

  private changed(entry: Entry): void {
    if (this.closed) return
    const record = entry.record
    const id = entry.kind === 'watcher' ? entry.record.id : entry.record.jobId
    if (id === undefined) return
    const state = entry.kind === 'watcher' ? entry.record.state
      : entry.record.phase === 'finished' ? entry.record.outcome?.status ?? 'finished' : entry.record.phase
    for (const listener of this.changes) {
      try { listener({ session: record.session, item: entry.kind, id, state }) } catch (error: unknown) {
        this.ctx.logger.warn(`background: change listener threw: ${String(error)}`)
      }
    }
  }

  private persist(entry: JobEntry): Promise<void> {
    if (this.closed) return Promise.reject(new Error('background service is closed'))
    return this.writer.write(join(entry.directory, 'record.json'), entry.record)
  }

  private persistWatcher(entry: WatcherEntry): Promise<void> {
    if (this.closed) return Promise.reject(new Error('background service is closed'))
    return this.writer.write(this.watcherPath(entry.record), entry.record)
  }

  /** Maintenance may retry; admission and caller-visible transitions use the rejecting barriers. */
  private persistEventually(entry: Entry): Promise<boolean> {
    const existing = this.pendingSaves.get(entry)
    if (existing !== undefined) {
      existing.revision += 1
      return existing.promise
    }
    const pending = { revision: 0, promise: Promise.resolve(false) }
    this.pendingSaves.set(entry, pending)
    pending.promise = (async () => {
      while (!this.closed && (entry.kind === 'job' ? this.jobs.get(entry.record.token) === entry : this.holds(entry))) {
        const revision = pending.revision
        try {
          await (entry.kind === 'job' ? this.persist(entry) : this.persistWatcher(entry))
          // Updates made during a write must land too before any settlement/ack proceeds.
          if (revision !== pending.revision) continue
          return !this.closed && (entry.kind === 'job' ? this.jobs.get(entry.record.token) === entry : this.holds(entry))
        } catch (error) {
          this.ctx.logger.warn(`background: record ${entry.record.token} remains pending: ${String(error)}`)
          await sleep(this.config.pollMs, undefined, { ref: false })
        }
      }
      return false
    })().finally(() => { this.pendingSaves.delete(entry) })
    return pending.promise
  }

  private watcherPath(record: WatcherRecord): string { return join(this.config.root, 'watchers', `${record.token}.json`) }

  /** Whether a settled record whose notice is taken care of is past its retention. */
  private expired(settledAt: number | undefined, notice: NoticeState | undefined): boolean {
    return settledAt !== undefined && notice !== 'pending' && Date.now() - settledAt > this.config.retainMs
  }

  /** Remove settled records past their retention. */
  private async sweep(): Promise<void> {
    for (const entry of [...this.jobs.values()]) {
      if (this.closed) return
      if (entry.record.phase !== 'finished' || entry.binding !== undefined || !this.expired(entry.record.outcome?.finishedAt, entry.record.notice)) continue
      this.jobs.delete(entry.record.token)
      await this.terminateIn(entry.directory, entry.record)
      await this.writer.drain()
      await removeRecord(entry.directory)
    }
    for (const entry of [...this.watchers.values()]) {
      if (this.closed) return
      if (entry.record.state === 'armed' || !this.expired(entry.record.settledAt, entry.record.notice)) continue
      this.watchers.delete(entry.record.token)
      await this.writer.drain()
      await removeRecord(this.watcherPath(entry.record))
    }
  }

  /** Stop watching; processes keep running and records stay for the next start. */
  private async dispose(): Promise<void> {
    clearInterval(this.sweeper)
    this.closed = true
    await this.writer.drain()
    for (const entry of this.jobs.values()) {
      entry.process?.release()
      entry.shell?.release?.()
    }
    for (const entry of this.watchers.values()) this.stopWatcher(entry)
    this.attention.clear()
    this.changes.clear()
  }
}

/** Status text in the job controls' bracket form. */
function statusText(status: string, detail: string | undefined): string {
  return detail === undefined || detail === '' ? `[status: ${status}]` : `[status: ${status}, ${detail}]`
}

/** Whether a message with this id waits in the agent's inbox. */
function pendingIn(agent: Agent, id: string): boolean {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === id)
}

/** The model-facing notice of a settled watcher. */
function watcherNotice(record: WatcherRecord): string {
  const lines = [modelText(record.state === 'fired' ? 'runtime/tool-watch-index/notice-fired' : 'runtime/tool-watch-index/notice-expired',
    { watch_id: record.id, result: record.result ?? '' })]
  // Woken at (or for) its deadline, but well after it: nothing was running to wake it on time.
  const late = (record.settledAt ?? record.deadline) - record.deadline
  if ((record.state === 'expired' || record.condition.kind === 'time') && late > LATE_MS) {
    lines.push(modelText('runtime/tool-watch-index/notice-late', { due: new Date(record.deadline).toISOString(), minutes: String(Math.round(late / 60_000)) }))
  }
  if (record.note !== undefined) lines.push(modelText('runtime/tool-watch-index/notice-note', { note: record.note }))
  return lines.join('\n')
}

async function fileState(path: string): Promise<FileState | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino }
  } catch {
    return null
  }
}

function cutLine(line: string): string {
  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`
}

/**
 * A plain description of what a watcher waits for (for tool results, hosts and the journal).
 * @param record - the watcher.
 * @returns a short phrase.
 */
export function describeCondition(record: Pick<WatcherRecord, 'condition' | 'deadline'>): string {
  const condition = record.condition
  switch (condition.kind) {
    case 'job': return modelText('runtime/tool-watch-index/waits-job', { job_id: condition.job })
    case 'output': return modelText('runtime/tool-watch-index/waits-output', { job_id: condition.job, pattern: condition.pattern })
    case 'pid': return modelText('runtime/tool-watch-index/waits-pid', { pid: String(condition.pid) })
    case 'file': return modelText('runtime/tool-watch-index/waits-file', { path: condition.path })
    case 'url': return modelText('runtime/tool-watch-index/waits-url', { url: condition.url })
    default: return modelText('runtime/tool-watch-index/waits-time', { at: new Date(record.deadline).toISOString() })
  }
}

export default BackgroundWork
