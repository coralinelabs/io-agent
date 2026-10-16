/**
 * Model-facing Consumer of the `ctx.shell` capability seam. Background calls
 * register process handles with `ctx.jobs`; their work uses job cancellation
 * rather than the tool-call signal after an id is returned. A foreground call
 * without its own `timeoutMs` that outlasts the executor's default wait is not
 * killed: the executor detaches it and it continues as a background job.
 *
 * Deployment policy (approvals, dangerous-command checks) belongs in
 * `tools/pre-execute` and sandboxing executors, not in this tool.
 * @module io-agent/tool-bash
 */

import { modelText } from "../../../context/text/index.ts"
import type { Context } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import { isAbsolute, sep } from 'node:path'
import { defineTool, TOOL_ABORTED } from "../../../tools/index.ts"
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from "../../../tools/index.ts"
import { HarnessError } from "../../../model/llm/index.ts"
import type { Agent } from "../../../runtime/agents/index.ts"
import type {} from "../../jobs/jobs/index.ts"
import type {} from "../../jobs/background/index.ts"
import type { DurableSlot } from "../../jobs/background/index.ts"
import type {} from "../../../interaction/user-approval/index.ts"
import type {} from "../shell-env/index.ts"
import type { SandboxExecutionPolicy, SandboxMode } from "../../sandbox/sandbox/index.ts"
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from "../../sandbox/sandbox/index.ts"
import type { SandboxPolicyService } from "../../sandbox/sandbox-policy/index.ts"
import { MANAGED_ENV_PREFIX } from "../shell/index.ts"
import type { ShellRunResult } from "../shell/index.ts"
import { processJob, processOutcome } from './background.ts'
import { outputBody, parseExitStatus, renderDetached, renderProcessRead, renderResult } from './render.ts'

export const name = 'tool-bash'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/** Configuration for the bash tool. */
export interface Config {
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
  /**
   * Advertise sandbox escalation under a confining executor (default true): the
   * `sandbox_permissions`/`justification` fields, the description paragraph and
   * the denial hint. A deployment whose approval can never grant an escalation
   * sets false; an unadvertised escalation is then rejected before anything runs.
   */
  escalation?: boolean
}

/** Runtime configuration schema for the bash tool plugin. */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  escalation: z.boolean().default(true),
})

/** Parsed tool args; execute validates value constraints absent from ParameterSchemaSpec. */
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

function validateBashArgs(args: BashToolArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error(modelText('foundation/tool-bash-index/text-01'))
  }
  if (args.description.trim().length === 0) {
    throw new Error(modelText('foundation/tool-bash-index/text-02'))
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(modelText('foundation/tool-bash-index/text-03', { value_1: String(JSON.stringify(args.timeoutMs)) }))
  }
  // The escalation pairing (sandbox_permissions ⇔ justification, non-empty) is
  // the shared rule both enforcing families validate identically.
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

function bashDescription(backgroundEnabled: boolean, escalationModes: readonly SandboxMode[]): string {
  const background = backgroundEnabled
    ? modelText('runtime/tool-bash-index/text-01')
    : modelText('runtime/tool-bash-index/text-02')
  const base = modelText('runtime/tool-bash-index/text-03', { value_1: String(MANAGED_ENV_PREFIX), value_2: String(background) })
  if (escalationModes.length === 0) return base
  return modelText('runtime/tool-bash-index/text-04', { value_1: String(base) })
}

/**
 * Present foreground calls as terminals and background starts as generic cards.
 * The command remains the title on both paths; foreground cwd is passed through
 * for the bridge to resolve, while background descriptions remain card content.
 */
type BashCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentBashCall(args: BashCallArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * Present completed foreground output as a terminal; background acknowledgements
 * and execution errors use generic fenced output without an exit-status pill.
 */
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = (typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true)
    || (typeof result.meta === 'object' && result.meta !== null && !Array.isArray(result.meta) && result.meta.background === true)
  // Background acknowledgements and errors have no terminal exit status.
  if (isBackground || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: modelText('runtime/tool-bash-index/text-05', { value_1: String(raw.replace(/\n+$/, '')) }) }] }
  }
  // The exit marker becomes the card's exit pill, so it leaves the output body.
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the filesystem identity of the session cwd and leave executor
 * defaulting as the fallback. A resolved sandbox-policy root wins so workdir
 * and confinement use the exact same per-call identity.
 */
