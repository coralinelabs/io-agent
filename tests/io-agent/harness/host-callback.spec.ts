/** Borrowed callbacks retain failure identity without blocking cancellation. */
import { expect, it } from 'vitest'
import { awaitHostCallback } from "../../../src/library/interaction/host-callback.ts"

it('preserves Error identity and carries non-Error rejection values as cause', async () => {
  const error = new Error('callback failure')
  await expect(awaitHostCallback(() => Promise.reject(error))).rejects.toBe(error)
  const value = { reason: 'host failure' }
  await expect(awaitHostCallback(async () => { throw value })).rejects.toMatchObject({ cause: value })
})

it('does not invoke an already-aborted callback and contains a late rejection', async () => {
  const controller = new AbortController()
  controller.abort('owner cancelled')
  let calls = 0
  await expect(awaitHostCallback(async () => { calls++; return 1 }, controller.signal))
    .rejects.toMatchObject({ cause: 'owner cancelled' })
  expect(calls).toBe(0)
  const late = Promise.withResolvers<number>(), active = new AbortController()
  const pending = awaitHostCallback(() => late.promise, active.signal)
  await Promise.resolve()
  const error = new Error('stop')
  active.abort(error)
  await expect(pending).rejects.toBe(error)
  late.reject(new Error('late callback failure'))
  await Promise.resolve()
})
