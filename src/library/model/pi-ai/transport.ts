/**
 * Transport-failure capture for pi-ai requests. pi-ai flattens a caught error
 * to its message before it reaches the adapter (undici's mid-stream socket
 * drop arrives as a bare `terminated`, its `SocketError` cause discarded), so
 * the adapter hands pi-ai a fetch that records the failure it sees, cause chain
 * included, and rethrows it unchanged. Classification then reads the error
 * codes, and falls back to the message only when none was observed.
 * @module io-agent/pi-ai/transport
 */

/** Node and undici codes for a wire that failed to connect or dropped mid-response. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
])

/** Codes for a connection or response that stopped arriving in time. */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

/**
 * Every string `code` on an error and its `cause` chain, outermost first.
 * @param error - a thrown value.
 * @returns the codes found; empty for a value without any.
 */
export function errorCodes(error: unknown): string[] {
  const codes: string[] = []
  const seen = new Set<object>()
  let current = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    current = (current as { cause?: unknown }).cause
  }
  return codes
}

/**
 * The harness failure code a set of observed error codes names.
 * @param codes - codes from {@link errorCodes}.
 * @returns `TIMEOUT` or `TRANSPORT`, or `undefined` when no code names a transport failure.
 */
export function transportFailureCode(codes: readonly string[]): 'TIMEOUT' | 'TRANSPORT' | undefined {
  if (codes.some(code => TIMEOUT_CODES.has(code))) return 'TIMEOUT'
  if (codes.some(code => TRANSPORT_CODES.has(code))) return 'TRANSPORT'
  return undefined
}

/** One request's fetch and what it observed. */
export interface ObservedFetch {
  /** Delegates to `globalThis.fetch` at call time, so an installed proxy dispatcher still applies. */
  fetch: typeof globalThis.fetch
  /** Codes of the failure the request or its streamed body raised; empty when none did. */
  failureCodes(): readonly string[]
}

/**
 * A fetch for one pi-ai request that records a failed request and a failed
 * read of a successful response's body. Error responses pass through untouched:
 * pi-ai reads their status and body itself.
 * @returns the fetch and its observation.
 */
export function observedFetch(): ObservedFetch {
  let codes: readonly string[] = []
  const record = (error: unknown): void => { codes = errorCodes(error) }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    let response: Response
    try {
      response = await globalThis.fetch(input, init)
    } catch (error) {
      record(error)
      throw error
    }
    const body = response.body
    if (!response.ok || body === null) return response
    const reader = body.getReader()
    const observed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (error) {
          record(error)
          throw error
        }
        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      },
      cancel: reason => reader.cancel(reason),
    })
    return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return { fetch, failureCodes: () => codes }
}
