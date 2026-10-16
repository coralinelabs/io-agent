import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  ENV_PREFIX, LEGACY_ENV_PREFIX, isManagedEnvName, legacyEnvName, readEnv, takeEnv, warnOnce, withLegacyAliases,
} from "../../../src/library/util/env-names/index.ts"
import { isInheritableEnvEntry, MANAGED_ENV_PREFIX } from "../../../src/library/execution/process/subprocess/index.ts"
import { DURABLE_MARKER_ENV, marked, members, type IdentityInternals } from "../../../src/library/execution/process/durable/identity.ts"
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { LocalBashExecutor } from "../../../src/library/execution/shell/bash-local/index.ts"
import LocalSubprocessRuntime from "../../../src/library/execution/process/subprocess-local/index.ts"

/** Records what each read reported, instead of the process-wide once-per-name warning. */
function recorder() {
  const heard: string[] = []
  return { heard, warn: (legacy: string, name: string) => { heard.push(`${legacy} -> ${name}`) } }
}

describe('the harness environment names: IO_AGENT_*, the PLUTO_* names read for one release', () => {
  it('names the namespace once, for the scrub, the shell facts and the old names alike', () => {
    expect(ENV_PREFIX).toBe('IO_AGENT_')
    expect(MANAGED_ENV_PREFIX).toBe(ENV_PREFIX)
    expect(LEGACY_ENV_PREFIX).toBe('PLUTO_')
    expect(legacyEnvName('IO_AGENT_USER_DIR')).toBe('PLUTO_USER_DIR')
    expect(() => legacyEnvName('HOME' as never)).toThrow(/not an IO_AGENT_\* name/)
  })

  it('reads the new name when it is present, and never the old one beside it', () => {
    const { heard, warn } = recorder()
    expect(readEnv({ IO_AGENT_USER_DIR: '/new', PLUTO_USER_DIR: '/old' }, 'IO_AGENT_USER_DIR', { warn })).toBe('/new')
    expect(heard).toEqual([])
  })

  it('reads the old name only in the new one\'s absence, and says so by name, never with the value', () => {
    const { heard, warn } = recorder()
    expect(readEnv({ PLUTO_USER_DIR: '/secret/old' }, 'IO_AGENT_USER_DIR', { warn })).toBe('/secret/old')
    expect(heard).toEqual(['PLUTO_USER_DIR -> IO_AGENT_USER_DIR'])
    expect(readEnv({}, 'IO_AGENT_USER_DIR', { warn })).toBeUndefined()
    // an undefined entry is absent, as process.env reports an unset name
    expect(readEnv({ IO_AGENT_USER_DIR: undefined, PLUTO_USER_DIR: '/old' }, 'IO_AGENT_USER_DIR', { warn })).toBe('/old')
  })

  it('never brings an old value back over an empty new one', () => {
    const { heard, warn } = recorder()
    expect(readEnv({ IO_AGENT_TOKEN: '', PLUTO_TOKEN: 'old-credential' }, 'IO_AGENT_TOKEN', { warn })).toBe('')
    expect(heard).toEqual([])
  })

  it('reads a family from one generation: one member renamed, the others are not read under old names', () => {
    const { heard, warn } = recorder()
    const family = ['IO_AGENT_KEY', 'IO_AGENT_KEY_FILE'] as const
    const half = { IO_AGENT_KEY_FILE: '/run/new-key', PLUTO_KEY: 'old-direct-key' }
    expect(readEnv(half, 'IO_AGENT_KEY', { family, warn })).toBeUndefined()
    expect(readEnv(half, 'IO_AGENT_KEY_FILE', { family, warn })).toBe('/run/new-key')
    expect(readEnv({ IO_AGENT_KEY_FILE: '', PLUTO_KEY: 'old' }, 'IO_AGENT_KEY', { family, warn })).toBeUndefined()
    expect(readEnv({ PLUTO_KEY: 'old' }, 'IO_AGENT_KEY', { family, warn })).toBe('old')
    expect(heard).toEqual(['PLUTO_KEY -> IO_AGENT_KEY'])
  })

  it('reports each old name once per process, by name only', () => {
    const emitted = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      for (let i = 0; i < 3; i++) {
        expect(readEnv({ PLUTO_ONCE_A: 'value-a' }, 'IO_AGENT_ONCE_A')).toBe('value-a')
        expect(readEnv({ PLUTO_ONCE_B: 'value-b' }, 'IO_AGENT_ONCE_B')).toBe('value-b')
      }
      warnOnce('PLUTO_ONCE_A', 'IO_AGENT_ONCE_A')
      expect(emitted.mock.calls.map(call => call[0])).toEqual([
        'PLUTO_ONCE_A is deprecated; use IO_AGENT_ONCE_A', 'PLUTO_ONCE_B is deprecated; use IO_AGENT_ONCE_B'])
      expect(emitted.mock.calls.every(call => (call[1] as { type: string }).type === 'DeprecationWarning')).toBe(true)
      expect(JSON.stringify(emitted.mock.calls)).not.toContain('value-')
    } finally {
      emitted.mockRestore()
    }
  })

  it('takes a launch marker under either name and leaves neither behind', () => {
    const { heard } = recorder()
    const current = { IO_AGENT_SUBPROCESS_RUNNER: 'linux', PLUTO_SUBPROCESS_RUNNER: 'stale', KEEP: '1' }
    expect(takeEnv(current, 'IO_AGENT_SUBPROCESS_RUNNER')).toBe('linux')
    expect(current).toEqual({ KEEP: '1' })
    const before = { PLUTO_SUBPROCESS_CONTROL: 'pipe' }
    const emitted = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      expect(takeEnv(before, 'IO_AGENT_SUBPROCESS_CONTROL')).toBe('pipe')
    } finally {
      emitted.mockRestore()
    }
    expect(before).toEqual({})
    expect(heard).toEqual([])
  })

  it('gives children the managed facts under both names, the model told only of the new', () => {
    expect(withLegacyAliases({ IO_AGENT_SHELL: '1', IO_AGENT_USER_DIR: '/u' })).toEqual({
      IO_AGENT_SHELL: '1', IO_AGENT_USER_DIR: '/u', PLUTO_SHELL: '1', PLUTO_USER_DIR: '/u' })
    expect(withLegacyAliases(undefined)).toEqual({})
  })

  it('keeps both namespaces out of a child\'s inherited environment, in any case', () => {
    for (const key of ['IO_AGENT_SESSION_ID', 'PLUTO_SESSION_ID', 'io_agent_shell', 'pluto_shell']) {
      expect(isManagedEnvName(key)).toBe(true)
      expect(isInheritableEnvEntry(key, 'stale')).toBe(false)
    }
    expect(isInheritableEnvEntry('IO_HOME', '/home/x/.io_workspace')).toBe(true)
    expect(isManagedEnvName('PLUTONIUM')).toBe(false)
  })
})

