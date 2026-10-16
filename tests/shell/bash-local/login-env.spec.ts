/**
 * The bash executor's login-shell environment snapshot. A temporary
 * HOME carries the login profile (`~/.bash_profile`), so the tests exercise
 * the real `bash -lc` capture, the credential scrub on captured entries, the
 * layering beneath the terminal overrides and caller env, and the fallback to
 * today's scrubbed parent environment when the capture fails or overruns.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { LocalBashExecutor } from "../../../src/library/execution/shell/bash-local/index.ts"
import { captureLoginEnvironment, loginEnvScript, parseLoginEnvironment, restoreDroppedPath } from "../../../src/library/execution/shell/bash-local/login-env.ts"
import { withholdFromChildren } from "../../../src/library/execution/process/subprocess/index.ts"
import LocalSubprocessRuntime from "../../../src/library/execution/process/subprocess-local/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import { SandboxProvider } from "../../../src/library/execution/sandbox/sandbox/index.ts"
import type { ConfinedArgv } from "../../../src/library/execution/sandbox/sandbox/index.ts"
import { SandboxPolicyService } from "../../../src/library/execution/sandbox/sandbox-policy/index.ts"
import { SandboxBashExecutor } from "../../../src/library/execution/shell/bash-sandbox/index.ts"

const PROFILE = [
  'echo "profile chatter on stdout"',
  'export LOGIN_PROBE=from-login-profile',
  'export LOGIN_SHARED=from-login-profile',
  'export GITHUB_TOKEN=profile-token',
  'export MY_SERVICE_API_KEY=profile-key',
  'export IO_AGENT_FORGED=profile-managed',
  'export TERM=xterm-256color',
  'export PAGER=less',
  'cd /',
].join('\n')

let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'io-agent-login-env-'))
  originalHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

async function setup(Executor: typeof LocalBashExecutor = LocalBashExecutor) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Executor, { graceMs: 200, timeoutMs: 10_000 })
  return { ctx, bash: ctx.shell as LocalBashExecutor }
}

async function run(bash: LocalBashExecutor, command: string, extra: Partial<Parameters<LocalBashExecutor['resolve']>[0]> = {}) {
  const result = await bash.run(bash.resolve({ command, ...extra }))
  expect(result.exitCode).toBe(0)
  return result.stdout.text
}

describe('parseLoginEnvironment', () => {
  it('reads only what follows the marker and applies the credential and shell-local scrub', () => {
    const marker = '__M__'
    const stdout = 'banner\n' + [
      `${marker}`,
      'PATH=/login/bin:/usr/bin',
      'MULTI=line one\nline two',
      'WITH_EQ=a=b',
      'AWS_SECRET_ACCESS_KEY=s',
      'npm_config_token=t',
      'pluto_home=/x',
      'PWD=/somewhere',
      'OLDPWD=/before',
      'SHLVL=2',
      '_=/usr/bin/env',
      'no-equals-entry',
      '',
    ].join('\0')
    expect(parseLoginEnvironment(stdout, marker)).toEqual({
      PATH: '/login/bin:/usr/bin',
      MULTI: 'line one\nline two',
      WITH_EQ: 'a=b',
    })
  })

  it('returns undefined without the marker', () => {
    expect(parseLoginEnvironment('PATH=/usr/bin\0', '__M__')).toBeUndefined()
  })

  it('quotes the marker into a script that runs env -0 last', () => {
    expect(loginEnvScript('__M__')).toBe("printf '%s\\0' '__M__'; exec env -0")
  })
})

describe('restoreDroppedPath', () => {
  it('leaves a login PATH that kept every parent entry as the profile wrote it', () => {
    expect(restoreDroppedPath('/home/u/.local/bin:/opt/venv/bin:/usr/bin:/bin', '/opt/venv/bin:/usr/bin:/bin'))
      .toBe('/home/u/.local/bin:/opt/venv/bin:/usr/bin:/bin')
  })

  it('puts each dropped parent entry back before the next parent entry the profile kept', () => {
    // Debian's /etc/profile for an ordinary user, over an image PATH with a venv in front.
    expect(restoreDroppedPath(
      '/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games',
      '/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    )).toBe('/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games')
  })

  it('appends dropped entries that no kept entry follows, once each', () => {
    expect(restoreDroppedPath('/usr/bin:/bin', '/usr/bin:/go/bin:/go/bin::/cargo/bin')).toBe('/usr/bin:/bin:/go/bin:/cargo/bin')
    expect(restoreDroppedPath('/usr/bin', undefined)).toBe('/usr/bin')
  })
})

describe('captureLoginEnvironment', () => {
  it('resolves undefined (never rejects) when the provider throws', async () => {
    const snapshot = await captureLoginEnvironment({
      subprocess: { spawn: () => { throw new Error('provider refused') } },
      cwd: home, env: {}, timeoutMs: 1_000, graceMs: 100,
    })
    expect(snapshot).toBeUndefined()
  })
})

describe('LocalBashExecutor login-shell environment', () => {
  it('a variable exported only from the login profile is visible to every command', async () => {
    writeFileSync(join(home, '.bash_profile'), PROFILE)
    const { bash } = await setup()
    expect(await run(bash, 'printf %s "$LOGIN_PROBE"')).toBe('from-login-profile')
    // Still a fresh non-login process per call: the snapshot is the base, not a sourced profile.
    expect(await run(bash, 'shopt -q login_shell && echo login || echo non-login')).toBe('non-login\n')
    const proc = await bash.start(bash.resolve({ command: 'printf %s "$LOGIN_PROBE"' }))
    await proc.done
    expect(proc.readOutput().delta).toBe('from-login-profile')
  })

  it('reads ~/.profile when no ~/.bash_profile exists', async () => {
    writeFileSync(join(home, '.profile'), 'export LOGIN_PROBE=from-dot-profile\n')
    const { bash } = await setup()
    expect(await run(bash, 'printf %s "$LOGIN_PROBE"')).toBe('from-dot-profile')
  })

  it('credential-shaped and IO_AGENT_* variables from the login profile stay scrubbed', async () => {
    writeFileSync(join(home, '.bash_profile'), PROFILE)
    const { bash } = await setup()
    expect(await run(bash, 'printf "%s|%s|%s" "${GITHUB_TOKEN-unset}" "${MY_SERVICE_API_KEY-unset}" "${IO_AGENT_FORGED-unset}"'))
      .toBe('unset|unset|unset')
  })

  it('layers the snapshot beneath the terminal overrides, the caller env and managedEnv; PWD follows the call', async () => {
    writeFileSync(join(home, '.bash_profile'), PROFILE)
    const { bash } = await setup()
    const workdir = mkdtempSync(join(tmpdir(), 'io-agent-login-env-wd-'))
    try {
      const out = await run(bash, 'printf "%s|%s|%s|%s|%s|%s" "$TERM" "$PAGER" "$LOGIN_SHARED" "$IO_AGENT_CALL" "$PWD" "$(pwd)"', {
        workdir,
        env: { LOGIN_SHARED: 'from-caller' },
        managedEnv: { IO_AGENT_CALL: 'trusted' },
      })
      expect(out).toBe(`dumb|cat|from-caller|trusted|${workdir}|${workdir}`)
      // A deliberately forwarded credential still reaches the command, as before.
      expect(await run(bash, 'printf %s "$GITHUB_TOKEN"', { env: { GITHUB_TOKEN: 'forwarded' } })).toBe('forwarded')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('a profile that resets PATH keeps the inherited entries, so image toolchains still resolve', async () => {
    const toolchain = mkdtempSync(join(tmpdir(), 'io-agent-login-env-bin-'))
    const originalPath = process.env.PATH
    try {
      mkdirSync(join(toolchain, 'bin'))
      writeFileSync(join(toolchain, 'bin', 'image-tool'), '#!/bin/sh\necho image-tool-ran\n')
      chmodSync(join(toolchain, 'bin', 'image-tool'), 0o755)
      process.env.PATH = `${join(toolchain, 'bin')}:${originalPath ?? '/usr/bin:/bin'}`
      // What /etc/profile does on Debian: PATH replaced outright, then a profile addition.
      writeFileSync(join(home, '.bash_profile'), 'PATH=/usr/bin:/bin\nexport PATH="$PATH:/login/only"\n')
      const { bash } = await setup()
      expect(await run(bash, 'image-tool')).toBe('image-tool-ran\n')
      expect(await run(bash, 'printf %s "$PATH"')).toMatch(new RegExp(`^${join(toolchain, 'bin')}:.*:/login/only$`))
    } finally {
      process.env.PATH = originalPath
      rmSync(toolchain, { recursive: true, force: true })
    }
  })

  it('a secret withheld after the capture stays out of later commands', async () => {
    writeFileSync(join(home, '.bash_profile'), 'export ROUTE_CREDENTIAL_COPY=fake-rotated-model-key-0123\n')
    const { bash } = await setup()
    expect(await run(bash, 'printf %s "${ROUTE_CREDENTIAL_COPY-unset}"')).toBe('fake-rotated-model-key-0123')
    const release = withholdFromChildren(() => ['fake-rotated-model-key-0123'])
    try {
      expect(await run(bash, 'printf %s "${ROUTE_CREDENTIAL_COPY-unset}"')).toBe('unset')
    } finally {
      release()
    }
  })

  it('profile chatter on stdout never reaches a command', async () => {
    writeFileSync(join(home, '.bash_profile'), PROFILE)
    const { bash } = await setup()
    expect(await run(bash, 'echo ok')).toBe('ok\n')
  })

  it('falls back to the scrubbed parent environment when the login shell fails', async () => {
    writeFileSync(join(home, '.bash_profile'), 'export LOGIN_PROBE=half-set\nexit 3\n')
    process.env.AMBIENT_PROBE = 'ambient'
    try {
      const { bash } = await setup()
      expect(await run(bash, 'printf "%s|%s" "${LOGIN_PROBE-unset}" "$AMBIENT_PROBE"')).toBe('unset|ambient')
    } finally {
      delete process.env.AMBIENT_PROBE
    }
  })

  it('falls back within its bound when the login profile hangs', async () => {
    writeFileSync(join(home, '.bash_profile'), 'export LOGIN_PROBE=too-late\nsleep 30\n')
    class ShortBound extends LocalBashExecutor {
      protected override loginEnvTimeoutMs(): number { return 300 }
    }
    const started = Date.now()
    const { bash } = await setup(ShortBound)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await run(bash, 'printf %s "${LOGIN_PROBE-unset}"')).toBe('unset')
  })

  it('a command issued while the capture runs waits for it outside its own timeout', async () => {
    writeFileSync(join(home, '.bash_profile'), 'sleep 0.6\nexport LOGIN_PROBE=after-wait\n')
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: 'printf %s "$LOGIN_PROBE"', timeoutMs: 300 }))
    expect(result.timedOut).toBe(false)
    expect(result.stdout.text).toBe('after-wait')
  })

  it('an abort during the wait settles the command as aborted without spawning it', async () => {
    writeFileSync(join(home, '.bash_profile'), 'sleep 2\n')
    const { ctx, bash } = await setup()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 50)
    const started = Date.now()
    const result = await bash.run(bash.resolve({ command: 'echo never', signal: controller.signal }))
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null, signal: null })
    expect(result.stdout.text).toBe('')
    const background = new AbortController()
    setTimeout(() => { background.abort() }, 50)
    await expect(bash.start(bash.resolve({ command: 'echo never', signal: background.signal }))).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('the sandboxing executor carries the snapshot into confined foreground and background commands', async () => {
    writeFileSync(join(home, '.bash_profile'), PROFILE)
    const confined: string[][] = []
    class PassthroughSandbox extends SandboxProvider {
      async confine(argv: readonly string[]): Promise<ConfinedArgv> {
        confined.push([...argv])
        return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
      }
    }
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(PassthroughSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200, timeoutMs: 10_000 })
    const bash = ctx.shell as SandboxBashExecutor
    const command = 'printf "%s|%s" "$LOGIN_PROBE" "${GITHUB_TOKEN-unset}"'
    const result = await bash.run(bash.resolve({ command }))
    expect(result.stdout.text).toBe('from-login-profile|unset')
    expect(result.sandbox?.mode).toBe('read-only')
    const proc = await bash.start(bash.resolve({ command }))
    await proc.done
    expect(proc.readOutput().delta).toBe('from-login-profile|unset')
    // The capture itself is not a confined command: only the two commands reached the provider.
    expect(confined).toEqual([['bash', '-c', command], ['bash', '-c', command]])
  })
})
