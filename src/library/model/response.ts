/** Receive and durably settle one assistant attempt; never retries or executes tools. */
import type { Agent, AgentEventDispatch } from '../runtime/agents/index.ts'
import { createAssistantMessage, type GenerateOptions, type PreparedLlmCall } from './llm/index.ts'
import type { Context } from '../runtime/vendor/cordis/index.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
export class ResponseReceiver {
  private revision = 0
  private attempt = 0
  constructor(private readonly ctx: Context, private readonly agent: Agent,
    private readonly dispatch: AgentEventDispatch) {}
  async receive(request: GenerateOptions, preparedCall: PreparedLlmCall | undefined,
    turn: number, step: number, signal: AbortSignal) {
    const live = new AssistantStreamAttempt(this.agent.session.id, ++this.attempt, () => ++this.revision,
      turn, step, frame => this.dispatch.emit('agent/assistant-stream', { frame }))
    let started = false
    try {
      const stream = preparedCall?.stream(request) ?? this.ctx.llm.stream(request)
      signal.throwIfAborted()
      live.start()
      started = true
      for await (const chunk of stream) { signal.throwIfAborted(); live.push(chunk) }
      signal.throwIfAborted()
    } catch (error: unknown) {
      if (!started) throw error
      try {
        const content = signal.aborted ? live.interruptedBlocks() : []
        if (content.length > 0) {
          live.settle('assistant/message', () => this.agent.session.append('assistant/message', {
            turn, step, message: createAssistantMessage({ content, source: {
              provider: request.provider, model: request.model,
              ...live.replayState === undefined ? {} : { replayState: live.replayState },
            } }), interrupted: true, ...live.usage === undefined ? {} : { usage: live.usage }, stream: live.stream,
          }, { surfaceOp: 'append' }).seq)
        } else this.settleAttempt(live, turn, step)
      } catch (settlementError: unknown) {
        throw new AggregateError([error, settlementError], 'Assistant stream failed and its durable settlement was rejected', { cause: error })
      }
      throw error
    }
    try {
      const finish = live.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        this.settleAttempt(live, turn, step)
        return { kind: 'failure' as const, failure: finish.failure }
      }
      const message = createAssistantMessage({ content: live.blocks(), source: {
        provider: request.provider, model: request.model,
        ...live.replayState === undefined ? {} : { replayState: live.replayState },
      } })
      live.settle('assistant/message', () => this.agent.session.append('assistant/message', {
        turn, step, message, ...live.usage === undefined ? {} : { usage: live.usage }, stream: live.stream,
      }, { surfaceOp: 'append' }).seq)
      return { kind: 'response' as const, message, finish }
    } catch (error: unknown) { if (!live.ended) live.abandon(); throw error }
  }
  private settleAttempt(live: AssistantStreamAttempt, turn: number, step: number): void {
    live.settle('assistant/attempt', () => this.agent.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq)
  }
}