function resolveWorkdir(
  modelWorkdir: string | undefined,
  exec: { agent?: Agent },
  policyWorkspaceRoot?: string,
): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  const sessionCwd = policyWorkspaceRoot ?? headerCwd
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return `${sessionCwd}${sep}${modelWorkdir}`
  }
  return modelWorkdir
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalBashResult(result: ShellRunResult) {
  const output = (stream: ShellRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
        ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
      },
    } : {},
  }
}

/** Disk bound of one durable output file (the executor's default spill bound). */
const DURABLE_FILE_BYTES = 64 * 1024 * 1024

/** Canonical background-handle properties shared by the bash output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  /** Present when a foreground call outlasted the default wait: how long it ran in the foreground. */
  afterMs: { type: 'number' },
  /** With `afterMs`: the output up to the move, rendered like a foreground result's body. */
  output: { type: 'string' },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  const backgroundEnabled = config.enableRunInBackground ?? true
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined || config.escalation === false ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error(modelText('runtime/tool-bash-index/text-06'))
  }
  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to
   * {@link approveEscalation}. This tool contributes only the composition
   * guard (the fields are unadvertised without a sandboxing executor, yet
   * schema validation checks advertised keys only, so an unadvertised
   * `sandbox_permissions` still reaches execute) and the approval
   * ingredients. The shared policy resolver is required whenever the executor
   * advertises confinement, so a split composition fails at tool-plugin load.
   */
  const approveBashEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error(defaultMode === undefined ? modelText('runtime/tool-bash-index/text-07') : modelText('tools/escalation-disabled'))
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'bash',
        signal: exec.signal,
      },
    )
  }

  /** Render a durable job's read the way a background process read renders. */
  const renderRead = (read: Parameters<typeof renderProcessRead>[0], proc: ShellRunResult['detached']): string =>
    renderProcessRead(read, proc?.sandbox, escalationModes)
  // Jobs adopted after a restart have no process handle of ours; their reads render the same way.
  ctx.inject(['background'], (backgroundCtx) => { backgroundCtx.background.setRenderer(renderRead) })

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: modelText('runtime/tool-bash-index/text-08'),
  })

  ctx.tools.register(defineTool({
    name: 'bash',
    description: bashDescription(backgroundEnabled, escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: modelText('runtime/tool-bash-index/text-09') },
      description: {
        type: 'string',
        required: true,
        description: modelText('runtime/tool-bash-index/text-10'),
      },
      timeoutMs: { type: 'number', description: modelText(backgroundEnabled ? 'runtime/tool-bash-index/text-19' : 'runtime/tool-bash-index/text-11') },
      workdir: { type: 'string', description: modelText('runtime/tool-bash-index/text-12') },
      ...backgroundEnabled ? {
        run_in_background: { type: 'boolean' as const, description: modelText('runtime/tool-bash-index/text-13') },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...escalationModes],
          description: modelText('runtime/tool-bash-index/text-14'),
        },
        justification: {
          type: 'string' as const,
          description: modelText('runtime/tool-bash-index/text-15'),
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: BACKGROUND_OUTPUT_PROPERTIES,
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              sandbox: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true },
                  denied: { type: 'boolean', required: true },
                  enforcement: { type: 'string' },
                  runnerFailed: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind !== 'background'
          ? renderResult(value as { kind: 'foreground' } & ShellRunResult, escalationModes)
          : value.afterMs === undefined
            ? `started background job ${value.jobId}`
            : renderDetached(value.output ?? '', value.afterMs, value.jobId),
      }],
      // Hosts present a moved command as a background start, not a terminal without an exit status.
      presentationMeta: (_args, value) => value.kind === 'background' ? { background: true } : {},
    },
    async execute(args: BashToolArgs, exec) {
      validateBashArgs(args)
      // Description is display metadata; workdir defaults to the caller's session.
      const standingPolicy = resolveSandboxPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
      const managedEnv = ctx.shellEnv.collect(exec)
      // an embedder's ordinary variables (a person's secrets), read at this call
      const env = ctx.shellEnv.environment(exec)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...env === undefined ? {} : { env },
        managedEnv,
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }
      if (args.run_in_background === true) {
        // Undeclared keys are allowed, so schema omission also needs enforcement.
        if (!backgroundEnabled) {
          throw new Error(modelText('runtime/tool-bash-index/text-16'))
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error(modelText('runtime/tool-bash-index/text-17'))
        }
        // The caller owns cancellation until ctx.jobs commits detached ownership.
        if (exec.signal.aborted) {
          const error = new HarnessError(modelText('foundation/tool-bash-index/text-04'), TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // A background command of a root session runs durably when the composition can: it
        // outlives this process and is adopted again under its id.
        const background = exec.agent === undefined || process.platform === 'win32' ? undefined : ctx.get('background')
        if (background !== undefined && exec.agent !== undefined && background.serves(exec.agent)) {
          const resolved = ctx.shell.resolve(request)
          const id = await background.startJob({
            owner: exec.agent,
            label: args.command,
            maxBytes: { stdout: resolved.stdoutMaxBytes, stderr: resolved.stdoutMaxBytes },
            maxFileBytes: DURABLE_FILE_BYTES,
            start: (launch, signal) => ctx.shell.start(ctx.shell.resolve({ ...request, durable: launch, signal })),
            outcome: processOutcome,
            render: renderRead,
          })
          return { kind: 'background' as const, jobId: id }
        }
        // Task preflight finishes before the starter can spawn a process.
        const id = jobs.start({
          kind: 'bash',
          label: args.command,
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => processJob(
            signal => ctx.shell.start(ctx.shell.resolve({ ...request, signal })),
            proc => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
          ),
        })
        return { kind: 'background' as const, jobId: id }
      }
      // Without the model's own deadline, the default wait is where a still-running command
      // moves to the background instead of being killed (no timeouts except real breakage).
      const jobs = backgroundEnabled && args.timeoutMs === undefined ? ctx.get('jobs') : undefined
      // A command that may move to the background runs durably from its start, so the job it
      // becomes outlives this process too.
      const background = jobs === undefined || exec.agent === undefined || process.platform === 'win32' ? undefined : ctx.get('background')
      let slot: DurableSlot | undefined
      if (background !== undefined && exec.agent !== undefined && background.serves(exec.agent)) {
        const resolved = ctx.shell.resolve(request)
        slot = await background.prepare(exec.agent, args.command,
          { maxBytes: { stdout: resolved.stdoutMaxBytes, stderr: resolved.stdoutMaxBytes }, maxFileBytes: DURABLE_FILE_BYTES })
      }
      let result: ShellRunResult
      try {
        result = await ctx.shell.run(ctx.shell.resolve({
          ...request,
          ...jobs === undefined ? {} : { detachOnTimeout: true },
          ...slot === undefined ? {} : { durable: slot.launch },
          signal: exec.signal,
        }))
      } catch (error: unknown) {
        if (slot !== undefined) await background?.release(slot, false)
        throw error
      }
      if (result.detached !== undefined && slot !== undefined && background !== undefined && exec.agent !== undefined
        && result.detached.durable !== undefined) {
        const detached = result.detached
        let id: string
        try {
          exec.signal.throwIfAborted()
          id = await background.continueAsJob(slot, exec.agent, detached, processOutcome, renderRead)
        } catch (error) {
          // A failed durable admission is an error; reap the process before returning it.
          detached.kill()
          await detached.done
          await background.release(slot, false)
          exec.signal.throwIfAborted()
          throw error
        }
        return { kind: 'background' as const, jobId: id, afterMs: result.timeoutMs, output: outputBody(result) }
      }
      // Ended in the foreground: its files go unless the result points at them.
      if (slot !== undefined) await background?.release(slot, result.stdout.truncated || result.stderr.truncated)
      if (result.detached !== undefined && jobs !== undefined) {
        const detached = result.detached
        let id: string
        try {
          exec.signal.throwIfAborted()
          id = jobs.start({
            kind: 'bash',
            label: args.command,
            ...exec.agent ? { owner: exec.agent } : {},
            run: () => processJob(
              () => Promise.resolve(detached),
              proc => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
            ),
          })
        } catch {
          // No job could take it (nothing would collect or stop it): it ends as a timeout kill.
          detached.kill()
          await detached.done
          exec.signal.throwIfAborted()
          const { detached: _handle, ...killed } = result
          return { kind: 'foreground' as const, ...canonicalBashResult({ ...killed, signal: detached.signal, exitCode: detached.exitCode }) }
        }
        return { kind: 'background' as const, jobId: id, afterMs: result.timeoutMs, output: outputBody(result) }
      }
      if (result.aborted) {
        const error = new HarnessError(modelText('foundation/tool-bash-index/text-05'), TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return { kind: 'foreground' as const, ...canonicalBashResult(result) }
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  }))
}
