import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import Skills from '../../../src/library/skills/skill/index.ts'
import * as FileSkills from '../../../src/library/skills/filesystem/index.ts'
const roots: string[] = [], contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'io-agent-category-')); roots.push(path); return path }
async function skill(base: string, path: string, name: string, body = 'Only load on request.') {
  const dir = join(base, path); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} metadata\n---\n${body}`); return dir
}
async function registry(path: string, config: FileSkills.Config = {}) {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Skills)
  await ctx.plugin(FileSkills, { customSkillDirs: [path], watch: false, metadataMaxBytes: 512, maxSourceBytes: 4096, ...config }); return ctx
}
describe('bounded categorical skill discovery', () => {
  it('finds nested categories without loading bodies or registering bundle resources', async () => {
    const path = await root(); const dir = await skill(path, 'engineering/review', 'review', 'x'.repeat(8000))
    await skill(dir, 'references/example', 'not-invocable')
    const ctx = await registry(path)
    expect((await ctx.skills.list()).map(s => s.name)).toEqual(['review'])
    await expect(ctx.skills.get('review')).rejects.toThrow(/source limit/)
  })
  it('keeps an invalid bundle a leaf, not a container for accidental executable examples', async () => {
    const path = await root(); const bad = await skill(path, 'invalid', 'valid-name')
    await writeFile(join(bad, 'SKILL.md'), 'invalid frontmatter')
    await skill(bad, 'references/example', 'hidden-example')
    expect((await (await registry(path)).skills.list())).toEqual([])
  })
  it('requires qualified identities for distinct same-tier category matches', async () => {
    const path = await root(); await skill(path, 'z-category/review', 'review', 'later')
    await skill(path, 'a-category/review', 'review', 'earlier')
    const ctx = await registry(path)
    await expect(ctx.skills.get('review')).rejects.toThrow('more than one eligible origin')
    expect((await ctx.skills.list()).map(s => s.name)).toEqual(['filesystem:custom:a-category/review', 'filesystem:custom:z-category/review'])
    expect((await ctx.skills.get('filesystem:custom:a-category/review'))?.content).toBe('earlier')
    expect((await ctx.skills.get('filesystem:custom:z-category/review'))?.content).toBe('later')
  })
  it('bounds directory breadth and reports an incomplete, still-loadable catalog', async () => {
    const path = await root(); await skill(path, 'a', 'first'); await skill(path, 'b', 'second')
    const ctx = await registry(path, { discoveryMaxDirectories: 2 })
    expect(await ctx.skills.snapshot()).toMatchObject({ complete: false, skills: [{ name: 'first' }] })
    expect((await ctx.skills.get('first'))?.content).toContain('Only load')
  })
  it('bounds depth rather than claiming a complete empty discovery', async () => {
    const path = await root(); await skill(path, 'category/nested/review', 'deep')
    expect(await (await registry(path, { discoveryMaxDepth: 1 })).skills.snapshot()).toEqual({ complete: false, skills: [] })
  })
  it('terminates symbolic-link cycles and coalesces aliases without inventing new identities', async () => {
    const path = await root(); await skill(path, 'category/review', 'review')
    await symlink(path, join(path, 'category/back')); await symlink(join(path, 'category'), join(path, 'alias'))
    const result = await (await registry(path, { discoveryMaxDirectories: 16 })).skills.snapshot()
    expect(result.complete).toBe(true); expect(result.skills.map(s => s.name)).toEqual(['review'])
  })
  it.each([{ discoveryMaxDepth: 0 }, { discoveryMaxDepth: 33 }, { discoveryMaxDirectories: 0 }, { discoveryMaxDirectories: 10001 }])('rejects invalid traversal bounds %s', async config => {
    const path = await root(); await expect(registry(path, config)).rejects.toThrow()
  })
})
