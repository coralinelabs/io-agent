/**
 * Registry tests for `@deepseek-ai/dsh-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { SESSION_FORMAT_VERSION } from "../../../src/library/session/journal/index.ts"
import type { ToolExecution } from "../../../src/library/tools/index.ts"
import { ShellEnvRegistry } from "../../../src/library/execution/shell/shell-env/index.ts"
import * as BashEnvPlugin from "../../../src/library/execution/shell/shell-env/index.ts"

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: ToolCallId('bash-env-call'),
    rootCallId: ToolCallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : {
        agent: {
          session: {
            header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false },
          },
        } as unknown as Agent,
      }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { userDirectory: './test-dsh-home' })

    expect(registry.collect(execution())).toEqual({
      IO_AGENT_USER_DIR: resolve('./test-dsh-home'),
      IO_AGENT_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      IO_AGENT_USER_DIR: resolve('./test-dsh-home'),
      IO_AGENT_SESSION_ID: 'session-a',
      IO_AGENT_SHELL: '1',
    })
  })

  it('sets no IO_AGENT_USER_DIR without a configured home: neither the ambient variable nor the user home stands in', () => {
    vi.stubEnv('IO_AGENT_USER_DIR', './ambient-dsh-home')
    const registry = new ShellEnvRegistry(new Context())
    expect(registry.collect(execution())).toEqual({ IO_AGENT_SHELL: '1' })
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { userDirectory: './test-dsh-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        IO_AGENT_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { IO_AGENT_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        IO_AGENT_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ IO_AGENT_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('IO_AGENT_SESSION_OPTIONAL')
    expect(registry.collect(execution()).IO_AGENT_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).IO_AGENT_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list().filter(entry => entry.contributor !== 'shell-env')).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'IO_AGENT_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'IO_AGENT_SESSION_OPTIONAL',
      },
    ])
    expect(registry.list().map(entry => entry.key)).toEqual([
      'IO_AGENT_ALWAYS_AVAILABLE', 'IO_AGENT_SESSION_ID', 'IO_AGENT_SESSION_OPTIONAL', 'IO_AGENT_SHELL', 'IO_AGENT_USER_DIR',
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { userDirectory: './test-dsh-home' })
    registry.register({
      name: 'first',
      variables: { IO_AGENT_SHARED: { description: 'First owner.' } },
      resolve: () => ({ IO_AGENT_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { IO_AGENT_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ IO_AGENT_SHARED: 'second' }),
    })).toThrow(/IO_AGENT_SHARED.*first.*second|IO_AGENT_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { userDirectory: './test-dsh-home' })
    registry.register({
      name: 'declared',
      variables: { IO_AGENT_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { IO_AGENT_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { IO_AGENT_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { pluto_invalid: { description: 'Invalid key.' } } as unknown as Record<'IO_AGENT_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { IO_AGENT_USER_DIR: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { IO_AGENT_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { userDirectory: './test-dsh-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { IO_AGENT_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ IO_AGENT_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*IO_AGENT_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { userDirectory: './test-dsh-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { IO_AGENT_STRING: { description: 'String fact.' } },
      resolve: () => ({ IO_AGENT_STRING: 42 }) as unknown as Record<'IO_AGENT_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*IO_AGENT_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { userDirectory: './test-dsh-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { IO_AGENT_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ IO_AGENT_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).IO_AGENT_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('IO_AGENT_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { userDirectory: './test-dsh-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { IO_AGENT_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ IO_AGENT_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).IO_AGENT_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('IO_AGENT_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service with only its own built-ins on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list().map(entry => [entry.contributor, entry.key])).toEqual([
      ['shell-env', 'IO_AGENT_SESSION_ID'],
      ['shell-env', 'IO_AGENT_SHELL'],
    ])
  })

  it('lists every built-in a call can receive, as collect() sets them', () => {
    const registry = new ShellEnvRegistry(new Context(), { userDirectory: './test-dsh-home' })
    const listed = registry.list().map(entry => entry.key)
    expect(Object.keys(registry.collect(execution('session-c'))).every(key => listed.includes(key as never))).toBe(true)
    for (const entry of registry.list()) expect(entry.description.length).toBeGreaterThan(0)
  })

  it('gives every call the variables its sources hold now, leaving out names a source may not set', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx)
    let value = 'first'
    const dispose = registry.provide({ name: 'secrets', resolve: () => ({ STRIPE_KEY: value, PATH: '/x', GIT_DIR: '/x', IO_AGENT_SHELL: '0', 'bad name': 'x', NUL: 'a\0b' }) })
    expect(registry.environment(execution())).toEqual({ STRIPE_KEY: 'first' })
    value = 'rotated'
    expect(registry.environment(execution())).toEqual({ STRIPE_KEY: 'rotated' })
    dispose()
    expect(registry.environment(execution())).toBeUndefined()
  })
})
