/** Home directory for the test-support packages that keep dsh's one-home layout. */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The configured home, or a per-process temporary one: never the user's home
 * directory and never an environment variable, like the product code.
 * @param configured - an explicit home, when the caller has one.
 * @returns the absolute home directory.
 */
export function testSupportHome(configured?: string): string {
  return resolve(configured ?? join(tmpdir(), `io-agent-test-home-${process.pid}`))
}
