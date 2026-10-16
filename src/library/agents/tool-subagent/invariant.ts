/**
 * Package-owned invariant companion for `io-agent/tool-subagent`.
 * @module io-agent/tool-subagent/invariant
 */

/* jscpd:ignore-start */
import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type { InvariantFailure, InvariantInstaller } from "../../runtime/invariants/index.ts"
import { subagentModelSelectionPolicy } from './model-selection-state.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-subagent'

/** Cordis companion plugin name. */
export const name = 'tool-subagent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Assert that model-selectable definitions are complete and reconstructable. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const schemas = ctx.tools.schemas(agent)
    const selectable = schemas.some((schema) => {
      const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties
      return properties?.['provider'] !== undefined
        && properties['model'] !== undefined
        && properties['reasoning_effort'] !== undefined
    })
    const discoverable = schemas.some(schema => schema.name === 'list_subagent_models')
    if (
      (selectable || discoverable)
      && (
        subagentModelSelectionPolicy(ctx.sessionProjections, agent.session) === undefined
        || !selectable
        || !discoverable
      )
    ) {
      fail(modelText('runtime/tool-subagent-invariant/text-01'))
    }
    return next()
  }, { global: true })
}, { inject: ['tools', 'sessionProjections'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
