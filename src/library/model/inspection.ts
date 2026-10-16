/** Model-boundary inspection: awaited, detached, immutable; never a second transcript. */
import type { Context } from "../runtime/vendor/cordis/index.ts"
import { createHash, randomUUID } from 'node:crypto'
import { MODEL_CONTEXT_REVISION } from "../context/text/index.ts"
import type { GenerateOptions, Message, ToolSchema } from "./llm/index.ts"

export interface RequestReceipt {
  readonly id: string
  readonly sessionId?: string
  readonly model: string
  readonly purpose: string
  readonly modelContextRevision: string
  /** JSON bytes at the harness boundary, not the provider's wire/body or token count. */
  readonly contextBytes: number
  readonly contextSha256: string
}
export interface ModelRequestSnapshot extends RequestReceipt {
  readonly system?: string
  readonly messages: readonly Message[]
  readonly tools: readonly ToolSchema[]
  readonly maxTokens?: number
}
/** Awaited before inference. Throw to veto the request; never use this as public telemetry. */
export type ModelRequestObserver = (request: ModelRequestSnapshot, signal?: AbortSignal) => void | Promise<void>

export function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}
function contextOf(options: GenerateOptions) {
  return { ...(options.system === undefined ? {} : { system: options.system }), messages: options.messages, tools: options.tools ?? [] }
}
function receiptFor(options: GenerateOptions): RequestReceipt {
  const json = JSON.stringify(contextOf(options))
  return Object.freeze({ id: randomUUID(), ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
    model: options.model, purpose: options.purpose ?? 'agent', modelContextRevision: MODEL_CONTEXT_REVISION,
    contextBytes: Buffer.byteLength(json), contextSha256: createHash('sha256').update(json).digest('hex') })
}
export function snapshotRequest(options: GenerateOptions, receipt = receiptFor(options)): ModelRequestSnapshot {
  return freezeSnapshot({ ...receipt, ...structuredClone(contextOf(options)),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) })
}

/** Latest 32 metadata-only observations per live session; full content is delivered only on opt-in. */
export class RequestInspection {
  private readonly receipts = new Map<string, RequestReceipt[]>()
  constructor(ctx: Context, observer?: ModelRequestObserver) {
    const receipts = this.receipts
    ctx.on('llm/stream', async function* (options, next) {
      options.signal?.throwIfAborted()
      const receipt = receiptFor(options)
      if (receipt.sessionId !== undefined) {
        const list = receipts.get(receipt.sessionId) ?? []
        receipts.set(receipt.sessionId, [...list.slice(-31), Object.freeze(receipt)])
      }
      if (observer !== undefined) await awaitObserver(observer, snapshotRequest(options, receipt), options.signal)
      options.signal?.throwIfAborted()
      yield* next()
    })
    ctx.on('agent/disposed', ({ agent }) => { this.receipts.delete(String(agent.id)) })
  }
  list(sessionId: string): readonly RequestReceipt[] { return [...this.receipts.get(sessionId) ?? []] }
}

/** Cancellation releases inference ownership even when an audit callback fails to cooperate. */
async function awaitObserver(observer: ModelRequestObserver, snapshot: ModelRequestSnapshot, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (signal === undefined) return observer(snapshot)
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    await Promise.race([Promise.resolve().then(() => observer(snapshot, signal)), aborted])
  } finally { signal.removeEventListener('abort', onAbort) }
}
