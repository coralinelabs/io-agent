/**
 * Model-facing PowerShell Consumer of the `ctx.shell` capability seam. Intended for
 * Windows compositions where a PowerShell executor (e.g.
 * `io-agent/pwsh-local`) backs `ctx.shell`; the tool contract is
 * PowerShell-dialect: native `C:\...` paths and `$env:NAME` variables.
 *
 * Behavior mirrors `tool-bash` call-for-call: foreground and
 * `run_in_background` execution (background handles register with the
 * generic `ctx.jobs` runtime), the managed `IO_AGENT_*` environment through the
 * shared `shell-env` registry, the per-call sandbox policy resolution (the
 * calling session's mode and cwd travel to the confining executor), the
 * sandbox-denial rendering with the same-turn escalation surface
 * (`sandbox_permissions` + `justification` resolved through
 * `ctx.approval`), and the bash marker/truncation rendering story. UI
 * presentation mirrors the bash tool's too: a completed foreground call is
 * a terminal card with the parsed exit-status pill, using the shared
 * exit-status parse from `io-agent/shell`.
 *
 * @module io-agent/tool-pwsh
 */

import { outputBody, renderDetached } from '../tool-bash/render.ts'
import { modelText } from "../../../context/text/index.ts"
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import { defineTool, TOOL_ABORTED } from "../../../tools/index.ts"
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from "../../../tools/index.ts"
import { HarnessError } from "../../../model/llm/index.ts"
import type { Agent } from "../../../runtime/agents/index.ts"
import type {} from "../../jobs/jobs/index.ts"
import type {} from "../shell-env/index.ts"
import type {} from "../../../interaction/user-approval/index.ts"
import type { SandboxExecutionPolicy, SandboxMode } from "../../sandbox/sandbox/index.ts"
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from "../../sandbox/sandbox/index.ts"
import type { SandboxPolicyService } from "../../sandbox/sandbox-policy/index.ts"
import type { ShellRunResult } from "../shell/index.ts"
import { parseExitStatus } from "../shell/index.ts"
import { processJob } from './background.ts'
import { renderPwshProcessRead, renderPwshResult } from './render.ts'
import type { RenderablePwshResult } from './render.ts'

declare module "../../jobs/jobs/index.ts" {
  interface JobKindMap {
    pwsh: 'pwsh'
  }
}

export const name = 'tool-pwsh'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/** Configuration for the pwsh tool. */
export interface Config {
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
  /**
   * Advertise sandbox escalation under a confining executor (default true): the
   * `sandbox_permissions`/`justification` fields, the description's escalation
   * paragraph and the denial hint. A deployment whose approval can never grant
   * an escalation sets false; an unadvertised escalation is then rejected before
   * anything runs. The description keeps its confinement contract either way.
  */
  escalation?: boolean
}

/** Runtime configuration schema for the pwsh tool plugin. */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  escalation: z.boolean().default(true),
})

/** Parsed tool args; execute validates value constraints absent from ParameterSchemaSpec. */
interface PwshToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

/** The canonical foreground result of one pwsh call (the `output.schema` value shape). */
interface PwshForegroundResult {
  kind: 'foreground'
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
  sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean }
}

/* jscpd:ignore-start -- minimal mirror of tool-bash's validation and execute plumbing. */
function validatePwshArgs(args: PwshToolArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error(modelText('foundation/tool-pwsh-index/text-01'))
  }
  if (args.description.trim().length === 0) {
    throw new Error(modelText('foundation/tool-pwsh-index/text-02'))
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(modelText('foundation/tool-pwsh-index/text-03', { value_1: String(JSON.stringify(args.timeoutMs)) }))
  }
  // The escalation pairing (sandbox_permissions ⇔ justification, non-empty) is
  // the shared rule both enforcing families validate identically.
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}
/* jscpd:ignore-end */

