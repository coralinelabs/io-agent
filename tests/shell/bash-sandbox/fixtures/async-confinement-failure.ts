/** Snapshot provider whose asynchronous refusal records every attempted underlying spawn. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from "../../../../src/library/runtime/vendor/cordis/index.ts"
import { SandboxProvider, SandboxUnavailableError } from "../../../../src/library/execution/sandbox/sandbox/index.ts"
import type { ConfinedArgv, SandboxPolicy } from "../../../../src/library/execution/sandbox/sandbox/index.ts"
import LocalSubprocessRuntime from "../../../../src/library/execution/process/subprocess-local/index.ts"

export const name = 'snapshot-async-confinement-failure'

/**
 * Mount a refusing sandbox and an underlying-spawn tripwire through normal Cordis services.
 * @param ctx - scenario-owned composition context.
 */
export async function apply(ctx: Context): Promise<void> {
  let confineCalls = 0
  let spawnCalls = 0
  const audit = (): void => {
    writeFileSync(join(process.cwd(), 'confinement-audit.json'), JSON.stringify({ confineCalls, spawnCalls }) + '\n')
  }
  class GuardedSubprocess extends LocalSubprocessRuntime {
    override spawn(): never {
      spawnCalls++
      audit()
      throw new Error('unexpected subprocess allocation after confinement refusal')
    }
    override async spawnTerminal(): Promise<never> {
      spawnCalls++
      audit()
      throw new Error('unexpected terminal allocation after confinement refusal')
    }
  }
  class RefusingSandbox extends SandboxProvider {
    override async confine(_argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      await Promise.resolve()
      signal?.throwIfAborted()
      confineCalls++
      audit()
      throw new SandboxUnavailableError(policy.mode, 'fixture asynchronous confinement refused')
    }
  }
  await ctx.plugin(GuardedSubprocess)
  await ctx.plugin(RefusingSandbox)
}
