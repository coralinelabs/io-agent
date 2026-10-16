/** The progressive surface is exercised through real tool execution, not direct tool bodies. */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, stream, tool } from './fixture.ts'

async function skill(workspace: string, name: string, body: string, userOnly = false): Promise<string> {
  const directory = join(workspace, '.agents/skills', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Routing metadata for ${name}.\n${userOnly ? 'disable-model-invocation: true\n' : ''}---\n${body}\n`)
  return directory
}
const errors = (events: readonly import("../../../src/library/session/journal/index.ts").SessionEvent[]) => events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError === true)

describe('bounded progressive skill disclosure', () => {
  it('publishes a bounded preview, searches beyond it, and only loads a selected body', async () => {
    const { app, workspace, requests } = await fixture((q, res, i) => {
      if (i === 0) {
        const text = JSON.stringify(q.messages)
        expect(text).not.toContain('BODY_NOT_PRELOADED_039')
        expect(text).not.toContain('Routing metadata for skill-039')
        expect(text).toContain('skill_list')
        tool(res, 'skill_list', { query: 'skill-039', limit: 1 })
      } else if (i === 1) {
        expect(JSON.stringify(q.messages)).toContain('Routing metadata for skill-039')
        expect(JSON.stringify(q.messages)).not.toContain('BODY_NOT_PRELOADED_039')
        tool(res, 'skill', { name: 'skill-039' }, 'load')
      } else stream(res, [{ content: 'Loaded only the selected instructions.' }])
    }, { skills: { catalogMaxEntries: 4, catalogMaxBytes: 2048, watch: false } })
    for (let i = 0; i < 40; i++) await skill(workspace, `skill-${String(i).padStart(3, '0')}`, `BODY_NOT_PRELOADED_${String(i).padStart(3, '0')}`)
    const result = await (await app.createSession()).run('Discover a relevant skill.')
    expect(errors(result.events)).toEqual([false, false])
    const catalog = result.events.find(e => e.type === 'user/message' && e.data.source.kind === 'skill-catalog')
    expect(catalog?.type).toBe('user/message')
    if (catalog?.type !== 'user/message' || catalog.data.source.kind !== 'skill-catalog') throw new Error('missing catalog')
    expect(catalog.data.source.entries.length).toBeLessThanOrEqual(4)
    expect(Buffer.byteLength(JSON.stringify(catalog.data.content))).toBeLessThanOrEqual(2048)
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('BODY_NOT_PRELOADED_039')
  }, 30000)

  it.each(['source', 'rendered'] as const)('advertises metadata but rejects an oversized %s body without truncation', async mode => {
    const { app, workspace, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'skill', { name: 'large' }) : stream(res, [{ content: 'Instructions were not partially loaded.' }]), {
      skills: { watch: false, metadataMaxBytes: 512, maxSourceBytes: mode === 'source' ? 2048 : 16384, maxSkillBytes: 1024 },
    })
    await skill(workspace, 'large', 'DO_NOT_PARTIALLY_INJECT_45 ' + 'x'.repeat(8192))
    const result = await (await app.createSession()).run('Load the large skill.')
    expect(errors(result.events)).toEqual([true])
    expect(JSON.stringify(requests[0]!.messages)).toContain('Routing metadata for large')
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('DO_NOT_PARTIALLY_INJECT_45')
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(mode === 'source' ? 'source limit' : 'instruction limit')
  }, 30000)

  it('does not inject an oversized user-invoked skill or send a partial first request', async () => {
    const { app, workspace, requests } = await fixture((_q, res) => stream(res, [{ content: 'Must not run.' }]), {
      skills: { watch: false, maxSkillBytes: 1024 },
    })
    await skill(workspace, 'large-private', 'z'.repeat(2048), true)
    const result = await (await app.createSession()).run('/large-private apply it.')
    expect(result.stopReason?.kind).toBe('error'); expect(requests).toHaveLength(0)
  }, 30000)

  it('ignores malformed text without poisoning other catalog entries', async () => {
    const { app, workspace, requests } = await fixture((_q, res) => stream(res, [{ content: 'Catalog inspected.' }]), {
      skills: { watch: false },
    })
    const invalid = await skill(workspace, 'invalid-text', 'placeholder')
    await writeFile(join(invalid, 'SKILL.md'), Buffer.from([0xff, 0xfe, 0x00]))
    await skill(workspace, 'valid-text', 'VALID_BODY_NOT_PRELOADED_45')
    const result = await (await app.createSession()).run('Inspect available skills.')
    expect(result.stopReason?.kind).not.toBe('error')
    const text = JSON.stringify(requests[0]!.messages)
    expect(text).toContain('Routing metadata for valid-text')
    expect(text).not.toContain('invalid-text')
    expect(text).not.toContain('VALID_BODY_NOT_PRELOADED_45')
  }, 30000)

  it('can remove all three skill tools without disabling ordinary coding tools', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Done.' }]), { skills: false })
    await (await app.createSession()).run('No skills.')
    const names = requests[0]!.tools!.map(t => t.function.name)
    for (const name of ['skill', 'skill_list', 'skill_read']) expect(names).not.toContain(name)
    expect(names).toContain('read')
  }, 30000)
})

describe('skill resources retain read authority', () => {
  it('delegates to the ordinary nested read pipeline, including a host denial', async () => {
    const nested: { name: string; parent: boolean; error: boolean }[] = []
    const { app, workspace, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'skill_read', { name: 'reader', path: 'reference.txt', offset: 2, limit: 1 }) : stream(res, [{ content: 'Read denied.' }]), {
      skills: { watch: false },
      configure: ctx => {
        ctx.tools.guard(exec => exec.name === 'read' ? 'HOST_READ_DENIAL_45' : undefined)
        ctx.on('tools/result', (exec, result) => { nested.push({ name: exec.name, parent: exec.parent !== undefined, error: result.isError }) })
      },
    })
    const dir = await skill(workspace, 'reader', 'Read reference.txt only when needed.')
    await writeFile(join(dir, 'reference.txt'), 'FIRST\nRESOURCE_SECRET_45\nTHIRD\n')
    const result = await (await app.createSession()).run('Read the resource.')
    expect(errors(result.events)).toEqual([true])
    expect(nested).toContainEqual({ name: 'read', parent: true, error: true })
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('HOST_READ_DENIAL_45')
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('RESOURCE_SECRET_45')
  }, 30000)

  it('preserves ordinary one-based line windows and limits', async () => {
    const { app, workspace, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'skill_read', { name: 'reader', path: 'reference.txt', offset: 2, limit: 1 }) : stream(res, [{ content: 'Read one line.' }]), { skills: { watch: false } })
    const dir = await skill(workspace, 'reader', 'Read the text as needed.')
    await writeFile(join(dir, 'reference.txt'), 'NOT_RETURNED_FIRST\nRETURNED_SECOND\nNOT_RETURNED_THIRD\n')
    const result = await (await app.createSession()).run('Read the second line.')
    expect(errors(result.events)).toEqual([false])
    const text = JSON.stringify(requests.at(-1)!.messages)
    expect(text).toContain('RETURNED_SECOND')
    expect(text).not.toContain('NOT_RETURNED_FIRST'); expect(text).not.toContain('NOT_RETURNED_THIRD')
  }, 30000)

  it.each(['../outside.txt', '/etc/passwd', 'https://example.invalid/file', 'C:\\outside.txt', 'escape.txt'])('refuses escaping resource path %s', async path => {
    const { app, workspace } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'skill_read', { name: 'reader', path }) : stream(res, [{ content: 'Refused.' }]), { skills: { watch: false } })
    const dir = await skill(workspace, 'reader', 'Read only contained resources.')
    const outside = join(workspace, 'outside.txt'); await writeFile(outside, 'OUTSIDE_SECRET_45')
    await symlink(outside, join(dir, 'escape.txt'))
    const result = await (await app.createSession()).run('Try this path.')
    expect(errors(result.events)).toEqual([true])
    expect(JSON.stringify(result.events.filter(e => e.type === 'tool/result'))).not.toContain('OUTSIDE_SECRET_45')
  }, 30000)

  it('binds user-only resource grants to admitted invocations and the current definition', async () => {
    const { app, workspace } = await fixture((_q, res, i) => i % 2 === 0
      ? tool(res, 'skill_read', { name: 'private-reader', path: 'reference.txt' }, 'resource-' + i)
      : stream(res, [{ content: 'Finished this attempt.' }]), { skills: { watch: false } })
    const dir = await skill(workspace, 'private-reader', 'ORIGINAL_PRIVATE_RULE_45', true)
    await writeFile(join(dir, 'reference.txt'), 'PRIVATE_RESOURCE_45\n')
    const session = await app.createSession()
    expect(errors((await session.run('Read a named private skill resource.')).events)).toEqual([true])
    expect(errors((await session.run('/private-reader use the resource.')).events)).toEqual([false])
    await skill(workspace, 'private-reader', 'CHANGED_PRIVATE_RULE_45', true)
    expect(errors((await session.run('Read it again without a new invocation.')).events)).toEqual([true])
    expect(errors((await session.run('/private-reader use the changed skill.')).events)).toEqual([false])
    await session.close()
    const resumed = await app.resumeSession(session.id)
    expect(errors((await resumed.run('Read the resource after reopening.')).events)).toEqual([true])
    expect(await readFile(join(dir, 'reference.txt'), 'utf8')).toBe('PRIVATE_RESOURCE_45\n')
  }, 30000)
})