function pwshDescription(backgroundEnabled: boolean, confined: boolean, escalationModes: readonly SandboxMode[]): string {
  const background = backgroundEnabled
    ? modelText('runtime/tool-pwsh-index/text-01')
    : modelText('runtime/tool-pwsh-index/text-02')
  const base = modelText('runtime/tool-pwsh-index/text-03', { value_1: String(background) })
  if (!confined) return base
  // The language-mode and named-pipe contracts below are Windows-restricted-token
  // behavior, but the gate is 'any confining executor is mounted'. Every shipped
  // composition pairing tool-pwsh with a confining executor is win32-only, so the
  // gate is equivalent. A POSIX pwsh-sandbox composition must gate both sentences
  // on the platform instead.
  const contract = modelText('runtime/tool-pwsh-index/text-04', { value_1: String(base) })
  // The escalation paragraph only where the fields are advertised.
  return escalationModes.length === 0 ? contract : `${contract} ${modelText('tools/pwsh/escalation')}`
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the session header cwd and leave executor defaulting as the fallback.
 */
function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: Agent }): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(headerCwd, modelWorkdir)
  }
  return modelWorkdir
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalPwshResult(result: ShellRunResult): PwshForegroundResult {
  const output = (stream: ShellRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    /* jscpd:ignore-start -- the canonical projection and background-handle shape mirror tool-bash's by design. */
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

/** Canonical background-handle properties shared by the pwsh output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  afterMs: { type: 'number' },
  output: { type: 'string' },
} as const
/* jscpd:ignore-end */

/* jscpd:ignore-start -- deliberate mirror of tool-bash's apply() preamble. */
export function apply(ctx: Context, config: Config = {}): void {
  const backgroundEnabled = config.enableRunInBackground ?? true
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined || config.escalation === false ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error(modelText('runtime/tool-pwsh-index/text-05'))
  }
  /* jscpd:ignore-end */
  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /* jscpd:ignore-start -- deliberate mirror of tool-bash's escalation resolver. */
  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to
   * {@link approveEscalation}. This tool contributes only the composition
   * guard (the fields are unadvertised without a sandboxing executor, yet
   * schema validation checks advertised keys only, so an unadvertised
   * `sandbox_permissions` still reaches execute) and the approval
   * ingredients. The shared policy resolver is required whenever the
   * executor advertises confinement, so a split composition fails at
   * tool-plugin load.
  */
  const approvePwshEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error(defaultMode === undefined ? modelText('runtime/tool-pwsh-index/text-06') : modelText('tools/escalation-disabled'))
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'pwsh',
        signal: exec.signal,
      },
    )
  }
  /* jscpd:ignore-end */

  ctx.systemPrompt.section({
    name: 'tool:pwsh',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PWSH'),
    text: modelText('runtime/tool-pwsh-index/text-07'),
  })

  ctx.tools.register(defineTool({
    name: 'pwsh',
    // The Windows confinement contract applies whenever a confining executor is
    // mounted; the escalation paragraph only when escalation is advertised.
    description: pwshDescription(backgroundEnabled, defaultMode !== undefined, escalationModes),
    /* jscpd:ignore-start -- deliberate mirror of tool-bash's parameter surface. */
    parameters: {
      command: { type: 'string', required: true, description: modelText('runtime/tool-pwsh-index/text-08') },
      description: {
        type: 'string',
        required: true,
        description: modelText('runtime/tool-pwsh-index/text-09'),
      },
      timeoutMs: { type: 'number', description: modelText(backgroundEnabled ? 'runtime/tool-bash-index/text-19' : 'runtime/tool-pwsh-index/text-10') },
      workdir: { type: 'string', description: modelText('runtime/tool-pwsh-index/text-11') },
      ...backgroundEnabled ? {
        run_in_background: { type: 'boolean' as const, description: modelText('runtime/tool-pwsh-index/text-12') },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...escalationModes],
          description: modelText('runtime/tool-pwsh-index/text-13'),
        },
        justification: {
          type: 'string' as const,
          description: modelText('runtime/tool-pwsh-index/text-14'),
        },
      } : {},
    },
    /* jscpd:ignore-end */
    output: {
      // The foreground result wire shape mirrors tool-bash's by contract —
      // consumers of one must accept the other.
      /* jscpd:ignore-start -- deliberate result-schema symmetry with tool-bash. */
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
      /* jscpd:ignore-end */
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? value.afterMs === undefined ? `started background job ${value.jobId}` : renderDetached(value.output ?? '', value.afterMs, value.jobId)
          : renderPwshResult(value as RenderablePwshResult, escalationModes),
      }],
      presentationMeta: (_args, value) => value.kind === 'background' ? { background: true } : {},
    },
    /* jscpd:ignore-start -- the execute path mirrors tool-bash's by design. */
    async execute(args: PwshToolArgs, exec) {
      validatePwshArgs(args)
      // Description is display metadata; workdir defaults to the caller's session.
      const standingPolicy = resolveSandboxPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approvePwshEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec)
      // an embedder's ordinary variables (a person's secrets), read at this call
      const env = ctx.shellEnv.environment(exec)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...env === undefined ? {} : { env },
        managedEnv: ctx.shellEnv.collect(exec),
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }
      if (args.run_in_background === true) {
        // Undeclared keys are allowed, so schema omission also needs enforcement.
        if (!backgroundEnabled) {
          throw new Error(modelText('runtime/tool-pwsh-index/text-15'))
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error(modelText('runtime/tool-pwsh-index/text-16'))
        }
        // The caller owns cancellation until ctx.jobs commits detached ownership.
        if (exec.signal.aborted) {
          const error = new HarnessError(modelText('foundation/tool-pwsh-index/text-04'), TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // Task preflight finishes before the starter can spawn a process.
        const id = jobs.start({
          kind: 'pwsh',
          label: args.command,
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => processJob(
            signal => ctx.shell.start(ctx.shell.resolve({ ...request, signal })),
            proc => renderPwshProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
          ),
        })
        return { kind: 'background' as const, jobId: id }
      }
      const jobs = backgroundEnabled && args.timeoutMs === undefined ? ctx.get('jobs') : undefined
      const result = await ctx.shell.run(ctx.shell.resolve({
        ...request,
        ...jobs === undefined ? {} : { detachOnTimeout: true },
        signal: exec.signal,
      }))
      if (result.detached !== undefined && jobs !== undefined) {
        const detached = result.detached
        let id: string
        try {
          // The caller owns cancellation until the job registry accepts the handle.
          exec.signal.throwIfAborted()
          id = jobs.start({
            kind: 'pwsh',
            label: args.command,
            ...exec.agent ? { owner: exec.agent } : {},
            run: () => processJob(
              () => Promise.resolve(detached),
              proc => renderPwshProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
            ),
          })
        } catch {
          // No job could take it (nothing would collect or stop it): it ends as a timeout kill.
          detached.kill()
          await detached.done
          exec.signal.throwIfAborted()
          const { detached: _handle, ...killed } = result
          return canonicalPwshResult({ ...killed, signal: detached.signal, exitCode: detached.exitCode })
        }
        return { kind: 'background' as const, jobId: id, afterMs: result.timeoutMs, output: outputBody(result) }
      }
      if (result.aborted) {
        const error = new HarnessError(modelText('foundation/tool-pwsh-index/text-05'), TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return canonicalPwshResult(result)
    },
    /* jscpd:ignore-end */
    /* jscpd:ignore-start -- the background call card mirrors presentBashCall's by design. */
    presentCall: (args: PwshToolArgs): TerminalCallView | GenericCallView => {
      // Background acknowledgements carry no terminal exit status; the generic
      // card mirrors the bash tool's background presentation.
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
    },
    /* jscpd:ignore-end */
    /* jscpd:ignore-start -- the completed-result presentation mirrors presentBashResult's by design. */
    presentResult: (args: unknown, result: ToolResult): ToolResultView | undefined => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      const isBackground = (typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true)
        || (typeof result.meta === 'object' && result.meta !== null && !Array.isArray(result.meta) && result.meta.background === true)
      // Background acknowledgements and errors have no terminal exit status.
      if (isBackground || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: modelText('runtime/tool-pwsh-index/text-17', { value_1: String(raw.replace(/\n+$/, '')) }) }] }
      }
      // The exit marker becomes the card's exit pill, so it leaves the output body.
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
    /* jscpd:ignore-end */
  }))
}
