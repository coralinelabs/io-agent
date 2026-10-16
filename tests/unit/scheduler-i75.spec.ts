import { expect, it } from 'vitest'
import { runOrdered, type Concurrency } from '../../src/library/tools/scheduler.ts'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it('escalates a call to exclusive after admission waits, before running its body', async () => {
  const preparing = Promise.withResolvers<void>(), approval = Promise.withResolvers<void>()
  const first = Promise.withResolvers<number>(), second = Promise.withResolvers<number>()
  const trace: string[] = []
  let changed = false
  const running = runOrdered({ items: [0, 1, 2], concurrency: 3, signal: new AbortController().signal,
    mode: n => n === 1 && changed ? 'exclusive' : 'parallel',
    prepare: async n => { if (n === 1) { preparing.resolve(); await approval.promise }; return { kind: 'dispatch', state: n } },
    dispatch: async n => { trace.push(`start:${n}`); return n === 0 ? first.promise : n === 1 ? second.promise : n },
    commit: async (_, n) => { trace.push(`commit:${n}`) }, skip: () => { throw Error('unexpected cancellation') },
  })
  await preparing.promise; changed = true; approval.resolve(); await tick()
  expect(trace).toEqual(['start:0'])
  first.resolve(0); await tick()
  expect(trace).toEqual(['start:0', 'commit:0', 'start:1'])
  second.resolve(1); await running
  expect(trace).toEqual(['start:0', 'commit:0', 'start:1', 'commit:1', 'start:2', 'commit:2'])
})

it('does not downgrade an originally exclusive admission while it waits', async () => {
  const preparing = Promise.withResolvers<void>(), approval = Promise.withResolvers<void>(), body = Promise.withResolvers<number>()
  let mode: Concurrency = 'exclusive'
  const started: number[] = []
  const running = runOrdered({ items: [0, 1], concurrency: 2, signal: new AbortController().signal,
    mode: () => mode,
    prepare: async n => { if (n === 0) { preparing.resolve(); await approval.promise }; return { kind: 'dispatch', state: n } },
    dispatch: async n => { started.push(n); return n === 0 ? body.promise : n }, commit: async () => {}, skip: () => {},
  })
  await preparing.promise; mode = 'parallel'; approval.resolve(); await tick()
  expect(started).toEqual([0]); body.resolve(0); await running; expect(started).toEqual([0, 1])
})

it('drains earlier work before returning a failure during an escalated barrier', async () => {
  const first = Promise.withResolvers<number>(), second = Promise.withResolvers<number>(), approval = Promise.withResolvers<void>()
  const preparing = Promise.withResolvers<void>(), failure = new Error('predecessor failed')
  let exclusive = false, settled = false
  const starts: number[] = []
  const running = runOrdered({ items: [0, 1, 2], concurrency: 3, signal: new AbortController().signal,
    mode: n => n === 2 && exclusive ? 'exclusive' : 'parallel',
    prepare: async n => { if (n === 2) { preparing.resolve(); await approval.promise }; return { kind: 'dispatch', state: n } },
    dispatch: async n => { starts.push(n); return n === 0 ? first.promise : second.promise }, commit: async () => {}, skip: () => {},
  })
  void running.then(() => { settled = true }, () => { settled = true })
  await preparing.promise; exclusive = true; approval.resolve(); second.reject(failure); await tick()
  expect(settled).toBe(false); expect(starts).toEqual([0, 1])
  first.resolve(0); await expect(running).rejects.toBe(failure)
})
