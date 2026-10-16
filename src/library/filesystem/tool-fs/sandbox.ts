/**
 * The sandbox-escalation API shared by the `write` and `edit` tools: the
 * per-call policy resolution, the advertised escalation fields, and the denial-marker
 * mapping — all delegating the vocabulary and the fail-closed approval
 * sequence to `io-agent/sandbox` (the same pieces `io-agent/tool-bash`
 * uses), so bash and fs escalate identically. Built ONCE per plugin from
 * `ctx.fs.sandboxMode` (the capability fact — is a confining backend mounted?)
 * and shared by both mutating tools.
 *
 * @module io-agent/tool-fs/sandbox
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type { ToolExecution } from "../../tools/index.ts"
import type { SandboxExecutionPolicy, SandboxMode } from "../../execution/sandbox/sandbox/index.ts"
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "../../execution/sandbox/sandbox/index.ts"
import type { SandboxPolicyService } from "../../execution/sandbox/sandbox-policy/index.ts"
import { FsError } from "../fs/index.ts"

/** The two escalation arguments a mutating tool may carry (advertised only under a confining backend). */
export interface FsEscalationArgs {
  sandbox_permissions?: string
  justification?: string
}

/** The schema fields for the escalation arguments, spread into a tool's `parameters` when a confining backend is mounted. */
export interface EscalationSchemaFields {
  sandbox_permissions: { type: 'string'; enum: string[]; description: string }
  justification: { type: 'string'; description: string }
}

/**
 * The filesystem escalation API: advertisement gating, per-call policy
 * resolution, the one-approved wider retry, and denial-marker mapping. A pure
 * product of `ctx` at plugin apply time.
 */
export class FsSandboxController {
  /**
   * The escalation targets this composition advertises: `[]` when no confining
   * backend is mounted or the deployment turned escalation off (its approval can
   * never grant one).
   */
  readonly escalationModes: readonly SandboxMode[]
  /** Shared per-session policy resolver, required by a confining backend. */
  private readonly policy: SandboxPolicyService | undefined

  /**
   * @param ctx - the tool plugin context; `ctx.fs.sandboxMode` says whether a confining backend is mounted.
   * @param escalation - whether to advertise escalation at all (the tool-fs `escalation` config).
   */
  constructor(private readonly ctx: Context, escalation = true) {
    const defaultMode = ctx.fs.sandboxMode
    this.escalationModes = defaultMode === undefined || !escalation ? [] : ESCALATION_TARGETS
    this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (defaultMode !== undefined && this.policy === undefined) {
      throw new Error(modelText('foundation/tool-fs-sandbox/text-01'))
    }
  }

  /**
   * The escalation schema fields for a mutating tool's `parameters`. Call it
   * only under a confining backend (guard on {@link escalationModes}); the
   * enum pins the closed target vocabulary, the strict-wider check happens per
   * call at execution.
   * @returns the two escalation parameter specs.
   */
  schemaFields(): EscalationSchemaFields {
    return {
      sandbox_permissions: {
        type: 'string',
        enum: [...this.escalationModes],
        description: modelText('foundation/tool-fs-sandbox/text-02'),
      },
      justification: {
        type: 'string',
        description: modelText('foundation/tool-fs-sandbox/text-03'),
      },
    }
  }

  /**
   * The policy to stamp onto this mutation: an approved escalation grant (a
   * strictly wider retry resolved through `ctx.approval` before anything
   * executes), else the session's standing mode. Repeating the standing mode
   * requires no approval. The calling session's cwd is
   * always carried as the workspace root. Validates the escalation argument
   * pairing first.
   * @param toolName - the mutating tool's name, for the approval audit trail.
   * @param args - the call's escalation arguments.
   * @param exec - the tool-execution context (agent, callId, signal).
   * @returns the policy to pass to the mutation, or undefined for an
   *   unsandboxed backend.
   */
  async resolvePolicy(toolName: string, args: FsEscalationArgs, exec: ToolExecution): Promise<SandboxExecutionPolicy | undefined> {
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
    if (args.sandbox_permissions === undefined || args.justification === undefined) {
      return standingPolicy
    }
    if (this.escalationModes.length === 0) {
      throw new Error(this.policy === undefined ? modelText('foundation/tool-fs-sandbox/text-04') : modelText('tools/escalation-disabled'))
    }
    const policy = standingPolicy as SandboxExecutionPolicy
    const approvedMode = await approveEscalation(
      { requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode: policy.mode, subject: 'operation' },
      {
        approver: this.ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName,
        signal: exec.signal,
      },
    )
    return { ...policy, mode: approvedMode }
  }

  /**
   * Map a thrown provider error for the model: a `FS_SANDBOX_DENIED` becomes a
   * `FsError` whose text is the shared `[sandbox: …]` denial marker plus, when
   * this composition advertises escalation, the same-turn escalation hint, so
   * a policy denial reads identically to bash's WHILE keeping the structured
   * `FS_SANDBOX_DENIED` code — `ToolRuntime` populates `result.error` only for
   * `HarnessError` instances, so a plain `Error` would strip the code
   * retry/observers key off. Any other error passes through unchanged.
   * @param error - the error thrown by the mutation.
   * @param policy - the policy stamped onto the call (names the mode in the marker).
   * @returns the error to throw — the marker `FsError` for a sandbox denial, else the original.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    // A FS_SANDBOX_DENIED only arises under a confining backend, whose tool
    // path always resolves a policy before mutation.
    const mode = (policy as SandboxExecutionPolicy).mode
    if (this.escalationModes.length === 0) return new FsError(sandboxDenialMarker(mode), 'FS_SANDBOX_DENIED', { cause: error })
    return new FsError(modelText('foundation/tool-fs-sandbox/text-05', { value_1: String(sandboxDenialMarker(mode)), value_2: String(escalationHintMarker('operation')) }), 'FS_SANDBOX_DENIED', { cause: error })
  }
}
