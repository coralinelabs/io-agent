/** Snapshot provider that awaits cancellation and records any premature process allocation. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from "../../../../src/library/runtime/vendor/cordis/index.ts"
import { SandboxProvider } from "../../../../src/library/execution/sandbox/sandbox/index.ts"
import type { ConfinedArgv, SandboxPolicy } from "../../../../src/library/execution/sandbox/sandbox/index.ts"
import LocalSubprocessRuntime from "../../../../src/library/execution/process/subprocess-local/index.ts"

export const name = 'snapshot-pending-confinement'

/**
 * Mount pending confinement and a process-allocation tripwire through normal services.
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
      throw new Error('unexpected process allocation after preparation timeout')
    }
  }
  class PendingSandbox extends SandboxProvider {
    override async confine(_argv: readonly string[], _policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      if (signal === undefined) throw new Error('foreground confinement requires a deadline signal')
      signal.throwIfAborted()
      confineCalls++
      audit()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('fixture preparation aborted')) }, { once: true })
      })
    }
  }
  await ctx.plugin(GuardedSubprocess)
  await ctx.plugin(PendingSandbox)
}
