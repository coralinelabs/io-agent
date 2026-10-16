/** One fixed host-owned endpoint; no provider directory, login flows, or credential files. */
import type { Context } from '../library/runtime/vendor/cordis/index.ts'
import { AGENT_ROUTES, type ResolvedConnection } from '../library/model/connection.ts'
import { PiAiAdapter } from '../library/model/pi-ai/adapter.ts'
import { resolveProfiles } from '../library/model/pi-ai/config.ts'
import { LlmError, resolveImageAttachmentAccess } from '../library/model/llm/index.ts'
import { withholdFromChildren } from '../library/execution/process/subprocess/index.ts'
import { modelText } from '../library/context/text/index.ts'
import type {} from '../library/filesystem/fs/index.ts'

export const name = 'io-agent-router'
export const inject = ['llm']

export function apply(ctx: Context, connection: ResolvedConnection): void {
  registerConnection(ctx, connection)
}

/** Register one immutable host-selected connection; other sessions keep their adapters. */
export function registerConnection(ctx: Context, connection: ResolvedConnection, replayRoutes: readonly string[] = AGENT_ROUTES): () => void {
  // Detach once: neither the host nor a later settings mutation may redirect an
  // in-flight request. Endpoint replacement is a new runtime, not a login event.
  const profiles = resolveProfiles({ [connection.route]: structuredClone(connection.profile) })
  const key = connection.apiKey
  let plainFallbackReported = false
  // The key never enters a child environment, even when the host process inherited it.
  const releaseKey = key === undefined ? undefined : ctx.effect(() => withholdFromChildren(() => key.recent()), 'model key scrub')
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    // Always supply an override, including anonymous endpoints: undefined
    // would re-enable the SDK's unrelated ambient-provider discovery.
    resolveApiKey: () => key === undefined ? Promise.resolve('EMPTY') : key.resolve(),
    auth: {
      // This transport has no provider-native auth flow. Keep that boundary
      // explicit even if an SDK operation attempts an ambient/store lookup.
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async delete() {},
        async modify() { throw new LlmError(modelText('runtime/router/no-login'), 'MISSING_CREDENTIAL') },
      },
      authContext: { async env() { return undefined }, async fileExists() { return false } },
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref,
    ),
    onReplayDegrade: detail => ctx.logger.warn('Model history replay degraded to neutral content', detail),
    onPlainReasoningFallback: (detail) => {
      if (plainFallbackReported) return
      plainFallbackReported = true
      ctx.logger.warn("The endpoint returns readable reasoning without encrypted content; it is replayed as text. Set reasoningReplay: 'plain' for it.", detail)
    },
    // A session resumed on the other protocol keeps its history's replay
    // state, so sealed reasoning is dropped with the warning above rather
    // than stripped silently as another adapter's history.
    replayRoutes,
  })
  const unregister = ctx.llm.registerAdapter([connection.route], adapter)
  return () => { unregister(); void releaseKey?.() }
}
