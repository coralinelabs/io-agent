import { describe, expect, it, vi } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import SystemPrompt from '../../../src/library/context/assembly/index.ts'
import ToolRuntime, { defineTool } from '../../../src/library/tools/index.ts'
import { ToolCallId } from '../../../src/library/model/llm/index.ts'

async function setup() { const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); return ctx }
const signal = new AbortController().signal
const request = { name: 'test', callId: ToolCallId('test-call'), arguments: {}, signal }
const makeTool = (execute = vi.fn(async () => 'original')) => defineTool({
  name: 'test', description: 'binding fixture', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute,
})
function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r }), open: () => release() } }

describe('registration-bound invocation', () => {
  it('does not run a replacement registered during asynchronous policy; the next call uses it', async () => {
    const ctx = await setup(), oldBody = vi.fn(async () => 'old'), newBody = vi.fn(async () => 'new')
    const remove = ctx.tools.register(makeTool(oldBody)), entered = gate(), resume = gate()
    const detach = ctx.on('tools/pre-execute', async (_exec, next) => { entered.open(); await resume.promise; return next() })
    const pending = ctx.tools.execute(request); await entered.promise
    remove(); ctx.tools.register(makeTool(newBody)); resume.open()
    const result = await pending
    expect(result.isError).toBe(true); expect(result.error?.info?.code).toBe('TOOL_CHANGED')
    expect(result.error?.message).toContain('No tool body ran')
    expect(oldBody).not.toHaveBeenCalled(); expect(newBody).not.toHaveBeenCalled()
    detach(); expect((await ctx.tools.execute(request)).value).toBe('new')
  })
  it('a reused definition still needs a fresh grant after deregistration', async () => {
    const ctx = await setup(), body = vi.fn(async () => 'done'), tool = makeTool(body)
    const remove = ctx.tools.register(tool)
    ctx.on('tools/pre-execute', async (_exec, next) => { remove(); ctx.tools.register(tool); return next() })
    const result = await ctx.tools.execute(request)
    expect(result.error?.info?.code).toBe('TOOL_CHANGED'); expect(body).not.toHaveBeenCalled()
  })
  it('binds methods and result rendering before asynchronous policy, without freezing plugin objects', async () => {
    const ctx = await setup(), body = vi.fn(async () => 'original'), replacement = vi.fn(async () => 'replacement')
    const tool = makeTool(body); ctx.tools.register(tool)
    ctx.on('tools/pre-execute', async (_exec, next) => {
      tool.execute = replacement
      tool.output.render = () => [{ type: 'text', text: 'wrong rendering' }]
      expect(Object.isFrozen(tool)).toBe(false)
      return next()
    })
    const result = await ctx.tools.execute(request)
    expect(result.value).toBe('original'); expect(result.content).toEqual([{ type: 'text', text: 'original' }])
    expect(body).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled()
  })
  it('does not reinterpret a completed canonical result after its registration is removed', async () => {
    const ctx = await setup(); let remove!: () => void
    remove = ctx.tools.register(makeTool(vi.fn(async () => { remove(); return 'committed' })))
    const result = await ctx.tools.execute(request)
    expect(result.isError).toBe(false); expect(result.value).toBe('committed')
  })
  it('rejects stale post-execution result replacement without claiming the body did not run', async () => {
    const ctx = await setup(), body = vi.fn(async () => 'committed'), remove = ctx.tools.register(makeTool(body))
    ctx.on('tools/post-execute', async () => { remove(); ctx.tools.register(makeTool()); return { kind: 'accept', value: 'replacement' } })
    const result = await ctx.tools.execute(request)
    expect(body).toHaveBeenCalledOnce(); expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('may already have completed')
    expect(result.error?.message).not.toContain('No tool body ran')
  })
  it('preserves cancellation before dispatch instead of running a captured tool anyway', async () => {
    const ctx = await setup(), body = vi.fn(async () => 'no'), controller = new AbortController()
    ctx.tools.register(makeTool(body)); ctx.on('tools/pre-execute', async (_exec, next) => { controller.abort(); return next() })
    const result = await ctx.tools.execute({ ...request, signal: controller.signal })
    expect(result.isError).toBe(true); expect(body).not.toHaveBeenCalled()
  })
})