describe('a background job started before the rename', () => {
  const internals = (environ: string): IdentityInternals => ({
    platform: 'linux',
    kill: () => {},
    readDir: () => ['4242'],
    readFile: (path: string) => path.endsWith('/stat')
      ? '4242 (sleep) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 900 0 0'
      : environ,
  } as unknown as IdentityInternals)

  it('is found by the marker its environment carries under the old name', () => {
    expect(DURABLE_MARKER_ENV).toBe('IO_AGENT_BACKGROUND_JOB')
    expect(marked('m-1', internals(`PATH=/bin\0PLUTO_BACKGROUND_JOB=m-1\0`))).toEqual([4242])
    expect(marked('m-1', internals(`PATH=/bin\0IO_AGENT_BACKGROUND_JOB=m-1\0`))).toEqual([4242])
    expect(marked('m-1', internals(`PATH=/bin\0PLUTO_BACKGROUND_JOB=m-2\0`))).toEqual([])
    expect(members({ pid: 1 }, 'm-1', internals(`PLUTO_BACKGROUND_JOB=m-1\0`))).toEqual([4242])
  })
})

describe('a model shell', () => {
  const spillDir = mkdtempSync(join(tmpdir(), 'io-agent-env-names-spec-'))
  afterAll(() => { rmSync(spillDir, { recursive: true, force: true }) })

  it('sees each managed fact under its new name and its old one, and no stale ambient one', async () => {
    // ambient before the executor starts, so its login-shell snapshot would carry them too were they not scrubbed
    vi.stubEnv('PLUTO_AMBIENT', 'stale')
    vi.stubEnv('IO_AGENT_AMBIENT', 'stale')
    try {
      const ctx = new Context()
      await ctx.plugin(LocalSubprocessRuntime)
      ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
      await ctx.plugin(LocalBashExecutor, { graceMs: 200 })
      const bash = ctx.shell as LocalBashExecutor
      await bash.ready()
      const result = await bash.run(bash.resolve({
        command: 'printf "%s|%s|%s|%s" "$IO_AGENT_SHELL" "$PLUTO_SHELL" "${PLUTO_AMBIENT-unset}" "${IO_AGENT_AMBIENT-unset}"',
        managedEnv: { IO_AGENT_SHELL: '1' },
      }))
      expect(result.stdout.text).toBe('1|1|unset|unset')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
