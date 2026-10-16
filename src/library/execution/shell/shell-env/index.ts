/**
 * Tool-independent shell environment plugin: owns the `ctx.shellEnv` registry of
 * trusted, per-execution `IO_AGENT_*` variables (with their `PLUTO_*` names for one release,
 * util/env-names) consumed by the model-facing shell
 * tools (`tool-bash`, `dsh-tool-pwsh`). Built-in shell facts are owned by
 * the registry itself while plugins can register additional, enumerable facts
 * with effect-scoped disposal.
 *
 * @module io-agent/shell-env
 */

import { Service, type Context } from "../../../runtime/vendor/cordis/index.ts"
import z from "../../../runtime/vendor/schemastery/index.ts"
import { MANAGED_ENV_PREFIX } from "../shell/index.ts"
import type { ManagedEnvironment, ManagedEnvironmentKey } from "../shell/index.ts"
import { resolve } from 'node:path'
import { USER_DIR_ENV } from "../../../util/home-paths/index.ts"
import type { ToolExecution } from "../../../tools/index.ts"

declare module "../../../runtime/vendor/cordis/index.ts" {
  interface Context {
    shellEnv: ShellEnvRegistry
  }
}

export const name = 'shell-env'
export const inject: string[] = []

/** Plugin config (all optional — the built-in facts resolve without defaults). */
export interface Config {
  /**
   * The user directory (user-global `AGENTS.md` and `skills/`), exposed to tool shells as
   * `IO_AGENT_USER_DIR`, the symbol model-facing paths use for it; without one it is not set.
   */
  userDirectory?: string
}

/** Runtime configuration schema for the shell-env plugin. */
export const Config: z<Config> = z.object({
  userDirectory: z.string(),
})

/**
 * An embedder's source of ordinary environment variables for every shell call (a person's secrets, say):
 * any names, read at each call, so a value that arrives mid-session is in the next command and one that is
 * removed is gone from it. Unlike contributors, these are not model-visible facts and are not enumerated.
 */
export interface ShellEnvSource {
  /** Stable source name used in diagnostics and duplicate detection. */
  name: string
  /** The variables for one tool execution. */
  resolve(execution: ToolExecution): Readonly<Record<string, string>>
}

/** Names a source may not set: what the shell, git, node, the dynamic linker and io-agent itself rely on. */
const SOURCE_RESERVED = /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TERM|LANG|TZ|TMPDIR|HOSTNAME|IFS|PS[1-4]|PROMPT_COMMAND|BASH_ENV|ENV|CDPATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|SSH_AUTH_SOCK|NO_COLOR|PAGER|GIT_PAGER|LC_\w*|LD_\w*|DYLD_\w*|GIT_\w*|BASH_FUNC_\w*|IO_\w*|PLUTO_\w*|CREANCE_\w*|(?:HTTPS?|NO|ALL)_PROXY)$/i
const SOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Model-visible metadata for one managed `IO_AGENT_*` environment variable. */
export interface BashEnvVariable {
  /** Concise description of the environment fact represented by the variable. */
  description: string
}

/**
 * A plugin contribution to the managed environment of each model shell call.
 * Declared keys make ownership conflicts detectable before the first command;
 * `resolve` computes only the values available for the current execution.
 */
export interface BashEnvContributor {
  /** Stable contributor name used in diagnostics and duplicate detection. */
  name: string
  /** Complete set of `IO_AGENT_*` keys this contributor may return. */
  variables: Readonly<Record<ManagedEnvironmentKey, BashEnvVariable>>
  /**
   * Resolve this contributor's available values for one tool execution.
   * @param execution - the shell tool execution and its optional calling agent.
   * @returns a partial map containing only keys declared in {@link variables}.
   */
  resolve(execution: ToolExecution): Readonly<Partial<Record<ManagedEnvironmentKey, string>>>
}

