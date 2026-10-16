import { describe, expect, it, vi } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import SystemPrompt from '../../../src/library/context/assembly/index.ts'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '../../../src/library/tools/index.ts'
import { ToolCallId } from '../../../src/library/model/llm/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}
const request = () => ({ name: 'write-once', callId: ToolCallId('operation'), arguments: {}, signal: new AbortController().signal })
const tool = (execute: () => Promise<string>) => defineTool({
  name: 'write-once', description: 'Effect-counting fixture', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute,
})

describe('one tool invocation, one execution authority', () => {
  it.each(['sequential', 'concurrent'] as const)('does not replay an effect for %s next calls', async mode => {
    const ctx = await setup(), body = vi.fn(async () => 'committed')
    try {
      ctx.tools.register(tool(body))
      ctx.on('tools/execute', async (_exec, next) => {
        const first = next()
        const second = mode === 'sequential' ? (await first, next()) : next()
        const [a, b] = await Promise.all([first, second])
        expect(a).toBe(b)
        return b
      })
      expect((await ctx.tools.execute(request())).value).toBe('committed')
      expect(body).toHaveBeenCalledTimes(1)
      await ctx.tools.execute(request())
      expect(body).toHaveBeenCalledTimes(2) // A NEW call is still a new execution.
    } finally { await ctx.fiber.dispose() }
  })

  it('does not replay a failed side effect just because a wrapper asks again', async () => {
    const ctx = await setup(), body = vi.fn(async (): Promise<string> => { throw new Error('may have written') })
    try {
      ctx.tools.register(tool(body))
      ctx.on('tools/execute', async (_exec, next) => { await next(); return next() })
      const result = await ctx.tools.execute(request())
      expect(result.isError).toBe(true)
      expect(result.error?.message).toContain('may have written')
      expect(body).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it('retains one detached frozen outcome through no-op policy and finalization', async () => {
    const ctx = await setup(), definition = tool(async () => 'committed')
    let bodyResult: ToolExecutionResult | undefined
    definition.finalizeContent = (_exec, result) => { expect(result).toBe(bodyResult); return undefined }
    try {
      ctx.tools.register(definition)
      ctx.on('tools/execute', async (_exec, next) => { bodyResult = await next(); return bodyResult })
      const result = await ctx.tools.execute(request())
      expect(result).toBe(bodyResult)
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.content)).toBe(true)
      expect(Object.isFrozen(result.content[0])).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('still detaches and validates actual post-policy replacements', async () => {
    const ctx = await setup(), authored = [{ type: 'text' as const, text: 'new presentation' }]
    try {
      ctx.tools.register(tool(async () => 'actual value'))
      ctx.on('tools/post-execute', async () => ({ kind: 'accept', content: authored }))
      const result = await ctx.tools.execute(request())
      authored[0]!.text = 'mutated later'
      expect(result.value).toBe('actual value')
      expect(result.content[0]).toEqual({ type: 'text', text: 'new presentation' })
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a now-unsupported borrowed output contract before any effect', async () => {
    const ctx = await setup(), body = vi.fn(async () => 'committed'), definition = tool(body)
    try {
      ctx.tools.register(definition)
      Object.assign(definition.output.schema, { minLength: 2 }) // Not in the enforced subset.
      const result = await ctx.tools.execute(request())
      expect(result.isError).toBe(true)
      expect(result.error?.message).toContain('minLength')
      expect(body).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})
