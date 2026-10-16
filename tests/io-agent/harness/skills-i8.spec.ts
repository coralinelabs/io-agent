/** Skills on the default runtime path: dense index, bundle file listing, tool conditions. */
import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fixture, stream, tool, type Request } from './fixture.ts'
import { createIoAgent } from '../../../src/index.ts'
import type { SessionEvent } from '../../../src/library/session/journal/index.ts'
import type { SkillCatalogSource } from '../../../src/library/skills/tool-skill/index.ts'

async function put(path: string, text: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) }
async function skill(directory: string, name: string, frontmatter = '', body = `${name} body.`): Promise<string> {
  await put(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Routing metadata for ${name}.\n${frontmatter}---\n${body}\n`)
  return directory
}
const toolTexts = (request: Request): string[] => request.messages.filter(m => m.role === 'tool').map(m => String(m.content))
const userTexts = (request: Request): string[] => request.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content))
const catalogs = (events: readonly SessionEvent[]) => events.flatMap(e => e.type === 'user/message' && e.data.source.kind === 'skill-catalog'
  ? [{ source: e.data.source as SkillCatalogSource, content: e.data.content }] : [])
const errors = (events: readonly SessionEvent[]) => events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError === true)
const listing = (text: string): string => text.slice(text.indexOf('Supporting files in this skill'), text.indexOf('</skill_resources>'))

describe('dense skill index on the default path', () => {
  it('fits a project-first, category-grouped preview into the cap and keeps full routing text searchable', async () => {
    const { app, workspace, stateDirectory, requests } = await fixture((q, res, i) => {
      if (i === 0) tool(res, 'skill_list', { query: 'WHEN_ONLY_149' })
      else stream(res, [{ content: 'Found it.' }])
    }, { skills: { watch: false } })
    await skill(join(workspace, '.agents/skills/ops/zz-rollback'), 'zz-rollback')
    await skill(join(workspace, '.pluto/skills/zz-local'), 'zz-local')
    const categories = ['docs', 'data', 'web']
    for (let i = 0; i < 150; i++) {
      const id = String(i).padStart(3, '0')
      await put(join(stateDirectory, 'skills', categories[i % 3]!, `user-${id}`, 'SKILL.md'),
        `---\nname: user-${id}\ndescription: User skill ${id} ${'covers a long routing description '.repeat(8)}DESC_TAIL_${id}\nwhenToUse: WHEN_ONLY_${id}\n---\nBODY_${id}\n`)
    }
    const result = await (await app.createSession()).run('Find the skill for the rollout routing hint.')
    expect(errors(result.events)).toEqual([false])
    const published = catalogs(result.events)
    expect(published).toHaveLength(1)
    const { source, content } = published[0]!
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(12288)
    expect(source.partial).toBe(true)
    expect(source.entries.length).toBeGreaterThanOrEqual(70); expect(source.entries.length).toBeLessThanOrEqual(100)
    expect(source.entries.every(entry => Array.from(entry.description).length <= 120)).toBe(true)
    expect(source.entries.slice(0, 2)).toEqual([
      { name: 'zz-local', description: 'Routing metadata for zz-local.' },
      { name: 'zz-rollback', description: 'Routing metadata for zz-rollback.', category: 'ops' }])
    const first = JSON.stringify(requests[0]!.messages)
    expect(first).toContain('ops:\\n- `zz-rollback`')
    expect(first.indexOf('zz-rollback')).toBeLessThan(first.indexOf('user-000'))
    // A bounded preview thins every category; none late in the alphabet is dropped.
    for (const category of categories) expect(source.entries.filter(entry => entry.category === category).length).toBeGreaterThan(20)
    expect(first).toContain('bounded preview')
    expect(first).not.toContain('WHEN_ONLY_')
    expect(first).not.toContain('DESC_TAIL_')
    expect(first).not.toContain('BODY_')
    expect(JSON.stringify(requests[0]!.messages.filter(m => m.role === 'system' || m.role === 'developer'))).not.toContain('available_skills')
    const page = JSON.parse(toolTexts(requests[1]!)[0]!) as { skills: { name: string; category?: string; description: string }[] }
    expect(page.skills).toEqual([expect.objectContaining({ name: 'user-149', category: 'web' })])
    expect(page.skills[0]!.description).toContain('DESC_TAIL_149')
    expect(requests[1]!.tools).toEqual(requests[0]!.tools)
  }, 60000)

  it('validates and applies the catalog description length option', async () => {
    for (const catalogDescriptionMaxLength of [2, 1001, 12.5]) {
      await expect(fixture(() => undefined, { skills: { catalogDescriptionMaxLength } })).rejects.toThrow('invalid skill limit: catalogDescriptionMaxLength')
    }
    const { app, workspace, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), { skills: { watch: false, catalogDescriptionMaxLength: 40 } })
    await put(join(workspace, '.agents/skills/wordy/SKILL.md'), `---\nname: wordy\ndescription: ${'lengthy words '.repeat(10)}\n---\nBody.\n`)
    const [published] = catalogs((await (await app.createSession()).run('Hello.')).events)
    expect(published!.source.entries).toEqual([{ name: 'wordy', description: `${'lengthy words '.repeat(2)}lengthy w...` }])
    // A complete catalog is the whole offer: no partial flag and no skill_list pointer.
    expect(published!.source.partial).toBeUndefined()
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('bounded preview')
  }, 30000)

  it('resumes a partial, categorized catalog without republishing it or rewriting the request prefix', async () => {
    const skills = { watch: false, catalogMaxEntries: 3 }
    const { app, workspace, stateDirectory, baseURL, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), { skills })
    for (const category of ['build', 'release']) {
      for (const n of [1, 2, 3]) await skill(join(workspace, `.agents/skills/${category}/${category}-${n}`), `${category}-${n}`)
    }
    const session = await app.createSession()
    const [published, ...more] = catalogs((await session.run('Hello.')).events)
    expect(more).toEqual([])
    expect(published!.source.partial).toBe(true)
    expect(published!.source.entries.map(entry => entry.category)).toEqual(['build', 'build', 'release'])
    const before = requests.at(-1)!
    await app.close()
    const reopened = await createIoAgent({ workspace, stateDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 }, skills })
    try {
      const result = await (await reopened.resumeSession(session.id)).run('Continue.')
      expect(result.stopReason?.kind).not.toBe('error')
      expect(catalogs(result.events)).toEqual([])
      const after = requests.at(-1)!
      expect(after.messages.length).toBeGreaterThan(before.messages.length)
      expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    } finally { await reopened.close() }
  }, 30000)
})

describe('bundle file listing on the default path', () => {
  it('lists bounded supporting files on load, keeps the unchanged reply, and shares the block with /name', async () => {
    const { app, workspace, requests } = await fixture((_q, res, i) => {
      if (i === 0) tool(res, 'skill', { name: 'deploy' }, 'load-1')
      else if (i === 1) tool(res, 'skill', { name: 'deploy' }, 'load-2')
      else if (i === 2) tool(res, 'skill_read', { name: 'deploy', path: 'references/api.md' }, 'read-1')
      else stream(res, [{ content: 'Deployed.' }])
    }, { skills: { watch: false } })
    const dir = await skill(join(workspace, '.agents/skills/deploy'), 'deploy', '', 'Read references/api.md before deploying.')
    await put(join(dir, 'references/api.md'), 'API_REFERENCE_I8\n')
    await put(join(dir, 'references/.hidden'), 'hidden')
    await put(join(dir, 'templates/t.yaml'), 'kind: t\n')
    await put(join(dir, 'scripts/run.sh'), 'echo run\n')
    await put(join(dir, 'notes/x.md'), 'not a support folder\n')
    for (let i = 0; i < 60; i++) await put(join(dir, `assets/${String(i).padStart(2, '0')}.txt`), 'asset\n')
    const session = await app.createSession()
    const result = await session.run('Deploy with the deploy skill.')
    expect(errors(result.events)).toEqual([false, false, false])
    const loaded = toolTexts(requests[1]!)[0]!
    const lines = listing(loaded).split('\n').filter(line => line.startsWith('- '))
    expect(lines).toEqual(['- references/api.md', '- templates/t.yaml', '- scripts/run.sh',
      ...Array.from({ length: 47 }, (_, i) => `- assets/${String(i).padStart(2, '0')}.txt`)])
    expect(loaded).toContain('This list is incomplete; other supporting files may exist in the base directory.')
    expect(loaded).not.toContain('notes/'); expect(loaded).not.toContain('.hidden')
    expect(toolTexts(requests[2]!)[1]).toContain('Skill "deploy" is unchanged.')
    expect(toolTexts(requests[3]!)[2]).toContain('API_REFERENCE_I8')

    const invoked = await (await app.createSession()).run('/deploy go')
    expect(invoked.stopReason?.kind).not.toBe('error')
    const injection = userTexts(requests.at(-1)!).find(text => text.includes('<skill_content name=\\"deploy\\">'))
    expect(injection).toContain(JSON.stringify(listing(loaded)).slice(1, -1))
  }, 60000)

  it('shortens a listing of long names to fit maxSkillBytes instead of refusing a loadable skill', async () => {
    const { app, workspace, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'skill', { name: 'wide' }) : stream(res, [{ content: 'Loaded.' }]), { skills: { watch: false, maxSkillBytes: 2048 } })
    const dir = await skill(join(workspace, '.agents/skills/wide'), 'wide', '', `WIDE_BODY_I8 ${'x'.repeat(1000)}`)
    for (let i = 0; i < 20; i++) await put(join(dir, `references/${String(i).padStart(2, '0')}-${'n'.repeat(100)}.md`), 'ref\n')
    const result = await (await app.createSession()).run('Load the wide skill.')
    expect(errors(result.events)).toEqual([false])
    const loaded = toolTexts(requests[1]!)[0]!
    expect(Buffer.byteLength(loaded, 'utf8')).toBeLessThanOrEqual(2048)
    expect(loaded).toContain('WIDE_BODY_I8')
    const lines = listing(loaded).split('\n').filter(line => line.startsWith('- '))
    expect(lines.length).toBeGreaterThan(0); expect(lines.length).toBeLessThan(20)
    expect(loaded).toContain('This list is incomplete; other supporting files may exist in the base directory.')
  }, 30000)
})

describe('tool-conditioned skills on the default path', () => {
  it('offers skills by the agent resolved tool set, in the catalog and skill_list alike, without blocking /name', async () => {
    const { app, workspace, requests } = await fixture((_q, res, i) => {
      if (i === 0) tool(res, 'skill_list', {})
      else stream(res, [{ content: 'Listed.' }])
    }, {
      skills: { watch: false },
      configure: ctx => { ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ deny: ['write'] }) }) },
    })
    const root = join(workspace, '.agents/skills')
    await skill(join(root, 'needs-bash'), 'needs-bash', 'requires-tools: bash\n')
    await skill(join(root, 'needs-search'), 'needs-search', 'requires-tools: [web_search]\n')
    await skill(join(root, 'search-fallback'), 'search-fallback', 'fallback-for-tools: web_search\n')
    await skill(join(root, 'bash-fallback'), 'bash-fallback', 'fallback-for-tools: [bash]\n')
    await skill(join(root, 'needs-write'), 'needs-write', 'requires-tools: write\n', 'NEEDS_WRITE_BODY_I8')
    const session = await app.createSession()
    const result = await session.run('Which skills are available?')
    expect(errors(result.events)).toEqual([false])
    expect(requests[0]!.tools!.map(t => t.function.name)).not.toContain('write')
    expect(catalogs(result.events).map(c => c.source.entries.map(e => e.name))).toEqual([['needs-bash', 'search-fallback']])
    expect(catalogs(result.events)[0]!.source.partial).toBeUndefined()
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('bounded preview')
    const page = JSON.parse(toolTexts(requests[1]!)[0]!) as { total: number; skills: { name: string }[] }
    expect(page.total).toBe(2); expect(page.skills.map(s => s.name)).toEqual(['needs-bash', 'search-fallback'])
    // Offer-time only: an explicit user invocation still loads a hidden skill.
    await session.run('/needs-write go')
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('NEEDS_WRITE_BODY_I8')
  }, 60000)
})
