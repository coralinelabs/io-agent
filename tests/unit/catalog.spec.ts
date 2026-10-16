import { describe, expect, it } from 'vitest'
import {
  catalogDigest, catalogLineBytes, catalogLines, catalogPage, descriptionOf, offeredWithTools, previewCatalog, toolAvailability,
} from '../../src/library/skills/catalog.ts'
import { bindSkillArguments, leadingSkillArguments } from '../../src/library/skills/activation.ts'
import type { SkillSummary } from '../../src/library/skills/skill/index.ts'
const skill = (name: string, description = 'Useful metadata'): SkillSummary => ({ name, description, provider: 'fixture', source: 'custom', invocation: { modelInvocable: true, userInvocable: true } })
describe('one bounded skill catalog', () => {
  it('enforces the actual byte budget, even for thousands of Unicode entries', () => {
    const all = Array.from({ length: 2000 }, (_, i) => skill(`skill-${String(i).padStart(4, '0')}`, '🙂'.repeat(50)))
    const seen: string[] = []; let offset = 0, revision: string | undefined
    do {
      const page = catalogPage(all, true, { query: '', offset, limit: 100, maxBytes: 4096 })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      if (revision) expect(page.revision).toBe(revision)
      revision = page.revision; seen.push(...page.skills.map(s => s.name))
      if (page.nextOffset === undefined) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset
    } while (true)
    expect(seen).toEqual(all.map(s => s.name))
  })
  it('keeps preview lines within the supplied line budget', () => {
    const all = Array.from({ length: 1000 }, (_, i) => skill(`skill-${i}`, '🙂'.repeat(60)))
    const { entries, partial } = previewCatalog(all, { limit: 1000, descriptionLimit: 60, lineBudget: 1024 })
    expect(catalogLines(entries).reduce((total, line) => total + catalogLineBytes(line), 0)).toBeLessThanOrEqual(1024)
    expect(entries.length).toBeGreaterThan(0); expect(entries.length).toBeLessThan(1000)
    expect(partial).toBe(true)
  })
  it('does not mutate provider ordering or publish user-only entries', () => {
    const all = [skill('z'), { ...skill('hidden'), invocation: { modelInvocable: false, userInvocable: true } }, skill('a')]
    expect(catalogPage(all, true, { query: '', offset: 0, limit: 10, maxBytes: 1024 }).skills.map(s => s.name)).toEqual(['a', 'z'])
    expect(all.map(s => s.name)).toEqual(['z', 'hidden', 'a'])
  })
  it('detects same-length metadata changes, completeness changes, and filtered identities', () => {
    const page = (all: SkillSummary[], complete = true, query = '') => catalogPage(all, complete, { query, offset: 0, limit: 2, maxBytes: 2048 })
    const before = page([skill('a', 'old')]).revision
    expect(page([skill('a', 'new')]).revision).not.toBe(before)
    expect(page([skill('a', 'old')], false).revision).not.toBe(before)
    expect(page([skill('a', 'old')], true, ' a ').revision).not.toBe(before)
    expect(page([skill('a')], true, ' A ').revision).toBe(page([skill('a')], true, 'a').revision)
  })
  it('reports skipped oversized names instead of returning a false renamed identity', () => {
    const page = catalogPage([skill('a'.repeat(10000)), skill('b')], true, { query: '', offset: 0, limit: 5, maxBytes: 512 })
    expect(page.skipped).toBe(1); expect(page.skills.map(s => s.name)).toEqual(['b'])
    expect(page.nextOffset).toBeUndefined(); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512)
  })
  it('rejects invalid paging and avoids surrogate splitting', () => {
    for (const offset of [-1, Infinity, NaN, 1.1]) expect(() => catalogPage([], true, { query: '', offset, limit: 10, maxBytes: 512 })).toThrow()
    expect(descriptionOf('🙂🙂🙂🙂🙂', 4)).toBe('🙂...')
  })
})
describe('dense skill index', () => {
  const at = (name: string, extra: Partial<SkillSummary> = {}): SkillSummary => ({ ...skill(name, `${name} summary`), ...extra })
  it('selects project skills first under pressure, then groups uncategorized entries before categories', () => {
    const all = [at('alpha'), at('zeta', { source: 'project', category: 'ops' }), at('beta', { category: 'docs' }),
      at('omega', { source: 'project-agents' }), at('gamma', { category: 'ops' })]
    const bounded = previewCatalog(all, { limit: 3, descriptionLimit: 120, lineBudget: Infinity })
    expect(bounded).toEqual({ partial: true, entries: [
      { name: 'omega', description: 'omega summary' }, { name: 'alpha', description: 'alpha summary' },
      { name: 'zeta', description: 'zeta summary', category: 'ops' }] })
    const complete = previewCatalog(all, { limit: 100, descriptionLimit: 120, lineBudget: Infinity })
    expect(complete.partial).toBe(false)
    expect(catalogLines(complete.entries)).toEqual([
      '- `omega`: omega summary', '- `alpha`: alpha summary',
      'ops:', '- `zeta`: zeta summary', '- `gamma`: gamma summary',
      'docs:', '- `beta`: beta summary'])
    // A project skill that no longer fits is skipped, not shortened; a later smaller one still fits.
    const tight = previewCatalog([at('big', { source: 'project', description: 'x'.repeat(400) }), at('small')],
      { limit: 100, descriptionLimit: 500, lineBudget: 100 })
    expect(tight).toEqual({ partial: true, entries: [{ name: 'small', description: 'small summary' }] })
  })
  it('thins every category round-robin under pressure instead of dropping those late in the alphabet', () => {
    const all = ['data', 'docs', 'web'].flatMap(category => [1, 2, 3].map(i => at(`${category}-${i}`, { category })))
    all.push(at('plain-1'), at('local', { source: 'project', category: 'web' }))
    const bounded = previewCatalog(all, { limit: 6, descriptionLimit: 120, lineBudget: Infinity })
    expect(bounded.partial).toBe(true)
    // Project tier first; then round 0 (uncategorized, data, docs, web) and round 1 (data).
    expect(catalogLines(bounded.entries)).toEqual([
      '- `plain-1`: plain-1 summary',
      'web:', '- `local`: local summary', '- `web-1`: web-1 summary',
      'data:', '- `data-1`: data-1 summary', '- `data-2`: data-2 summary',
      'docs:', '- `docs-1`: docs-1 summary'])
  })
  it('accounts bytes exactly, including Unicode, escapes, control characters and category headers', () => {
    const hostile = 'Café 🙂 "quoted" \\ back <tag> & \u0001 \ud800 end'
    const all = Array.from({ length: 40 }, (_, i) => at(`s-${i}`, { description: hostile.repeat(3),
      ...(i % 3 === 0 ? {} : { category: i % 3 === 1 ? 'ops <x>' : 'données\nrapport' }) }))
    const frame = (lines: readonly string[]) => Buffer.byteLength(JSON.stringify([{ type: 'text',
      text: ['<system-reminder>', '<available_skills>', ...lines, '</available_skills>', '</system-reminder>'].join('\n') }]))
    for (const lineBudget of [0, 300, 2048, 5000]) {
      const { entries } = previewCatalog(all, { limit: 100, descriptionLimit: 120, lineBudget })
      const lines = catalogLines(entries)
      const used = lines.reduce((total, line) => total + catalogLineBytes(line), 0)
      expect(frame(lines)).toBe(frame([]) + used)
      expect(used).toBeLessThanOrEqual(lineBudget)
    }
    const lines = catalogLines(previewCatalog(all, { limit: 100, descriptionLimit: 120, lineBudget: Infinity }).entries)
    expect(lines).toContain('ops &lt;x&gt;:')
    expect(lines).toContain('données rapport:')
    expect(lines.filter(line => !line.startsWith('- `'))).toHaveLength(2)
  })
  it('offers a skill only when every required tool resolves and no fallback target does', () => {
    const tools = new Set(['bash', 'read'])
    const calls: string[] = []
    const hasTool = toolAvailability(name => { calls.push(name); return tools.has(name) })
    const offered = (conditions: SkillSummary['conditions']) => offeredWithTools(conditions === undefined ? {} : { conditions }, hasTool)
    expect(offered(undefined)).toBe(true)
    expect(offered({ requiresTools: ['bash'] })).toBe(true)
    expect(offered({ requiresTools: ['bash', 'web_search'] })).toBe(false)
    expect(offered({ fallbackForTools: ['web_search'] })).toBe(true)
    expect(offered({ fallbackForTools: ['bash'] })).toBe(false)
    expect(offered({ requiresTools: ['read'], fallbackForTools: ['web_search'] })).toBe(true)
    expect(calls).toEqual(['bash', 'web_search', 'read'])
  })
  it('searches categories and whenToUse, returning the category with the paged metadata', () => {
    const all = [at('deploy', { category: 'ops', whenToUse: 'ROLLBACK_ONLY' }), at('write-docs', { category: 'docs' })]
    const page = catalogPage(all, true, { query: 'OPS', offset: 0, limit: 10, maxBytes: 1024 })
    expect(page.skills).toEqual([{ name: 'deploy', description: 'deploy summary', category: 'ops' }])
    expect(catalogPage(all, true, { query: 'rollback_only', offset: 0, limit: 10, maxBytes: 1024 }).skills.map(s => s.name)).toEqual(['deploy'])
  })
  it('keeps the legacy digest for uncategorized complete catalogs and distinguishes partial or categorized ones', () => {
    const entries = [{ name: 'a-skill', description: 'Alpha <tools> & more' }, { name: 'b-skill', description: 'Beta 🙂' }]
    // sha256 of entries.map(e => JSON.stringify([e.name, e.description])).join('\n').
    expect(catalogDigest(entries)).toBe('38cea59e2a99c98244d4ea7188c59d835b6de1e412638dac22ad946f541b4e2a')
    expect(catalogDigest(entries, true)).not.toBe(catalogDigest(entries))
    expect(catalogDigest([{ ...entries[0]!, category: 'ops' }, entries[1]!])).not.toBe(catalogDigest(entries))
  })
})
describe('skill arguments are data, never a second interpreter', () => {
  it('replaces each placeholder exactly once without interpreting shell or template syntax', () => {
    expect(bindSkillArguments('Use $ARGUMENTS; repeat $ARGUMENTS.', '$(touch nope) $ARGUMENTS {{secret}}')).toBe('Use $(touch nope) $ARGUMENTS {{secret}}; repeat $(touch nope) $ARGUMENTS {{secret}}.')
  })
  it('does not match a partial token or slash path', () => {
    expect(bindSkillArguments('$ARGUMENTS_EXTRA $ARGUMENTS', 'x')).toBe('$ARGUMENTS_EXTRA x')
    expect(leadingSkillArguments('/review path/to/x', 'review')).toBe('path/to/x')
    expect(leadingSkillArguments('/review/other x', 'review')).toBeUndefined()
    expect(leadingSkillArguments('mention /review x', 'review')).toBeUndefined()
  })
})
