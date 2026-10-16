/**
 * Configuration normalization for workspace instruction discovery and rendering.
 *
 * @module io-agent/agent-instructions/config
 */

import { relative, resolve } from 'node:path'
import z from "../../runtime/vendor/schemastery/index.ts"
import { DEFAULT_TOUCH_EXCLUDED_DIRECTORIES } from './touch.ts'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
const DEFAULT_MAX_TOTAL_SOURCE_BYTES = 4 * DEFAULT_MAX_SOURCE_BYTES
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Refuse write/edit until newly discovered instructions enter a model step. */
  requireBeforeWrite?: boolean
  /** Directory holding the user-global `AGENTS.md`; without one there is no user-global instruction. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** UTF-8 byte cap for one rendered baseline or dynamic batch; non-positive or non-finite disables loading. */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /**
   * Maximum UTF-8 bytes read across one baseline or reconciliation batch. The
   * most specific files read first; a file that no longer fits is left unread
   * (a baseline names it in its budget notice).
   */
  maxTotalSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   */
  localInstructionFileCandidates?: string[]
  /**
   * Directory names (dependency, cache, build and VCS trees) at which a `bash`,
   * `grep` or `glob` touch stops disclosing nested instructions; `read`, `write`
   * and `edit` touches are not filtered.
   */
  touchExcludedDirectories?: string[]
}

export const Config: z<Config> = z.object({
  requireBeforeWrite: z.boolean().default(false),
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  maxTotalSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_TOTAL_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
  touchExcludedDirectories: z.array(z.string()).default([...DEFAULT_TOUCH_EXCLUDED_DIRECTORIES]),
})

/** Normalized instruction discovery configuration. */
export interface ResolvedDiscoveryConfig {
  /** Absolute user-global instruction directory, when one is configured. */
  dshHome?: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
  localInstructionFileCandidates: string[]
}

/** Normalized configuration used by discovery and reconciliation. */
export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  maxBytes: number
  maxSourceBytes: number
  /**
   * Batch read bound; not part of {@link workspaceBaselineIdentity}, so a resumed
   * session keeps its visible baseline when only this bound changed.
   */
  maxTotalSourceBytes: number
  /** Touch-only filter; deliberately not part of {@link workspaceBaselineIdentity}. */
  touchExcludedDirectories: ReadonlySet<string>
}

/**
 * Identify the discovery, precedence, and budget semantics of one baseline.
 * @param config - normalized plugin configuration.
 * @param cwd - absolute session working directory.
 * @param projectRoot - project root selected for the current baseline.
 * @returns stable serialized identity for compatibility checks on resume.
 */
export function workspaceBaselineIdentity(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
): string {
  return JSON.stringify({
    projectRoot: relative(cwd, projectRoot),
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
  })
}

/**
 * Resolve defaults, the configured home, and valid same-directory candidates.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig(config),
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    maxTotalSourceBytes: config.maxTotalSourceBytes ?? DEFAULT_MAX_TOTAL_SOURCE_BYTES,
    touchExcludedDirectories: new Set(config.touchExcludedDirectories ?? DEFAULT_TOUCH_EXCLUDED_DIRECTORIES),
  }
}

/**
 * Resolve the subset of configuration used before instruction content is rendered.
 * @param config - optional discovery controls.
 * @returns normalized home, root markers, and instruction candidates.
 */
export function resolveDiscoveryConfig(
  config: Pick<Config, 'dshHome' | 'projectRootMarkers' | 'instructionFileCandidates' | 'localInstructionFileCandidates'>,
): ResolvedDiscoveryConfig {
  return {
    ...config.dshHome === undefined ? {} : { dshHome: resolve(config.dshHome) },
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates: resolveInstructionFileCandidates(
      config.instructionFileCandidates,
      DEFAULT_INSTRUCTION_FILE_CANDIDATES,
    ),
    localInstructionFileCandidates: resolveInstructionFileCandidates(
      config.localInstructionFileCandidates,
      DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
    ),
  }
}

function resolveInstructionFileCandidates(candidates: string[] | undefined, fallback: readonly string[]): string[] {
  return (candidates ?? [...fallback]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
