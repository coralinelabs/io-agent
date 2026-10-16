/**
 * Process identity and process-group signalling for durable background
 * processes. A pid alone names a process only until it is reused, so a
 * durable process is identified by its pid, its kernel start time and the
 * boot it started in; a pid whose start time or boot differs belongs to
 * someone else. Descendants that left the process group are found through
 * the marker their environment inherited.
 * @module io-agent/durable-process/identity
 */

import { readdirSync, readFileSync } from 'node:fs'
import { parseProcStat } from '../subprocess-local/process-inspector.ts'
import { legacyEnvName } from '../../../util/env-names/index.ts'

/** Environment variable every durable process and its descendants carry, valued with the process's marker. */
export const DURABLE_MARKER_ENV = 'IO_AGENT_BACKGROUND_JOB'

/**
 * The environment entries that carry a marker: under the variable's name, and under its name before
 * io-agent, which a process started by an earlier harness still carries until it ends.
 * @param marker - the marker value.
 * @returns `NAME=marker` for both names.
 */
export function markerEntries(marker: string): string[] {
  return [`${DURABLE_MARKER_ENV}=${marker}`, `${legacyEnvName(DURABLE_MARKER_ENV)}=${marker}`]
}

function carries(environ: string, entries: readonly string[]): boolean {
  return environ.split('\0').some(entry => entries.includes(entry))
}

/** Who a durable process is, as recorded when it started. */
export interface ProcessIdentity {
  /** The wrapper's pid, which is also its process-group and session id. */
  pid: number
  /** Kernel start time (`/proc/<pid>/stat` field 22) on Linux; absent elsewhere. */
  started?: string
  /** Kernel boot id on Linux; absent elsewhere. */
  bootId?: string
}

/** Filesystem and signal operations, injectable for tests. */
export interface IdentityInternals {
  readFile(path: string): string
  readDir(path: string): string[]
  kill(pid: number, signal: NodeJS.Signals | 0): void
  platform: NodeJS.Platform
}

/* v8 ignore start -- thin OS bindings; the logic above them is tested with injected tables. */
export const DEFAULT_IDENTITY_INTERNALS: IdentityInternals = {
  readFile: path => readFileSync(path, 'utf8'),
  readDir: path => readdirSync(path),
  kill: (pid, signal) => { process.kill(pid, signal) },
  platform: process.platform,
}
/* v8 ignore stop */

/**
 * The current boot id, or undefined where the platform has none.
 * @param internals - injectable operations.
 * @returns the kernel boot id.
 */
