/** Filesystem metadata: categories, the project tier, tool conditions and bundle file listings. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import Skills, { MAX_SKILL_RESOURCE_LISTING_BYTES, renderSkillContent, resourceFileLineBytes } from '../../../src/library/skills/skill/index.ts'
import * as FileSkills from '../../../src/library/skills/filesystem/index.ts'

const roots: string[] = [], contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'io-agent-i8-skills-')); roots.push(path); return path }
async function put(path: string, text = 'x'): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) }
const frontmatter = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} metadata\n${extra}---\n${name} body\n`
async function registry(config: FileSkills.Config): Promise<Context> {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Skills)
  await ctx.plugin(FileSkills, { watch: false, metadataMaxBytes: 1024, maxSourceBytes: 65536, ...config })
  return ctx
}

describe('skill categories and project tier', () => {
  it('derives the category from walked folders for bundles, flat files and nested bundles', async () => {
    const base = await root()
    await put(join(base, 'top/SKILL.md'), frontmatter('top'))
    await put(join(base, 'flat.md'), frontmatter('flat'))
    await put(join(base, 'eng/review/SKILL.md'), frontmatter('review'))
    await put(join(base, 'eng/sub/deep/SKILL.md'), frontmatter('deep'))
    await put(join(base, 'docs/notes.md'), frontmatter('notes'))
    const ctx = await registry({ customSkillDirs: [base] })
    const byName = Object.fromEntries((await ctx.skills.list()).map(s => [s.name, s.category]))
    expect(byName).toEqual({ top: undefined, flat: undefined, review: 'eng', deep: 'eng/sub', notes: 'docs' })
    expect((await ctx.skills.get('deep'))?.category).toBe('eng/sub')
  })

  it('labels explicit project roots as the project tier without changing precedence', async () => {
    const project = await root(), custom = await root()
    await put(join(project, 'shared/SKILL.md'), frontmatter('shared', 'whenToUse: PROJECT_COPY\n'))
    await put(join(custom, 'shared/SKILL.md'), frontmatter('shared', 'whenToUse: CUSTOM_COPY\n'))
    await put(join(custom, 'only-custom/SKILL.md'), frontmatter('only-custom'))
    const ctx = await registry({ projectSkillDirs: [project], customSkillDirs: [custom] })
    const listed = await ctx.skills.list()
    expect(listed.map(s => [s.name, s.source, s.whenToUse])).toEqual([
      ['only-custom', 'custom', undefined], ['shared', 'project', 'PROJECT_COPY']])
    // Project roots keep the custom rank: a runtime registration still outranks them, as before.
    ctx.skills.register({ name: 'shared', description: 'runtime', source: 'runtime', content: 'RUNTIME_COPY' })
    expect((await ctx.skills.get('shared'))?.content).toBe('RUNTIME_COPY')
  })
})

describe('tool conditions frontmatter', () => {
  it('parses string and list forms, and ignores malformed or contradictory conditions', async () => {
    const base = await root()
    await put(join(base, 'a/SKILL.md'), frontmatter('as-string', 'requires-tools: bash read\nfallback-for-tools: web_search\n'))
    await put(join(base, 'b/SKILL.md'), frontmatter('as-list', 'requires-tools: [mcp__docs__search]\n'))
    await put(join(base, 'c/SKILL.md'), frontmatter('empty-list', 'requires-tools: []\n'))
    await put(join(base, 'd/SKILL.md'), frontmatter('contradictory', 'requires-tools: bash\nfallback-for-tools: [bash]\n'))
    await put(join(base, 'e/SKILL.md'), frontmatter('malformed', 'requires-tools: ["not a tool name"]\n'))
    const ctx = await registry({ customSkillDirs: [base] })
    const listed = await ctx.skills.list()
    expect(listed.map(s => [s.name, s.conditions])).toEqual([
      ['as-list', { requiresTools: ['mcp__docs__search'] }],
      ['as-string', { requiresTools: ['bash', 'read'], fallbackForTools: ['web_search'] }],
      ['empty-list', undefined],
    ])
    expect((await ctx.skills.get('as-string'))?.conditions).toEqual({ requiresTools: ['bash', 'read'], fallbackForTools: ['web_search'] })
  })
})

describe('bundle file listing', () => {
  it('lists supporting folders in fixed order, sorted, bounded at 50 and without hidden or foreign entries', async () => {
    const base = await root(), skill = join(base, 'deploy')
    await put(join(skill, 'SKILL.md'), frontmatter('deploy'))
    await put(join(skill, 'references/z.md')); await put(join(skill, 'references/a.md'))
    await put(join(skill, 'references/.hidden')); await put(join(skill, 'references/node_modules/pkg/index.js'))
    await put(join(skill, 'templates/t.yaml')); await put(join(skill, 'scripts/run.sh'))
    await put(join(skill, 'notes/x.md'))
    for (let i = 0; i < 60; i++) await put(join(skill, `assets/${String(i).padStart(2, '0')}.txt`))
    const ctx = await registry({ customSkillDirs: [base] })
    const files = (await ctx.skills.get('deploy'))?.resourceFiles
    expect(files?.truncated).toBe(true)
    expect(files?.paths).toEqual(['references/a.md', 'references/z.md', 'templates/t.yaml', 'scripts/run.sh',
      ...Array.from({ length: 46 }, (_, i) => `assets/${String(i).padStart(2, '0')}.txt`)])
  })

  it('descends nested folders depth-first, bounds depth and terminates symlink cycles', async () => {
    const base = await root(), skill = join(base, 'nested')
    await put(join(skill, 'SKILL.md'), frontmatter('nested'))
    await put(join(skill, 'references/b/inner.md')); await put(join(skill, 'references/a.md')); await put(join(skill, 'references/c.md'))
    await put(join(skill, 'assets/1/2/3/ok.txt')); await put(join(skill, 'assets/1/2/3/4/too-deep.txt'))
    await symlink(join(skill, 'references'), join(skill, 'references/b/loop'))
    await symlink(base, join(skill, 'scripts'))
    const ctx = await registry({ customSkillDirs: [base] })
    expect((await ctx.skills.get('nested'))?.resourceFiles).toEqual({
      paths: ['references/a.md', 'references/b/inner.md', 'references/c.md', 'assets/1/2/3/ok.txt'], truncated: true })
  })

  it('skips generated Python caches, so a script run leaves the listing and rendered block byte-identical', async () => {
    const base = await root(), skill = join(base, 'py')
    await put(join(skill, 'SKILL.md'), frontmatter('py'))
    await put(join(skill, 'scripts/main.py')); await put(join(skill, 'scripts/helper.py'))
    const ctx = await registry({ customSkillDirs: [base] })
    const before = await ctx.skills.get('py')
    expect(before?.resourceFiles).toEqual({ paths: ['scripts/helper.py', 'scripts/main.py'], truncated: false })
    // What the first `python scripts/main.py` leaves behind in a writable workspace bundle.
    await put(join(skill, 'scripts/__pycache__/helper.cpython-312.pyc'))
    await put(join(skill, 'scripts/stale.pyc')); await put(join(skill, 'scripts/venv/bin/python'))
    const after = await ctx.skills.get('py')
    expect(after?.resourceFiles).toEqual(before?.resourceFiles)
    expect(renderSkillContent(after!)).toBe(renderSkillContent(before!))
  })

  it('stops listing long names at the byte budget and marks the listing incomplete', async () => {
    const base = await root(), skill = join(base, 'long')
    await put(join(skill, 'SKILL.md'), frontmatter('long'))
    const names = Array.from({ length: 50 }, (_, i) => `references/${String(i).padStart(2, '0')}-${'n'.repeat(128)}.md`)
    for (const name of names) await put(join(skill, name))
    const ctx = await registry({ customSkillDirs: [base] })
    const files = (await ctx.skills.get('long'))?.resourceFiles
    const used = files!.paths.reduce((total, path) => total + resourceFileLineBytes(path), 0)
    expect(files?.truncated).toBe(true)
    expect(files?.paths).toEqual(names.slice(0, files!.paths.length))
    expect(used).toBeLessThanOrEqual(MAX_SKILL_RESOURCE_LISTING_BYTES)
    expect(used + resourceFileLineBytes(names[files!.paths.length]!)).toBeGreaterThan(MAX_SKILL_RESOURCE_LISTING_BYTES)
  })

  it('gives flat skills and bundles without supporting files no listing, keeping the block unchanged', async () => {
    const base = await root()
    await put(join(base, 'flat.md'), frontmatter('flat'))
    await put(join(base, 'references/nearby.md'))
    await put(join(base, 'plain/SKILL.md'), frontmatter('plain'))
    await put(join(base, 'plain/notes.md'))
    const ctx = await registry({ customSkillDirs: [base] })
    expect(await ctx.skills.get('flat')).not.toHaveProperty('resourceFiles')
    expect(await ctx.skills.get('plain')).not.toHaveProperty('resourceFiles')
  })
})
