/** One foreground deadline covers sandbox preparation and native execution. */
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { SandboxProvider } from "../../../src/library/execution/sandbox/sandbox/index.ts"
import type { ConfinedArgv, SandboxPolicy } from "../../../src/library/execution/sandbox/sandbox/index.ts"
import { SandboxPolicyService } from "../../../src/library/execution/sandbox/sandbox-policy/index.ts"
import { SessionProjectionRegistry } from "../../../src/library/session/projection/index.ts"
import { LocalSubprocessRuntime } from "../../../src/library/execution/process/subprocess-local/index.ts"
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from "../../../src/library/execution/process/subprocess/index.ts"
import type { ShellRunResult } from "../../../src/library/execution/shell/shell/index.ts"
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SandboxPwshExecutor } from "../../../src/library/execution/shell/pwsh-sandbox/index.ts"

async function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const ctx = new Context()
  const prepared = Promise.withResolvers<ConfinedArgv>()
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const spawned = Promise.withResolvers<SubprocessSpawnSpec>()
  const completion = Promise.withResolvers<SubprocessOutcome>()
  const runs: Promise<ShellRunResult>[] = []
  const listeners: Array<() => void> = []
  const wrap: ConfinedArgv = { argv: ['fixture-runner'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  const confine = vi.fn(async (_argv: readonly string[], _policy: SandboxPolicy, signal?: AbortSignal) => {
    entered.resolve(signal)
    return prepared.promise
  })
  class ControlledSandbox extends SandboxProvider {
    override confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      return confine(argv, policy, signal)
    }
  }
  const terminate = vi.fn(() => { completion.resolve({ exitCode: null, signal: 'SIGTERM' }) })
  const output = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: { stdout: output, stderr: output }, done: completion.promise,
    terminate, waitForExit: async () => { await completion.promise; return true },
  }
  onTestFinished(async () => {
    prepared.resolve(wrap)
    completion.resolve({ exitCode: 0, signal: null })
    await Promise.allSettled(runs)
    for (const detach of listeners) detach()
    try { await ctx.fiber.dispose() }
    finally { vi.restoreAllMocks(); vi.useRealTimers() }
  })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(ControlledSandbox)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPwshExecutor, { timeoutMs: 100, graceMs: 100 })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    spawned.resolve(spec)
    spec.signal?.addEventListener('abort', terminate, { once: true })
    listeners.push(() => { spec.signal?.removeEventListener('abort', terminate) })
    if (spec.signal?.aborted) terminate()
    return handle
  })
  const start = (timeoutMs = 10, signal?: AbortSignal, detachOnTimeout = false) => {
    const observed: { done: boolean; result?: ShellRunResult; error?: unknown } = { done: false }
    const promise = ctx.shell.run(ctx.shell.resolve({ command: 'fixture command', timeoutMs, signal, detachOnTimeout }))
    runs.push(promise)
    void promise.then(
      (result) => { observed.done = true; observed.result = result },
      (error: unknown) => { observed.done = true; observed.error = error },
    )
    return { promise, observed }
  }
  return { ctx, prepared, entered, spawned, completion, wrap, confine, spawn, terminate, start }
}

describe('pwsh preparation deadline', () => {
  it.each(['success', 'rejection'] as const)('times out unresolved preparation and prevents late %s from spawning', async (late) => {
    const test = await setup()
    const run = test.start()
    const signal = await test.entered.promise
    await vi.advanceTimersByTimeAsync(10)
    expect(run.observed.done).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(run.observed.result).toEqual({
      exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 10,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
      sandbox: { mode: 'read-only', denied: false },
    })
    expect(test.spawn).not.toHaveBeenCalled()
    if (late === 'success') test.prepared.resolve(test.wrap)
    else test.prepared.reject(new Error('late preparation rejection'))
    await vi.advanceTimersByTimeAsync(0)
    expect(test.spawn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes the remaining deadline to native execution instead of restarting it', async () => {
    const test = await setup()
    const run = test.start(100)
    const preparationSignal = await test.entered.promise
    await vi.advanceTimersByTimeAsync(60)
    test.prepared.resolve(test.wrap)
    const spawn = await test.spawned.promise
    expect(spawn.signal).toBe(preparationSignal)
    await vi.advanceTimersByTimeAsync(39)
    expect(run.observed.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(run.observed.result).toMatchObject({ timedOut: true, aborted: false, signal: 'SIGTERM', sandbox: { enforcement: 'full' } })
    expect(test.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detaches a confined command still running at the deadline, and classifies it when it settles', async () => {
    const test = await setup()
    const run = test.start(10, undefined, true)
    await test.entered.promise
    test.prepared.resolve(test.wrap)
    await test.spawned.promise
    await vi.advanceTimersByTimeAsync(10)
    expect(run.observed.done).toBe(true)
    expect(test.terminate).not.toHaveBeenCalled()
    const result = run.observed.result!
    expect(result).toMatchObject({ timedOut: true, aborted: false, sandbox: { mode: 'read-only', denied: false, enforcement: 'full' } })
    const proc = result.detached!
    expect(proc.status).toBe('running')
    test.completion.resolve({ exitCode: 0, signal: null })
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('preserves upstream cancellation when it wins during preparation', async () => {
    const test = await setup()
    const controller = new AbortController()
    const reason = new Error('caller stopped preparation')
    const run = test.start(10, controller.signal)
    await test.entered.promise
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(20)
    expect(run.observed.done).toBe(true)
    expect(run.observed.error).toBe(reason)
    expect(test.spawn).not.toHaveBeenCalled()
    test.prepared.resolve(test.wrap)
    await vi.advanceTimersByTimeAsync(0)
    expect(test.spawn).not.toHaveBeenCalled()
  })

  it('keeps timeout as the first cause when upstream cancellation follows its notification', async () => {
    const test = await setup()
    const controller = new AbortController()
    const run = test.start(10, controller.signal)
    const signal = await test.entered.promise
    signal?.addEventListener('abort', () => { controller.abort(new Error('later caller abort')) }, { once: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(controller.signal.aborted).toBe(true)
    expect(run.observed.result).toMatchObject({ timedOut: true, aborted: false })
    expect(test.spawn).not.toHaveBeenCalled()
  })

  it('does not prepare after a pre-existing caller cancellation', async () => {
    const test = await setup()
    const reason = new Error('already cancelled')
    const run = test.start(10, AbortSignal.abort(reason))
    await vi.advanceTimersByTimeAsync(0)
    expect(run.observed.error).toBe(reason)
    expect(test.confine).not.toHaveBeenCalled()
    expect(test.spawn).not.toHaveBeenCalled()
  })

  it('preserves preparation failures and disposes the deadline', async () => {
    const test = await setup()
    const run = test.start()
    await test.entered.promise
    const error = new Error('confinement unavailable')
    test.prepared.reject(error)
    await expect(run.promise).rejects.toBe(error)
    expect(test.spawn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