export function bootId(internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): string | undefined {
  if (internals.platform !== 'linux') return undefined
  try {
    return internals.readFile('/proc/sys/kernel/random/boot_id').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Record the identity of a process that exists now (a child this process has not reaped yet).
 * @param pid - the process id.
 * @param internals - injectable operations.
 * @returns its identity; the start time is absent when it could not be read.
 */
export function identify(pid: number, internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): ProcessIdentity {
  if (internals.platform !== 'linux') return { pid }
  let started: string | undefined
  try {
    started = parseProcStat(internals.readFile(`/proc/${pid}/stat`))?.started
  } catch {
    started = undefined
  }
  const boot = bootId(internals)
  return { pid, ...started === undefined ? {} : { started }, ...boot === undefined ? {} : { bootId: boot } }
}

/**
 * Whether the recorded process is still running: the same pid, start time and boot, not a zombie.
 * @param identity - the recorded identity.
 * @param internals - injectable operations.
 * @returns true only for the very process that was recorded.
 */
export function isAlive(identity: ProcessIdentity, internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): boolean {
  if (internals.platform === 'linux') {
    if (identity.bootId !== undefined && identity.bootId !== bootId(internals)) return false
    let stat: ReturnType<typeof parseProcStat>
    try {
      stat = parseProcStat(internals.readFile(`/proc/${identity.pid}/stat`))
    } catch {
      return false
    }
    if (stat === undefined) return false
    if (identity.started !== undefined && stat.started !== identity.started) return false
    return !/^[ZXx]$/.test(stat.state)
  }
  try {
    internals.kill(identity.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Every live process that belongs to a durable process: its process group, its session, and any
 * descendant that left both but still carries the marker in its environment. Linux only; elsewhere
 * the group is signalled without enumeration.
 * @param identity - the durable process.
 * @param marker - the marker value its environment carries.
 * @param internals - injectable operations.
 * @returns live member pids, or undefined when the process table cannot be read.
 */
export function members(identity: ProcessIdentity, marker: string | undefined,
  internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): number[] | undefined {
  if (internals.platform !== 'linux') return undefined
  const group = groupIsOurs(identity, internals)
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch {
    return undefined
  }
  const needle = marker === undefined ? undefined : markerEntries(marker)
  const found: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    let stat: ReturnType<typeof parseProcStat>
    try {
      stat = parseProcStat(internals.readFile(`/proc/${pid}/stat`))
    } catch {
      continue
    }
    if (stat === undefined || /^[ZXx]$/.test(stat.state)) continue
    let member = group && (stat.pgrp === identity.pid || stat.session === identity.pid)
    if (!member && needle !== undefined) {
      try {
        member = carries(internals.readFile(`/proc/${pid}/environ`), needle)
      } catch {
        member = false
      }
    }
    if (member) found.push(pid)
  }
  return found
}

/**
 * Every live process whose environment carries a durable process's marker. It finds a durable
 * process whose launch facts were never recorded (the harness stopped between spawn and record).
 * Linux only; elsewhere nothing can be enumerated.
 * @param marker - the marker value.
 * @param internals - injectable operations.
 * @returns live pids carrying the marker.
 */
export function marked(marker: string, internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): number[] {
  if (internals.platform !== 'linux') return []
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch {
    return []
  }
  const needle = markerEntries(marker)
  const found: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      const stat = parseProcStat(internals.readFile(`/proc/${pid}/stat`))
      if (stat === undefined || /^[ZXx]$/.test(stat.state)) continue
      if (carries(internals.readFile(`/proc/${pid}/environ`), needle)) found.push(pid)
    } catch {
      continue
    }
  }
  return found
}

/**
 * Signal every member of a durable process: the whole process group, then each enumerated member
 * the group signal could not reach. Never throws; delivery races exit.
 * @param identity - the durable process.
 * @param marker - its environment marker.
 * @param signal - the signal to deliver.
 * @param internals - injectable operations.
 */
export function signalMembers(identity: ProcessIdentity, marker: string | undefined, signal: 'SIGTERM' | 'SIGKILL',
  internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): void {
  if (groupIsOurs(identity, internals)) {
    try { internals.kill(-identity.pid, signal) } catch { /* the group is gone */ }
  }
  for (const pid of members(identity, marker, internals) ?? []) {
    try { internals.kill(pid, signal) } catch { /* it exited meanwhile */ }
  }
}

/**
 * Whether any live process still belongs to the durable process.
 * @param identity - the durable process.
 * @param marker - its environment marker.
 * @param internals - injectable operations.
 * @returns true while a member remains.
 */
export function hasMembers(identity: ProcessIdentity, marker: string | undefined,
  internals: IdentityInternals = DEFAULT_IDENTITY_INTERNALS): boolean {
  const listed = members(identity, marker, internals)
  if (listed !== undefined) return listed.length > 0
  return groupIsOurs(identity, internals) && hasGroup(identity.pid, internals)
}

/**
 * Whether the process group named by the recorded pid is still the durable process's own. The
 * kernel never reuses a pid while a group or session still carries it, so a group with that id is
 * ours unless a different process (another start time, or another boot) now holds the pid itself.
 */
function groupIsOurs(identity: ProcessIdentity, internals: IdentityInternals): boolean {
  if (identity.bootId !== undefined && identity.bootId !== bootId(internals)) return false
  if (internals.platform !== 'linux' || identity.started === undefined) return true
  let stat: ReturnType<typeof parseProcStat>
  try {
    stat = parseProcStat(internals.readFile(`/proc/${identity.pid}/stat`))
  } catch {
    return true
  }
  return stat === undefined || stat.started === identity.started
}

function hasGroup(pgid: number, internals: IdentityInternals): boolean {
  try {
    internals.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
