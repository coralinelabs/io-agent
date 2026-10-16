/**
 * Execution types for the bash executor seam. Background job semantics belong
 * to `io-agent/jobs`; this seam exposes only process handles. The
 * managed-environment and captured-output vocabulary is owned by the
 * subprocess seam and re-exported here so bash consumers keep one import
 * root.
 * @module dsh-shell/types
 */

import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from "../../sandbox/sandbox/index.ts"
import type { CollectedOutput, ManagedEnvironment } from "../../process/subprocess/index.ts"
import type { DurableLaunch, DurableProcess } from "../../process/durable/index.ts"

export { MANAGED_ENV_PREFIX } from "../../process/subprocess/index.ts"
export type { CollectedOutput, ManagedEnvironment, ManagedEnvironmentKey } from "../../process/subprocess/index.ts"

/**
 * Sandbox facts for one run, present iff a sandboxing executor handled it.
 * Facts are reported independently of process exit status so callers can
 * distinguish command failures from policy denials and runner failures.
 */
export interface ShellSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /** Whether the sandbox denied a file operation. */
  denied: boolean
  /** How completely the selected runner enforced the requested mode. */
  enforcement?: SandboxEnforcement
  /** Whether the sandbox runner failed before the command could run. */
  runnerFailed?: boolean
}

/**
 * A caller's execution REQUEST: `workdir` and `timeoutMs` are optional and
 * filled by {@link ShellExecutor.resolve} from the implementation's config.
 * This is the model-/plugin-facing shape; pass it to `resolve()` to obtain a
 * fully-resolved {@link ShellExecSpec}.
 */
export interface ShellExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /**
   * When the resolved timeout passes, hand the still-running command back as
   * {@link ShellRunResult.detached} instead of terminating it. Executors that
   * cannot detach keep the timeout kill.
   */
  detachOnTimeout?: boolean | undefined
  /**
   * Run the command as a durable process under this launch (output in files,
   * outside every process range of the harness), so it can outlive the
   * harness. For background starts and `detachOnTimeout` runs; executors that
   * cannot run durably ignore it, and stdin data disables it.
   */
  durable?: DurableLaunch | undefined
  /**
   * Foreground stdout capture budget in bytes. Absent uses the executor's
   * default output cap. Trusted in-process consumers use this when they must
   * parse complete stdout up to their own bounded limit; the model-facing bash
   * tool does not expose it as a parameter.
   */
  stdoutMaxBytes?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the command's stdin, then close it. Absent leaves stdin
   * closed/empty (the default for model-driven tool calls). Set by in-process
   * plugins (e.g. the hooks bridges, which write a hook command's JSON payload
   * to its stdin); the model-facing bash tool does not expose it as a parameter
   * (a model that needs stdin uses shell syntax like a heredoc or a pipe).
   */
  stdin?: string | undefined
  /**
   * Ordinary environment entries for the command, merged after the credential
   * scrub. Managed facts belong in {@link managedEnv}, which merges after this
   * map, so an entry here can never displace one. Set by in-process plugins
   * (the hooks bridges set `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, …); the
   * model-facing bash tool does not expose it as a parameter.
   */
  env?: Record<string, string> | undefined
  /**
   * Harness-owned `IO_AGENT_*` variables for this execution (typed to managed
   * keys). Executors discard ambient `IO_AGENT_*` entries before merging this
   * snapshot last, so an unavailable current fact cannot inherit a stale
   * value from the harness process and a caller {@link env} entry cannot
   * displace a managed one.
   */
  managedEnv?: ManagedEnvironment | undefined
  /** Fully resolved per-call sandbox policy; sandboxing executors default it. */
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}

/**
 * A resolved execution spec. {@link ShellExecutor.resolve} fills and caps the
 * required fields; {@link ShellExecutor.start} ignores `timeoutMs` because
 * background processes have no executor timeout.
 */
export interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** Carried from {@link ShellExecRequest.detachOnTimeout}: `run()` detaches instead of killing at the timeout. */
  detachOnTimeout?: boolean | undefined
  /** Carried from {@link ShellExecRequest.durable}. */
  durable?: DurableLaunch | undefined
  /**
   * Resolved foreground stdout capture budget in bytes. `run()` uses it for
   * stdout; background jobs and stderr keep the executor's own output cap.
   */
  stdoutMaxBytes: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /** Bytes to write to stdin before closing it; absent means no stdin. */
  stdin?: string | undefined
  /**
   * Ordinary environment entries carried through from
   * {@link ShellExecRequest.env}; {@link managedEnv} still merges after them.
   * OPTIONAL on the spec for the same reason as `stdin`: absent means no
   * ordinary extra environment.
   */
  env?: Record<string, string> | undefined
  /** Managed `IO_AGENT_*` snapshot (typed to managed keys); merges after {@link env}. */
  managedEnv?: ManagedEnvironment | undefined
  /** Resolved sandbox policy; ignored by executors that do not confine. */
  sandboxPolicy: SandboxExecutionPolicy | undefined
}

/** The outcome of a foreground run, including timeout during preparation. */
export interface ShellRunResult {
  /** Exit code; null when preparation expired or the process died from a signal. */
  exitCode: number | null
  /** Terminating signal, or null when none was reported, including preparation expiry. */
  signal: NodeJS.Signals | null
  /**
   * True when the executor's own timeout was the FIRST cause to cut the command
   * short. Mutually exclusive with {@link aborted}: one fused deadline drives
   * both the timeout and the caller's cancellation, so a timeout and an abort
   * racing before process close report the single first-abort cause, not both.
   */
  timedOut: boolean
  /**
   * True when the caller's `AbortSignal` was the FIRST cause to kill the command
   * (and it was not the executor's own timeout). Mutually exclusive with
   * {@link timedOut} — see there for the first-cause classification.
   */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  /** Sandbox execution facts, absent for an unsandboxed executor. */
  sandbox?: ShellSandboxInfo
  /**
   * The command, still running at the timeout of a `detachOnTimeout` run. It
   * keeps running and collecting output; `stdout`/`stderr` hold the output up
   * to the detach, and its reads continue from there. `timedOut` is true and
   * the exit facts are null. The caller owns it from here: kill it or hand it
   * to a job registry.
   */
  detached?: ShellProcess
}

/** Lifecycle of a background process. */
export type ShellProcessStatus = 'running' | 'completed' | 'killed'

/** One incremental {@link ShellProcess.readOutput} read. */
export interface ShellProcessRead {
  /** Output produced since the previous read (stderr in a marked section). */
  delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and a safe path is available. */
  stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and a safe path is available. */
  stderrSpillPath?: string
}

/**
 * A background process handle returned by {@link ShellExecutor.start}. It is the
 * only access path; buffered output remains readable after exit. Composition
 * teardown (the subprocess service's disposal) kills running processes and
 * awaits {@link done}; an executor-only reload leaves them running.
 */
export interface ShellProcess {
  /** Process lifecycle state (settled exactly once). */
  status: ShellProcessStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /**
   * Resolves when the underlying process settles (never rejects — provider
   * rejection settles as `killed` with a stage-neutral error on stderr).
   */
  readonly done: Promise<void>
  /** Sandbox facts, stamped once a confined process settles. */
  sandbox?: ShellSandboxInfo
  /**
   * Why the process infrastructure, not the command, ended it: set when the
   * subprocess provider rejected before reporting an outcome. A command's own
   * nonzero exit or signal never sets it; a sandbox runner failure is reported
   * in {@link sandbox}.
   */
  failure?: string
  /**
   * Read output produced since the previous read (consuming — consecutive
   * reads never re-deliver). Reads that lost data flag `lossy` and point at
   * full-stream spill files when available.
   */
  readOutput(): ShellProcessRead
  /**
   * Terminate the provider-managed range. Returns false when it had already finished
   * (no-op); idempotent.
   */
  kill(): boolean
  /** The durable process behind this handle, when it runs durably ({@link ShellExecRequest.durable}). */
  readonly durable?: DurableProcess
  /** Durable only: the whole-stream offsets {@link readOutput} has consumed. */
  cursor?(): { stdout: number; stderr: number }
  /** Durable only: stop watching the process without stopping it (the harness is going away). */
  release?(): void
}
