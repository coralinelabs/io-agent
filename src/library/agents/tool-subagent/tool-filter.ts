/** Per-call filters only narrow deployment filters; never replace them. */
import { DEFERRAL_BRIDGE_NAMES } from '../../tools/index.ts'
import type { ToolRestriction } from '../../tools/index.ts'

/**
 * Narrow the configured child filter by the model's `allowed_tools`.
 * @param configured - the deployment's child filter, if any.
 * @param requested - the model's exact tool names; omitted keeps `configured`.
 * @param onDemand - when the parent is presented the on-demand bridges, the
 * MCP tool names behind them. A bridge name in `requested` stands for all of
 * them (a bridge is presentation, not a capability): the child is then
 * presented the same tools, eagerly or behind its own bridges.
 * @returns the child restriction, never wider than `configured`.
 */
export function narrowedToolFilter(
  configured: ToolRestriction | undefined,
  requested: readonly string[] | undefined,
  onDemand?: readonly string[],
): ToolRestriction | undefined {
  if (requested === undefined) return configured
  if (requested.length > 128 || requested.some(name => !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) || new Set(requested).size !== requested.length) {
    throw new TypeError('allowed_tools must contain at most 128 unique tool names')
  }
  const names = onDemand === undefined
    ? [...requested]
    : [...new Set(requested.flatMap(name => DEFERRAL_BRIDGE_NAMES.includes(name) ? onDemand : [name]))]
  const allowed = configured?.allow === undefined ? names : names.filter(name => configured.allow!.includes(name))
  return { allow: allowed, ...(configured?.deny === undefined ? {} : { deny: [...configured.deny] }) }
}
