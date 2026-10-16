/**
 * kv100 system-prompt admission through the real loop: on a continuing route a changed prompt waits for the
 * next series, and a route change takes the current prompt at once, since the new route has lost the cached
 * prefix anyway. The route-switch case is Codex's review probe on b3faff2 (harness #230), inverted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import AgentRegistry, { installModelSelection, type Agent, type ModelSelectionRef } from '../../../src/library/runtime/agents/index.ts'
import AgentLoop from '../../../src/plugins/runtime.ts'
import LlmRuntime, { createUserMessage } from '../../../src/library/model/llm/index.ts'
import { toPiContext } from '../../../src/library/model/pi-ai/context.ts'
import SessionStore, { SessionId } from '../../../src/library/session/journal/index.ts'
import SessionProjectionRegistry from '../../../src/library/session/projection/index.ts'
import SystemPrompt from '../../../src/library/context/assembly/index.ts'
import ToolRuntime from '../../../src/library/tools/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

/** A route on a kv100 connection. */
class Kv100Adapter extends MockAdapter {
  override async resolveModel(provider: string, model: string) {
    return { ...await super.resolveModel(provider, model), kv100: true as const }
  }
}

async function setup(start: 'capable' | 'plain') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  // one route reads a later system message, the other only a leading one
  const capable = new Kv100Adapter(Array.from({ length: 8 }, () => textResponse('ok')))
  capable.systemPromptUpdate = 'in-history'
  const plain = new Kv100Adapter(Array.from({ length: 8 }, () => textResponse('ok')))
  ctx.llm.registerAdapter(['capable'], capable)
  ctx.llm.registerAdapter(['plain'], plain)
  let prompt = 'prompt one'
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
    ...await next(), sections: [{ name: 'test', text: prompt, order: 0 }],
  }))
  const route = { provider: start, model: 'model' }
  const selection: ModelSelectionRef = { current: route, assembled: undefined }
  const agent = await ctx.agentLoop.create(SessionId(`kv100-admission-${start}`), route)
  installModelSelection(agent.ctx, selection)
  return { agent, capable, plain, selection, setPrompt: (text: string) => { prompt = text } }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('kv100 system-prompt admission', () => {
  it('keeps the sent prompt on a continuing leading-only route', async () => {
    const h = await setup('plain')
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    expect(h.plain.requests.map(request => toPiContext(request).systemPrompt)).toEqual(['prompt one', 'prompt one'])
  })

  it('takes the current prompt at once when the route changes', async () => {
    const h = await setup('capable')
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    // the in-history route gets the change appended after the history
    expect(h.capable.requests[1]!.messages.filter(message => message.role === 'system')).toHaveLength(2)
    h.selection.current = { provider: 'plain', model: 'other-model' }
    h.setPrompt('prompt three')
    await send(h.agent, 'third')
    const sent = h.plain.requests[0]!
    expect(sent.model).toBe('other-model')
    expect(toPiContext(sent).systemPrompt).toBe('prompt three')
  })
})
