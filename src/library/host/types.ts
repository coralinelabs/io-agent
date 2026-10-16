/** Public host API types: configuration, the versioned HostEvent vocabulary, views and wire requests. */
import type { ContinuedQuestion } from '../interaction/continued/index.ts'
import type { IoAgentOptions } from "../runtime/options.ts"
import type { ModelConnection } from '../model/connection.ts'
import type { JsonValue } from '../util/values/index.ts'

export type QuestionRequest = Parameters<NonNullable<IoAgentOptions['onQuestion']>>[0]
export type QuestionAnswer = Awaited<ReturnType<NonNullable<IoAgentOptions['onQuestion']>>>
export type ApprovalRequest = Parameters<NonNullable<IoAgentOptions['onApproval']>>[0]
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled'

/** The HostEvent vocabulary version carried as `v` on every event. A breaking change bumps it. */
export const HOST_EVENT_VERSION = 1

/** A structured file mutation about to be applied, reported under the owning root session. */
export interface HostFileChange {
  /** Opaque identity of this mutation notification, identical in its before/complete callbacks.
   * Unlike provider call IDs, it is unique across sibling agents and repeated tool executions. */
  change_id: string
  /**
   * Root session whose work (possibly a delegated child's) makes the change. Absent when no session's
   * agent makes it (a tool run outside any agent), so there is no conversation to attribute it to.
   */
  session_id?: string
  turn_id?: string
  call_id: string
  /** The mutating tool (`write` or `edit`). */
  tool: string
  /** Absolute host paths about to change; a path may not exist yet. */
  paths: string[]
}

/** The embedded engine's options as a host takes them: the host owns the question, approval and file-change callbacks. */
export type HostEngineOptions = Omit<IoAgentOptions, 'onQuestion' | 'onApproval' | 'onFileChange'>

/** Host configuration is trusted; per-turn model selection is supplied separately from client JSON. */
export interface HostOptions {
  /** The embedded engine. */
  ioAgent: HostEngineOptions
  /**
   * Lifetime of one question or approval, including periods without an observer. Default: none (the longest
   * timer, about 24.8 days): it waits for its answer, its cancellation or the host closing.
   */
  interactionTimeoutMs?: number
  /** Activity identities retained per session, including the current one. Default: 128. */
  maxActivities?: number
  /** Immutable session/model adapter entries; idle session release frees them. Default: 1024. */
  maxModelConnections?: number
  /** Live replay events retained per session; per-activity open interaction count. Default: 65536. */
  maxReplayEvents?: number
  /** Live replay bytes retained per session; separately per-activity open interaction bytes. Default: 16777216. */
  maxReplayBytes?: number
  /**
   * An open session with no running work, running background job (its own or a delegated child's), pending
   * operation or attached watcher is released after this long without use, freeing its retained replay; its
   * history stays on disk and any call reopens it. Default: 600000 ms.
   */
  idleReleaseMs?: number
  /**
   * Awaited before a `write` or `edit` tool changes files, so the host can record their prior
   * content (for an undo it owns). A rejection fails that tool call before anything is written.
   */
  onFileChange?: (change: HostFileChange) => void | Promise<void>
  /** Awaited after an attempted structured mutation, before its tool result is published. */
  onFileChangeComplete?: (change: HostFileChange) => void | Promise<void>
  /**
   * The connection a session's turns last chose, asked when this host opens a session none of its own turns
   * chose one for (after a restart: background work reopening it, or any other call). An agent woken without a
   * client turn then runs where the session's turns ran. Undefined, or no answer, leaves `ioAgent.model`.
   */
  connectionFor?: (sessionId: string) => ModelConnection | undefined | Promise<ModelConnection | undefined>
}

/**
 * @deprecated The host options before io-agent, `pluto` in place of `ioAgent`, accepted by {@link createHost} for one
 * release. `ioAgent` wins whenever it is present; `pluto` alone is read with one `DeprecationWarning`.
 */
export type LegacyHostOptions = Omit<HostOptions, 'ioAgent'> & { pluto: HostEngineOptions; ioAgent?: HostEngineOptions }

