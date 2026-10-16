/**
 * Whether this host has a usable confinement backend (bubblewrap, the static Landlock launcher, Seatbelt or the
 * Windows ACL runner), asked the way the harness asks: the local sandbox confining a trivial argv read-only.
 *
 * Specs that need one skip where there is none, by this answer and nothing looser: production never falls back to
 * running unconfined, and a spec cannot either. `scripts/qualify-confinement.sh` runs them where the launcher is
 * built, and its receipt says how they did. Probed independently of what a spec runs, so a launch failure of the
 * thing under test cannot turn into a skip.
 */
import { Context } from "../../src/library/runtime/vendor/cordis/index.ts"
import Sandbox from "../../src/library/execution/sandbox/sandbox-local/index.ts"
import { SandboxUnavailableError } from "../../src/library/execution/sandbox/sandbox/index.ts"

export const sandboxUsable: boolean = await (async () => {
  const probe = new Context()
  try {
    await probe.plugin(Sandbox, {})
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally { await probe.fiber.dispose() }
})()
