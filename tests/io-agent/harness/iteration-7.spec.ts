/** Exercise the default plugin composition and actual model requests over local HTTP/SSE. */
import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, stream, tool } from './fixture.ts'

async function skill(workspace: string, path: string, name: string, body: string, policy = '') {
  const directory = join(workspace, '.agents/skills', path)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} category metadata\n${policy}---\n${body}\n`)
  return directory
}

describe('real default runtime', () => {
  it('advertises nested metadata, activates on demand, and never advertises bundle examples', async () => {
    const { app, workspace, requests } = await fixture((_request, response, i) => {
      if (i === 0) tool(response, 'skill', { name: 'audit' }, 'activate')
      else if (i === 1) tool(response, 'skill_read', { name: 'audit', path: 'references/checklist.md' }, 'read-reference')
      else stream(response, [{ content: 'Audit instructions and checklist read.' }])
    }, { skills: { watch: false, discoveryMaxDepth: 4 } })
    const directory = await skill(workspace, 'engineering/review/audit', 'audit', 'PRIVATE_SKILL_BODY: consult references/checklist.md.')
    await mkdir(join(directory, 'references'))
    await writeFile(join(directory, 'references/checklist.md'), 'PRIVATE_CHECKLIST')
    await skill(workspace, 'engineering/review/audit/references/example', 'not-a-capability', 'UNTRUSTED_EXAMPLE')
    const result = await (await app.createSession()).run('Use audit and read its checklist.')
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[0]!.messages)).toContain('audit category metadata')
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('PRIVATE_SKILL_BODY')
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('not-a-capability')
    expect(JSON.stringify(requests[1]!.messages)).toContain('PRIVATE_SKILL_BODY')
    expect(JSON.stringify(requests[2]!.messages)).toContain('PRIVATE_CHECKLIST')
    expect(result.stopReason?.kind).toBe('completed')
    expect(result.events.filter(e => e.type === 'tool/result').every(e => e.data.message.content.every(c => !c.isError))).toBe(true)
  }, 30000)

  it('loads a newly written nested skill through synchronous first-party invalidation with watching disabled', async () => {
    const { app, requests, workspace } = await fixture((_request, response, i) => {
      if (i === 0) tool(response, 'write', { file_path: '.agents/skills/research/created/SKILL.md', content: '---\nname: created\ndescription: CREATED_METADATA\n---\nCREATED_BODY' }, 'create-skill')
      else if (i === 1) tool(response, 'skill', { name: 'created' }, 'load-created')
      else stream(response, [{ content: 'New skill available.' }])
    }, { skills: { watch: false } })
    // The session starts with a skill, so it is offered the skill tools (decided at creation).
    await skill(workspace, 'research/existing', 'existing', 'EXISTING_BODY')
    const result = await (await app.createSession()).run('Create the skill and activate it.')
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('CREATED_METADATA')
    // System metadata is refreshed while the instruction body is still progressive.
    expect(requests[1]!.messages.some(m => JSON.stringify(m.content).includes('- `created`: CREATED_METADATA'))).toBe(true)
    expect(JSON.stringify(requests[2]!.messages)).toContain('CREATED_BODY')
    expect(result.stopReason?.kind).toBe('completed')
    expect(result.events.filter(e => e.type === 'tool/result').every(e => e.data.message.content.every(c => !c.isError))).toBe(true)
  }, 30000)

  it('offers a skill written in a session that started with none to new sessions only', async () => {
    const { app, requests } = await fixture((_request, response, i) => {
      if (i === 0) tool(response, 'write', { file_path: '.agents/skills/research/created/SKILL.md', content: '---\nname: created\ndescription: CREATED_METADATA\n---\nCREATED_BODY' }, 'create-skill')
      else stream(response, [{ content: 'Done.' }])
    }, { skills: { watch: false } })
    await (await app.createSession()).run('Create the skill.')
    expect(requests).toHaveLength(2)
    // No skill at creation: no skill tools and no catalog, before or after the write.
    for (const request of requests) {
      expect(request.tools!.some(t => t.function.name === 'skill')).toBe(false)
      expect(JSON.stringify(request.messages)).not.toContain('available_skills')
    }
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools))
    await (await app.createSession()).run('Use the new skill.')
    expect(requests[2]!.tools!.some(t => t.function.name === 'skill')).toBe(true)
    expect(requests[2]!.messages.some(m => JSON.stringify(m.content).includes('- `created`: CREATED_METADATA'))).toBe(true)
  }, 30000)
})
