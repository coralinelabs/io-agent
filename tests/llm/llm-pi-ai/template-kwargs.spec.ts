import { describe, expect, it } from 'vitest'
import { applyTemplateKwargs, resolveTemplateKwargs } from "../../../src/library/model/pi-ai/template-kwargs.ts"
import type { RequestTemplateKwargs } from "../../../src/library/model/pi-ai/template-kwargs.ts"

describe('deployment-owned template kwargs', () => {
  it('preserves nested JSON, false, zero, null, and array values without inference', () => {
    const source = { thinking: false, budget: 0, stop: null, details: { list: ['a', 3] } }
    const value = resolveTemplateKwargs(source)
    source.details.list.push('new')
    expect(value).toEqual({ thinking: false, budget: 0, stop: null, details: { list: ['a', 3] } })
  })
  it.each([undefined, null, [], { v: undefined }, { v: NaN }, { v: Infinity }, { v: 1n }, { v: () => 1 }, { v: new Date() }])('rejects non-JSON value %#', value => {
    expect(() => resolveTemplateKwargs(value as RequestTemplateKwargs)).toThrow()
  })
  it('rejects cycles but accepts repeated non-cyclic references', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => resolveTemplateKwargs(cyclic as RequestTemplateKwargs)).toThrow('cyclic')
    const shared = { a: 1 }; expect(resolveTemplateKwargs({ a: shared, b: shared })).toEqual({ a: shared, b: shared })
  })
  it('only edits the template namespace and never mutates the source payload', () => {
    const request = { model: 'chosen', messages: [{ role: 'user', content: 'task' }], tools: [1], max_tokens: 8,
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: true } }
    const changed = applyTemplateKwargs(request, { enable_thinking: false, model: 'not-a-route' })
    expect(changed).toEqual({ ...request, chat_template_kwargs: { preserve_thinking: true, enable_thinking: false, model: 'not-a-route' } })
    expect(request.chat_template_kwargs.enable_thinking).toBe(true)
  })
})
