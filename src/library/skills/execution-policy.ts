/** Skill execution is a declared capability, not an instruction hidden in prose.
 * Claude-rewrite fork semantics: fresh context, optionally narrower tools, same router.
 * No skill-selected model/provider and no automatic shell preprocessing.
 */
export interface SkillExecutionPolicy {
  readonly context: 'inline' | 'fork'
  readonly allowedTools?: readonly string[]
  readonly argumentNames?: readonly string[]
}

/** Offer-time tool conditions (Hermes `requires_tools`/`fallback_for_tools` semantics).
 * They decide whether catalogs and skill_list offer a skill to an agent, evaluated against
 * that agent's resolved tool view. They are not an authorization boundary: the loader by
 * exact name, `/name` invocation and skill_read are unaffected; allowed-tools narrows forks.
 */
export interface SkillToolConditions {
  /** Offer only when every named tool resolves for the calling agent. */
  readonly requiresTools?: readonly string[]
  /** Offer only when none of the named tools resolves for the calling agent. */
  readonly fallbackForTools?: readonly string[]
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/

function list(value: unknown, field: string, pattern: RegExp): string[] | undefined {
  if (value === undefined) return undefined
  const items = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value
  if (!Array.isArray(items) || items.length > 128 || items.some(v => typeof v !== 'string' || !pattern.test(v))) {
    throw new TypeError(`invalid skill ${field}`)
  }
  if (new Set(items).size !== items.length) throw new TypeError(`duplicate skill ${field}`)
  return items
}

/** Called for discovery and activation; malformed policies never degrade to broader ones. */
export function skillExecutionPolicy(data: Record<string, unknown>): SkillExecutionPolicy | undefined {
  if (data.context === undefined && data['allowed-tools'] === undefined && data.arguments === undefined) return undefined
  const context = data.context ?? 'inline'
  if (context !== 'inline' && context !== 'fork') throw new TypeError('skill context must be inline or fork')
  const allowedTools = list(data['allowed-tools'], 'allowed-tools', TOOL_NAME)
  const argumentNames = list(data.arguments, 'arguments', /^[A-Za-z][A-Za-z0-9_]*$/)
  if (argumentNames && (argumentNames.some(n => n.toUpperCase() === 'ARGUMENTS')
    || new Set(argumentNames.map(n => n.toUpperCase())).size !== argumentNames.length)) {
    throw new TypeError('skill argument names collide')
  }
  if (allowedTools !== undefined && context !== 'fork') {
    throw new TypeError('allowed-tools requires context: fork; inline instructions cannot change tool permissions')
  }
  return Object.freeze({ context,
    ...(allowedTools === undefined ? {} : { allowedTools: Object.freeze(allowedTools) }),
    ...(argumentNames === undefined ? {} : { argumentNames: Object.freeze(argumentNames) }) })
}

export function validateSkillExecution(value: SkillExecutionPolicy | undefined): void {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || (value.context !== 'inline' && value.context !== 'fork')) throw new TypeError('invalid skill execution policy')
  skillExecutionPolicy({ context: value.context, 'allowed-tools': value.allowedTools, arguments: value.argumentNames })
}

/**
 * Read `requires-tools` and `fallback-for-tools` frontmatter (a string or a list, the
 * allowed-tools grammar). Empty lists are omitted; a name in both lists is contradictory
 * and rejected, so a malformed condition never degrades to broader visibility.
 */
export function skillToolConditions(data: Record<string, unknown>): SkillToolConditions | undefined {
  const requiresTools = list(data['requires-tools'], 'requires-tools', TOOL_NAME)
  const fallbackForTools = list(data['fallback-for-tools'], 'fallback-for-tools', TOOL_NAME)
  if (requiresTools !== undefined && fallbackForTools?.some(name => requiresTools.includes(name)) === true) {
    throw new TypeError('a skill tool cannot be both required and a fallback target')
  }
  if (!requiresTools?.length && !fallbackForTools?.length) return undefined
  return Object.freeze({
    ...(requiresTools?.length ? { requiresTools: Object.freeze(requiresTools) } : {}),
    ...(fallbackForTools?.length ? { fallbackForTools: Object.freeze(fallbackForTools) } : {}),
  })
}

export function validateSkillToolConditions(value: SkillToolConditions | undefined): void {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'requiresTools' && key !== 'fallbackForTools')
    || [value.requiresTools, value.fallbackForTools].some(names => names !== undefined && !Array.isArray(names))) {
    throw new TypeError('invalid skill tool conditions')
  }
  skillToolConditions({ 'requires-tools': value.requiresTools, 'fallback-for-tools': value.fallbackForTools })
}
