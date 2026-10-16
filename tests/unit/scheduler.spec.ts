import { describe, expect, it, vi } from 'vitest'
import { runOrdered, type Concurrency } from '../../src/library/tools/scheduler.ts'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('ordered execution library', () => {
  it('refills a freed parallel slot even when an earlier call is still running', async () => {
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<number>())
    const started: number[] = [], committed: number[] = []
    const run = runOrdered({ items: [0, 1, 2, 3], concurrency: 2, signal: new AbortController().signal,
      mode: () => 'parallel', prepare: async (n: number) => ({ kind: 'dispatch' as const, state: n }),
      dispatch: async n => { started.push(n); return gates[n]!.promise },
      commit: async (_n, result) => { committed.push(result) }, skip: () => { throw Error('unexpected skip') },
    })
    await tick(); expect(started).toEqual([0, 1])
    gates[1]!.resolve(1); await tick(); expect(started).toEqual([0, 1, 2]); expect(committed).toEqual([])
    gates[2]!.resolve(2); await tick(); expect(started).toEqual([0, 1, 2, 3])
    gates[3]!.resolve(3); gates[0]!.resolve(0); await run
    expect(committed).toEqual([0, 1, 2, 3])
  })
  it('exclusive calls wait for earlier results to commit and block later starts', async () => {
    const active = new Set<number>(), finished: number[] = [], trace: string[] = []
    await runOrdered({ items: [0, 1, 2, 3], concurrency: 3, signal: new AbortController().signal,
      mode: n => n === 2 ? 'exclusive' : 'parallel', prepare: async (n: number) => ({ kind: 'dispatch' as const, state: n }),
      dispatch: async n => { if (n === 2 || n === 3) expect(active.size).toBe(0); active.add(n); trace.push(`start${n}`); await tick(); active.delete(n); return n },
      commit: async (_n, n) => { finished.push(n); trace.push(`commit${n}`) }, skip: () => {},
    })
    expect(finished).toEqual([0, 1, 2, 3]); expect(trace.indexOf('start2')).toBeGreaterThan(trace.indexOf('commit1'))
    expect(trace.indexOf('start3')).toBeGreaterThan(trace.indexOf('commit2'))
  })
  it('settled preflight outcomes commit without executing a body', async () => {
    const dispatch = vi.fn(), output: number[] = []
    await runOrdered({ items: [1, 2], concurrency: 1, signal: new AbortController().signal, mode: () => 'exclusive',
      prepare: async (n: number) => ({ kind: 'settled' as const, state: n, result: n * 2 }), dispatch,
      commit: async (_state, n) => { output.push(n) }, skip: () => {},
    })
    expect(dispatch).not.toHaveBeenCalled(); expect(output).toEqual([2, 4])
  })
  it('cancellation drains started work, commits it, then closes unstarted calls in order', async () => {
    const controller = new AbortController(), gate = Promise.withResolvers<number>(), trace: string[] = []
    const run = runOrdered({ items: [0, 1, 2], concurrency: 1, signal: controller.signal, mode: () => 'parallel',
      prepare: async (n: number) => ({ kind: 'dispatch' as const, state: n }), dispatch: async () => gate.promise,
      commit: async (_, n) => { trace.push(`commit${n}`) }, skip: n => { trace.push(`skip${n}`) },
    })
    await tick(); controller.abort(); await tick(); expect(trace).toEqual([])
    gate.resolve(0); await run; expect(trace).toEqual(['commit0', 'skip1', 'skip2'])
  })
  it('pre-aborted batches never prepare or execute', async () => {
    const prepare = vi.fn(), dispatch = vi.fn(), skip = vi.fn()
    await runOrdered({ items: [1, 2], concurrency: 2, signal: AbortSignal.abort(), mode: () => 'parallel', prepare, dispatch, commit: vi.fn(), skip })
    expect(prepare).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(skip.mock.calls).toEqual([[1, 0], [2, 1]])
  })
  it('mode is evaluated live after an earlier ordered commit', async () => {
    let mode: Concurrency = 'parallel'; const trace: string[] = []
    await runOrdered({ items: [0, 1, 2], concurrency: 1, signal: new AbortController().signal,
      mode: n => { trace.push(`${n}:${mode}`); return mode }, prepare: async (n: number) => ({ kind: 'dispatch' as const, state: n }),
      dispatch: async n => n, commit: async () => { mode = 'exclusive' }, skip: () => {},
    })
    expect(trace).toEqual(['0:parallel', '0:parallel', '1:exclusive', '2:exclusive'])
  })
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid concurrency %s', async concurrency => {
    await expect(runOrdered({ items: [], concurrency, signal: new AbortController().signal,
      mode: () => 'parallel', prepare: vi.fn(), dispatch: vi.fn(), commit: vi.fn(), skip: vi.fn() })).rejects.toThrow(/positive safe integer/)
  })
  it('a rejected body drains its siblings before returning the original failure', async () => {
    const gate = Promise.withResolvers<number>(), error = new Error('body failed'), trace: string[] = []
    const run = runOrdered({ items: [0, 1, 2], concurrency: 2, signal: new AbortController().signal,
      mode: () => 'parallel', prepare: async (n: number) => ({ kind: 'dispatch' as const, state: n }),
      dispatch: async n => { trace.push(`start${n}`); if (n === 0) return gate.promise; await tick(); throw error },
      commit: async () => {}, skip: () => { throw Error('must not manufacture a cancellation') },
    })
    let settled = false; void run.then(() => { settled = true }, () => { settled = true })
    await tick(); await tick(); expect(settled).toBe(false); expect(trace).toEqual(['start0', 'start1'])
    gate.resolve(0); await expect(run).rejects.toBe(error)
  })
})


it('bounds the uncommitted backlog behind a slow first result without losing rolling concurrency', async () => {
  const gate = Promise.withResolvers<number>(), started: number[] = [], committed: number[] = []
  const running = runOrdered({ items: Array.from({ length: 100 }, (_, i) => i), concurrency: 4, maxBuffered: 8, signal: new AbortController().signal,
    mode: () => 'parallel', prepare: async (n: number) => ({ kind: 'dispatch' as const, state: n }),
    dispatch: async n => { started.push(n); return n === 0 ? gate.promise : n },
    commit: async (_n, value) => { committed.push(value) }, skip: () => { throw Error('unexpected skip') },
  })
  await tick(); await tick(); expect(started).toEqual([0,1,2,3,4,5,6,7]); expect(committed).toEqual([])
  gate.resolve(0); await running
  expect(committed).toEqual(Array.from({ length: 100 }, (_, i) => i))
})