export type HostErrorCode = 'INVALID_REQUEST' | 'UNKNOWN_SESSION' | 'UNKNOWN_ACTIVITY' | 'UNKNOWN_JOB' | 'UNKNOWN_WATCHER' | 'TURN_CONFLICT'
  | 'SESSION_BUSY' | 'SESSION_IDLE' | 'CAPACITY' | 'REPLAY_GAP' | 'INVALID_CURSOR' | 'REQUEST_CLOSED'
  | 'ANSWER_CONFLICT' | 'REQUEST_MISMATCH' | 'INVALID_ANSWER' | 'CLOSED' | 'TRANSPORT_ERROR'
  | 'INTERACTION_TIMEOUT' | 'UNKNOWN_OWNER' | 'UNSUPPORTED' | 'INTERNAL'

/** Serializable failure; private native causes are never sent to clients. */
export interface HostFailure { code: HostErrorCode; message: string }

/** Typed controls, separate from model tool-result text. */
export type InteractionRequest = { request_id: string; agent_id: string } & (
  | { kind: 'question'; questions: QuestionRequest['questions'] }
  | { kind: 'approval'; toolName: string; callId?: string; reason?: string; arguments?: unknown }
)
export type InteractionCloseReason = 'answered' | 'cancelled' | 'timeout' | 'shutdown' | 'settled'

/** How a tool call presents: `command` runs a program, the rest name what the call touches. */
export type HostToolKind = 'command' | 'read' | 'write' | 'edit' | 'search' | 'fetch' | 'image' | 'show'
  | 'plan' | 'delegate' | 'question' | 'other'
/** Why a turn ended. */
export type HostEndReason = 'done' | 'cancelled' | 'max_tokens' | 'error' | 'interrupted' | 'blocked'
export interface HostLocation { path: string; line?: number }
/** One changed region; `old` is null for inserted text or a created file. Long sides are cut and marked. */
export interface HostDiff { path: string; old: string | null; new: string; truncated?: true }
/**
 * A file a tool asks the UI to open (a generic result's `show`): an optional label, focus regions (1-based
 * lines, 1-based UTF-16 columns, `end` after the last character), inclusive line spans to fold, and the tool's
 * revision for the contents they were computed against. Bounded on projection; presentation only.
 */
export interface HostFileView { path: string; revision?: string; title?: string
  ranges?: { start: { line: number; column: number }; end: { line: number; column: number } }[]; folds?: { start: number; end: number }[] }
/** A durable prompt image; `path` is its stored copy on the host filesystem when the backend has one. */
export interface HostImage { media_type: string; width: number; height: number; name?: string; path?: string }
/** What the user submitted: text blocks joined by blank lines, plus images in order. */
export interface HostInput { text: string; images: HostImage[] }

/**
 * Version-1 event bodies. `text`/`reasoning` deltas, `tool_preview`, `interaction*`, `file_change` and `activity` are live only;
 * every other body is projected from the durable journal, so history and live delivery carry the same
 * events. A `message` carries the committed text and reasoning of one model reply and supersedes the
 * deltas streamed since the previous `message` (a retried attempt streams again).
 */