/** An enumerable declaration returned by {@link ShellEnvRegistry.list}. */
export interface BashEnvVariableInfo extends BashEnvVariable {
  /** Contributor that owns the variable. */
  contributor: string
  /** Declared `IO_AGENT_*` environment variable name. */
  key: ManagedEnvironmentKey
}

const SHELL_KEY = `${MANAGED_ENV_PREFIX}SHELL` as const
const SESSION_ID_KEY = `${MANAGED_ENV_PREFIX}SESSION_ID` as const
const RESERVED_BASH_ENV_KEYS = new Set<ManagedEnvironmentKey>([
  USER_DIR_ENV,
  SHELL_KEY,
  SESSION_ID_KEY,
])
const BASH_ENV_KEY_SUFFIX = /^[A-Z][A-Z0-9_]*$/

/**
 * Registry (`ctx.shellEnv`) for trusted, per-execution `IO_AGENT_*` variables.
 * The namespace is rebuilt for every model shell call: ambient `IO_AGENT_*` values
 * are discarded by the executor, then the registry's current snapshot is
 * injected. Built-in shell facts remain owned by the registry itself while
 * plugins can register additional, enumerable facts with effect-scoped
 * disposal.
 */
export class ShellEnvRegistry extends Service {
  private readonly contributors = new Map<string, BashEnvContributor>()
  private readonly sources = new Map<string, ShellEnvSource>()
  private readonly keyOwners = new Map<ManagedEnvironmentKey, string>()
  private readonly userDirectory: string | undefined

  /**
   * Create and install the `ctx.shellEnv` service.
   * @param ctx - Cordis context that owns the service and registrations.
   * @param config - user-directory configuration for the built-in variables.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'shellEnv')
    this.userDirectory = config.userDirectory === undefined ? undefined : resolve(config.userDirectory)
  }

  /**
   * Register one environment contributor. Names and keys are unique; built-in
   * keys are reserved. Registration is disposed with the calling plugin fiber.
   * @param contributor - declared key ownership and per-execution resolver.
   * @returns the disposer that unregisters the contribution.
   */
  register(contributor: BashEnvContributor): () => void {
    const dispose = this.ctx.effect(function* (this: ShellEnvRegistry) {
      if (contributor.name.trim().length === 0) {
        throw new Error('bash env contributor name must be non-empty')
      }
      if (this.contributors.has(contributor.name)) {
        throw new Error(`bash env contributor "${contributor.name}" is already registered`)
      }

      const variables = Object.entries(contributor.variables) as [ManagedEnvironmentKey, BashEnvVariable][]
      for (const [key, variable] of variables) {
        if (!key.startsWith(MANAGED_ENV_PREFIX)
          || !BASH_ENV_KEY_SUFFIX.test(key.slice(MANAGED_ENV_PREFIX.length))) {
          throw new Error(`bash env contributor "${contributor.name}" declared invalid key "${key}"`)
        }
        if (RESERVED_BASH_ENV_KEYS.has(key)) {
          throw new Error(`bash env contributor "${contributor.name}" cannot own reserved key "${key}"`)
        }
        if (variable.description.trim().length === 0) {
          throw new Error(`bash env contributor "${contributor.name}" must describe "${key}"`)
        }
        const owner = this.keyOwners.get(key)
        if (owner !== undefined) {
          throw new Error(`bash env key "${key}" is already owned by contributor "${owner}"; contributor "${contributor.name}" cannot also own it`)
        }
      }

      this.contributors.set(contributor.name, contributor)
      for (const [key] of variables) this.keyOwners.set(key, contributor.name)
      yield () => {
        this.contributors.delete(contributor.name)
        for (const [key] of variables) this.keyOwners.delete(key)
      }
    }.bind(this), 'bashEnv.register()')
    return () => void dispose()
  }

