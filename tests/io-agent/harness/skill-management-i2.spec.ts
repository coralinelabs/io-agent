/** Exercised through the real loop, router fixture, filesystem guards and journal. */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IoAgentOptions } from '../../../src/index.ts'
import { fixture, stream, tool, tools, onFixtureCleanup, type Request } from './fixture.ts'
import { validateBundleName, inspectSkillPackage, planSkillPackage } from '../../../src/library/skills/management.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
const content = (body = 'REUSABLE_PROCEDURE_42') => `---\nname: review\ndescription: Verify reports carefully.\n---\n${body}\n`
function latest(q: Request): Record<string, unknown> {
  const value = q.messages.filter(m => m.role === 'tool').at(-1)?.content
  return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value))
}
async function managed(reply: Parameters<typeof fixture>[0], overrides: Partial<IoAgentOptions> = {}, workspaceInsideUserspace = false) {
  const userDirectory = await mkdtemp(join(tmpdir(), 'io-skill-user-'))
  onFixtureCleanup(() => rm(userDirectory, { recursive: true, force: true }))
  const f = await fixture(reply, { userDirectory, skills: { writePolicy: 'allow', watch: false }, ...(workspaceInsideUserspace ? { workspace: userDirectory } : {}), ...overrides })
  return { ...f, userDirectory, root: join(userDirectory, 'skills') }
}
const create = { action: 'apply', name: 'analysis/review', revision: null,
  operations: [{ path: 'SKILL.md', content: content() }, { path: 'scripts/check.py', content: 'print("CHECK_SCRIPT_42")\n' }] }

