/** Default bound for one model-request tool batch. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/**
 * A single ordered execution queue, independent of the agent and journal.
 * Preparation and commitment are serialized; only tool bodies overlap.
 * Exclusive calls form live barriers. A terminal failure drains started work;
 * cancellation also supplies an outcome for every not-yet-started model call.
 */
export type Concurrency = 'parallel' | 'exclusive'
export type Preparation<S, R> =
  | { kind: 'dispatch'; state: S }
  | { kind: 'settled'; state: S; result: R }

export interface OrderedExecution<I, S, R> {
  readonly items: readonly I[]
  readonly concurrency: number
  /** Maximum admitted but not yet committed results, including running work. */
  readonly maxBuffered?: number
  readonly signal: AbortSignal
  mode(item: I): Concurrency
  /** Own admission (including journal call ids) before any execution starts. */
  prepare(item: I, index: number): Promise<Preparation<S, R>>
  dispatch(state: S): Promise<R>
  /** Finalize policy and publish the result, in original model order. */
  commit(state: S, result: R, index: number): Promise<void>
  /** Cancellation must close the protocol for calls that never began. */
  skip(item: I, index: number): void
}

/** Bounded rolling execution without pre-partitioning or a second group state machine. */
export async function runOrdered<I, S, R>(execution: OrderedExecution<I, S, R>): Promise<void> {
  const { items, concurrency, signal } = execution
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('tool concurrency must be a positive safe integer')
  const maxBuffered = execution.maxBuffered ?? Math.max(32, concurrency * 4)
  if (!Number.isSafeInteger(maxBuffered) || maxBuffered < 1) throw new RangeError('result backlog must be a positive safe integer')
  const pending = new Map<number, Promise<number>>()
  const settled = new Map<number, { state: S; result: R }>()
  let next = 0
  let committed = 0
  let exclusive: number | undefined
  let failure: { error: unknown } | undefined
  const checkFailure = (): void => { if (failure !== undefined) throw failure.error }

  const commitReady = async (): Promise<void> => {
    while (settled.has(committed)) {
      const slot = settled.get(committed)!
      await execution.commit(slot.state, slot.result, committed)
      settled.delete(committed)
      if (exclusive === committed) exclusive = undefined
      committed++
      checkFailure()
    }
  }

  try {
    while (next < items.length || pending.size > 0) {
      checkFailure()
      await commitReady()
      const item = items[next]
      if (!signal.aborted && item !== undefined && pending.size < concurrency && next - committed < maxBuffered && exclusive === undefined) {
        // Re-evaluate after each ordered commit: tools and permission modes can change.
        const mode = execution.mode(item)
        if (mode === 'parallel' || pending.size === 0) {
          const index = next++
          const prepared = await execution.prepare(item, index)
          checkFailure()
          // Admission may await approval while tools/policy change. Escalation
          // creates a real barrier before the effect, not merely before its result.
          // Never weaken the mode under which this invocation was first admitted.
          const barrier = mode === 'exclusive' || (prepared.kind === 'dispatch' && execution.mode(item) === 'exclusive')
          if (barrier) {
            while (pending.size > 0) {
              pending.delete(await Promise.race(pending.values()))
              checkFailure()
              await commitReady()
            }
            await commitReady()
            exclusive = index
          }
          if (prepared.kind === 'settled') {
            settled.set(index, { state: prepared.state, result: prepared.result })
          } else {
            // Rejections become queue state so they never escape as unhandled promises.
            const completion = execution.dispatch(prepared.state).then(result => {
              settled.set(index, { state: prepared.state, result })
              return index
            }, (error: unknown) => {
              failure ??= { error }
              return index
            })
            pending.set(index, completion)
          }
          continue
        }
      }
      if (pending.size === 0) break
      pending.delete(await Promise.race(pending.values()))
    }
    checkFailure()
    await commitReady()
    if (committed !== next) throw new Error('tool scheduler lost a started outcome')
    if (signal.aborted) {
      for (; next < items.length; next++) execution.skip(items[next]!, next)
    }
  } catch (error: unknown) {
    failure ??= { error }
    await Promise.allSettled(pending.values())
    throw failure.error
  }
}
