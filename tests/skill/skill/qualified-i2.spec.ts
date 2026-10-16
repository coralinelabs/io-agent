/** One catalog resolution governs list, metadata, body loading and invocation policy. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import Registry, { isSkillReference, type SkillCandidate, type SkillProviderControl } from '../../../src/library/skills/skill/index.ts'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Registry); return ctx }
function provider(ctx: Context, name: string, patch: Partial<SkillCandidate> = {}) {
  let reads = 0, control!: SkillProviderControl
  const candidate: SkillCandidate = { name: 'review', description: name, source: 'custom', provider: name,
    rank: 300, locator: {}, invocation: { modelInvocable: true, userInvocable: true }, ...patch }
  const dispose = ctx.skills.registerProvider(c => { control = c; return { name, list: async () => [candidate],
    get: async entry => { reads++; return { ...entry, content: `${name} instructions` } } } })
  return { candidate, dispose, invalidate: () => control.invalidate(), reads: () => reads }
}
describe('qualified skill identities', () => {
  it('exposes both same-tier origins without eagerly reading either body', async () => {
    const ctx = await setup(); const a = provider(ctx, 'one'); const b = provider(ctx, 'two')
    const names = (await ctx.skills.list()).map(s => s.name)
    expect(names).toEqual(['one:custom:review', 'two:custom:review'])
    expect(names.every(isSkillReference)).toBe(true); expect(a.reads() + b.reads()).toBe(0)
    await expect(ctx.skills.describe('review')).rejects.toMatchObject({ code: 'AMBIGUOUS_SKILL' })
    await expect(ctx.skills.get('review')).rejects.toMatchObject({ code: 'AMBIGUOUS_SKILL' })
    expect(await ctx.skills.describe(names[1]!)).toMatchObject({ name: names[1], provider: 'two' })
    expect(a.reads() + b.reads()).toBe(0)
    expect(await ctx.skills.get(names[1]!)).toMatchObject({ name: names[1], content: 'two instructions' })
    expect(a.reads()).toBe(0); expect(b.reads()).toBe(1)
  })
  it('does not bypass a deliberate override through the qualified alias of a hidden source', async () => {
    const ctx = await setup(); provider(ctx, 'lower'); provider(ctx, 'winner', { rank: 299, invocation: { modelInvocable: false, userInvocable: true } })
    expect((await ctx.skills.list()).map(s => s.name)).toEqual(['review'])
    expect(await ctx.skills.get('lower:custom:review')).toBeUndefined()
    expect(await ctx.skills.describe('winner:custom:review')).toMatchObject({ name: 'review', invocation: { modelInvocable: false } })
  })
  it('keeps issued origin references working when a collision later disappears', async () => {
    const ctx = await setup(); const a = provider(ctx, 'one'); provider(ctx, 'two')
    expect((await ctx.skills.list())).toHaveLength(2); a.dispose()
    expect((await ctx.skills.list()).map(s => s.name)).toEqual(['review'])
    expect(await ctx.skills.get('two:custom:review')).toMatchObject({ name: 'review', content: 'two instructions' })
  })
  it('fences a suspended bare-name load when a competing origin appears', async () => {
    const ctx = await setup(); const gate = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>()
    const entry: SkillCandidate = { name: 'review', description: 'first', provider: 'one', source: 'custom', rank: 300, locator: {}, invocation: { modelInvocable: true, userInvocable: true } }
    ctx.skills.registerProvider(() => ({ name: 'one', list: async () => [entry], get: async c => { started.resolve(); await gate.promise; return { ...c, content: 'old' } } }))
    const pending = ctx.skills.get('review'); await started.promise; provider(ctx, 'two'); gate.resolve()
    expect(await pending).toBeUndefined()
  })
  it('does not disclose a private origin in an ambiguity error', async () => {
    const ctx = await setup(); provider(ctx, 'secret-provider', { invocation: { modelInvocable: false, userInvocable: true } }); provider(ctx, 'public')
    try { await ctx.skills.get('review'); throw new Error('expected rejection') }
    catch (error) { expect(String(error)).toContain('more than one'); expect(String(error)).not.toContain('secret-provider') }
  })
  it('disambiguates same-provider paths deterministically, independent of listing order', async () => {
    const ctx = await setup(); const mk = (path: string): SkillCandidate => ({ name: 'review', description: path, provider: 'fs', source: 'custom', path, rank: 300, locator: path, invocation: { modelInvocable: true, userInvocable: true } })
    let values = [mk('/one/SKILL.md'), mk('/two/SKILL.md')], control!: SkillProviderControl
    ctx.skills.registerProvider(c => { control = c; return { name: 'fs', list: async () => values, get: async v => ({ ...v, content: v.path! }) } })
    const before = await ctx.skills.list(); expect(before).toHaveLength(2)
    expect(before.every(s => /@\w{12}$/.test(s.name))).toBe(true)
    values = values.toReversed(); control.invalidate(); expect(await ctx.skills.list()).toEqual(before)
    expect(await ctx.skills.get(before[0]!.name)).toMatchObject({ content: before[0]!.path })
  })
  it('rejects genuinely conflicting definitions at the exact same origin rather than guessing by opaque locators', async () => {
    const ctx = await setup()
    const base: SkillCandidate = { name: 'review', description: 'one', source: 'custom', provider: 'duplicate', rank: 300, locator: 1, invocation: { modelInvocable: true, userInvocable: true }, path: '/same/SKILL.md' }
    ctx.skills.registerProvider(() => ({ name: 'duplicate', list: async () => [base, { ...base, description: 'two', locator: 2 }], get: async () => undefined }))
    await expect(ctx.skills.list()).rejects.toThrow('conflicting definitions')
  })
})
