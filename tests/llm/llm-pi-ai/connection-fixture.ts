/** Existing adapter harnesses use the same host-owned registration as the product. */
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { registerConnection } from '../../../src/plugins/router.ts'
import type { PiAiProviderProfile } from '../../../src/library/model/pi-ai/config.ts'
export type { PiAiProviderProfile } from '../../../src/library/model/pi-ai/config.ts'
export interface ConnectionProfiles { providers?: Record<string, PiAiProviderProfile> }
export async function registerProfiles(ctx: Context, config: ConnectionProfiles, apiKey: string | null | undefined = 'test-key') {
  const disposers: Array<() => void> = []
  try {
    for (const [route, profile] of Object.entries(config.providers ?? {})) {
      disposers.push(registerConnection(ctx, {
        route, profile, model: '', maxTokens: 32768, contextWindow: 262144, promptCacheTtlMs: 0,
        ...(apiKey == null ? {} : { apiKey: { resolve: async () => apiKey, recent: () => [apiKey] } }),
      }))
    }
  } catch (error) { for (const dispose of disposers) dispose(); throw error }
  return { dispose() { for (const dispose of disposers) dispose() } }
}
