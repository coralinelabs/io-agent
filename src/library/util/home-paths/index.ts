/**
 * Shared filesystem path helpers for the harness's state and user directories.
 * There is no default home: every directory is the host's explicit choice, and
 * no environment variable or OS home directory stands in for one.
 *
 * @module io-agent/home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Name of the variable that carries the configured user directory (user-global
 * `AGENTS.md` and `skills/`) to tool shells, and the symbol model-facing paths
 * use for it. The harness sets it for its children; it never reads it.
 */
export const USER_DIR_ENV = 'IO_AGENT_USER_DIR'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}
