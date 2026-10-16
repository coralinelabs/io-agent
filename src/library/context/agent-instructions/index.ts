import { visibleAuthoredUserMessages, visibleUserMessages } from '../visibility.ts'
/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful
 * read/write/edit, bash, grep and glob touches project nested, changed, and removed
 * instructions into the inbox.
 * Plugin lifecycle reads use the optional `ctx.fs` provider, so providerless products
 * mount it as a no-op.
 *
 * @module io-agent/agent-instructions
 */

import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { isDeepStrictEqual } from 'node:util'
import { modelText } from "../text/index.ts"
import type { Agent, PreStepDecision } from "../../runtime/agents/index.ts"
import { createUserMessage } from "../../model/llm/index.ts"
import type { Session, UserMessage } from "../../session/journal/index.ts"
import type {} from "../../session/projection/index.ts"
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from "../../tools/index.ts"
import { Config, resolveConfig, workspaceBaselineIdentity, type ResolvedConfig } from './config.ts'
import { findProjectRoot, loadBaselineInstructionSet } from './files.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  name,
  reconcileInstructionContext,
  agentInstructionsMessage,
  type InstructionVersionCache,
  type AgentInstructionSource,
} from './state.ts'
import { instructionScopeKey, type AgentInstructionChange } from './render.ts'
import { instructionTouches } from './touch.ts'

export { Config, name }
/** Services required by workspace instruction projection. */
export const inject = ['sessionProjections']
export {
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
} from './files.ts'
export type {
  InstructionFile,
  LoadedInstructionFile,
} from './files.ts'
export { renderAgentInstructions } from './render.ts'
export type { RenderedAgentInstructions, TruncatedInstruction } from './render.ts'

function visibleBaselineSource(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): AgentInstructionSource | undefined {
  for (const message of authorityMessages.toReversed()) {
    if (message.source.kind === 'agent-instructions' && message.source.baseline === true) {
      return message.source
    }
  }
  const message = visibleAuthoredUserMessages(agent.session).findLast(message => message.source.kind === 'agent-instructions' && message.source.baseline === true)
  if (message?.source.kind === 'agent-instructions') return message.source
  return undefined
}

