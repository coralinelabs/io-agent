/**
 * Local Service Provider for the bash capability seam over the subprocess
 * capability seam. Public commands run as `bash -c` in a provider-managed range
 * through `ctx.subprocess`; subclasses may reuse the same mechanics with an
 * explicit argv. This executor owns command defaulting, deadlines and cause
 * classification, the model-friendly terminal environment, and the model-facing
 * stdout/stderr merge for background reads. Execution policy belongs in
 * `tools/pre-execute` or a sandboxing executor.
 * @module io-agent/bash-local
 */

import { Context } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import { SHELL_SETTINGS_NAMESPACE, ShellExecutor } from "../shell/index.ts"
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellProcessRead, ShellRunResult, CollectedOutput } from "../shell/index.ts"
import { isInheritableEnvEntry } from "../../process/subprocess/index.ts"
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from "../../process/subprocess/index.ts"
import { spawnDurable } from "../../process/durable/index.ts"
import type { DurableProcess } from "../../process/durable/index.ts"
import type {} from "../../../runtime/settings/index.ts"
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from "../../../util/timeout/index.ts"
import { withLegacyAliases } from "../../../util/env-names/index.ts"
import { captureLoginEnvironment, LOGIN_ENV_TIMEOUT_MS } from './login-env.ts'

/**
 * Model-friendly environment overrides: disable colors, pagers, and
 * interactive terminal features that would garble tool output (the same set
 * Codex hardcodes; Claude Code achieves it via TERM=dumb). Bash-tool policy —
 * merged into the spawn's explicit env above the login-shell snapshot, so a
 * trusted caller's own entry still wins; the subprocess service applies its
 * credential scrub independently, and the snapshot passes the same scrub.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config; matches OpenCode's 3s). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (the `maxSpillBytes` config). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`bash-local: ${name} must be a positive finite number`)
  }
}

/**
 * Reject a resolved section this executor could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound `graceMs` has to
 * fit, so a stored value is refused where it is written instead of failing at
 * the next command.
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableBashConfig(config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', resolved.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', resolved.maxSpillBytes)
  assertPositiveFinite('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`bash-local: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Local bash executor over `ctx.subprocess`. Bounded output, spill files,
 * managed-range SIGTERM→SIGKILL escalation, and quiescence are the subprocess
 * service's mechanics; this executor supplies their configured budgets per spawn, so a
 * still-running background process stays managed (killed and joined at
 * composition teardown) even across an executor reload.
 */
