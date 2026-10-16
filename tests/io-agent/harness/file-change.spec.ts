/** io-agent tells its embedder which paths a write or edit is about to change, before the change applies. */
import { expect, it } from 'vitest'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileChange } from "../../../src/index.ts"
import { fixture, stream, tool } from './fixture.ts'

it('awaits the embedder with the calling session and absolute paths before write and edit apply', async () => {
  const changes: (FileChange & { before: string | null })[] = []
  const f = await fixture((request, response) => {
    const calls = request.messages.filter(message => message.role === 'tool').length
    if (calls === 0) tool(response, 'write', { file_path: 'direct.txt', content: 'x' }, 'direct-write')
    else if (calls === 1) tool(response, 'edit', { file_path: 'direct.txt', old_string: 'x', new_string: 'y' }, 'direct-edit')
    else if (calls === 2) tool(response, 'write', { file_path: 'refused.txt', content: 'never' }, 'refused-write')
    else stream(response, [{ content: 'Done.' }])
  }, { onFileChange: async (change) => {
    changes.push({ ...change, before: await readFile(change.paths[0]!, 'utf8').catch(() => null) })
    if (change.callId === 'refused-write') throw new Error('EMBEDDER_REFUSED')
  } })
  await writeFile(join(f.workspace, 'refused.txt'), 'kept')
  const session = await f.app.createSession()
  const result = await session.run('Write, edit, then write a refused file.')
  expect(result.stopReason?.kind).toBe('completed')
  const root = await realpath(f.workspace)
  expect(changes).toEqual([
    { sessionId: session.id, callId: 'direct-write', tool: 'write', paths: [join(root, 'direct.txt')], before: null },
    { sessionId: session.id, callId: 'direct-edit', tool: 'edit', paths: [join(root, 'direct.txt')], before: 'x' },
    { sessionId: session.id, callId: 'refused-write', tool: 'write', paths: [join(root, 'refused.txt')], before: 'kept' },
  ])
  expect(await readFile(join(root, 'direct.txt'), 'utf8')).toBe('y')
  expect(await readFile(join(root, 'refused.txt'), 'utf8')).toBe('kept')
  expect(JSON.stringify(f.requests[3]!.messages)).toContain('EMBEDDER_REFUSED')
}, 30000)