function isAgentInstructionsMessage(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

/**
 * Wait for `work` unless `signal` aborts first; the work itself keeps running.
 * @param work - a projection tail, which never rejects.
 * @param signal - the turn or tool signal whose abort ends the wait.
 */
function untilSettledOrAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/** The write/edit target the requireBeforeWrite guard prepares; touches come from {@link instructionTouches}. */
function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (exec.name !== 'write' && exec.name !== 'edit') return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  // The project root found at a session's first composition, kept for this loop
  // instance: scope keys are relative to it, so a root marker created or removed
  // mid-session must not reinterpret them. A new or resumed session searches again.
  const projectRoots = new WeakMap<Session, string>()
  const projectionLifecycle = new AbortController()
  /**
   * A touched file (read/write/edit: its parent chain is probed) or directory
   * (bash/grep/glob: a guess, probed through itself where it exists).
   */
  type ProjectionTouch = { agent: Agent; path: string; directory: boolean }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  ctx.effect(
    () => () => {
      projectionLifecycle.abort(new Error('agent-instructions disposed'))
      executionTouches.clear()
    },
    'agent-instructions.projectionLifecycle',
  )
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>()
  // Execution ancestry and the enclosing durable step are the two commit
  // boundaries before an asynchronous projection may mutate the agent inbox.
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
    touchedDirectories: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return undefined
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    if (touchedPaths.length === 0 && touchedDirectories.length === 0 && pending.length > 0) return pending[0]
    const content: UserMessage['content'][number][] = []
    const changes: AgentInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd()
    let projectRoot = projectRoots.get(agent.session)
    if (projectRoot === undefined) {
      const found = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
      // A concurrent first composition may have settled first; its root wins.
      projectRoot = projectRoots.get(agent.session) ?? found
      projectRoots.set(agent.session, projectRoot)
    }
    const identity = workspaceBaselineIdentity(resolved, cwd, projectRoot)
    const visibleBaseline = visibleBaselineSource(agent, authorityMessages)
    const baselinePresent = visibleBaseline !== undefined
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity
    const prepared = baselinePreparations.get(agent.session)
    let excludedBaselineScopes = keepVisibleBaseline && prepared?.identity === identity
      ? prepared.excludedScopes
      : undefined
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline
      const instructions = await loadBaselineInstructionSet({
        cwd,
        ...resolved.dshHome === undefined ? {} : { dshHome: resolved.dshHome },
        projectRootMarkers: resolved.projectRootMarkers,
        maxBytes: resolved.maxBytes,
        maxSourceBytes: resolved.maxSourceBytes,
        maxTotalSourceBytes: resolved.maxTotalSourceBytes,
        instructionFileCandidates: resolved.instructionFileCandidates,
        localInstructionFileCandidates: resolved.localInstructionFileCandidates,
        projectRoot,
        replacePreviousBaseline,
        signal,
      }, fileSystem)
      const baseline = baselineInstructionState(instructions?.included ?? [])
      const observedBaseline = baselineInstructionState(instructions?.observed ?? [])
      const excludedScopes = new Set(observedBaseline.changes.keys())
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope)
      // Left unread by the total read bound: excluded like a file the render budget omitted.
      for (const file of instructions?.unread ?? []) excludedScopes.add(instructionScopeKey(file.displayPath))
      excludedBaselineScopes = excludedScopes
      nextPreparation = { identity, excludedScopes }
      let versionStates = instructionVersions.get(agent.session)
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map()
        instructionVersions.set(agent.session, versionStates)
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state)
      if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
        const baselineContent = agentInstructionsMessage(instructions.rendered.text).content
        content.push(...baselineContent)
        const replacementScopes = new Set(baseline.changes.keys())
        const replacementRemovals = replacePreviousBaseline
          ? visibleBaseline.changes.flatMap(change => (
            change.action === 'remove' || replacementScopes.has(change.scope)
              ? []
              : [{ action: 'remove' as const, scope: change.scope, path: change.path }]
          ))
          : []
        const baselineChanges = [...replacementRemovals, ...baseline.changes.values()]
        changes.push(...baselineChanges)
        authorityMessages.push(createUserMessage({
          content: baselineContent,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            baseline: true,
            baselineIdentity: identity,
            changes: baselineChanges,
          },
        }))
        desiredBaseline = true
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      resolved,
      instructionVersions,
      fileSystem,
      {
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...keepVisibleBaseline ? { excludedBaselineScopes } : {},
        touchedPaths,
        touchedDirectories,
        projectRoot,
        signal,
      },
    )
    if (update !== undefined) {
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === 'agent-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation)
    if (content.length === 0) return undefined
    return createUserMessage({
      content,
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        ...desiredBaseline ? { baseline: true } : {},
        ...desiredBaseline ? { baselineIdentity: identity } : {},
        changes,
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || visibleUserMessages(agent.session).some(message => sameContextPayload(message, desired))
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
    touchedDirectories: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, claimed, pending, touchedPaths, touchedDirectories)
    signal.throwIfAborted()
    syncInbox(agent, claimed, desired)
  }

  // One projection per agent and flush: composing the touches together yields the
  // same merged inbox context as serial per-touch projections, with one probe pass.
  const queueProjection = (
    agent: Agent,
    touches: readonly ProjectionTouch[],
  ): void => {
    const files = [...new Set(touches.flatMap(touch => touch.directory ? [] : [touch.path]))]
    const directories = [...new Set(touches.flatMap(touch => touch.directory ? [touch.path] : []))]
    const previous = projectionTails.get(agent) ?? Promise.resolve()
    const current = previous.then(() => composeAndSync(agent, projectionLifecycle.signal, [], files, directories))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction refresh failed: %o', error)
      })
    projectionTails.set(agent, current)
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent)
    })
  }

  // A projection runs on the plugin lifecycle signal, so a cancelled turn or tool call
  // stops waiting for it at once instead of when a slow probe pass finishes.
  const waitForProjections = async (agent: Agent, signal: AbortSignal): Promise<void> => {
    let projection: Promise<void> | undefined
    while ((projection = projectionTails.get(agent)) !== undefined) await untilSettledOrAborted(projection, signal)
  }

  if (config.requireBeforeWrite === true) {
    // Structured multi-file consumers use the same delivery-before-mutation rule as write/edit.
    // The callback runs before publication; an undisclosed instruction postpones the entire batch.
    ctx.on('fs/before-change', async (target, actor) => {
      const exec = actor as ToolExecution | undefined
      if (exec?.agent === undefined || exec.name === 'write' || exec.name === 'edit') return
      await waitForProjections(exec.agent, exec.signal)
      const fs = ctx.get('fs')
      if (fs === undefined) return
      const path = fs.processPath(target)
      await composeAndSync(exec.agent, exec.signal, [], [path])
      exec.signal.throwIfAborted()
      if (exec.agent.inbox.nextStep.some(isAgentInstructionsMessage)) throw new Error(modelText('instructions/write-retry'))
    })
    ctx.inject(['tools'], (toolCtx) => {
      const prepared = new WeakSet<object>()
      const writePath = (exec: ToolExecution): string | undefined => (
        exec.name === 'write' || exec.name === 'edit' ? filePathFromExecution(exec) : undefined
      )
      toolCtx.on('tools/pre-execute', async (exec, next) => {
        const path = writePath(exec)
        if (exec.agent !== undefined && path !== undefined) {
          await waitForProjections(exec.agent, exec.signal)
          const fs = toolCtx.get('fs')
          const canonical = fs === undefined ? path : fs.processPath(await fs.resolve(path, {
            ...(exec.agent.session.header.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
            signal: exec.signal,
          }))
          await composeAndSync(exec.agent, exec.signal, [], [...new Set([path, canonical])])
          exec.signal.throwIfAborted()
          prepared.add(exec.token)
        }
        return next()
      })
      toolCtx.tools.guard((exec) => {
        if (exec.agent === undefined || writePath(exec) === undefined) return undefined
        if (!prepared.has(exec.token) || exec.agent.inbox.nextStep.some(isAgentInstructionsMessage)) {
          return modelText('instructions/write-retry')
        }
        return undefined
      })
    })
  }

  const stepIsOpen = (session: Session): boolean => {
    const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined) {
      throw new Error('agent-instructions requires the turnBoundary session projection')
    }
    return boundary.openTurnStartSeq !== null
      && boundary.lastStepBoundary?.kind === 'start'
      && boundary.lastStepBoundary.seq > boundary.openTurnStartSeq
  }

  const queueProjections = (touches: readonly ProjectionTouch[]): void => {
    const byAgent = new Map<Agent, ProjectionTouch[]>()
    for (const touch of touches) {
      const group = byAgent.get(touch.agent)
      if (group === undefined) byAgent.set(touch.agent, [touch])
      else group.push(touch)
    }
    for (const [agent, group] of byAgent) queueProjection(agent, group)
  }

  const projectTouches = (touches: readonly ProjectionTouch[]): void => {
    const closed: ProjectionTouch[] = []
    for (const touch of touches) {
      const session = touch.agent.session
      if (!stepIsOpen(session)) {
        closed.push(touch)
        continue
      }
      const pending = stepTouches.get(session)
      if (pending === undefined) stepTouches.set(session, [touch])
      else pending.push(touch)
    }
    queueProjections(closed)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/end') return
    const pending = stepTouches.get(session)
    if (pending === undefined) return
    stepTouches.delete(session)
    queueProjections(pending)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    await waitForProjections(agent, signal)
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))) {
      return decision
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { ...decision, messages: entered }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const agent = exec.agent
      /* v8 ignore next -- normal agents carry an absolute session cwd. */
      const cwd = agent.session.header.cwd ?? process.cwd()
      const own = instructionTouches(exec, cwd, resolved.touchExcludedDirectories)
      for (const path of own.files) touches.push({ agent, path, directory: false })
      for (const path of own.directories) touches.push({ agent, path, directory: true })
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent)
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches)
        else parentTouches.push(...touches)
      }
      return
    }
    projectTouches(touches)
  })
}