export class LocalBashExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedConfig

  /**
   * The login-shell environment snapshot (see `login-env.ts`), started once
   * when the executor is constructed — before any command, so before a model
   * command could touch a login profile. Settles `undefined` when the capture
   * failed, which keeps the scrubbed parent environment as every command's base.
   */
  private readonly loginEnv: Promise<Readonly<Record<string, string>> | undefined>

  /** The settled snapshot, read by every spawn once {@link awaitLoginEnvironment} returned. */
  private loginEnvSnapshot: Readonly<Record<string, string>> | undefined

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.source()
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills these fields before construction; the type does not encode that step.
    const entry = config as ResolvedConfig
    assertServiceableBashConfig(entry)
    this.source = () => entry
    // Started here, not awaited: the service is usable at once, and only a
    // command issued before the capture settled waits (see awaitLoginEnvironment).
    this.loginEnv = captureLoginEnvironment({
      subprocess: ctx.subprocess,
      cwd: entry.cwd ?? process.cwd(),
      env: ENV_OVERRIDES,
      ...process.env.PATH !== undefined ? { parentPath: process.env.PATH } : {},
      timeoutMs: this.loginEnvTimeoutMs(),
      graceMs: entry.graceMs,
    })
    void this.loginEnv.then((snapshot) => { this.loginEnvSnapshot = snapshot })
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SHELL_SETTINGS_NAMESPACE, LocalBashExecutor.Config, entry, {
        validate: assertServiceableBashConfig,
        setSource: (current) => {
          this.source = current as () => ResolvedConfig
        },
        // Every field is read through the getter at each command, so nothing
        // derived from the source needs rebuilding when the document changes.
        onChange: () => {},
      })
    })
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`. The tool layer calls
   * this before {@link run}/{@link start}, so those methods receive explicit
   * values and never re-default.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'bash-local: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      ...request.detachOnTimeout === true ? { detachOnTimeout: true } : {},
      ...request.durable !== undefined ? { durable: request.durable } : {},
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      // Carry stdin/ordinary env/trusted managedEnv through verbatim — optional,
      // no config default. The subprocess service owns the scrub and merge order.
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.managedEnv !== undefined ? { managedEnv: request.managedEnv } : {},
      // Carry a sandbox policy through verbatim: this executor never
      // confines, so the field is inert here (the seam contract) — a
      // sandboxing subclass overrides resolve() to stamp its default instead.
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * Bound on the one-time login-shell capture; a subclass (or a test) may
   * shorten it. Read once, during construction.
   * @returns the bound in milliseconds.
   */
  protected loginEnvTimeoutMs(): number {
    return LOGIN_ENV_TIMEOUT_MS
  }

  /**
   * Resolves once the one-time login-shell snapshot settled (captured or
   * fallen back); never rejects. Commands wait for it themselves, so callers
   * need this only to take startup timing out of their own measurements.
   * @returns a promise settled with the capture.
   */
  ready(): Promise<void> {
    return this.loginEnv.then(() => {})
  }

  /**
   * Wait until the login-shell snapshot settled, outside any command deadline:
   * only a command issued within the capture's first moments waits, at most
   * for the capture's own bound (the capture never rejects). An upstream abort
   * ends the wait early; the caller then settles the command as cancelled.
   * @param signal - the caller's cancellation.
   */
  protected async awaitLoginEnvironment(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return
    const aborted = Promise.withResolvers<void>()
    const abort = (): void => { aborted.resolve() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([this.ready(), aborted.promise])
    } finally { signal?.removeEventListener('abort', abort) }
  }

  /**
   * Map one resolved bash spec and explicit argv onto a fully-specified
   * subprocess spawn. Every command is a fresh process by design: no cwd or
   * variable persists between calls; `workdir` and the login-shell snapshot
   * carry what a command needs.
   */
  private spawnSpec(
    spec: ShellExecSpec,
    argv: readonly string[],
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv,
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      // One explicit env map for the seam, layered so the trusted managedEnv
      // snapshot beats the caller's env, the terminal overrides and the
      // (already scrubbed) login-shell snapshot; the subprocess service
      // merges the whole map after its ambient scrub.
      env: { ...this.currentLoginEnv(), ...ENV_OVERRIDES, ...spec.env, ...withLegacyAliases(spec.managedEnv) },
    }
  }

  /**
   * The login-shell snapshot as of this spawn: its entries pass the ambient
   * scrub again, so a secret withheld only after the capture (a rotated model
   * key) stays out of later commands just as it does from the parent base.
   */
  private currentLoginEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.loginEnvSnapshot ?? {})) {
      if (isInheritableEnvEntry(key, value)) env[key] = value
    }
    return env
  }

  /** The collect-mode readers the executor itself requested (present by construction). */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('bash-local: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return (await this.runArgv(spec, ['bash', '-c', spec.command])).result
  }

  /**
   * Run an explicit argv with the foreground lifecycle, environment, output,
   * timeout, and cancellation semantics of this executor. Subclasses use this
   * after replacing the public command's shell argv at an execution boundary.
   * @param spec - resolved execution settings and caller-owned command metadata.
   * @param argvOrPrepare - exact argv, or preparation cancelled by the same deadline as execution.
   * @returns the foreground result and whether argv reached the subprocess provider.
   */
  protected async runArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
  ): Promise<{ result: ShellRunResult; spawnRequested: boolean }> {
    // The snapshot wait precedes the deadline: it never spends the command's timeout.
    const abortedBefore = spec.signal?.aborted === true
    await this.awaitLoginEnvironment(spec.signal)
    if (!abortedBefore && spec.signal?.aborted === true) {
      // Cancelled while waiting: nothing ran, and nothing is spawned into an aborted signal.
      return {
        spawnRequested: false,
        result: {
          exitCode: null, signal: null, timedOut: false, aborted: true, timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
        },
      }
    }
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    let argv: readonly string[]
    if (typeof argvOrPrepare === 'function') {
      const cancelled = Promise.withResolvers<never>()
      const abort = (): void => { cancelled.reject(d.signal.reason) }
      d.signal.addEventListener('abort', abort, { once: true })
      try {
        argv = await Promise.race([
          Promise.resolve().then(() => { d.signal.throwIfAborted(); return argvOrPrepare(d.signal) }),
          cancelled.promise,
        ])
        d.signal.throwIfAborted()
      } catch (error) {
        if (timeoutOf(d.signal, 'BASH_TIMEOUT') === undefined) throw error
        return {
          spawnRequested: false,
          result: {
            exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: spec.timeoutMs,
            stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
          },
        }
      } finally { d.signal.removeEventListener('abort', abort) }
    } else { argv = argvOrPrepare }
    if (spec.detachOnTimeout === true) return { spawnRequested: true, result: await this.runDetachable(spec, argv, d.signal) }
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = LocalBashExecutor.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return {
      spawnRequested: true,
      result: {
        ...outcome,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected.stdout),
        stderr: finalOutput(collected.stderr),
      },
    }
  }

  /**
   * The foreground run of a `detachOnTimeout` spec. The process lives on its own
   * signal, which the caller's cancellation reaches only until the timeout: a
   * command still running then is returned as `detached` and keeps running,
   * with the output so far in the result and later reads continuing after it.
   * @param spec - the resolved spec; `timeoutMs` is the detach point.
   * @param argv - exact argv to hand to `ctx.subprocess`.
   * @param fused - the run's fused caller-and-timeout signal.
   * @returns the finished, aborted or detached result.
   */
  private async runDetachable(spec: ShellExecSpec, argv: readonly string[], fused: AbortSignal): Promise<ShellRunResult> {
    const life = new AbortController()
    const forward = (): void => { life.abort(spec.signal?.reason) }
    spec.signal?.addEventListener('abort', forward, { once: true })
    try {
      if (spec.signal?.aborted === true) forward()
      const handle = this.spawn(spec, this.spawnSpec(spec, argv, spec.stdoutMaxBytes, life.signal))
      const collected = LocalBashExecutor.collected(handle)
      let settled = false
      const finished = handle.done.then((outcome) => { settled = true; return outcome })
      // After a detach nothing here awaits it any more; the detached handle settles the failure.
      void finished.catch(() => undefined)
      const expired = new Promise<void>((resolve) => {
        if (fused.aborted) resolve()
        else fused.addEventListener('abort', () => { resolve() }, { once: true })
      })
      // A rejected `done` (provider failure) rejects the run, as on the killing path.
      await Promise.race([finished, expired])
      if (!settled && timeoutOf(fused, 'BASH_TIMEOUT') !== undefined) {
        spec.signal?.removeEventListener('abort', forward)
        const stdout = collected.stdout.readFrom(0)
        const stderr = collected.stderr.readFrom(0)
        return {
          exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: stdout.text, truncated: stdout.lossy, ...stdout.spillPath !== undefined ? { spillPath: stdout.spillPath } : {} },
          stderr: { text: stderr.text, truncated: stderr.lossy, ...stderr.spillPath !== undefined ? { spillPath: stderr.spillPath } : {} },
          detached: this.processHandle(handle, collected, life.signal, { stdout: stdout.nextOffset, stderr: stderr.nextOffset }),
        }
      }
      const outcome = await finished
      return {
        ...outcome,
        timedOut: false,
        aborted: spec.signal?.aborted === true,
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected.stdout),
        stderr: finalOutput(collected.stderr),
      }
    } finally {
      spec.signal?.removeEventListener('abort', forward)
    }
  }

  async start(spec: ShellExecSpec): Promise<ShellProcess> {
    await this.awaitLoginEnvironment(spec.signal)
    return this.startArgv(spec, ['bash', '-c', spec.command])
  }

  /**
   * Start an explicit argv with the background lifecycle, environment, output,
   * cancellation, and managed-range ownership semantics of this executor.
   * Subclasses use this after replacing the public command's shell argv at an
   * execution boundary, after awaiting {@link awaitLoginEnvironment} so the
   * spawn carries the login-shell snapshot.
   * @param spec - resolved execution settings and caller-owned command metadata.
   * @param argv - exact executable and arguments to hand to `ctx.subprocess`.
   * @returns the live background handle; provider rejection settles it as killed.
   */
  protected startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    // Background runs ignore timeoutMs; callers stop them through kill() or spec.signal.
    spec.signal?.throwIfAborted()
    const running = this.spawn(spec, this.spawnSpec(spec, argv, this.config.maxOutputBytes, spec.signal))
    return this.processHandle(running, LocalBashExecutor.collected(running), spec.signal, { stdout: 0, stderr: 0 })
  }

  /**
   * Spawn through the subprocess service, or as a durable process when the spec asks for one
   * and nothing needs stdin.
   * @param spec - the resolved spec.
   * @param spawn - the fully specified spawn.
   * @returns the handle.
   */
  private spawn(spec: ShellExecSpec, spawn: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.durable === undefined || spec.stdin !== undefined || process.platform === 'win32') return this.ctx.subprocess.spawn(spawn)
    return spawnDurable(spawn, spec.durable)
  }

  /**
   * The background handle over one spawned process: settlement classification,
   * consuming reads from the given offsets, and managed-range termination.
   * @param running - the spawned process.
   * @param collected - its collect-mode readers.
   * @param signal - the signal the process was spawned with; its abort settles the handle as killed.
   * @param offsets - where the first read starts (output already handed out ends there).
   * @returns the live handle.
   */
  private processHandle(
    running: SubprocessHandle,
    collected: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader },
    signal: AbortSignal | undefined,
    offsets: { stdout: number; stderr: number },
  ): ShellProcess {
    // A provider rejection has no direct outcome to display; its stage is not
    // public, so a neutral note is delivered once through the read path.
    let providerFailureNote: string | undefined
    const consumeProviderFailure = (): string => {
      const note = providerFailureNote ?? ''
      providerFailureNote = undefined
      return note
    }

    let stdoutOffset = offsets.stdout
    let stderrOffset = offsets.stderr
    const durable = (running as { durable?: DurableProcess }).durable
    const proc: ShellProcess = {
      ...durable === undefined ? {} : {
        durable,
        cursor: () => ({ stdout: stdoutOffset, stderr: stderrOffset }),
        release: () => { durable.release() },
      },
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        // Any signal termination is killed, including a command signaling itself.
        if (proc.status === 'running') {
          proc.status = signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
      }, (error: unknown) => {
        // Background provider failures settle as killed and surface through the read path.
        proc.status = 'killed'
        let detail = 'unprintable provider failure'
        try {
          detail = String(error)
        } catch {
          // Provider-owned rejection values cannot make ShellProcess.done reject.
        }
        providerFailureNote = `subprocess failed before reporting an outcome: ${detail}`
        proc.failure = providerFailureNote
        this.onProcessDone(proc, providerFailureNote, true, error)
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        const providerFailure = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text
          + (providerFailure.length > 0 ? `${failureSeparator}${providerFailure}` : '')
        // Single newline between sections: stdout chunks usually end with one
        // already; add it only when missing.
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }

  /**
   * Settlement hook for subclasses that attach execution facts to a process.
   * Called after exit facts or provider-failure output are stamped and before
   * {@link ShellProcess.done} resolves. The base implementation is intentionally
   * empty.
   * @param _proc - the settled process handle.
   * @param _stderr - the process's retained stderr tail used by subclasses for settlement classification.
   * @param _providerRejected - whether the subprocess promise rejected without a direct outcome.
   * @param _providerError - the provider rejection reason, which may itself be undefined.
   */
  protected onProcessDone(_proc: ShellProcess, _stderr: string, _providerRejected: boolean, _providerError?: unknown): void {}
}

export default LocalBashExecutor
