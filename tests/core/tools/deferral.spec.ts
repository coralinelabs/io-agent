/** Pure deferral planning, catalog and search, and the registry's bridges and nested dispatch. */
import { canonicalJson } from '../../../src/library/context/stable-schema.ts'
import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createScope } from "../../../src/library/runtime/scope/index.ts"
import type { Scope } from "../../../src/library/runtime/scope/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime, {
  planDeferral,
  renderDeferredCatalog,
  searchDeferredTools,
  wireSchemaBytes,
} from "../../../src/library/tools/index.ts"
import type { ToolDefinition, ToolExecutionResult } from "../../../src/library/tools/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { SessionId } from "../../../src/library/session/journal/index.ts"

const BRIDGES = ['tool_call', 'tool_describe', 'tool_search']

function marked(name: string, source = 'x', description = `tool ${name}`, execute?: ToolDefinition['execute']): ToolDefinition {
  return {
    name: `mcp__${source}__${name}`,
    description,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    deferral: { source },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: execute ?? ((args: unknown) => Promise.resolve(`ran:${name}:${(args as { text?: string }).text ?? ''}`)),
  }
}

function core(name: string): ToolDefinition {
  return {
    name, description: `core ${name}`, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

/** An agent-shaped scope key whose session reports a logged request header. */
function agentKey(name: string, headerTools?: string[]): Agent {
  return { id: name as SessionId, session: { requestHeader: () => headerTools === undefined ? undefined
    : { config: { provider: 'p', model: 'm' }, tools: headerTools.map(tool => ({ name: tool, description: '', parameters: {} })) } } } as unknown as Agent
}

async function mount(maxEagerTools = 2): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { deferral: { maxEagerTools, maxEagerSchemaBytes: 100_000 } })
  return ctx
}

async function scopeFor(ctx: Context, key: Agent): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  return scope
}

async function wireNames(ctx: Context, agent: Agent): Promise<string[]> {
  return (await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(tool => tool.name)
}

function call(ctx: Context, agent: Agent, name: string, args: unknown, signal = new AbortController().signal): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId: ToolCallId('outer'), name, arguments: args, agent, signal })
}

describe('deferral planning', () => {
  it('defers strictly above the count or byte threshold, and latches once presented', () => {
    const tools = [marked('a'), marked('b'), core('read')]
    const bytes = wireSchemaBytes(tools[0]!) + wireSchemaBytes(tools[1]!)
    expect(planDeferral(tools, { maxEagerTools: 2, maxEagerSchemaBytes: bytes }, false).presented).toBe(false)
    expect(planDeferral(tools, { maxEagerTools: 1, maxEagerSchemaBytes: bytes }, false).presented).toBe(true)
    expect(planDeferral(tools, { maxEagerTools: 2, maxEagerSchemaBytes: bytes - 1 }, false).presented).toBe(true)
    expect(planDeferral(tools, { maxEagerTools: 2, maxEagerSchemaBytes: bytes }, true).presented).toBe(true)
    // Nothing marked: nothing to defer, whatever the latch says.
    expect(planDeferral([core('read')], { maxEagerTools: 0, maxEagerSchemaBytes: 0 }, true).presented).toBe(false)
    const plan = planDeferral([marked('b'), core('read'), marked('a')], { maxEagerTools: 0, maxEagerSchemaBytes: 0 }, false)
    expect(plan.deferred.map(t => t.name)).toEqual(['mcp__x__a', 'mcp__x__b'])
    expect(plan.eager.map(t => t.name)).toEqual(['read'])
  })

  it('ranks tools matching every keyword first and deterministically', () => {
    const tools = [
      marked('issue_create', 'github', 'Create a new issue in a repository'),
      marked('issue_list', 'github', 'List issues'),
      marked('page_create', 'notion', 'Create a page'),
    ]
    expect(searchDeferredTools(tools, 'issue create').map(m => m.definition.name)).toEqual(['mcp__github__issue_create'])
    expect(searchDeferredTools(tools, 'create').map(m => m.definition.name)).toEqual(['mcp__github__issue_create', 'mcp__notion__page_create'])
    // No tool has both words: partial matches are listed instead of nothing.
    expect(searchDeferredTools(tools, 'issue delete').map(m => m.definition.name)).toEqual(['mcp__github__issue_create', 'mcp__github__issue_list'])
    expect(searchDeferredTools(tools, 'mcp__notion__page_create')[0]!.definition.name).toBe('mcp__notion__page_create')
    expect(searchDeferredTools(tools, 'weather')).toEqual([])
  })

  it('degrades the longest source to a count when the catalog is over budget', () => {
    const tools = [...Array.from({ length: 40 }, (_, i) => marked(`long_tool_${i}`, 'big')), marked('one', 'small')]
    const full = renderDeferredCatalog(tools, 100_000)
    expect(full).toContain('- big (40): mcp__big__long_tool_0, mcp__big__long_tool_1')
    const bounded = renderDeferredCatalog(tools, 400)
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(400)
    expect(bounded).toContain('- big: 40 tools')
    expect(bounded).toContain('- small (1): mcp__small__one')
    expect(renderDeferredCatalog([])).toBe('')
  })
})

