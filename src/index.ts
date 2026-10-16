/** io-agent: a headless dsh-derived coding agent. Importing it starts no process, server, or UI. */
import { Context } from "./library/runtime/vendor/cordis/index.ts"
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import type { SessionPersistenceSnapshot } from "./library/session/persistence/index.ts"
import { awaitHostCallback } from "./library/interaction/host-callback.ts"
import { brandString } from "./library/util/brand/index.ts"
import type { AgentHandle } from "./library/runtime/agents/index.ts"
import type { SessionId } from "./library/session/journal/index.ts"
import { mountRuntime } from "./plugins/index.ts"
import { resolveOptions } from "./library/runtime/options.ts"
import type { FileChange, IoAgentOptions, ResolvedIoAgentOptions } from "./library/runtime/options.ts"
import type { ToolExecution } from "./library/tools/index.ts"
import { IoAgentSession } from "./library/runtime/session.ts"
import { nonempty } from "./library/model/connection.ts"
import { RequestInspection } from "./library/model/inspection.ts"
export type { RequestReceipt, ModelRequestSnapshot, ModelRequestObserver } from "./library/model/inspection.ts"
export type { ContinuedQuestion } from './library/interaction/continued/index.ts'
export type { MemoryOptions, MemorySnapshot } from "./library/context/memory.ts"
export type { VerificationResult } from "./library/context/verification.ts"

export type { ModelConnection, ReasoningEffort, ReasoningReplay } from "./library/model/connection.ts"
export type { IoAgentOptions, IoAgentSkillOptions, IoAgentRecallOptions, IoAgentBackgroundOptions, IoAgentMcpToolSearchOptions, McpServerOptions, FileChange } from "./library/runtime/options.ts"
export { IoAgentSession } from "./library/runtime/session.ts"
export type { Prompt, IoAgentEvent, RunResult } from "./library/runtime/session.ts"
export type { SessionMetrics, PromptCacheMetrics, ContextMetrics } from "./library/model/token-meter/metrics.ts"
export type { PrefixBreak, PrefixBreakCause, PromptCacheBucket } from "./library/model/token-meter/projection.ts"
export { promptCacheHit } from "./library/model/token-meter/metrics.ts"
export { MODEL_CONTEXT_REVISION } from "./library/context/text/index.ts"

export class IoAgent implements AsyncDisposable {
  private readonly sessions = new Map<string, IoAgentSession>()
  private readonly pending = new Map<string, Promise<IoAgentSession>>()
  private closeTask: Promise<void> | undefined
  private readonly closing = new AbortController()

  /** @internal Use createIoAgent() so partial startup is always unwound. */
  constructor(private readonly context: Context, private readonly options: ResolvedIoAgentOptions,
    private readonly inspection: RequestInspection) {}

  /** Create a persisted session; duplicate ids fail rather than overwrite existing history. */
  createSession(options: { id?: string; signal?: AbortSignal } = {}): Promise<IoAgentSession> {
    return this.open(options.id ?? randomUUID(), false, options.signal)
  }
  /** Resume through dsh's validated single-writer persistence and interrupted-turn recovery. */
  resumeSession(id: string, options: { signal?: AbortSignal } = {}): Promise<IoAgentSession> {
    return this.open(id, true, options.signal)
  }
  listSessions(): Promise<readonly SessionPersistenceSnapshot[]> {
    this.assertOpen()
    return this.context.sessionPersistence.list()
  }

