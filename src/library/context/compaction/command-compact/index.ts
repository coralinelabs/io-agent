/**
 * Human-facing `/compact` command over the backend-independent compaction seam.
 * @module io-agent/command-compact
 */

import { modelText } from "../../text/index.ts"
import type { Context } from "../../../runtime/vendor/cordis/index.ts"
import { CommandDefinitionId } from "../../../interaction/commands/brand.ts"
import { ManualCompactionError } from "../compaction/index.ts"
import type { CommandInvocation, CommandResult } from "../../../interaction/commands/index.ts"

export const name = 'command-compact'
export const inject = ['commands', 'compaction']

const USAGE = 'Usage: /compact (no arguments)'

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: modelText('foundation/command-compact-index/text-01'),
      }
    case 'cancelled':
      return { kind: 'error', text: modelText('foundation/command-compact-index/text-02') }
    case 'changed':
      return {
        kind: 'error',
        text: modelText('foundation/command-compact-index/text-03'),
      }
    case 'summary':
      return {
        kind: 'error',
        text: modelText('foundation/command-compact-index/text-04'),
      }
    case 'commit':
      return {
        kind: 'error',
        text: modelText('foundation/command-compact-index/text-05'),
      }
    case 'persistence':
      return {
        kind: 'error',
        text: modelText('foundation/command-compact-index/text-06'),
      }
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/** Execute one argument-free manual compaction request. */
async function executeCompact(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: modelText('foundation/command-compact-index/text-07') }
    return {
      kind: 'success',
      text: modelText('foundation/command-compact-index/text-08', { value_1: String(result.shadowedSeqs.length), value_2: String(result.shadowedTokenCount) }),
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: modelText('foundation/command-compact-index/text-09') }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/compact` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'),
      name: 'compact',
      description: modelText('foundation/command-compact-index/text-10'),
      handler,
    })
  }, 'command-compact lifecycle')
}
