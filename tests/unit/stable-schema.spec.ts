import { describe, expect, it } from 'vitest'
import { canonicalJson, stableToolSchemas } from '../../src/library/context/stable-schema.ts'
import { Context } from '../../src/library/runtime/vendor/cordis/index.ts'
import SystemPrompt from '../../src/library/context/assembly/index.ts'

describe('stable model-facing schemas', () => {
  it('canonicalizes object key order without changing array semantics or the input', () => {
    const source = { z: { b: 1, a: 2 }, enum: ['z', 'a'], a: [{ z: 2, a: 1 }] }
    const before = JSON.stringify(source), result = canonicalJson(source)
    expect(JSON.stringify(result)).toBe('{"a":[{"a":1,"z":2}],"enum":["z","a"],"z":{"a":2,"b":1}}')
    expect(JSON.stringify(source)).toBe(before); expect(result).not.toBe(source)
  })
  it('preserves prototype-like JSON keys as data without pollution', () => {
    const result = canonicalJson(JSON.parse('{"constructor":1,"__proto__":{"polluted":true}}'))
    expect(Object.hasOwn(result as object, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(JSON.stringify(result)).toBe('{"__proto__":{"polluted":true},"constructor":1}')
  })
  it.each([undefined, NaN, Infinity, 1n, { hidden: undefined }, () => 1])('rejects non-JSON value %s', value => {
    expect(() => canonicalJson(value)).toThrow()
  })
  it('rejects cycles', () => { const v: Record<string, unknown> = {}; v.self = v; expect(() => canonicalJson(v)).toThrow() })
  it('handles deep schemas iteratively', () => {
    let value: unknown = null; for (let i = 0; i < 10000; i++) value = { z: value, a: 1 }
    expect(() => canonicalJson(value)).not.toThrow()
  })
  it('retains caller tool order and enum order; refuses duplicate names', () => {
    const a = { name: 'z', description: 'z', parameters: { enum: ['z','a'], type: 'object' } }
    const b = { ...a, name: 'a' }
    expect(stableToolSchemas([a,b]).map(t => t.name)).toEqual(['z','a'])
    expect(() => stableToolSchemas([a,a])).toThrow('duplicate model tool')
  })
  it('canonicalizes after middleware, but observes later changed and withdrawn definitions', async () => {
    const ctx = new Context(); await ctx.plugin(SystemPrompt)
    let revision = 0
    const remove = ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'fixture', description: String(revision), parameters: revision === 0
      ? { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } }
      : { properties: { a: { type: 'string' }, z: { type: 'string' } }, type: 'object' } }] }))
    const first = await ctx.systemPrompt.assemble(); revision++
    const second = await ctx.systemPrompt.assemble()
    expect(JSON.stringify(first.tools[0]!.parameters)).toBe(JSON.stringify(second.tools[0]!.parameters))
    expect(second.tools[0]!.description).toBe('1')
    remove(); expect((await ctx.systemPrompt.assemble()).tools).toEqual([])
  })
  it('uses deterministic ties for equal-priority runtime contexts, independent of plugin activation order', async () => {
    const first=new Context(), second=new Context(); await first.plugin(SystemPrompt); await second.plugin(SystemPrompt)
    first.systemPrompt.context({name:'z',order:1,text:'Z'}); first.systemPrompt.context({name:'a',order:1,text:'A'})
    second.systemPrompt.context({name:'a',order:1,text:'A'}); second.systemPrompt.context({name:'z',order:1,text:'Z'})
    expect((await first.systemPrompt.assemble()).contexts).toEqual((await second.systemPrompt.assemble()).contexts)
    expect((await first.systemPrompt.assemble()).contexts.map(c=>c.name)).toEqual(['a','z'])
  })
  it('canonicalizes explicitly frozen middleware headers without mutating them', async () => {
    const ctx=new Context(); await ctx.plugin(SystemPrompt)
    const tools=Object.freeze([{name:'fixed',description:'test',parameters:{type:'object',properties:{z:{type:'string'},a:{type:'string'}}}}])
    const before=JSON.stringify(tools)
    ctx.on('system-prompt/assemble',async (_assembly,_context,next)=>({...await next(),tools:tools as never}))
    const result=await ctx.systemPrompt.assemble()
    expect(JSON.stringify(tools)).toBe(before)
    expect(Object.keys((result.tools[0]!.parameters.properties) as object)).toEqual(['a','z'])
  })
})