  /**
   * Register a source of ordinary variables for every shell call, disposed with the calling plugin fiber.
   * @param source - its name and a per-execution resolver.
   * @returns the disposer that unregisters it.
   */
  provide(source: ShellEnvSource): () => void {
    const dispose = this.ctx.effect(function* (this: ShellEnvRegistry) {
      if (source.name.trim().length === 0) throw new Error('shell env source name must be non-empty')
      if (this.sources.has(source.name)) throw new Error(`shell env source "${source.name}" is already registered`)
      this.sources.set(source.name, source)
      yield () => { this.sources.delete(source.name) }
    }.bind(this), 'shellEnv.provide()')
    return () => void dispose()
  }

  /**
   * The ordinary variables every registered source gives one shell call, read now. A name a source may not
   * set, or a value no process could carry, is left out rather than failing the command.
   * @param execution - the current tool execution.
   * @returns the variables, or undefined when no source gives any.
   */
  environment(execution: ToolExecution): Record<string, string> | undefined {
    let env: Record<string, string> | undefined
    for (const source of [...this.sources.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      for (const [key, value] of Object.entries(source.resolve(execution))) {
        if (!SOURCE_NAME.test(key) || SOURCE_RESERVED.test(key) || key.startsWith(MANAGED_ENV_PREFIX)) continue
        if (typeof value !== 'string' || value.includes('\0')) continue
        ;(env ??= {})[key] = value
      }
    }
    return env
  }

  /**
   * Build the trusted `IO_AGENT_*` snapshot for one shell tool execution.
   * @param execution - the current tool execution.
   * @returns an immutable environment overlay containing built-ins and current contributions.
   */
  collect(execution: ToolExecution): ManagedEnvironment {
    const values: Record<ManagedEnvironmentKey, string> = {
      ...this.userDirectory === undefined ? {} : { [USER_DIR_ENV]: this.userDirectory },
      [SHELL_KEY]: '1',
    }
    if (execution.agent !== undefined) {
      values[SESSION_ID_KEY] = execution.agent.session.header.id
    }

    for (const contributor of [...this.contributors.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      const resolved = contributor.resolve(execution)
      for (const [rawKey, value] of Object.entries(resolved)) {
        const key = rawKey as ManagedEnvironmentKey
        if (!Object.hasOwn(contributor.variables, key)) {
          throw new Error(`bash env contributor "${contributor.name}" returned undeclared key "${key}"`)
        }
        if (typeof value !== 'string') {
          throw new Error(`bash env contributor "${contributor.name}" returned a non-string value for "${key}"`)
        }
        values[key] = value
      }
    }

    return Object.freeze(Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))))
  }

  /**
   * Enumerate every variable a shell call can receive, the registry's own
   * built-ins (owned by `shell-env`) included, without executing resolvers.
   * @returns declarations sorted by environment variable name.
   */
  list(): BashEnvVariableInfo[] {
    const builtIns: BashEnvVariableInfo[] = [
      ...this.userDirectory === undefined ? [] : [{
        contributor: name, key: USER_DIR_ENV as ManagedEnvironmentKey, description: 'User directory holding the user-global AGENTS.md and skills.',
      }],
      { contributor: name, key: SHELL_KEY as ManagedEnvironmentKey, description: 'Set to 1 in every shell a tool starts.' },
      { contributor: name, key: SESSION_ID_KEY as ManagedEnvironmentKey, description: 'Id of the session whose tool started the shell, when a session did.' },
    ]
    return [...builtIns, ...[...this.contributors.values()]
      .flatMap(contributor => Object.entries(contributor.variables).map(([key, variable]) => ({
        contributor: contributor.name,
        description: variable.description,
        key: key as ManagedEnvironmentKey,
      })))]
      .sort((left, right) => left.key.localeCompare(right.key))
  }
}

/**
 * Load the shell-env plugin: register the `ctx.shellEnv` registry service.
 * @param ctx - Cordis context that owns the service and registrations.
 * @param config - home-directory configuration for the built-in variables.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new ShellEnvRegistry(ctx, config)
}