export type HostEventBody =
  | { type: 'question_state'; question: ContinuedQuestion }

  | { type: 'turn'; input: HostInput; metadata?: JsonValue }
  | { type: 'steered'; input: HostInput; metadata?: JsonValue }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'message'; text: string; reasoning: string; interrupted?: true }
  | { type: 'tool_start'; call_id: string; tool: string; kind: HostToolKind; title: string; detail?: string; locations: HostLocation[] }
  | { type: 'tool_end'; call_id: string; tool: string; kind: HostToolKind; ok: boolean; title: string; summary: string
    output?: string; exit_code?: number; diffs?: HostDiff[]; locations: HostLocation[]; image?: { path: string }; show?: HostFileView }
  /** Live notification after the host accepted a preimage, before the structured mutation. */
  | { type: 'file_change'; call_id: string; paths: string[] }
  /**
   * A file-changing call while the model is still writing it: the change its arguments describe so far, from the
   * tool's own call presentation, paced to a few a second. Best effort; `tool_start`/`tool_end` stay authoritative.
   */
  | { type: 'tool_preview'; call_id: string; tool: string; kind: HostToolKind; title: string; diffs: HostDiff[]; locations: HostLocation[] }
  | { type: 'interaction'; request: InteractionRequest }
  | { type: 'interaction_closed'; request_id: string; reason: InteractionCloseReason }
  /** Tokens of one model call; `input` counts the whole prompt, `cached` the part read from cache. */
  | { type: 'usage'; input: number; cached: number; output: number; reasoning?: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'end'; reason: HostEndReason }
  /** Native activity lifecycle; `settled` and `failed` follow its persistence barrier. */
  | { type: 'activity'; state: 'started' | 'settled' | 'failed'; error?: HostFailure }
  /**
   * A background command of the session started or ended (`finished` on its own, `killed`, or `failed` to run or
   * lost). Journaled: history carries it too. `at` is when it happened, which for an end seen after a restart is
   * earlier than the event.
   */
  | { type: 'job'; job_id: string; event: 'started' | 'finished' | 'killed' | 'failed'; label: string; detail?: string
    exit_code?: number | null; at: number }
  /**
   * The model endpoint failed (a refused connection, a stream silent past its idle bound, an overload) and the
   * request is tried again after `delay_ms`: attempt `attempt`, of `max_attempts` when the route bounds them.
   * Journaled. Without child_session_id, the session waits on its endpoint until the next message/retry/end.
   * With child_session_id, a delegated descendant is backing off; child_seq names its source journal event.
   */
  | { type: 'retry'; attempt: number; max_attempts?: number; delay_ms: number; code: string; message: string; child_session_id?: string; child_seq?: number }
  /** A watcher of the session was armed, fired, reached its deadline (`expired`) or was cancelled. Journaled. */
  | { type: 'watcher'; watch_id: string; event: 'armed' | 'fired' | 'expired' | 'cancelled'; waits_for: string; deadline: number
    result?: string; at: number }

/**
 * One delivered event. `seq` is journal-anchored: `Math.floor(seq / 2 ** 20)` counts the durable journal
 * events that existed when it was emitted, so a cursor keeps its meaning across history reads and host
 * restarts. `turn_id` names the submitted turn the event belongs to; `activity_id` exists on live
 * events only.
 */
export type HostEvent = { v: typeof HOST_EVENT_VERSION; seq: number; session_id: string; turn_id?: string; activity_id?: string } & HostEventBody

/** A durable prompt block: text, or a base64 image admitted into the attachment store. */
export type HostPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }

/** One new user turn. `context` reaches the model as a separate message before the prompt and is never shown as input. */
export interface TurnSubmission {
  session_id: string
  /** Client-chosen idempotency key, recorded durably with the turn. */
  turn_id: string
  prompt: string | HostPromptBlock[]
  context?: string
  /** Opaque bounded host annotation, durable but never sent to the model. */
  metadata?: JsonValue
}

/** Steering for running work, with the same hidden context and annotation semantics as a turn. */
export interface SteerSubmission {
  session_id: string
  prompt: string | HostPromptBlock[]
  /** Optional durable idempotency key. */
  steer_id?: string
  /** When present, only this running turn can receive the input. */
  turn_id?: string
  context?: string
  metadata?: JsonValue
}

/** Steering was durably admitted, not necessarily consumed or executed yet. */
export interface SteerReceipt { accepted: true }
/** Detached annotation for an admitted steer; no prompt content or routing credentials. */
export interface SteerLookup { receipt: SteerReceipt; metadata?: JsonValue }

/** Trusted host routing, never copied from the untrusted submission JSON. */
export interface TurnOptions { model?: ModelConnection }

/**
 * Admission, not execution success. Watch the session from `after` to see this turn's events; for a
 * duplicate whose events are no longer retained that watch reports REPLAY_GAP, and history has them.
 */
export interface TurnReceipt {
  session_id: string
  turn_id: string
  /** The activity this submission started; absent for a duplicate whose activity is no longer retained. */
  activity_id?: string
  /** Cursor preceding the turn's first event. */
  after: number
  /** True when `turn_id` was already admitted with the same content; nothing new was started. */
  duplicate: boolean
}

/** An admitted turn's receipt and detached opaque annotation, without prompt or routing credentials. */
export interface TurnLookup { receipt: TurnReceipt; metadata?: JsonValue }

export interface ActivityView {
  session_id: string
  activity_id: string
  /** Present when a submission started this activity. */
  turn_id?: string
  status: 'running' | 'settling' | 'settled'
  /** How the activity's last turn ended, once one did. */
  end?: HostEndReason
  error?: HostFailure
  pending_requests: readonly InteractionRequest[]
}

