/** Bind the coding policy to the resource-owning session host. */
import { AgentLoop as SessionHost, type Config } from '../library/runtime/engine.ts'
import type { Context } from '../library/runtime/vendor/cordis/index.ts'
import { ReactLoopAgent } from '../loop.ts'
export * from '../library/runtime/engine.ts'
export class AgentLoop extends SessionHost {
  constructor(ctx: Context, config: Config) {
    super(ctx, config, (owner, id, options, session) => new ReactLoopAgent(owner, id, options, session))
  }
}
export default AgentLoop
