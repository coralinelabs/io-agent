/**
 * Types shared by job producers, the registry, and controllers. The
 * service implementation lives in `./index.ts`.
 * @module io-agent/jobs/types
 */

import type { Agent } from "../../../runtime/agents/index.ts"
import type { SessionId } from "../../../session/journal/index.ts"
import type { JobId } from './brand.ts'

export { JobId } from './brand.ts'

/**
 * Task lifecycle: `running`, optionally `stopping`, then exactly one terminal
 * status. Producer-specific facts belong in {@link JobSnapshot.detail}.
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}

/** The merge-extensible union of registered producer kind names. */
export type JobKind = JobKindMap[keyof JobKindMap]

/** Terminal result supplied by a producer through {@link JobHooks.done}. */
export interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Optional canonical final report, independent of consumable progress. Terminal model reads
   * repeat this report; live observers receive it once after the last collected progress bytes. */
  output?: string
  /**
   * The producer already told the owner how the job ended (a watcher on it
   * fired, or the outcome predates this registration): settlement announces
   * nothing.
   */
  reported?: true
}

/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity and lifecycle state.
 */
export interface JobStart {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata.
   */
  outputLimitBytes?: number
  /**
   * Owning live agent. Access is fenced by its session id, and agent disposal
   * cancels and awaits the job. The instance must be the one currently
   * registered under its agent id. Omitting the owner creates an unowned job,
   * open to any caller until service disposal.
   */
  owner?: Agent
  /**
   * Adopt an id the work already has (a durable job resumed after a restart):
   * `<kind>-N`, unused. Omission issues the next id. Either way later ids
   * continue past it.
   */
  id?: JobId
  /**
   * Producer-supplied identity that outlives this process (a durable job's
   * token). Completion notices derive their message identity from it, so a
   * notice re-sent after a restart is recognized as the same one.
   */
  key?: string
  /**
   * The outcome was already reported before this registration (an adopted job
   * whose notice was delivered before a restart): settlement announces nothing.
   */
  reported?: true
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once; a throw leaves nothing registered, and the producer must clean up any
   * partially started resources.
   */
  run(): JobHooks
}

/** Hooks through which the runtime controls and observes producer work. */
export interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped.
   */
  done: Promise<JobOutcome>
  /**
   * Consume output produced since the previous call. The producer formats
   * truncation and spill notices. Absence marks a final-output-only job; each
   * job has one consuming cursor.
   */
  readOutput?(): string
  /**
   * Let go of the work without stopping it. When present, owner and service
   * teardown call it instead of {@link cancel}: the work outlives its owner
   * (a durable job another process can adopt). Must be synchronous and settle
   * {@link done} promptly; the settlement is teardown's and reports nothing.
   */
  detach?(): void
}

/**
 * A read-only projection of one job, safe to hand to listeners and tools —
 * a fresh object per call, never live registry state.
 */
export interface JobSnapshot {
  /** The registry-issued id (`<kind>-N`). */
  id: JobId
  /** The producer kind the job was registered with. */
  kind: JobKind
  /** The producer-supplied one-line label. */
  label: string
  /** Producer-owned cap for complete model-facing notices and output reads. */
  outputLimitBytes?: number
  /** Producer identity that outlives the process, when the producer supplied one ({@link JobStart.key}). */
  key?: string
  /**
   * Owner session id used for authorization and correlation; absent for
   * unowned jobs. Completion listeners receive the exact {@link Agent}
   * separately through {@link JobDoneListener}.
   */
  ownerSession?: SessionId
  /** Current lifecycle state. */
  status: JobStatus
  /** Kind-specific status detail, present once the producer supplied one (usually terminal). */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while `running`/`stopping`. */
  finishedAt?: number
  /**
   * True when a kill, read, wait, or teardown cancel has reported or committed
   * to report the terminal state. Completion reporters suppress redundant
   * notices when set. Teardown claims it because the owner or service being
   * destroyed leaves no reader: a reporter that opens a turn on notice would
   * otherwise spend a model request per teardown layer.
   */
  reported: boolean
}

/** Output and post-read state returned by {@link JobRegistry.read}. */
/** A stream generation fences process restarts or re-adoption of the same durable job id. */
export interface JobOutputCursor { streamId: string; offset: number }
/** Non-consuming, bounded observation. It never acknowledges a model completion notice. */
export interface JobOutputPage {
  text: string
  from: number
  cursor: JobOutputCursor
  earliest: number
  total: number
  lossy: boolean
  snapshot: JobSnapshot
  /** Reading output failed; this does not change the actual operation's outcome. */
  outputError?: string
}
export interface JobOutputOptions {
  cursor?: JobOutputCursor
  maxBytes?: number
}

export interface JobRead {
  /** Some unread bytes were evicted from the bounded registry view. */
  lossy?: true
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}

/**
 * Completion callback with the exact owner supplied at start, or `undefined`
 * for an unowned job. Returned promises are observed but not awaited.
 */
export type JobDoneListener = (
  snapshot: JobSnapshot,
  owner: Agent | undefined,
) => void | PromiseLike<void>

/**
 * Observation callback for a change to what one owner's {@link JobRegistry.list}
 * would return. It is owner-granular rather than job-granular because the
 * change may be a removal, which no per-job record can express, and because
 * its consumers re-read the whole visible set anyway.
 *
 * An `undefined` owner means an unowned job changed, so every caller's visible
 * set changed with it.
 */
export type JobsChangedListener = (owner: Agent | undefined) => void