export type SessionStatus = 'idle' | 'working' | 'needs_you'

/** Retained live delivery after a cursor, plus current controls. */
export interface SessionView {
  session_id: string
  status: SessionStatus
  busy: boolean
  /** A background job runs or a watcher is armed: the agent will be woken later even while `idle`. */
  background: boolean
  delivery_error?: HostFailure
  activity?: ActivityView
  /** Cursor of the newest delivered event; pass it back as `after`. */
  last_seq: number
  events: readonly HostEvent[]
}

/** Durable history as the same events live delivery carries; tail live delivery from `cursor`. */
export interface SessionHistory {
  session_id: string
  events: readonly HostEvent[]
  cursor: number
  activity?: ActivityView
}

export interface SessionSummary {
  id: string
  title: string | null
  created_at: number
  /** Time of the last user input, model reply or turn end. */
  updated_at: number
  /** The latest reply's text (or the latest input), whitespace-collapsed and cut to 160 characters. */
  preview: string
  status: SessionStatus
  /** A background job runs or a watcher is armed (see {@link SessionView.background}). */
  background: boolean
}

/** One background job of a session. */
export interface HostBackgroundJob {
  job_id: string
  /** `bash` for a command; delegated work (`subagent`) is listed while its session is open. */
  kind: string
  /** The command, or the delegation's description. */
  label: string
  state: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Outcome detail once ended (`exit code: 0`, `stopped by the user`, ...). */
  detail?: string
  exit_code?: number | null
  started_at: number
  finished_at?: number
  /** It outlives a host restart: a command running as its own process, adopted again by the next host. */
  durable: boolean
  /** It ended and the agent has not yet taken in how (its notice waits for the agent's next step). */
  notice_pending?: true
}

/** One watcher of a session: a wait for a condition or a time that wakes the agent once. */
export interface HostWatcher {
  watch_id: string
  condition: 'time' | 'job' | 'output' | 'pid' | 'file' | 'url'
  state: 'armed' | 'fired' | 'expired' | 'cancelled'
  /** What it waits for, in plain words. */
  waits_for: string
  /** Epoch ms: when it wakes the agent at the latest (for a time watcher, the time itself). */
  deadline: number
  created_at: number
  settled_at?: number
  /** Once settled: what fired it, or the last observation at the deadline. */
  result?: string
  /** While armed: the latest observation. */
  last_poll?: string
  /** The model's own note, repeated to it when it is woken. */
  note?: string
  /** It settled and the agent has not yet taken in its notice. */
  notice_pending?: true
}

/** A future time the session's agent will be woken at the latest. */
export interface HostWakeup {
  at: number
  /** `watcher`: a watcher's deadline; `check_in`: an idle agent's look at its still-running jobs. */
  kind: 'watcher' | 'check_in'
  watch_id?: string
}

/** A session's background work, open or not. */
export interface BackgroundView {
  session_id: string
  /** A job runs or a watcher is armed. */
  active: boolean
  /** Newest first: running ones and recently ended ones (kept for days). */
  jobs: HostBackgroundJob[]
  /** Newest first: armed ones and recently settled ones. */
  watchers: HostWatcher[]
  /** Soonest first. */
  wakeups: HostWakeup[]
}

/** Something about a session's background work changed; read {@link BackgroundView} again for the whole picture. */
export interface BackgroundChange {
  session_id: string
  item: 'job' | 'watcher'
  /** The job or watcher, when known (a delegated job's change names none). */
  id?: string
  /** Its state after the change, when known. */
  state?: string
}

/** One full-text match in a user input or a model reply; `excerpt` is a bounded plain-text window around it. */
export interface SearchHit { session_id: string; seq: number; excerpt: string }

/** Outcome of deleting every session: each one either went or failed on its own. */
export interface DeleteAllResult {
  deleted: string[]
  failed: { session_id: string; error: HostFailure }[]
}

/** Answers carry request identity rather than matching question text. */
export type InteractionReply = { session_id: string; request_id: string; activity_id?: string } & (
  | { kind: 'question'; answer: QuestionAnswer }
  | { kind: 'approval'; decision: ApprovalDecision }
)
