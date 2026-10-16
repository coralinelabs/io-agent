/** Tool execution binds the generic scheduler to permissions and the authoritative journal. */
import { modelText } from '../context/text/index.ts'
import type { Context } from '../runtime/vendor/cordis/index.ts'
import { createToolResultMessage, type ToolCallBlock } from '../model/llm/index.ts'
import type { Session, SessionEvent, SessionSeq, UserMessage } from '../session/journal/index.ts'
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER,
  type ToolBatchResult, type ToolExecutionInput, type ToolExecutionResult, type ToolRunContext } from './index.ts'
import { runOrdered } from './scheduler.ts'

interface Call { block: ToolCallBlock; exec: ToolExecutionInput }
interface State { exec: ToolRunContext; needsPost?: boolean }
interface Outcome { result: ToolExecutionResult; needsPost: boolean }

/** Parse only syntax here; the tool registry owns schema validation and rejection. */
function parseArguments(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : {} } catch { return raw }
}

export async function executeToolCalls(
  ctx: Context, turn: number, step: number, calls: ToolCallBlock[], signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent
  const runtime = ctx.tools[TOOL_RUNTIME_SCHEDULER]
  const sequences = new Map<number, SessionSeq>()
  const items = calls.map(block => ({ block, exec: {
    callId: block.id, name: block.name, arguments: parseArguments(block.arguments), agent, signal,
  } }))
  let concluded = false
  // Model-ordered durable results, announced once the whole batch is committed.
  const committed: ToolBatchResult[] = []
  await runOrdered<Call, State, Outcome>({
    items, concurrency: ctx.agentLoop.config.maxParallelToolCalls, signal,
    mode: call => ctx.tools.executionMode(call.exec).kind,
    async prepare(call, index) {
      sequences.set(index, appendToolCall(session, turn, step, call.block))
      const prepared = await runtime.prepare(call.exec)
      if (prepared.kind === 'dispatch') return { kind: 'dispatch', state: { exec: prepared.exec } }
      return { kind: 'settled', state: { exec: prepared.exec }, result: {
        result: prepared.result, needsPost: prepared.kind === 'post-result',
      } }
    },
    async dispatch(state) {
      const result = await runtime.dispatch(state.exec)
      return { result: result.result, needsPost: result.kind === 'post-result' }
    },
    async commit(state, outcome, index) {
      const result = outcome.needsPost
        ? await runtime.finalize(state.exec, outcome.result)
        : runtime.finish(state.exec, outcome.result)
      const block = calls[index]!
      committed.push({ event: appendToolResult(session, turn, step, block, result, sequences.get(index)!), name: block.name })
      sequences.delete(index)
      for (const context of result.additionalContexts ?? []) acceptContext(context)
      concluded ||= result.concludesTurn === true
    },
    skip: call => appendSkippedToolCall(session, turn, step, call.block),
  })
  // Every result is durable and none has been sent yet: batch-level policies
  // (the spill policy's per-step budget) may still rewrite them before the
  // next request. A cancelled step announces nothing.
  if (committed.length > 0 && !signal.aborted) {
    await runtime.committed({ agent, turn, step, results: committed, signal })
  }
  return { concluded }
}

/** Append the durable call/result pair for a model call skipped after cancellation. */
function appendSkippedToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): void {
  const callSeq = appendToolCall(session, turn, step, block)
  appendToolResult(session, turn, step, block, {
    content: [{ type: 'text', text: modelText('foundation/agent-loop-tool-calls/text-01') }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }, callSeq)
}

/** Append a started call and return the event seq that its result must cite. */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): SessionSeq {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** Append a model-ordered result linked to its call event. */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: SessionSeq,
): SessionEvent<'tool/result'> {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  return session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
