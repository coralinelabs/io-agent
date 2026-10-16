/**
 * Login-shell environment snapshot for the bash executor. A command runs as a
 * fresh non-login `bash -c`, so setup that exists only in `/etc/profile`,
 * `~/.bash_profile`, `~/.bash_login` or `~/.profile` would never reach it. The
 * executor captures that environment once (`bash -lc 'env -0'` behind a nonce
 * marker, bounded by a short timeout) and uses it as the base environment of
 * every later command. Every captured entry passes the subprocess credential
 * scrub, so a login profile cannot re-introduce a scrubbed variable; shell-local
 * names are dropped so each call's `PWD` follows its own working directory.
 * `/etc/profile` on Debian-family systems resets `PATH` outright, which would
 * lose the entries an image or service set (a venv, a toolchain); those come
 * back (see {@link restoreDroppedPath}). Any failure yields `undefined`, and the
 * executor keeps the scrubbed parent environment as before.
 * @module io-agent/bash-local/login-env
 */

import { randomUUID } from 'node:crypto'
import { isInheritableEnvEntry } from "../../process/subprocess/index.ts"
import type { SubprocessRuntime } from "../../process/subprocess/index.ts"

/** Default bound on the one-time capture; a slower login profile falls back. */
export const LOGIN_ENV_TIMEOUT_MS = 5_000

/** Largest captured environment accepted; a truncated capture falls back. */
const LOGIN_ENV_MAX_BYTES = 4 * 1024 * 1024

/**
 * Names the login shell sets for itself rather than exports as setup; each
 * call's own bash derives them from its process, working directory and depth.
 */
const SHELL_LOCAL_NAMES: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

/** The login-shell script: a nonce marker separates profile chatter on stdout from `env -0`. */
export function loginEnvScript(marker: string): string {
  return `printf '%s\\0' '${marker}'; exec env -0`
}

/**
 * Parse one capture's stdout into the scrubbed snapshot.
 * @param stdout - everything the login shell wrote, profile output included.
 * @param marker - the nonce written immediately before `env -0`.
 * @returns the scrubbed entries, or `undefined` when the marker is absent.
 */
export function parseLoginEnvironment(stdout: string, marker: string): Record<string, string> | undefined {
  const tag = `${marker}\0`
  const start = stdout.lastIndexOf(tag)
  if (start < 0) return undefined
  const env: Record<string, string> = {}
  for (const entry of stdout.slice(start + tag.length).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq)
    const value = entry.slice(eq + 1)
    if (SHELL_LOCAL_NAMES.has(key) || !isInheritableEnvEntry(key, value)) continue
    env[key] = value
  }
  return env
}

/**
 * Put back the parent `PATH` entries a login profile dropped. Each one returns
 * just before the next parent entry the login `PATH` kept, or at the end, so
 * the parent's relative order survives while the profile's own additions and
 * reorderings stay as written.
 * @param loginPath - `PATH` as the login shell exported it.
 * @param parentPath - `PATH` the executor's process inherited.
 * @returns the login `PATH` with the dropped parent entries restored.
 */
export function restoreDroppedPath(loginPath: string, parentPath: string | undefined): string {
  const merged = loginPath.split(':')
  const kept = new Set(merged)
  const seen = new Set<string>()
  const pending: string[] = []
  for (const entry of (parentPath ?? '').split(':')) {
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    if (!kept.has(entry)) { pending.push(entry); continue }
    if (pending.length === 0) continue
    merged.splice(merged.indexOf(entry), 0, ...pending)
    pending.length = 0
  }
  return [...merged, ...pending].filter(entry => entry !== '').join(':')
}

/** Inputs of one capture. */
export interface LoginEnvCapture {
  /** The subprocess service that owns (and at teardown reaps) the capture process. */
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  /** Working directory of the capture. */
  cwd: string
  /** Entries layered for the capture only (the executor's terminal overrides). */
  env: Readonly<Record<string, string>>
  /** The inherited `PATH`, whose entries a profile that resets `PATH` must not lose. */
  parentPath?: string
  /** Bound on the login shell's run. */
  timeoutMs: number
  /** Grace period for terminating a capture that overran its bound. */
  graceMs: number
}

/**
 * Capture the login-shell environment once. Never rejects and never outlives
 * its bound: a failed spawn, nonzero exit, timeout, missing marker
 * or truncated output all resolve `undefined`.
 * @param capture - the service, directory, environment and bound.
 * @returns the scrubbed snapshot, or `undefined` to keep today's environment.
 */
export async function captureLoginEnvironment(capture: LoginEnvCapture): Promise<Record<string, string> | undefined> {
  const marker = `__IO_AGENT_LOGIN_ENV_${randomUUID()}__`
  const controller = new AbortController()
  const expired = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => {
    controller.abort(new Error('login environment snapshot timed out'))
    expired.resolve(undefined)
  }, capture.timeoutMs)
  timer.unref()
  const run = async (): Promise<Record<string, string> | undefined> => {
    const handle = capture.subprocess.spawn({
      argv: ['bash', '-lc', loginEnvScript(marker)],
      cwd: capture.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: LOGIN_ENV_MAX_BYTES }, stderr: { maxBytes: 4_096 } },
      graceMs: capture.graceMs,
      signal: controller.signal,
      env: { ...capture.env },
    })
    const outcome = await handle.done
    if (controller.signal.aborted || outcome.exitCode !== 0) return undefined
    const stdout = handle.collected.stdout?.readFrom(0)
    if (stdout === undefined || stdout.lossy) return undefined
    const snapshot = parseLoginEnvironment(stdout.text, marker)
    if (snapshot?.PATH !== undefined) snapshot.PATH = restoreDroppedPath(snapshot.PATH, capture.parentPath)
    return snapshot
  }
  try {
    // A capture that loses the race to the bound must not reject unobserved later.
    return await Promise.race([run().catch(() => undefined), expired.promise])
  } finally {
    clearTimeout(timer)
  }
}