describe('registry bridges', () => {
  it('presents bridges instead of marked schemas above the threshold and keeps them by latch', async () => {
    const ctx = await mount(2)
    ctx.tools.register(core('read'))
    for (const name of ['a', 'b', 'c']) ctx.tools.register(marked(name))
    const fresh = agentKey('fresh')
    expect(await wireNames(ctx, fresh)).toEqual(['read', ...BRIDGES])
    const context = (await ctx.systemPrompt.assemble({ scope: fresh, agent: fresh })).contexts.find(c => c.name === 'tools:deferred')
    expect(context?.text).toContain('- x (3): mcp__x__a, mcp__x__b, mcp__x__c')

    const small = await mount(2)
    small.tools.register(core('read'))
    small.tools.register(marked('a'))
    // At the threshold: byte-identical to no deferral, and no catalog.
    expect(await wireNames(small, fresh)).toEqual(['mcp__x__a', 'read'])
    expect((await small.systemPrompt.assemble({ scope: fresh, agent: fresh })).contexts.find(c => c.name === 'tools:deferred')?.text).toBe('')
    // A session that already presented the bridges keeps them when the count drops.
    const latched = agentKey('latched', ['read', ...BRIDGES])
    expect(await wireNames(small, latched)).toEqual(['read', ...BRIDGES])
  })

  it('applies restrictions to the underlying tools and never strips or grants the bridges', async () => {
    const ctx = await mount(1)
    ctx.tools.register(core('read'))
    for (const name of ['a', 'b', 'c']) ctx.tools.register(marked(name))
    const none = agentKey('none')
    ;(await scopeFor(ctx, none)).ctx.tools.restrict({ deny: ['mcp__x__a', 'mcp__x__b', 'mcp__x__c'] })
    expect(await wireNames(ctx, none)).toEqual(['read'])
    expect(ctx.tools.get('tool_call', none)).toBeUndefined()
    const one = agentKey('one')
    ;(await scopeFor(ctx, one)).ctx.tools.restrict({ allow: ['read', 'mcp__x__a'] })
    expect(await wireNames(ctx, one)).toEqual(['mcp__x__a', 'read'])
    const scope = await scopeFor(ctx, agentKey('bridge'))
    expect(() => scope.ctx.tools.restrict({ allow: ['read', 'tool_search'] }))
      .toThrow('"tool_search" is the on-demand MCP tool bridge, not a tool to allow or deny; name the MCP tools themselves (mcp__<server>__<tool>)')
    // Where the scope presents no bridge (no MCP tool visible), the name is simply unknown.
    const bare = await mount(1)
    bare.tools.register(core('read'))
    const bareScope = await scopeFor(bare, agentKey('bare'))
    expect(() => bareScope.ctx.tools.restrict({ allow: ['read', 'tool_search'] })).toThrow(/unknown global tool "tool_search"/)
    expect(() => ctx.tools.register(core('tool_call'))).toThrow(/reserved for the on-demand MCP tool bridge/)
  })

  it('dispatches tool_call through the full pipeline under the underlying name', async () => {
    const ctx = await mount(0)
    ctx.tools.register(core('read'))
    ctx.tools.register(marked('a'))
    const seen: { name: string; nested: boolean; callId: string }[] = []
    ctx.on('tools/pre-execute', async (exec, next) => {
      seen.push({ name: exec.name, nested: exec.parent !== undefined, callId: exec.callId })
      return exec.name === 'mcp__x__a' && (exec.arguments as { text?: string }).text === 'deny' ? { kind: 'deny', reason: 'DENIED_FIXTURE' } : next()
    })
    const agent = agentKey('agent')
    const ok = await call(ctx, agent, 'tool_call', { name: 'mcp__x__a', arguments: { text: 'hi' } })
    expect(ok).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ran:a:hi' }] })
    expect(seen).toEqual([
      { name: 'tool_call', nested: false, callId: 'outer' },
      { name: 'mcp__x__a', nested: true, callId: 'outer:deferred' },
    ])
    const denied = await call(ctx, agent, 'tool_call', { name: 'mcp__x__a', arguments: { text: 'deny' } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('DENIED_FIXTURE')
    const direct = await call(ctx, agent, 'tool_call', { name: 'read', arguments: {} })
    expect(direct.isError && direct.error.info?.code).toBe('DEFERRED_TOOL_NOT_DEFERRED')
    const unknown = await call(ctx, agent, 'tool_call', { name: 'tool_search', arguments: {} })
    expect(unknown.isError && unknown.error.info?.code).toBe('DEFERRED_TOOL_UNKNOWN')
  })

  it('preserves nested cancellation and malformed-result error codes', async () => {
    const ctx = await mount(0)
    let started!: () => void
    // A cooperative body that settles successfully once cancelled: the registry reports ABORTED.
    ctx.tools.register(marked('slow', 'x', 'slow tool', (_args, exec) => new Promise((resolve) => {
      started()
      exec.signal.addEventListener('abort', () => resolve('late'), { once: true })
    })))
    ctx.tools.register(marked('bad', 'x', 'bad tool', () => Promise.resolve(42)))
    const agent = agentKey('agent')
    const cancelled = async (name: string, args: unknown): Promise<ToolExecutionResult> => {
      const running = new Promise<void>(resolve => { started = resolve })
      const controller = new AbortController()
      const pending = call(ctx, agent, name, args, controller.signal)
      await running
      controller.abort(new Error('stop'))
      return pending
    }
    const direct = await cancelled('mcp__x__slow', { text: 't' })
    const bridged = await cancelled('tool_call', { name: 'mcp__x__slow', arguments: { text: 't' } })
    expect(direct.isError && direct.error).toEqual({ message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } })
    expect(bridged.isError && bridged.error).toEqual(direct.isError && direct.error)
    const invalid = await call(ctx, agent, 'tool_call', { name: 'mcp__x__bad', arguments: { text: 't' } })
    expect(invalid.isError && invalid.error.info).toMatchObject({ name: 'ToolOutputError', code: 'INVALID_TOOL_OUTPUT' })
    expect(JSON.stringify(invalid.content)).toContain('tool \\"mcp__x__bad\\" returned invalid output')
  })
})


describe('bounded discovery summaries', () => {
  it('bounds required-field previews without changing the full deferred schema', async () => {
    const ctx = await mount(0)
    const key = agentKey('i4-wide-schema')
    const required = Array.from({ length: 160 }, (_, index) => `field_${index}_${'属性'.repeat(20)}`)
    const definition = marked('wide')
    definition.parameters = { type: 'object', properties: Object.fromEntries(required.map(name => [name, { type: 'string' }])), required }
    ctx.tools.register(definition)
    try {
      const result = await call(ctx, key, 'tool_search', { query: 'wide' })
      expect(result.isError).toBe(false)
      const summary = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(8192)
      expect(summary).toContain('mcp__x__wide')
      expect(summary).toContain('tool_describe')
      expect(summary.isWellFormed()).toBe(true)
      const described = await call(ctx, key, 'tool_describe', { names: ['mcp__x__wide'] })
      expect(described.isError).toBe(false)
      const full = described.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(full).toContain(JSON.stringify(required))
      expect(full).toContain(JSON.stringify(canonicalJson(definition.parameters)))
    } finally { await ctx.fiber.dispose() }
  })

  it('bounds the whole result, not only each tool description', async () => {
    const ctx = await mount(0)
    const key = agentKey('i4-many-wide')
    for (let i = 0; i < 25; i += 1) {
      const definition = marked(`wide_${String(i).padStart(2, '0')}`, 'x', '🧭'.repeat(160))
      const required = Array.from({ length: 20 }, (_, index) => `field_${index}_${'参数'.repeat(20)}`)
      definition.parameters = { type: 'object', properties: Object.fromEntries(required.map(name => [name, { type: 'string' }])), required }
      ctx.tools.register(definition)
    }
    try {
      const result = await call(ctx, key, 'tool_search', { query: 'wide', limit: 25 })
      expect(result.isError).toBe(false)
      const summary = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(8192)
      expect(summary).toContain('of 25 on-demand tools')
      expect(summary.isWellFormed()).toBe(true)
      expect(summary).not.toContain('\uFFFD')
    } finally { await ctx.fiber.dispose() }
  })

  it('bounds unmatched query echo and source summaries', async () => {
    const ctx = await mount(0)
    const key = agentKey('i4-no-match')
    for (let i = 0; i < 400; i += 1) ctx.tools.register(marked('read', `source_${i}_${'a'.repeat(20)}`))
    try {
      const result = await call(ctx, key, 'tool_search', { query: '🧭'.repeat(10_000) })
      expect(result.isError).toBe(false)
      const summary = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(8192)
      expect(summary).toContain('No on-demand tool matches')
      expect(summary.isWellFormed()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
})
