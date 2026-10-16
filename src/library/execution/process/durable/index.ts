/**
 * Durable background processes. The command runs under a detached Node supervisor
 * started in its own session and process group, with stdout and stderr
 * captured into bounded files and its exit status written to a file when it ends. It
 * belongs to no process range of the harness, so the harness can exit or
 * restart while it keeps running, and a later harness adopts it from its
 * directory: completion is read from the exit-status file, or, when the
 * process is gone without one, from its absence. Termination takes the whole
 * process group and every descendant that carries its marker.
 *
 * Directory layout: `launch.json` (identity and marker), `stdout`, `stderr`,
 * their `.state`/`.prev` companions once output was dropped, and `exit`.
 * @module io-agent/durable-process
 */

import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '../subprocess/index.ts'
import { targetEnvironment } from '../subprocess-local/runner-launch.ts'
import { DurableOutput } from './files.ts'
import { DEFAULT_IDENTITY_INTERNALS, DURABLE_MARKER_ENV, hasMembers, identify, isAlive, marked, signalMembers } from './identity.ts'
import type { IdentityInternals, ProcessIdentity } from './identity.ts'

export { DURABLE_MARKER_ENV, isAlive, identify, marked } from './identity.ts'
export type { IdentityInternals, ProcessIdentity } from './identity.ts'
export { DurableOutput } from './files.ts'

/** How often a running durable process is checked: exit status, liveness and file sizes. */
const DEFAULT_POLL_MS = 250

/** Longest wait for a process group to empty after SIGKILL before giving up on observing it. */
const KILL_SETTLE_MS = 5_000

/** Where and as whom a durable process runs. */
export interface DurableLaunch {
  /** Private directory for its files; created when missing. */
  readonly directory: string
  /** Marker its environment carries, so escaped descendants can still be found. */
  readonly marker: string
}

/** What a durable process left behind. */
export interface DurableExit {
  /** The command's exit status (128+n after signal n), or null when none was recorded. */
  exitCode: number | null
  /** The signal that ended the wrapper itself, when it had no chance to record a status. */
  signal: NodeJS.Signals | null
  /** True when the process was gone without a recorded status and no signal of ours ended it. */
  lost: boolean
}

/** The launch facts persisted in `launch.json`. */
export interface DurableLaunchFacts extends ProcessIdentity {
  marker: string
  /** Epoch ms of the spawn. */
  startedAt: number
  /** Output rotation belongs to the detached supervisor, not an adopting harness. */
  captured?: boolean
}

/** Tuning and test seams. */
export interface DurableOptions {
  /** Most bytes one read returns, per stream. */
  maxBytes: { stdout: number; stderr: number }
  /** Size past which a stream file's older bytes are dropped. */
  maxFileBytes: number
  /** Check interval while running (default 250 ms). */
  pollMs?: number
  /** Process-table operations. */
  internals?: IdentityInternals
}

/**
 * One durable process, spawned by this harness or adopted from its directory.
 */
export class DurableProcess {
  readonly stdout: DurableOutput
  readonly stderr: DurableOutput
  readonly done: Promise<DurableExit>
  private exit: DurableExit | undefined
  private settle!: (exit: DurableExit) => void
  private timer: ReturnType<typeof setInterval> | undefined
  private terminating: Promise<void> | undefined
  private signalled = false
  private readonly internals: IdentityInternals

  /**
   * @param directory - the process's directory.
   * @param facts - its recorded identity and marker.
   * @param options - read and file bounds, poll interval.
   * @param child - the wrapper, when this harness spawned it and can see it exit.
   */
  constructor(readonly directory: string, readonly facts: DurableLaunchFacts, options: DurableOptions, private readonly child?: ChildProcess) {
    this.internals = options.internals ?? DEFAULT_IDENTITY_INTERNALS
    const finished = (): boolean => this.exit !== undefined
    this.stdout = new DurableOutput(join(directory, 'stdout'), options.maxBytes.stdout, options.maxFileBytes, finished, facts.captured ?? false)
    this.stderr = new DurableOutput(join(directory, 'stderr'), options.maxBytes.stderr, options.maxFileBytes, finished, facts.captured ?? false)
    this.done = new Promise<DurableExit>((resolve) => { this.settle = resolve })
    child?.once('exit', (_code, signal) => {
      const code = readExitStatus(directory)
      this.finish({ exitCode: code ?? null, signal: code === undefined ? signal : null, lost: false })
    })
    // A missed exit event, or a process this harness did not spawn: the status file and the
    // process table say the same thing a little later.
    this.timer = setInterval(() => { this.check() }, options.pollMs ?? DEFAULT_POLL_MS)
    this.timer.unref()
    this.check()
  }

