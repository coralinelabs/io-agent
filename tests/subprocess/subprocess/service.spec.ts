import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { scrubbedParentEnv, SubprocessRuntime, withholdFromChildren } from "../../../src/library/execution/process/subprocess/index.ts"
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "../../../src/library/execution/process/subprocess/index.ts"

/**
 * Minimal concrete service: a hand-built handle. The seam is spawn-only —
 * defaulting, shell semantics, and deadlines belong to callers — so this stub
 * is all an implementation owes the abstract class.
 */
class StubSubprocessRuntime extends SubprocessRuntime {
  async terminalEnvironment() { return { platform: 'posix' as const } }
  async resolveExecutable(command: string): Promise<string> {
    return `/bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const read: SubprocessOutputRead = { text: '', nextOffset: 0, lossy: false }
    const collected = spec.stdio.stdout !== 'pipe' && spec.stdio.stdout !== 'inherit'
      ? { stdout: { readFrom: () => read } }
      : {}
    return {
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

describe('SubprocessRuntime seam', () => {
  it('a concrete subclass registers as ctx.subprocess and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    const handle = ctx.subprocess.spawn({
      argv: ['true'],
      cwd: '/stub',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: 'inherit' },
      graceMs: 1,
    })
    expect(Object.hasOwn(handle, 'pid')).toBe(false)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })

  it('loading a second implementation throws (one subprocess service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    class SecondService extends StubSubprocessRuntime {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "subprocess" has been registered/)
  })

  it('scrubbedParentEnv drops credential-shaped and DSH_ names (case-insensitively) but keeps PATH', () => {
    process.env.IO_AGENT_SCRUB_PROBE = 'stale'
    process.env.pluto_scrub_probe_lower = 'stale'
    process.env.SCRUB_PROBE_TOKEN = 'secret'
    process.env.SCRUB_PROBE_PASSWORD = 'secret'
    process.env.SCRUB_PROBE_PLAIN = 'visible'
    try {
      const env = scrubbedParentEnv()
      expect(env.IO_AGENT_SCRUB_PROBE).toBeUndefined()
      expect(env.pluto_scrub_probe_lower).toBeUndefined()
      expect(env.SCRUB_PROBE_TOKEN).toBeUndefined()
      expect(env.SCRUB_PROBE_PASSWORD).toBeUndefined()
      expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.IO_AGENT_SCRUB_PROBE
      delete process.env.pluto_scrub_probe_lower
      delete process.env.SCRUB_PROBE_TOKEN
      delete process.env.SCRUB_PROBE_PASSWORD
      delete process.env.SCRUB_PROBE_PLAIN
    }
  })

  it('scrubbedParentEnv drops every entry carrying a withheld secret, whatever its name, while the source is registered', () => {
    let secret: string | undefined = 'sk-withheld-0123456789'
    process.env.WITHHELD_PROBE_EXACT = secret
    process.env.WITHHELD_PROBE_URL = `https://user:${secret}@example.org`
    process.env.WITHHELD_PROBE_SHORT = 'abc'
    process.env.WITHHELD_PROBE_CONTAINS_SHORT = 'xxabcxx'
    process.env.WITHHELD_PROBE_PLAIN = 'visible'
    const release = withholdFromChildren(() => secret)
    const short = withholdFromChildren(() => 'abc')
    try {
      const env = scrubbedParentEnv()
      expect(env.WITHHELD_PROBE_EXACT).toBeUndefined()
      expect(env.WITHHELD_PROBE_URL).toBeUndefined()
      expect(env.WITHHELD_PROBE_SHORT).toBeUndefined()
      expect(env.WITHHELD_PROBE_PLAIN).toBe('visible')
      // A short secret removes only an equal value, never every value containing it.
      expect(env.WITHHELD_PROBE_CONTAINS_SHORT).toBe('xxabcxx')
      // The source is read at each spawn: a rotated secret is withheld, the old value only while the source still names it.
      secret = 'sk-rotated-9876543210'
      process.env.WITHHELD_PROBE_ROTATED = secret
      expect(scrubbedParentEnv().WITHHELD_PROBE_ROTATED).toBeUndefined()
      expect(scrubbedParentEnv().WITHHELD_PROBE_EXACT).toBe('sk-withheld-0123456789')
      const both = withholdFromChildren(() => ['sk-rotated-9876543210', 'sk-withheld-0123456789'])
      expect(scrubbedParentEnv().WITHHELD_PROBE_EXACT).toBeUndefined()
      both()
      secret = undefined
      expect(scrubbedParentEnv().WITHHELD_PROBE_ROTATED).toBe('sk-rotated-9876543210')
      secret = 'sk-rotated-9876543210'
      release()
      expect(scrubbedParentEnv().WITHHELD_PROBE_ROTATED).toBe('sk-rotated-9876543210')
    } finally {
      release()
      short()
      for (const name of ['EXACT', 'URL', 'SHORT', 'CONTAINS_SHORT', 'PLAIN', 'ROTATED']) delete process.env[`WITHHELD_PROBE_${name}`]
    }
  })
})