describe('governed skill packages', () => {
  it('creates a usable package, discovers it without watching, and progressively loads its resources', async () => {
    const f = await managed((q, response, index) => {
      if (index === 0) tool(response, 'skill_manage', { action: 'inspect', name: 'analysis/review' }, 'inspect')
      else if (index === 1) { expect(latest(q)).toEqual({ revision: null, files: [] }); tool(response, 'skill_manage', create, 'create') }
      else if (index === 2) { expect(latest(q)).toMatchObject({ outcome: 'committed', revision: expect.any(String) }); tool(response, 'skill_list', {}, 'list') }
      else if (index === 3) { expect(JSON.stringify(latest(q))).toContain('review'); tool(response, 'skill', { name: 'review' }, 'load') }
      else if (index === 4) tool(response, 'skill_read', { name: 'review', path: 'scripts/check.py' }, 'resource')
      else stream(response, [{ content: 'Saved and verified the reusable procedure.' }])
    })
    const result = await (await f.app.createSession()).run('Save the procedure as a usable skill package.')
    expect(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError), JSON.stringify(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message))).toEqual([false, false, false, false, false])
    expect(JSON.stringify(f.requests[3]!.messages.filter(m => m.role === 'tool'))).not.toContain('REUSABLE_PROCEDURE_42') // Not loaded until requested.
    expect(JSON.stringify(f.requests[4]!.messages)).toContain('REUSABLE_PROCEDURE_42')
    expect(JSON.stringify(f.requests[5]!.messages)).toContain('CHECK_SCRIPT_42')
    expect(await readFile(join(f.root, 'analysis/review/SKILL.md'), 'utf8')).toBe(content())
    expect(await readFile(join(f.root, 'analysis/review/scripts/check.py'), 'utf8')).toContain('CHECK_SCRIPT_42')
  }, 30000)

  it('approves a complete package once per revision, updates it, then removes its discoverable files', async () => {
    let revision: string | null = null, asks = 0
    const f = await managed((q, response, index) => {
      if (index === 0) tool(response, 'skill_manage', create, 'create')
      else if (index === 1) {
        revision = latest(q).revision as string
        expect(latest(q).outcome).toBe('committed')
        tool(response, 'skill_manage', { action: 'apply', name: create.name, revision,
          operations: [{ path: 'SKILL.md', content: content('UPDATED_PROCEDURE') }, { path: 'scripts/check.py', content: null }] }, 'update')
      } else if (index === 2) {
        expect(latest(q).revision).not.toBe(revision); revision = latest(q).revision as string
        tool(response, 'skill', { name: 'review' }, 'load')
      } else if (index === 3) {
        expect(JSON.stringify(q.messages)).toContain('UPDATED_PROCEDURE')
        tool(response, 'skill_manage', { action: 'apply', name: create.name, revision,
          operations: [{ path: 'SKILL.md', content: null }] }, 'remove')
      } else if (index === 4) {
        expect(latest(q)).toMatchObject({ outcome: 'committed', revision: null })
        tool(response, 'skill_list', {}, 'list')
      } else {
        expect(JSON.stringify(latest(q))).not.toContain('Verify reports carefully.')
        stream(response, [{ content: 'Package removed after use.' }])
      }
    }, { approval: 'ask', skills: { watch: false, writePolicy: 'ask' }, onApproval: async () => { asks++; return 'allowed-once' } })
    const result = await (await f.app.createSession()).run('Save, improve, and remove a procedure with permission.')
    expect(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError)).toEqual([false, false, false, false, false])
    expect(asks).toBe(3)
    await expect(readFile(join(f.root, 'analysis/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(f.root, 'analysis/review/scripts/check.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('rejects an invalid complete proposal before asking approval or writing any resource', async () => {
    let asks = 0
    const f = await managed((_q, response, index) => index === 0 ? tool(response, 'skill_manage', { ...create,
      operations: [{ path: 'scripts/check.py', content: 'created?' }, { path: 'SKILL.md', content: 'not frontmatter' }] }) : stream(response, [{ content: 'Nothing written.' }]),
    { approval: 'ask', onApproval: async () => { asks++; return 'allowed-once' }, skills: { watch: false, writePolicy: 'ask' } })
    const result = await (await f.app.createSession()).run('Propose a skill.')
    expect(result.events.find(e => e.type === 'tool/result')?.data.message.isError).toBe(true)
    expect(asks).toBe(0); await expect(readFile(join(f.root, 'analysis/review/scripts/check.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('asks once for a package and a refusal causes no file changes', async () => {
    const asks: string[] = []
    const f = await managed((_q, r, i) => i === 0 ? tool(r, 'skill_manage', create) : stream(r, [{ content: 'Permission denied.' }]),
      { approval: 'ask', skills: { watch: false, writePolicy: 'ask' }, onApproval: async request => { asks.push(request.reason ?? ''); return 'rejected' } })
    const result = await (await f.app.createSession()).run('Save after asking.')
    expect(asks).toHaveLength(1); expect(asks[0]).toContain('scripts/check.py')
    expect(result.events.find(e => e.type === 'tool/result')?.data.message.isError).toBe(true)
    await expect(readFile(join(f.root, 'analysis/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('rechecks the inspected revision after approval awaits', async () => {
    let root = ''
    const f = await managed((_q, r, i) => i === 0 ? tool(r, 'skill_manage', create) : stream(r, [{ content: 'Stale proposal rejected.' }]),
      { approval: 'ask', skills: { watch: false, writePolicy: 'ask' }, onApproval: async () => {
        await mkdir(join(root, 'analysis/review'), { recursive: true }); await writeFile(join(root, 'analysis/review/SKILL.md'), content('OTHER_OWNER')); return 'allowed-once'
      } })
    root = f.root
    const result = await (await f.app.createSession()).run('Save after asking.')
    expect(result.events.find(e => e.type === 'tool/result')?.data.message.isError).toBe(true)
    expect(await readFile(join(root, 'analysis/review/SKILL.md'), 'utf8')).toContain('OTHER_OWNER')
    await expect(readFile(join(root, 'analysis/review/scripts/check.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('applies only one of competing absent-revision proposals from the same model step', async () => {
    const f = await managed((_q, r, i) => i === 0 ? tools(r, [['skill_manage', create, 'first'], ['skill_manage', {
      ...create, operations: [{ path: 'SKILL.md', content: content('SECOND') }],
    }, 'second']]) : stream(r, [{ content: 'One proposal committed.' }]))
    const result = await (await f.app.createSession()).run('Save the procedure.')
    expect(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError), JSON.stringify(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message))).toEqual([false, true])
    expect(await readFile(join(f.root, 'analysis/review/SKILL.md'), 'utf8')).toBe(content())
  }, 30000)

  it('does not treat the write policy as a filesystem sandbox bypass', async () => {
    const f = await managed((_q, r, i) => i === 0 ? tool(r, 'skill_manage', create) : stream(r, [{ content: 'Read-only.' }]), { sandbox: 'read-only' })
    const result = await (await f.app.createSession()).run('Attempt the mutation.')
    expect(result.events.find(e => e.type === 'tool/result')?.data.message.isError).toBe(true)
    await expect(readFile(join(f.root, 'analysis/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('fires existing change hooks and rejects publication when a callback changes the package', async () => {
    const touched: string[] = []; let root = ''
    const f = await managed((_q, r, i) => i === 0 ? tool(r, 'skill_manage', create) : stream(r, [{ content: 'Concurrent change preserved.' }]), {
      configure(ctx) { ctx.on('fs/before-change', async (target, exec) => {
        if ((exec as { name?: string })?.name !== 'skill_manage') return
        touched.push(target.displayPath)
        if (touched.length === 1) { await mkdir(join(root, 'analysis/review'), { recursive: true }); await writeFile(join(root, 'analysis/review/notes.txt'), 'FOREIGN') }
      }) },
    }); root = f.root
    const result = await (await f.app.createSession()).run('Save the procedure.')
    expect(touched, JSON.stringify(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message))).toHaveLength(2)
    expect(result.events.find(e => e.type === 'tool/result')?.data.message.isError).toBe(true)
    expect(await readFile(join(root, 'analysis/review/notes.txt'), 'utf8')).toBe('FOREIGN')
    await expect(readFile(join(root, 'analysis/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)

  it('requires workspace-scoped nested instructions before a package is changed', async () => {
    let root = ''
    const f = await managed(async (_q, r, i) => {
      if (i === 0) { await mkdir(join(root, 'analysis/review'), { recursive: true }); await writeFile(join(root, 'analysis/review/AGENTS.md'), 'NESTED_PACKAGE_RULE_42: preserve documentation.\n'); tool(r, 'skill_manage', { action: 'inspect', name: 'analysis/review' }) }
      else if (i === 1 || i === 3) tool(r, 'skill_manage', { ...create, revision: latest(_q).revision }, `write-${i}`)
      else if (i === 2) tool(r, 'skill_manage', { action: 'inspect', name: 'analysis/review' }, 'again')
      else stream(r, [{ content: 'Applied under the nested instructions.' }])
    }, {}, true); root = f.root
    const result = await (await f.app.createSession()).run('Create a governed skill.')
    expect(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError), JSON.stringify(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message))).toEqual([false, true, false, false])
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('NESTED_PACKAGE_RULE_42')
    expect(await readFile(join(root, 'analysis/review/SKILL.md'), 'utf8')).toBe(content())
  }, 30000)

  it.each([{ skills: false }, { skills: { writePolicy: 'deny' } }, { skills: { writePolicy: 'ask' } }] satisfies Partial<IoAgentOptions>[])(
    'does not advertise unavailable package writes: %j', async overrides => {
      const f = await managed((_q, r) => stream(r, [{ content: 'Ready.' }]), overrides)
      await (await f.app.createSession()).run('Inspect capabilities.')
      expect(f.requests[0]!.tools!.map(t => t.function.name)).not.toContain('skill_manage')
    }, 30000)

  it('uses one parser and rejects path tricks, resource links, and removal of required metadata', async () => {
    let ctx!: Context
    const f = await managed((_q, r) => stream(r, [{ content: 'Ready.' }]), { configure(c) { ctx = c } })
    for (const name of ['../escape', '/absolute', 'a//b', 'a/../b', 'a\\b', 'a/.private', 'a:other']) expect(() => validateBundleName(name)).toThrow()
    await mkdir(join(f.root, 'analysis/review'), { recursive: true }); await writeFile(join(f.root, 'analysis/review/SKILL.md'), content())
    const snapshot = await inspectSkillPackage(ctx.fs, f.root, 'analysis/review')
    expect(() => planSkillPackage(snapshot, [{ path: '../outside', content: 'bad' }], snapshot.revision)).toThrow()
    expect(() => planSkillPackage(snapshot, [{ path: 'SKILL.md', content: null }, { path: 'script.py', content: 'print(42)' }], snapshot.revision)).toThrow()
    expect(() => planSkillPackage(snapshot, [{ path: 'SKILL.md', content: content('NEW') }], null)).toThrow()
    expect(planSkillPackage(snapshot, [{ path: 'SKILL.md', content: null }], snapshot.revision).get('SKILL.md')).toBeNull()
    await symlink(f.workspace, join(f.root, 'analysis/review/escape'))
    await expect(inspectSkillPackage(ctx.fs, f.root, 'analysis/review')).rejects.toThrow()
  }, 30000)
})
