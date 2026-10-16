/** Contain a borrowed host callback; non-Error failures retain their original value as cause. */
export function awaitHostCallback<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      const reason: unknown = signal?.reason
      reject(reason instanceof Error ? reason : new Error('host request cancelled', { cause: reason }))
    }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    // Invoke in a microtask: synchronous throws and late rejections are both observed.
    void Promise.resolve().then(() => {
      signal?.throwIfAborted()
      return call()
    }).then((value) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) abort()
      else resolve(value)
    }, (error: unknown) => {
      signal?.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error('host callback failed', { cause: error }))
    })
  })
}