  /** Whether the command has not been seen to end. */
  get running(): boolean { return this.exit === undefined }

  /** The recorded end, once seen. */
  get outcome(): DurableExit | undefined { return this.exit }

  /**
   * One check: bound the output files, then look for the exit status, then for the process itself.
   */
  check(): void {
    for (const output of [this.stdout, this.stderr]) {
      try { output.enforceCap() } catch { /* the next check retries */ }
    }
    if (this.exit !== undefined) return
    const code = readExitStatus(this.directory)
    if (code !== undefined) {
      this.finish({ exitCode: code, signal: null, lost: false })
      return
    }
    if (this.child !== undefined) {
      // A child of this harness reports its own exit; the status file was read above.
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.finish({ exitCode: null, signal: this.child.signalCode, lost: false })
      }
      return
    }
    if (isAlive(this.facts, this.internals)) return
    // The status is written before the wrapper exits: read it once more now that it has.
    const late = readExitStatus(this.directory)
    this.finish(late !== undefined ? { exitCode: late, signal: null, lost: false }
      : { exitCode: null, signal: this.signalled ? 'SIGKILL' : null, lost: !this.signalled })
  }

  /**
   * Terminate every member: SIGTERM to the group and marked descendants, SIGKILL to whatever is
   * left after `graceMs`, then wait for the members to go. Idempotent.
   * @param graceMs - time between SIGTERM and SIGKILL.
   * @returns resolves once no member is left (or none can be observed any more).
   */
  terminate(graceMs: number): Promise<void> {
    this.terminating ??= (async () => {
      this.signalled = true
      signalMembers(this.facts, this.facts.marker, 'SIGTERM', this.internals)
      const graceEnd = Date.now() + graceMs
      while (this.hasMembers() && Date.now() < graceEnd) await sleep(25)
      if (this.hasMembers()) {
        signalMembers(this.facts, this.facts.marker, 'SIGKILL', this.internals)
        const killEnd = Date.now() + KILL_SETTLE_MS
        while (this.hasMembers() && Date.now() < killEnd) await sleep(25)
      }
      this.check()
    })()
    return this.terminating
  }

  /** Whether any process of this durable process is still alive. */
  hasMembers(): boolean {
    return hasMembers(this.facts, this.facts.marker, this.internals)
  }

  /**
   * Wait until no member is left.
   * @param signal - optional bound for the wait.
   * @returns true once empty, false when the signal aborted first.
   */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    while (this.hasMembers()) {
      if (signal?.aborted === true) return false
      await sleep(25)
    }
    return true
  }

  /** Stop watching without touching the process (the harness is shutting down). */
  release(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  private finish(exit: DurableExit): void {
    if (this.exit !== undefined || this.hasMembers()) return
    this.exit = exit
    for (const output of [this.stdout, this.stderr]) {
      try { output.enforceCap() } catch { /* bounded on the next start */ }
    }
    this.release()
    this.settle(exit)
  }
}

/**
 * Spawn a durable process for a fully specified subprocess spawn. Only `argv`, `cwd`, `env`,
 * the collect caps and `graceMs` apply; stdin is always empty.
 * @param spec - the spawn the caller would hand to the subprocess service.
 * @param launch - directory and marker.
 * @param options - poll interval and test seams; read caps come from the spec's collect modes.
 * @returns a subprocess handle over the durable process, plus the process itself.
 */
