/** Hide human questions from agents without an eligible host answerer. */
import { Context } from "../runtime/vendor/cordis/index.ts"
import { agentCarrier } from "../runtime/agents/index.ts"
import { questionTool } from './tool-ask-user/index.ts'
import { awaitHostCallback } from './host-callback.ts'

/**
 * Install after host configuration so its creation listeners register scoped answerers first.
 * @param ctx The configured io-agent runtime before any agents are created.
 */
export function mountQuestionAvailability(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    // Scope carriers expose their dispatch filter at runtime through an opaque public type.
    const target = agentCarrier(agent) as unknown as { [Context.filter](context: Context): boolean }
    const hooks = ctx.events._hooks['user-questions/request'] ?? []
    // Inspect registrations without dispatching a synthetic human question.
    const hasAnswerer = hooks.some(hook => hook.global || target[Context.filter](hook.ctx))
    if (!ctx.agents.roots().includes(agent) || (!hasAnswerer && ctx.get('continuedQuestions') === undefined)) {
      agent.ctx.tools.restrict({ deny: ['ask_user_question'] })
    } else if (!hasAnswerer) {
      // This scoped definition advertises only continued mode; it cannot offer an unanswered blocking call.
      agent.ctx.tools.register(questionTool(agent.ctx, false))
    } else {
      agent.ctx.on('user-questions/request', (request, next) => awaitHostCallback(next, request.signal), { prepend: true })
    }
  })
}
