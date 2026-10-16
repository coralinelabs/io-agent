import { writeFile } from 'node:fs/promises'
import { Context } from "../../../../src/library/runtime/vendor/cordis/index.ts"
import AgentLoop from "../../../../src/plugins/runtime.ts"
import { mountAgentLoopTestDependencies } from "../../../support/test-support/agent-loop-testkit/src/index.ts"
import { createUserMessage, ToolCallId, type GenerateOptions, LlmAdapter, type StreamChunk  } from "../../../../src/library/model/llm/index.ts"
import { SessionId } from "../../../../src/library/session/journal/index.ts"
import JsonlSessionPersistence from "../../../../src/library/session/persistence-jsonl/index.ts"
import * as checkpointPolicy from "../../../../src/library/session/checkpoint-policy/index.ts"

function waitForCrash(): Promise<never> {
  return new Promise(() => { setInterval(() => {}, 60_000) })
}

const [mode, root, marker] = process.argv.slice(2)
if ((mode !== 'request' && mode !== 'tool') || root === undefined || marker === undefined) {
  throw new Error('usage: crash-child.ts <request|tool> <persistence-root> <marker>')
}
const persistenceRoot = root
const failpoint = marker

class CrashAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (mode === 'request') {
      await writeFile(failpoint, 'request-dispatched')
      await waitForCrash()
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId('crash-call'), name: 'crash_tool', arguments: '{}' },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
await ctx.plugin(checkpointPolicy)
ctx.llm.registerAdapter(['crash'], new CrashAdapter())
ctx.tools.register({
  name: 'crash_tool',
  description: 'records an external effect and never returns',
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [] },
  async execute() {
    await writeFile(failpoint, 'tool-side-effect')
    return waitForCrash()
  },
})

const handle = await ctx.agents.create({
  sessionId: SessionId('semantic-checkpoint-crash'),
  agentOptions: { provider: 'crash', model: 'crash' },
})
handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'exercise the crash boundary' }], source: { kind: 'user' } }))
await waitForCrash()