export function spawnDurable(spec: SubprocessSpawnSpec, launch: DurableLaunch,
  options: Partial<Pick<DurableOptions, 'pollMs' | 'internals'>> = {}): SubprocessHandle & { readonly durable: DurableProcess } {
  const collect = (mode: SubprocessSpawnSpec['stdio']['stdout'], fallback: number): { max: number; file: number } =>
    typeof mode === 'object' ? { max: mode.maxBytes, file: mode.spill?.maxBytes ?? Math.max(mode.maxBytes, fallback) } : { max: fallback, file: fallback }
  const out = collect(spec.stdio.stdout, 64 * 1024 * 1024)
  const err = collect(spec.stdio.stderr, 64 * 1024 * 1024)
  mkdirSync(launch.directory, { recursive: true, mode: 0o700 })
  const env = { ...targetEnvironment(spec), [DURABLE_MARKER_ENV]: launch.marker }
  const outFd = openSync(join(launch.directory, 'stdout'), 'a', 0o600)
  let errFd: number | undefined
  let child: ChildProcess
  try {
    errFd = openSync(join(launch.directory, 'stderr'), 'a', 0o600)
    const capture = fileURLToPath(import.meta.url.endsWith('.ts') ? new URL('./capture.ts', import.meta.url) : new URL('./capture.js', import.meta.url))
    child = spawn(process.execPath, [capture, launch.directory, String(Math.max(out.file, err.file)), ...spec.argv], {
      cwd: spec.cwd, env, detached: true, stdio: ['ignore', outFd, errFd],
    })
  } finally {
    closeSync(outFd)
    if (errFd !== undefined) closeSync(errFd)
  }
  const pid = child.pid
  if (pid === undefined) {
    const failed = new Promise<never>((_resolve, reject) => { child.once('error', reject) })
    void failed.catch(() => undefined)
    throw new Error(`durable process could not start in ${spec.cwd}`)
  }
  // The harness may exit while the process runs; the process must not keep it alive.
  child.unref()
  const internals = options.internals ?? DEFAULT_IDENTITY_INTERNALS
  const facts: DurableLaunchFacts = { ...identify(pid, internals), marker: launch.marker, startedAt: Date.now(), captured: true }
  writeLaunchFacts(launch.directory, facts)
  const durable = new DurableProcess(launch.directory, facts,
    { maxBytes: { stdout: out.max, stderr: err.max }, maxFileBytes: Math.max(out.file, err.file), internals,
      ...options.pollMs === undefined ? {} : { pollMs: options.pollMs } }, child)
  const terminate = (): void => { void durable.terminate(spec.graceMs) }
  if (spec.signal?.aborted === true) terminate()
  else spec.signal?.addEventListener('abort', terminate, { once: true })
  const done: Promise<SubprocessOutcome> = durable.done.then(exit => ({ exitCode: exit.exitCode, signal: exit.signal }))
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: durable.stdout, stderr: durable.stderr },
    done,
    terminate,
    waitForExit: signal => durable.waitForExit(signal),
    durable,
  }
}

/**
 * Adopt the durable process recorded in a directory.
 * @param directory - its directory.
 * @param options - read and file bounds, poll interval, test seams.
 * @returns the process, or undefined when the directory has no launch facts (it never started).
 */
export function adoptDurable(directory: string, options: DurableOptions): DurableProcess | undefined {
  const facts = readLaunchFacts(directory)
  return facts === undefined ? undefined : new DurableProcess(directory, facts, options)
}

/**
 * Terminate every process that carries a marker but has no recorded launch facts: SIGTERM, then
 * SIGKILL to whatever is left after `graceMs`.
 * @param marker - the marker value.
 * @param graceMs - time between SIGTERM and SIGKILL.
 * @param internals - injectable operations.
 * @returns resolves once none is left (or none can be observed any more).
 */
export async function terminateMarked(marker: string, graceMs: number, internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): Promise<void> {
  const signal = (name: 'SIGTERM' | 'SIGKILL'): void => {
    for (const pid of marked(marker, internals)) {
      try { internals.kill(pid, name) } catch { /* it exited meanwhile */ }
    }
  }
  if (marked(marker, internals).length === 0) return
  signal('SIGTERM')
  const graceEnd = Date.now() + graceMs
  while (marked(marker, internals).length > 0 && Date.now() < graceEnd) await sleep(25)
  if (marked(marker, internals).length === 0) return
  signal('SIGKILL')
  const killEnd = Date.now() + KILL_SETTLE_MS
  while (marked(marker, internals).length > 0 && Date.now() < killEnd) await sleep(25)
}

/**
 * Read the launch facts of a durable process directory.
 * @param directory - its directory.
 * @returns the facts, or undefined when missing or unreadable.
 */
export function readLaunchFacts(directory: string): DurableLaunchFacts | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'launch.json'), 'utf8')) as Partial<DurableLaunchFacts>
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.marker !== 'string'
      || !Number.isSafeInteger(value.startedAt)) return undefined
    return {
      pid: value.pid as number, marker: value.marker, startedAt: value.startedAt as number,
      ...value.captured === true ? { captured: true } : {},
      ...typeof value.started === 'string' ? { started: value.started } : {},
      ...typeof value.bootId === 'string' ? { bootId: value.bootId } : {},
    }
  } catch {
    return undefined
  }
}

function writeLaunchFacts(directory: string, facts: DurableLaunchFacts): void {
  const path = join(directory, 'launch.json')
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, ...facts }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(`${path}.tmp`, path)
}

/**
 * The exit status a wrapper recorded, if any.
 * @param directory - the process's directory.
 * @returns 0-255, or undefined when not (yet) recorded.
 */
export function readExitStatus(directory: string): number | undefined {
  const path = join(directory, 'exit')
  if (!existsSync(path)) return undefined
  try {
    const code = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined
  } catch {
    return undefined
  }
}
