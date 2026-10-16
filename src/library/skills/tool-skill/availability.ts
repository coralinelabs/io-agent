/**
 * Decide, when a session's agent is created, whether the skill tools are
 * offered. A session that starts with no skills gets no
 * `skill`/`skill_list`/`skill_read` schemas and no catalog. When a skill
 * appears later (one the agent writes itself, say), the tools join the
 * session's next request together with the loader's catalog: one
 * declared `tools` prefix break. Without a skill nothing changes.
 *
 * @module io-agent/tool-skill/availability
 */

import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type { Agent } from "../../runtime/agents/index.ts"
import { SKILL_TOOL_NAME } from './history.ts'

/** The progressive skill tools this decision covers, loader first. */
const SKILL_TOOL_NAMES = [SKILL_TOOL_NAME, 'skill_list', 'skill_read'] as const

/**
 * Whether one agent's session hides its skill tools. A session with a logged
 * request header keeps the surface that header recorded, so a resumed session
 * and a fork child seeded with its parent's history send the tools they sent
 * before. Otherwise the tools are hidden only when discovery completes and
 * finds no skill; an incomplete or failed discovery keeps them.
 */
async function hidesSkillTools(ctx: Context, agent: Agent, signal: AbortSignal | undefined): Promise<boolean> {
  const header = agent.session.requestHeader()
  if (header !== undefined) return header.tools?.some(tool => tool.name === SKILL_TOOL_NAME) !== true
  try {
    const snapshot = await ctx.skills.snapshot({ cwd: agent.session.header.cwd, ...signal === undefined ? {} : { signal }, scope: agent })
    return snapshot.complete && snapshot.skills.length === 0
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    ctx.logger.warn(`agent "${String(agent.id)}": skill discovery failed at creation, keeping the skill tools: ${String(error)}`)
    return false
  }
}

/**
 * Install after host configuration, beside question availability, so providers
 * and scoped registrations made by `configure()` are seen. Hiding restricts the
 * agent's own scope: the schemas leave its requests and a forced call is refused
 * as an unknown tool, and the loader's catalog is never published for it. The
 * restriction lifts after the first step that finds a skill.
 * @param ctx - the configured io-agent runtime, before any agent exists.
 */
export function mountSkillAvailability(ctx: Context): void {
  ctx.on('agent/created', async ({ agent, signal }) => {
    // Only globally registered tools this agent sees: a scoped registration is not ours to restrict.
    const names = SKILL_TOOL_NAMES.filter(name => ctx.tools.get(name) !== undefined && ctx.tools.get(name, agent) !== undefined)
    if (names.length === 0) return
    const hide = await hidesSkillTools(ctx, agent, signal)
    signal?.throwIfAborted()
    if (!hide) return
    const lift = agent.ctx.tools.restrict({ deny: names })
    let lifted = false
    // Checked at each step (a cached catalog read) after every other pre-step listener, the
    // skill loader included: this step's request and catalog were decided with the tools
    // hidden, so lifting now gives the next request the tools and the catalog together.
    agent.ctx.on('agent/pre-step', async ({ signal: stepSignal }, next) => {
      const decision = await next()
      if (lifted || decision.kind === 'reject') return decision
      const snapshot = await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal: stepSignal, scope: agent })
      stepSignal.throwIfAborted()
      if (snapshot.skills.length > 0) {
        lifted = true
        lift()
      }
      return decision
    }, { prepend: true })
  })
}
