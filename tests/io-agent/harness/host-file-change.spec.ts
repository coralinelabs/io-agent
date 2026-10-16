/** A host is told which paths a write or edit is about to change, before the change applies. */
import { describe, expect, it } from 'vitest'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostFileChange } from "../../../src/library/host/index.ts"
import { stream, tool } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'

type Seen = HostFileChange & { before: string | null }
const contentOf = (path: string) => readFile(path, 'utf8').catch(() => null)

describe('file-change hook', () => {
  it('reports root-owned paths before write and edit apply, including a delegated child write', async () => {
    const seen: Seen[] = []
    const f = await hostFixture((request, response) => {
      const text = JSON.stringify(request.messages)
      const calls = request.messages.filter(message => message.role === 'tool').length
      if (text.includes('Write child.txt')) {
        if (calls === 0) tool(response, 'write', { file_path: 'child.txt', content: 'from child' }, 'child-write')
        else stream(response, [{ content: 'Child wrote.' }])
      } else if (calls === 0) tool(response, 'write', { file_path: 'notes.txt', content: 'one' }, 'first-write')
      else if (calls === 1) tool(response, 'edit', { file_path: 'notes.txt', old_string: 'one', new_string: 'two' }, 'first-edit')
      else if (calls === 2) tool(response, 'subagent', { description: 'Write', prompt: 'Write child.txt.', run_in_background: false }, 'delegate')
      else stream(response, [{ content: 'All changes made.' }])
    }, {}, { onFileChange: async (change) => { seen.push({ ...change, before: await contentOf(change.paths[0]!) }) } })
    const id = await f.host.createSession()
    const { activity } = await run(f.host, turn(id, 'Make the changes.'))
    expect(activity.end).toBe('done')
    const root = await realpath(f.workspace)
    expect(seen).toEqual([
      { change_id: expect.any(String), session_id: id, turn_id: 'turn-application-01', call_id: 'first-write', tool: 'write', paths: [join(root, 'notes.txt')], before: null },
      { change_id: expect.any(String), session_id: id, turn_id: 'turn-application-01', call_id: 'first-edit', tool: 'edit', paths: [join(root, 'notes.txt')], before: 'one' },
      { change_id: expect.any(String), session_id: id, turn_id: 'turn-application-01', call_id: 'child-write', tool: 'write', paths: [join(root, 'child.txt')], before: null },
    ])
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('two')
    expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('from child')
  }, 30000)

  it('pairs distinct mutation identities for sibling agents reusing one provider call ID', async () => {
    const before: Seen[] = [], after: (HostFileChange & { after: string | null })[] = []
    const children: { id: string; parent: string }[] = []
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'subagent', { description: 'First sibling', prompt: 'Write alpha.txt.', run_in_background: false }, 'delegate-alpha')
      else if (index === 1) tool(response, 'write', { file_path: 'alpha.txt', content: 'alpha' }, 'shared-provider-call')
      else if (index === 3) tool(response, 'subagent', { description: 'Second sibling', prompt: 'Write beta.txt.', run_in_background: false }, 'delegate-beta')
      else if (index === 4) tool(response, 'write', { file_path: 'beta.txt', content: 'beta' }, 'shared-provider-call')
      else stream(response, [{ content: 'Finished.' }])
    }, { configure(context) {
      context.on('agent/created', ({ agent }) => {
        if (agent.session.header.parentSession !== undefined) children.push({ id: String(agent.id), parent: String(agent.session.header.parentSession) })
      })
    } }, {
      onFileChange: async change => { before.push({ ...change, before: await contentOf(change.paths[0]!) }) },
      onFileChangeComplete: async change => { after.push({ ...change, after: await contentOf(change.paths[0]!) }) },
    })
    const id = await f.host.createSession()
    const { receipt, activity } = await run(f.host, turn(id, 'Delegate to two siblings.'))
    expect(activity.end).toBe('done')
    expect(f.requests).toHaveLength(7)
    expect(children).toHaveLength(2)
    expect(new Set(children.map(child => child.id)).size).toBe(2)
    expect(children.every(child => child.parent === id)).toBe(true)
    expect(before).toHaveLength(2)
    expect(after).toHaveLength(2)
    expect(new Set(before.map(change => change.change_id)).size).toBe(2)
    for (const change of before) {
      expect(change).toMatchObject({ session_id: id, turn_id: receipt.turn_id, call_id: 'shared-provider-call', before: null })
      const { before: _before, ...identity } = change
      expect(after.find(done => done.change_id === change.change_id)).toEqual({ ...identity,
        after: change.paths[0] === join(f.workspace, 'alpha.txt') ? 'alpha' : 'beta' })
    }
    const events = f.host.readSession(id, receipt.after).events.filter(event => event.type === 'file_change')
    expect(events).toHaveLength(2)
    expect(events.every(event => event.call_id === 'shared-provider-call' && !('change_id' in event))).toBe(true)
  }, 30000)

  it('fails the tool call before anything is written when the host refuses the change', async () => {
    const f = await hostFixture((request, response) => {
      const calls = request.messages.filter(message => message.role === 'tool').length
      if (calls === 0) tool(response, 'write', { file_path: 'kept.txt', content: 'original' }, 'allowed-write')
      else if (calls === 1) tool(response, 'edit', { file_path: 'kept.txt', old_string: 'original', new_string: 'changed' }, 'refused-edit')
      else stream(response, [{ content: 'The edit was refused.' }])
    }, {}, { onFileChange: (change) => { if (change.tool === 'edit') throw new Error('HOST_REFUSED_SNAPSHOT') } })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Write then edit.'))
    expect(await readFile(join(f.workspace, 'kept.txt'), 'utf8')).toBe('original')
    const ends = (await f.host.history(id)).events.filter(event => event.type === 'tool_end')
    expect(ends.map(event => event.type === 'tool_end' && event.ok)).toEqual([true, false])
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('HOST_REFUSED_SNAPSHOT')
  }, 30000)
})
