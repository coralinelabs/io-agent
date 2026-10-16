/** New implementations exercised through the public API and actual HTTP/SSE pipeline. */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, stream, tool } from './fixture.ts'
import type { SessionEvent } from '../../../src/library/session/journal/index.ts'
const errors = (events: readonly SessionEvent[]) => events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError)
async function putSkill(directory: string, name: string, body: string, description = 'Review current work.') {
  const root = join(directory, name); await mkdir(root, { recursive: true })
  const path = join(root, 'SKILL.md')
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`)
  return path
}
describe('actual runtime replacements', () => {
  it('suppresses only still-visible exact skill content; same-length changes reload without moving the stable prefix', async () => {
    let path = ''
    const { app, workspace, requests } = await fixture(async (_q, res, i) => {
      if (i === 0 || i === 1) tool(res, 'skill', { name: 'review' }, `load-${i}`)
      else if (i === 2) { const before = await stat(path); await writeFile(path, (await readFile(path, 'utf8')).replace('VISIBLE_A', 'VISIBLE_B')); await utimes(path, before.atime, before.mtime); tool(res, 'skill', { name: 'review' }, 'changed') }
      else stream(res, [{ content: 'The changed instructions are loaded.' }])
    }, { skills: { watch: false } })
    path = await putSkill(join(workspace, '.agents/skills'), 'review', 'VISIBLE_A: follow this rule.')
    const result = await (await app.createSession()).run('Use the review skill.')
    expect(errors(result.events)).toEqual([false, false, false])
    const outputs = result.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data.message))
    expect(outputs[0]).toContain('VISIBLE_A'); expect(outputs[1]).not.toContain('VISIBLE_A'); expect(outputs[1]).toContain('unchanged')
    expect(outputs[2]).toContain('VISIBLE_B')
    const stable = (request: typeof requests[number]) => ({ tools: request.tools, system: request.messages.filter(m => m.role === 'system' || m.role === 'developer') })
    for (const q of requests) expect(stable(q)).toEqual(stable(requests[0]!))
    expect(result.stopReason?.kind).toBe('completed')
  }, 30000)
  it('binds invocation arguments literally in the actual skill tool result', async () => {
    const argumentsText = 'src/input.ts $ARGUMENTS $(touch NEVER)'
    const { app, workspace, requests } = await fixture((_q, res, i) => i === 0
      ? tool(res, 'skill', { name: 'review', arguments: argumentsText }) : stream(res, [{ content: 'Loaded literal arguments.' }]), { skills: { watch: false } })
    await putSkill(join(workspace, '.agents/skills'), 'review', 'Review only: $ARGUMENTS')
    const result = await (await app.createSession()).run('Load the parametrized skill.')
    expect(errors(result.events)).toEqual([false])
    expect(JSON.stringify(requests[1]!.messages)).toContain(`Review only: ${argumentsText}`)
  }, 30000)
  it('plans the whole edit batch against the observed bytes, without normalizing other lines', async () => {
    const { app, workspace } = await fixture((_q, res, i) => {
      if (i === 0) tool(res, 'read', { file_path: 'source.txt' })
      else if (i === 1) tool(res, 'edit', { file_path: 'source.txt', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'three', new_string: 'THREE' }] }, 'edit-batch')
      else stream(res, [{ content: 'Two changes committed.' }])
    })
    await writeFile(join(workspace, 'source.txt'), '\uFEFFone\r\ntwo\nthree\r\nfour')
    const result = await (await app.createSession()).run('Edit the first and third words.')
    expect(errors(result.events)).toEqual([false, false])
    expect(await readFile(join(workspace, 'source.txt'), 'utf8')).toBe('\uFEFFONE\r\ntwo\nTHREE\r\nfour')
  }, 30000)
  it('rejects a late bad edit without partially committing its earlier valid edit', async () => {
    const { app, workspace } = await fixture((_q, res, i) => {
      if (i === 0) tool(res, 'read', { file_path: 'source.txt' })
      else if (i === 1) tool(res, 'edit', { file_path: 'source.txt', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'missing', new_string: 'changed' }] }, 'rejected-batch')
      else stream(res, [{ content: 'No edits committed.' }])
    })
    await writeFile(join(workspace, 'source.txt'), 'one two')
    const result = await (await app.createSession()).run('Try the edit batch.')
    expect(errors(result.events)).toEqual([false, true])
    expect(await readFile(join(workspace, 'source.txt'), 'utf8')).toBe('one two')
  }, 30000)
})
