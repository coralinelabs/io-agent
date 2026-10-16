import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import Skills, { type SkillCandidate, type SkillProvider, type SkillProviderControl } from '../../../src/library/skills/skill/index.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Skills)
  let candidate: SkillCandidate = { name: 'audit', description: 'Audit', provider: 'source', source: 'test', rank: 10, locator: 'audit', invocation: { modelInvocable: true, userInvocable: true } }
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0, control!: SkillProviderControl
  const provider: SkillProvider = { name: 'source', async list() { return [candidate] }, async get(entry) {
    calls++; const value = { ...entry, content: 'ORIGINAL' }; if (calls === 1) { started.resolve(); await release.promise }; return value
  } }
  const dispose = ctx.skills.registerProvider(c => { control = c; return provider })
  return { ctx, provider, dispose, started, release, control: () => control,
    mutateBorrowedPolicy() { Object.assign(candidate.invocation, { modelInvocable: false }); control.invalidate() },
    update(policy = false) { candidate = { ...candidate, invocation: { modelInvocable: policy, userInvocable: true } }; control.invalidate() },
  }
}
describe('suspended skill loads are registration- and policy-bound', () => {
  it('does not return a body after its provider is removed', async () => {
    const f = await fixture(); const loading = f.ctx.skills.get('audit'); await f.started.promise; f.dispose(); f.release.resolve()
    expect(await loading).toBeUndefined()
  })
  it('detects same-object re-registration, not just a changed provider object', async () => {
    const f = await fixture(); const loading = f.ctx.skills.get('audit'); await f.started.promise; f.dispose()
    f.ctx.skills.registerProvider(() => f.provider); f.release.resolve()
    expect(await loading).toBeUndefined(); expect((await f.ctx.skills.get('audit'))?.content).toBe('ORIGINAL')
  })
  it('does not return a body loaded under the old invocation policy', async () => {
    const f = await fixture(); const loading = f.ctx.skills.get('audit'); await f.started.promise; f.update(false); f.release.resolve()
    expect(await loading).toBeUndefined(); expect((await f.ctx.skills.get('audit'))?.invocation?.modelInvocable).toBe(false)
  })
  it('compares against captured metadata, not two references to a mutated object', async () => {
    const f = await fixture(); const loading = f.ctx.skills.get('audit'); await f.started.promise
    f.mutateBorrowedPolicy(); f.release.resolve()
    expect(await loading).toBeUndefined()
  })
  it('allows unrelated invalidation when the exact selected source and metadata remain current', async () => {
    const f = await fixture(); const loading = f.ctx.skills.get('audit'); await f.started.promise; f.control().invalidate(); f.release.resolve()
    expect((await loading)?.content).toBe('ORIGINAL')
  })
  it('does not let a higher-priority registration appear midway through an old load', async () => {
    const f = await fixture(); const loading = f.ctx.skills.get('audit'); await f.started.promise
    f.ctx.skills.registerProvider(() => ({ name: 'replacement', async list() { return [{ name: 'audit', description: 'New policy', provider: 'replacement', source: 'test', rank: 1, locator: null }] }, async get(c) { return { ...c, content: 'REPLACEMENT' } } }))
    f.release.resolve(); expect(await loading).toBeUndefined(); expect((await f.ctx.skills.get('audit'))?.content).toBe('REPLACEMENT')
  })
  it('rejects a provider-loaded definition that claims a different source', async () => {
    const f = await fixture(); f.release.resolve()
    f.provider.get = async c => ({ ...c, provider: 'imposter', content: 'UNTRUSTED_SOURCE' })
    expect(await f.ctx.skills.get('audit')).toBeUndefined()
  })
  it('preserves cancellation even when a source later completes', async () => {
    const f = await fixture(), controller = new AbortController()
    const loading = f.ctx.skills.get('audit', { signal: controller.signal }); await f.started.promise
    const rejected = expect(loading).rejects.toThrow('cancelled lookup')
    controller.abort(new Error('cancelled lookup')); await rejected; f.release.resolve()
    expect((await f.ctx.skills.get('audit'))?.content).toBe('ORIGINAL')
  })
})