  close(): Promise<void> {
    this.closeTask ??= this.disposeOwned()
    return this.closeTask
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  private open(id: string, resume: boolean, signal?: AbortSignal): Promise<IoAgentSession> {
    this.assertOpen()
    nonempty('session id', id)
    if (this.sessions.has(id) || this.pending.has(id)) return Promise.reject(new Error(`session is already open: ${id}`))
    const creationSignal = signal === undefined ? this.closing.signal : AbortSignal.any([signal, this.closing.signal])
    const operation = this.createOwned(id, resume, creationSignal)
    this.pending.set(id, operation)
    void operation.then(() => this.pending.delete(id), () => this.pending.delete(id))
    return operation
  }
  private async createOwned(id: string, resume: boolean, signal?: AbortSignal): Promise<IoAgentSession> {
    const agentOptions = { provider: this.options.connection.route, model: this.options.connection.model }
    let handle: AgentHandle
    if (resume) handle = await this.context.agents.resume({
      resumeSessionId: brandString<SessionId>(id), agentOptions,
      ...(signal === undefined ? {} : { signal }),
      validateHeader: async (header) => {
        if (header.cwd === undefined || await realpath(header.cwd) !== this.options.workspace) {
          throw new Error('session workspace does not match this io-agent instance')
        }
      },
    })
    else handle = await this.context.agents.create({ sessionId: brandString<SessionId>(id),
      meta: { cwd: this.options.workspace }, agentOptions, ...(signal === undefined ? {} : { signal }) })
    if (this.closeTask !== undefined) { await handle.dispose(); throw new Error('io-agent closed during session creation') }
    const session = new IoAgentSession(this.context, handle, this.options.connection, this.inspection, () => { this.sessions.delete(id) })
    this.sessions.set(id, session)
    return session
  }
  private assertOpen(): void { if (this.closeTask !== undefined) throw new Error('io-agent is closed') }
  private async disposeOwned(): Promise<void> {
    this.closing.abort(new Error('io-agent is closing'))
    await Promise.allSettled([...this.pending.values()])
    const results = await Promise.allSettled([...this.sessions.values()].map(session => session.close()))
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason as unknown)
    try { await this.context.fiber.dispose() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'io-agent shutdown failed')
  }
}

/** Boot the complete coding-agent library. No API request is made until work is submitted. */
export async function createIoAgent(input: IoAgentOptions): Promise<IoAgent> {
  const options = await resolveOptions(input)
  // Private like every directory the library creates below it: under a group-writable umask
  // (002, the user-private-group default) a 0775 root would make the spill sweep skip `spill/`.
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const context = new Context()
  try {
    const { onApproval, onQuestion, onFileChange } = options
    if (onApproval !== undefined) context.on('approval/request', request => awaitHostCallback(() => onApproval(request), request.signal))
    if (onQuestion !== undefined) context.on('user-questions/request', request => awaitHostCallback(() => onQuestion(request), request.signal))
    if (onFileChange !== undefined) context.on('fs/before-change', async (target, actor) => {
      const exec = actor as ToolExecution | undefined
      const change: FileChange = { callId: String(exec?.callId ?? ''), tool: exec?.name ?? '', paths: [context.fs.processPath(target)],
        ...(exec?.agent === undefined ? {} : { sessionId: String(exec.agent.id) }) }
      await awaitHostCallback(async () => { await onFileChange(change) }, exec?.signal)
    })
    const inspection = new RequestInspection(context, options.onModelRequest)
    // A function-supplied key is resolved before anything spawns (MCP servers start while mounting),
    // so the first children already have it withheld. A key not available yet is not held yet either.
    await options.connection.apiKey?.resolve().catch(() => undefined)
    await mountRuntime(context, options)
    await context.llm.resolveCallConfig({ provider: options.connection.route, model: options.connection.model })
    return new IoAgent(context, options, inspection)
  } catch (error) {
    try { await context.fiber.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'io-agent startup and rollback failed') }
    throw error
  }
}

// The names before io-agent, kept for one release so an embedder built against them keeps working.
// Calling createPluto reports itself once as a DeprecationWarning; the class and type aliases cannot.
let warnedCreatePluto = false
/** @deprecated Use {@link createIoAgent}; removed after one release. */
export function createPluto(input: IoAgentOptions): Promise<IoAgent> {
  if (!warnedCreatePluto) {
    warnedCreatePluto = true
    process.emitWarning('createPluto is deprecated; use createIoAgent', { type: 'DeprecationWarning', code: 'IO_AGENT_LEGACY_API' })
  }
  return createIoAgent(input)
}
/** @deprecated Use {@link IoAgent}; removed after one release. */
export { IoAgent as Pluto, IoAgentSession as PlutoSession }
export type { IoAgentOptions as PlutoOptions, IoAgentSkillOptions as PlutoSkillOptions, IoAgentRecallOptions as PlutoRecallOptions,
  IoAgentBackgroundOptions as PlutoBackgroundOptions, IoAgentMcpToolSearchOptions as PlutoMcpToolSearchOptions } from "./library/runtime/options.ts"
export type { IoAgentEvent as PlutoEvent } from "./library/runtime/session.ts"

export { mountExternalAgent } from './library/integrations/external-agents.ts'
export type { ExternalAgentOptions, ExternalAgentMount } from './library/integrations/external-agents.ts'

export { mountLanguageServers } from './library/integrations/code-intelligence.ts'
export type { LanguageServerOptions, LanguageServerMount } from './library/integrations/code-intelligence.ts'
