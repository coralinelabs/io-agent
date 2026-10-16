/** Background work a host finds on disk before it opens. */
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pendingWork } from '../execution/jobs/background/records.ts'

/**
 * Whether an engine's state directory holds background work to take up now: a command recorded as
 * running (it may still run, or have ended while nothing watched it), a watcher armed, or a notice its
 * agent has not yet taken in, or a turn the last stop cut off. A host that opens lazily opens at once when this is true, so that work
 * proceeds (and its agent hears of it) without waiting for a client; and a host that may sleep
 * stays up for it.
 * @param stateDirectory - the engine's `stateDirectory`.
 * @returns true when some background work is pending.
 */
export async function pendingBackgroundWork(stateDirectory: string): Promise<boolean> {
  if (await pendingWork(join(resolve(stateDirectory), 'background'))) return true
  // A turn the last stop cut off is resumed as the host opens (Host's `active` markers).
  return readdir(join(resolve(stateDirectory), 'active')).then(ids => ids.length > 0, () => false)
}
