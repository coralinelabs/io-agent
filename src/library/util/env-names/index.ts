/**
 * The harness's environment names, `IO_AGENT_*`, and the `PLUTO_*` names they replace, which
 * are read for one release after the rename to io-agent. The rules are the whole Io rename's:
 *
 * - a new name wins by presence: set at all, even to the empty string, it is the value, and an
 *   old name beside it is not read;
 * - an old name is read only in the new one's absence, and that is reported once per name, by
 *   name and never with its value (a Node `DeprecationWarning`);
 * - so an empty new value never brings an old one back;
 * - names that choose one thing together are a family: when any member is present under its new
 *   name, no member is read under an old one, so a half-renamed environment cannot mix sources.
 *
 * Children see both generations of the managed facts for the same release
 * ({@link withLegacyAliases}): a command, skill or `AGENTS.md` written against `$PLUTO_USER_DIR`
 * keeps working, while the model is told of the `IO_AGENT_*` names only. Both prefixes are the
 * harness's own namespace and never pass from the ambient environment to a child
 * ({@link isManagedEnvName}).
 * @module io-agent/env-names
 */

/** The harness's environment namespace. */
export const ENV_PREFIX = 'IO_AGENT_' as const
/** The namespace's name before io-agent, read for one release. */
export const LEGACY_ENV_PREFIX = 'PLUTO_' as const

/** A name in the harness's namespace. */
export type EnvName = `${typeof ENV_PREFIX}${string}`

/** An environment to read from: `process.env`, or any map of names to values. */
export type EnvSource = Readonly<Record<string, string | undefined>>

/** How an old name that was read is reported: its name and the one that replaces it, never a value. */
export type LegacyWarning = (legacy: string, name: EnvName) => void

/** Options for {@link readEnv}. */
export interface ReadEnvOptions {
  /** The names that choose one thing together with `name` (`name` itself may be among them). */
  family?: readonly EnvName[]
  /** Who hears of an old name read; by default a `DeprecationWarning`, once per name per process. */
  warn?: LegacyWarning
}

const warned = new Set<string>()

/**
 * The default report: one `DeprecationWarning` per old name per process.
 * @param legacy - the old name that was read.
 * @param name - the name that replaces it.
 */
export function warnOnce(legacy: string, name: EnvName): void {
  if (warned.has(legacy)) return
  warned.add(legacy)
  process.emitWarning(`${legacy} is deprecated; use ${name}`, { type: 'DeprecationWarning', code: 'IO_AGENT_LEGACY_ENV' })
}

/**
 * The name a setting had before io-agent.
 * @param name - a name in the harness's namespace.
 * @returns the same name under {@link LEGACY_ENV_PREFIX}.
 */
export function legacyEnvName(name: EnvName): string {
  if (!name.startsWith(ENV_PREFIX)) throw new Error(`${name} is not an ${ENV_PREFIX}* name`)
  return LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length)
}

/**
 * Whether a name is in the harness's namespace under either generation, compared
 * case-insensitively (Windows environment names are case-insensitive, so a parent's
 * `io_agent_*` or `pluto_*` would otherwise read back as a managed fact in the child).
 * @param key - an environment variable name.
 * @returns true for `IO_AGENT_*` and `PLUTO_*`, in any case.
 */
export function isManagedEnvName(key: string): boolean {
  const upper = key.toUpperCase()
  return upper.startsWith(ENV_PREFIX) || upper.startsWith(LEGACY_ENV_PREFIX)
}

function present(env: EnvSource, name: string): boolean {
  return Object.hasOwn(env, name) && env[name] !== undefined
}

/**
 * Read one setting under the rules above.
 * @param env - the environment to read.
 * @param name - the setting's name in the harness's namespace.
 * @param options - its family, and who hears of an old name read.
 * @returns the value (possibly empty), or undefined when neither name gives it.
 */
export function readEnv(env: EnvSource, name: EnvName, options: ReadEnvOptions = {}): string | undefined {
  if (present(env, name)) return env[name]
  if ((options.family ?? []).some(member => present(env, member))) return undefined
  const legacy = legacyEnvName(name)
  if (!present(env, legacy)) return undefined
  ;(options.warn ?? warnOnce)(legacy, name)
  return env[legacy]
}

/**
 * Read a private launch marker under the rules above and delete it under both names, so neither
 * reaches code that runs after it.
 * @param env - the mutable environment holding the marker.
 * @param name - the marker's name.
 * @returns the marker's value, or undefined when it is not set.
 */
export function takeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>, name: EnvName): string | undefined {
  const value = readEnv(env, name)
  Reflect.deleteProperty(env, name)
  Reflect.deleteProperty(env, legacyEnvName(name))
  return value
}

/**
 * The managed facts a child receives: each `IO_AGENT_*` fact, and the same value under its
 * `PLUTO_*` name for one release.
 * @param managed - the trusted `IO_AGENT_*` facts for one execution.
 * @returns both generations, the new names first.
 */
export function withLegacyAliases(managed: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (managed === undefined) return {}
  const aliases: Record<string, string> = {}
  for (const [key, value] of Object.entries(managed)) {
    if (key.startsWith(ENV_PREFIX)) aliases[legacyEnvName(key as EnvName)] = value
  }
  return { ...managed, ...aliases }
}
